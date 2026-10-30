// Copied read-only from independent review; only adapter path and temp helper adapted. Assertions unchanged.
/** Independent adapter fault tests; Python runs locally in a fresh HOME/root, no SSH/sshd.
 * No real job child or signal is created: supervisor Popen is replaced only in the fault case.
 * Other cases exercise the actual adapter filesystem and persisted operation/lease code.
 */
import { expect, test, afterEach } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
const ownedTemps: string[] = []
function tempDir(prefix: string) { const p=mkdtempSync('/tmp/'+prefix); ownedTemps.push(p); return p }
afterEach(() => { for(const p of ownedTemps.splice(0)) rmSync(p,{recursive:true,force:true}) })

const adapter = process.env.REMOTE_REVIEW_ADAPTER ?? fileURLToPath(new URL('./adapter.py', import.meta.url))
const script = String.raw`
import importlib.util, os, sys, json, errno
spec = importlib.util.spec_from_file_location('review_adapter', sys.argv[1])
a = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)
root = sys.argv[2]
case = sys.argv[3]
a.registry_path = lambda: os.path.join(root, '.review-private-registry')
# All root identity probing is real; it only queries boot identity, not SSH or user config.
m = a.root_open({'path': root})
def request(method, params, op):
    return dict(method=method, params=params, operation_id=op, root_id=m['root_id'], generation=m['generation'])
def call(method, params, op):
    return a.dispatch(m, request(method, params, op))
lease = call('leases.acquire', {'owner_id': 'review_owner'}, 'acquire')
def refused(fn):
    try:
        fn()
        return None
    except a.Refused as e:
        return e.code
out = {}
if case == 'supervisor-running-storage':
    path = os.path.join(m['state_path'], 'jobs', 'review_job')
    a.private_dir(path)
    a.atomic(os.path.join(path, 'spec.json'), dict(job_id='review_job', operation_id='start', timeout_s=None,
        output_cap_bytes=None, shell='/bin/sh', command='never actually executed', cwd=root, token='review_token'))
    class Child:
        pid = 987654321
        waited = False
        def poll(self): return None
        def wait(self, *args, **kwargs):
            self.waited = True
            return 0
    child = Child()
    a.subprocess.Popen = lambda *args, **kwargs: child
    a.process_identity = lambda pid: 'review fake identity'
    original = a.atomic
    def fault(path, value):
        if os.path.basename(path) == 'running.json':
            raise OSError(errno.ENOSPC, 'review injected full storage')
        return original(path, value)
    a.atomic = fault
    escaped = None
    try:
        a.supervisor(path)
    except OSError as e:
        escaped = e.errno
    out = dict(escaped_errno=escaped, child_waited=child.waited,
        storage_failure_recorded=os.path.exists(os.path.join(path, 'storage-failed.json')),
        terminal_recorded=os.path.exists(os.path.join(path, 'exit.json')),
        status=a.job_status(m, 'review_job')['state'])
elif case == 'journal-before-replace':
    file = os.path.join(root, 'note.txt')
    with open(file, 'wb') as f: f.write(b'before')
    original = a.os.replace
    def fault(src, dst, *args, **kwargs):
        if dst == 'note.txt': raise OSError(errno.ENOSPC, 'review injected replace failure')
        return original(src, dst, *args, **kwargs)
    a.os.replace = fault
    try:
        call('files.write', dict(path='note.txt', data=a.b64(b'after'), expected_hash=a.sha(b'before'), lease=lease), 'write')
    except OSError:
        pass
    image = a.load(a.operation_path(m, 'write') + '.images')
    with open(file, 'rb') as f: content = f.read().decode()
    out = dict(content=content, operation_state=a.load(a.operation_path(m, 'write'))['state'], image_state=image['state'])
elif case == 'unknown-lease':
    path = os.path.join(m['state_path'], 'jobs', 'unknown_job')
    a.private_dir(path)
    a.atomic(os.path.join(path, 'spec.json'), dict(operation_id='lost_start'))
    code = refused(lambda: call('leases.release', {'lease': lease}, 'release'))
    out = dict(code=code, held=a.load(os.path.join(m['state_path'], 'lease.json')) == lease)
elif case == 'prepared-lease':
    a.atomic(a.operation_path(m, 'lost_write'), dict(state='prepared', digest='test'))
    code = refused(lambda: call('leases.release', {'lease': lease}, 'release'))
    out = dict(code=code, held=a.load(os.path.join(m['state_path'], 'lease.json')) == lease)
elif case == 'prepared-no-replay':
    req = request('files.write', {'path': 'note.txt'}, 'lost_write')
    invoked = []
    def work():
        invoked.append(True)
        raise OSError(errno.ENOSPC, 'review lost completion')
    try: a.mutation(m, req, work)
    except OSError: pass
    code = refused(lambda: a.mutation(m, req, work))
    out = dict(code=code, invocations=len(invoked), state=a.load(a.operation_path(m, 'lost_write'))['state'])
elif case == 'external-change':
    with open(os.path.join(root, 'note.txt'), 'wb') as f: f.write(b'external')
    code = refused(lambda: call('files.write', dict(path='note.txt', data=a.b64(b'after'), expected_hash=a.sha(b'before'), lease=lease), 'write'))
    with open(os.path.join(root, 'note.txt'), 'rb') as f: content=f.read().decode()
    out = dict(code=code, content=content)
elif case == 'canonical-alias':
    alias = os.path.join(root, 'alias')
    os.symlink(root, alias)
    alias_meta = a.root_open({'path': alias})
    req = dict(method='leases.acquire', params={'owner_id': 'other'}, operation_id='alias_acquire', root_id=alias_meta['root_id'], generation=alias_meta['generation'])
    code = refused(lambda: a.dispatch(alias_meta, req))
    out = dict(code=code, same_root=alias_meta['root_id']==m['root_id'], same_state=alias_meta['state_path']==m['state_path'])
elif case == 'page-hash-cost':
    size = 4*a.PAGE
    with open(os.path.join(root, 'large.bin'), 'wb') as f: f.write(b'x'*size)
    original = a.file_hash
    hashed = []
    def counted(fd, *args, **kwargs):
        hashed.append(os.fstat(fd).st_size)
        return original(fd, *args, **kwargs)
    a.file_hash = counted
    read = 0
    for offset in range(0, size, a.PAGE):
        page=a.read_page(m, dict(path='large.bin', byte_offset=offset, limit=a.PAGE))
        read += len(a.unb64(page['data']))
    out = dict(returned_bytes=read, hashed_bytes=sum(hashed), hash_calls=len(hashed))
else:
    raise AssertionError('unknown review scenario')
print(json.dumps(out))
`

function scenario(name: string): Record<string, unknown> {
  const home = tempDir('oasis-ssh-review-python-')
  const result = spawnSync('python3', ['-B', '-I', '-c', script, adapter, home, name], {
    env: { PATH: process.env.PATH, HOME: home, TMPDIR: home, LANG: 'en_US.UTF-8' }, encoding: 'utf8', timeout: 10_000,
  })
  expect(result.status, result.stderr).toBe(0)
  return JSON.parse(result.stdout)
}

test('ssh review: post-spawn running receipt failure stays inside supervisor storage handling', () => {
  const result = scenario('supervisor-running-storage')
  expect(result, JSON.stringify(result)).toMatchObject({ escaped_errno: null, storage_failure_recorded: true, terminal_recorded: false })
})

test('ssh review: before-image persisted before failed replace never claims applied', () => {
  const result = scenario('journal-before-replace')
  expect(result).toMatchObject({ content: 'before', operation_state: 'prepared' })
  expect(result.image_state, JSON.stringify(result)).not.toBe('applied')
})

test('ssh review: unknown durable job retains writer lease', () => {
  expect(scenario('unknown-lease')).toEqual({ code: 'outcome_unknown', held: true })
})
test('ssh review: prepared file mutation retains writer lease', () => {
  expect(scenario('prepared-lease')).toEqual({ code: 'outcome_unknown', held: true })
})
test('ssh review: lost mutation receipt cannot rerun side effects', () => {
  expect(scenario('prepared-no-replay')).toEqual({ code: 'outcome_unknown', invocations: 1, state: 'prepared' })
})
test('ssh review: external file modification fails expected hash without overwrite', () => {
  expect(scenario('external-change')).toEqual({ code: 'version_conflict', content: 'external' })
})
test('ssh review: canonical root aliases cannot acquire separate writer leases', () => {
  expect(scenario('canonical-alias')).toEqual({ code: 'lease_conflict', same_root: true, same_state: true })
})
test('ssh review: quantify current full-hash-per-page cost (characterization, not performance approval)', () => {
  const result = scenario('page-hash-cost')
  console.info('SSH review page hash cost:', JSON.stringify(result))
  expect(result.returned_bytes).toBe(1024 * 1024)
  // Keep optimization legal; this assertion checks valid accounting, not the inefficient implementation.
  expect(Number(result.hashed_bytes)).toBeGreaterThanOrEqual(0)
})
