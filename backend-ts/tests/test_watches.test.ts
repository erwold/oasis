/** The watches end to end: an agent of the session's own conversation sets what it wants to be woken for and ends
 *  its turn; the harness reads the command's output (past the log's cap too), sees it end, keeps the timers, and
 *  starts the conversation's next turn with what fired — once the conversation is free, as the harness's message.
 *  A restart reports the timer it missed and the command it lost; the person cancels a watch over the API. */

import { afterEach, expect, test } from 'bun:test'
import type { Run } from '@oasis-code/contract'
import * as repo from '../src/db/repo.ts'
import { watchTool } from '../src/agent/tools/watches.ts'
import { makeDeps } from '../src/agent/deps.ts'
import { lastToolReturn, loadJson, modelResponse, textPart, toolCallPart, type ModelMessage } from '../src/llm/messages.ts'
import { nowIso } from '../src/timebase.ts'
import { appState, buggyRepo, closeState, FAKE_FULL, openSession, PassthroughRuntime, scriptedModel, setModel, sleep, waitDone, type AppState } from './harness.ts'
import { Client, json, makeApp } from './api_harness.ts'
import type { App } from '../src/main.ts'

let state: AppState | null = null
let app: App | null = null
afterEach(async () => {
  if (state) await closeState(state)
  state = null
  if (app) await app.close()
  app = null
})

const FAST = { debounce_ms: 50, tick_ms: 100 }

/** What the last call of a tool returned (nothing yet: an empty record). */
const returned = (messages: ModelMessage[], tool: string): Record<string, unknown> => {
  const out = lastToolReturn(messages, tool)
  return out && typeof out === 'object' ? (out as Record<string, unknown>) : {}
}

/** The text of the latest request's user parts (what the model is answering). */
function lastUserText(messages: ModelMessage[]): string {
  const last = messages[messages.length - 1]
  if (!last || last.kind !== 'request') return ''
  return last.parts.filter((p) => p.part_kind === 'user-prompt').map((p) => (Array.isArray(p.content) ? p.content.filter((c) => typeof c === 'string').join('\n') : String(p.content))).join('\n')
}

async function until<T>(what: string, read: () => T | null | undefined | false, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(50)
  }
}

const wakeRuns = (st: AppState, sessionId: string): Run[] => repo.listRuns(st.conn, sessionId).filter((r) => r.spawned_by === 'wake')

test('a training watched: the step crossing a line and a NaN loss wake the conversation once it is free, in one message from the app', async () => {
  state = await appState({ sandbox: true, watches: FAST })
  const st = state
  const training = `for i in 1 2 3 4; do echo "{\\"step\\": $((i*40)), \\"loss\\": 0.5}"; sleep 0.2; done; echo '{"step": 200, "loss": NaN}'; sleep 4`
  let wokenWith = ''
  setModel(st, 'scripted:a', scriptedModel((messages) => {
    const said = lastUserText(messages)
    if (said.includes('oasis-code started this turn')) { wokenWith = said; return modelResponse([textPart('the loss went NaN at step 200: stopping')]) }
    const bash = returned(messages, 'bash')
    const watches = messages.flatMap((m) => (m.kind === 'response' ? m.parts : [])).filter((p) => p.part_kind === 'tool-call' && p.tool_name === 'watch').length
    if (!bash.execution_id) return modelResponse([toolCallPart('bash', { command: training, wait_s: 1 }, 'c1')])
    if (watches === 0) return modelResponse([toolCallPart('watch', { kind: 'metric', execution_id: bash.execution_id, field: 'step', op: '>=', value: 100, note: 'run the eval at step 100' }, 'c2')])
    if (watches === 1) return modelResponse([toolCallPart('watch', { kind: 'metric', execution_id: bash.execution_id, field: 'loss', op: 'nonfinite', note: 'stop the run and lower the learning rate' }, 'c3')])
    return modelResponse([textPart('watching the training')])
  }))
  const { session } = await openSession(st, buggyRepo())
  const first = await st.runs.start(session, 'train the model and keep an eye on it')
  const done = await waitDone(st, first.id)
  expect(done.status, String(done.error)).toBe('done')
  const set = repo.listWatches(st.conn, session.id)
  expect(set.map((w) => w.summary).sort()).toEqual([`loss not finite (NaN or infinite) in ${set[0]!.spec.execution_id}`, `step >= 100 in ${set[0]!.spec.execution_id}`].sort())
  // both conditions were met while the first run still ran (step 120, then NaN): nothing started beside it
  const woken = await until('the wake run', () => wakeRuns(st, session.id)[0])
  expect(wakeRuns(st, session.id)).toHaveLength(1)
  expect(new Date(woken.created_at).getTime()).toBeGreaterThanOrEqual(new Date(done.finished_at!).getTime())
  const finished = await waitDone(st, woken.id)
  expect(finished.status).toBe('done')
  expect(finished.resumes_run_id).toBe(first.id)                                   // the conversation goes on
  expect(wokenWith).toContain('2 watch event(s)')
  expect(wokenWith).toContain('step = 120')
  expect(wokenWith).toContain('loss = NaN')
  expect(wokenWith).toContain('Your note: run the eval at step 100')
  expect(wokenWith).toContain('not from the user')
  // the message is the app's, every part of it
  const history = loadJson(repo.getRunHistory(st.conn, finished.id)!)
  const opening = history.find((m) => m.kind === 'request' && m.parts.some((p) => p.part_kind === 'user-prompt' && lastUserText([m]).includes('oasis-code started this turn')))!
  for (const part of opening.parts.filter((p) => p.part_kind === 'user-prompt')) expect((part as { origin?: string }).origin).toBe('app')
  const events = repo.listWakeEvents(st.conn, session.id)
  expect(events.map((e) => [e.kind, e.status, e.run_id])).toEqual([['fired', 'delivered', woken.id], ['fired', 'delivered', woken.id]])
  expect(repo.listWatches(st.conn, session.id).map((w) => [w.status, w.fires])).toEqual([['done', 1], ['done', 1]])
  // the woken run is of the thread: the next message of the person continues from it
  expect(repo.latestRunOfSession(st.conn, session.id)!.id).toBe(woken.id)
}, 30_000)                                                                            // a 4 s command and two runs: past bun's 5 s default

test("the output past the log's cap is still read; a watch that never reports ends with its command and says how it ended", async () => {
  state = await appState({ sandbox: true, watches: FAST })
  const st = state
  st.config.command_output_cap_bytes = 2000
  const noisy = `head -c 30000 /dev/zero | tr '\\0' 'a'; echo; sleep 1.5; echo "FATAL: diverged at step 7"; sleep 0.3; exit 3`
  const woken: string[] = []
  setModel(st, 'scripted:a', scriptedModel((messages) => {
    const said = lastUserText(messages)
    if (said.includes('oasis-code started this turn')) { woken.push(said); return modelResponse([textPart('seen')]) }
    const bash = returned(messages, 'bash')
    const calls = messages.flatMap((m) => (m.kind === 'response' ? m.parts : [])).filter((p) => p.part_kind === 'tool-call' && p.tool_name === 'watch').length
    if (!bash.execution_id) return modelResponse([toolCallPart('bash', { command: noisy, wait_s: 1 }, 'c1')])
    if (calls === 0) return modelResponse([toolCallPart('watch', { kind: 'match', execution_id: bash.execution_id, pattern: 'FATAL', note: 'read the error' }, 'c2')])
    if (calls === 1) return modelResponse([toolCallPart('watch', { kind: 'match', execution_id: bash.execution_id, pattern: 'NEVER PRINTED', note: 'unused' }, 'c3')])
    return modelResponse([textPart('waiting')])
  }))
  const { session } = await openSession(st, buggyRepo())
  const first = await st.runs.start(session, 'run it')
  await waitDone(st, first.id)
  // the line comes after the first run ended (a wake at once), the end a moment later (another, once the first is done)
  await until('both events delivered', () => { const e = repo.listWakeEvents(st.conn, session.id); return e.length === 2 && e.every((x) => x.status === 'delivered') })
  for (const run of wakeRuns(st, session.id)) await waitDone(st, run.id)
  const said = woken.join('\n')
  const xid = repo.listWatches(st.conn, session.id)[0]!.spec.execution_id!
  const execution = repo.getExecution(st.conn, xid)!
  expect(execution.truncated).toBe(true)                                           // the log kept 2000 bytes …
  expect(execution.stdout_bytes).toBe(2000)
  expect(said).toContain('FATAL: diverged at step 7')                              // … the watch read the line after them
  expect(said).toContain(`${xid} ended (failed, exit code 3) before the watch reported`)
  expect(repo.listWakeEvents(st.conn, session.id).map((e) => e.kind).sort()).toEqual(['ended', 'fired'])
})

test('a watch is refused in a UI task\'s run, on a command of another session, on a command that ended; exit on an ended command reports at once', async () => {
  state = await appState({ sandbox: true, watches: FAST })
  const st = state
  const { session, project, ws } = await openSession(st, buggyRepo())
  const other = await openSession(st, buggyRepo())
  const base = { conn: st.conn, store: st.store, config: st.config, project, session, workspace: ws, run_id: 'run_x', model_cfg: null as never, workspaces: st.workspaces, processes: st.processes, gate: st.gate, policy: null as never, emit: () => {} }
  const ctx = (own: boolean) => ({ deps: makeDeps({ ...base, watchable: own, watches: st.watches }), tool_call_id: 't', tool_name: 'watch', retry: 0, messages: [] })
  const notHere = await watchTool(ctx(false), { kind: 'timer', delay_s: 60, note: 'x' })
  expect(notHere).toMatchObject({ status: 'refused', reason: "a UI task's run takes no watches" })
  // a command of another session, however its id was learnt
  const theirs = repo.insertExecution(st.conn, { run_id: null, workspace_id: other.ws.id, tool_call_id: null, kind: 'command', command: 'sleep 1', cwd: '/', isolation: {}, network: false })
  expect(await watchTool(ctx(true), { kind: 'exit', execution_id: theirs.id, note: 'x' })).toMatchObject({ status: 'refused', reason: `unknown command ${theirs.id}` })
  // one of this session's that ended: a match is refused, an exit reports at once
  const mine = repo.insertExecution(st.conn, { run_id: null, workspace_id: ws.id, tool_call_id: null, kind: 'command', command: 'true', cwd: '/', isolation: {}, network: false })
  repo.finishExecution(st.conn, mine.id, { status: 'succeeded', exit_code: 0, timed_out: false, cancelled: false, truncated: false, stdout_asset_id: null, stderr_asset_id: null, stdout_bytes: 0, stderr_bytes: 0, duration_ms: 5 })
  const late = await watchTool(ctx(true), { kind: 'match', execution_id: mine.id, pattern: 'x', note: 'x' })
  expect(late.status).toBe('refused')
  expect(String(late.reason)).toContain('has already ended (succeeded, exit code 0)')
  const exit = await watchTool(ctx(true), { kind: 'exit', execution_id: mine.id, note: 'look at the result' })
  expect(exit.status).toBe('ok')
  expect(String(exit.message)).toContain('End your turn now')
  const [event] = repo.listWakeEvents(st.conn, session.id)
  expect(event!.kind).toBe('fired')
  expect(event!.detail).toContain(`${mine.id} ended (succeeded, exit code 0)`)
  // the limit on watches waiting at once; each answer lists the ones still waiting
  let last: Record<string, unknown> = {}
  for (let i = 0; i < 20; i += 1) {
    last = await watchTool(ctx(true), { kind: 'timer', delay_s: 600 + i, note: `t${i}` })
    expect(last.status).toBe('ok')
  }
  expect((last.waiting as unknown[]).length).toBe(20)
  const over = await watchTool(ctx(true), { kind: 'timer', delay_s: 900, note: 'one too many' })
  expect(String(over.reason)).toContain('the limit is 20')
  // the same tool ends one: cancel, never both at once; one of another session is unknown
  const first = (last.waiting as { watch_id: string; note: string }[])[0]!
  expect(first.note).toBe('t0')                                                    // oldest first
  expect(await watchTool(ctx(true), { kind: 'timer', delay_s: 60, note: 'x', cancel: first.watch_id })).toMatchObject({ status: 'refused', reason: 'give kind to set a watch or cancel to end one, not both' })
  const cancelled = await watchTool(ctx(true), { cancel: first.watch_id })
  expect(cancelled).toMatchObject({ status: 'ok', cancelled: first.watch_id })
  expect((cancelled.waiting as unknown[]).length).toBe(19)
  expect(repo.getWatch(st.conn, first.watch_id)).toMatchObject({ status: 'cancelled', ended_reason: 'cancelled by the agent' })
  expect(await watchTool(ctx(true), { cancel: first.watch_id })).toMatchObject({ status: 'not_waiting', ended: 'cancelled by the agent' })
  expect(await watchTool(ctx(true), {})).toMatchObject({ status: 'refused', reason: 'kind is required to set a watch (or cancel to end one)' })
  const theirWatch = repo.insertWatch(st.conn, { session_id: other.session.id, run_id: 'run_y', spec: { kind: 'timer', execution_id: null, at: nowIso(), every_s: null, pattern: null, field: null, op: null, value: null, stream: 'both', silence_s: null }, note: 'n', summary: 's', repeat: false, cooldown_s: 0, max_fires: 1, expires_at: nowIso() })
  expect(await watchTool(ctx(true), { cancel: theirWatch.id })).toMatchObject({ status: 'refused', reason: `unknown watch ${theirWatch.id}` })
})

test('a restart: a timer due while nothing ran reports late, a watch on a lost command says so; the hourly limit holds the next wake', async () => {
  state = await appState({ sandbox: true, watches: { ...FAST, wakes_per_hour: 1 } })
  const st = state
  let wokenWith: string[] = []
  setModel(st, 'scripted:a', scriptedModel((messages) => { wokenWith.push(lastUserText(messages)); return modelResponse([textPart('ok')]) }))
  const { session, ws } = await openSession(st, buggyRepo())
  const past = new Date(Date.now() - 10 * 60_000).toISOString()
  const week = new Date(Date.now() + 7 * 86_400_000).toISOString()
  const spec = { at: null, every_s: null, pattern: null, field: null, op: null, value: null, stream: 'both' as const, silence_s: null }
  repo.insertWatch(st.conn, { session_id: session.id, run_id: 'run_prev', spec: { ...spec, kind: 'timer', execution_id: null, at: past }, note: 'check the loss curve', summary: `at ${past}`, repeat: false, cooldown_s: 0, max_fires: 1, expires_at: week })
  const lost = repo.insertExecution(st.conn, { run_id: null, workspace_id: ws.id, tool_call_id: null, kind: 'command', command: 'python train.py', cwd: '/', isolation: {}, network: false })
  repo.startExecution(st.conn, lost.id)
  repo.markLostExecutions(st.conn)
  repo.insertWatch(st.conn, { session_id: session.id, run_id: 'run_prev', spec: { ...spec, kind: 'match', execution_id: lost.id, pattern: 'Traceback' }, note: 'debug it', summary: 'a line matching /Traceback/', repeat: false, cooldown_s: 0, max_fires: 1, expires_at: week })
  const counts = st.watches.start()
  expect(counts).toMatchObject({ lost: 1, armed: 1 })
  const woken = await until('the wake run', () => wakeRuns(st, session.id)[0])
  await waitDone(st, woken.id)
  const said = wokenWith.join('\n')
  expect(said).toContain(`it was due at ${past}, while oasis-code was not running`)
  expect(said).toContain(`${lost.id} was stopped when oasis-code quit or restarted`)
  expect(said).toContain('Your note: debug it')
  // another event within the hour waits: the limit allows one wake an hour here
  const again = repo.insertWatch(st.conn, { session_id: session.id, run_id: woken.id, spec: { ...spec, kind: 'timer', execution_id: null, at: nowIso() }, note: 'later', summary: 'now', repeat: false, cooldown_s: 0, max_fires: 1, expires_at: week })
  st.watches.close()
  wokenWith = []
  const { WatchService } = await import('../src/agent/watches/service.ts')
  st.watches = new WatchService(st, { ...FAST, wakes_per_hour: 1 })
  st.watches.attachHooks()
  st.watches.start()
  await until('the event recorded', () => repo.listWakeEvents(st.conn, session.id).find((e) => e.watch_id === again.id))
  await sleep(500)
  expect(wakeRuns(st, session.id)).toHaveLength(1)
  expect(repo.listPendingWakeEvents(st.conn, session.id)).toHaveLength(1)
})

test('the person sees the watches in the session and cancels one over the API; it wakes no one after', async () => {
  app = await makeApp(null, { watches: FAST })
  const c = new Client(app)
  const st = app.state
  const { session } = await openSession(st, buggyRepo())
  const week = new Date(Date.now() + 7 * 86_400_000).toISOString()
  const at = new Date(Date.now() + 3_600_000).toISOString()
  const w = repo.insertWatch(st.conn, { session_id: session.id, run_id: 'run_prev', spec: { kind: 'timer', execution_id: null, at, every_s: null, pattern: null, field: null, op: null, value: null, stream: 'both', silence_s: null }, note: 'n', summary: `at ${at}`, repeat: false, cooldown_s: 0, max_fires: 1, expires_at: week })
  const detail = await json<{ watches: { id: string; status: string }[] }>(await c.get(`/api/sessions/${session.id}`))
  expect(detail.watches.map((x) => [x.id, x.status])).toEqual([[w.id, 'active']])
  const out = await json<{ cancelled: boolean; watch: { status: string; ended_reason: string } }>(await c.post(`/api/watches/${w.id}/cancel`))
  expect(out).toMatchObject({ cancelled: true, watch: { status: 'cancelled', ended_reason: 'cancelled by the user' } })
  expect((await json<{ cancelled: boolean }>(await c.post(`/api/watches/${w.id}/cancel`))).cancelled).toBe(false)
  await json(await c.post('/api/watches/w_nothing/cancel'), 404)
})

/** An app whose commands run (the passthrough runtime under a full report), its watches quick. */
const SANDBOXED = { watches: FAST, runtime: new PassthroughRuntime(), isolation: { ...FAKE_FULL, runtime: 'passthrough' } }

/** A model that starts a command, watches for its end and ends its turn; woken, it says what it read. */
const watcher = (woken: string[]) => scriptedModel((messages) => {
  const said = lastUserText(messages)
  if (said.includes('oasis-code started this turn')) { woken.push(said); return modelResponse([textPart('woken: the command finished')]) }
  const bash = returned(messages, 'bash')
  if (!Object.keys(bash).length) return modelResponse([toolCallPart('bash', { command: 'sleep 2.5; echo finished', wait_s: 1 }, 'c1')])
  if (!bash.execution_id) return modelResponse([textPart(`no command: ${JSON.stringify(bash)}`)])
  if (!Object.keys(returned(messages, 'watch')).length) return modelResponse([toolCallPart('watch', { kind: 'exit', execution_id: bash.execution_id, note: 'read what it printed' }, 'c2')])
  return modelResponse([textPart('watching it')])
})

/** The opening request of a run: every part of it the app's (no words of the person). */
function openedByTheApp(st: AppState, runId: string): void {
  const history = loadJson(repo.getRunHistory(st.conn, runId)!)
  const opening = history.find((m) => m.kind === 'request' && lastUserText([m]).includes('oasis-code started this turn'))!
  for (const part of opening.parts.filter((p) => p.part_kind === 'user-prompt')) expect((part as { origin?: string }).origin).toBe('app')
}

test("a group member that ends its run with a watch set leaves its step waiting on it; the report goes on in that step, whose answer is the one after it", async () => {
  app = await makeApp(null, SANDBOXED)
  const st = app.state
  const c = new Client(app)
  const woken: string[] = []
  setModel(st, 'scripted:a', watcher(woken))
  const handed: string[] = []
  setModel(st, 'scripted:b', scriptedModel((messages) => { handed.push(lastUserText(messages)); return modelResponse([textPart('B answer')]) }))
  const { session } = await openSession(st, buggyRepo())
  const ix = await json<{ id: string }>(await c.post(`/api/sessions/${session.id}/interactions`, {
    text: 'run it, then B reads A', participants: [{ model: 'scripted:a', id: 'pt_aaaaaa' }, { model: 'scripted:b', id: 'pt_bbbbbb' }],
    plan: { nodes: [{ id: 'a1', participant: 'pt_aaaaaa' }, { id: 'b1', participant: 'pt_bbbbbb', depends_on: ['a1'], receives: ['a1'] }], then: 'stop' },
  }))
  const watching = await until("A's step waiting on its watch", () => repo.listNodes(st.conn, ix.id).find((n) => n.id === 'a1' && n.status === 'watching'))
  const first = watching.run_id!
  expect(repo.getRun(st.conn, first)!.status).toBe('done')
  expect(repo.listNodes(st.conn, ix.id).find((n) => n.id === 'b1')!.status).toBe('queued')   // what comes after it waits
  expect(repo.getInteraction(st.conn, ix.id)!.status).toBe('running')
  const woke = await until('the wake run done', () => { const r = wakeRuns(st, session.id)[0]; return r && !['queued', 'running'].includes(r.status) ? r : null })
  expect(woke.status, String(woke.error)).toBe('done')
  expect([woke.interaction_id, woke.interaction_node, woke.resumes_run_id]).toEqual([ix.id, 'a1', first])   // the same step goes on
  expect(woken.join('\n')).toContain('Your note: read what it printed')
  expect(woken.join('\n')).toContain('finished')
  openedByTheApp(st, woke.id)
  const done = await until('the interaction done', () => { const i = repo.getInteraction(st.conn, ix.id)!; return i.status === 'done' ? i : null })
  const nodes = repo.listNodes(st.conn, ix.id)
  expect(nodes.map((n) => [n.id, n.kind, n.status])).toEqual([['a1', 'plan', 'done'], ['b1', 'plan', 'done']])   // no follow-up step
  expect(nodes[0]!.run_ids).toEqual([first, woke.id])
  expect(handed.join('\n')).toContain('woken: the command finished')                // B was handed the answer after the report …
  expect(handed.join('\n')).not.toContain('watching it')                            // … not the run that only set the watch
  expect(done.runs_started).toBe(2)                                                  // the step's second run is not counted
  expect(repo.listWakeEvents(st.conn, session.id).map((e) => [e.status, e.run_id])).toEqual([['delivered', woke.id]])
  expect(repo.listRuns(st.conn, session.id).filter((r) => r.interaction_id === null)).toEqual([])  // nothing started in the thread
}, 30_000)

/** A member that sets an hour's timer and ends its run. */
const sleeper = scriptedModel((messages) => {
  if (!Object.keys(returned(messages, 'watch')).length) return modelResponse([toolCallPart('watch', { kind: 'timer', delay_s: 3600, note: 'look again' }, 'w1')])
  return modelResponse([textPart('back in an hour')])
})

test("a step waiting on its watch: the watch cancelled, the step is done with the answer it gave; the interaction stopped, the step is cancelled and its watch withdrawn", async () => {
  app = await makeApp(null, SANDBOXED)
  const st = app.state
  const c = new Client(app)
  setModel(st, 'scripted:a', sleeper)
  setModel(st, 'scripted:b', scriptedModel(() => modelResponse([textPart('B answer')])))
  const { session } = await openSession(st, buggyRepo())
  const open = async (text: string) => json<{ id: string }>(await c.post(`/api/sessions/${session.id}/interactions`, { text, participants: [{ model: 'scripted:a', id: 'pt_aaaaaa' }, { model: 'scripted:b', id: 'pt_bbbbbb' }], plan: { template: 'independent' } }))
  const one = await open('first')
  const step = await until('the step waiting on its watch', () => repo.listNodes(st.conn, one.id).find((n) => n.status === 'watching'))
  const watch = repo.listWatches(st.conn, session.id).find((w) => w.run_id === step.run_id)!
  expect((await json<{ cancelled: boolean }>(await c.post(`/api/watches/${watch.id}/cancel`))).cancelled).toBe(true)
  await until('the interaction done', () => repo.getInteraction(st.conn, one.id)!.status === 'done')
  expect(repo.getNode(st.conn, one.id, step.id)!.status).toBe('done')
  const two = await open('second')
  const next = await until('the step waiting on its watch', () => repo.listNodes(st.conn, two.id).find((n) => n.status === 'watching'))
  await json(await c.post(`/api/interactions/${two.id}/cancel`))
  expect(repo.getInteraction(st.conn, two.id)!.status).toBe('cancelled')
  expect(repo.getNode(st.conn, two.id, next.id)!.status).toBe('cancelled')
  expect(repo.listWatches(st.conn, session.id).find((w) => w.run_id === next.run_id)!.status).toBe('cancelled')
  expect(wakeRuns(st, session.id)).toEqual([])
}, 30_000)

test("a step waiting on its watch keeps its place: with one at a time, the next step waits; words sent to it go on in that step", async () => {
  app = await makeApp(null, SANDBOXED)
  const st = app.state
  const c = new Client(app)
  setModel(st, 'scripted:a', sleeper)
  setModel(st, 'scripted:b', scriptedModel(() => modelResponse([textPart('B answer')])))
  const { session } = await openSession(st, buggyRepo())
  const ix = await json<{ id: string }>(await c.post(`/api/sessions/${session.id}/interactions`, {
    text: 'each alone', participants: [{ model: 'scripted:a', id: 'pt_aaaaaa' }, { model: 'scripted:b', id: 'pt_bbbbbb' }], plan: { template: 'independent' }, concurrency: 1,
  }))
  const step = await until('the step waiting on its watch', () => repo.listNodes(st.conn, ix.id).find((n) => n.participant === 'pt_aaaaaa' && n.status === 'watching'))
  await sleep(300)
  expect(repo.listNodes(st.conn, ix.id).find((n) => n.participant === 'pt_bbbbbb')!.status).toBe('queued')
  setModel(st, 'scripted:a', scriptedModel(() => modelResponse([textPart('the answer now')])))
  const out = await json<{ id: string }>(await c.post(`/api/runs/${step.run_id}/resume`, { text: 'give the answer now' }))
  const resumed = repo.getRun(st.conn, out.id)!
  expect([resumed.interaction_node, resumed.resumes_run_id]).toEqual([step.id, step.run_id])
  // the run answered, and the hour's timer is still set: the step waits on it again, its place kept
  await until('the step waiting again', () => repo.getNode(st.conn, ix.id, step.id)!.status === 'watching' && repo.getNode(st.conn, ix.id, step.id)!.run_id === out.id)
  await sleep(300)
  expect(repo.listNodes(st.conn, ix.id).find((n) => n.participant === 'pt_bbbbbb')!.status).toBe('queued')
  const watch = repo.listWatches(st.conn, session.id)[0]!
  expect((await json<{ cancelled: boolean }>(await c.post(`/api/watches/${watch.id}/cancel`))).cancelled).toBe(true)
  await until('the interaction done', () => repo.getInteraction(st.conn, ix.id)!.status === 'done')
  expect(repo.listNodes(st.conn, ix.id).map((n) => [n.participant, n.kind, n.status])).toEqual([['pt_aaaaaa', 'plan', 'done'], ['pt_bbbbbb', 'plan', 'done']])
  expect(repo.getNode(st.conn, ix.id, step.id)!.run_ids).toEqual([step.run_id!, out.id])
}, 30_000)

test("a separate task's watch wakes the task's own conversation under its order; its watches are its own", async () => {
  app = await makeApp(null, SANDBOXED)
  const st = app.state
  const c = new Client(app)
  const woken: string[] = []
  setModel(st, 'scripted:a', watcher(woken))
  const { session } = await openSession(st, buggyRepo())
  const task = await json<{ id: string }>(await c.post(`/api/sessions/${session.id}/work-orders`, { work_order: { prompt: 'run it and read the result', model: 'scripted:a' } }))
  const woke = await until('the wake run done', () => { const r = wakeRuns(st, session.id)[0]; return r && !['queued', 'running'].includes(r.status) ? r : null })
  expect(woke.status, String(woke.error)).toBe('done')
  expect(woke.resumes_run_id).toBe(task.id)
  expect(woke.work_order).not.toBeNull()                                            // the task's order goes on
  expect(woken.join('\n')).toContain('finished')
  openedByTheApp(st, woke.id)
  // the thread's agent neither lists the task's watch nor cancels it
  const thread = await st.runs.start(session, 'hello')
  await waitDone(st, thread.id)
  const watchId = repo.listWatches(st.conn, session.id).find((w) => w.run_id === task.id)!.id
  const base = { conn: st.conn, store: st.store, config: st.config, project: repo.getProject(st.conn, session.project_id)!, session, workspace: repo.getWorkspace(st.conn, session.workspace_id!)!, model_cfg: null as never, workspaces: st.workspaces, processes: st.processes, gate: st.gate, policy: null as never, emit: () => {} }
  const as = (runId: string) => ({ deps: makeDeps({ ...base, run_id: runId, watchable: true, watches: st.watches }), tool_call_id: 't', tool_name: 'watch', retry: 0, messages: [] })
  expect(await watchTool(as(thread.id), { cancel: watchId })).toMatchObject({ status: 'refused', reason: `unknown watch ${watchId}` })
  expect(await watchTool(as(woke.id), { cancel: watchId })).toMatchObject({ status: 'not_waiting', cancelled: watchId })
}, 30_000)
