/** Exact, read-only access to a session's attached files — what a command may read of them, and what the harness itself
 *  may read — and nothing more.
 *
 *  Two origins, two rules:
 *  - `upload`: bytes the person sent from a browser, kept by the harness under its data directory (its asset store),
 *    which every command's profile denies as a whole. A command of the session reads such a file through one exact
 *    literal grant (Sandbox.read_files) — never its folder, never another session's, never the database or a
 *    credential beside it. The grant is made here, from the harness's own records (authorizeInputFiles), never from a
 *    path a client sent; the result is branded, and sandboxForWorkspace takes nothing else. A stored upload is granted
 *    only once it is sealed (sealStoredFile: the macOS user-immutable flag, read back from the file itself at every
 *    grant): no write and no new hard link reach its inode by any name, and a file with a second name (an alias made
 *    before the seal) is never granted. Where no seal can be set (any platform but macOS) nothing is granted: there is
 *    no verified protection against a writable alias there, and none is claimed.
 *  - `local`: a file the person chose in the desktop app, used where it stands — nothing copied, nothing linked, no
 *    grant: a command reads it exactly as it could before (the profile's credential and data-directory denies hold),
 *    no more. The harness reads such a file itself only through inspectLocalSource / readLocalBounded: the real path,
 *    the credential stores, the data directory and the caller's own denied roots refused by the identity of every
 *    ancestor (a case-folding volume or a link cannot slip past), a regular file opened without following a link and
 *    without blocking (a FIFO or a device is refused, never waited on), its identity — device, inode, size, change
 *    and modification times — compared on the open descriptor before a byte is read, and never more than the bound.
 *
 *  Nothing here copies a file, creates a hard link, follows a link out of a folder an agent can write, or reads a
 *  file whole to measure it. */

import { spawnSync } from 'node:child_process'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync, type BigIntStats } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { CREDENTIAL_READ_DENY } from '../execution/isolation.ts'

/** A file's identity: the same inode, untouched since — any write, rename, link or attribute change moves ctime.
 *  Every field a decimal string (64-bit values do not fit a JSON number): the contract's file fingerprint carries
 *  them the same way; compare with sameIdentity, never a number against a string. */
export interface FileIdentity {
  dev: string
  ino: string
  size: string
  mtime_ns: string
  ctime_ns: string
}

export class AttachmentAccessRefused extends Error {
  constructor(message: string) { super(message); this.name = 'AttachmentAccessRefused' }
}

export function identityOf(st: BigIntStats): FileIdentity {
  return { dev: st.dev.toString(), ino: st.ino.toString(), size: st.size.toString(), mtime_ns: st.mtimeNs.toString(), ctime_ns: st.ctimeNs.toString() }
}

export function sameIdentity(a: FileIdentity, b: FileIdentity): boolean {
  const keys = ['dev', 'ino', 'size', 'mtime_ns', 'ctime_ns'] as const
  return keys.every((k) => typeof a?.[k] === 'string' && /^\d+$/.test(a[k]) && a[k] === b?.[k])
}

function inside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
}

// ---- uploads: exact grants from the harness's own records --------------------------------------------------------

/** What the harness recorded of one stored upload (its asset row), as the caller read it from its database. */
export interface StoredInputRecord {
  asset_id: string
  project_id: string
  session_id: string
  /** the asset's role: only `attachment` is ever granted */
  role: string
  /** only `upload` is granted; a local file keeps the command's own read rights and is never put in a profile */
  origin: string
  /** relative to the asset store's root, as the store wrote it: `<project_id>/<kind>/<name>` */
  storage_path: string
  bytes: number
  /** recorded once the file was sealed; when given, the file must still be that inode, untouched */
  identity?: FileIdentity | null
}

const GRANT = Symbol('oasis-code.authorized-input-files')
/** each grant made here, with the data directory and the store it was made against (never readable from the object) */
const granted = new WeakMap<object, { data_dir: string; store_root: string }>()

/** A session's uploads its commands may read, made only by authorizeInputFiles (a brand a literal cannot carry). */
export interface AuthorizedInputFiles {
  readonly [GRANT]: true
  readonly session_id: string
  readonly project_id: string
  /** real absolute paths, each a sealed regular file of one name under the asset store */
  readonly paths: readonly string[]
  /** the records refused, and why (the caller says so; the file stays out of every profile) */
  readonly refused: readonly { asset_id: string; reason: string }[]
}

/** The paths of a grant made by authorizeInputFiles; anything else (a plain object, a client's list) throws. */
export function authorizedPaths(value: AuthorizedInputFiles): readonly string[] {
  if (!value || typeof value !== 'object' || !granted.has(value)) throw new AttachmentAccessRefused('input files must come from authorizeInputFiles')
  return value.paths
}

/** The real data directory and asset store a grant was made against (empty strings when no store qualified). */
export function grantScope(value: AuthorizedInputFiles): { data_dir: string; store_root: string } {
  const scope = value && typeof value === 'object' ? granted.get(value) : undefined
  if (!scope) throw new AttachmentAccessRefused('input files must come from authorizeInputFiles')
  return scope
}

/** The macOS user-immutable flag (UF_IMMUTABLE), as stat(1) reads it from the file itself (not followed). */
const UF_IMMUTABLE = 0x2

/** Whether a file carries the user-immutable flag, read from the file now. Only macOS sets it; elsewhere false. */
export function isSealed(path: string): boolean {
  if (process.platform !== 'darwin') return false
  const out = spawnSync('/usr/bin/stat', ['-f', '%f', path], { encoding: 'utf8', timeout: 10_000 })
  const flags = out.status === 0 ? Number(out.stdout.trim()) : NaN
  return Number.isInteger(flags) && (flags & UF_IMMUTABLE) !== 0
}

/** The real asset store, when it lies strictly inside the real data directory; else null. */
function protectedStore(dataDir: string, storeRoot: string): { data: string; store: string } | null {
  try {
    const data = realpathSync.native(dataDir)
    const store = realpathSync.native(storeRoot)
    return store !== data && inside(store, data) ? { data, store } : null
  } catch { return null }
}

const COMPONENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/

/** The session's stored uploads its commands may read: each record checked against the session (project, session,
 *  role, origin), its storage path a plain relative path under the store's project folder (no `..`, no hidden
 *  component, no separator but `/`), every component on disk a real folder — no link, followed or not — down to a
 *  regular file of one name, of the recorded size and, when recorded, identity. The store must lie inside the data
 *  directory (the profile's data-root deny is what keeps the rest of it closed). A record that fails is refused, not
 *  thrown: the run goes on without that file. */
export function authorizeInputFiles(o: { data_dir: string; store_root: string; session: { id: string; project_id: string }; records: readonly StoredInputRecord[]; refused?: readonly { asset_id: string; reason: string }[] }): AuthorizedInputFiles {
  // refusals the caller made before (a reference as sent that no longer agrees with its record) are kept and said
  const refused: { asset_id: string; reason: string }[] = (o.refused ?? []).map((r) => ({ asset_id: String(r.asset_id), reason: String(r.reason) }))
  const paths: string[] = []
  const scope = protectedStore(o.data_dir, o.store_root)
  const store = scope?.store ?? null
  for (const r of o.records) {
    const refuse = (reason: string) => refused.push({ asset_id: String(r?.asset_id ?? '?'), reason })
    if (store === null) { refuse('the asset store is not inside the data directory'); continue }
    if (process.platform !== 'darwin') { refuse('no seal against a writable hard-link alias on this platform: an upload is not granted to commands here'); continue }
    if (!r || r.session_id !== o.session.id || r.project_id !== o.session.project_id) { refuse('not an attachment of this session'); continue }
    if (r.role !== 'attachment') { refuse('not an attachment'); continue }
    if (r.origin !== 'upload') { refuse('only uploaded files are granted; a local file is read where it stands'); continue }
    const rel = typeof r.storage_path === 'string' ? r.storage_path : ''
    const parts = rel.split('/')
    if (rel.includes('\\') || parts.length < 2 || parts.length > 6 || !parts.every((p) => COMPONENT.test(p)) || parts[0] !== r.project_id) { refuse('not a storage path the store writes'); continue }
    let cur = store
    let bad: string | null = null
    for (let i = 0; i < parts.length && bad === null; i += 1) {
      cur = join(cur, parts[i]!)
      let st: ReturnType<typeof lstatSync>
      try { st = lstatSync(cur) } catch { bad = 'missing'; break }
      if (st.isSymbolicLink()) bad = 'a link in its path'
      else if (i < parts.length - 1 && !st.isDirectory()) bad = 'not under folders'
      else if (i === parts.length - 1 && !st.isFile()) bad = 'not a regular file'
    }
    if (bad !== null) { refuse(bad); continue }
    let real: string
    try { real = realpathSync.native(cur) } catch { refuse('missing'); continue }
    if (real !== cur) { refuse(`reached through a link (${real})`); continue }
    let st: BigIntStats
    try { st = statSync(cur, { bigint: true }) } catch { refuse('missing'); continue }
    if (!st.isFile()) { refuse('not a regular file'); continue }
    if (st.nlink !== 1n) { refuse(`has ${st.nlink} names (a hard-link alias)`); continue }
    if (st.size !== BigInt(r.bytes)) { refuse('its size is not the recorded size'); continue }
    if (!r.identity) { refuse('no identity was recorded when it was sealed'); continue }
    if (!sameIdentity(identityOf(st), r.identity)) { refuse('not the file that was stored (changed or replaced)'); continue }
    // the seal itself, read from the file now (not the record's word for it); then the identity again, so a seal
    // lifted and set back meanwhile (which moves ctime) is caught
    if (!isSealed(cur)) { refuse('not sealed: a hard link to it could be made and written'); continue }
    let after: BigIntStats
    try { after = statSync(cur, { bigint: true }) } catch { refuse('missing'); continue }
    if (!sameIdentity(identityOf(after), r.identity) || after.nlink !== 1n) { refuse('changed while it was checked'); continue }
    if (!paths.includes(cur)) paths.push(cur)
  }
  const grant = { [GRANT]: true as const, session_id: o.session.id, project_id: o.session.project_id, paths: Object.freeze([...paths]), refused: Object.freeze(refused) }
  Object.freeze(grant)
  granted.set(grant, { data_dir: scope?.data ?? '', store_root: store ?? '' })
  return grant
}

/** A stored upload of the asset store: a regular file of one name strictly inside the real store, itself strictly
 *  inside the real data directory, reached through no link. Anything else — a person's own local file above all — is
 *  never sealed or unsealed. */
export function storedUpload(path: string, o: { data_dir: string; store_root: string }): string {
  const scope = protectedStore(o.data_dir, o.store_root)
  if (scope === null) throw new AttachmentAccessRefused('the asset store is not inside the data directory')
  if (typeof path !== 'string' || !path.startsWith('/') || resolve(path) !== path || !inside(path, scope.store) || path === scope.store) {
    throw new AttachmentAccessRefused(`${path} is not a file of the asset store; only stored uploads are sealed`)
  }
  let real: string
  try { real = realpathSync.native(path) } catch { throw new AttachmentAccessRefused(`${path} is missing`) }
  if (real !== path) throw new AttachmentAccessRefused(`${path} is reached through a link`)
  const st = lstatSync(path)
  if (!st.isFile()) throw new AttachmentAccessRefused(`${path} is not a regular file`)
  return path
}

/** Seal a stored upload once it has its final name (rename first: an immutable file cannot be renamed): on macOS the
 *  user-immutable flag (chflags uchg, not following a link) — no write by any name, no rename, no removal, and no new
 *  hard link (link(2) is refused on an immutable file) — read back from the file, then its identity, which the caller
 *  records with the asset (authorizeInputFiles requires it). Throws, and seals nothing, when the file already has a
 *  second name (an alias made before the seal could still write it), when the flag cannot be set or is not there
 *  after, or on any platform but macOS (no user-immutable flag without privileges; nothing is claimed there). */
export function sealStoredFile(path: string, o: { data_dir: string; store_root: string }): { identity: FileIdentity } {
  const file = storedUpload(path, o)
  if (lstatSync(file).nlink !== 1) throw new AttachmentAccessRefused(`${file} has a second name; a file with an alias is never sealed or granted`)
  if (process.platform !== 'darwin') throw new AttachmentAccessRefused('no user-immutable flag on this platform: the upload cannot be sealed, and is not granted to commands')
  const out = spawnSync('/usr/bin/chflags', ['-h', 'uchg', file], { encoding: 'utf8', timeout: 10_000 })
  if (out.status !== 0) throw new AttachmentAccessRefused(`chflags uchg failed (${out.status ?? out.signal}): ${(out.stderr || '').trim().slice(0, 200)}`)
  if (!isSealed(file)) throw new AttachmentAccessRefused(`${file} does not carry the immutable flag after it was set`)
  const st = statSync(file, { bigint: true })
  if (st.nlink !== 1n) throw new AttachmentAccessRefused(`${file} gained a second name while it was sealed`)
  return { identity: identityOf(st) }
}

/** Lift the seal before the harness itself removes a stored upload (a removed session, a collected orphan, a test's
 *  cleanup): the same store-only rule as the seal; a person's local file is never touched. */
export function unsealStoredFile(path: string, o: { data_dir: string; store_root: string }): void {
  const file = storedUpload(path, o)
  if (process.platform !== 'darwin') return
  const out = spawnSync('/usr/bin/chflags', ['-h', 'nouchg', file], { encoding: 'utf8', timeout: 10_000 })
  if (out.status !== 0) throw new AttachmentAccessRefused(`chflags nouchg failed (${out.status ?? out.signal}): ${(out.stderr || '').trim().slice(0, 200)}`)
}

// ---- local files: read where they stand, by the harness only within these bounds ---------------------------------

/** A local file the person chose, as inspected: its real path and identity then. */
export interface LocalSource {
  real_path: string
  identity: FileIdentity
  nlink: number
}

export interface LocalAccessOptions {
  /** the harness's data directory: never read through a local reference */
  data_dir: string
  /** further denied roots: the configured extra denies, the other projects' and the snapshot projects' own folders */
  deny_roots?: readonly string[]
  /** the credential stores (default: the fixed list a command never reads, under this user's home) */
  credential_roots?: readonly string[]
}

function deniedIdentities(o: LocalAccessOptions): { keys: Set<string>; roots: string[] } {
  const roots = [...(o.credential_roots ?? CREDENTIAL_READ_DENY.map((p) => (p.startsWith('~') ? join(homedir(), p.slice(1)) : p))), o.data_dir, ...(o.deny_roots ?? [])]
  const keys = new Set<string>()
  const real: string[] = []
  for (const root of roots) {
    try {
      const st = statSync(root, { bigint: true })
      keys.add(`${st.dev}:${st.ino}`)
      real.push(realpathSync.native(root))
    } catch { real.push(resolve(root)) }
  }
  return { keys, roots: real }
}

const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)

/** Open a path for reading without following a final link and without blocking; a regular file only. */
function openRegular(path: string): { fd: number; st: BigIntStats } {
  let fd: number
  try { fd = openSync(path, OPEN_FLAGS) } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    throw new AttachmentAccessRefused(code === 'ELOOP' ? `${path} is a link now` : `${path} cannot be opened (${code ?? (error as Error).message})`)
  }
  const st = fstatSync(fd, { bigint: true })
  if (!st.isFile()) { closeSync(fd); throw new AttachmentAccessRefused(`${path} is not a regular file`) }
  return { fd, st }
}

/** Whether a real path, or any folder above it, is a denied root — by identity (device and inode), so a case variant
 *  or another spelling of the same folder is caught — and by its real spelling. */
function deniedBy(real: string, st: BigIntStats, denied: { keys: Set<string>; roots: string[] }): string | null {
  if (denied.keys.has(`${st.dev}:${st.ino}`)) return real
  for (let dir = dirname(real); ; dir = dirname(dir)) {
    try { const d = statSync(dir, { bigint: true }); if (denied.keys.has(`${d.dev}:${d.ino}`)) return dir } catch { /* unreadable: the spelling check stands */ }
    if (dir === dirname(dir)) break
  }
  return denied.roots.find((root) => inside(real, root)) ?? null
}

/** A local file the person chose, checked before it is referenced: an absolute path; its real path (the volume's own
 *  spelling), opened without following a link and without blocking; a regular file; the same inode at that real path
 *  after the open (a swap during the check is refused); outside every credential store, the data directory and the
 *  caller's denied roots. Nothing of its content is read. */
export function inspectLocalSource(path: string, o: LocalAccessOptions): LocalSource {
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\0') || /[\x00-\x1f\x7f]/.test(path)) throw new AttachmentAccessRefused('a local file is named by an absolute path without control characters')
  let real: string
  try { real = realpathSync.native(path) } catch { throw new AttachmentAccessRefused(`${path} does not exist`) }
  const { fd, st } = openRegular(real)
  try {
    let again: string
    try { again = realpathSync.native(real) } catch { throw new AttachmentAccessRefused(`${path} moved while it was checked`) }
    const at = statSync(again, { bigint: true })
    if (again !== real || at.dev !== st.dev || at.ino !== st.ino) throw new AttachmentAccessRefused(`${path} changed while it was checked`)
    const denied = deniedBy(real, st, deniedIdentities(o))
    if (denied !== null) throw new AttachmentAccessRefused(`${path} is under ${denied}, which commands never read; it cannot be attached`)
    return { real_path: real, identity: identityOf(st), nlink: Number(st.nlink) }
  } finally { closeSync(fd) }
}

/** Up to `limit` bytes of a local file, read by the harness itself (a route that takes the file in its request; the
 *  first bytes that tell its format): opened at its real path without following a link, refused unless it is still
 *  the inode inspected, untouched (identity), of one name (no alias that could be another file's), outside the denied
 *  roots, and — with `whole` — no larger than the bound. Never reads past the bound. */
export function readLocalBounded(source: LocalSource, limit: number, o: LocalAccessOptions & { whole?: boolean }): Uint8Array {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new AttachmentAccessRefused('a bound is a non-negative integer')
  const { fd, st } = openRegular(source.real_path)
  try {
    if (!sameIdentity(identityOf(st), source.identity)) throw new AttachmentAccessRefused(`${source.real_path} changed since it was attached; attach it again`)
    if (st.nlink !== 1n) throw new AttachmentAccessRefused(`${source.real_path} has ${st.nlink} names; the harness does not read a file with an alias`)
    const denied = deniedBy(source.real_path, st, deniedIdentities(o))
    if (denied !== null) throw new AttachmentAccessRefused(`${source.real_path} is under ${denied}`)
    const size = Number(st.size)
    if (o.whole && size > limit) throw new AttachmentAccessRefused(`${source.real_path} is ${size} bytes; the bound is ${limit}`)
    const want = Math.min(size, limit)
    const out = new Uint8Array(want)
    let done = 0
    while (done < want) {
      const n = readSync(fd, out, done, want - done, done)
      if (n <= 0) break
      done += n
    }
    if (o.whole && done !== size) throw new AttachmentAccessRefused(`${source.real_path} was shorter than its size while it was read`)
    // the same descriptor after the read: a write, truncation, rename or link meanwhile moved its identity — what was
    // read is thrown away, never sent as the file
    const after = fstatSync(fd, { bigint: true })
    if (!sameIdentity(identityOf(after), source.identity) || after.nlink !== 1n) throw new AttachmentAccessRefused(`${source.real_path} changed while it was read; nothing of it is used`)
    return done === want ? out : out.subarray(0, done)
  } finally { closeSync(fd) }
}
