/** The watches' lifecycle at its edges: a wake run keyed by its first event, so a restart before its events were
 *  settled takes that run and settles only what its message carried; a cancelled watch and a deleted session's
 *  watches wake no one (their waiting reports withdrawn, their timers released, the reason said); a repeating timer
 *  keeps to its cooldown; the tail of an over-long line is never read as a line of its own. */

import { afterEach, expect, setSystemTime, test } from 'bun:test'
import type { Execution, Run, WakeEvent } from '@oasis-code/contract'
import * as repo from '../src/db/repo.ts'
import type { WatchInput } from '../src/agent/watches/conditions.ts'
import { WatchService, type WatchServiceOptions } from '../src/agent/watches/service.ts'
import { modelResponse, textPart, type ModelMessage } from '../src/llm/messages.ts'
import { appState, buggyRepo, closeState, openSession, scriptedModel, setModel, sleep, waitDone, type AppState } from './harness.ts'

let state: AppState | null = null
const started: string[] = []
afterEach(async () => {
  setSystemTime()
  if (state) {
    for (const xid of started) state.processes.stop(xid)
    await closeState(state)
  }
  started.length = 0
  state = null
}, 30_000)

const NO_DELIVERY = { debounce_ms: 3_600_000, tick_ms: 3_600_000 }
const FAST = { debounce_ms: 50, tick_ms: 100 }

type Listener = (xid: string, stream: 'stdout' | 'stderr', chunk: Buffer) => void
interface ServiceInternals { armed: Map<string, unknown>; timers(): void; tick(): void }
const internals = (st: AppState) => st.watches as unknown as ServiceInternals

function feed(st: AppState, xid: string, chunk: string): void {
  for (const listener of (st.processes as unknown as { outputListeners: Listener[] }).outputListeners) listener(xid, 'stdout', Buffer.from(chunk))
}

function lastUserText(messages: ModelMessage[]): string {
  const last = messages[messages.length - 1]
  if (!last || last.kind !== 'request') return ''
  return last.parts.filter((p) => p.part_kind === 'user-prompt').map((p) => (Array.isArray(p.content) ? p.content.filter((c) => typeof c === 'string').join('\n') : String(p.content))).join('\n')
}

async function setup(watches: WatchServiceOptions) {
  state = await appState({ sandbox: true, watches })
  state.watches.start()
  const opened = await openSession(state, buggyRepo())
  return { st: state, ...opened }
}

/** oasis-code restarted, as far as the watches go: the old service gone, a new one on the same database started. */
function restart(st: AppState, opts: WatchServiceOptions): ReturnType<WatchService['start']> {
  st.watches.close()
  st.watches = new WatchService(st, opts)
  st.watches.attachHooks()
  return st.watches.start()
}

async function command(st: AppState, ws: { id: string; path: string }, projectId: string, cmd: string): Promise<Execution> {
  const box = { writable: [ws.path], write_deny: [], read_deny: [], read_allow: [ws.path], network: false }
  const x = await st.processes.start({ command: cmd, cwd: ws.path, sandbox: box, project_id: projectId, workspace_id: ws.id })
  started.push(x.id)
  return x
}

function register(st: AppState, sessionId: string, input: WatchInput, note = 'look again') {
  const out = st.watches.register({ session_id: sessionId, run_id: 'run_watch', note, input })
  if ('error' in out) throw new Error(out.error)
  return out
}

const eventsOf = (st: AppState, watchId: string): WakeEvent[] => repo.listWakeEvents(st.conn, repo.getWatch(st.conn, watchId)!.session_id, 500).filter((e) => e.watch_id === watchId)
const wakeRuns = (st: AppState, sessionId: string): Run[] => repo.listRuns(st.conn, sessionId).filter((r) => r.spawned_by === 'wake')

async function until<T>(what: string, read: () => T | null | undefined | false, timeoutMs = 15_000): Promise<T> {
  const deadline = performance.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value) return value
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(25)
  }
}

async function settleWakes(st: AppState, sessionId: string): Promise<void> {
  await sleep(600)
  for (const r of wakeRuns(st, sessionId)) await waitDone(st, r.id)
}

test('a restart after the wake run started but before its events were settled takes the same run (keyed wake:<first event>), no second wake', async () => {
  const { st, session } = await setup(FAST)
  setModel(st, 'scripted:a', scriptedModel(() => modelResponse([textPart('ok')])))
  const t0 = Date.now()
  setSystemTime(new Date(t0))
  register(st, session.id, { kind: 'timer', delay_s: 30 })
  setSystemTime(new Date(t0 + 31_000))
  internals(st).timers()
  const first = await until('the wake', () => wakeRuns(st, session.id)[0])
  await settleWakes(st, session.id)
  const [event] = repo.listWakeEvents(st.conn, session.id)
  expect(event!.run_id).toBe(first.id)
  const keyOf = (runId: string) => st.conn.get('SELECT client_request_id FROM runs WHERE id=?', [runId])!.client_request_id
  // the crash window: the run exists, its events' settle was never written
  st.conn.run("UPDATE wake_events SET status='pending', run_id=NULL, delivered_at=NULL WHERE session_id=?", [session.id])
  restart(st, FAST)
  await settleWakes(st, session.id)
  expect(wakeRuns(st, session.id).map((r) => r.id)).toEqual([first.id])
  expect(keyOf(first.id)).toBe(`wake:${event!.id}`)
}, 30_000)


test('a restart in that window with a newer report waiting: the old run settles only what its message carried; the newer report wakes on its own', async () => {
  const { st, session } = await setup(FAST)
  const said: string[] = []
  setModel(st, 'scripted:a', scriptedModel((m) => { said.push(lastUserText(m)); return modelResponse([textPart('ok')]) }))
  const t0 = Date.now()
  setSystemTime(new Date(t0))
  const early = register(st, session.id, { kind: 'timer', delay_s: 30 }, 'the early one')
  const later = register(st, session.id, { kind: 'timer', delay_s: 300 }, 'the later one')
  setSystemTime(new Date(t0 + 31_000))
  internals(st).timers()
  const first = await until('the first wake', () => wakeRuns(st, session.id)[0])
  await settleWakes(st, session.id)
  st.conn.run("UPDATE wake_events SET status='pending', run_id=NULL, delivered_at=NULL WHERE session_id=?", [session.id])
  st.watches.close()
  // while down, the later timer comes too: its report was never in the first wake's message
  setSystemTime(new Date(t0 + 301_000))
  restart(st, FAST)
  await until('the second wake', () => wakeRuns(st, session.id)[1])
  await settleWakes(st, session.id)
  const runs = wakeRuns(st, session.id)
  expect(runs).toHaveLength(2)
  expect(runs[0]!.id).toBe(first.id)
  expect(eventsOf(st, early.id).map((e) => [e.status, e.run_id])).toEqual([['delivered', first.id]])
  expect(eventsOf(st, later.id).map((e) => [e.status, e.run_id])).toEqual([['delivered', runs[1]!.id]])
  expect(said.filter((t) => t.includes('the later one'))).toHaveLength(1)
  expect(said.find((t) => t.includes('the early one'))).not.toContain('the later one')
}, 30_000)

test('the person cancels a watch whose report still waits for the conversation: the report is withdrawn, no wake comes from it', async () => {
  const { st, session } = await setup(FAST)
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => { release = r })
  setModel(st, 'scripted:a', scriptedModel(async (m) => {
    if (!lastUserText(m).includes('oasis-code started this turn')) await gate
    return modelResponse([textPart('ok')])
  }))
  const person = await st.runs.start(session, 'the person asks something')
  const t0 = Date.now()
  setSystemTime(new Date(t0))
  const w = register(st, session.id, { kind: 'timer', delay_s: 60, repeat: true })
  setSystemTime(new Date(t0 + 61_000))
  internals(st).timers()
  expect(repo.listPendingWakeEvents(st.conn, session.id)).toHaveLength(1)
  // the person cancels it while its report waits for the person's own run
  expect(st.watches.cancel(w.id, 'person')).toBe(true)
  release()
  await waitDone(st, person.id)
  await settleWakes(st, session.id)
  expect(wakeRuns(st, session.id)).toHaveLength(0)
  expect(eventsOf(st, w.id).map((e) => e.status)).toEqual(['dropped'])
  expect(repo.getWatch(st.conn, w.id)).toMatchObject({ status: 'cancelled', ended_reason: 'cancelled by the user' })
}, 30_000)


test('a report of a cancelled watch still pending when the wake is made is dropped, not delivered', async () => {
  const { st, session } = await setup(NO_DELIVERY)
  setModel(st, 'scripted:a', scriptedModel(() => modelResponse([textPart('ok')])))
  const t0 = Date.now()
  setSystemTime(new Date(t0))
  const w = register(st, session.id, { kind: 'timer', delay_s: 60 })
  setSystemTime(new Date(t0 + 61_000))
  internals(st).timers()
  // a watch cancelled by an older build, its report left waiting
  repo.updateWatch(st.conn, w.id, { status: 'cancelled', ended_reason: 'cancelled by the user' })
  expect(await st.watches.deliver(session.id)).toBeNull()
  expect(wakeRuns(st, session.id)).toHaveLength(0)
  expect(eventsOf(st, w.id).map((e) => e.status)).toEqual(['dropped'])
}, 30_000)

test('a deleted session found by the tick: its watches end with a reason and release their timers', async () => {
  const { st, session } = await setup(NO_DELIVERY)
  const t0 = Date.now()
  setSystemTime(new Date(t0))
  const w = register(st, session.id, { kind: 'timer', delay_s: 60, repeat: true, max_fires: 20 })
  repo.deleteSession(st.conn, session.id)                              // what DELETE /api/sessions/:id writes
  internals(st).tick()
  setSystemTime(new Date(t0 + 61_000))
  internals(st).timers()
  internals(st).tick()
  expect(internals(st).armed.has(w.id)).toBe(false)
  expect(repo.getWatch(st.conn, w.id)).toMatchObject({ status: 'cancelled', ended_reason: 'the session was deleted' })
  expect(eventsOf(st, w.id).filter((e) => e.kind === 'fired')).toHaveLength(0)
}, 30_000)


test('deleting a session ends its watches at once, with a reason, and withdraws their waiting reports', async () => {
  const { st, session } = await setup(NO_DELIVERY)
  const t0 = Date.now()
  setSystemTime(new Date(t0))
  const w = register(st, session.id, { kind: 'timer', delay_s: 60, repeat: true })
  setSystemTime(new Date(t0 + 61_000))
  internals(st).timers()
  expect(eventsOf(st, w.id).map((e) => e.status)).toEqual(['pending'])
  repo.deleteSession(st.conn, session.id)
  st.watches.sessionDeleted(session.id)
  expect(internals(st).armed.has(w.id)).toBe(false)
  expect(repo.getWatch(st.conn, w.id)).toMatchObject({ status: 'cancelled', ended_reason: 'the session was deleted' })
  expect(eventsOf(st, w.id).map((e) => e.status)).toEqual(['dropped'])
}, 30_000)

test('a restart finds an active watch of a deleted session: it ends with the reason, not armed again', async () => {
  const { st, session } = await setup(NO_DELIVERY)
  const w = register(st, session.id, { kind: 'timer', delay_s: 60, repeat: true })
  repo.deleteSession(st.conn, session.id)
  restart(st, NO_DELIVERY)
  expect(internals(st).armed.has(w.id)).toBe(false)
  expect(repo.getWatch(st.conn, w.id)).toMatchObject({ status: 'cancelled', ended_reason: 'the session was deleted' })
}, 30_000)

test('a repeating timer keeps to its cooldown_s: no report before the cooldown has passed, one after', async () => {
  const { st, session } = await setup(NO_DELIVERY)
  const t0 = Date.now()
  setSystemTime(new Date(t0))
  const w = register(st, session.id, { kind: 'timer', delay_s: 60, repeat: true, cooldown_s: 600, max_fires: 5 })
  expect(w.cooldown_s).toBe(600)
  setSystemTime(new Date(t0 + 61_000))
  internals(st).timers()
  expect(eventsOf(st, w.id)).toHaveLength(1)
  setSystemTime(new Date(t0 + 122_000))
  internals(st).timers()
  setSystemTime(new Date(t0 + 183_000))
  internals(st).timers()
  expect(eventsOf(st, w.id)).toHaveLength(1)
  setSystemTime(new Date(t0 + 662_000))
  internals(st).timers()
  expect(eventsOf(st, w.id)).toHaveLength(2)
}, 30_000)


test('a line longer than the read limit: its tail is skipped up to the line\'s end, never read as a line of its own; the next line is read', async () => {
  const { st, session, ws, project } = await setup(NO_DELIVERY)
  const x = await command(st, ws, project.id, 'sleep 30')
  const w = register(st, session.id, { kind: 'match', execution_id: x.id, pattern: '^ERROR', repeat: true, cooldown_s: 60 })
  // one line: 20000 x, then "ERROR tail" in later chunks — the line does not start with ERROR
  feed(st, x.id, 'x'.repeat(20_000))
  feed(st, x.id, 'ERROR tail')
  feed(st, x.id, ' still the same line\n')
  expect(eventsOf(st, w.id)).toHaveLength(0)
  feed(st, x.id, 'ERROR a line of its own\n')
  expect(eventsOf(st, w.id).map((e) => e.detail).join('\n')).toContain('ERROR a line of its own')
  expect(eventsOf(st, w.id)).toHaveLength(1)
}, 30_000)
