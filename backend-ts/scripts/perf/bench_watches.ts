/** Item 5 — the watches at idle and under many watches: how often the service's ticker and the remote driver's poll
 *  run, the SQL statements each costs, process CPU over the window, and how soon a `match` watch fires after its
 *  command printed the line (the command stamps its own epoch-ms; the fire is stamped as WatchService.fire is
 *  entered — an instance wrapper, no source change), then how soon the wake run starts (the debounce included).
 *  Production defaults (tick 5 s, debounce 2 s) unless --tick-ms/--debounce-ms. Commands run through the suite's
 *  passthrough runtime in sandbox mode; every command the bench starts is stopped at the end.
 *
 *  bun run scripts/perf/bench_watches.ts [--window-s 30] [--counts 0,1,20,100] [--latency-samples 10] [--silence]
 *  command isolation (no watches): --counts '' --commands 1,5,10 --latency-samples 0 --name watches_commands */

import './lib/env.ts'
import * as repo from '../../src/db/repo.ts'
import type { App } from '../../src/main.ts'
import { anthropicText, perfApp, perfSession, ProviderStub, streamResponse, syntheticRepo } from './lib/app.ts'
import { argList, argNum, argValue, hasFlag, memory, meta, round, sleep, summarize, writeResult } from './lib/stats.ts'

const windowS = argNum('window-s', 30)
const counts = argList('counts', [0, 1, 20, 100])
const latencySamples = argNum('latency-samples', 10)
const tickMs = argNum('tick-ms', 5000)
const debounceMs = argNum('debounce-ms', 2000)
const withSilence = hasFlag('silence')
/** running quiet commands with no watch at all: the process manager's own per-command cost, apart from the watches */
const commandCounts = argList('commands', [])

const stub = new ProviderStub(() => streamResponse(anthropicText('noted')))

interface Probe { ticks: number; tickMs: number[]; polls: number; sql: number; fires: { id: string; at: number }[]; lineageTicks: number; lineageMs: number }

function instrument(app: App): Probe {
  const probe: Probe = { ticks: 0, tickMs: [], polls: 0, sql: 0, fires: [], lineageTicks: 0, lineageMs: 0 }
  // the process manager's per-command lineage read (every LINEAGE_TICK_MS while a command runs): counted and timed
  const pm = app.state.processes as unknown as Record<string, (...a: unknown[]) => unknown>
  const track = pm.trackLineage!.bind(pm)
  pm.trackLineage = (...a: unknown[]) => { probe.lineageTicks++; const t = performance.now(); try { return track(...a) } finally { probe.lineageMs += performance.now() - t } }
  const svc = app.state.watches as unknown as Record<string, (...a: unknown[]) => unknown>
  const tick = svc.tick!.bind(svc)
  svc.tick = () => { probe.ticks++; const t = performance.now(); try { return tick() } finally { probe.tickMs.push(performance.now() - t) } }
  const fire = svc.fire!.bind(svc)
  svc.fire = (armed: unknown, ...rest: unknown[]) => { probe.fires.push({ id: (armed as { watch: { id: string } }).watch.id, at: Date.now() }); return fire(armed, ...rest) }
  const driver = app.state.remote_driver as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
  const poll = driver.poll!.bind(driver)
  driver.poll = (...a: unknown[]) => { probe.polls++; return poll(...a) }
  const conn = app.state.conn as unknown as Record<string, (...a: unknown[]) => unknown>
  for (const m of ['all', 'get', 'run', 'exec']) { const f = conn[m]!.bind(conn); conn[m] = (...a: unknown[]) => { probe.sql++; return f(...a) } }
  return probe
}

async function setup(sessions: number) {
  const app = await perfApp({ models: { 'stub:anthropic': stub.model() }, watches: { tick_ms: tickMs, debounce_ms: debounceMs } })
  const probe = instrument(app)
  await app.start()
  const repoPath = syntheticRepo(5)
  const ctx = []
  for (let i = 0; i < sessions; i++) {
    const { session, ws, project } = await perfSession(app, repoPath)
    const run = await app.state.runs.start(session, 'set up', { fresh: true })
    await app.state.runs.handles.get(run.id)!.task
    ctx.push({ session, ws, project, run_id: run.id })
  }
  return { app, probe, ctx }
}

async function startCommand(app: App, c: { ws: { id: string; path: string }; project: { id: string }; run_id: string }, command: string): Promise<string> {
  const x = await app.state.processes.start({
    command, cwd: c.ws.path, project_id: c.project.id, workspace_id: c.ws.id, run_id: c.run_id, kind: 'command', access: 'sandbox',
    sandbox: { writable: [c.ws.path], write_deny: [], read_deny: [], read_allow: [], network: false },
    timeout_s: 900, output_cap_bytes: 1 << 20,
  })
  return x.id
}

const QUIET = `perl -e 'select(undef,undef,undef,900)'`
const idle: Record<string, unknown>[] = []
for (const count of counts) {
  const sessions = Math.max(1, Math.ceil(count / 20))
  const { app, probe, ctx } = await setup(sessions)
  const xids: string[] = []
  for (let i = 0; i < count; i++) {
    const c = ctx[Math.floor(i / 20)]!
    if (i % 20 === 0) xids.push(await startCommand(app, c, QUIET))
    const kind = i % 3
    const input = kind === 0 ? { kind: 'match' as const, execution_id: xids[xids.length - 1], pattern: 'NEVER_PRINTED_\\d+' }
      : kind === 1 ? { kind: 'silence' as const, execution_id: xids[xids.length - 1], silence_s: 3600 }
        : { kind: 'timer' as const, delay_s: 7 * 24 * 3600 }
    const w = app.state.watches.register({ session_id: c.session.id, run_id: c.run_id, note: 'perf idle watch', input })
    if ('error' in w) throw new Error(`register: ${w.error}`)
  }
  await sleep(500)
  const before = { lt: probe.lineageTicks, lm: probe.lineageMs, ticks: probe.ticks, polls: probe.polls, sql: probe.sql, tickN: probe.tickMs.length, cpu: process.cpuUsage(), mem: await memory() }
  const t0 = performance.now()
  await sleep(windowS * 1000)
  const elapsed = (performance.now() - t0) / 1000
  const cpu = process.cpuUsage(before.cpu)
  const tickMsW = probe.tickMs.slice(before.tickN)
  const r = {
    watches: count, sessions, commands: xids.length, window_s: round(elapsed, 2), ticks: probe.ticks - before.ticks, remote_polls: probe.polls - before.polls,
    lineage_reads: probe.lineageTicks - before.lt, lineage_ms_total: round(probe.lineageMs - before.lm, 1), sql_statements: probe.sql - before.sql, sql_per_s: round((probe.sql - before.sql) / elapsed, 2), tick_ms: summarize(tickMsW),
    cpu_ms: round((cpu.user + cpu.system) / 1000, 1), cpu_pct_of_one_core: round(((cpu.user + cpu.system) / 1000) / (elapsed * 10), 3),
    mem_before: before.mem, mem_after: await memory(), loadavg: (await import('node:os')).loadavg(),
  }
  idle.push(r)
  console.log(`idle watches=${count}: ticks=${r.ticks} polls=${r.remote_polls} sql=${r.sql_statements} tick_med=${r.tick_ms.median}ms cpu=${r.cpu_ms}ms over ${r.window_s}s`)
  for (const x of xids) app.state.processes.stop(x)
  await app.close()
}

const commandsOnly: Record<string, unknown>[] = []
for (const nCmd of commandCounts) {
  const { app, probe, ctx } = await setup(1)
  const xids: string[] = []
  for (let i = 0; i < nCmd; i++) xids.push(await startCommand(app, ctx[0]!, QUIET))
  await sleep(500)
  const sql0 = probe.sql, lt0 = probe.lineageTicks, lm0 = probe.lineageMs, cpu0 = process.cpuUsage(), t0 = performance.now()
  await sleep(windowS * 1000)
  const elapsed = (performance.now() - t0) / 1000, cpu = process.cpuUsage(cpu0)
  const r = { running_commands: nCmd, watches: 0, window_s: round(elapsed, 2), sql_statements: probe.sql - sql0, lineage_reads: probe.lineageTicks - lt0, lineage_reads_per_s: round((probe.lineageTicks - lt0) / elapsed, 1), lineage_ms_total: round(probe.lineageMs - lm0, 1), cpu_ms: round((cpu.user + cpu.system) / 1000, 1), cpu_pct_of_one_core: round(((cpu.user + cpu.system) / 1000) / (elapsed * 10), 3), system_process_count: Number((await import('node:child_process')).execSync('ps -A -o pid= | wc -l').toString().trim()) }
  commandsOnly.push(r)
  console.log(`commands only n=${nCmd}: cpu=${r.cpu_ms}ms over ${r.window_s}s (${r.cpu_pct_of_one_core}% core), lineage reads=${r.lineage_reads} in ${r.lineage_ms_total}ms, processes on host=${r.system_process_count}`)
  for (const x of xids) app.state.processes.stop(x)
  await sleep(300)
  await app.close()
}

// discovery latency: each sample a command that prints one stamped line after a delay, watched by one match watch
const latency: Record<string, unknown> = {}
if (latencySamples > 0 || withSilence) {
  const { app, probe, ctx } = await setup(1)
  const c = ctx[0]!
  const fireLat: number[] = [], wakeLat: number[] = []
  for (let i = 0; i < latencySamples; i++) {
    const delay = 1 + (i % 5) * 0.2
    const xid = await startCommand(app, c, `perl -MTime::HiRes=time -e '$|=1; select(undef,undef,undef,${delay}); printf "MARK %.0f\\n", time*1000; select(undef,undef,undef,900)'`)
    const w = app.state.watches.register({ session_id: c.session.id, run_id: c.run_id, note: 'perf latency watch', input: { kind: 'match', execution_id: xid, pattern: 'MARK' } })
    if ('error' in w) throw new Error(`register: ${w.error}`)
    const deadline = Date.now() + 15_000
    let fired: { at: number } | undefined
    while (!(fired = probe.fires.find((f) => f.id === w.id)) && Date.now() < deadline) await sleep(5)
    const out = app.state.processes.readOutput(xid, 'stdout', 0, 4096) as unknown as { data?: string; text?: string }
    const mark = Number(/MARK (\d+)/.exec(String(out.data ?? out.text ?? JSON.stringify(out)))?.[1])
    if (fired && Number.isFinite(mark)) fireLat.push(fired.at - mark)
    // the wake run: started once the conversation is free and the debounce passed
    const wakeDeadline = Date.now() + 15_000
    let wake
    while (!(wake = repo.listRuns(app.state.conn, c.session.id).find((r) => r.spawned_by === 'wake' && Date.parse(r.created_at) >= (fired?.at ?? 0) - 5)) && Date.now() < wakeDeadline) await sleep(10)
    if (wake && fired) wakeLat.push(Date.parse(wake.created_at) - fired.at)
    if (wake) await app.state.runs.handles.get(wake.id)?.task
    app.state.processes.stop(xid)
    await sleep(200)
  }
  Object.assign(latency, { match_fire_after_print_ms: summarize(fireLat), wake_run_created_after_fire_ms: summarize(wakeLat), samples: latencySamples, raw_fire_ms: fireLat, raw_wake_ms: wakeLat })
  console.log(`match latency: fire median=${summarize(fireLat).median}ms wake median=${summarize(wakeLat).median}ms`)
  if (withSilence) {
    // silence: three commands print once then go quiet; a 30 s silence watch each (the minimum the tool allows)
    const xs: { xid: string; id: string; quietFrom: number; lastOut: number }[] = []
    for (let i = 0; i < 3; i++) {
      const xid = await startCommand(app, c, `perl -MTime::HiRes=time -e '$|=1; printf "LAST %.0f\\n", time*1000; select(undef,undef,undef,900)'`)
      await sleep(300)
      const out = app.state.processes.readOutput(xid, 'stdout', 0, 4096) as unknown as { data?: string; text?: string }
      const regAt = Date.now()
      const w = app.state.watches.register({ session_id: c.session.id, run_id: c.run_id, note: 'perf silence watch', input: { kind: 'silence', execution_id: xid, silence_s: 30 } })
      if ('error' in w) throw new Error(`register: ${w.error}`)
      // silence counts from the later of the last output and the arming
      xs.push({ xid, id: w.id, quietFrom: regAt, lastOut: Number(/LAST (\d+)/.exec(String(out.data ?? out.text ?? JSON.stringify(out)))?.[1]) })
    }
    const until = Date.now() + 50_000
    while (Date.now() < until && !xs.every((x) => probe.fires.some((f) => f.id === x.id))) await sleep(50)
    const late = xs.map((x) => (probe.fires.find((f) => f.id === x.id)?.at ?? NaN) - (Math.max(x.quietFrom, Number.isFinite(x.lastOut) ? x.lastOut : 0) + 30_000))
    latency.silence_fire_after_due_ms = summarize(late.filter(Number.isFinite))
    latency.silence_raw_ms = late
    for (const x of xs) app.state.processes.stop(x.xid)
    console.log(`silence latency after due: ${late.map((v) => round(v, 0)).join(', ')} ms`)
  }
  await app.close()
}

writeResult(argValue('name', 'watches')!, {
  bench: 'watches', ...meta(), level: 'WatchService + RemoteExecutionDriver in process; real child processes (passthrough sandbox mode); instance-wrapper counters',
  params: { window_s: windowS, counts, commands: commandCounts, latency_samples: latencySamples, tick_ms: tickMs, debounce_ms: debounceMs, silence: withSilence }, idle, commands_only: commandsOnly, latency,
})
process.exit(0)
