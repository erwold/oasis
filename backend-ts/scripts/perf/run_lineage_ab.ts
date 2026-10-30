/** Runs bench_lineage.ts (with the lib/lineage_probe.ts preload) for the lineage-polling fix, each run a fresh
 *  process, and keeps what is needed to trust the numbers: every stage's real exit code (or signal), its start and end
 *  in UTC and on this one process's monotonic clock, the load before and after, and the exact sources it ran — the git
 *  blob and sha256 of src/execution/processes.ts and lineage.ts, and the sha256 of every harness file.
 *
 *  The baseline is the base commit's own processes.ts, put in place of this worktree's for that stage only (written
 *  beside it and renamed over it), then the worktree's own put back and checked byte for byte; nothing else of the
 *  tree is touched, no other checkout, no git write. A put-back that cannot be verified stops everything with a
 *  non-zero exit. Each bench's result is checked against the source its stage meant to run (its recorded sha256), its
 *  case list, and its commands still running at the end of their window. Refused before anything runs: another Bun
 *  than 1.4.0, a production difference from the base other than processes.ts, the base's lineage.ts not the one in
 *  place, a frozen harness file not the frozen one, an output folder inside this repository or ~/.oasis-code.
 *
 *  bun scripts/perf/run_lineage_ab.ts smoke --out /abs/dir       after only, commands 0,1, 2 s windows
 *  bun scripts/perf/run_lineage_ab.ts ab    --out /abs/dir       baseline, after, baseline, after; 0,1,5,10; 30 s
 *  [--base a4dc9ca3bfddfa9cc57b50ba5f68c914a5772d10]  Exit 0 only when every stage and every check passed. */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir, loadavg } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const BACKEND = resolve(import.meta.dir, '..', '..')
const REPO = resolve(BACKEND, '..')
const PROCESSES = 'backend-ts/src/execution/processes.ts'
const LINEAGE = 'backend-ts/src/execution/lineage.ts'
/** the frozen audit harness (commit 2f5098a4f9e2d99d16356948d16d739e64467e46): sha256, first 16 hex */
const FROZEN: Record<string, string> = {
  'scripts/perf/bench_watches.ts': 'e6644ad0ba01a10e', 'scripts/perf/lib/app.ts': '0e8215511b8e0577', 'scripts/perf/lib/env.ts': '207a78cac0cf5c17',
  'scripts/perf/lib/fixtures.ts': '67322f3da3e2caca', 'scripts/perf/lib/stats.ts': '27fb3ad7fee2dc04',
}
const HARNESS = [...Object.keys(FROZEN), 'scripts/perf/bench_lineage.ts', 'scripts/perf/lib/lineage_probe.ts', 'scripts/perf/run_lineage_ab.ts']

const arg = (name: string, fallback: string | null = null): string | null => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : fallback
}
const mode = process.argv[2]
const base = arg('base', 'a4dc9ca3bfddfa9cc57b50ba5f68c914a5772d10')!
const outArg = arg('out')

const t0 = performance.now()
const mono = (): number => Math.round((performance.now() - t0) * 1000) / 1000
const load = (): number[] => loadavg().map((x) => Math.round(x * 100) / 100)
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const blob = (bytes: Uint8Array): string => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')

function git(args: string[]): { status: number | null; out: Buffer; err: string } {
  const r = spawnSync('git', args, { cwd: REPO, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1' }, maxBuffer: 64 * 1024 * 1024 })
  return { status: r.status, out: r.stdout ?? Buffer.alloc(0), err: (r.stderr ?? Buffer.alloc(0)).toString() }
}
function gitText(args: string[]): string {
  const r = git(args)
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} exited ${r.status}: ${r.err.trim()}`)
  return r.out.toString().trim()
}

interface Stage {
  name: string; kind: 'preflight' | 'bench' | 'swap' | 'restore' | 'validate'; ok: boolean
  start_utc: string; end_utc: string | null; mono_start_ms: number; mono_end_ms: number | null
  loadavg_before: number[]; loadavg_after: number[] | null
  exit_code?: number | null; signal?: string | null; command?: string[]; log?: { stdout: string; stderr: string }
  sources?: Record<string, { blob: string; sha256: string }>; detail?: string
}

const manifest: Record<string, unknown> & { stages: Stage[] } = { stages: [] }
let out = ''
const save = (): void => { if (out) writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n') }

function begin(name: string, kind: Stage['kind']): Stage {
  const s: Stage = { name, kind, ok: false, start_utc: new Date().toISOString(), end_utc: null, mono_start_ms: mono(), mono_end_ms: null, loadavg_before: load(), loadavg_after: null }
  manifest.stages.push(s)
  save()
  return s
}
function end(s: Stage, ok: boolean, detail?: string): boolean {
  s.ok = ok
  s.end_utc = new Date().toISOString()
  s.mono_end_ms = mono()
  s.loadavg_after = load()
  if (detail !== undefined) s.detail = detail
  save()
  if (!ok) console.error(`[run_lineage_ab] ${s.name}: FAILED${detail ? ` — ${detail}` : ''}`)
  return ok
}
function sourcesNow(): Record<string, { blob: string; sha256: string }> {
  const r: Record<string, { blob: string; sha256: string }> = {}
  for (const p of [PROCESSES, LINEAGE]) { const b = readFileSync(join(REPO, p)); r[p] = { blob: blob(b), sha256: sha256(b) } }
  return r
}

/** the file at `path` replaced by `bytes` (written beside it, renamed over it), then read back and compared */
function put(path: string, bytes: Uint8Array): boolean {
  const tmp = join(dirname(path), `.run_lineage_ab.${process.pid}.tmp`)
  writeFileSync(tmp, bytes)
  renameSync(tmp, path)
  return sha256(readFileSync(path)) === sha256(bytes)
}

let child: ChildProcess | null = null
let afterBytes: Buffer | null = null
let swapped = false

/** the worktree's own processes.ts back in place and verified; false: it could not be (everything stops) */
function restore(reason: string): boolean {
  if (!swapped || afterBytes === null) return true
  const s = begin(`restore after ${reason}`, 'restore')
  let ok = false
  try { ok = put(join(REPO, PROCESSES), afterBytes) } catch (error) { return end(s, false, String(error)) }
  if (ok) swapped = false
  s.sources = sourcesNow()
  return end(s, ok, ok ? undefined : 'the restored processes.ts does not read back as the worktree\'s own')
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    // the bench this wrapper started, by its handle; then the worktree's own file back, verified
    if (child !== null && child.exitCode === null) { try { child.kill('SIGTERM') } catch { /* gone */ } }
    const restored = restore(signal)
    manifest.interrupted = signal
    save()
    process.exit(restored ? 130 : 3)
  })
}

async function bench(label: 'baseline' | 'after', index: number, commands: string, windowS: number, expectSha: string): Promise<boolean> {
  const name = `${String(index).padStart(2, '0')}_${label}`
  const command = [process.execPath, '--preload', './scripts/perf/lib/lineage_probe.ts', 'scripts/perf/bench_lineage.ts',
    '--commands', commands, '--window-s', String(windowS), '--rounds', '1', '--label', label, '--name', name, '--out', out]
  const s = begin(`bench ${name}`, 'bench')
  s.command = command.map((c) => c === process.execPath ? 'bun' : c)
  s.sources = sourcesNow()
  s.log = { stdout: `${name}.stdout.log`, stderr: `${name}.stderr.log` }
  if (s.sources[PROCESSES]!.sha256 !== expectSha) return end(s, false, `processes.ts in place is not the ${label} one`)
  const stdout = openSync(join(out, s.log.stdout), 'w'), stderr = openSync(join(out, s.log.stderr), 'w')
  const result = await new Promise<{ code: number | null; signal: string | null }>((done) => {
    child = spawn(command[0]!, command.slice(1), { cwd: BACKEND, stdio: ['ignore', stdout, stderr] })
    child.once('error', (error) => { s.detail = String(error); done({ code: null, signal: null }) })
    child.once('exit', (code, signal) => done({ code, signal }))
  })
  child = null
  closeSync(stdout); closeSync(stderr)
  s.exit_code = result.code
  s.signal = result.signal
  if (result.code !== 0) return end(s, false, `exit ${result.code}${result.signal ? ` (${result.signal})` : ''}`)
  end(s, true)
  // the result as written: the source it ran, every case, every command still running at its window's end
  const v = begin(`validate ${name}`, 'validate')
  let data: { sources?: Record<string, string>; cases?: { running_commands: number; still_running_at_end: number }[] }
  try { data = JSON.parse(readFileSync(join(out, `${name}.json`), 'utf8')) } catch (error) { return end(v, false, `no readable result: ${String(error)}`) }
  const wanted = commands.split(',').map(Number)
  const problems = [
    data.sources?.['src/execution/processes.ts'] !== expectSha ? 'its recorded processes.ts is not the stage\'s' : null,
    JSON.stringify((data.cases ?? []).map((c) => c.running_commands)) !== JSON.stringify(wanted) ? 'its cases are not the ones asked' : null,
    (data.cases ?? []).some((c) => c.still_running_at_end !== c.running_commands) ? 'a command ended inside its window' : null,
  ].filter(Boolean)
  return end(v, problems.length === 0, problems.join('; ') || undefined)
}

async function main(): Promise<number> {
  if (mode !== 'smoke' && mode !== 'ab') { console.error('usage: run_lineage_ab.ts smoke|ab --out /absolute/dir [--base <sha>]'); return 2 }
  if (!outArg || !isAbsolute(outArg)) { console.error('--out must be an absolute folder'); return 2 }
  out = resolve(outArg)
  const inside = (dir: string) => out === dir || out.startsWith(dir + sep)
  if (inside(REPO) || inside(resolve(homedir(), '.oasis-code'))) { console.error(`--out ${out} is inside this repository or ~/.oasis-code; refused`); return 2 }
  if (existsSync(join(out, 'manifest.json'))) { console.error(`${out} already holds a manifest; use a fresh folder`); return 2 }
  mkdirSync(out, { recursive: true })

  const pre = begin('preflight', 'preflight')
  try {
    afterBytes = readFileSync(join(REPO, PROCESSES))
    const baseBytes = git(['show', `${base}:${PROCESSES}`])
    const baseLineage = git(['show', `${base}:${LINEAGE}`])
    if (baseBytes.status !== 0 || baseLineage.status !== 0) { end(pre, false, `the base ${base} files cannot be read`); return 1 }
    const harness: Record<string, string> = {}
    const baseline = { blob: blob(baseBytes.out), sha256: sha256(baseBytes.out) }
    const after = { blob: blob(afterBytes), sha256: sha256(afterBytes) }
    let changed: string[] = [], untracked: string[] = []
    try {
      for (const f of HARNESS) harness[f] = sha256(readFileSync(join(BACKEND, f)))
      // what differs from the base in production (tracked changes against it, and untracked files)
      changed = gitText(['diff', '--name-only', base, '--', 'backend-ts/src', 'contract']).split('\n').filter(Boolean)
      untracked = gitText(['ls-files', '--others', '--exclude-standard', '--', 'backend-ts/src', 'contract']).split('\n').filter(Boolean)
      Object.assign(manifest, {
        mode, base, head: gitText(['rev-parse', 'HEAD']), branch: gitText(['rev-parse', '--abbrev-ref', 'HEAD']), status_porcelain: gitText(['status', '--porcelain']),
        bun: Bun.version, bun_revision: Bun.revision, platform: process.platform, arch: process.arch, harness_sha256: harness,
        processes_ts: { baseline, after }, lineage_ts: sourcesNow()[LINEAGE], production_changed_from_base: changed, production_untracked: untracked,
      })
    } catch (error) {
      end(pre, false, String(error))
      return 1
    }
    const frozenBad = Object.entries(FROZEN).filter(([f, prefix]) => !harness[f]!.startsWith(prefix)).map(([f]) => f)
    const problems = [
      Bun.version !== '1.4.0' ? `Bun ${Bun.version}, not 1.4.0` : null,
      process.platform !== 'darwin' ? 'not macOS: there is no kernel lineage to measure' : null,
      frozenBad.length ? `frozen harness files changed: ${frozenBad.join(', ')}` : null,
      changed.some((f) => f !== PROCESSES) || untracked.length ? `production differs from the base beyond processes.ts: ${[...changed, ...untracked].join(', ')}` : null,
      sha256(baseLineage.out) !== sourcesNow()[LINEAGE]!.sha256 ? 'lineage.ts is not the base\'s' : null,
      mode === 'ab' && baseline.sha256 === after.sha256 ? 'processes.ts is the base\'s: there is no after to compare' : null,
    ].filter(Boolean)
    if (!end(pre, problems.length === 0, problems.join('; ') || undefined)) return 1

    const plan: ('baseline' | 'after')[] = mode === 'smoke' ? ['after'] : ['baseline', 'after', 'baseline', 'after']
    const commands = mode === 'smoke' ? '0,1' : '0,1,5,10'
    const windowS = mode === 'smoke' ? 2 : 30
    for (const [i, label] of plan.entries()) {
      if (label === 'baseline') {
        const s = begin(`swap in baseline processes.ts (${i + 1})`, 'swap')
        swapped = true
        let ok = false
        try { ok = put(join(REPO, PROCESSES), baseBytes.out) } catch (error) { s.detail = String(error) }
        s.sources = sourcesNow()
        if (!end(s, ok, ok ? undefined : s.detail ?? 'the baseline processes.ts does not read back')) return restore('a failed swap') ? 1 : 3
      }
      const ok = await bench(label, i + 1, commands, windowS, label === 'baseline' ? baseline.sha256 : after.sha256)
      if (!restore(`bench ${i + 1}`)) return 3
      if (!ok) return 1
    }
    return 0
  } finally {
    if (!restore('the end')) manifest.restore_failed = true
    save()
  }
}

const code = await main().catch((error) => { console.error(error); return restore('an error') ? 1 : 3 })
manifest.exit_code = manifest.restore_failed ? 3 : code
manifest.finished_utc = new Date().toISOString()
manifest.mono_total_ms = mono()
save()
console.log(`[run_lineage_ab] ${mode}: exit ${manifest.exit_code}${out ? `; manifest ${relative(process.cwd(), join(out, 'manifest.json'))}` : ''}`)
process.exit(manifest.exit_code as number)
