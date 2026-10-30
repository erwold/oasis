/** Computer use (computer_observe / computer_act) over a desktop app the test plays: a look comes back with its
 *  screenshot kept as an image of the session and handed to the model as an image, the outline and the page's words
 *  marked untrusted; an action goes as the run (its hold on the page) with nothing null in it; files to upload are
 *  read through the path policy; the network grant, Plan mode and a session that asks before changes all hold, and an
 *  approved action goes through the same desktop app. */

import { afterEach, expect, test } from 'bun:test'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { GrantsSchema, type Session } from '@oasis-code/contract'
import type { ComputerClient } from '../src/computer/desktop.ts'
import * as repo from '../src/db/repo.ts'
import { BridgeError } from '../src/llm/chatgpt_web.ts'
import { returnHasImage } from '../src/llm/images.ts'
import { lastToolReturn, modelResponse, textPart, toolCallPart, type ModelMessage } from '../src/llm/messages.ts'
import * as gate from '../src/policy/gate.ts'
import { applySessionMode } from '../src/policy/modes.ts'
import { ModelConfig } from '../src/config.ts'
import { appState, buggyRepo, closeState, openSession, scriptedModel, setModel, testConfig, waitDone, type AppState } from './harness.ts'
import { rec } from './tree_helpers.ts'
import { tempDir } from './helpers.ts'

let state: AppState | null = null
afterEach(async () => { if (state) await closeState(state); state = null })

const JPEG = readFileSync(join(import.meta.dir, 'fixtures', 'images', 'red-7x5.jpg'))

/** A route that takes images (the screenshot reaches it as one). */
function seeing() {
  const config = testConfig()
  config.models = [new ModelConfig({ id: 'scripted:a', label: 'Scripted A', provider: 'anthropic', model: 'scripted-a', api_key_env: 'OASIS_TEST_KEY_A', capabilities: { images: true } })]
  return config
}

/** The desktop app as the test plays it: every request kept, each answered by `answer`. */
function fakeComputer(answer: (path: string, body: Record<string, unknown>) => Record<string, unknown> | Error, downloadsDir: string | null = null): ComputerClient & { calls: [string, Record<string, unknown>][]; timeouts: (number | undefined)[] } {
  const calls: [string, Record<string, unknown>][] = []
  const timeouts: (number | undefined)[] = []
  return {
    calls, timeouts, downloadsDir,
    request: async (path, body, _signal, timeoutMs) => {
      calls.push([path, body])
      timeouts.push(timeoutMs)
      const out = answer(path, body)
      if (out instanceof Error) throw out
      return out
    },
  }
}

const look = (extra: Record<string, unknown> = {}) => ({
  status: 'ok', surface: 'browser', snapshot_id: 'browser-1', url: 'https://example.com/', title: 'Example', loading: false,
  viewport: { width: 1265, height: 800 }, image: { media_type: 'image/jpeg', data_base64: JPEG.toString('base64'), width: 7, height: 5 },
  outline: '- button "Go" [ref=e7]', dialog: null, notes: [], ...extra,
})

/** A run that calls the tools in turn and keeps what each returned. */
function playing(calls: [string, Record<string, unknown>][], box: Record<string, unknown>[]) {
  let n = 0
  return (messages: ModelMessage[]) => {
    if (n > 0) box.push(rec(lastToolReturn(messages, calls[n - 1]![0])))
    const next = calls[n]
    n += 1
    return next ? modelResponse([toolCallPart(next[0], next[1], '')]) : modelResponse([textPart('done')])
  }
}

function withNetwork(st: AppState, session: Session, network: boolean): Session {
  repo.setSessionGrants(st.conn, session.id, { ...GrantsSchema.parse({}), network })
  return repo.getSession(st.conn, session.id)!
}

test('a look: the screenshot is an image of the session the model sees, the outline untrusted, the run holds the page', async () => {
  const computer = fakeComputer(() => look())
  state = await appState({ computer, config: seeing() })
  const { session } = await openSession(state, buggyRepo())
  const out: Record<string, unknown>[] = []
  let seenImage = false
  setModel(state, 'scripted:a', scriptedModel((messages) => {
    const ret = lastToolReturn(messages, 'computer_observe')
    if (ret !== null) { seenImage = returnHasImage(ret); out.push(rec(ret)); return modelResponse([textPart('done')]) }
    return modelResponse([toolCallPart('computer_observe', {}, '')])
  }))
  const run = await waitDone(state, (await state.runs.start(session, 'look at the page')).id)
  expect(run.status).toBe('done')
  // the look, then — the run over — the page let go at once
  expect(computer.calls).toEqual([['/computer/observe', { surface: 'browser', owner: run.id, session: session.id, screenshot: true }], ['/computer/release', { owner: run.id }]])
  const payload = out[0]!
  expect(payload.status).toBe('ok')
  expect(seenImage).toBe(true)
  const shot = rec(payload.screenshot)
  expect([shot.kind, shot.media_type, shot.width, shot.height, shot.name]).toEqual(['image', 'image/jpeg', 7, 5, 'browser-1.jpg'])
  expect('image' in payload).toBe(false)                                              // the bytes never ride in the payload
  expect(payload.outline).toBe('- button "Go" [ref=e7]')
  expect(String(payload.untrusted)).toContain('untrusted')
  const asset = repo.getAsset(state.conn, shot.asset_id as string)!
  expect(asset.meta.session_id).toBe(session.id)
  const result = repo.listEvents(state.conn, run.id).find((e) => e.event === 'tool_result')!.data
  expect([result.tool, result.screenshot_asset_id, result.snapshot_id, result.summary]).toEqual(['computer_observe', shot.asset_id, 'browser-1', 'look at browser · Example'])
})

test('read_text, and an action: the arguments go without their nulls, as the run of its session; the look after it comes back', async () => {
  const computer = fakeComputer((path, body) => (body.action === 'read_text' ? { status: 'ok', surface: 'browser', action: 'read_text', text: 'hello', offset: 0, total_chars: 5, next_offset: null }
    : path === '/computer/act' ? look({ action: body.action, done: { clicked: body.ref }, snapshot_id: 'browser-2' }) : look()))
  state = await appState({ computer, config: seeing() })
  const { session } = await openSession(state, buggyRepo())
  const box: Record<string, unknown>[] = []
  setModel(state, 'scripted:a', scriptedModel(playing([
    ['computer_observe', { read_text: true }],
    ['computer_act', { action: 'click', ref: 'e7', snapshot_id: 'browser-1' }],
    ['computer_act', { surface: 'chatgpt', action: 'type', text: 'hi', submit: true, snapshot_id: 'chatgpt-3' }],
    ['computer_act', { action: 'navigate', url: 'https://example.com/b' }],
  ], box)))
  const run = await waitDone(state, (await state.runs.start(session, 'use the page')).id)
  expect(computer.calls.filter((c) => c[0] !== '/computer/release')).toEqual([
    ['/computer/act', { surface: 'browser', owner: run.id, session: session.id, action: 'read_text', offset: 0 }],
    ['/computer/act', { surface: 'browser', owner: run.id, session: session.id, action: 'click', snapshot_id: 'browser-1', ref: 'e7' }],
    ['/computer/act', { surface: 'chatgpt', owner: run.id, session: session.id, action: 'type', snapshot_id: 'chatgpt-3', text: 'hi', submit: true }],
    ['/computer/act', { surface: 'browser', owner: run.id, session: session.id, action: 'navigate', url: 'https://example.com/b' }],
  ])
  expect([box[0]!.text, box[0]!.untrusted !== undefined, 'screenshot' in box[0]!]).toEqual(['hello', true, false])
  expect([box[1]!.status, box[1]!.snapshot_id, rec(box[1]!.done).clicked]).toEqual(['ok', 'browser-2', 'e7'])
  expect(rec(box[1]!.screenshot).kind).toBe('image')
})

test('what the desktop app says goes to the model as it is: stale with a fresh look, busy with its holder; no app, or a refused token, is said in words', async () => {
  let answer: Record<string, unknown> | Error = look({ status: 'stale', reason: 'the page changed since that look', snapshot_id: 'browser-5' })
  const computer = fakeComputer(() => answer)
  state = await appState({ computer })
  const { session } = await openSession(state, buggyRepo())
  const run = async (args: Record<string, unknown>) => {
    const box: Record<string, unknown>[] = []
    setModel(state!, 'scripted:a', scriptedModel(playing([['computer_act', args]], box)))
    await waitDone(state!, (await state!.runs.start(session, 'act', { fresh: true })).id)
    return box[0]!
  }
  const stale = await run({ action: 'click', x: 3, y: 4, snapshot_id: 'browser-1' })
  expect([stale.status, stale.reason, stale.snapshot_id]).toEqual(['stale', 'the page changed since that look', 'browser-5'])
  // a model that takes no images is told so in the picture's place (the outline is still there)
  expect(String(stale.screenshot)).toContain('this model does not accept images')
  expect(stale.outline).toBe('- button "Go" [ref=e7]')
  // Unsupported screenshot note is chosen BEFORE storage, not substituted at the provider/replay boundary.
  const stored = repo.getRunHistory(state.conn, repo.latestRunOfSession(state.conn, session.id)!.id)!
  expect(stored).toContain('this model does not accept images')
  expect(stored).not.toContain('\"kind\":\"image\"')
  answer = { status: 'busy', reason: 'the browser surface is in use by run_other', holder: 'run_other' }
  const busy = await run({ action: 'reload' })
  expect([busy.status, busy.holder]).toEqual(['busy', 'run_other'])
  answer = new BridgeError('the bridge at http://127.0.0.1:8323 is not reachable (ECONNREFUSED)', 'unreachable', 'http://127.0.0.1:8323')
  const gone = await run({ action: 'reload' })
  expect(gone.status).toBe('refused')
  expect(String(gone.reason)).toContain('the oasis-code desktop app is not running')
  answer = new BridgeError('refused', 'refused', 'http://127.0.0.1:8323', 401)
  expect(String((await run({ action: 'reload' })).reason)).toContain("refused this backend's token")
})

test('an upload names files the run may read: each goes as its path on this machine; one outside or not a file is refused before anything', async () => {
  const computer = fakeComputer(() => look({ action: 'upload', done: { uploaded: 1 } }))
  state = await appState({ computer })
  const { session, ws } = await openSession(state, buggyRepo())
  writeFileSync(join(ws.path, 'notes.txt'), 'hi')
  const box: Record<string, unknown>[] = []
  setModel(state, 'scripted:a', scriptedModel(playing([
    ['computer_act', { action: 'upload', files: ['notes.txt', 'calc.py'], snapshot_id: 'browser-1' }],
    ['computer_act', { action: 'upload', files: ['../../../etc/passwd'], snapshot_id: 'browser-1' }],
    ['computer_act', { action: 'upload', files: ['.'], snapshot_id: 'browser-1' }],
    ['computer_act', { action: 'upload', files: [], snapshot_id: 'browser-1' }],
  ], box)))
  await waitDone(state, (await state.runs.start(session, 'upload')).id)
  expect(computer.calls.map((c) => c[0])).toEqual(['/computer/act', '/computer/release'])
  expect(computer.calls[0]![1].files).toEqual([realpathSync(join(ws.path, 'notes.txt')), realpathSync(join(ws.path, 'calc.py'))])
  expect(box[0]!.status).toBe('ok')
  expect(box.slice(1).map((b) => b.status)).toEqual(['refused', 'refused', 'refused'])
  expect(String(box[2]!.reason)).toContain('is not a file')
  expect(String(box[3]!.reason)).toContain('upload needs files')
})

test('the network grant covers computer use; Plan mode looks but does not act', async () => {
  const computer = fakeComputer(() => look())
  state = await appState({ computer })
  let { session } = await openSession(state, buggyRepo())
  session = withNetwork(state, session, false)
  let box: Record<string, unknown>[] = []
  setModel(state, 'scripted:a', scriptedModel(playing([['computer_observe', {}], ['computer_act', { action: 'reload' }]], box)))
  await waitDone(state, (await state.runs.start(session, 'look')).id)
  expect(box.map((b) => [b.status, b.action])).toEqual([['refused_by_policy', 'network'], ['refused_by_policy', 'network']])
  expect(computer.calls).toEqual([])                                                  // never asked: nothing to let go either
  session = withNetwork(state, session, true)
  applySessionMode(state.conn, session, 'plan')
  box = []
  setModel(state, 'scripted:a', scriptedModel(playing([['computer_observe', {}], ['computer_act', { action: 'reload' }]], box)))
  await waitDone(state, (await state.runs.start(repo.getSession(state.conn, session.id)!, 'look', { fresh: true })).id)
  expect(box.map((b) => b.status)).toEqual(['ok', 'blocked'])
  expect(computer.calls.map((c) => c[0])).toEqual(['/computer/observe', '/computer/release'])
})

test("a run in Plan mode is told what it may do with the app's pages: look at its own tabs (the first blank) and ChatGPT's, not navigate, use tabs or act on one", async () => {
  const computer = fakeComputer(() => look())
  state = await appState({ computer })
  const { session } = await openSession(state, buggyRepo())
  applySessionMode(state.conn, session, 'plan')
  let first = ''
  setModel(state, 'scripted:a', scriptedModel((messages) => { first ||= JSON.stringify(messages[0]); return modelResponse([textPart('done')]) }))
  await waitDone(state, (await state.runs.start(repo.getSession(state.conn, session.id)!, 'look')).id)
  expect(first).toContain('Plan mode: read files and use the web')
  expect(first).toContain('looking at your own browser tabs and the ChatGPT page works (computer_observe, read_text too); your first browser look takes over the tabs this conversation\'s last finished run left, or opens a blank one')
  expect(first).toContain('Navigating, opening, switching or closing a tab, and clicking, typing or any other input on a page do not')
})

test('a session that asks before changes: the action is proposed, and its approval acts through the desktop app as the run that proposed it', async () => {
  const computer = fakeComputer((_path, body) => look({ action: body.action, done: { clicked: body.ref }, snapshot_id: 'browser-2' }))
  state = await appState({ computer })
  const { project, session } = await openSession(state, buggyRepo())
  applySessionMode(state.conn, session, 'approve')
  const box: Record<string, unknown>[] = []
  setModel(state, 'scripted:a', scriptedModel(playing([['computer_observe', {}], ['computer_act', { action: 'click', ref: 'e7', snapshot_id: 'browser-1' }]], box)))
  const run = await waitDone(state, (await state.runs.start(repo.getSession(state.conn, session.id)!, 'click go')).id)
  expect(box.map((b) => b.status)).toEqual(['ok', 'action_gated'])                 // the look is a read: never proposed
  expect(computer.calls.map((c) => c[1].action ?? c[0])).toEqual(['/computer/observe', '/computer/release'])
  expect(String(box[1]!.message)).toContain('computer_act click e7 on browser')
  const proposal = gate.listProposals(state.conn, project.id, session.id)[0]!
  expect(proposal.tool_name).toBe('computer_act')
  const decided = await gate.decideProposal(state, proposal.proposal_asset_id, 'approve')
  expect(rec(decided.result)).toEqual({ status: 'ok', surface: 'browser', action: 'click', done: { clicked: 'e7' }, url: 'https://example.com/', title: 'Example' })
  // an approval's action is marked so: the desktop app acts on the page it names or nowhere (it never opens one)
  expect(computer.calls[2]).toEqual(['/computer/act', { surface: 'browser', owner: run.id, session: session.id, approval: true, action: 'click', snapshot_id: 'browser-1', ref: 'e7' }])
  // the page changed before the approval: the desktop app says stale, and the record says so
  const again = fakeComputer(() => ({ status: 'stale', reason: 'the page changed since that look' }))
  state.computer = again
  setModel(state, 'scripted:a', scriptedModel(playing([['computer_act', { action: 'click', ref: 'e7', snapshot_id: 'browser-1' }]], [])))
  await waitDone(state, (await state.runs.start(repo.getSession(state.conn, session.id)!, 'click again', { fresh: true })).id)
  const second = gate.listProposals(state.conn, project.id, session.id).find((p) => p.status === 'pending')!
  const stale = await gate.decideProposal(state, second.proposal_asset_id, 'approve')
  expect(rec(stale.result).status).toBe('stale')
})

test('what a page downloaded is moved into the workspace\'s temporary folder and named there; a file outside the app\'s folder is not touched', async () => {
  const from = tempDir('oasis-downloads-')
  writeFileSync(join(from, '17-ab-report.csv'), 'a,b\n1,2\n')
  writeFileSync(join(from, '18-cd-report.csv'), 'second')
  const outside = join(tempDir('oasis-elsewhere-'), 'secret.txt')
  writeFileSync(outside, 'keep me')
  const computer = fakeComputer(() => look({ action: 'click', done: { clicked: 'e7' }, downloads: [
    { name: 'report.csv', path: join(from, '17-ab-report.csv'), bytes: 8, media_type: 'text/csv', url: 'https://example.com/export' },
    { name: 'report.csv', path: join(from, '18-cd-report.csv'), bytes: 6 },
    { name: 'secret.txt', path: outside, bytes: 7 },
  ] }), from)
  state = await appState({ computer })
  const { session } = await openSession(state, buggyRepo())
  const box: Record<string, unknown>[] = []
  setModel(state, 'scripted:a', scriptedModel(playing([['computer_act', { action: 'click', ref: 'e7', snapshot_id: 'browser-1' }]], box)))
  await waitDone(state, (await state.runs.start(session, 'export')).id)
  const downloads = box[0]!.downloads as Record<string, unknown>[]
  expect(downloads.map((d) => [d.name, d.bytes])).toEqual([['report.csv', 8], ['report.csv', 6]])
  expect(String(downloads[0]!.path)).toEndWith('/downloads/report.csv')
  expect(String(downloads[1]!.path)).toEndWith('/downloads/report (2).csv')
  expect(readFileSync(String(downloads[0]!.path), 'utf8')).toBe('a,b\n1,2\n')
  expect(downloads[0]!.from_url).toBe('https://example.com/export')
  expect(existsSync(join(from, '17-ab-report.csv'))).toBe(false)                  // moved, not copied
  expect(readFileSync(outside, 'utf8')).toBe('keep me')                           // never the app's: left alone
})

test('test_computer_approval_keeps_downloads: what an approved action downloaded is taken into the temporary folder before the page is let go, and named in the result', async () => {
  const from = tempDir('oasis-downloads-')
  const file = join(from, '1-ab-approved-export.csv')
  const order: string[] = []
  const computer = fakeComputer((path, body) => {
    if (path === '/computer/release') { order.push(`release; the file is ${existsSync(file) ? 'still there' : 'taken'}`); return { status: 'ok', released: ['browser'] } }
    if (body.action === 'click') { writeFileSync(file, 'a,b\n1,2\n'); return look({ action: 'click', done: { clicked: 'e7' }, downloads: [{ name: 'approved-export.csv', path: file, bytes: 8 }] }) }
    return look()
  }, from)
  state = await appState({ computer })
  const { session, ws } = await openSession(state, buggyRepo())
  applySessionMode(state.conn, session, 'approve')
  setModel(state, 'scripted:a', scriptedModel(playing([['computer_act', { action: 'click', ref: 'e7', snapshot_id: 'browser-1' }]], [])))
  await waitDone(state, (await state.runs.start(repo.getSession(state.conn, session.id)!, 'export', { fresh: true })).id)
  const proposal = gate.listProposals(state.conn, session.project_id, session.id).find((p) => p.status === 'pending')!
  order.length = 0
  const result = rec((await gate.decideProposal(state, proposal.proposal_asset_id, 'approve')).result)
  expect(result.status).toBe('ok')
  const downloads = result.downloads as Record<string, unknown>[]
  expect(downloads.map((d) => [d.name, d.bytes])).toEqual([['approved-export.csv', 8]])
  expect(realpathSync(String(downloads[0]!.path))).toBe(realpathSync(join(state.processes.ensureTemp(ws.id), 'downloads', 'approved-export.csv')))
  expect(readFileSync(String(downloads[0]!.path), 'utf8')).toBe('a,b\n1,2\n')
  expect(order).toEqual(['release; the file is taken'])
})

test('select, drag and a wait for a condition go as the model gave them; a wait\'s request may take its own seconds and a minute', async () => {
  const computer = fakeComputer((_p, body) => look({ action: body.action, done: {} }))
  state = await appState({ computer })
  const { session } = await openSession(state, buggyRepo())
  const box: Record<string, unknown>[] = []
  setModel(state, 'scripted:a', scriptedModel(playing([
    ['computer_act', { action: 'select', ref: 'e4', text: 'Blue', snapshot_id: 'browser-1' }],
    ['computer_act', { action: 'drag', ref: 'e3', to_x: 10, to_y: 20, snapshot_id: 'browser-1' }],
    ['computer_act', { action: 'wait', text: 'Done', gone: true, seconds: 120 }],
    ['computer_act', { action: 'wait', download: true }],
  ], box)))
  const run = await waitDone(state, (await state.runs.start(session, 'use the page')).id)
  expect(computer.calls.filter((c) => c[0] === '/computer/act').map((c) => c[1])).toEqual([
    { surface: 'browser', owner: run.id, session: session.id, action: 'select', snapshot_id: 'browser-1', ref: 'e4', text: 'Blue' },
    { surface: 'browser', owner: run.id, session: session.id, action: 'drag', snapshot_id: 'browser-1', ref: 'e3', to_x: 10, to_y: 20 },
    { surface: 'browser', owner: run.id, session: session.id, action: 'wait', text: 'Done', seconds: 120, gone: true },
    { surface: 'browser', owner: run.id, session: session.id, action: 'wait', download: true },
  ])
  expect(computer.timeouts.slice(0, 4)).toEqual([undefined, undefined, 180_000, 90_000])
})

test('integration: a page action approved while another writer holds the folder goes on — it writes nothing of the folder, so it neither waits for the writer nor is refused for it (workspace_busy) nor takes the folder', async () => {
  const computer = fakeComputer((_path, body) => look({ action: body.action, done: { clicked: body.ref }, snapshot_id: 'browser-2' }))
  state = await appState({ computer })
  const { project, session, ws } = await openSession(state, buggyRepo())
  applySessionMode(state.conn, session, 'approve')
  setModel(state, 'scripted:a', scriptedModel(playing([['computer_observe', {}], ['computer_act', { action: 'click', ref: 'e7', snapshot_id: 'browser-1' }]], [])))
  await waitDone(state, (await state.runs.start(repo.getSession(state.conn, session.id)!, 'click go')).id)
  const proposal = gate.listProposals(state.conn, project.id, session.id)[0]!
  expect(proposal.tool_name).toBe('computer_act')
  await state.locks.acquire(ws.id, 'command:cmd_fake')
  try {
    const decided = await gate.decideProposal(state, proposal.proposal_asset_id, 'approve')
    expect(rec(decided.result).status).toBe('ok')
    expect(state.locks.holder(ws.id)).toBe('command:cmd_fake')                 // the writer's hold untouched
  } finally {
    state.locks.release(ws.id, 'command:cmd_fake')
  }
})


test('the sharp browser display is stored separately while the model keeps its original screenshot', async () => {
  const displayBytes = readFileSync(join(import.meta.dir, 'fixtures', 'images', 'red-14x10.png'))
  const computer = fakeComputer(() => look({ display_image: { media_type: 'image/png', data_base64: displayBytes.toString('base64'), width: 14, height: 10 } }))
  state = await appState({ computer, config: seeing() })
  const { session } = await openSession(state, buggyRepo())
  const box: Record<string, unknown>[] = []
  setModel(state, 'scripted:a', scriptedModel(playing([['computer_observe', {}]], box)))
  const run = await waitDone(state, (await state.runs.start(session, 'look')).id)
  const payload = box[0]!
  expect([rec(payload.screenshot).width, rec(payload.screenshot).height]).toEqual([7, 5])
  expect(typeof payload.screenshot_display_asset_id).toBe('string')
  expect(payload.screenshot_display_asset_id).not.toBe(rec(payload.screenshot).asset_id)
  const display = repo.getAsset(state.conn, payload.screenshot_display_asset_id as string)!
  expect([display.meta.width, display.meta.height]).toEqual([14, 10])
  expect(state.store.read(display.storage_path)).toEqual(displayBytes)
  const result = repo.listEvents(state.conn, run.id).find((event) => event.event === 'tool_result')!.data
  expect(result.screenshot_display_asset_id).toBe(display.id)
  expect(result.screenshot_asset_id).toBe(rec(payload.screenshot).asset_id)
  expect('display_image' in payload).toBe(false)
})

test('an invalid or oversized optional display picture does not lose the original computer screenshot', async () => {
  let display = Buffer.from('broken')
  const computer = fakeComputer(() => look({ display_image: { data_base64: display.toString('base64') } }))
  state = await appState({ computer, config: seeing() })
  const { session } = await openSession(state, buggyRepo())
  for (const bytes of [display, readFileSync(join(import.meta.dir, 'fixtures', 'images', 'red-3000x1.png')), Buffer.alloc(4 * 1024 * 1024 + 1)]) {
    display = bytes
    const box: Record<string, unknown>[] = []
    setModel(state, 'scripted:a', scriptedModel(playing([['computer_observe', {}]], box)))
    const run = await waitDone(state, (await state.runs.start(session, 'look', { fresh: true })).id)
    expect(run.status).toBe('done')
    expect(rec(box[0]!.screenshot).width).toBe(7)
    expect('screenshot_display_asset_id' in box[0]!).toBe(false)
  }
})

// ---- the agent browser's tabs: each run its own ------------------------------------------------------------------

/** A desktop app with tabs as the test plays it: a look names its tab and lists the run's own tabs (and, to prove the
 *  backend passes none on, a stray foreign one with an owner). */
function tabbedComputer(extra: (path: string, body: Record<string, unknown>) => Record<string, unknown> | null = () => null) {
  let current = 'tab-a'
  let n = 0
  return fakeComputer((path, body) => {
    const special = extra(path, body)
    if (special !== null) return special
    if (path === '/computer/release') return { status: 'ok', released: ['browser/tab-a'] }
    if (body.surface !== 'browser') return look({ surface: 'chatgpt', snapshot_id: 'chatgpt-1' })
    if (body.action === 'tab_new') current = 'tab-b'
    else if (typeof body.tab_id === 'string') current = body.tab_id
    n += 1
    const tabs = [{ tab_id: 'tab-a', url: 'https://example.com/', title: 'Example', current: current === 'tab-a', owner: body.owner, session: body.session },
      ...(current === 'tab-b' ? [{ tab_id: 'tab-b', url: 'about:blank', title: '', current: true }] : []),
      { tab_id: 'tab-x', url: 'https://secret.example/inbox', title: 'Someone else', current: false, owner: 'run_other' }]
    return look({ action: body.action, tab_id: current, tabs, snapshot_id: `browser-${n}` })
  })
}

test('test_computer_tabs_schema: observe takes tab_id; computer_act takes tab_id and tab_new/tab_select/tab_close; an older call (and proposal) without them parses as before', async () => {
  const { COMPUTER_ACTIONS, COMPUTER_TAB_ACTIONS, computerActSchema } = await import('@oasis-code/contract')
  const { parametersSchema, specOf } = await import('../src/agent/tools/registry.ts')
  expect(COMPUTER_ACTIONS.slice(-3)).toEqual(['tab_new', 'tab_select', 'tab_close'])
  expect([...COMPUTER_TAB_ACTIONS]).toEqual(['tab_new', 'tab_select', 'tab_close'])
  const act = rec(parametersSchema(specOf('computer_act')!))
  const observe = rec(parametersSchema(specOf('computer_observe')!))
  expect(Object.keys(rec(act.properties))).toContain('tab_id')
  expect(Object.keys(rec(observe.properties))).toContain('tab_id')
  expect(JSON.stringify(rec(act.properties).action)).toContain('tab_close')
  expect(String(rec(rec(act.properties).tab_id).description)).toContain("this run's tabs")
  // the gate's model of a proposal recorded before tabs
  const old = computerActSchema().parse({ surface: 'browser', action: 'click', ref: 'e7', snapshot_id: 'browser-1' })
  expect(old.tab_id).toBeNull()
  expect(gate.ARG_MODELS.computer_act!.parse({ action: 'navigate', url: 'https://example.com/' })).toMatchObject({ surface: 'browser', tab_id: null })
})

test("test_computer_tabs_bodies: a look's tab and the run's own tabs reach the model (no other run's); an action goes to its look's tab; tab_new/select/close go as given; owner and session are the run's whatever the model says", async () => {
  const computer = tabbedComputer()
  state = await appState({ computer })
  const { session } = await openSession(state, buggyRepo())
  const box: Record<string, unknown>[] = []
  setModel(state, 'scripted:a', scriptedModel(playing([
    ['computer_observe', { owner: 'run_other', session: 'ses_other', owner_label: 'Spoofed' }],
    ['computer_act', { action: 'tab_new', url: 'https://example.com/b', owner: 'run_other' }],
    ['computer_act', { action: 'click', ref: 'e7', snapshot_id: 'browser-1' }],          // a look of tab-a: goes there
    ['computer_act', { action: 'tab_select', tab_id: 'tab-b' }],
    ['computer_act', { action: 'reload' }],                                               // the run's latest answer's tab: tab-b
    ['computer_act', { action: 'tab_close' }],                                            // the latest tab, named
    ['computer_observe', { tab_id: 'tab-a', read_text: true }],
  ], box)))
  const run = await waitDone(state, (await state.runs.start(session, 'tabs')).id)
  const who = { owner: run.id, session: session.id }
  expect(computer.calls.map((c) => c[1])).toEqual([
    { surface: 'browser', ...who, screenshot: true },
    { surface: 'browser', ...who, action: 'tab_new', url: 'https://example.com/b' },
    { surface: 'browser', ...who, action: 'click', tab_id: 'tab-a', snapshot_id: 'browser-1', ref: 'e7' },
    { surface: 'browser', ...who, action: 'tab_select', tab_id: 'tab-b' },
    { surface: 'browser', ...who, action: 'reload', tab_id: 'tab-b' },
    { surface: 'browser', ...who, action: 'tab_close', tab_id: 'tab-b' },
    { surface: 'browser', ...who, action: 'read_text', tab_id: 'tab-a', offset: 0 },
    { owner: run.id },
  ])
  // the look names its tab and lists the run's own tabs only, each with what a look lists of it
  expect(box[0]!.tab_id).toBe('tab-a')
  expect(box[0]!.tabs).toEqual([{ tab_id: 'tab-a', url: 'https://example.com/', title: 'Example', current: true }])
  expect(JSON.stringify(box)).not.toContain('secret.example')
  expect(JSON.stringify(box)).not.toContain('run_other')
  expect('screenshot' in box[0]!).toBe(true)
})

test('test_computer_tabs_foreign_refusal_shows_nothing: an answer about a tab that is not one of the run\'s own carries no picture, outline, address or title, and keeps no screenshot', async () => {
  const computer = fakeComputer(() => look({ status: 'refused', reason: 'this run has no tab tab-x', tab_id: 'tab-x', tabs: [{ tab_id: 'tab-a', url: 'https://example.com/', title: 'Example', current: true }],
    url: 'https://secret.example/inbox', title: 'Someone else', outline: '- button "Delete" [ref=e1]', display_image: { data_base64: JPEG.toString('base64') } }))
  state = await appState({ computer, config: seeing() })
  const { session } = await openSession(state, buggyRepo())
  const box: Record<string, unknown>[] = []
  setModel(state, 'scripted:a', scriptedModel(playing([['computer_observe', { tab_id: 'tab-x' }], ['computer_act', { action: 'reload', tab_id: 'tab-x' }]], box)))
  const run = await waitDone(state, (await state.runs.start(session, 'peek')).id)
  for (const out of box) {
    expect(out.status).toBe('refused')
    for (const key of ['screenshot', 'screenshot_display_asset_id', 'outline', 'url', 'title', 'tab_id', 'snapshot_id', 'untrusted']) expect(key in out).toBe(false)
    expect(out.tabs).toEqual([{ tab_id: 'tab-a', url: 'https://example.com/', title: 'Example', current: true }])
  }
  expect(JSON.stringify(box)).not.toContain('secret.example')
  const results = repo.listEvents(state.conn, run.id).filter((e) => e.event === 'tool_result').map((e) => e.data)
  expect(results.map((r) => [r.screenshot_asset_id, r.url, r.title])).toEqual([[null, null, null], [null, null, null]])
  expect(computer.calls[0]![1]).toEqual({ surface: 'browser', owner: run.id, session: session.id, tab_id: 'tab-x', screenshot: true })
})

test('test_computer_tabs_chatgpt_unchanged: tab_id and the tab actions are refused on chatgpt before anything reaches the app; its bodies are as before', async () => {
  const computer = tabbedComputer()
  state = await appState({ computer })
  const { session } = await openSession(state, buggyRepo())
  const box: Record<string, unknown>[] = []
  setModel(state, 'scripted:a', scriptedModel(playing([
    ['computer_act', { surface: 'chatgpt', action: 'tab_new' }],
    ['computer_act', { surface: 'chatgpt', action: 'tab_select', tab_id: 'tab-a' }],
    ['computer_act', { surface: 'chatgpt', action: 'tab_close' }],
    ['computer_act', { surface: 'chatgpt', action: 'reload', tab_id: 'tab-a' }],
    ['computer_observe', { surface: 'chatgpt', tab_id: 'tab-a' }],
    ['computer_act', { action: 'tab_select' }],                                            // the browser's, with no tab named
    ['computer_act', { action: 'tab_new', tab_id: 'tab-a' }],
    ['computer_observe', { surface: 'chatgpt' }],
  ], box)))
  const run = await waitDone(state, (await state.runs.start(session, 'chatgpt')).id)
  expect(box.slice(0, 7).map((b) => b.status)).toEqual(Array(7).fill('refused'))
  expect(String(box[0]!.reason)).toContain('for the browser surface')
  expect(String(box[5]!.reason)).toContain('tab_select needs tab_id')
  expect(computer.calls).toEqual([['/computer/observe', { surface: 'chatgpt', owner: run.id, session: session.id, screenshot: true }], ['/computer/release', { owner: run.id }]])
})

test('test_computer_tabs_owner_label: the label is the run\'s participant name from the session\'s records — none for a participant with no name of its own or only the model\'s name; never the page\'s words', async () => {
  const crepo = await import('../src/db/collab_repo.ts')
  const { ownerLabel } = await import('../src/agent/tools/computer.ts')
  const computer = tabbedComputer()
  state = await appState({ computer })
  const { session } = await openSession(state, buggyRepo())
  setModel(state, 'scripted:a', scriptedModel(playing([['computer_observe', {}]], [])))
  const first = await waitDone(state, (await state.runs.start(session, 'look')).id)
  expect(computer.calls[0]![1]).toEqual({ surface: 'browser', owner: first.id, session: session.id, screenshot: true })   // the main participant: no name of its own
  const pid = crepo.getRunMeta(state.conn, first.id)!.participant_id!
  expect(ownerLabel(state.conn, first.id)).toBeNull()
  state.conn.run('UPDATE participants SET label=? WHERE id=?', ['Reviewer\u0007 B', pid])
  expect(ownerLabel(state.conn, first.id)).toBe('Reviewer B')
  state.conn.run('UPDATE participants SET label=? WHERE id=?', ['Scripted A', pid])
  expect(ownerLabel(state.conn, first.id, 'Scripted A')).toBeNull()                          // a model's name says nothing of which run
  expect(ownerLabel(state.conn, 'run_missing')).toBeNull()
  state.conn.run('UPDATE participants SET label=? WHERE id=?', ['Reviewer', pid])
  computer.calls.length = 0
  setModel(state, 'scripted:a', scriptedModel(playing([['computer_observe', { owner_label: 'Page title' }], ['computer_act', { surface: 'chatgpt', action: 'reload' }]], [])))
  const second = await waitDone(state, (await state.runs.start(session, 'look again')).id)
  expect(crepo.getRunMeta(state.conn, second.id)!.participant_id).toBe(pid)
  expect(computer.calls[0]![1]).toEqual({ surface: 'browser', owner: second.id, session: session.id, owner_label: 'Reviewer', screenshot: true })
  expect(computer.calls[1]![1]).toEqual({ surface: 'chatgpt', owner: second.id, session: session.id, action: 'reload' })    // chatgpt: as before
})

test('test_computer_tabs_approval_keeps_its_tab: a proposal is bound to the tab of the look it names (not a later look), and its approval — after the run ended — goes there as that run, marked an approval, then lets go', async () => {
  const computer = tabbedComputer()
  state = await appState({ computer })
  const { session } = await openSession(state, buggyRepo())
  applySessionMode(state.conn, session, 'approve')
  setModel(state, 'scripted:a', scriptedModel(playing([
    ['computer_observe', {}],                                                              // browser-1, tab-a
    ['computer_observe', { tab_id: 'tab-b' }],                                             // browser-2, a later look of another tab
    ['computer_act', { action: 'click', ref: 'e7', snapshot_id: 'browser-1' }],
  ], [])))
  const run = await waitDone(state, (await state.runs.start(repo.getSession(state.conn, session.id)!, 'click')).id)
  expect(run.status).toBe('done')
  const proposal = gate.listProposals(state.conn, session.project_id, session.id).find((p) => p.status === 'pending')!
  expect(proposal.label).toBe('computer_act click e7 ("button \\"Go\\"") on browser in tab "tab-a", chosen on look browser-1')
  expect(gate.loadProposal(state.conn, state.store, proposal.proposal_asset_id).validated_args).toMatchObject({ tab_id: 'tab-a', snapshot_id: 'browser-1' })
  computer.calls.length = 0
  const decided = rec((await gate.decideProposal(state, proposal.proposal_asset_id, 'approve')).result)
  expect([decided.status, decided.tab_id]).toEqual(['ok', 'tab-a'])
  expect(computer.calls).toEqual([
    ['/computer/act', { surface: 'browser', owner: run.id, session: session.id, approval: true, action: 'click', tab_id: 'tab-a', snapshot_id: 'browser-1', ref: 'e7' }],
    ['/computer/release', { owner: run.id }],
  ])
})

test('test_computer_tabs_first_navigate_approval: a first navigate proposed with no look yet is bound to the run\'s own tab (a look without a picture); approved, it goes there — and a gone tab is stale, with nothing opened', async () => {
  let gone = false
  const computer = tabbedComputer((path, body) => (gone && path === '/computer/act' ? { status: 'stale', reason: 'the tab snapshot named was closed; nothing was done' } : null))
  state = await appState({ computer })
  const { session } = await openSession(state, buggyRepo())
  applySessionMode(state.conn, session, 'approve')
  setModel(state, 'scripted:a', scriptedModel(playing([['computer_act', { action: 'navigate', url: 'https://example.com/a' }]], [])))
  const run = await waitDone(state, (await state.runs.start(repo.getSession(state.conn, session.id)!, 'go')).id)
  expect(computer.calls).toEqual([['/computer/observe', { surface: 'browser', owner: run.id, session: session.id, screenshot: false }], ['/computer/release', { owner: run.id }]])
  const proposal = gate.listProposals(state.conn, session.project_id, session.id).find((p) => p.status === 'pending')!
  expect(proposal.label).toBe('computer_act navigate to "https://example.com/a" on browser in tab "tab-a"')
  computer.calls.length = 0
  expect(rec((await gate.decideProposal(state, proposal.proposal_asset_id, 'approve')).result).status).toBe('ok')
  expect(computer.calls[0]).toEqual(['/computer/act', { surface: 'browser', owner: run.id, session: session.id, approval: true, action: 'navigate', tab_id: 'tab-a', url: 'https://example.com/a' }])
  // the same, its tab gone by the time it is approved (closed, reaped, the data cleared): stale, and only let go after
  setModel(state, 'scripted:a', scriptedModel(playing([['computer_act', { action: 'navigate', url: 'https://example.com/b' }]], [])))
  await waitDone(state, (await state.runs.start(repo.getSession(state.conn, session.id)!, 'go', { fresh: true })).id)
  const second = gate.listProposals(state.conn, session.project_id, session.id).find((p) => p.status === 'pending')!
  gone = true
  computer.calls.length = 0
  const stale = rec((await gate.decideProposal(state, second.proposal_asset_id, 'approve')).result)
  expect(stale.status).toBe('stale')
  expect(computer.calls.map((c) => [c[0], c[1].action ?? null, c[1].approval ?? null])).toEqual([['/computer/act', 'navigate', true], ['/computer/release', null, null]])
  // the tab actions are proposed like any computer action (Ask before changes), never let through on their own
  setModel(state, 'scripted:a', scriptedModel(playing([['computer_act', { action: 'tab_new' }]], [])))
  await waitDone(state, (await state.runs.start(repo.getSession(state.conn, session.id)!, 'tab', { fresh: true })).id)
  expect(gate.listProposals(state.conn, session.project_id, session.id).find((p) => p.status === 'pending')!.label).toBe('computer_act open a new tab on browser')
})

/** A desktop app whose tabs are per run: each run's first look opens `tab-<run>`; `tab_id` looks at that tab. Every
 *  look has a snapshot id of its own; a tab's look shows its own dialog and outline (`pages`). */
function perRunComputer(pages: Record<string, { dialog?: Record<string, unknown>; outline?: string }> = {}) {
  let n = 0
  return fakeComputer((path, body) => {
    if (path === '/computer/release') return { status: 'ok', released: [] }
    const tab = typeof body.tab_id === 'string' ? body.tab_id : `tab-${String(body.owner)}`
    n += 1
    const page = pages[tab] ?? {}
    return look({ action: body.action, tab_id: tab, tabs: [{ tab_id: tab, url: 'about:blank', title: '', current: true }], snapshot_id: `browser-${n}`,
      dialog: page.dialog ?? null, outline: page.outline ?? '- button "Go" [ref=e7]', ...(page.dialog ? { image: null } : {}) })
  })
}

test("test_computer_tabs_never_borrow_an_earlier_run's_tab: a run going on in the same conversation binds its first navigate to a tab of its own, and an earlier run's look is stale before anything", async () => {
  const computer = perRunComputer()
  state = await appState({ computer })
  const { session } = await openSession(state, buggyRepo())
  setModel(state, 'scripted:a', scriptedModel(playing([['computer_observe', {}]], [])))
  const first = await waitDone(state, (await state.runs.start(session, 'look')).id)
  expect(computer.calls[0]![1]).toEqual({ surface: 'browser', owner: first.id, session: session.id, screenshot: true })    // browser-1 of tab-<first>
  applySessionMode(state.conn, session, 'approve')
  computer.calls.length = 0
  const box: Record<string, unknown>[] = []
  setModel(state, 'scripted:a', scriptedModel(playing([
    ['computer_act', { action: 'click', ref: 'e7', snapshot_id: 'browser-1' }],           // the earlier run's look
    ['computer_act', { action: 'navigate', url: 'https://example.com/next' }],
  ], box)))
  const second = await waitDone(state, (await state.runs.start(repo.getSession(state.conn, session.id)!, 'go on')).id)
  expect(second.resumes_run_id ?? null).toBe(first.id)                                     // the same conversation: the earlier answers are in it
  expect([box[0]!.status, String(box[0]!.reason)]).toEqual(['stale', 'snapshot browser-1 is a look an earlier run took; this run has tabs of its own (look again with computer_observe). Nothing was done.'])
  expect(box[1]!.status).toBe('action_gated')
  // only the second run's own tab was asked for; the earlier run's tab is named nowhere
  expect(computer.calls).toEqual([['/computer/observe', { surface: 'browser', owner: second.id, session: session.id, screenshot: false }], ['/computer/release', { owner: second.id }]])
  const proposals = gate.listProposals(state.conn, session.project_id, session.id).filter((p) => p.status === 'pending')
  expect(proposals.map((p) => p.label)).toEqual([`computer_act navigate to "https://example.com/next" on browser in tab "tab-${second.id}"`])
  expect(JSON.stringify(gate.loadProposal(state.conn, state.store, proposals[0]!.proposal_asset_id))).not.toContain(`tab-${first.id}`)
})

test('test_computer_tabs_proposal_shows_its_own_look: with two tabs each showing a dialog, a proposal names the dialog and the ref of the look it was chosen on — never the other tab\'s later one', async () => {
  const computer = perRunComputer({
    'tab-a': { dialog: { type: 'confirm', message: 'Delete records?' }, outline: '- button "Archive in A" [ref=e7]' },
    'tab-b': { dialog: { type: 'confirm', message: 'Continue?' }, outline: '- button "Delete in B" [ref=e7]' },
  })
  state = await appState({ computer })
  const { session } = await openSession(state, buggyRepo())
  applySessionMode(state.conn, session, 'approve')
  setModel(state, 'scripted:a', scriptedModel(playing([
    ['computer_observe', { tab_id: 'tab-a' }],                                             // browser-1
    ['computer_observe', { tab_id: 'tab-b' }],                                             // browser-2, later
    ['computer_act', { action: 'dialog', accept: true, snapshot_id: 'browser-1' }],
    ['computer_act', { action: 'click', ref: 'e7', snapshot_id: 'browser-1' }],
  ], [])))
  await waitDone(state, (await state.runs.start(repo.getSession(state.conn, session.id)!, 'two tabs')).id)
  // (the reviewer's case: look A shows "Delete records?", a later look B "Continue?"; the answer on A's look must
  // show A's dialog — approving it on B's words would delete the records)
  const pending = gate.listProposals(state.conn, session.project_id, session.id).filter((p) => p.status === 'pending')
  const labels = pending.map((p) => p.label).sort()
  expect(labels).toEqual([
    'computer_act accept the open dialog (the confirm the run last saw: "Delete records?") on browser in tab "tab-a", chosen on look browser-1',
    'computer_act click e7 ("button \\"Archive in A\\"") on browser in tab "tab-a", chosen on look browser-1',
  ])
  expect(JSON.stringify(pending.map((p) => gate.loadProposal(state!.conn, state!.store, p.proposal_asset_id)))).not.toContain(' in B')
  expect(JSON.stringify(pending.map((p) => gate.loadProposal(state!.conn, state!.store, p.proposal_asset_id)))).not.toContain('Continue?')
  for (const p of pending) await gate.decideProposal(state, p.proposal_asset_id, 'reject')
  // a look named with a tab it is not of: no look matches exactly — nothing is described from any other look
  setModel(state, 'scripted:a', scriptedModel(playing([
    ['computer_observe', { tab_id: 'tab-a' }],                                             // browser-3
    ['computer_observe', { tab_id: 'tab-b' }],                                             // browser-4
    ['computer_act', { action: 'dialog', accept: true, snapshot_id: 'browser-3', tab_id: 'tab-b' }],
  ], [])))
  await waitDone(state, (await state.runs.start(repo.getSession(state.conn, session.id)!, 'mismatch', { fresh: true })).id)
  const mismatch = gate.listProposals(state.conn, session.project_id, session.id).find((p) => p.status === 'pending')!
  expect(mismatch.label).toBe('computer_act accept the open dialog (the run did not see which) on browser in tab "tab-b", chosen on look browser-3')
  expect(gate.loadProposal(state.conn, state.store, mismatch.proposal_asset_id).context).toBeNull()
})

/** A desktop app that keeps the run's tabs: a look with no tab current opens the next one; tab_close of the last one
 *  answers ok with no tab and no tabs. */
function closingComputer() {
  const open: string[] = []
  let current: string | null = null
  let made = 0
  let n = 0
  return fakeComputer((path, body) => {
    if (path === '/computer/release') return { status: 'ok', released: [] }
    if (body.action === 'tab_close') {
      const tab = String(body.tab_id ?? current)
      open.splice(open.indexOf(tab), 1)
      current = open.at(-1) ?? null
      return { status: 'ok', surface: 'browser', action: 'tab_close', done: { closed: tab }, ...(current ? { tab_id: current } : {}), tabs: open.map((t) => ({ tab_id: t, url: 'about:blank', title: '', current: t === current })) }
    }
    if (typeof body.tab_id === 'string') current = body.tab_id
    else if (current === null) { made += 1; current = `tab-${made}`; open.push(current) }
    n += 1
    return look({ action: body.action, tab_id: current, tabs: open.map((t) => ({ tab_id: t, url: 'about:blank', title: '', current: t === current })), snapshot_id: `browser-${n}` })
  })
}

test('test_computer_tabs_after_closing_the_last: once the run closed its last tab, an action naming no tab is bound to none of the closed ones — directly it goes with no tab (a new one is opened), asked before changes it is bound to the new own tab', async () => {
  const computer = closingComputer()
  state = await appState({ computer })
  const { session } = await openSession(state, buggyRepo())
  setModel(state, 'scripted:a', scriptedModel(playing([
    ['computer_observe', {}],                                                              // opens tab-1
    ['computer_act', { action: 'tab_close' }],                                             // bound to tab-1; the last: none current
    ['computer_act', { action: 'navigate', url: 'https://example.com/a' }],
  ], [])))
  const run = await waitDone(state, (await state.runs.start(session, 'close then go')).id)
  expect(computer.calls.filter((c) => c[0] === '/computer/act').map((c) => c[1])).toEqual([
    { surface: 'browser', owner: run.id, session: session.id, action: 'tab_close', tab_id: 'tab-1' },
    { surface: 'browser', owner: run.id, session: session.id, action: 'navigate', url: 'https://example.com/a' },
  ])
  // asked before changes (the session's mode turned on mid-run, after the close): bound to the run's new own tab
  computer.calls.length = 0
  let step = 0
  setModel(state, 'scripted:a', scriptedModel(() => {
    step += 1
    if (step === 1) return modelResponse([toolCallPart('computer_observe', {}, '')])
    if (step === 2) return modelResponse([toolCallPart('computer_act', { action: 'tab_close' }, '')])
    if (step === 3) { applySessionMode(state!.conn, repo.getSession(state!.conn, session.id)!, 'approve'); return modelResponse([toolCallPart('computer_act', { action: 'navigate', url: 'https://example.com/b' }, '')]) }
    return modelResponse([textPart('done')])
  }))
  const second = await waitDone(state, (await state.runs.start(repo.getSession(state.conn, session.id)!, 'again', { fresh: true })).id)
  expect(computer.calls.map((c) => [c[0], c[1].action ?? null, c[1].tab_id ?? null, c[1].screenshot ?? null])).toEqual([
    ['/computer/observe', null, null, true], ['/computer/act', 'tab_close', 'tab-2', null], ['/computer/observe', null, null, false], ['/computer/release', null, null, null],
  ])
  const proposal = gate.listProposals(state.conn, session.project_id, session.id).find((p) => p.status === 'pending')!
  expect(proposal.run_id).toBe(second.id)
  expect(gate.loadProposal(state.conn, state.store, proposal.proposal_asset_id).validated_args).toMatchObject({ action: 'navigate', tab_id: 'tab-3' })
})
