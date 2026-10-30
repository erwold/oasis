/** The legacy placement of an attached PDF or video a route did not take itself, made safe.
 *
 *  History written before ref-v1 already says, word for word, `saved at <workspace temp>/attachments/<sha12>-<name>`;
 *  that text is never changed. The file it names was put there by the harness itself (llm/attachments.ts
 *  folderPlacer) with mkdir -p and writeFileSync — both follow links — into the workspace's temporary folder, which
 *  every command of the workspace writes: a command could turn `attachments`, or the file's name, into a link, and
 *  the next request's placement wrote the attachment's bytes wherever it led (outside the sandbox, as the harness).
 *  Checking first (lstat) and writing after is a race the command can win; Node has no descriptor-relative
 *  mkdirat/openat/renameat to close it.
 *
 *  So the harness no longer writes there. The placement is done by a small writer under the workspace's own kernel
 *  confinement (the isolation runtime that confines its commands): it may write only inside the real temporary
 *  folder — whatever a link there points at, the kernel refuses a write that lands outside — is handed its code
 *  inline (no script file: the data directory stays denied whole) and the bytes on its standard input, has no
 *  network and may make no hard link. Inside, it refuses a
 *  linked or non-folder `attachments`, writes a fresh file it creates exclusively (never through an existing name:
 *  a hard link or a link planted at the final name is replaced, not written through) and renames it into place.
 *
 *  Once per folder and file for the life of the process: the bytes are read (by the caller's loader) at most once,
 *  not on every request; what the agent later does to the copy in its own temporary folder is its own. Fail closed:
 *  without full enforcement, over the legacy bound, with bytes that are not the recorded ones, or with a writer that
 *  did not answer `placed`, nothing is written and the request still names the same path (the history's words do
 *  not change); the refusal is reported, and the file is simply not there. */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { scrubbedEnv, type Enforcement, type IsolationRuntime, type Sandbox } from '../execution/isolation.ts'

/** The most a legacy PDF or video attachment ever was (contract FILE_LIMITS.pdf / .video before ref-v1). */
export const LEGACY_PLACEMENT_MAX_BYTES = 20 * 1024 * 1024

export interface LegacyFile { name: string; sha256: string; bytes: number }

/** The file name the legacy placement used — the same characters, so the history's path is the one placed. */
export function legacyPlacementName(file: Pick<LegacyFile, 'name' | 'sha256'>): string {
  const safe = basename(file.name).replace(/[^\w.-]+/g, '_').replace(/^\.+/, '') || 'attachment'
  return `${file.sha256.slice(0, 12)}-${safe}`
}

/** The path the legacy note names for a file placed into `dir` (`<workspace temp>/attachments`). */
export function legacyPlacementPath(dir: string, file: Pick<LegacyFile, 'name' | 'sha256'>): string {
  return join(dir, legacyPlacementName(file))
}

/** The writer: evaluated by the runtime's executable (bun -e) under the placement box. Its folder, name and size come
 *  in its environment (an evaluated script's argv differs between bun's spellings). */
export const LEGACY_WRITER = `'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { OASIS_PLACE_DIR: dir, OASIS_PLACE_NAME: name, OASIS_PLACE_SIZE: size } = process.env
const fail = (code, why) => { process.stderr.write('refused: ' + why + '\\n'); process.exit(code) }
if (!dir || !name || name.includes('/') || name === '.' || name === '..') fail(2, 'bad arguments')
const folder = () => { try { return fs.lstatSync(dir) } catch (e) { if (e.code === 'ENOENT') return null; throw e } }
let st = folder()
if (st === null) { try { fs.mkdirSync(dir, { mode: 0o755 }) } catch (e) { if (e.code !== 'EEXIST') throw e } st = folder() }
if (st === null || st.isSymbolicLink() || !st.isDirectory()) fail(3, 'the attachments folder is not a folder')
const bytes = fs.readFileSync(0)
if (bytes.length !== Number(size)) fail(4, 'the input is not the expected size')
const tmp = path.join(dir, '.oasis-place-' + process.pid + '-' + Date.now().toString(36))
const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o644)
try {
  for (let done = 0; done < bytes.length;) { const n = fs.writeSync(fd, bytes, done, bytes.length - done); if (!(n > 0)) fail(6, 'short write'); done += n }
  fs.fsyncSync(fd)
} finally { fs.closeSync(fd) }
const target = path.join(dir, name)
let there = null
try { there = fs.lstatSync(target) } catch { there = null }
if (there !== null && there.isDirectory()) { fs.unlinkSync(tmp); fail(5, 'a folder holds the name') }
fs.renameSync(tmp, target)
process.stdout.write('placed\\n')
`

/** The placement box: the real temporary folder writable (and pinned: never removed or replaced), the harness's data
 *  directory denied whole, no network, no hard link at all. */
export function legacyPlacementSandbox(tempReal: string, dataReal: string): Sandbox {
  return { writable: [tempReal], write_deny: [], read_deny: [dataReal], read_allow: [tempReal], pinned: [tempReal], network: false, deny_hardlinks: true }
}

export interface LegacyPlacerOptions {
  runtime: IsolationRuntime
  /** what the isolation probe measured, read at each placement; anything but full writes nothing */
  enforcement: () => Enforcement
  /** the harness's data directory (denied to the writer as a whole) */
  data_dir: string
  /** a folder of the harness's own under the data directory, written by no command (settings.scratch_dir) */
  scratch_dir: string
  /** the program that runs the writer: bun, or the compiled backend (BUN_BE_BUN) */
  executable?: string
  timeout_ms?: number
  /** required: a refusal is the caller's to show (a visible event of the run) — the history still says `saved at`
   *  that path, and nothing is there */
  on_refused: (file: LegacyFile, path: string, reason: string) => void
}

export type PlacementOutcome = { status: 'placed'; path: string } | { status: 'refused'; path: string; reason: string }

export class LegacyAttachmentPlacer {
  private readonly outcomes = new Map<string, PlacementOutcome>()

  constructor(private readonly o: LegacyPlacerOptions) {}

  /** What became of a file in a folder this process placed or refused, or null (not tried yet). */
  outcome(dir: string, file: Pick<LegacyFile, 'name' | 'sha256'>): PlacementOutcome | null {
    return this.outcomes.get(legacyPlacementPath(dir, file)) ?? null
  }

  /** Let a folder's files be placed again (at a run's start, say: a copy the agent removed comes back once). */
  forget(dir: string): void {
    for (const key of [...this.outcomes.keys()]) if (dirname(key) === dir) this.outcomes.delete(key)
  }

  /** Place a legacy file into `dir` (`<workspace temp>/attachments`) once; the path the history names, whatever
   *  happened. `bytes` may be a loader: it is called only when a placement is attempted. */
  place(dir: string, file: LegacyFile, bytes: Uint8Array | (() => Uint8Array)): string {
    const path = legacyPlacementPath(dir, file)
    if (this.outcomes.has(path)) return path
    const outcome = this.attempt(dir, file, bytes)
    this.outcomes.set(path, outcome)
    if (outcome.status === 'refused') this.o.on_refused(file, path, outcome.reason)
    return path
  }

  /** llm/attachments.ts AttachmentPlacer over one folder: the loader is called only when the file is placed now. */
  placer(dir: string): (file: LegacyFile, bytes: Uint8Array | (() => Uint8Array)) => string {
    return (file, bytes) => this.place(dir, file, bytes)
  }

  private attempt(dir: string, file: LegacyFile, given: Uint8Array | (() => Uint8Array)): PlacementOutcome {
    const path = legacyPlacementPath(dir, file)
    const refuse = (reason: string): PlacementOutcome => ({ status: 'refused', path, reason })
    if (!/^[a-f0-9]{64}$/.test(file.sha256)) return refuse('the file has no sha256')
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > LEGACY_PLACEMENT_MAX_BYTES) return refuse(`a legacy placement holds at most ${LEGACY_PLACEMENT_MAX_BYTES} bytes`)
    if (this.o.enforcement() !== 'full') return refuse('the workspace\'s confinement is not fully enforced; the harness does not write into a folder its commands write')
    // the temporary folder itself: a real folder (the harness made it so before the run: ProcessManager.ensureTemp)
    const temp = dirname(dir)
    let tempReal: string
    try {
      if (!lstatSync(temp).isDirectory()) return refuse('the temporary folder is not a folder')
      tempReal = realpathSync.native(temp)
    } catch { return refuse('the temporary folder is missing') }
    let bytes: Uint8Array
    try { bytes = typeof given === 'function' ? given() : given } catch (error) { return refuse(`the attachment could not be read: ${(error as Error).message}`) }
    if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) return refuse('the bytes are not the attachment\'s')
    let dataReal: string
    try { dataReal = realpathSync.native(this.o.data_dir) } catch { return refuse('the data directory is missing') }
    mkdirSync(this.o.scratch_dir, { recursive: true })
    const work = mkdtempSync(join(this.o.scratch_dir, 'legacy-place-'))
    try {
      const workReal = realpathSync.native(work)
      if (!workReal.startsWith(`${dataReal}/`)) return refuse('the harness\'s scratch folder is not inside its data directory')
      const box = legacyPlacementSandbox(tempReal, dataReal)
      let argv: string[]
      try {
        argv = this.o.runtime.command([this.o.executable ?? process.execPath, '-e', LEGACY_WRITER], box, join(workReal, 'profile.sb'))
      } catch (error) { return refuse(`no confinement for the writer: ${(error as Error).message}`) }
      const out = spawnSync(argv[0]!, argv.slice(1), {
        input: bytes, cwd: tempReal, encoding: 'utf8', timeout: this.o.timeout_ms ?? 30_000, maxBuffer: 64 * 1024,
        env: scrubbedEnv(['PATH'], {
          HOME: tempReal, TMPDIR: tempReal, BUN_BE_BUN: '1',
          OASIS_PLACE_DIR: join(tempReal, basename(dir)), OASIS_PLACE_NAME: legacyPlacementName(file), OASIS_PLACE_SIZE: String(bytes.length),
        }),
      })
      if (out.status === 0 && out.stdout.trim() === 'placed') return { status: 'placed', path }
      return refuse(`the confined writer did not place it (exit ${out.status ?? out.signal}): ${(out.stderr || out.error?.message || '').trim().slice(0, 300)}`)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  }
}
