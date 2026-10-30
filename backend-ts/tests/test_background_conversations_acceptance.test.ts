/** Background commands and the conversation that started them, end to end over the API with scripted models and
 *  real local commands (gated by files, never by long sleeps):
 *   - a later run of the SAME conversation starts beside the command its earlier run left running — even past an
 *     outsider already queued on the same real folder (a second direct project on an alias of it); the outsider, a
 *     separate task, a connector's writer and a fresh conversation stay out until every writer is gone; stopping the
 *     later run never stops the inherited command;
 *   - in place, the overlapped run's receipt and diff are its safe journal writes only (attribution partial, the
 *     background execution named, a chain-broken path unattributed, the command's own file never claimed), and its
 *     whole-run undo is refused (attribution_unavailable) during the overlap and after the command ended, touching
 *     no file; a later quiescent run's undo works as before;
 *   - in a snapshot workspace the overlapped run claims nothing (attribution unavailable, no checkpoint, its run diff
 *     409), sticky though the command ended mid-run; the next quiescent run measures from the tree as it found it,
 *     after an unattributed state checkpoint (run_id null);
 *   - a watch that fires while the later run works waits in the persisted queue and wakes the conversation once,
 *     after that run — never steered into it;
 *   - a local restart stops the command and frees the folder; a fresh conversation was queued behind it before.
 *  Only frozen public fields are read (contract/src: SessionDetail.background_commands, the receipt diff's
 *  attribution fields, the run diff answer, the undo answer, the run row and its events). */

import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BackgroundCommand, Checkpoint, Run, RunDiffResponse, SessionDetail, UndoResult } from '@oasis-code/contract'
import type { Settings } from '../src/config.ts'
import * as repo from '../src/db/repo.ts'
import { isUserPrompt, lastToolReturn, modelResponse, textPart, toolCallPart, type ModelMessage, type ModelResponse } from '../src/llm/messages.ts'
import type { App } from '../src/main.ts'
import { Client, json, makeApp } from './api_harness.ts'
import { buggyRepo, FAKE_FULL, PassthroughRuntime, scriptedModel, setModel, sleep, testSettings, waitDone } from './harness.ts'
import { tempDir } from './helpers.ts'

const MODEL = 'scripted:a'
const FAST_WATCHES = { debounce_ms: 50, tick_ms: 100 }
/** Commands run as they are (the passthrough runtime under a full report): these tests are of the conversation and
 *  the folder's writers, not of the OS confinement. */
const OPTIONS = { probe: false, watches: FAST_WATCHES, runtime: new PassthroughRuntime(), isolation: { ...FAKE_FULL, runtime: 'passthrough' } }
const WAKE_OPENING = 'oasis-code started this turn'

type Rec = Record<string, unknown>
const rec = (v: unknown) => (v ?? {}) as Rec

// ---- cleanup: every app closed, every run stopped, every gate opened, every hold released — assertions or not ----

const apps: App[] = []
const releases: (() => void)[] = []
const gateDirs: { dir: string; names: Set<string> }[] = []

afterEach(async () => {
  // gates first: a command waiting on one exits on its own (each loop is also bounded)
  for (const g of gateDirs.splice(0)) for (const name of g.names) { try { writeFileSync(join(g.dir, name), '') } catch { /* gone */ } }
  for (const release of releases.splice(0)) release()
  for (const app of apps.splice(0).reverse()) {
    try {
      for (const [id, handle] of app.state.runs.handles) if (!handle.done) app.state.runs.cancel(id)
      for (const handle of app.state.runs.handles.values()) if (!handle.done) await Promise.race([handle.task, sleep(5000)]).catch(() => {})
    } catch { /* closing anyway */ }
    try { await app.close() } catch { /* closed already */ }
  }
})

async function open(settings: Settings | null = null): Promise<{ app: App; c: Client }> {
  const app = await makeApp(settings, OPTIONS)
  apps.push(app)
  return { app, c: new Client(app) }
}

/** Closes one app now (a restart): it is no longer closed again after the test. */
async function closeNow(app: App): Promise<void> {
  const i = apps.indexOf(app)
  if (i >= 0) apps.splice(i, 1)
  await app.close()
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  releases.push(resolve)
  return { promise, resolve }
}

/** Files outside every workspace a command waits on: `wait(name)` is the shell that waits (bounded: a minute at most,
 *  so nothing outlives a broken test for long), `open(name)` lets it go. */
function gates() {
  const dir = tempDir('oasis-bg-gates-')
  const names = new Set<string>()
  gateDirs.push({ dir, names })
  const path = (name: string) => { names.add(name); return join(dir, name) }
  return {
    path,
    wait: (name: string) => `i=0; while [ ! -f '${path(name)}' ] && [ $i -lt 1200 ]; do sleep 0.05; i=$((i+1)); done`,
    mark: (name: string) => `: > '${join(dir, name)}'`,
    open: (name: string) => writeFileSync(path(name), ''),
    exists: (name: string) => existsSync(join(dir, name)),
  }
}

async function until<T>(what: string, read: () => T | null | undefined | false | Promise<T | null | undefined | false>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const value = await read()
    if (value) return value
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(25)
  }
}

function within<T>(p: Promise<T>, what: string, ms = 20_000): Promise<T> {
  return Promise.race([p, sleep(ms).then(() => { throw new Error(`timed out waiting for ${what}`) })])
}

// ---- a scripted model that plays each run's own steps, by the marker in that run's opening message --------------

type Step = (messages: ModelMessage[]) => ModelResponse | Promise<ModelResponse>
const say = (text: string) => modelResponse([textPart(text)])

function promptText(m: ModelMessage): string {
  if (m.kind !== 'request') return ''
  return m.parts.filter(isUserPrompt).map((p) => (Array.isArray(p.content) ? p.content.filter((c) => typeof c === 'string').join('\n') : String(p.content))).join('\n')
}

/** `TURN:<key>` in a run's message picks its steps; the n-th model call of the run plays the n-th step (counted from
 *  that message on: the conversation's earlier turns are history). The harness's own wake message plays `wake`. */
function router(turns: Record<string, Step[]>, wake?: Step) {
  return scriptedModel(async (messages) => {
    let at = -1
    let key: string | null = null
    for (let i = messages.length - 1; i >= 0 && key === null; i -= 1) {
      const text = promptText(messages[i]!)
      if (!text) continue
      if (text.includes(WAKE_OPENING)) { at = i; key = '__wake' } else {
        const m = /TURN:(\w+)/.exec(text)
        if (m) { at = i; key = m[1]! }
      }
    }
    if (key === '__wake') return wake ? wake(messages) : say('woken')
    const n = messages.slice(at + 1).filter((m) => m.kind === 'response').length
    const step = key === null ? undefined : turns[key]?.[n]
    return step ? step(messages) : say(`turn ${key ?? '?'} ends`)
  })
}

// ---- reading the app's public answers ---------------------------------------------------------------------------

const events = (app: App, runId: string) => repo.listEvents(app.state.conn, runId).map((e) => e.event)
const getRun = async (c: Client, id: string) => json<Run & Rec>(await c.get(`/api/runs/${id}`))
const sessionDetail = async (c: Client, id: string) => json<SessionDetail>(await c.get(`/api/sessions/${id}`))
const execution = async (c: Client, xid: string) => json<Rec>(await c.get(`/api/executions/${xid}`))
const isLive = async (c: Client, xid: string) => (await execution(c, xid)).running === true
const diffOf = (run: Run) => rec(rec(rec(run.receipt).mechanical).diff)
const producedOf = (run: Run) => rec(rec(run.receipt).produced)
const conversationOf = (run: Rec) => rec(run.collab).conversation_id as string | null | undefined
const participantOf = (run: Rec) => rec(run.collab).participant_id as string | null | undefined
const chat = async (c: Client, sid: string, body: Rec) => json<Run>(await c.post(`/api/sessions/${sid}/chat`, body))

function plainFolder(): string {
  const dir = join(tempDir('oasis-bg-folder-'), 'f')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'README.md'), 'x\n')
  return dir
}

const read = (path: string) => readFileSync(path, 'utf8')

/** R1 of a session: starts `command` with a one second wait, so it is still running as R1 ends. */
const startsInBackground = (command: string): Step[] => [
  () => modelResponse([toolCallPart('bash', { command, wait_s: 1 }, 'bg1')]),
  () => say('left it running'),
]

async function firstRunLeavesItRunning(app: App, c: Client, sid: string, text: string): Promise<{ r1: Run; xid: string }> {
  const r1 = await waitDone(app.state, (await chat(c, sid, { text })).id)
  expect(r1.status, String(r1.error)).toBe('done')
  const xs = repo.listExecutions(app.state.conn, { run_id: r1.id })
  expect(xs).toHaveLength(1)
  const xid = xs[0]!.id
  expect(await isLive(c, xid)).toBe(true)
  return { r1, xid }
}

// ---- 1 ------------------------------------------------------------------------------------------------------------

test('a later run of the same conversation starts beside its own live background command, past an outsider already queued on the same real folder; Stop leaves the command; the outsider starts only when every writer is gone', async () => {
  const folder = plainFolder()
  const alias = join(tempDir('oasis-bg-alias-'), 'alias')
  symlinkSync(folder, alias)
  const { app, c } = await open()
  const pa = await json(await c.post('/api/projects', { source_path: folder, mode: 'direct' }))
  const pb = await json(await c.post('/api/projects', { source_path: alias, mode: 'direct' }))
  const s1 = await json(await c.post(`/api/projects/${pa.id}/sessions`, { title: 'owner' }))
  const s2 = await json(await c.post(`/api/projects/${pb.id}/sessions`, { title: 'outsider' }))
  const wsA = rec(s1.workspace)
  const wsB = rec(s2.workspace)
  expect(wsB.path).toBe(wsA.path)                                                   // one real folder: one writer lane
  const g = gates()
  const r2Entered = deferred()
  const r2Hold = deferred()
  let xid = ''
  let outsiderSawCommandLive: boolean | null = null
  setModel(app.state, MODEL, router({
    r1: startsInBackground(`echo bg-started; ${g.wait('end')}; echo bg-finished`),
    r2: [async () => { r2Entered.resolve(); await r2Hold.promise; return say('r2 done') }],
    out: [() => { outsiderSawCommandLive = app.state.processes.isRunning(xid); return say('outsider done') }],
    order: [() => say('order done')],
  }))

  const first = await firstRunLeavesItRunning(app, c, s1.id as string, 'TURN:r1 start the long job')
  const r1 = first.r1
  xid = first.xid
  const r1Row = await getRun(c, r1.id)
  expect(typeof conversationOf(r1Row)).toBe('string')

  // the outsider (another session, another project on an alias of the folder) is queued behind the command first
  const out = await chat(c, s2.id as string, { text: 'TURN:out write here' })
  expect(out.status).toBe('queued')
  expect((await getRun(c, out.id)).waiting).not.toBeNull()

  // the same conversation's next run is admitted beside its own command, past the outsider already in line
  const r2 = await chat(c, s1.id as string, { text: 'TURN:r2 go on while it runs' })
  expect(r2.status).not.toBe('queued')
  await within(r2Entered.promise, 'R2 reaching its model')
  expect(await isLive(c, xid)).toBe(true)                                           // demonstrably still running
  expect(repo.getExecution(app.state.conn, xid)!.finished_at).toBeNull()
  expect(events(app, r2.id)).toContain('run_started')
  expect(events(app, r2.id)).not.toContain('run_queued')
  const r2Row = await getRun(c, r2.id)
  expect(r2Row.status).toBe('running')
  expect(r2Row.waiting ?? null).toBeNull()
  expect(conversationOf(r2Row)).toBe(conversationOf(r1Row))
  expect(participantOf(r2Row)).toBe(participantOf(r1Row))
  expect((await getRun(c, out.id)).status).toBe('queued')                           // the outsider still waits

  // the session lists the command its ended run left running (who started it, where, which conversation)
  const listed = (await sessionDetail(c, s1.id as string)).background_commands
  expect(listed).toBeDefined()
  expect(listed!.map((b: BackgroundCommand) => b.execution_id)).toEqual([xid])
  expect(listed![0]).toMatchObject({ execution_id: xid, run_id: r1.id, workspace_id: wsA.id as string, status: 'running', conversation_id: conversationOf(r1Row) })
  expect(listed![0]!.command).toContain('bg-finished')

  // every other writer stays out: a separate task of this very session queues, a connector's writer is refused
  const order = await json<Run>(await c.post(`/api/sessions/${s1.id}/work-orders`, { work_order: { prompt: 'TURN:order', model: MODEL, workspace: { base: 'parent' } } }))
  expect(order.status).toBe('queued')
  const refused = await json(await c.post(`/api/workspaces/${wsA.id}/commands`, { command: 'echo connector > connector.txt', wait_s: 5 }), 409)
  expect(refused.code).toBe('workspace_busy')
  expect(existsSync(join(folder, 'connector.txt'))).toBe(false)

  // Stop R2: R2 ends; the command its conversation inherited from R1 is not stopped
  expect((await json(await c.post(`/api/runs/${r2.id}/cancel`))).cancelled).toBe(true)
  r2Hold.resolve()
  expect((await waitDone(app.state, r2.id)).status).toBe('cancelled')
  expect(await isLive(c, xid)).toBe(true)
  expect(repo.getExecution(app.state.conn, xid)!.status).toBe('running')
  expect((await getRun(c, out.id)).status).toBe('queued')                           // the command still writes
  expect((await getRun(c, order.id)).status).toBe('queued')
  expect((await sessionDetail(c, s1.id as string)).background_commands!.map((b) => b.execution_id)).toEqual([xid])
  expect((await json(await c.post(`/api/runs/${order.id}/cancel`))).cancelled).toBe(true)
  expect((await waitDone(app.state, order.id)).status).toBe('cancelled')
  expect(events(app, order.id)).not.toContain('run_started')

  // the command ends: the last writer is gone, the folder goes to the outsider
  g.open('end')
  const outDone = await waitDone(app.state, out.id)
  expect(outDone.status, String(outDone.error)).toBe('done')
  expect(outsiderSawCommandLive as boolean | null).toBe(false)
  expect(events(app, out.id).slice(0, 1)).toEqual(['run_queued'])
  expect(events(app, out.id)).toContain('run_started')
  // the command kept its own run and output
  const x = await execution(c, xid)
  expect(x).toMatchObject({ run_id: r1.id, status: 'succeeded', running: false })
  expect(JSON.stringify(await json(await c.get(`/api/executions/${xid}/output`)))).toContain('bg-finished')
  expect(rec(await getRun(c, r2.id)).executions as Rec[]).toEqual([])
  expect((await sessionDetail(c, s1.id as string)).background_commands ?? []).toEqual([])
  await until('the folder free', async () => (await json(await c.get(`/api/workspaces/${wsA.id}`))).lock_owner === null)
}, 60_000)

// ---- 2 ------------------------------------------------------------------------------------------------------------

test('in place, an overlapped run claims only its safe journal writes (partial, the command named, a chain-broken path unattributed); its undo is refused during the overlap and after the command ended, touching no file; a quiescent run undoes as before', async () => {
  const folder = plainFolder()
  const { app, c } = await open()
  const project = await json(await c.post('/api/projects', { source_path: folder, mode: 'direct' }))
  const s = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'overlap' }))
  const sid = s.id as string
  const wsId = rec(s.workspace).id as string
  const g = gates()
  const r2Paused = deferred()
  const r2Hold = deferred()
  setModel(app.state, MODEL, router({
    // the command waits, then writes a file of its own and one R2 writes too, says so, and waits to end
    r1: startsInBackground(`${g.wait('write')}; printf 'bg\\n' > bg.txt; printf 'bg\\n' > shared.txt; ${g.mark('wrote')}; ${g.wait('end')}; echo bg-exit`),
    r2: [
      () => modelResponse([toolCallPart('write_file', { path: 'shared.txt', content: 'r2 v1\n' }, 'w1')]),
      () => modelResponse([toolCallPart('write_file', { path: 'r2.txt', content: 'r2\n' }, 'w2')]),
      async () => { r2Paused.resolve(); await r2Hold.promise; return modelResponse([toolCallPart('read_file', { path: 'shared.txt' }, 'r1')]) },
      () => modelResponse([toolCallPart('write_file', { path: 'shared.txt', content: 'r2 v2\n' }, 'w3')]),
      () => say('r2 wrote its files'),
    ],
    r3: [
      () => modelResponse([toolCallPart('write_file', { path: 'r3.txt', content: 'r3\n' }, 'w4')]),
      () => say('r3 wrote its file'),
    ],
  }))

  const { r1, xid } = await firstRunLeavesItRunning(app, c, sid, 'TURN:r1 start the generator')
  const r2 = await chat(c, sid, { text: 'TURN:r2 write beside it' })
  expect(r2.status).not.toBe('queued')
  await within(r2Paused.promise, 'R2 between its writes')
  expect(await isLive(c, xid)).toBe(true)
  // the command writes between R2's two writes of shared.txt
  g.open('write')
  await until('the command wrote', () => g.exists('wrote'))
  expect(read(join(folder, 'shared.txt'))).toBe('bg\n')
  r2Hold.resolve()
  const r2Done = await waitDone(app.state, r2.id)
  expect(r2Done.status, String(r2Done.error)).toBe('done')
  const files = () => ({ bg: read(join(folder, 'bg.txt')), shared: read(join(folder, 'shared.txt')), r2: read(join(folder, 'r2.txt')) })
  const after = { bg: 'bg\n', shared: 'r2 v2\n', r2: 'r2\n' }
  expect(files()).toEqual(after)
  expect(await isLive(c, xid)).toBe(true)                                            // the overlap goes on past R2

  // the receipt: R2's own safe writes only, said to be partial, the background command named
  const diff = diffOf(r2Done)
  expect(diff).toMatchObject({ in_place: true, attribution: 'partial', files: 1 })
  expect(diff.background_execution_ids).toEqual([xid])
  expect(diff.unattributed_paths).toEqual(['shared.txt'])
  expect(producedOf(r2Done).files_changed).toEqual(['r2.txt'])
  // the run's diff: the same
  const runDiff = await json<RunDiffResponse>(await c.get(`/api/runs/${r2.id}/diff`))
  expect(runDiff.files.map((f) => f.path)).toEqual(['r2.txt'])
  expect(runDiff).toMatchObject({ in_place: true, attribution: 'partial', background_execution_ids: [xid], unattributed_paths: ['shared.txt'] })
  expect(runDiff.patch).not.toContain('bg.txt')
  expect(runDiff.patch).not.toContain('shared.txt')
  // the command is still R1's (its run, its output); R2 lists none of its own
  expect((await execution(c, xid)).run_id).toBe(r1.id)
  expect(rec(await getRun(c, r2.id)).executions as Rec[]).toEqual([])
  expect((await sessionDetail(c, sid)).background_commands!.map((b) => [b.execution_id, b.run_id])).toEqual([[xid, r1.id]])

  // the whole-run undo during the overlap: refused, nothing touched
  const during = await json(await c.post(`/api/runs/${r2.id}/undo`), 409)
  expect(['attribution_unavailable', 'workspace_busy']).toContain(during.code as string)
  expect(files()).toEqual(after)

  // the command ends: the undo is still refused — what R2 wrote cannot be told from what the command wrote
  g.open('end')
  await until('the command ended', async () => !(await isLive(c, xid)))
  expect(JSON.stringify(await json(await c.get(`/api/executions/${xid}/output`)))).toContain('bg-exit')
  const refused = await json(await c.post(`/api/runs/${r2.id}/undo`), 409)
  expect(refused.code).toBe('attribution_unavailable')
  expect(files()).toEqual(after)
  expect((await sessionDetail(c, sid)).background_commands ?? []).toEqual([])
  await until('the folder free', async () => (await json(await c.get(`/api/workspaces/${wsId}`))).lock_owner === null)

  // a quiescent run: exact, nothing in the background, and its undo works (checked against the file as it is)
  const r3 = await waitDone(app.state, (await chat(c, sid, { text: 'TURN:r3 one more file' })).id)
  expect(r3.status, String(r3.error)).toBe('done')
  const d3 = diffOf(r3)
  expect(d3.attribution ?? 'exact').toBe('exact')
  expect(d3.background_execution_ids ?? []).toEqual([])
  expect(producedOf(r3).files_changed).toEqual(['r3.txt'])
  const undo3 = await json<UndoResult>(await c.post(`/api/runs/${r3.id}/undo`))
  expect(undo3).toMatchObject({ removed: ['r3.txt'], restored: [], conflicts: [] })
  expect(existsSync(join(folder, 'r3.txt'))).toBe(false)
  expect(files()).toEqual(after)
  // R2's stays refused, whatever ran since
  expect((await json(await c.post(`/api/runs/${r2.id}/undo`), 409)).code).toBe('attribution_unavailable')
  expect(files()).toEqual(after)
}, 60_000)

// ---- 3 ------------------------------------------------------------------------------------------------------------

test('a snapshot run overlapped by a background command claims nothing (sticky though the command ended mid-run); the next quiescent run measures from the tree it found, after an unattributed state checkpoint', async () => {
  const { app, c } = await open()
  const project = await json(await c.post('/api/projects', { source_path: buggyRepo() }))
  const s = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'snapshot' }))
  const sid = s.id as string
  const wsId = rec(s.workspace).id as string
  const g = gates()
  const r2Paused = deferred()
  const r2Hold = deferred()
  setModel(app.state, MODEL, router({
    // a "download" that lands in the worktree while R2 works, then ends
    r1: startsInBackground(`${g.wait('download')}; printf 'downloaded\\n' > dl.txt; echo dl-done`),
    r2: [
      () => modelResponse([toolCallPart('write_file', { path: 'r2.txt', content: 'r2\n' }, 'w1')]),
      async () => { r2Paused.resolve(); await r2Hold.promise; return say('r2 done') },
    ],
    r3: [
      () => modelResponse([toolCallPart('write_file', { path: 'r3.txt', content: 'r3\n' }, 'w2')]),
      () => say('r3 done'),
    ],
  }))

  const { r1, xid } = await firstRunLeavesItRunning(app, c, sid, 'TURN:r1 start the download')
  expect(producedOf(r1).final_checkpoint_id ?? null).toBeNull()                       // R1 changed nothing itself
  const r2 = await chat(c, sid, { text: 'TURN:r2 work while it downloads' })
  expect(r2.status).not.toBe('queued')
  await within(r2Paused.promise, 'R2 working')
  expect(await isLive(c, xid)).toBe(true)
  // the command ends before R2 does
  g.open('download')
  await until('the download ended', async () => !(await isLive(c, xid)))
  const ws = repo.getWorkspace(app.state.conn, wsId)!
  expect(read(join(ws.path, 'dl.txt'))).toBe('downloaded\n')
  r2Hold.resolve()
  const r2Done = await waitDone(app.state, r2.id)
  expect(r2Done.status, String(r2Done.error)).toBe('done')

  // R2 claims nothing: unavailable, the command named, no checkpoint of its own, its run diff refused
  const d2 = diffOf(r2Done)
  expect(d2.attribution).toBe('unavailable')
  expect(d2.background_execution_ids).toEqual([xid])
  expect(producedOf(r2Done).final_checkpoint_id ?? null).toBeNull()
  expect(producedOf(r2Done).files_changed as string[]).not.toContain('dl.txt')
  const checkpointsOf = async () => (await json<{ checkpoints: Checkpoint[] }>(await c.get(`/api/workspaces/${wsId}`))).checkpoints
  expect((await checkpointsOf()).filter((cp) => cp.run_id === r2.id)).toEqual([])
  const r2Diff = await json(await c.get(`/api/runs/${r2.id}/diff`), 409)
  expect(r2Diff.code).toBe('attribution_unavailable')
  expect(r2Diff.background_execution_ids as string[]).toContain(xid)
  expect((await execution(c, xid)).run_id).toBe(r1.id)
  expect((await sessionDetail(c, sid)).background_commands ?? []).toEqual([])

  // R3, quiescent: its baseline is the tree as it found it (the download and R2's file in it)
  const r3 = await waitDone(app.state, (await chat(c, sid, { text: 'TURN:r3 a file of mine' })).id)
  expect(r3.status, String(r3.error)).toBe('done')
  const d3 = diffOf(r3)
  expect(d3.attribution ?? 'exact').toBe('exact')
  expect(d3.background_execution_ids ?? []).toEqual([])
  expect(typeof d3.base_tree_sha).toBe('string')
  expect(producedOf(r3).files_changed).toEqual(['r3.txt'])
  const r3Diff = await json<RunDiffResponse>(await c.get(`/api/runs/${r3.id}/diff`))
  expect(r3Diff.files.map((f) => f.path)).toEqual(['r3.txt'])
  expect(r3Diff.patch).not.toContain('dl.txt')
  expect(r3Diff.patch).not.toContain('r2.txt')
  expect(r3Diff.attribution ?? 'exact').toBe('exact')

  // the checkpoints: R3's sits on a state checkpoint of no run that holds what was there before R3
  const checkpoints = await checkpointsOf()
  const cp3 = checkpoints.find((cp) => cp.id === producedOf(r3).final_checkpoint_id)!
  expect(cp3).toBeDefined()
  expect(cp3.run_id).toBe(r3.id)
  const state = checkpoints.find((cp) => cp.id === cp3.parent_checkpoint_id)!
  expect(state).toBeDefined()
  expect(state.run_id).toBeNull()
  const git = app.state.workspaces.git
  expect((await git.numstat(ws.path, state.commit_sha, cp3.commit_sha)).map((f) => f.path)).toEqual(['r3.txt'])
  expect((await git.numstat(ws.path, ws.base_commit, state.commit_sha)).map((f) => f.path).sort()).toEqual(['dl.txt', 'r2.txt'])
  expect(repo.getSnapshot(app.state.conn, state.snapshot_id)!.tree_sha).toBe(d3.base_tree_sha as string)
}, 60_000)

// ---- 4 ------------------------------------------------------------------------------------------------------------

test('a watch that fires while the next run of its conversation works waits in the persisted queue, then wakes the conversation exactly once after that run, never steered into it', async () => {
  const { app, c } = await open()
  const project = await json(await c.post('/api/projects', { source_path: plainFolder(), mode: 'direct' }))
  const s = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'watched' }))
  const sid = s.id as string
  const g = gates()
  const r2Entered = deferred()
  const r2Hold = deferred()
  const r2Saw: string[] = []
  const woken: string[] = []
  setModel(app.state, MODEL, router({
    r1: [
      () => modelResponse([toolCallPart('bash', { command: `${g.wait('end')}; echo watched-job-finished`, wait_s: 1 }, 'bg1')]),
      (m) => modelResponse([toolCallPart('watch', { kind: 'exit', execution_id: rec(lastToolReturn(m, 'bash')).execution_id, note: 'read what the job printed' }, 'wt1')]),
      () => say('watching the job'),
    ],
    r2: [
      async (m) => { r2Saw.push(JSON.stringify(m)); r2Entered.resolve(); await r2Hold.promise; return modelResponse([toolCallPart('read_file', { path: 'README.md' }, 'rd')]) },
      (m) => { r2Saw.push(JSON.stringify(m)); return say('r2 done') },
    ],
  }, (m) => { woken.push(promptText(m.findLast((x) => promptText(x).includes(WAKE_OPENING))!)); return say('woken: read it') }))
  const wakeRuns = () => repo.listRuns(app.state.conn, sid).filter((r) => r.spawned_by === 'wake')

  const { xid } = await firstRunLeavesItRunning(app, c, sid, 'TURN:r1 run the job and watch it')
  expect(repo.listWatches(app.state.conn, sid).map((w) => [w.status, w.spec.execution_id])).toEqual([['active', xid]])
  const r2 = await chat(c, sid, { text: 'TURN:r2 meanwhile' })
  expect(r2.status).not.toBe('queued')
  await within(r2Entered.promise, 'R2 working')

  // the job ends while R2 works: the event is kept, pending; nothing starts beside R2, nothing is steered into it
  g.open('end')
  await until('the job ended', async () => !(await isLive(c, xid)))
  await until('the wake event kept', () => repo.listWakeEvents(app.state.conn, sid).length === 1)
  await sleep(300)                                                                     // three of the watches' ticks
  expect(repo.listPendingWakeEvents(app.state.conn, sid)).toHaveLength(1)
  expect(wakeRuns()).toEqual([])
  expect(app.state.runs.handles.get(r2.id)!.done).toBe(false)
  r2Hold.resolve()
  const r2Done = await waitDone(app.state, r2.id)
  expect(r2Done.status, String(r2Done.error)).toBe('done')
  expect((await json<{ steers: unknown[] }>(await c.get(`/api/runs/${r2.id}/steers`))).steers).toEqual([])
  for (const m of r2Saw) expect(m).not.toContain(WAKE_OPENING)

  // after R2: exactly one wake, continuing from R2, the event delivered to it
  const woke = await until('the wake run', () => wakeRuns()[0])
  const wokeDone = await waitDone(app.state, woke.id)
  expect(wokeDone.status, String(wokeDone.error)).toBe('done')
  expect(new Date(woke.created_at).getTime()).toBeGreaterThanOrEqual(new Date(r2Done.finished_at!).getTime())
  expect(wokeDone.resumes_run_id).toBe(r2.id)
  expect(woken).toHaveLength(1)
  expect(woken[0]).toContain('Your note: read what the job printed')
  expect(woken[0]).toContain(xid)
  await sleep(300)
  expect(wakeRuns().map((r) => r.id)).toEqual([woke.id])
  expect(repo.listPendingWakeEvents(app.state.conn, sid)).toEqual([])
  expect(repo.listWakeEvents(app.state.conn, sid).map((e) => [e.kind, e.status, e.run_id])).toEqual([['fired', 'delivered', woke.id]])
}, 60_000)

// ---- 5 ------------------------------------------------------------------------------------------------------------

test('a fresh conversation of the session queues behind the background command; a local restart stops the command and frees the folder for everyone', async () => {
  const folder = plainFolder()
  const settings = testSettings()
  const first = await open(settings)
  const c1 = first.c
  const project = await json(await c1.post('/api/projects', { source_path: folder, mode: 'direct' }))
  const s1 = await json(await c1.post(`/api/projects/${project.id}/sessions`, { title: 'owner' }))
  const s2 = await json(await c1.post(`/api/projects/${project.id}/sessions`, { title: 'outsider' }))
  const sid = s1.id as string
  const wsId = rec(s1.workspace).id as string
  const g = gates()
  const turns = {
    r1: startsInBackground(`${g.wait('end')}; printf 'late\\n' > after.txt`),
    fresh: [() => say('fresh done')],
    out: [() => say('outsider done')],
    next: [() => say('next done')],
  }
  setModel(first.app.state, MODEL, router(turns))
  const { r1, xid } = await firstRunLeavesItRunning(first.app, c1, sid, 'TURN:r1 start it')
  const r1Row = await getRun(c1, r1.id)
  expect((await sessionDetail(c1, sid)).background_commands!.map((b) => [b.execution_id, b.run_id, b.conversation_id])).toEqual([[xid, r1.id, conversationOf(r1Row) ?? null]])

  // a fresh conversation of the same session is another conversation: it waits behind the command
  const fresh = await chat(c1, sid, { text: 'TURN:fresh start over', fresh: true })
  expect(fresh.status).toBe('queued')
  expect(conversationOf(await getRun(c1, fresh.id)) ?? null).not.toBe(conversationOf(r1Row))
  const out = await chat(c1, s2.id as string, { text: 'TURN:out mine now' })
  expect(out.status).toBe('queued')
  for (const id of [fresh.id, out.id]) {
    expect((await json(await c1.post(`/api/runs/${id}/cancel`))).cancelled).toBe(true)
    expect((await waitDone(first.app.state, id)).status).toBe('cancelled')
    // stopped in line: queued (a place-in-line update may say so again), never started, ended once as cancelled
    const seen = repo.listEvents(first.app.state.conn, id)
    const names = seen.map((e) => e.event)
    expect(names[0]).toBe('run_queued')
    expect(names.at(-1)).toBe('run_finished')
    expect(names.slice(0, -1).every((n) => n === 'run_queued')).toBe(true)
    expect(names).not.toContain('run_started')
    expect(names).not.toContain('slot_acquired')
    const finished = seen.filter((e) => e.event === 'run_finished')
    expect(finished).toHaveLength(1)
    expect(finished[0]!.data).toMatchObject({ status: 'cancelled' })
  }
  expect(await isLive(c1, xid)).toBe(true)

  // the app restarts: the command is stopped with it (the existing cleanup), and never writes again
  await closeNow(first.app)
  const second = await open(settings)
  await second.app.start()
  const c2 = second.c
  setModel(second.app.state, MODEL, router(turns))
  g.open('end')
  await sleep(400)                                                                      // eight of its polls
  expect(existsSync(join(folder, 'after.txt'))).toBe(false)
  const x = await execution(c2, xid)
  expect(x.running).toBe(false)
  expect(x.status).not.toBe('running')
  expect(x.finished_at).not.toBeNull()
  expect(x.run_id).toBe(r1.id)
  expect((await sessionDetail(c2, sid)).background_commands ?? []).toEqual([])
  expect((await json(await c2.get(`/api/workspaces/${wsId}`))).lock_owner).toBeNull()

  // nothing holds the folder: the conversation, a fresh one and the other session each start at once
  for (const [session, body] of [[sid, { text: 'TURN:next go on' }], [sid, { text: 'TURN:fresh again', fresh: true }], [s2.id as string, { text: 'TURN:out now' }]] as const) {
    const run = await chat(c2, session, body)
    expect(run.status).not.toBe('queued')
    const done = await waitDone(second.app.state, run.id)
    expect(done.status, String(done.error)).toBe('done')
    expect(events(second.app, run.id)).not.toContain('run_queued')
  }
  expect((await json(await c2.get(`/api/workspaces/${wsId}`))).lock_owner).toBeNull()
}, 60_000)
