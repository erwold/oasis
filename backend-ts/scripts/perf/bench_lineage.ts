/** The process manager's lineage cost with N quiet commands running and no watch (bench_watches.ts `--commands`, the
 *  same app, command and windows), with the two counters kept apart: how often the manager's `trackLineage` is entered
 *  (an instance wrapper, as bench_watches counts it) and how often the kernel's process table is actually read
 *  (lib/lineage_probe.ts, a load-time wrapper of execution/lineage.ts — no production file changed). One table
 *  reading may serve several commands, so the first is not the second. Every case runs `--rounds` times (default
 *  once: the A/B alternates whole invocations instead), in the order given, each in a fresh app; the host's process
 *  count and load are taken around every window.
 *
 *  bun --preload ./scripts/perf/lib/lineage_probe.ts scripts/perf/bench_lineage.ts \
 *    [--commands 0,1,5,10] [--window-s 30] [--rounds 1] [--label before] [--name lineage_before] [--out DIR] */

import './lib/env.ts'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { App } from '../../src/main.ts'
import { anthropicText, perfApp, perfSession, ProviderStub, streamResponse, syntheticRepo } from './lib/app.ts'
import type { LineageProbe } from './lib/lineage_probe.ts'
import { argList, argNum, argValue, BACKEND_DIR, loadAvg, meta, round, sleep, writeResult } from './lib/stats.ts'

const probe = (globalThis as { __oasisLineageProbe?: LineageProbe }).__oasisLineageProbe
if (!probe) throw new Error('run with --preload ./scripts/perf/lib/lineage_probe.ts: the table readings cannot be counted without it')
// the static imports above have loaded execution/lineage.ts: it must be the rewritten one, before anything is measured
if (!probe.installed) throw new Error('the lineage probe did not rewrite execution/lineage.ts: its counts would be zero, not measured')

const windowS = argNum('window-s', 30)
const rounds = argNum('rounds', 1)
const commandCounts = argList('commands', [0, 1, 5, 10])
const label = argValue('label', 'unlabelled')!

const stub = new ProviderStub(() => streamResponse(anthropicText('noted')))
const QUIET = `perl -e 'select(undef,undef,undef,900)'`

interface Calls { calls: number; ms: number }

function instrument(app: App): { track: Calls; sql: { n: number } } {
  const track: Calls = { calls: 0, ms: 0 }
  const sql = { n: 0 }
  const pm = app.state.processes as unknown as Record<string, (...a: unknown[]) => unknown>
  const original = pm.trackLineage!.bind(pm)
  pm.trackLineage = (...a: unknown[]) => { track.calls++; const t = performance.now(); try { return original(...a) } finally { track.ms += performance.now() - t } }
  const conn = app.state.conn as unknown as Record<string, (...a: unknown[]) => unknown>
  for (const m of ['all', 'get', 'run', 'exec']) { const f = conn[m]!.bind(conn); conn[m] = (...a: unknown[]) => { sql.n++; return f(...a) } }
  return { track, sql }
}

/** the host's process count, by ps itself (no pipe whose last command could turn a failed ps into a count of 0) */
function hostProcesses(): number {
  const r = spawnSync('/bin/ps', ['-A', '-o', 'pid='], { encoding: 'utf8' })
  const n = (r.stdout ?? '').split('\n').filter((l) => /^\s*\d+\s*$/.test(l)).length
  if (r.error || r.status !== 0 || n === 0) throw new Error(`ps could not count the host's processes (${r.error ? String(r.error) : `exit ${r.status}`}, ${n} listed)`)
  return n
}
const fileSha = (rel: string): string => createHash('sha256').update(readFileSync(join(BACKEND_DIR, rel))).digest('hex')

/** the commands of the case running now: stopped (their process groups, synchronously) before lib/env.ts's own
 *  SIGINT/SIGTERM handler exits the process, and on any other exit (an uncaught error), so a bench that ends early
 *  leaves none of its quiet commands behind */
let running: { app: App; xids: string[] } | null = null
const stopRunning = (): void => { if (running) for (const x of running.xids) running.app.state.processes.stop(x) }
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.prependListener(signal, stopRunning)
process.prependListener('exit', stopRunning)

const cases: Record<string, unknown>[] = []
for (let roundIndex = 0; roundIndex < rounds; roundIndex++) {
  for (const n of commandCounts) {
    // bench_watches.ts's defaults (the production watch tick and debounce), so the app is the same one
    const app = await perfApp({ models: { 'stub:anthropic': stub.model() }, watches: { tick_ms: 5000, debounce_ms: 2000 } })
    const { track, sql } = instrument(app)
    await app.start()
    const { session, ws, project } = await perfSession(app, syntheticRepo(5))
    const run = await app.state.runs.start(session, 'set up', { fresh: true })
    await app.state.runs.handles.get(run.id)!.task
    const xids: string[] = []
    running = { app, xids }
    for (let i = 0; i < n; i++) {
      const x = await app.state.processes.start({
        command: QUIET, cwd: ws.path, project_id: project.id, workspace_id: ws.id, run_id: run.id, kind: 'command', access: 'sandbox',
        sandbox: { writable: [ws.path], write_deny: [], read_deny: [], read_allow: [], network: false }, timeout_s: 900, output_cap_bytes: 1 << 20,
      })
      xids.push(x.id)
    }
    await sleep(500)
    const hostBefore = hostProcesses(), loadBefore = loadAvg()
    const t0c = track.calls, t0m = track.ms, s0 = probe.scans, s0m = probe.scan_ms, s0r = probe.scan_rows, q0 = sql.n
    const cpu0 = process.cpuUsage(), t0 = performance.now()
    await sleep(windowS * 1000)
    const elapsed = (performance.now() - t0) / 1000, cpu = process.cpuUsage(cpu0)
    const scans = probe.scans - s0
    const stillRunning = xids.filter((x) => app.state.processes.isRunning(x)).length
    const r = {
      label, round: roundIndex + 1, running_commands: n, still_running_at_end: stillRunning, window_s: round(elapsed, 2),
      track_lineage_calls: track.calls - t0c, track_lineage_calls_per_s: round((track.calls - t0c) / elapsed, 1), track_lineage_ms_total: round(track.ms - t0m, 1),
      table_scans: scans, table_scans_per_s: round(scans / elapsed, 1), table_scan_ms_total: round(probe.scan_ms - s0m, 1),
      table_scan_ms_mean: scans ? round((probe.scan_ms - s0m) / scans, 3) : null, rows_per_scan_mean: scans ? round((probe.scan_rows - s0r) / scans, 1) : null,
      sql_statements: sql.n - q0,
      cpu_ms: round((cpu.user + cpu.system) / 1000, 1), cpu_pct_of_one_core: round(((cpu.user + cpu.system) / 1000) / (elapsed * 10), 3),
      host_processes_before: hostBefore, host_processes_after: hostProcesses(), loadavg_before: loadBefore, loadavg_after: loadAvg(),
    }
    cases.push(r)
    console.log(`[${label}] round ${r.round} n=${n}: trackLineage ${r.track_lineage_calls} calls; table scans ${scans} (${r.table_scans_per_s}/s) in ${r.table_scan_ms_total} ms; cpu ${r.cpu_pct_of_one_core}% core; host ${hostBefore} processes; still running ${stillRunning}/${n}`)
    for (const x of xids) app.state.processes.stop(x)
    for (const x of xids) await app.state.processes.wait(x, 10)
    running = null
    await app.close()
    // commands that ran the whole window on a host with a kernel lineage read the table: none read is a probe that
    // missed them, never a measured zero (said once its commands are stopped)
    if (process.platform === 'darwin' && stillRunning > 0 && scans === 0) throw new Error(`[${label}] n=${n}: ${stillRunning} command(s) ran ${r.window_s} s and no table reading was counted; the probe missed them`)
  }
}

writeResult(argValue('name', `lineage_${label}`)!, {
  bench: 'lineage', ...meta({ label }),
  sources: { 'src/execution/processes.ts': fileSha('src/execution/processes.ts'), 'src/execution/lineage.ts': fileSha('src/execution/lineage.ts') },
  level: 'ProcessManager in the perf app; real quiet child processes (passthrough sandbox mode); trackLineage instance wrapper + load-time identities() wrapper (main thread; CPU includes it)',
  params: { window_s: windowS, rounds, commands: commandCounts }, cases,
})
process.exit(0)
