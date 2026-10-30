/** The OS isolation boundary for repository code (adapted from oasis exploration/isolation.py, see NOTICE).
 *  macOS: Seatbelt (sandbox-exec). Linux: bubblewrap (probe only claims what it verified).
 *
 *  What a command process gets: writes to its workspace worktree and its own scratch (HOME / TMPDIR point there),
 *  reads of the host minus the credential stores on a fixed list (CREDENTIAL_READ_DENY), the harness data directory,
 *  the user's original repository and any extra denied prefixes — the person's other private files stay readable;
 *  no network unless the session granted it for this execution; its own process group; rlimits; a wall-clock
 *  timeout. Not isolated from the person's other processes: their arguments and environment are readable and they
 *  can be signalled (PROCESS_LIMIT). The worktree's Git metadata (the project's base.git and the worktree's own
 *  directory in it) is readable — `git status`, `git diff`, `git log` work — and stays read-only, so a shell cannot
 *  rewrite shared Git state; the base repository's other worktrees (sibling sessions') stay hidden.
 *
 *  A work order's boundaries hold at the same edge: read-only, a read scope, a write scope and the protected paths
 *  are rendered into the profile after the workspace's rules, so a shell, an interpreter or a tool a command runs
 *  is held to them as the file tools are — nothing under the worktree is read or written outside them, whatever
 *  the command is called.
 *
 *  Enforcement is what the probe measured, and only that: the network check has a positive control (a loopback
 *  server of the host's own, reached by the host before and after, never by the probe), a connection that failed
 *  as unreachable or timed out is not a denial, and the process-group kill and the resource limits are exercised
 *  inside the confinement rather than assumed. A runtime reporting anything but 'full' makes bash refuse; nothing
 *  falls back to a bare subprocess. */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { safeFetch } from '../safe_fetch.ts'

export type Enforcement = 'full' | 'partial' | 'unavailable'

/** The credential stores a command never reads: the well-known places keys, tokens and passwords are kept. A list,
 *  not a boundary: any other private file of the person's (documents, shell history, another project's `.env`)
 *  stays readable to a command (see READ_LIMIT). */
export const CREDENTIAL_READ_DENY = [
  '~/.ssh', '~/.aws', '~/.config/gcloud', '~/.gnupg', '~/.netrc', '~/.docker', '~/.kube',
  '~/.config/gh', '~/.claude', '~/.codex', '~/.oasis', '~/.oasis-code', '~/cliproxyapi',
  '~/.npmrc', '~/.git-credentials', '~/.config/git/credentials', '~/.pypirc', '~/.cargo/credentials', '~/.cargo/credentials.toml',
  '~/.azure', '~/Library/Keychains',
]

/** What a command reads of the host, said plainly. */
export const READ_LIMIT = 'A command reads the host\'s files except the credential stores on a fixed list, the harness\'s data '
  + 'and the other projects: the person\'s other private files (documents, shell history, another project\'s .env) are readable to it.'

/** What a command sees of the person's other processes, said plainly. macOS answers a same-user process's arguments and
 *  environment (sysctl KERN_PROCARGS2) without asking the sandbox — measured: neither `(deny sysctl-read)` nor a
 *  deny-by-default profile withholds them — and denying `process-info*` or `signal` outside the command's own
 *  sandbox breaks `lsof` and stopping, from a later command, a server an earlier one started. So neither is denied. */
export const PROCESS_LIMIT = 'A command can read the arguments and environment of the person\'s other processes that are not '
  + 'part of macOS (the backend itself among them) and can signal them. A key exported in the environment the backend was '
  + 'started from is readable this way; a key kept in Accounts is not.'

export interface IsolationReport {
  runtime: string
  enforcement: Enforcement
  filesystem_isolation: boolean
  network_isolation: boolean
  process_tree_kill: boolean
  resource_limits: boolean
  runtime_fingerprint: string
  diagnostics: string[]
  /** what the runtime does not do, said plainly (a capability above is true within these) */
  limits?: string[]
}

export function isolationDict(r: IsolationReport): Record<string, unknown> {
  return { ...r, diagnostics: [...r.diagnostics] }
}

export interface ResourceLimits {
  cpu_seconds: number
  address_space_bytes: number
  file_size_bytes: number
  open_files: number
}

export const DEFAULT_LIMITS: ResourceLimits = { cpu_seconds: 3600, address_space_bytes: 8 * 1024 ** 3, file_size_bytes: 2 * 1024 ** 3, open_files: 1024 }

/** The exit status of a command whose resource limits could not be applied (nothing of it ran). */
export const LIMITS_REFUSED_EXIT = 126
/** What the limits' shell line prints on stderr when one of them is refused (and the command does not run). */
export const LIMITS_REFUSED_LINE = 'oasis-code: the resource limits could not be applied; the command did not run'

/** The shell line that applies the resource limits before a command runs, and stops when any of them is refused: an
 *  invalid value, or a hard limit below the one asked for, leaves the command unrun with the shell's own reason on
 *  stderr and exit status 126 — never a command running under fewer limits than the harness set. The file size
 *  limit is given in the shell's own unit: bash counts 1024-byte blocks, the POSIX shells (dash, zsh, ksh) 512-byte
 *  ones. The address space limit is Linux's (macOS does not enforce RLIMIT_AS; nothing is claimed for it there). */
export function limitedArgv(command: string, limits: ResourceLimits): string[] {
  const blocks = (unit: number) => Math.max(1, Math.trunc(limits.file_size_bytes / unit))
  const ulimits = [
    `ulimit -t ${limits.cpu_seconds}`,
    `if [ -n "$BASH_VERSION" ]; then ulimit -f ${blocks(1024)}; else ulimit -f ${blocks(512)}; fi`,
    `ulimit -n ${limits.open_files}`,
  ]
  if (process.platform === 'linux') ulimits.push(`ulimit -v ${Math.trunc(limits.address_space_bytes / 1024)}`)
  const prelude = `${ulimits.join(' && ')} || { echo '${LIMITS_REFUSED_LINE}' >&2; exit ${LIMITS_REFUSED_EXIT}; }`
  return ['/bin/sh', '-c', `${prelude}; exec /bin/sh -c "$0"`, command]
}

/** One command's confinement, resolved: real paths only (Seatbelt matches real paths; /tmp is /private/tmp). */
export interface Sandbox {
  writable: string[]              // the worktree and the scratch
  deny_hardlinks?: boolean        // isolated source mounts: no inode alias into a writable tree
  write_deny: string[]            // under the writable roots, never written (git metadata)
  /** under the writable roots, never written wherever they fall: each a regex body over the real path (a nested
   *  repository's metadata in a folder edited in place, where no fixed path can name them all) */
  write_deny_patterns?: string[]
  read_deny: string[]             // credentials, the harness data dir, the original repo, other projects
  read_allow: string[]            // under a denied root, still readable (the worktree, the scratch, the project's base repository)
  /** under an allowed root, denied again (the base repository's other worktrees: sibling sessions' metadata) */
  read_deny_within?: string[]
  /** under that, allowed again (this worktree's own metadata directory) */
  read_allow_within?: string[]
  /** roots a command stands on (its worktree, its HOME): written inside, never removed, renamed or replaced — a
   *  writable root swapped for a link would be another's ground next time */
  pinned?: string[]
  network: boolean
  /** the work order's boundaries inside the worktree, rendered after the workspace's rules (see OrderBounds) */
  bounds?: OrderBounds | null
  /** exact regular files a command reads although the harness's data directory, denied as a whole, holds them (a
   *  session's own sealed uploads in the asset store; a confined writer's own script): see ExactReads. Only the
   *  harness's authorization puts files here (workspace/attachment_access.ts authorizeInputFiles from its own records,
   *  or its legacy writer); a client's path never does. Absent or null: the profile is the one this build always
   *  rendered. */
  exact_reads?: ExactReads | null
}

/** What a box reads exactly: each file one literal path — never a subpath, never its folder's listing — read only,
 *  never written, renamed, removed or hard-linked. The renderer checks it whole again (exactReadProblems) and refuses
 *  the box over any fault. */
export interface ExactReads {
  /** real absolute paths of regular files of one name, each strictly inside one of `within` */
  files: string[]
  /** the harness-owned folders they may lie in (its asset store root; a writer's own work folder), each a real folder
   *  strictly inside `data_root` — never the data directory itself, so its database, tokens and credentials stay out */
  within: string[]
  /** the harness's data directory: exactly the one the runtime was built to deny (state.ts builds it with
   *  `extra_read_deny: [settings.data_dir]`) — never another denied root (a project's source, a credential store) */
  data_root: string
}

/** A sandbox's exact input files refused: nothing runs under a box that names one. */
export class SandboxInputRefused extends Error {
  constructor(message: string) { super(message); this.name = 'SandboxInputRefused' }
}

function under(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`)
}

function strictlyUnder(path: string, root: string): boolean {
  return path !== root && under(path, root)
}

/** The volume's own spelling of a path (a case-folding volume answers `.SSH` as `.ssh`), or null when it is missing. */
function nativeReal(path: string): string | null {
  try { return realpathSync.native(path) } catch { return null }
}

/** Why a box's exact reads cannot be granted, checked where the box is rendered. The data root must be exactly one of
 *  the harness's own data roots (`data_roots`: the runtime's configured denies — not the box's other denied roots), a
 *  real folder outside every writable root; a runtime configured with none grants no exact read. Each `within` folder: a real folder (no link in
 *  any component), strictly inside the data root, outside every writable root. Each file: an absolute, normal, real
 *  path to a regular file with one name only (no hard-link alias anywhere), strictly inside a `within` folder, outside
 *  every writable root; and under a credential store of the fixed list only when that store holds the data root
 *  itself (the default `~/.oasis-code`) — any other credential store is never opened by this exception. Empty: the
 *  reads may be granted. */
export function exactReadProblems(reads: ExactReads, ctx: { writable: string[]; data_roots: string[]; credential_roots?: string[] }): string[] {
  const problems: string[] = []
  const writable = ctx.writable.map(resolveReal)
  const dataRoots = ctx.data_roots.map(resolveReal)
  const credentials = (ctx.credential_roots ?? CREDENTIAL_READ_DENY).map(resolveReal)
  const normal = (p: unknown): p is string => typeof p === 'string' && p.startsWith('/') && !p.includes('\0') && resolve(p) === p && !p.endsWith('/')
  const data = reads?.data_root
  if (!normal(data) || nativeReal(data) !== data || !dataRoots.includes(data)) return [`the data root ${JSON.stringify(data)} is not the harness's own data directory, as a real path`]
  if (writable.some((w) => under(data, w))) return [`the data root ${data} is inside a writable root`]
  const within: string[] = []
  for (const w of reads.within ?? []) {
    const say = (why: string) => problems.push(`folder ${JSON.stringify(w)}: ${why}`)
    if (!normal(w) || nativeReal(w) !== w) { say('not a real absolute folder path'); continue }
    let st: ReturnType<typeof lstatSync>
    try { st = lstatSync(w) } catch { say('missing'); continue }
    if (!st.isDirectory()) { say('not a folder'); continue }
    if (!strictlyUnder(w, data)) { say(`not strictly inside the data root ${data}`); continue }
    if (writable.some((r) => under(w, r))) { say('inside a writable root'); continue }
    // the data directory's trees commands write in (any workspace's worktree, HOME and temporary folder)
    if (['workspaces', 'sandboxes'].some((tree) => under(w, join(data, tree)))) { say('inside a tree commands write'); continue }
    within.push(w)
  }
  for (const file of reads.files ?? []) {
    const say = (why: string) => problems.push(`${JSON.stringify(file)}: ${why}`)
    if (!normal(file)) { say('not an absolute, normal path'); continue }
    const real = nativeReal(file)
    if (real === null) { say('missing'); continue }
    if (real !== file) { say(`reached through a link (${real})`); continue }
    let st: ReturnType<typeof lstatSync>
    try { st = lstatSync(file) } catch { say('missing'); continue }
    if (!st.isFile()) { say('not a regular file'); continue }
    if (st.nlink !== 1) { say(`has ${st.nlink} names (a hard-link alias)`); continue }
    if (!within.some((w) => strictlyUnder(file, w))) { say('not inside a harness-owned folder of the box'); continue }
    if (writable.some((w) => under(file, w))) { say('inside a writable root'); continue }
    const credential = credentials.find((c) => under(file, c) && !under(data, c))
    if (credential !== undefined) { say(`under the credential store ${credential}`); continue }
  }
  return problems
}

/** The profile's tail for a box's exact reads (none: nothing, so the profile is unchanged). */
function exactReadRules(files: readonly string[], readDeny: string[]): string {
  if (!files.length) return ''
  const unique = [...new Set(files)]
  const ancestors = ancestorsBetween(unique, readDeny)
  return '\n;; exact input files: one literal each, read only — no folder listed, nothing written, renamed, removed or linked\n'
    + `(allow file-read*\n  ${lit(unique, 'literal')})\n`
    + (ancestors.length ? `(allow file-read-metadata\n  ${lit(ancestors, 'literal')})\n` : '')
    + `(deny file-write*\n  ${lit(unique, 'literal')})\n`
    + `(deny file-link\n  ${lit(unique, 'literal')})\n`
}

/** A box's exact read files once checked whole (none: nothing); a fault refuses the box. */
function checkedExactReads(box: Sandbox, runtimeDenied: string[]): string[] {
  const reads = box.exact_reads ?? null
  if (reads === null || !reads.files?.length) return []
  const writable = [...box.writable, ...(box.bounds?.attached?.writable ? [box.bounds.attached.root] : [])]
  // the runtime's own denies only (the harness's data directory), never the box's other denied roots
  const problems = exactReadProblems(reads, { writable, data_roots: runtimeDenied })
  if (problems.length) throw new SandboxInputRefused(`an exact input file cannot be granted to the command: ${problems.join('; ')}`)
  return reads.files
}

/** What a work order (and the protected paths of the project) bound inside a worktree, as the kernel enforces it
 *  for a command: the globs are the order's own, relative to the worktree root, with the file tools' meaning — a
 *  bare name covers the file or everything below a directory, `dir/**` likewise, `*` and `?` cross `/`. */
export interface OrderBounds {
  /** the worktree's real root */
  root: string
  /** nothing under the root (or an attached folder opened for writing) is written */
  read_only: boolean
  /** only these are read under the root; the repository directories the worktree reads its history through are
   *  hidden with it (no `git show` of what a scope hides); null: the whole worktree */
  read: string[] | null
  /** only these are written under the root; null: the whole worktree */
  write: string[] | null
  /** never written, whatever the scope says */
  protected: string[]
  /** the repository directories of the worktree: its own metadata, the object views it reads through, a linked
   *  worktree's metadata and the base repository — hidden under a read scope */
  repository: string[]
  /** an attached folder the globs may name by its first component (mounted as `name/` in the worktree) */
  attached?: { name: string; root: string; writable: boolean } | null
}

export function expandUser(path: string): string {
  return path.startsWith('~') ? join(homedir(), path.slice(1)) : path
}

function resolveReal(path: string): string {
  const expanded = resolve(expandUser(path))
  try { return realpathSync(expanded) } catch { return expanded }
}

/** A path as Seatbelt matches it: `~` expanded, absolute, its links resolved where it exists. */
export function resolveRealPath(path: string): string {
  return resolveReal(path)
}

/** Full isolation could not be verified on this host; nothing runs unisolated. */
export class IsolationUnavailable extends Error {
  constructor(message: string) { super(message); this.name = 'IsolationUnavailable' }
}

/** A restriction chosen for a Full access command (the network off, a read-only folder, a work order's bounds) that
 *  the OS of this host cannot be shown to enforce: the command does not run — neither without the restriction nor in
 *  the whole sandbox instead. */
export class HostRestrictionUnavailable extends IsolationUnavailable {
  readonly code = 'restriction_unavailable'
  constructor(message: string) { super(message); this.name = 'HostRestrictionUnavailable' }
}

/** What the OS holds a Full access command to when a narrower restriction was chosen for it, and only that: the
 *  command otherwise runs as the user on the host — the user's login shell, HOME, TMPDIR and environment, every file
 *  readable and writable as the user, no credential deny, no resource limit (Seatbelt: `hostProfile`). */
export interface HostRestrictions {
  /** false: the network is denied */
  network: boolean
  /** real paths (folders or files) never written, linked, removed or renamed; their ancestors are pinned too (a folder
   *  above one renamed away would carry it out of the rule) */
  write_deny: string[]
  /** real folders inside a `write_deny` folder that stay writable (a writable folder of the session's, or its working
   *  folder, lying in a read-only one: the deepest folder decides); a `write_deny` path inside one of these is denied
   *  again. Hard links stay denied in the whole read-only folder. Nothing outside a `write_deny` folder is named */
  write_allow?: string[]
  /** a work order's read-only / read scope / write scope, as the sandbox renders it (protected paths are the file
   *  tools': a Full access command is the user's own) */
  bounds?: OrderBounds | null
}

/** Whether a host restriction holds anything (none: the command runs on the host as it is). */
export function hostRestricted(r: HostRestrictions | null | undefined): r is HostRestrictions {
  if (!r) return false
  return !r.network || r.write_deny.length > 0 || (!!r.bounds && (r.bounds.read_only || r.bounds.read !== null || r.bounds.write !== null))
}

/** Every folder above a path, the root excluded (`/a/b/c` → `/a/b`, `/a`). */
function ancestorsOf(path: string): string[] {
  const out: string[] = []
  let cur = dirname(path)
  while (cur !== '/' && cur !== '.' && cur.length > 0) {
    out.push(cur)
    const next = dirname(cur)
    if (next === cur) break
    cur = next
  }
  return out
}

/** The Seatbelt profile of a Full access command with narrow restrictions: everything allowed, as for the user, then
 *  only the rules chosen — the network denied; a work order's bounds; writes denied to the read-only paths (after the
 *  order's allows, so a scope never reopens them), hard links of them denied, and the paths and their ancestors
 *  pinned against removal and rename. No credential deny, no HOME of the harness's, no resource limit. */
export function hostProfile(r: HostRestrictions): string {
  const denied = [...new Set(r.write_deny.map(resolveReal))]
  // a writable folder only counts inside a denied one (it reopens nothing else)
  const allowed = [...new Set((r.write_allow ?? []).map(resolveReal))].filter((a) => denied.some((d) => d !== a && under(a, d)))
  // denied folders holding a writable one: denied first, the writable one reopened after; every other denied path
  // after that (and after the order's allows), so neither a writable folder nor a scope reopens it
  const outer = denied.filter((d) => allowed.some((a) => a !== d && under(a, d)))
  const inner = denied.filter((d) => !outer.includes(d))
  const bounds = r.bounds ? { ...r.bounds, protected: [] } : null
  const lines = [
    '(version 1)',
    '(allow default)',
    ';; Full access: the host as the user, with only the restrictions chosen for this command',
    r.network ? ';; network: allowed' : '(deny network*)',
  ]
  if (outer.length) {
    // shallowest first, so the deepest folder holding a path has the last word on it
    lines.push(';; read-only folders holding a writable one: denied, the writable one reopened (the deepest decides)')
    const depth = (p: string) => p.split('/').length
    const nested = [...outer.map((p) => ['deny', p] as const), ...allowed.map((p) => ['allow', p] as const)].sort((a, b) => depth(a[1]) - depth(b[1]) || a[1].localeCompare(b[1]))
    for (const [rule, path] of nested) lines.push(`(${rule} file-write*\n  ${lit([path])})`)
  }
  lines.push(bounds && (bounds.read_only || bounds.read !== null || bounds.write !== null) ? orderRules(bounds) : ';; no work order bounds')
  if (denied.length) {
    const pinned = [...new Set(denied.flatMap((p) => [p, ...ancestorsOf(p)]))]
    lines.push(';; read-only paths: never written, linked, removed or renamed')
    if (inner.length) lines.push(`(deny file-write*\n  ${lit(inner)})`)
    lines.push(`(deny file-link\n  ${lit(denied)})`)
    lines.push(`(deny file-write-unlink\n  ${lit(pinned, 'literal')})`)
    lines.push(`(deny file-write-create\n  ${lit(pinned, 'literal')})`)
  }
  return lines.join('\n') + '\n'
}

const SEATBELT_TEMPLATE = `(version 1)
(allow default)
{network}
(deny file-write*)
(allow file-write*
  {writable}
  (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (literal "/dev/tty")
  (regex #"^/dev/ttys[0-9]+$"))
(deny file-write*
  {write_deny})
(deny file-read*
  {read_deny})
(allow file-read*
  {read_allow})
(deny file-read*
  {read_deny_within})
(allow file-read*
  {read_allow_within})
(allow file-read-metadata
  {read_metadata})
{order}
(deny file-write-unlink
  {pinned})
(deny file-write-create
  {pinned})
`

/** The directories between a denied root and an allowed path under it (the root itself included): a path is
 *  reached through its parents, and git, for one, resolves its metadata pointer by `stat`-ing every component. The
 *  metadata of these directory inodes is allowed — a name, a time, a mode — never their listing or a file in them. */
export function ancestorsBetween(allowed: string[], denied: string[]): string[] {
  const out = new Set<string>()
  for (const a of allowed) {
    for (const d of denied) {
      if (a === d || !a.startsWith(d.endsWith('/') ? d : `${d}/`)) continue
      let cur = dirname(a)
      while (cur.length >= d.length) {
        out.add(cur)
        if (cur === d) break
        cur = dirname(cur)
      }
    }
  }
  return [...out].sort()
}

/** A path, or a regex body, inside a profile's string literal. The profile reader takes `\\` as one backslash and
 *  `\"` as a quote, and drops the backslash of any other escape — so a backslash in a path is doubled and a quote
 *  escaped, and a regex body is written the same way (its own escapes, `\.` for a dot, reach the matcher only as
 *  `\\.`). Without this a backslash in a workspace path made the rule match a sibling path instead (SEC-04). */
export function sbplString(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** A regex filter over a pattern body (already regex-escaped where it is literal), as a plain string the reader
 *  decodes: the `#"…"` form takes the text raw and cannot hold a quote at all. */
function regexFilter(body: string): string {
  return `(regex "${sbplString(body)}")`
}

function lit(paths: string[], kind = 'subpath'): string {
  const unique = [...new Set(paths)]
  if (!unique.length) return '(literal "/nonexistent/oasis-code-placeholder")'
  return unique.map((p) => `(${kind} "${sbplString(p)}")`).join('\n  ')
}

// ---- the work order's boundaries as Seatbelt filters ------------------------------------------------------------

const GLOB_CHARS = /[*?[]/

/** A glob as the order writes it, in the form the file tools compare (see work_orders.inScope). */
function cleanGlob(raw: string): string {
  const g = raw.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  return g === '.' ? '' : g
}

/** A path's characters, literal, inside a Seatbelt regex. */
export function regexEscape(text: string): string {
  return text.replace(/[.+^$(){}|\\[\]?*]/g, '\\$&')
}

/** fnmatch's pattern (`*` and `?` across `/`, `[...]` classes) as a Seatbelt regex body, the way
 *  workspace/paths.fnmatchcase compiles it for the file tools. */
export function fnmatchRegex(pattern: string): string {
  let re = ''
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i]!
    if (c === '*') re += '.*'
    else if (c === '?') re += '.'
    else if (c === '[') {
      let j = i + 1
      if (j < pattern.length && pattern[j] === '!') j += 1
      if (j < pattern.length && pattern[j] === ']') j += 1
      while (j < pattern.length && pattern[j] !== ']') j += 1
      if (j >= pattern.length) re += '\\['
      else {
        let stuff = pattern.slice(i + 1, j).replace(/\\/g, '\\\\')
        i = j
        if (stuff.startsWith('!')) stuff = '^' + stuff.slice(1)
        else if (stuff.startsWith('^')) stuff = '\\' + stuff
        re += `[${stuff}]`
      }
    } else re += regexEscape(c)
  }
  return re
}

/** The Seatbelt filters that match what one glob covers under a root: everything (`*`, `**`, `.`), a name and
 *  everything below it (`src`, `src/**`, `calc.py`), or the paths a wildcard pattern matches. */
export function globFilters(root: string, glob: string): string[] {
  const g = cleanGlob(glob)
  if (g === '' || g === '*' || g === '**') return [`(subpath "${sbplString(root)}")`]
  const base = g.endsWith('/**') ? g.slice(0, -3) : g
  if (!GLOB_CHARS.test(base)) return [`(subpath "${sbplString(`${root}/${base}`)}")`]
  return [regexFilter(`^${regexEscape(root)}/${fnmatchRegex(g)}$`)]
}

/** The directories a wildcard glob's fixed prefix names (`src/tests` of `src/tests/*.py`): a tool that walks to
 *  a match stats them on the way. */
function prefixDirectories(root: string, glob: string): string[] {
  const g = cleanGlob(glob)
  if (!g) return []
  const parts = g.split('/')
  const out: string[] = []
  for (let i = 0; i < parts.length - 1 && !GLOB_CHARS.test(parts[i]!); i += 1) out.push(`${root}/${parts.slice(0, i + 1).join('/')}`)
  return out
}

/** The roots a glob applies under: the worktree, and the attached folder when the glob names it by its mount name
 *  (`name`, `name/**`, `name/src/*.py`), with the mount name stripped. */
function targetsOf(b: OrderBounds, glob: string, access: 'read' | 'write' = 'read'): [string, string][] {
  const g = cleanGlob(glob)
  const out: [string, string][] = [[b.root, g]]
  const a = b.attached
  if (!a || (access === 'write' && !a.writable)) return out
  if (g === '' || g === '*' || g === '**') out.push([a.root, ''])
  else if (g === a.name) out.push([a.root, ''])
  else if (g.startsWith(`${a.name}/`)) out.push([a.root, g.slice(a.name.length + 1)])
  return out
}

/** The profile's tail for a work order's boundaries: rendered after the workspace rules and before the pinned
 *  roots, so a scope narrows what the workspace allowed and never widens it. */
export function orderRules(bounds: OrderBounds | null | undefined): string {
  if (!bounds) return ';; no work order bounds'
  const b = { ...bounds, root: resolveReal(bounds.root), repository: bounds.repository.map(resolveReal), attached: bounds.attached ? { ...bounds.attached, root: resolveReal(bounds.attached.root) } : null }
  const lines: string[] = [';; the work order\'s boundaries']
  const filters = (globs: string[], access: 'read' | 'write' = 'read'): string[] => globs.flatMap((g) => targetsOf(b, g, access).flatMap(([root, rel]) => globFilters(root, rel)))
  const unique = (items: string[]): string => [...new Set(items)].join('\n  ')
  if (b.read !== null) {
    const hidden = [b.root, ...b.repository, ...(b.attached ? [b.attached.root] : [])]
    lines.push(`(deny file-read*\n  ${lit(hidden)})`)
    lines.push(`(allow file-read*\n  ${unique(filters(b.read)) || lit([])})`)
    const walked = [b.root, ...(b.attached ? [b.attached.root] : []), ...b.read.flatMap((g) => targetsOf(b, g).flatMap(([root, rel]) => prefixDirectories(root, rel)))]
    lines.push(`(allow file-read-metadata\n  ${lit(walked, 'literal')})`)
  }
  if (b.read_only || b.write !== null) {
    const held = [b.root, ...(b.attached?.writable ? [b.attached.root] : [])]
    lines.push(`(deny file-write*\n  ${lit(held)})`)
    if (!b.read_only && b.write !== null) lines.push(`(allow file-write*\n  ${unique(filters(b.write, 'write')) || lit([])})`)
  }
  if (b.protected.length) {
    // as the file tools read a protected glob: the pattern itself, and the name it strips to (`secrets/**` covers `secrets`)
    const globs = b.protected.flatMap((p) => { const stripped = p.replace(/[/*]+$/, ''); return stripped && stripped !== p ? [p, stripped] : [p] })
    lines.push(`(deny file-write*\n  ${unique(filters(globs))})`)
  }
  return lines.join('\n')
}

export interface IsolationRuntime {
  readonly name: string
  fingerprint(): string
  command(argv: string[], box: Sandbox, profilePath: string): string[]
  /** A Full access command under narrow restrictions (HostRestrictions): absent when the runtime cannot hold them on
   *  the host (such a command is then refused) */
  hostCommand?(argv: string[], restrictions: HostRestrictions, profilePath: string): string[]
  probe(dataDir: string): Promise<IsolationReport>
}

function which(bin: string): boolean {
  return (process.env.PATH ?? '/usr/bin:/bin').split(':').some((dir) => { try { return statSync(join(dir, bin)).isFile() } catch { return false } })
}

/** What stopping a command reaches on macOS, and what it does not (see execution/lineage.ts). */
export const LINEAGE_LIMIT = 'A command\'s processes are stopped with it by the kernel lineage and the fork watcher. A process that '
  + 'makes a child and exits before the watcher reads its parent\'s children breaks the chain: that child is attributed '
  + 'to no command and is not stopped.'

/** The errors a connection the sandbox refused is known to end in: Bun's fetch cannot open a socket at all
 *  (FailedToOpenSocket), a runtime that surfaces the errno gets EPERM or EACCES. Any other error — a reset, a
 *  library's TypeError — is a failure the probe cannot read as isolation, and is reported as such. */
export const DENIAL_CODES = ['FailedToOpenSocket', 'EPERM', 'EACCES']

/** The probe a runtime runs inside its own confinement. Each file attempt prints allowed / blocked; the network
 *  attempt says how it ended — allowed, denied (one of DENIAL_CODES: the sandbox), unreachable (a closed port, no
 *  route), timed out, or failed otherwise; the resource limits are the harness's own prelude with a 1024-byte file
 *  size limit under a 4096-byte write; the process tree is a detached group with a grandchild, killed as a group.
 *  Its `fetch` is the confined runtime's, not this process's, and reaches only this process's own control server,
 *  which answers a fixed, unencoded body: nothing Brotli-encoded can reach it (docs/brotli-cve-2026-111497.md). */
function probeScript(opts: { control: string; escape: string; secret: string; locked: string; okFile: string; home: string; capFile: string; limited: string[] }): string {
  return `
const r = {}
const fs = require('node:fs')
const cp = require('node:child_process')
async function attempt(name, fn) { try { await fn(); r[name] = 'allowed' } catch { r[name] = 'blocked' } }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
r.net = await (async () => {
  try { const res = await fetch(${JSON.stringify(opts.control)}, { signal: AbortSignal.timeout(5000) }); await res.text(); return 'allowed' }
  catch (error) {
    const code = String((error && (error.code || (error.cause && error.cause.code) || error.name)) || 'unknown')
    if (/timeout|timedout|abort/i.test(code)) return 'timeout ' + code
    if (/refused|unreach/i.test(code)) return 'unreachable ' + code
    if (${JSON.stringify(DENIAL_CODES)}.includes(code)) return 'denied ' + code
    return 'failed ' + code
  }
})()
await attempt('home_write', () => fs.writeFileSync(${JSON.stringify(opts.escape)}, 'x'))
await attempt('data_read', () => fs.readFileSync(${JSON.stringify(opts.secret)}))
await attempt('meta_write', () => fs.writeFileSync(${JSON.stringify(opts.locked)}, 'y'))
await attempt('work_write', () => fs.writeFileSync(${JSON.stringify(opts.okFile)}, 'ok'))
await attempt('home_read', () => fs.readdirSync(${JSON.stringify(opts.home)}))
r.rlimit = (() => {
  const argv = ${JSON.stringify(opts.limited)}
  const run = cp.spawnSync(argv[0], argv.slice(1), { cwd: ${JSON.stringify(dirname(opts.capFile))}, timeout: 10000, encoding: 'utf8' })
  let size = -1
  try { size = fs.statSync(${JSON.stringify(opts.capFile)}).size } catch { size = -1 }
  if (size > 0 && size <= 1024 && run.status !== 0) return 'held'
  return 'not held (' + size + ' bytes, status ' + run.status + ' ' + (run.signal || '') + ' ' + String(run.stderr || '').trim().slice(-200) + ')'
})()
r.tree_kill = await (async () => {
  const child = cp.spawn('/bin/sh', ['-c', 'sleep 30 & echo $!; wait'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
  let timer
  const grandchild = await new Promise((resolve) => {
    let out = ''
    child.stdout.on('data', (d) => { out += d; const m = /^(\\d+)/.exec(out); if (m) resolve(Number(m[1])) })
    child.on('exit', () => resolve(0))
    child.on('error', () => resolve(0))
    timer = setTimeout(() => resolve(0), 5000)
  })
  clearTimeout(timer)
  if (!grandchild) return 'not measured (no grandchild)'
  try { process.kill(-child.pid, 'SIGKILL') } catch (error) { return 'not killed (' + (error && error.code) + ')' }
  for (let i = 0; i < 40; i += 1) {
    try { process.kill(grandchild, 0) } catch { return 'killed' }
    await sleep(50)
  }
  return 'not killed (' + grandchild + ' still alive)'
})()
console.log(JSON.stringify(r))
`
}

/** The probe's output, or null when it could not be started; killed after a minute. */
function runProbe(command: string[], cwd: string, env: Record<string, string>): Promise<{ stdout: string; stderr: string } | null> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let child: ReturnType<typeof spawn>
    try { child = spawn(command[0]!, command.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }) } catch { resolve(null); return }
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* gone */ } }, 60_000)
    child.stdout!.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr!.on('data', (d: Buffer) => { stderr += d.toString() })
    child.once('error', () => { clearTimeout(timer); resolve(null) })
    child.once('close', () => { clearTimeout(timer); resolve({ stdout, stderr }) })
  })
}

/** The positive control of the network check: whether the host reached its own loopback server before and after the
 *  probe (an unreachable target fails outside a sandbox too, so a failed connection proves nothing without it), and
 *  how many connections that server took from the probe (none, for a sandbox that denies the network). */
export interface ProbeControl {
  healthy: boolean
  probe_hits: number
}

interface ControlServer {
  url: string
  hits(): number
  reachable(): Promise<boolean>
  close(): void
}

async function startControl(): Promise<ControlServer | null> {
  let hits = 0
  const server = createServer((_req, res) => { hits += 1; res.end('oasis-code isolation probe control') })
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()) })
  } catch { return null }
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const url = `http://127.0.0.1:${port}/probe`
  return {
    url,
    hits: () => hits,
    reachable: async () => {
      try { const res = await safeFetch(url, { signal: AbortSignal.timeout(5000) }); await res.text(); return res.ok } catch { return false }
    },
    close: () => { server.close(); server.closeAllConnections() },
  }
}

/** The report from what the probe printed and what the host saw: every check named ok or FAIL, and for a failed
 *  network check why it failed — the probe reached the control, or its connection failed as unreachable or timed
 *  out rather than refused by the sandbox, or the host had no healthy control to compare against. */
export function judgeProbe(name: string, fingerprint: string, work: string, escape: string, output: { stdout: string; stderr: string } | null, control: ProbeControl): IsolationReport {
  let report: Record<string, string> = {}
  try { report = JSON.parse((output?.stdout ?? '').trim().split('\n').at(-1) ?? '{}') } catch { report = {} }
  const homeWriteBlocked = report.home_write === 'blocked' && !existsSync(escape)
  try { unlinkSync(escape) } catch { /* never written */ }
  const lockedText = (() => { try { return readFileSync(join(work, 'meta', 'locked'), 'utf8') } catch { return '' } })()
  const net = report.net ?? 'no report'
  const checks = {
    net: net.startsWith('denied') && control.healthy && control.probe_hits === 0,
    home_write: homeWriteBlocked,
    data_read: report.data_read === 'blocked',
    meta_write: report.meta_write === 'blocked' && lockedText === 'x',
    work_write: report.work_write === 'allowed' && existsSync(join(work, 'ok.txt')),
    home_read: report.home_read === 'allowed',
    rlimit: report.rlimit === 'held',
    tree_kill: report.tree_kill === 'killed',
  }
  const diagnostics = [Object.entries(checks).map(([k, v]) => `${k}=${v ? 'ok' : 'FAIL'}`).join(', ')]
  if (!checks.net) diagnostics.push(networkDiagnostic(net, control))
  if (report.rlimit && !checks.rlimit) diagnostics.push(`resource limits: ${report.rlimit}`)
  if (report.tree_kill && !checks.tree_kill) diagnostics.push(`process tree kill: ${report.tree_kill}`)
  if (!Object.keys(report).length) diagnostics.push('probe printed no report: ' + (output?.stderr ?? 'the probe could not start').slice(-300))
  const full = Object.values(checks).every(Boolean)
  return {
    runtime: name, enforcement: full ? 'full' : 'partial',
    filesystem_isolation: checks.home_write && checks.data_read && checks.meta_write, network_isolation: checks.net,
    process_tree_kill: checks.tree_kill, resource_limits: checks.rlimit, runtime_fingerprint: fingerprint, diagnostics,
    limits: [LINEAGE_LIMIT, READ_LIMIT, PROCESS_LIMIT],
  }
}

function networkDiagnostic(net: string, control: ProbeControl): string {
  if (!control.healthy) return 'network: not verified — the host could not reach its own control server, so a failed connection inside the sandbox proves nothing'
  if (net === 'allowed' || control.probe_hits > 0) return `network: the sandboxed probe reached the control server (${control.probe_hits} connection(s))`
  if (net.startsWith('unreachable') || net.startsWith('timeout')) return `network: the probe's connection failed as ${net}, not as refused by the sandbox`
  if (net.startsWith('failed')) return `network: the probe's connection ${net}, which is not a refusal the sandbox is known to give (${DENIAL_CODES.join(', ')}); not verified`
  return `network: ${net}`
}

export class SeatbeltRuntime implements IsolationRuntime {
  readonly name = 'seatbelt'
  readonly extra_read_deny: string[]
  readonly probe_executable: string

  constructor(opts: { extra_read_deny?: string[]; probe_executable?: string } = {}) {
    this.extra_read_deny = [...(opts.extra_read_deny ?? [])]
    this.probe_executable = opts.probe_executable ?? process.execPath
  }

  profile(box: Sandbox): string {
    const home = homedir()
    let readDeny = [...CREDENTIAL_READ_DENY.map(resolveReal), ...this.extra_read_deny.map(resolveReal), ...box.read_deny.map(resolveReal)]
    readDeny = readDeny.filter((p) => existsSync(p) || !p.startsWith(home))
    const files = checkedExactReads(box, this.extra_read_deny)
    const readAllow = box.read_allow.map(resolveReal)
    const readDenyWithin = (box.read_deny_within ?? []).map(resolveReal)
    const readAllowWithin = (box.read_allow_within ?? []).map(resolveReal)
    const metadata = [...ancestorsBetween(readAllow, readDeny), ...ancestorsBetween(readAllowWithin, readDenyWithin)]
    return SEATBELT_TEMPLATE
      .replace('{network}', box.network ? '(allow network*)' : '(deny network*)')
      .replace('{writable}', lit(box.writable.map(resolveReal)))
      .replace('{write_deny}', [lit(box.write_deny.map(resolveReal), 'subpath'), lit(box.write_deny.map(resolveReal), 'literal'), ...(box.write_deny_patterns ?? []).map(regexFilter)].join('\n  '))
      .replace('{read_deny}', lit(readDeny))
      .replace('{read_allow}', lit(readAllow))
      .replace('{read_deny_within}', lit(readDenyWithin))
      .replace('{read_allow_within}', lit(readAllowWithin))
      .replace('{read_metadata}', lit(metadata, 'literal'))
      .replace('{order}', orderRules(box.bounds))
      .replaceAll('{pinned}', lit((box.pinned ?? []).map(resolveReal), 'literal'))
      + '\n;; immutable workspace denies, after all work-order allows\n(deny file-write*\n  ' + [lit(box.write_deny.map(resolveReal)), ...(box.write_deny_patterns ?? []).map(regexFilter)].join('\n  ') + ')\n'
      + (box.deny_hardlinks ? '\n(deny file-link)\n' : '')
      + exactReadRules(files, readDeny)
  }

  fingerprint(): string {
    return createHash('sha256').update('seatbelt|' + SEATBELT_TEMPLATE + '|' + CREDENTIAL_READ_DENY.join(',') + '|' + this.extra_read_deny.join(',')).digest('hex').slice(0, 16)
  }

  command(argv: string[], box: Sandbox, profilePath: string): string[] {
    writeFileSync(profilePath, this.profile(box))
    return ['sandbox-exec', '-f', profilePath, ...argv]
  }

  hostCommand(argv: string[], restrictions: HostRestrictions, profilePath: string): string[] {
    writeFileSync(profilePath, hostProfile(restrictions))
    return ['sandbox-exec', '-f', profilePath, ...argv]
  }

  async probe(dataDirIn: string): Promise<IsolationReport> {
    if (process.platform !== 'darwin') return unavailable(this.name, 'seatbelt is macOS-only')
    if (!which('sandbox-exec')) return unavailable(this.name, 'sandbox-exec not found')
    const home = homedir()
    const dataDir = resolveReal(dataDirIn)
    mkdirSync(dataDir, { recursive: true })
    const secret = join(dataDir, '.probe-secret')
    writeFileSync(secret, 'secret')
    const tmp = mkdtempSync(join(dataDir, 'oasis-code-probe-'))
    const control = await startControl()
    try {
      const scratch = resolveReal(tmp)
      const work = join(scratch, 'work')
      mkdirSync(join(work, 'meta'), { recursive: true })
      writeFileSync(join(work, 'meta', 'locked'), 'x')
      const script = join(scratch, 'probe.mjs')
      const escape = join(home, '.oasis_code_isolation_escape_probe')
      const capFile = join(work, 'cap.bin')
      writeFileSync(script, probeScript({
        // no control server: a port nothing listens on, so the probe's failure reads as unreachable and never as isolation
        control: control?.url ?? 'http://127.0.0.1:9/probe', escape, secret, locked: join(work, 'meta', 'locked'), okFile: join(work, 'ok.txt'), home, capFile,
        limited: limitedArgv('head -c 4096 /dev/zero > cap.bin', { ...DEFAULT_LIMITS, file_size_bytes: 1024 }),
      }))
      const box: Sandbox = { writable: [work, scratch], write_deny: [join(work, 'meta')], read_deny: [dataDir], read_allow: [work, scratch], network: false }
      const profile = join(scratch, 'profile.sb')
      const healthyBefore = control ? await control.reachable() : false
      const hitsBefore = control?.hits() ?? 0
      // BUN_BE_BUN: the compiled single-file backend runs the probe script as bun itself would (bun and node ignore it)
      const output = await runProbe(this.command([this.probe_executable, script], box, profile), work, scrubbedEnv(['PATH'], { HOME: scratch, TMPDIR: scratch, BUN_BE_BUN: '1' }))
      const healthyAfter = control ? await control.reachable() : false
      const probeHits = control ? control.hits() - hitsBefore - (healthyAfter ? 1 : 0) : 0
      return judgeProbe(this.name, this.fingerprint(), work, escape, output, { healthy: healthyBefore && healthyAfter, probe_hits: probeHits })
    } finally {
      control?.close()
      try { unlinkSync(secret) } catch { /* gone */ }
      rmSync(tmp, { recursive: true, force: true })
    }
  }
}

export class BubblewrapRuntime implements IsolationRuntime {
  readonly name = 'bubblewrap'
  readonly extra_read_deny: string[]

  constructor(opts: { extra_read_deny?: string[]; probe_executable?: string } = {}) {
    this.extra_read_deny = [...(opts.extra_read_deny ?? [])]
  }

  fingerprint(): string {
    return createHash('sha256').update('bwrap-oasis-code-v0').digest('hex').slice(0, 16)
  }

  command(argv: string[], box: Sandbox, _profilePath: string): string[] {
    if (box.bounds && (box.bounds.read !== null || box.bounds.write !== null || box.bounds.protected.length)) {
      throw new IsolationUnavailable('bubblewrap cannot hold a work order\'s read / write scope or protected paths; nothing runs outside them')
    }
    const cmd = ['bwrap', '--die-with-parent', '--new-session', '--unshare-all', '--proc', '/proc', '--dev', '/dev',
      '--ro-bind', '/usr', '/usr', '--ro-bind', '/bin', '/bin', '--ro-bind', '/lib', '/lib']
    if (existsSync('/lib64')) cmd.push('--ro-bind', '/lib64', '/lib64')
    if (existsSync('/etc')) cmd.push('--ro-bind', '/etc', '/etc')
    if (box.network) cmd.push('--share-net')
    for (const path of box.writable) cmd.push(box.bounds?.read_only && path === box.bounds.root ? '--ro-bind' : '--bind', path, path)
    for (const path of box.write_deny) cmd.push('--ro-bind', path, path)
    // exact input files: the file alone, bound read-only at its own path (its folder is not bound: nothing else of
    // it is seen), after every writable bind so none can open it for writing; a link to it from a writable bind
    // crosses a mount and fails
    for (const path of new Set(checkedExactReads(box, this.extra_read_deny))) cmd.push('--ro-bind', path, path)
    return [...cmd, ...argv]
  }

  async probe(_dataDir: string): Promise<IsolationReport> {
    if (process.platform !== 'linux') return unavailable(this.name, 'bubblewrap is Linux-only')
    if (!which('bwrap')) return unavailable(this.name, 'bwrap not found')
    // not verified by a real probe on this build: reported as partial, and no capability is claimed for it
    return {
      runtime: this.name, enforcement: 'partial', filesystem_isolation: false, network_isolation: false, process_tree_kill: false,
      resource_limits: false, runtime_fingerprint: this.fingerprint(),
      diagnostics: ['bubblewrap present; this build has not verified its confinement with a probe, so nothing is claimed for it'],
    }
  }
}

export function unavailable(name: string, why: string): IsolationReport {
  return { runtime: name, enforcement: 'unavailable', filesystem_isolation: false, network_isolation: false, process_tree_kill: false, resource_limits: false, runtime_fingerprint: '', diagnostics: [why] }
}

export function buildRuntime(opts: { extra_read_deny?: string[]; probe_executable?: string } = {}): IsolationRuntime {
  if (process.platform === 'darwin') return new SeatbeltRuntime(opts)
  return new BubblewrapRuntime(opts)
}

/** An environment built from nothing: the named host variables (by name, never a secret's name), then the sandbox's own HOME / TMPDIR. */
export function scrubbedEnv(passthrough: string[], extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of passthrough) {
    const value = process.env[name]
    if (value !== undefined && !looksSecret(name)) env[name] = value
  }
  env.PATH ??= '/usr/bin:/bin:/usr/sbin:/sbin'
  env.LANG ??= 'C.UTF-8'
  Object.assign(env, extra)
  return env
}

const SECRET_MARKERS = ['KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'CREDENTIAL', 'AUTH']

export function looksSecret(name: string): boolean {
  const upper = name.toUpperCase()
  return SECRET_MARKERS.some((marker) => upper.includes(marker))
}
