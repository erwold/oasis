"""SSH stdin adapter. Python >=3.9, POSIX Linux/macOS; standard library only.
Not a shell sandbox. State belongs to the explicitly selected project, never HOME.
"""
import base64
import contextlib
import datetime
import fcntl
import hashlib
import json
import os
import platform
import re
import selectors
import signal
import stat
import struct
import subprocess
import sys
import time
import uuid
import zlib

FRAME = 8 * 1024 * 1024
SMALL = 2 * 1024 * 1024
PAGE = 256 * 1024
TAIL_PAGE = 1024 * 1024
CRC_SLICE = 64 * 1024 * 1024
CAPS = dict(direct_files=True, durable_jobs=True, journal_undo=True, port_forwarding=True,
            sandbox=False, restricted_shell=False, snapshots=False, isolated_copies=False)


class Refused(Exception):
    def __init__(self, code, message, status='refused'):
        super().__init__(message)
        self.code, self.status = code, status


def fail(code, message, status='refused'):
    raise Refused(code, message, status)


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def b64(data):
    return None if data is None else base64.b64encode(data).decode('ascii')


def unb64(data):
    try:
        return base64.b64decode(data, validate=True)
    except Exception:
        fail('invalid_argument', 'Invalid base64')


def uid():
    return uuid.uuid4().hex


def ident(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', value):
        fail('invalid_argument', 'Invalid operation/job identifier')
    return value


def integer(value, low, high):
    if type(value) is not int or not low <= value <= high:
        fail('invalid_argument', 'Integer outside supported budget')
    return value


def syncdir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic(path, value):
    data = json.dumps(value, separators=(',', ':'), ensure_ascii=True).encode()
    tmp = path + '.' + uid() + '.tmp'
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
        syncdir(os.path.dirname(path))
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def load(path, default=None):
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def private_dir(path):
    try:
        os.mkdir(path, 0o700)
    except FileExistsError:
        pass
    st = os.lstat(path)
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid() or st.st_mode & 0o077:
        fail('state_path_refused', 'State must be an owned private non-symlink directory')


@contextlib.contextmanager
def locked(path):
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)


def boot_identity():
    if sys.platform.startswith('linux'):
        with open('/proc/sys/kernel/random/boot_id') as f:
            return f.read().strip()
    return subprocess.check_output(['/usr/sbin/sysctl', '-n', 'kern.boottime'], text=True).strip()


def process_identity(pid):
    # Exact PID query; never enumerate/kill by command pattern.
    p = subprocess.run(['/bin/ps', '-p', str(pid), '-o', 'lstart=', '-o', 'command='],
                       stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    return p.stdout.strip() if p.returncode == 0 else None


def probe():
    if sys.version_info < (3, 9) or sys.platform not in ('linux', 'darwin'):
        fail('unsupported_transport', 'Requires Linux/macOS and Python >=3.9')
    if process_identity(os.getpid()) is None:
        fail('unsupported_transport', 'Exact PID/start identity query is unavailable')
    try:
        boot_identity()
    except (OSError, subprocess.SubprocessError):
        fail('unsupported_transport', 'Environment boot identity is unavailable')
    return dict(protocol=1, python_version=platform.python_version(), platform=sys.platform, exec=True, capabilities=CAPS)


def registry_path():
    # Fixed per OS user, not HOME, SSH alias, project permissions or requested state path.
    return os.path.join(os.path.realpath('/tmp'), 'oasis-ssh-root-registry-v1-' + str(os.geteuid()))


def trusted_private_path(path, create=False):
    """No symlinks/untrusted writable ancestors; /tmp's sticky root-owned parent is allowed.
    /tmp -> /private/tmp is the system alias on macOS, not a user-selected symlink.
    """
    if not isinstance(path, str) or not os.path.isabs(path) or '\x00' in path:
        fail('state_path_refused', 'Private state path must be explicitly absolute')
    path = os.path.normpath(path)
    if path == '/tmp' or path.startswith('/tmp/'):
        path = os.path.realpath('/tmp') + path[4:]
    current = '/'
    components = [part for part in path.split('/') if part]
    if not components:
        fail('state_path_refused', 'Filesystem root is not a private state directory')
    for index, part in enumerate(components):
        current = os.path.join(current, part)
        final = index == len(components)-1
        if final and create:
            private_dir(current)
        try:
            st = os.lstat(current)
        except FileNotFoundError:
            fail('root_changed', 'Pinned private directory is missing', 'conflict')
        if not stat.S_ISDIR(st.st_mode) or st.st_uid not in (0, os.geteuid()):
            fail('state_path_refused', 'Private state requires trusted non-symlink directory ancestry')
        if final:
            if st.st_uid != os.geteuid() or stat.S_IMODE(st.st_mode) != 0o700:
                fail('state_path_refused', 'Private directory must be owned by the SSH user and mode 0700')
        elif st.st_mode & 0o022:
            if not (st.st_uid == 0 and st.st_mode & stat.S_ISVTX):
                fail('state_path_refused', 'Writable non-sticky ancestor cannot protect private state')
    return path, [st.st_dev, st.st_ino]


def private_json(path):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return None
    except OSError:
        fail('state_path_refused', 'Private metadata cannot be opened without following symlinks')
    with os.fdopen(fd, 'rb') as f:
        st = os.fstat(f.fileno())
        if not stat.S_ISREG(st.st_mode) or st.st_uid != os.geteuid() or st.st_mode & 0o077 or st.st_size > 65536:
            fail('state_path_refused', 'Private metadata must be a bounded owned private regular file')
        return json.load(f)


def registry_context(create):
    path, signature = trusted_private_path(registry_path(), create=create)
    return path, signature


def check_pin(meta, p):
    if ((p.get('expected_root_id') is not None and p['expected_root_id'] != meta['root_id']) or
            (p.get('expected_generation') is not None and p['expected_generation'] != meta['generation'])):
        fail('root_changed', 'Expected root/generation differs; no operation was replayed', 'conflict')


def root_open(p):
    probe()
    requested = p.get('path')
    if not isinstance(requested, str) or not os.path.isabs(requested):
        fail('invalid_argument', 'Explicit absolute project path required')
    root = canonical_directory(requested)
    st = os.stat(root)
    if not stat.S_ISDIR(st.st_mode):
        fail('invalid_argument', 'Project is not a directory')
    state = p.get('state_path') or os.path.join(root, '.oasis-remote')
    if not isinstance(state, str) or not os.path.isabs(state):
        fail('state_path_refused', 'State path must be explicitly absolute')
    # Normalize the system /tmp alias only; arbitrary symlinks are rejected, not canonicalized away.
    state = os.path.normpath(state)
    if state == '/tmp' or state.startswith('/tmp/'):
        state = os.path.realpath('/tmp') + state[4:]
    pinned = p.get('expected_root_id') is not None or p.get('expected_generation') is not None
    try:
        registry, registry_signature = registry_context(create=not pinned)
    except Refused as error:
        if pinned and error.code == 'state_path_refused':
            fail('root_changed', 'Pinned registry permissions or identity changed', 'conflict')
        raise
    if [st.st_dev, st.st_ino] == registry_signature:
        fail('state_path_refused', 'Private registry cannot be selected as a project through an alias')
    if state == root or root.startswith(state + '/') or state == registry or state.startswith(registry + '/') or root == registry or root.startswith(registry + '/'):
        fail('state_path_refused', 'Project, state and private root registry must be distinct')
    signature = [st.st_dev, st.st_ino, boot_identity(), platform.node()]
    # Object identity makes case/Unicode/bind aliases collide on ONE registry entry.
    # Canonical path and boot identity remain validated attributes, not alternate lock keys.
    key = sha(json.dumps([st.st_dev, st.st_ino], separators=(',', ':')).encode())
    entry_path = os.path.join(registry, key + '.json')
    with locked(os.path.join(registry, 'registry.lock')):
        registry_meta = private_json(os.path.join(registry, 'registry.json'))
        if registry_meta is None:
            if pinned or any(name.endswith('.json') for name in os.listdir(registry)):
                fail('root_changed', 'Registry identity was lost', 'conflict')
            registry_meta = dict(registry_id=uid(), signature=registry_signature)
            atomic(os.path.join(registry, 'registry.json'), registry_meta)
        if registry_meta['signature'] != registry_signature:
            fail('root_changed', 'Root registry directory was replaced', 'conflict')
        entry = private_json(entry_path)
        if entry:
            if entry['state_path'] != state or entry['path'] != root or entry['signature'] != signature:
                fail('root_changed', 'Canonical root is already bound to another state/environment', 'conflict')
            if entry.get('phase') != 'ready':
                fail('root_changed', 'Root initialization is unsettled; explicit recovery required', 'conflict')
            check_pin(entry, p)
            try:
                _, state_signature = trusted_private_path(state, create=False)
                meta = private_json(os.path.join(state, 'root.json'))
            except Refused:
                fail('root_changed', 'Pinned state permissions, ownership or symlink identity changed', 'conflict')
            if (not meta or meta['root_id'] != entry['root_id'] or meta['generation'] != entry['generation'] or
                    meta.get('registry_id') != registry_meta['registry_id'] or
                    meta.get('registry_signature') != registry_signature or meta.get('state_signature') != state_signature or
                    entry.get('state_signature') != state_signature or meta['signature'] != signature):
                fail('root_changed', 'Pinned state/registry was removed or replaced', 'conflict')
        else:
            if pinned:
                fail('root_changed', 'Pinned root registry binding is missing', 'conflict')
            # Compatibility with the former private project anchor, without requiring
            # a project marker for newly selected external state on a shared filesystem.
            legacy = None
            anchor = os.path.join(root, '.oasis-remote')
            if os.path.isdir(anchor) and not os.path.islink(anchor):
                ast = os.lstat(anchor)
                if ast.st_uid == os.geteuid() and stat.S_IMODE(ast.st_mode) == 0o700:
                    legacy = private_json(os.path.join(anchor, 'binding.json'))
            if legacy and legacy['state_path'] != state:
                fail('root_changed', 'Legacy root is already bound to another private state', 'conflict')
            _, state_signature = trusted_private_path(state, create=True)
            actual_state = canonical_directory(state)
            if (state_signature in ([st.st_dev, st.st_ino], registry_signature) or
                    root.startswith(actual_state + '/') or actual_state.startswith(canonical_directory(registry) + '/')):
                fail('state_path_refused', 'Private state overlaps project/registry through a filesystem alias')
            meta_path = os.path.join(state, 'root.json')
            meta = private_json(meta_path)
            if meta:
                if (meta.get('registry_id') is not None or not legacy or meta['path'] != root or
                        meta['signature'] != signature or legacy['root_id'] != meta['root_id'] or
                        legacy['generation'] != meta['generation']):
                    fail('root_changed', 'State exists without its matching registry; cannot silently rebind', 'conflict')
            else:
                if legacy:
                    fail('root_changed', 'Legacy state metadata was lost', 'conflict')
                meta = dict(path=root, state_path=state, root_id=uid(), generation=uid(), signature=signature)
            meta.update(registry_id=registry_meta['registry_id'], registry_path=registry, registry_key=key,
                        registry_signature=registry_signature, state_signature=state_signature)
            # A durable reservation precedes metadata publication. A crash cannot permit
            # another alias/state_path to create a second independent writer lease.
            atomic(entry_path, dict(meta, phase='prepared'))
            atomic(meta_path, meta)
            atomic(entry_path, dict(meta, phase='ready'))
        for name in ('operations', 'jobs'):
            private_dir(os.path.join(state, name))
        # Immutable, content-addressed supervisor. No installation or external dependency.
        source = globals().get('__source__')
        if source is not None:
            script = os.path.join(state, 'adapter-' + sha(source.encode()) + '.py')
            if not os.path.exists(script):
                fd = os.open(script, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                with os.fdopen(fd, 'w') as f:
                    f.write(source)
                    f.flush()
                    os.fsync(f.fileno())
                syncdir(state)
            script_fd = os.open(script, os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(script_fd, 'rb') as f:
                if f.read(len(source.encode()) + 1) != source.encode():
                    fail('protocol_mismatch', 'Persisted adapter content hash differs')
            meta['script'] = script
        else:
            meta['script'] = os.path.abspath(__file__)
    return meta


def public_root(meta):
    return {**{k: meta[k] for k in ('path', 'state_path', 'root_id', 'generation')},
            'capabilities': CAPS, 'limits': dict(small_file_bytes=SMALL, page_bytes=PAGE, frame_bytes=FRAME)}


def validate(meta, req):
    st = os.stat(meta['path'])
    registry, registry_signature = registry_context(create=False)
    registry_meta = private_json(os.path.join(registry, 'registry.json'))
    entry = private_json(os.path.join(registry, meta['registry_key'] + '.json'))
    _, state_signature = trusted_private_path(meta['state_path'], create=False)
    persisted = private_json(os.path.join(meta['state_path'], 'root.json'))
    if (not registry_meta or not entry or not persisted or entry.get('phase') != 'ready' or
            registry_meta['registry_id'] != meta['registry_id'] or registry_signature != meta['registry_signature'] or
            registry_meta['signature'] != registry_signature or state_signature != meta['state_signature'] or
            entry['root_id'] != meta['root_id'] or entry['generation'] != meta['generation'] or
            entry['state_path'] != meta['state_path'] or persisted['root_id'] != meta['root_id'] or
            persisted['generation'] != meta['generation'] or persisted.get('registry_id') != meta['registry_id'] or
            [st.st_dev, st.st_ino, boot_identity(), platform.node()] != meta['signature'] or
            req.get('root_id') != meta['root_id'] or req.get('generation') != meta['generation']):
        fail('root_changed', 'Pinned project/state/registry identity mismatch', 'conflict')


def filesystem_name(parent, spelling, st):
    """Ask this filesystem, not Unicode casefold/normcase, which direntry was opened.
    On a case-sensitive volume, distinct exact names stay distinct. Ambiguous hardlink
    names fail closed instead of guessing a policy identity.
    """
    candidates = []
    with os.scandir(parent) as entries:
        for entry in entries:
            if entry.name == spelling:
                return spelling
            if entry.inode() == st.st_ino:
                est = entry.stat(follow_symlinks=False)
                if est.st_dev == st.st_dev and len(candidates) < 2:
                    candidates.append(entry.name)
    if len(candidates) != 1:
        fail('path_refused', 'Filesystem path identity is ambiguous or changed')
    return candidates[0]


def canonical_directory(path):
    # Project-root symlink aliases are explicitly resolved; user-file symlinks below
    # a pinned root are not. Resolve actual case/Unicode spellings component by component.
    path = os.path.realpath(path)
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    names = []
    try:
        for component in [part for part in path.split('/') if part]:
            st = os.stat(component, dir_fd=fd, follow_symlinks=False)
            name = filesystem_name(fd, component, st)
            new = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = new
            names.append(name)
        return '/' + '/'.join(names)
    finally:
        os.close(fd)


def deny_private_identity(meta, st, name=None):
    if name == '.oasis-remote':
        fail('path_refused', 'Private state is not a user file')
    identities = [meta.get('state_signature'), meta.get('registry_signature')]
    for private in (meta.get('state_path'), meta.get('registry_path') or registry_path()):
        if private:
            try:
                item = os.lstat(private)
                identities.append([item.st_dev, item.st_ino])
            except FileNotFoundError:
                pass
    if [st.st_dev, st.st_ino] in identities:
        fail('path_refused', 'Private state/registry identity is excluded')
    if stat.S_ISLNK(st.st_mode):
        fail('path_refused', 'User-file symlink aliases are not supported')
    if stat.S_ISREG(st.st_mode) and st.st_nlink > 1:
        fail('path_refused', 'Hardlinked user files are not supported across the private-state boundary')


def resolve_file(meta, path, allow_missing=False, require_spelling=False):
    if not isinstance(path, str) or '\x00' in path:
        fail('invalid_argument', 'Invalid path')
    if os.path.isabs(path):
        path = os.path.relpath(path, meta['path'])
    raw = [part for part in path.split('/') if part not in ('', '.')]
    if '..' in raw:
        fail('path_refused', 'Path escapes the selected project')
    fd = os.open(meta['path'], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    names, exists, last = [], True, None
    try:
        root_stat = os.fstat(fd)
        if meta.get('signature') and [root_stat.st_dev, root_stat.st_ino] != meta['signature'][:2]:
            fail('root_changed', 'Opened root descriptor differs from pinned root', 'conflict')
        for index, component in enumerate(raw):
            try:
                last = os.stat(component, dir_fd=fd, follow_symlinks=False)
            except FileNotFoundError:
                if allow_missing and index == len(raw)-1 and component != '.oasis-remote':
                    names.append(component)
                    exists, last = False, None
                    break
                raise
            name = filesystem_name(fd, component, last)
            deny_private_identity(meta, last, name)
            names.append(name)
            if require_spelling and component != name:
                fail('path_not_canonical', 'Resolve the actual filesystem spelling before applying file policy')
            if index < len(raw)-1:
                new = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                try:
                    deny_private_identity(meta, os.fstat(new), name)
                except BaseException:
                    os.close(new)
                    raise
                os.close(fd)
                fd = new
        relative = '/'.join(names) or '.'
        result = dict(path=relative, absolute_path=os.path.join(meta['path'], *names), exists=exists)
        if exists:
            result['kind'] = stat_result(relative, last or root_stat)['kind']
        return result
    finally:
        os.close(fd)


def parts(meta, path):
    # All file methods require canonical spelling. This is fail-closed even before
    # the caller integrates files.resolve into policy/approval/journal checks.
    resolved = resolve_file(meta, path, allow_missing=True, require_spelling=True)
    return [] if resolved['path'] == '.' else resolved['path'].split('/')


@contextlib.contextmanager
def parent_fd(meta, path):
    seg = parts(meta, path)
    fd = os.open(meta['path'], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        root_stat = os.fstat(fd)
        if meta.get('signature') and [root_stat.st_dev, root_stat.st_ino] != meta['signature'][:2]:
            fail('root_changed', 'Opened root descriptor differs from pinned root', 'conflict')
        for name in seg[:-1]:
            new = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            try:
                deny_private_identity(meta, os.fstat(new), name)
            except BaseException:
                os.close(new)
                raise
            os.close(fd)
            fd = new
        yield fd, seg[-1] if seg else '.'
    finally:
        os.close(fd)


@contextlib.contextmanager
def file_open(meta, path, directory=False):
    with parent_fd(meta, path) as (parent, name):
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | (os.O_DIRECTORY if directory else os.O_NONBLOCK), dir_fd=parent)
    try:
        st = os.fstat(fd)
        deny_private_identity(meta, st, name)
        if not directory and not stat.S_ISREG(st.st_mode):
            fail('path_refused', 'Only regular files supported')
        yield fd
    finally:
        os.close(fd)


def file_hash(fd):
    st = os.fstat(fd)
    digest = hashlib.sha256()
    os.lseek(fd, 0, os.SEEK_SET)
    while True:
        chunk = os.read(fd, PAGE)
        if not chunk:
            break
        digest.update(chunk)
    after = os.fstat(fd)
    if (st.st_size, st.st_mtime_ns, st.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
        fail('version_conflict', 'File changed while hashing', 'conflict')
    return digest.hexdigest(), after


def stat_result(path, st):
    kind = 'file' if stat.S_ISREG(st.st_mode) else 'directory' if stat.S_ISDIR(st.st_mode) else 'symlink' if stat.S_ISLNK(st.st_mode) else 'other'
    return dict(path=path, kind=kind, size=st.st_size, mode=stat.S_IMODE(st.st_mode))


def listing(meta, p):
    path = p.get('path', '.')
    offset = integer(p.get('offset', 0), 0, 1000000)
    limit = integer(p.get('limit', 300), 1, 300)
    with file_open(meta, path, True) as fd:
        st = os.fstat(fd)
        fingerprint = sha(str((st.st_dev, st.st_ino, st.st_mtime_ns, st.st_ctime_ns)).encode())
        if p.get('fingerprint') and p['fingerprint'] != fingerprint:
            fail('cursor_invalid', 'Directory changed between pages', 'conflict')
        entries, seen, more = [], 0, False
        with os.scandir(fd) as it:
            for ent in it:
                if ent.name == '.oasis-remote':
                    continue
                rel = os.path.join(path, ent.name)
                try:
                    parts(meta, rel)
                except Refused:
                    continue
                if seen < offset:
                    seen += 1
                    continue
                if len(entries) == limit:
                    more = True
                    break
                entries.append(stat_result(rel, ent.stat(follow_symlinks=False)))
                seen += 1
        return dict(path=path, entries=entries, next_offset=seen if more else None, truncated=more, fingerprint=fingerprint)


def read_page(meta, p):
    offset = integer(p.get('byte_offset', 0), 0, 2**53 - 1)
    limit = integer(p.get('limit', PAGE), 1, PAGE)
    with file_open(meta, p['path']) as fd:
        digest, st = file_hash(fd)
        if p.get('expected_hash') and p['expected_hash'] != digest:
            fail('version_conflict', 'Read version changed', 'conflict')
        os.lseek(fd, offset, os.SEEK_SET)
        data = os.read(fd, limit)
        after = os.fstat(fd)
        if (st.st_mtime_ns, st.st_ctime_ns, st.st_size) != (after.st_mtime_ns, after.st_ctime_ns, after.st_size):
            fail('version_conflict', 'Read version changed', 'conflict')
    return dict(data=b64(data), byte_offset=offset, next_offset=offset+len(data), eof=offset+len(data)>=st.st_size,
                sha256=digest, total_written=st.st_size, total_retained=st.st_size, gaps=[])


def pread_full(fd, length, offset):
    chunks, got = [], 0
    while got < length:
        part = os.pread(fd, length - got, offset + got)
        if not part:
            break
        chunks.append(part)
        got += len(part)
    return b''.join(chunks)


def tail_page(meta, p):
    # Read-only, for a file that grows: one page from byte_offset, read up to the size the file had when the request
    # began; its first and the anchor bytes before byte_offset; with verify, the CRC-32 of [crc_from, byte_offset)
    # continued from crc_seed, at most CRC_SLICE bytes of it per request (crc_next says where it stopped: the caller
    # asks again from there, so no request holds the channel for a long hash). No whole-file hash per page.
    offset = integer(p.get('byte_offset', 0), 0, 2**53 - 1)
    limit = integer(p.get('limit', TAIL_PAGE), 0, TAIL_PAGE)
    anchor = integer(p.get('anchor_bytes', 0), 0, 4096)
    verify = p.get('verify') is True
    crc_from = integer(p.get('crc_from', 0), 0, 2**53 - 1)
    crc_seed = integer(p.get('crc_seed', 0), 0, 2**32 - 1)
    with file_open(meta, p['path']) as fd:
        st = os.fstat(fd)
        size = st.st_size
        head = pread_full(fd, min(anchor, size), 0)
        before = pread_full(fd, offset - max(0, offset - anchor), max(0, offset - anchor)) if offset <= size else None
        data = pread_full(fd, min(limit, size - offset), offset) if offset < size else b''
        crc, crc_next = None, None
        if verify and offset <= size and crc_from <= offset:
            crc, at = crc_seed, crc_from
            stop = min(offset, crc_from + CRC_SLICE)
            while at < stop:
                chunk = pread_full(fd, min(TAIL_PAGE, stop - at), at)
                if not chunk:
                    break
                crc = zlib.crc32(chunk, crc)
                at += len(chunk)
            crc_next = at
    return dict(file_id='%d:%d' % (st.st_dev, st.st_ino), size=size, mtime_ms=st.st_mtime_ns / 1e6, data=b64(data),
                byte_offset=offset, next_offset=offset + len(data), eof=offset + len(data) >= size, head=b64(head),
                anchor=None if before is None else b64(before), crc=crc, crc_next=crc_next)


def lease_check(meta, proof):
    current = load(os.path.join(meta['state_path'], 'lease.json'))
    if not current or not isinstance(proof, dict) or any(current[k] != proof.get(k) for k in ('lease_id', 'owner_id', 'fence')):
        fail('lease_conflict', 'Current root writer lease required', 'conflict')
    return current


def operation_path(meta, op):
    return os.path.join(meta['state_path'], 'operations', ident(op) + '.json')


def job_dir(meta, job):
    path = os.path.join(meta['state_path'], 'jobs', ident(job))
    if not os.path.isdir(path):
        fail('outcome_unknown', 'Job is not present in pinned environment', 'unknown')
    return path


def job_status(meta, job):
    path = job_dir(meta, job)
    spec = load(os.path.join(path, 'spec.json'))
    terminal = load(os.path.join(path, 'exit.json'))
    if terminal:
        return terminal
    running = load(os.path.join(path, 'running.json'))
    base = dict(job_id=job, operation_id=spec['operation_id'], timeout_s=spec.get('timeout_s'), output_cap_bytes=spec.get('output_cap_bytes'))
    storage = load(os.path.join(path, 'storage-failed.json'))
    if storage:
        if storage.get('terminal_confirmed'):
            return storage
        return dict(base, state='unknown', reason='storage_failed')
    if running and process_identity(running['supervisor_pid']) == running['supervisor_identity']:
        return dict(base, state='running', pid_identity=running['pid_identity'])
    # Missing start/exit is never an invitation to spawn again.
    return dict(base, state='unknown', reason='No trustworthy live supervisor or terminal record')


def mutation(meta, req, work):
    op = ident(req['operation_id'])
    path = operation_path(meta, op)
    digest = sha(json.dumps([req['method'], req['params']], sort_keys=True, separators=(',', ':')).encode())
    old = load(path)
    if old:
        if old['digest'] != digest:
            fail('operation_conflict', 'operation_id was already used with different arguments', 'conflict')
        if old['state'] == 'applied':
            return old['result']
        if old['state'] == 'failed':
            fail(old['code'], old['message'], old.get('status', 'refused'))
        fail('outcome_unknown', 'Operation intent exists without a completed receipt; query only', 'unknown')
    record = dict(operation_id=op, state='prepared', digest=digest)
    atomic(path, record)
    try:
        result = work()
    except Refused as error:
        atomic(path, dict(record, state='failed', code=error.code, message=str(error), status=error.status))
        raise
    atomic(path, dict(record, state='applied', result=result))
    return result


def write_file(meta, req):
    p, method = req['params'], req['method']
    lease_check(meta, p.get('lease'))
    with parent_fd(meta, p['path']) as (parent, name):
        if name == '.':
            fail('path_refused', 'Cannot mutate root')
        before, mode = None, 0o600
        try:
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        except FileNotFoundError:
            fd = None
        if fd is not None:
            with os.fdopen(fd, 'rb') as f:
                st = os.fstat(f.fileno())
                if not stat.S_ISREG(st.st_mode):
                    fail('path_refused', 'Only regular files may be changed')
                before = f.read(SMALL + 1)
                mode = stat.S_IMODE(st.st_mode)
            if len(before) > SMALL:
                fail('file_too_large', 'Small-file journal budget exceeded')
        before_sha = sha(before) if before is not None else None
        if 'expected_hash' not in p or p['expected_hash'] != before_sha:
            fail('version_conflict', 'Expected file version differs', 'conflict')
        if method == 'files.remove':
            if before is None:
                fail('version_conflict', 'Cannot remove absent file', 'conflict')
            after = None
        elif method == 'files.edit':
            if before is None:
                fail('version_conflict', 'Cannot edit absent file', 'conflict')
            try:
                text = before.decode('utf-8')
            except UnicodeDecodeError:
                fail('invalid_argument', 'Text edit requires UTF-8')
            old, new = p.get('old_string'), p.get('new_string')
            if not isinstance(old, str) or not old or not isinstance(new, str):
                fail('invalid_argument', 'Nonempty old_string and new_string required')
            count = text.count(old)
            if count == 0 or (count > 1 and not p.get('replace_all', False)):
                fail('edit_conflict', 'Text match missing or not unique', 'conflict')
            after = text.replace(old, new, -1 if p.get('replace_all') else 1).encode()
        else:
            after = unb64(p['data'])
        if after is not None and len(after) > SMALL:
            fail('file_too_large', 'Small-file journal budget exceeded')
        # Persist images before applying; interrupted replacement remains unknown, never auto-replayed.
        receipt = dict(path=p['path'], operation_id=req['operation_id'], before=b64(before), after=b64(after),
                       before_sha256=before_sha, after_sha256=sha(after) if after is not None else None, state='applied')
        atomic(operation_path(meta, req['operation_id']) + '.images', dict(receipt, state='prepared'))
        # Narrow the external-writer race after durable image I/O. POSIX still has no
        # conditional rename CAS for uncooperative writers; leases serialize our clients.
        try:
            check_fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        except FileNotFoundError:
            current = None
        else:
            with os.fdopen(check_fd, 'rb') as check:
                if not stat.S_ISREG(os.fstat(check.fileno()).st_mode):
                    fail('version_conflict', 'File type changed before apply', 'conflict')
                current = check.read(SMALL + 1)
        if current != before:
            fail('version_conflict', 'File changed before apply', 'conflict')
        if after is None:
            os.unlink(name, dir_fd=parent)
        else:
            tmp = '.oasis-write-' + uid()
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode, dir_fd=parent)
            try:
                with os.fdopen(fd, 'wb') as f:
                    os.fchmod(f.fileno(), mode)
                    f.write(after)
                    f.flush()
                    os.fsync(f.fileno())
                if before is None:
                    try:
                        os.link(tmp, name, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
                    except FileExistsError:
                        fail('version_conflict', 'File was created concurrently', 'conflict')
                else:
                    os.replace(tmp, name, src_dir_fd=parent, dst_dir_fd=parent)
            finally:
                try:
                    os.unlink(tmp, dir_fd=parent)
                except FileNotFoundError:
                    pass
        os.fsync(parent)
        return receipt


def job_start(meta, req):
    p = dict(req['params'])
    lease_check(meta, p.get('lease'))
    command = p.get('command')
    if not isinstance(command, str) or not command or '\x00' in command:
        fail('invalid_argument', 'Command required')
    cwd = p.get('cwd', '.')
    with file_open(meta, cwd, True):
        pass
    timeout, cap = p.get('timeout_s'), p.get('output_cap_bytes')
    if timeout is not None and (type(timeout) not in (int, float) or not 0 < timeout < 1e12):
        fail('invalid_argument', 'timeout_s must be positive or null')
    if cap is not None:
        integer(cap, 1, 2**53-1)
    shell = p.get('shell', '/bin/sh')
    if not isinstance(shell, str) or not os.path.isabs(shell) or '\x00' in shell:
        fail('invalid_argument', 'Shell must be an absolute executable path')
    env = p.get('env', {})
    if not isinstance(env, dict) or any(not isinstance(k, str) or not isinstance(v, str) or '=' in k or '\x00' in k+v for k, v in env.items()):
        fail('invalid_argument', 'Invalid command environment')
    job = uid()
    path = os.path.join(meta['state_path'], 'jobs', job)
    private_dir(path)
    spec = dict(p, job_id=job, operation_id=req['operation_id'], timeout_s=timeout, output_cap_bytes=cap,
                cwd=os.path.join(meta['path'], *parts(meta, cwd)), shell=shell, token=uid(), root_id=meta['root_id'], generation=meta['generation'])
    atomic(os.path.join(path, 'spec.json'), spec)
    # operation->job mapping is durable BEFORE Popen; lost ACK can only query this identity.
    atomic(os.path.join(meta['state_path'], 'operations', ident(req['operation_id']) + '.job'), {'job_id': job})
    subprocess.Popen([sys.executable, '-B', '-I', meta['script'], '--supervisor', path], stdin=subprocess.DEVNULL,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True, close_fds=True)
    return dict(job_id=job, operation_id=req['operation_id'], state='starting', timeout_s=timeout, output_cap_bytes=cap)


def supervisor(path):
    """Storage failure policy: fail-stop the verified child, drain, reap, persist failure.

    Never leave a spawned child unsupervised because a receipt/log write failed.
    If storage remains full after reaping, this supervisor retries the durable failure
    record instead of fabricating exit.json or allowing an automatic respawn.
    """
    import select
    spec = load(os.path.join(path, 'spec.json'))
    with locked(os.path.join(path, 'supervisor.lock')):
        if os.path.exists(os.path.join(path, 'spawn-intent.json')):
            return
        atomic(os.path.join(path, 'spawn-intent.json'), {'at': now()})
        base = dict(job_id=spec['job_id'], operation_id=spec['operation_id'], timeout_s=spec['timeout_s'], output_cap_bytes=spec['output_cap_bytes'])
        logs, totals, retained = {}, {'stdout': 0, 'stderr': 0}, {'stdout': 0, 'stderr': 0}
        # Allocate storage handles before spawn. Failures here cannot orphan a child.
        try:
            for name in ('stdout', 'stderr'):
                logs[name] = open(os.path.join(path, name), 'ab', buffering=0)
        except OSError:
            for f in logs.values():
                f.close()
            try:
                atomic(os.path.join(path, 'storage-failed.json'), dict(base, reason='storage_failed', terminal_confirmed=False))
            except OSError:
                pass
            return
        env = os.environ.copy()
        env.update(spec.get('env', {}))
        try:
            child = subprocess.Popen([spec['shell'], '-c', spec['command']], cwd=spec['cwd'], env=env,
                                     stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                     start_new_session=True, close_fds=True)
        except OSError:
            for f in logs.values():
                f.close()
            raise  # Popen did not return a child; start remains unknown, never replayed.
        identity, failed, marker_saved = None, False, False
        start, reason, last_stop = time.monotonic(), None, None
        # Real Popen supplies both pipes. A test double or exceptional missing pipe
        # still follows wait/reap below, never an early return after successful Popen.
        pipes = {getattr(child, name): name for name in ('stdout', 'stderr') if getattr(child, name, None) is not None}

        def send(sig):
            nonlocal identity
            # Only this loop reaps. A live/unreaped child reserves its PID/group.
            # Shell exec may change command text, but not the recorded start identity.
            if child.poll() is not None:
                return False
            try:
                actual = process_identity(child.pid)
                if not actual:
                    return False
                if identity is None:
                    identity = actual
                if actual != identity and actual[:24] != identity[:24]:
                    return False
                if os.getpgid(child.pid) != child.pid:
                    return False
                os.killpg(child.pid, sig)
                return True
            except OSError:
                return False

        def storage_failure():
            nonlocal failed, reason, marker_saved
            failed, reason = True, 'storage_failed'
            if not marker_saved:
                try:
                    atomic(os.path.join(path, 'storage-failed.json'), dict(base, reason=reason, terminal_confirmed=False, at=now()))
                    marker_saved = True
                except OSError:
                    pass
            send(signal.SIGKILL)

        try:
            # Every post-spawn storage initialization is inside supervised handling.
            try:
                identity = process_identity(child.pid)
                atomic(os.path.join(path, 'running.json'), dict(supervisor_pid=os.getpid(), supervisor_identity=process_identity(os.getpid()),
                       pid_identity=dict(pid=child.pid, identity=identity), token=spec['token']))
            except OSError:
                storage_failure()
            if not pipes:
                # Missing capture streams: do not claim logs are complete.
                storage_failure()
                code = child.wait()
            else:
                while pipes or child.poll() is None:
                    if failed:
                        storage_failure()  # retry marker/identity if the earlier query failed
                    try:
                        stop = load(os.path.join(path, 'stop.json'))
                        if stop and stop['token'] == spec['token'] and stop['operation_id'] != last_stop:
                            last_stop = stop['operation_id']
                            if send(getattr(signal, stop['signal'])):
                                if not failed:
                                    reason = 'stopped'
                                atomic(os.path.join(path, 'stop-ack.json'), {'operation_id': last_stop, 'at': now()})
                        if reason is None and spec['timeout_s'] is not None and time.monotonic()-start >= spec['timeout_s']:
                            if send(signal.SIGKILL):
                                reason = 'timeout'
                    except (OSError, ValueError):
                        storage_failure()
                    try:
                        ready = select.select(list(pipes), [], [], 0.05)[0] if pipes else []
                        if not pipes:
                            time.sleep(0.05)
                    except OSError:
                        storage_failure()
                        time.sleep(0.05)
                        continue
                    for pipe in ready:
                        name = pipes[pipe]
                        try:
                            data = os.read(pipe.fileno(), 65536)
                        except OSError:
                            storage_failure()
                            continue
                        if not data:
                            del pipes[pipe]
                            pipe.close()
                            continue
                        totals[name] += len(data)
                        if failed:
                            continue  # drain without unbounded memory; discarded bytes become explicit gaps
                        cap = spec['output_cap_bytes']
                        keep = data if cap is None else data[:max(0, cap-sum(retained.values()))]
                        try:
                            written = 0
                            while written < len(keep):
                                count = logs[name].write(keep[written:])
                                if not count:
                                    raise OSError('short log write')
                                written += count
                                retained[name] += count
                            if keep:
                                os.fsync(logs[name].fileno())
                            if cap is not None:
                                atomic(os.path.join(path, 'progress.json'), dict(totals=totals, retained=retained))
                                if sum(totals.values()) > cap and reason is None:
                                    send(signal.SIGKILL)
                                    reason = 'output_cap'
                        except OSError:
                            storage_failure()
                code = child.wait()
            terminal = dict(base, state='exited', exit_code=code if code>=0 else None, signal=-code if code<0 else None,
                            ended_at=now(), reason=reason, stdout_bytes=totals['stdout'], stderr_bytes=totals['stderr'],
                            stdout_retained=retained['stdout'], stderr_retained=retained['stderr'])
            # No successful-looking exit.json on a storage failure. This distinct failure
            # record confirms reaping and incomplete logs; job_status exposes the reason.
            while True:
                try:
                    if failed:
                        atomic(os.path.join(path, 'storage-failed.json'), dict(terminal, reason='storage_failed',
                               terminal_confirmed=True, log_complete=False))
                    else:
                        atomic(os.path.join(path, 'exit.json'), terminal)
                    break
                except OSError:
                    storage_failure()
                    time.sleep(0.2)
        finally:
            # This is reached only after child.wait and durable terminal/failure handling,
            # not as an OSError escape hatch that abandons a still-running child.
            for f in logs.values():
                f.close()



def policy_scope(fd, path):
    """Read-only, descriptor-scoped capabilities. No probe/cache file is ever written.
    A statfs type alone is NOT permission to assume all Linux filesystems are byte-exact.
    """
    st = os.fstat(fd)
    result = dict(path=path, device=st.st_dev, inode=st.st_ino, case_sensitive=None,
                  unicode='opaque', source='unknown')
    try:
        import ctypes
        import array
        libc = ctypes.CDLL(None, use_errno=True)
        if sys.platform == 'darwin':
            # Darwin sys/mount.h __DARWIN_STRUCT_STATFS64 (2168 bytes). Only use
            # f_fstypename; do not expose mount-from names or other system metadata.
            class StatFS(ctypes.Structure):
                _fields_ = [('bsize', ctypes.c_uint32), ('iosize', ctypes.c_int32),
                    ('blocks', ctypes.c_uint64), ('bfree', ctypes.c_uint64), ('bavail', ctypes.c_uint64),
                    ('files', ctypes.c_uint64), ('ffree', ctypes.c_uint64), ('fsid', ctypes.c_int32 * 2),
                    ('owner', ctypes.c_uint32), ('type', ctypes.c_uint32), ('flags', ctypes.c_uint32),
                    ('subtype', ctypes.c_uint32), ('name', ctypes.c_char * 16),
                    ('mount', ctypes.c_char * 1024), ('from_', ctypes.c_char * 1024),
                    ('reserved', ctypes.c_uint32 * 8)]
            query = libc.fstatfs64
            query.argtypes, query.restype = [ctypes.c_int, ctypes.POINTER(StatFS)], ctypes.c_int
            native = StatFS()
            if query(fd, ctypes.byref(native)) != 0 or native.name not in (b'apfs', b'hfs'):
                return result  # SMB/NFS/FUSE may have other name aliases; do not guess.
            case = os.fpathconf(fd, 11)  # Darwin sys/unistd.h _PC_CASE_SENSITIVE
            if case in (0, 1):
                result.update(case_sensitive=bool(case), source='darwin-fpathconf')
        elif sys.platform == 'linux':
            query = libc.fstatfs
            query.argtypes, query.restype = [ctypes.c_int, ctypes.c_void_p], ctypes.c_int
            native = ctypes.create_string_buffer(512)
            if query(fd, native) != 0:
                return result
            magic = ctypes.c_long.from_buffer(native).value & 0xffffffff
            # ext2/3/4, f2fs, tmpfs: require actual inode flags, including per-directory
            # FS_CASEFOLD_FL. Overlay/NFS/CIFS/FUSE and failed ioctls remain unknown.
            if magic not in (0xef53, 0xf2f52010, 0x01021994):
                return result
            flags = array.array('l', [0])
            request = (2 << 30) | (flags.itemsize << 16) | (ord('f') << 8) | 1  # FS_IOC_GETFLAGS
            fcntl.ioctl(fd, request, flags, True)
            sensitive = not bool(flags[0] & 0x40000000)  # FS_CASEFOLD_FL
            result.update(case_sensitive=sensitive, unicode='byte-exact' if sensitive else 'opaque', source='linux-inode-flags')
    except (OSError, ValueError, AttributeError, TypeError, ImportError):
        pass
    return result


def policy_glob(name, pattern, budget, insensitive=False):
    """Bounded fnmatchcase DP. * and ? cross '/', as in the existing file-tool policy.
    Using regex on a whole adversarial glob can backtrack exponentially on Python 3.9.
    """
    import fnmatch
    tokens, index = [], 0
    while index < len(pattern):
        char = pattern[index]
        if char == '*':
            if not tokens or tokens[-1][0] != '*':
                tokens.append(('*', ''))
        elif char == '?':
            tokens.append(('?', ''))
        elif char == '[':
            end = index + 1
            if end < len(pattern) and pattern[end] == '!': end += 1
            if end < len(pattern) and pattern[end] == ']': end += 1
            while end < len(pattern) and pattern[end] != ']': end += 1
            if end < len(pattern):
                tokens.append(('class', pattern[index:end+1]))
                index = end
            else:
                tokens.append(('literal', char))
        else:
            tokens.append(('literal', char))
        index += 1
    budget[0] -= max(1, len(tokens)) * max(1, len(name)) * (2 if insensitive else 1)
    if budget[0] < 0:
        fail('policy_budget_exceeded', 'Policy matching work budget exceeded')
    previous = [True] + [False] * len(name)
    for kind, value in tokens:
        current = [False] * (len(name)+1)
        if kind == '*':
            current[0] = previous[0]
            for i in range(1, len(name)+1): current[i] = previous[i] or current[i-1]
        else:
            for i, char in enumerate(name, 1):
                if not previous[i-1]:
                    continue
                if kind == '?':
                    current[i] = True
                elif kind == 'literal':
                    current[i] = char.lower() == value.lower() if insensitive else char == value
                elif insensitive:
                    # Do NOT lowercase class ranges: [A-z] contains punctuation which
                    # [a-z] would drop. Negation applies after the ASCII alias union.
                    aliases = (fnmatch.fnmatchcase(char.lower(), value), fnmatch.fnmatchcase(char.upper(), value))
                    current[i] = all(aliases) if value.startswith('[!') else any(aliases)
                else:
                    current[i] = fnmatch.fnmatchcase(char, value)
        previous = current
    return previous[-1]


def policy_ascii(value):
    return all(32 <= ord(char) < 127 for char in value)


def policy_unicode_positive(value, sensitive):
    """Conservative positive-only heuristic, NEVER evidence of a negative match.
    We do not claim Python's Unicode tables are the filesystem's Unicode tables.
    """
    import unicodedata
    value = unicodedata.normalize('NFD', value)
    value = ''.join(char for char in value if unicodedata.category(char) != 'Cf')
    return value if sensitive else value.casefold()


def policy_literal_component(context, pattern):
    fd, name, target, scope = context
    if pattern == name:
        return True, False
    try:
        other = os.stat(pattern, dir_fd=fd, follow_symlinks=False)
    except FileNotFoundError:
        other = None
    except OSError:
        fail('policy_semantics_unavailable', 'Cannot safely query a policy name in its actual parent')
    # Existing names use the real filesystem as a read-only equivalence oracle.
    # This works even on an otherwise unknown network filesystem, without a probe.
    if target is not None or other is not None:
        return bool(target is not None and other is not None and
                    (target.st_dev, target.st_ino) == (other.st_dev, other.st_ino)), False
    sensitive = scope['case_sensitive']
    if scope['unicode'] == 'byte-exact':
        return name == pattern, False
    if sensitive is not None and policy_ascii(name) and policy_ascii(pattern):
        return (name == pattern if sensitive else name.lower() == pattern.lower()), False
    if sensitive is not None and policy_unicode_positive(name, sensitive) == policy_unicode_positive(pattern, sensitive):
        return True, True
    fail('policy_semantics_unavailable', 'Absent policy names have no proven filesystem equivalence; write must be refused')


def policy_match(meta, p):
    patterns = p.get('patterns')
    if not isinstance(patterns, list) or len(patterns) > 256:
        fail('invalid_argument', 'Policy patterns must be a list of at most 256 globs')
    if not isinstance(p.get('path'), str) or len(p['path']) > 4096:
        fail('invalid_argument', 'Policy path exceeds budget')
    for pattern in patterns:
        if (not isinstance(pattern, str) or not pattern or len(pattern) > 4096 or
                '\x00' in pattern or pattern.startswith('/') or '..' in pattern.split('/')):
            fail('invalid_argument', 'Policy globs must be bounded relative paths')
    resolved = resolve_file(meta, p['path'], allow_missing=p.get('allow_missing', True))
    rel = resolved['path']
    result = dict(path=rel, absolute_path=resolved['absolute_path'], exists=resolved['exists'],
                  matches=[], matched_patterns=[], conservative=False, scopes=[])
    if not patterns:
        return result  # Unknown semantics must NOT disable a path with no applicable rules.
    names = [] if rel == '.' else rel.split('/')
    if len(names) > 128:
        fail('policy_budget_exceeded', 'Too many policy path components')
    fds, contexts = [], []
    budget = [2000000]
    try:
        fd = os.open(meta['path'], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        fds.append(fd)
        rst = os.fstat(fd)
        if [rst.st_dev, rst.st_ino] != meta['signature'][:2]:
            fail('root_changed', 'Policy root descriptor changed', 'conflict')
        for i, name in enumerate(names):
            scope = policy_scope(fd, '/'.join(names[:i]) or '.')
            result['scopes'].append(scope)
            try:
                target = os.stat(name, dir_fd=fd, follow_symlinks=False)
            except FileNotFoundError:
                if i != len(names)-1 or resolved['exists']:
                    fail('version_conflict', 'Policy path changed while resolving', 'conflict')
                target = None
            if target is not None:
                deny_private_identity(meta, target, name)
            contexts.append((fd, name, target, scope))
            if i < len(names)-1:
                fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                fds.append(fd)
                deny_private_identity(meta, os.fstat(fd), name)
        for pattern in patterns:
            conservative = False
            prefix = pattern[:-3] if pattern.endswith('/**') else None
            literal = pattern if not any(char in pattern for char in '*?[') else None
            if prefix is not None and not any(char in prefix for char in '*?['):
                pieces = prefix.split('/')
                matched = len(names) > len(pieces)
            elif literal is not None:
                pieces = literal.split('/')
                matched = len(names) == len(pieces)
            else:
                pieces, matched = None, False
            if literal is not None and pattern == rel:
                matched = True
            elif pieces is not None:
                if matched:
                    for context, piece in zip(contexts, pieces):
                        equal, uncertain = policy_literal_component(context, piece)
                        conservative |= uncertain
                        if not equal:
                            matched = False
                            break
            else:
                modes = {(scope['case_sensitive'], scope['unicode']) for scope in result['scopes']}
                if not modes:
                    modes = {(True, 'byte-exact')}
                if modes == {(True, 'byte-exact')}:
                    matched = policy_glob(rel, pattern, budget)
                elif len(modes) == 1 and next(iter(modes))[0] is not None and policy_ascii(rel) and policy_ascii(pattern):
                    sensitive = next(iter(modes))[0]
                    matched = policy_glob(rel, pattern, budget, insensitive=not sensitive)
                else:
                    # Positive-only conservative denial is safe; a guessed negative is NOT.
                    # Mixed mounts/per-directory rules cannot be flattened to root semantics.
                    matched = policy_glob(rel, pattern, budget)
                    if not matched and len(modes) == 1 and next(iter(modes))[0] is not None:
                        sensitive = next(iter(modes))[0]
                        matched = policy_glob(policy_unicode_positive(rel, sensitive), policy_unicode_positive(pattern, sensitive), budget)
                    if not matched:
                        fail('policy_semantics_unavailable', 'Unicode/glob or mixed-directory equivalence is not proven; write must be refused')
                    conservative = True
            result['matches'].append(matched)
            if matched:
                result['matched_patterns'].append(pattern)
                result['conservative'] |= conservative
        return result
    finally:
        for fd in reversed(fds):
            os.close(fd)


def dispatch(meta, req):
    validate(meta, req)
    method, p = req['method'], req['params']
    if method == 'roots.validate':
        return public_root(meta)
    if method == 'files.policyMatch':
        return policy_match(meta, p)
    if method == 'files.resolve':
        return resolve_file(meta, p['path'], allow_missing=p.get('allow_missing', False))
    if method == 'files.stat':
        with parent_fd(meta, p['path']) as (fd, name):
            result = stat_result(p['path'], os.stat(name, dir_fd=fd, follow_symlinks=False))
        if result['kind'] == 'file':
            with file_open(meta, p['path']) as fd:
                result['sha256'] = file_hash(fd)[0]
        return result
    if method == 'files.list':
        return listing(meta, p)
    if method == 'files.read':
        return read_page(meta, p)
    if method == 'files.tail':
        return tail_page(meta, p)
    if method == 'files.search':
        query = p.get('query', '').encode('utf-8')
        if not query or len(query) > 4096:
            fail('invalid_argument', 'Literal query must be 1..4096 UTF-8 bytes')
        page = read_page(meta, p)
        data = unb64(page['data'])
        if not page['eof'] and len(data) < len(query):
            fail('invalid_argument', 'Search page must be at least query length')
        matches, pos = [], 0
        while len(matches) < 1000:
            found = data.find(query, pos)
            if found < 0:
                break
            matches.append(page['byte_offset']+found)
            pos = found+1
        next_offset = page['byte_offset']+pos if len(matches)==1000 else page['next_offset'] if page['eof'] else page['next_offset']-len(query)+1
        return dict(matches=matches, next_offset=next_offset, eof=page['eof'] and len(matches)<1000, sha256=page['sha256'], incomplete=not page['eof'] or len(matches)==1000)
    if method == 'operations.status':
        result = load(operation_path(meta, p['operation_id']))
        if not result:
            return dict(operation_id=p['operation_id'], state='not_found')
        return {k: v for k, v in result.items() if k not in ('digest', 'message')}
    if method == 'jobs.recover':
        mapped = load(os.path.join(meta['state_path'], 'operations', ident(p['operation_id'])+'.job'))
        if not mapped:
            fail('outcome_unknown', 'No durable job mapping; do not rerun automatically', 'unknown')
        return job_status(meta, mapped['job_id'])
    if method == 'jobs.status':
        return job_status(meta, p['job_id'])
    if method == 'jobs.read':
        path = job_dir(meta, p['job_id'])
        stream = p.get('stream')
        if stream not in ('stdout', 'stderr'):
            fail('invalid_argument', 'Invalid stream')
        offset = integer(p.get('byte_offset', 0), 0, 2**53-1)
        limit = integer(p.get('limit', PAGE), 1, PAGE)
        terminal = load(os.path.join(path, 'exit.json'))
        storage = load(os.path.join(path, 'storage-failed.json'))
        if not terminal and storage and storage.get('terminal_confirmed'):
            terminal = storage
        try:
            with open(os.path.join(path, stream), 'rb') as f:
                size = os.fstat(f.fileno()).st_size
                f.seek(offset)
                data = f.read(limit)
        except FileNotFoundError:
            size, data = 0, b''
        progress = load(os.path.join(path, 'progress.json'), {})
        total = terminal[stream+'_bytes'] if terminal else max(size, progress.get('totals', {}).get(stream, size))
        return dict(data=b64(data), byte_offset=offset, next_offset=offset+len(data), total_written=total, total_retained=size,
                    gaps=[dict(start=size, end=total)] if total>size else [], eof=bool(terminal) and offset+len(data)>=size,
                    storage_failed=bool(storage), log_complete=not bool(storage) and total==size)
    # Mutations serialized across aliases against the root's single state lock.
    with locked(os.path.join(meta['state_path'], 'mutation.lock')):
        validate(meta, req)
        if method == 'leases.inspect':
            return load(os.path.join(meta['state_path'], 'lease.json'))

        def work():
            if method in ('files.write', 'files.edit', 'files.remove'):
                return write_file(meta, req)
            if method == 'jobs.start':
                return job_start(meta, req)
            if method == 'jobs.stop':
                path = job_dir(meta, p['job_id'])
                status = job_status(meta, p['job_id'])
                if status['state'] == 'exited':
                    return dict(job_id=p['job_id'], state='terminal-confirmed', job=status)
                sig = p.get('signal', 'SIGTERM')
                if sig not in ('SIGTERM', 'SIGKILL', 'SIGINT'):
                    fail('invalid_argument', 'Signal not supported')
                spec = load(os.path.join(path, 'spec.json'))
                atomic(os.path.join(path, 'stop.json'), dict(operation_id=req['operation_id'], token=spec['token'], signal=sig))
                return dict(job_id=p['job_id'], state='requested', job=status)
            lease_path = os.path.join(meta['state_path'], 'lease.json')
            if method == 'leases.acquire':
                owner = ident(p['owner_id'])
                current = load(lease_path)
                if current:
                    fail('lease_conflict', 'Root already has a writer; timeout/disconnect never steals it', 'conflict')
                counter_path = os.path.join(meta['state_path'], 'fence.json')
                fence = load(counter_path, 0)+1
                atomic(counter_path, fence)
                lease = dict(lease_id=uid(), owner_id=owner, fence=fence, updated_at=now())
                atomic(lease_path, lease)
                return lease
            if method == 'leases.renew':
                lease = lease_check(meta, p.get('lease'))
                lease['updated_at'] = now()
                atomic(lease_path, lease)
                return lease
            if method == 'leases.release':
                lease_check(meta, p.get('lease'))
                for job in os.listdir(os.path.join(meta['state_path'], 'jobs')):
                    if job_status(meta, job)['state'] != 'exited':
                        fail('outcome_unknown', 'Active or unknown job retains writer lease', 'unknown')
                for name in os.listdir(os.path.join(meta['state_path'], 'operations')):
                    if name.endswith('.json') and name != req['operation_id']+'.json':
                        operation = load(os.path.join(meta['state_path'], 'operations', name))
                        if operation['state'] == 'prepared':
                            fail('outcome_unknown', 'Unsettled operation retains writer lease', 'unknown')
                os.unlink(lease_path)
                syncdir(meta['state_path'])
                return dict(released=True)
            fail('capability_unavailable', 'Unknown remote method')
        return mutation(meta, req, work)


def exact(stream, n):
    chunks = bytearray()
    while len(chunks) < n:
        part = stream.read(n-len(chunks))
        if not part:
            raise EOFError()
        chunks.extend(part)
    return bytes(chunks)


def serve():
    meta = None
    while True:
        try:
            head = exact(sys.stdin.buffer, 8)
        except EOFError:
            return
        if head[:4] != b'OSR1':
            return
        size = struct.unpack('>I', head[4:])[0]
        if size > FRAME:
            return
        try:
            req = json.loads(exact(sys.stdin.buffer, size).decode('utf-8'))
        except (EOFError, ValueError):
            return
        response = {k: req.get(k) for k in ('protocol', 'request_id', 'operation_id', 'generation', 'root_id')}
        try:
            if req.get('protocol') != 1:
                fail('protocol_mismatch', 'Protocol 1 required')
            method, p = req['method'], req['params']
            if method == 'probe':
                result = probe()
            elif method == 'openRoot':
                # One long-lived channel serves many batches: a failed open must never leave the
                # previous batch's root context for the method frame that follows it.
                meta = None
                meta = root_open(p)
                result = public_root(meta)
            elif method == 'listDirs':
                path = os.path.realpath(p['path'])
                if not os.path.isabs(p['path']):
                    fail('invalid_argument', 'Explicit absolute directory required')
                result = listing(dict(path=path, state_path=os.path.join(path, '.oasis-remote')), dict(path='.', limit=300))
                result['path'] = path
            else:
                if meta is None:
                    fail('root_changed', 'Open/pin a root before scoped RPC')
                result = dispatch(meta, req)
            response.update(ok=True, result=result)
        except Refused as e:
            response.update(ok=False, error=dict(code=e.code, status=e.status, reason=str(e), retryable=e.status=='unknown'))
        except FileNotFoundError:
            response.update(ok=False, error=dict(code='not_found', status='refused', reason='Remote path does not exist', retryable=False))
        except (OSError, ValueError, TypeError, KeyError) as e:
            # No environment, command content, key material, or arbitrary exception repr in diagnostics.
            response.update(ok=False, error=dict(code='storage_failed' if isinstance(e, OSError) else 'invalid_argument',
                            status='unknown' if isinstance(e, OSError) else 'refused', reason=type(e).__name__, retryable=False))
        data = json.dumps(response, separators=(',', ':'), ensure_ascii=True).encode()
        if len(data) > FRAME:
            return
        sys.stdout.buffer.write(b'OSR1'+struct.pack('>I', len(data))+data)
        sys.stdout.buffer.flush()


if __name__ == '__main__':
    if len(sys.argv)>1 and sys.argv[1] == '--supervisor':
        supervisor(sys.argv[2])
    else:
        serve()
