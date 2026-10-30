/** A session's attached files, read exactly: an uploaded file is granted to its own session's commands as one literal
 *  path — read only, never written or linked, sealed (read back from the file) before it is granted, its folder and
 *  siblings, another session's files, the data directory and the credential stores closed as before — and only from
 *  the harness's own records, under the harness's own data directory; a local file is read by the harness only at its
 *  real path, outside the denied roots, as the inode it was before and after the read, without following a link,
 *  without blocking, never past a bound. A box without exact reads renders exactly what it always did. */

import { afterAll, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BubblewrapRuntime, exactReadProblems, SandboxInputRefused, SeatbeltRuntime, type Sandbox } from '../src/execution/isolation.ts'
import {
  AttachmentAccessRefused, authorizedPaths, authorizeInputFiles, identityOf, inspectLocalSource, isSealed, readLocalBounded, sameIdentity,
  sealStoredFile, unsealStoredFile, type AuthorizedInputFiles, type FileIdentity, type StoredInputRecord,
} from '../src/workspace/attachment_access.ts'
import { sandboxForWorkspace } from '../src/workspace/sandbox.ts'

const mac = process.platform === 'darwin'
const roots: string[] = []
/** sealed store files, unsealed (through the store-only helper) before their folders are removed */
const sealed: { path: string; scope: { data_dir: string; store_root: string } }[] = []
afterAll(() => {
  for (const f of sealed) { try { unsealStoredFile(f.path, f.scope) } catch { /* gone or replaced */ } }
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

function root(): string {
  const r = realpathSync.native(mkdtempSync(join(tmpdir(), 'oasis-attach-access-')))
  roots.push(r)
  return r
}

/** A data directory with an asset store, two sessions' uploads in one project folder (sealed on macOS, as the store
 *  keeps them), a workspace per session. */
function world() {
  const base = root()
  const data = join(base, 'data')
  const store = join(data, 'assets')
  const folder = join(store, 'p1', 'data')
  mkdirSync(folder, { recursive: true })
  const a = join(folder, 'aaaaaaaaaaaaaaaa.mp4')
  const b = join(folder, 'bbbbbbbbbbbbbbbb.mp4')
  writeFileSync(a, 'SESSION-A-VIDEO')
  writeFileSync(b, 'SESSION-B-VIDEO')
  writeFileSync(join(data, 'index.db'), 'DATABASE')
  const wsA = join(data, 'workspaces', 'ws_a')
  const wsB = join(data, 'workspaces', 'ws_b')
  const repo = join(data, 'repos', 'p1', 'base.git')
  for (const d of [wsA, wsB, repo]) mkdirSync(d, { recursive: true })
  const scope = { data_dir: data, store_root: store }
  const seal = (path: string): FileIdentity => {
    const { identity } = sealStoredFile(path, scope)
    sealed.push({ path, scope })
    return identity
  }
  const ida = mac ? seal(a) : identityOf(statSync(a, { bigint: true }))
  const idb = mac ? seal(b) : identityOf(statSync(b, { bigint: true }))
  const rec = (over: Partial<StoredInputRecord> = {}): StoredInputRecord => ({
    asset_id: 'a_1', project_id: 'p1', session_id: 's_a', role: 'attachment', origin: 'upload', storage_path: 'p1/data/aaaaaaaaaaaaaaaa.mp4', bytes: 15, identity: ida, ...over,
  })
  const project = { kind: 'snapshot' as const, source_path: null, base_repo_path: repo }
  return { base, data, store, folder, a, b, ida, idb, wsA, wsB, rec, project, scope, seal }
}

const grant = (w: ReturnType<typeof world>, records: StoredInputRecord[], session = { id: 's_a', project_id: 'p1' }): AuthorizedInputFiles =>
  authorizeInputFiles({ data_dir: w.data, store_root: w.store, session, records })

const runtime = (w: { data: string }) => new SeatbeltRuntime({ extra_read_deny: [w.data] })

test('a box without exact reads renders the profile and the bubblewrap command it always did; the fingerprints are unchanged', () => {
  const w = world()
  const box = sandboxForWorkspace(w.data, w.project, { path: w.wsA }, { network: false })
  expect('exact_reads' in box).toBe(false)
  const withNone = sandboxForWorkspace(w.data, w.project, { path: w.wsA, session_id: 's_a', project_id: 'p1' }, { network: false, input_files: grant(w, []) })
  expect(withNone).toEqual(box)
  const sb = runtime(w)
  for (const none of [null, { files: [], within: [], data_root: w.data }]) {
    expect(sb.profile({ ...box, exact_reads: none })).toBe(sb.profile(box))
    expect(new BubblewrapRuntime().command(['x'], { ...box, exact_reads: none }, '/p')).toEqual(new BubblewrapRuntime().command(['x'], box, '/p'))
  }
  expect(sb.profile(box)).not.toContain('exact input files')
  // the template and the credential list are those of the baseline (7b83d48): its recorded fingerprints stand
  expect(new SeatbeltRuntime().fingerprint()).toBe('8d8ce3795f47efed')
  expect(new SeatbeltRuntime({ extra_read_deny: ['/x'] }).fingerprint()).toBe('27d14b703fb7f267')
  expect(new BubblewrapRuntime().fingerprint()).toBe('0856172ee9170969')
})

test.skipIf(!mac)('a sealed upload of the session is one literal: read, never written, renamed or linked; no folder, no sibling, no database', () => {
  const w = world()
  const g = grant(w, [w.rec()])
  expect(g.refused).toEqual([])
  expect(authorizedPaths(g)).toEqual([w.a])
  const box = sandboxForWorkspace(w.data, w.project, { path: w.wsA, session_id: 's_a', project_id: 'p1' }, { network: false, input_files: g })
  expect(box.exact_reads).toEqual({ files: [w.a], within: [w.store], data_root: w.data })
  expect(box.writable.some((p) => w.a.startsWith(p))).toBe(false)
  const profile = runtime(w).profile(box)
  const tail = profile.slice(profile.indexOf(';; exact input files'))
  expect(profile.indexOf(';; exact input files')).toBeGreaterThan(profile.indexOf(`(deny file-read*`))
  expect(tail).toContain(`(allow file-read*\n  (literal "${w.a}"))`)
  expect(tail).toContain(`(deny file-write*\n  (literal "${w.a}"))`)
  expect(tail).toContain(`(deny file-link\n  (literal "${w.a}"))`)
  // the folders above it: their metadata only, by literal — never a listing, never a subpath
  const metadata = /\(allow file-read-metadata\n([^)]*\)(?:\n  [^)]*\))*)\)/.exec(tail)?.[1] ?? ''
  for (const folder of [w.data, w.store, join(w.store, 'p1'), w.folder]) expect(metadata).toContain(`(literal "${folder}")`)
  expect(metadata).not.toContain('subpath')
  for (const wide of [w.folder, w.store, join(w.store, 'p1'), w.data]) {
    expect(profile).not.toContain(`(allow file-read*\n  (subpath "${wide}")`)
    expect(tail).not.toContain(`(subpath "${wide}")`)
  }
  expect(profile).not.toContain(w.b)
  expect(profile).not.toContain(join(w.data, 'index.db'))
  expect(profile).toContain(`(subpath "${w.data}")`)
  // bubblewrap: the file alone, read-only, after every writable bind; its folder never bound
  const argv = new BubblewrapRuntime({ extra_read_deny: [w.data] }).command(['x'], box, '/p')
  const at = argv.lastIndexOf(w.a)
  expect(argv.slice(at - 2, at + 1)).toEqual(['--ro-bind', w.a, w.a])
  expect(at).toBeGreaterThan(argv.lastIndexOf('--bind'))
  expect(argv).not.toContain(w.folder)
})

test.skipIf(!mac)('a grant is made only of the harness\'s sealed records of this session: every other record is refused, with its reason', () => {
  const w = world()
  writeFileSync(join(w.folder, '.hidden'), 'x')
  // a file of the store with the right size and a recorded identity, never sealed
  const loose = join(w.folder, 'cccccccccccccccc.mp4')
  writeFileSync(loose, 'NOT-SEALED-FILE')
  const looseId = identityOf(statSync(loose, { bigint: true }))
  const cases: [string, StoredInputRecord, string][] = [
    ['another session', w.rec({ session_id: 's_b' }), 'not an attachment of this session'],
    ['another project', w.rec({ project_id: 'p2', storage_path: 'p2/data/aaaaaaaaaaaaaaaa.mp4' }), 'not an attachment of this session'],
    ['not an attachment', w.rec({ role: 'site_icon' }), 'not an attachment'],
    ['a local file', w.rec({ origin: 'local' }), 'only uploaded files are granted; a local file is read where it stands'],
    ['a parent step', w.rec({ storage_path: 'p1/data/../data/aaaaaaaaaaaaaaaa.mp4' }), 'not a storage path the store writes'],
    ['an absolute path', w.rec({ storage_path: w.a }), 'not a storage path the store writes'],
    ['a backslash', w.rec({ storage_path: 'p1\\data\\aaaaaaaaaaaaaaaa.mp4' }), 'not a storage path the store writes'],
    ['a hidden component', w.rec({ storage_path: 'p1/data/.hidden' }), 'not a storage path the store writes'],
    ['another project folder', w.rec({ storage_path: 'p2/data/aaaaaaaaaaaaaaaa.mp4' }), 'not a storage path the store writes'],
    ['the folder itself', w.rec({ storage_path: 'p1/data' }), 'not a regular file'],
    ['a size that is not the file', w.rec({ bytes: 16 }), 'its size is not the recorded size'],
    ['a missing file', w.rec({ storage_path: 'p1/data/dddddddddddddddd.mp4' }), 'missing'],
    ['no identity recorded', w.rec({ identity: null }), 'no identity was recorded when it was sealed'],
    ['another file\'s identity', w.rec({ identity: w.idb }), 'not the file that was stored (changed or replaced)'],
    ['a size as a number', w.rec({ identity: { ...w.ida, size: 15 as unknown as string } }), 'not the file that was stored (changed or replaced)'],
    ['not sealed', w.rec({ storage_path: 'p1/data/cccccccccccccccc.mp4', identity: looseId }), 'not sealed: a hard link to it could be made and written'],
  ]
  const g = grant(w, cases.map(([, r], i) => ({ ...r, asset_id: `case_${i}` })))
  expect(g.paths).toEqual([])
  expect(g.refused).toEqual(cases.map(([, , reason], i) => ({ asset_id: `case_${i}`, reason })))
  // a store outside the data directory is no protected store: nothing of it is granted
  const outsideStore = root()
  mkdirSync(join(outsideStore, 'p1', 'data'), { recursive: true })
  writeFileSync(join(outsideStore, 'p1', 'data', 'aaaaaaaaaaaaaaaa.mp4'), 'SESSION-A-VIDEO')
  const outside = authorizeInputFiles({ data_dir: w.data, store_root: outsideStore, session: { id: 's_a', project_id: 'p1' }, records: [w.rec()] })
  expect(outside.paths).toEqual([])
  expect(outside.refused[0]!.reason).toContain('not inside the data directory')
})

test.skipIf(!mac)('a link anywhere on the way, a second name, a replaced file or a FIFO: refused, never followed; a file with an alias is never sealed', () => {
  const w = world()
  symlinkSync(w.folder, join(w.store, 'p1', 'linked'))
  symlinkSync(w.a, join(w.folder, 'eeeeeeeeeeeeeeee.mp4'))
  const twin = join(w.folder, 'ffffffffffffffff.mp4')
  writeFileSync(twin, 'TWIN-CONTENT-15')
  linkSync(twin, join(w.base, 'alias.mp4'))
  expect(() => sealStoredFile(twin, w.scope)).toThrow(/second name/)
  expect(isSealed(twin)).toBe(false)
  const fifo = join(w.folder, '0000000000000000.mp4')
  expect(spawnSync('mkfifo', [fifo]).status).toBe(0)
  const g = grant(w, [
    w.rec({ asset_id: 'folder_link', storage_path: 'p1/linked/aaaaaaaaaaaaaaaa.mp4' }),
    w.rec({ asset_id: 'file_link', storage_path: 'p1/data/eeeeeeeeeeeeeeee.mp4' }),
    w.rec({ asset_id: 'twin', storage_path: 'p1/data/ffffffffffffffff.mp4', identity: identityOf(statSync(twin, { bigint: true })) }),
    w.rec({ asset_id: 'fifo', storage_path: 'p1/data/0000000000000000.mp4', bytes: 0 }),
  ])
  expect(g.paths).toEqual([])
  expect(Object.fromEntries(g.refused.map((r) => [r.asset_id, r.reason]))).toEqual({
    folder_link: 'a link in its path', file_link: 'a link in its path', twin: 'has 2 names (a hard-link alias)', fifo: 'not a regular file',
  })
  // the same sealed file passes; unsealed, it does not; a file put in its place under the same name and size does not
  expect(grant(w, [w.rec()]).paths).toEqual([w.a])
  unsealStoredFile(w.a, w.scope)
  const unsealed = grant(w, [w.rec()])
  expect(unsealed.paths).toEqual([])
  expect(unsealed.refused[0]!.reason).toMatch(/changed or replaced|not sealed/)
  const fresh = join(w.folder, 'fresh')
  writeFileSync(fresh, 'SESSION-A-VIDEO')
  renameSync(fresh, w.a)
  const id = w.seal(w.a)
  expect(sameIdentity(id, w.ida)).toBe(false)
  expect(grant(w, [w.rec()]).refused[0]!.reason).toBe('not the file that was stored (changed or replaced)')
  expect(grant(w, [w.rec({ identity: id })]).paths).toEqual([w.a])
})

test('the seal touches the asset store only: never a file outside it, never through a link, never on a platform without the flag', () => {
  const w = world()
  const l = local()
  // a person's local file, the database, a link into the store, the store folder itself: never sealed or unsealed
  for (const p of [l.movie, join(w.data, 'index.db'), w.store, w.folder]) {
    expect(() => sealStoredFile(p, w.scope)).toThrow(AttachmentAccessRefused)
    expect(() => unsealStoredFile(p, w.scope)).toThrow(AttachmentAccessRefused)
  }
  symlinkSync(w.b, join(w.folder, '1111111111111111.mp4'))
  expect(() => sealStoredFile(join(w.folder, '1111111111111111.mp4'), w.scope)).toThrow(/link/)
  // a store named outside its data directory is no store
  expect(() => sealStoredFile(w.a, { data_dir: w.data, store_root: l.docs })).toThrow(/not inside the data directory/)
  if (mac) expect(isSealed(l.movie)).toBe(false)
  else {
    const fresh = join(w.folder, '2222222222222222.mp4')
    writeFileSync(fresh, 'x')
    expect(() => sealStoredFile(fresh, w.scope)).toThrow(/no user-immutable flag/)
  }
})

test.skipIf(mac)('without a seal (any platform but macOS) no upload is granted, and none is claimed protected', () => {
  const w = world()
  const g = grant(w, [w.rec()])
  expect(g.paths).toEqual([])
  expect(g.refused[0]!.reason).toContain('no seal against a writable hard-link alias on this platform')
})

test.skipIf(!mac)('a grant is a brand of this data directory: a plain object or a client\'s list is refused, and a session\'s files reach no other session\'s workspace', () => {
  const w = world()
  const forged = { session_id: 's_a', project_id: 'p1', paths: [w.a], refused: [] } as unknown as AuthorizedInputFiles
  expect(() => authorizedPaths(forged)).toThrow(AttachmentAccessRefused)
  expect(() => sandboxForWorkspace(w.data, w.project, { path: w.wsA, session_id: 's_a', project_id: 'p1' }, { network: false, input_files: forged })).toThrow(AttachmentAccessRefused)
  const g = grant(w, [w.rec()])
  expect(() => sandboxForWorkspace(w.data, w.project, { path: w.wsB, session_id: 's_b', project_id: 'p1' }, { network: false, input_files: g })).toThrow(SandboxInputRefused)
  expect(() => sandboxForWorkspace(w.data, w.project, { path: w.wsB }, { network: false, input_files: g })).toThrow(SandboxInputRefused)
  expect(() => sandboxForWorkspace(w.data, w.project, { path: w.wsB, session_id: null, project_id: 'p1' }, { network: false, input_files: g })).toThrow(SandboxInputRefused)
  expect(() => sandboxForWorkspace(w.data, w.project, { path: w.wsA, session_id: 's_a', project_id: 'p2' }, { network: false, input_files: g })).toThrow(SandboxInputRefused)
  const gb = grant(w, [w.rec({ asset_id: 'b', session_id: 's_b', storage_path: 'p1/data/bbbbbbbbbbbbbbbb.mp4', identity: w.idb })], { id: 's_b', project_id: 'p1' })
  expect(gb.paths).toEqual([w.b])
  const boxB = sandboxForWorkspace(w.data, w.project, { path: w.wsB, session_id: 's_b', project_id: 'p1' }, { network: false, input_files: gb })
  expect(runtime(w).profile(boxB)).not.toContain(w.a)
  // a grant made against another data directory's store is not granted under this one
  const other = world()
  const elsewhere = authorizeInputFiles({ data_dir: other.data, store_root: other.store, session: { id: 's_a', project_id: 'p1' }, records: [other.rec()] })
  expect(elsewhere.paths).toEqual([other.a])
  expect(() => sandboxForWorkspace(w.data, w.project, { path: w.wsA, session_id: 's_a', project_id: 'p1' }, { network: false, input_files: elsewhere })).toThrow(SandboxInputRefused)
})

test('the renderer checks the exact reads again: only the harness\'s own data root, harness folders inside it, real single-name files — else the box is refused', () => {
  const w = world()
  const sb = runtime(w)
  const base: Sandbox = { writable: [w.wsA], write_deny: [], read_deny: [w.data], read_allow: [w.wsA], network: false }
  const ok = { files: [w.a], within: [w.store], data_root: w.data }
  expect(() => sb.profile({ ...base, exact_reads: ok })).not.toThrow()
  // a runtime configured with no data root of its own grants nothing; another denied root of the box is no data root
  expect(() => new SeatbeltRuntime().profile({ ...base, exact_reads: ok })).toThrow(SandboxInputRefused)
  const source = join(w.base, 'source')
  mkdirSync(join(source, 'sub'), { recursive: true })
  writeFileSync(join(source, 'sub', 'secret.txt'), 'S')
  expect(() => sb.profile({ ...base, read_deny: [w.data, source], exact_reads: { files: [join(source, 'sub', 'secret.txt')], within: [join(source, 'sub')], data_root: source } })).toThrow(/not the harness's own data directory/)
  // the data directory itself is no `within`: its database is never an exact read
  expect(() => sb.profile({ ...base, exact_reads: { files: [join(w.data, 'index.db')], within: [w.data], data_root: w.data } })).toThrow(SandboxInputRefused)
  // a file outside the named folders; a folder in the trees commands write; a linked folder; a relative or `..` path
  expect(() => sb.profile({ ...base, exact_reads: { files: [join(w.data, 'index.db')], within: [w.store], data_root: w.data } })).toThrow(/harness-owned folder/)
  const inWorktree = join(w.wsA, 'in-worktree.mp4')
  writeFileSync(inWorktree, 'x')
  expect(() => sb.profile({ ...base, exact_reads: { files: [inWorktree], within: [join(w.data, 'workspaces')], data_root: w.data } })).toThrow(SandboxInputRefused)
  const otherTemp = join(w.data, 'sandboxes', 'ws_b', 'tmp')
  mkdirSync(otherTemp, { recursive: true })
  writeFileSync(join(otherTemp, 'f'), 'x')
  expect(() => sb.profile({ ...base, exact_reads: { files: [join(otherTemp, 'f')], within: [otherTemp], data_root: w.data } })).toThrow(/tree commands write/)
  symlinkSync(w.store, join(w.data, 'store-link'))
  expect(() => sb.profile({ ...base, exact_reads: { files: [join(w.data, 'store-link', 'p1', 'data', 'aaaaaaaaaaaaaaaa.mp4')], within: [join(w.data, 'store-link')], data_root: w.data } })).toThrow(SandboxInputRefused)
  expect(() => sb.profile({ ...base, exact_reads: { files: ['relative/file'], within: [w.store], data_root: w.data } })).toThrow(SandboxInputRefused)
  expect(() => sb.profile({ ...base, exact_reads: { files: [`${w.folder}/../data/aaaaaaaaaaaaaaaa.mp4`], within: [w.store], data_root: w.data } })).toThrow(SandboxInputRefused)
  expect(() => new BubblewrapRuntime({ extra_read_deny: [w.data] }).command(['x'], { ...base, exact_reads: { files: [join(w.data, 'index.db')], within: [w.store], data_root: w.data } }, '/p')).toThrow(SandboxInputRefused)
  // checked, then the file's name turned into a link before the command starts: refused at render
  const plain = join(w.folder, '3333333333333333.mp4')
  writeFileSync(plain, 'P')
  const box = { ...base, exact_reads: { files: [plain], within: [w.store], data_root: w.data } }
  expect(() => sb.profile(box)).not.toThrow()
  renameSync(plain, join(w.folder, 'moved'))
  symlinkSync(join(w.data, 'index.db'), plain)
  expect(() => sb.profile(box)).toThrow(/reached through a link|not a regular file/)
  unlinkSync(plain)
  renameSync(join(w.folder, 'moved'), plain)
  // a second name made after the check: refused at render
  linkSync(plain, join(w.wsA, 'alias.mp4'))
  expect(() => sb.profile(box)).toThrow(/2 names/)
  unlinkSync(join(w.wsA, 'alias.mp4'))
  expect(() => sb.profile(box)).not.toThrow()
})

test('a credential store is opened by the exception only where it holds the harness\'s data directory itself — a credential store inside it, or beside it, never', () => {
  const base = root()
  const home = join(base, 'home')
  const data = join(home, '.oasis-code')
  const store = join(data, 'assets', 'p1', 'data')
  const auth = join(data, 'auth-store')
  const ssh = join(home, '.ssh')
  for (const d of [store, auth, ssh]) mkdirSync(d, { recursive: true })
  for (const f of [join(store, 'u.mp4'), join(auth, 'token'), join(ssh, 'id_key')]) writeFileSync(f, 'x')
  const ctx = (credential_roots: string[]) => ({ writable: [], data_roots: [data], credential_roots })
  // the data directory is itself on the credential list (the default ~/.oasis-code): its store's file may be read
  expect(exactReadProblems({ files: [join(store, 'u.mp4')], within: [join(data, 'assets')], data_root: data }, ctx([data, ssh]))).toEqual([])
  // a credential store inside the data directory stays closed, whatever folder is named
  expect(exactReadProblems({ files: [join(auth, 'token')], within: [auth], data_root: data }, ctx([data, auth]))[0]).toContain('credential store')
  // a credential store beside it: its files are never inside the data root, never granted
  expect(exactReadProblems({ files: [join(ssh, 'id_key')], within: [ssh], data_root: data }, ctx([data, ssh])).length).toBeGreaterThan(0)
  expect(exactReadProblems({ files: [join(ssh, 'id_key')], within: [ssh], data_root: ssh }, { writable: [], data_roots: [data], credential_roots: [ssh] })[0]).toContain('not the harness\'s own data directory')
})

// ---- local files ------------------------------------------------------------------------------------------------

function local() {
  const base = root()
  const home = join(base, 'home')
  const cred = join(home, '.secretstore')
  const data = join(home, '.harness-data')
  const docs = join(home, 'Movies')
  for (const d of [cred, data, docs]) mkdirSync(d, { recursive: true })
  writeFileSync(join(cred, 'id_key'), 'PRIVATE-KEY')
  writeFileSync(join(data, 'index.db'), 'DATABASE')
  const movie = join(docs, 'talk.mov')
  writeFileSync(movie, 'MOVIE-BYTES-0123456789')
  const opts = { data_dir: data, credential_roots: [cred] }
  return { base, home, cred, data, docs, movie, opts }
}

test('a local file is inspected at its real path, by identity, without reading it; denied roots are refused however they are spelled', () => {
  const l = local()
  const src = inspectLocalSource(l.movie, l.opts)
  expect(src.real_path).toBe(l.movie)
  expect(src.identity.size).toBe('22')
  symlinkSync(l.movie, join(l.base, 'link.mov'))
  expect(inspectLocalSource(join(l.base, 'link.mov'), l.opts).real_path).toBe(l.movie)
  symlinkSync(join(l.cred, 'id_key'), join(l.docs, 'key.mov'))
  symlinkSync(l.cred, join(l.docs, 'store'))
  for (const p of [join(l.cred, 'id_key'), join(l.docs, 'key.mov'), join(l.docs, 'store', 'id_key'), join(l.data, 'index.db')]) {
    expect(() => inspectLocalSource(p, l.opts)).toThrow(AttachmentAccessRefused)
  }
  expect(() => inspectLocalSource(l.movie, { ...l.opts, deny_roots: [l.docs] })).toThrow(/under/)
  expect(() => inspectLocalSource(join(l.home, '.SecretStore', 'id_key'), l.opts)).toThrow(AttachmentAccessRefused)
  const fifo = join(l.docs, 'pipe.mov')
  expect(spawnSync('mkfifo', [fifo]).status).toBe(0)
  const started = Date.now()
  expect(() => inspectLocalSource(fifo, l.opts)).toThrow(/not a regular file/)
  expect(Date.now() - started).toBeLessThan(2_000)
  expect(() => inspectLocalSource(l.docs, l.opts)).toThrow(/not a regular file/)
  expect(() => inspectLocalSource('Movies/talk.mov', l.opts)).toThrow(/absolute/)
  expect(() => inspectLocalSource(`${l.docs}/a\nb.mov`, l.opts)).toThrow(/control/)
  // inspecting changes nothing of the file: no flag, no second name, the same identity
  expect(sameIdentity(identityOf(statSync(l.movie, { bigint: true })), src.identity)).toBe(true)
  if (mac) expect(isSealed(l.movie)).toBe(false)
})

test('a local file is read by the harness only as the inode it was, before and after the read, of one name, never past the bound', () => {
  const l = local()
  const src = inspectLocalSource(l.movie, l.opts)
  expect(Buffer.from(readLocalBounded(src, 5, l.opts)).toString()).toBe('MOVIE')
  expect(Buffer.from(readLocalBounded(src, 1_000, { ...l.opts, whole: true })).toString()).toBe('MOVIE-BYTES-0123456789')
  expect(() => readLocalBounded(src, 10, { ...l.opts, whole: true })).toThrow(/the bound is 10/)
  linkSync(l.movie, join(l.base, 'alias.mov'))
  expect(() => readLocalBounded(src, 5, l.opts)).toThrow(/changed since|names/)
  unlinkSync(join(l.base, 'alias.mov'))
  expect(() => readLocalBounded(src, 5, l.opts)).toThrow(/changed since/)
  const again = inspectLocalSource(l.movie, l.opts)
  expect(readLocalBounded(again, 5, l.opts).length).toBe(5)
  appendFileSync(l.movie, '!')
  expect(() => readLocalBounded(again, 5, l.opts)).toThrow(/changed since/)
  const third = inspectLocalSource(l.movie, l.opts)
  writeFileSync(join(l.docs, 'other.mov'), 'MOVIE-BYTES-0123456789!')
  renameSync(join(l.docs, 'other.mov'), l.movie)
  expect(() => readLocalBounded(third, 5, l.opts)).toThrow(/changed since/)
  const fourth = inspectLocalSource(l.movie, l.opts)
  unlinkSync(l.movie)
  symlinkSync(join(l.cred, 'id_key'), l.movie)
  expect(() => readLocalBounded(fourth, 50, l.opts)).toThrow(/link now|cannot be opened/)
  unlinkSync(l.movie)
  expect(() => readLocalBounded(fourth, 50, l.opts)).toThrow(/cannot be opened/)
})

test('a write while the harness reads a local file: what was read is thrown away, never returned as the file', () => {
  // a large file read in one bounded call while another process appends to it: either the read finished before the
  // write (the bytes are the file as inspected) or the identity after the read differs and the read is refused
  const l = local()
  const big = join(l.docs, 'big.mov')
  writeFileSync(big, Buffer.alloc(64 * 1024 * 1024, 7))
  const src = inspectLocalSource(big, l.opts)
  const writer = Bun.spawn(['/bin/sh', '-c', `sleep 0.005; printf X >> '${big}'`])
  let outcome: 'refused' | 'whole' = 'whole'
  try {
    const bytes = readLocalBounded(src, 64 * 1024 * 1024, { ...l.opts, whole: true })
    expect(bytes.length).toBe(64 * 1024 * 1024)
    expect(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).equals(Buffer.alloc(64 * 1024 * 1024, 7))).toBe(true)
  } catch (error) {
    outcome = 'refused'
    expect(String((error as Error).message)).toMatch(/changed (while it was read|since it was attached)/)
  }
  return writer.exited.then(() => {
    // once the write landed, the next read is refused whatever the timing was
    expect(() => readLocalBounded(src, 10, l.opts)).toThrow(/changed since/)
    expect(['refused', 'whole']).toContain(outcome)
  })
})

// ---- the real kernel ------------------------------------------------------------------------------------------

const ATTEMPT = `const fs = require('node:fs'); const [granted, sibling, folder, db, worktree] = process.argv.slice(2); const out = {}
const tries = {
  read: () => fs.readFileSync(granted, 'utf8'), sibling: () => fs.readFileSync(sibling, 'utf8'), list: () => fs.readdirSync(folder).join(','),
  db: () => fs.readFileSync(db, 'utf8'),
  write: () => { fs.appendFileSync(granted, 'X'); return 'W' }, rename: () => { fs.renameSync(granted, granted + '.moved'); return 'R' },
  link: () => { fs.linkSync(granted, worktree + '/alias.mp4'); return 'L' },
}
for (const [k, f] of Object.entries(tries)) { try { out[k] = { ok: f() } } catch (e) { out[k] = { code: e.code } } }
console.log(JSON.stringify(out))`

test.skipIf(!mac)('macOS, the real Seatbelt: the granted file is read; its sibling (another session\'s), its folder and the database are not; nothing writes, renames or links it', () => {
  const w = world()
  const g = grant(w, [w.rec()])
  expect(g.paths).toEqual([w.a])
  const box = sandboxForWorkspace(w.data, w.project, { path: w.wsA, session_id: 's_a', project_id: 'p1' }, { network: false, input_files: g })
  const script = join(w.wsA, 'attempt.cjs')
  writeFileSync(script, ATTEMPT)
  const argv = runtime(w).command([process.execPath, script, w.a, w.b, w.folder, join(w.data, 'index.db'), w.wsA], box, join(w.base, 'profile.sb'))
  const result = spawnSync(argv[0]!, argv.slice(1), { cwd: w.wsA, encoding: 'utf8', timeout: 20_000, env: { PATH: '/usr/bin:/bin', HOME: w.wsA, BUN_BE_BUN: '1' } })
  let seen: Record<string, { ok?: string; code?: string }> = {}
  try { seen = JSON.parse(result.stdout.trim()) } catch { seen = {} }
  const got = Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, v.ok ?? v.code]))
  expect({ exit: result.status, stderr: result.stderr.trim().slice(0, 200), got }).toEqual({
    exit: 0, stderr: '', got: { read: 'SESSION-A-VIDEO', sibling: 'EPERM', list: 'EPERM', db: 'EPERM', write: 'EPERM', rename: 'EPERM', link: 'EPERM' },
  })
  expect(readFileSync(w.a, 'utf8')).toBe('SESSION-A-VIDEO')
  expect(existsSync(join(w.wsA, 'alias.mp4'))).toBe(false)
}, 60_000)
