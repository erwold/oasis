/** ChatGPT on the web as a participant: a run on `chatgpt:web` is typed into the desktop app's ChatGPT page through
 *  its bridge (here a fake one) and its answer read back. Pinned here: the words sent carry no connector and none
 *  of the environment the page has no tool for; the progress streams; the answer, its pictures and the conversation's
 *  address are the run's; the participant's next run goes on in the same ChatGPT conversation; one answer forms at a
 *  time (the second run is queued and says so); Stop ends the wait (queued or answering) and clicks the page's stop;
 *  a page signed out, a bridge not there; the message's images handed to the page with its words; and an interaction — ChatGPT derives,
 *  Claude challenges with a tool, ChatGPT answers the challenge in its own conversation — hands each the other's
 *  answer as written. */

import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { agentMentionToken, type InteractionDetail, type Run } from '@oasis-code/contract'
import * as repo from '../src/db/repo.ts'
import { BridgeError, bridgeRequest, BRIDGE_TOKEN_FILE, BRIDGE_URL_FILE, ChatGptBridge, CHATGPT_WEB_ID, localBridgeUrl } from '../src/llm/chatgpt_web.ts'
import { tempDir } from './helpers.ts'
import { isRequest, isResponse, isUserPrompt, lastToolReturn, loadValue, modelResponse, textPart, toolCallPart, type ModelMessage } from '../src/llm/messages.ts'
import { isImagePiece } from '../src/llm/images.ts'
import type { App } from '../src/main.ts'
import { Client, json, makeApp } from './api_harness.ts'
import { legacyV1Director } from './director_surface_fixtures.ts'
import { buggyRepo, scriptedModel, setModel, sleep, testSettings, waitDone } from './harness.ts'
import { rec } from './tree_helpers.ts'

type Rec = Record<string, unknown>

let app: App | null = null
afterEach(async () => {
  if (app) await app.close()
  app = null
})

const CHATGPT = agentMentionToken('ChatGPT', CHATGPT_WEB_ID, 'pt_c0ffee')
const FABLE = agentMentionToken('Claude Fable 5.1', 'scripted:a', 'pt_fab1e5')
const PNG = readFileSync(join(import.meta.dir, 'fixtures', 'images', 'red-7x5.png')).toString('base64')

/** The desktop app's bridge as the runs reach it: one page, signed in or not, busy or not; every message a new
 *  conversation unless it names one; each answer what `answer` says for it, once `release` lets it go. */
function fakeBridge(answer: (body: Rec, sent: number) => Rec) {
  const state = {
    logged_in: true, busy: false, reachable: true, sent: [] as Rec[], stops: [] as Rec[], calls: [] as string[], conversations: 0,
    progress: new Map<string, Rec>(), answering: null as string | null,
    // hold: every answer waits for release(turn) — the page still forming it
    hold: false, released: new Set<string>(),
    notLoaded: null as string | null,
    refuseImages: null as string | null,
    // an agent acting on the page (computer use); a page that was given the message before with no sign it went
    inUse: null as string | null,
    unconfirmed: false,
    // what /answer says for every turn instead (a desktop app restarted since the message went)
    answerAs: null as Rec | null,
  }
  const release = (turnId: string) => { state.released.add(turnId) }
  const fetchImpl = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    if (!state.reachable) throw new TypeError('fetch failed')
    const url = new URL(typeof input === 'string' ? input : input.toString())
    state.calls.push(`${init?.method ?? 'GET'} ${url.pathname}`)
    if (new Headers(init?.headers as Record<string, string>).get('authorization') !== 'Bearer bridge-secret') return new Response('{"detail":"bad bridge token"}', { status: 401 })
    const body = init?.body ? (JSON.parse(String(init.body)) as Rec) : {}
    if (url.pathname === '/send') {
      if (state.notLoaded) return Response.json({ accepted: false, reason: 'page_not_loaded', detail: state.notLoaded })
      if (!state.logged_in) return Response.json({ accepted: false, reason: 'needs_login' })
      if (state.inUse) return Response.json({ accepted: false, reason: 'page_in_use', detail: state.inUse })
      if (state.unconfirmed) return Response.json({ accepted: false, reason: 'unconfirmed', detail: 'submitted at 12:00 with no sign that it went' })
      if (state.busy || state.answering !== null) return Response.json({ accepted: false, reason: 'generating' })
      if (state.refuseImages && body.images) return Response.json({ accepted: false, reason: 'images_not_attached', detail: state.refuseImages })
      state.sent.push(body)
      const conversation = typeof body.conversation_url === 'string' ? body.conversation_url : `https://chatgpt.com/c/conv-${(state.conversations += 1)}`
      state.answering = String(body.turn_id)
      return Response.json({ accepted: true, message_id: `m${state.sent.length}`, conversation: { url: conversation } })
    }
    if (url.pathname === '/answer') {
      const turn = url.searchParams.get('turn_id') ?? ''
      if (state.answerAs) return Response.json(state.answerAs)
      const at = state.sent.findIndex((b) => b.turn_id === turn)
      if (at < 0) return Response.json({ status: 'unknown' })
      if ((state.hold && !state.released.has(turn)) || state.answering !== turn) return Response.json({ status: 'generating', progress: state.progress.get(turn) ?? { thinking: '', text: '', steps: [] } })
      state.answering = null
      return Response.json({ status: 'done', model: 'GPT-6 Pro', ...answer(state.sent[at]!, at + 1) })
    }
    if (url.pathname === '/stop') {
      state.stops.push(body)
      if (state.answering === body.turn_id) state.answering = null
      return Response.json({ stopped: true })
    }
    return new Response('not found', { status: 404 })
  }
  return { state, fetchImpl, release }
}

async function session(bridge: ReturnType<typeof fakeBridge>) {
  const settings = testSettings()
  // the desktop app started its bridge on this data directory: its token is kept there, and the route is available
  mkdirSync(settings.data_dir, { recursive: true })
  writeFileSync(join(settings.data_dir, BRIDGE_TOKEN_FILE), 'bridge-secret\n', { mode: 0o600 })
  app = await makeApp(settings, { chatgpt: { url: 'http://bridge.test', model: () => 'gpt-6-pro', fetchImpl: bridge.fetchImpl, poll_ms: 10, busy_retry_ms: 20 } })
  const c = new Client(app)
  const project = await json(await c.post('/api/projects', { source_path: buggyRepo() }))
  const s = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'chatgpt' }))
  return { c, sid: s.id as string, project: project.id as string }
}

async function until<T>(read: () => T | Promise<T>, ok: (v: T) => boolean, what: string, timeoutMs = 10_000): Promise<T> {
  const end = Date.now() + timeoutMs
  for (;;) {
    const v = await read()
    if (ok(v)) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(10)
  }
}

const events = (runId: string) => app!.state.runs.handles.get(runId)!.events
const promptsOf = (messages: ModelMessage[]) => messages.filter(isRequest).flatMap((m) => m.parts).filter(isUserPrompt)
  .map((p) => (typeof p.content === 'string' ? p.content : p.content.filter((c): c is string => typeof c === 'string').join('\n')))

test('a run on ChatGPT: plain words to the page, no connector, no environment; the progress streams; the answer, its pictures and the conversation are the run\'s; the next run goes on there', async () => {
  const bridge = fakeBridge((body, n) => (n === 1
    ? { text: '推导如下：$$E = mc^2$$\n\n![图](sandbox:/mnt/data/plot.png)', thinking: 'Considering the units.', images: [{ name: 'plot.png', media_type: 'image/png', data_base64: PNG }] }
    : { text: `Continuing: ${String(body.text)}` }))
  const { c, sid } = await session(bridge)
  // the catalogue carries the route: words and images in, no tool of the harness, one answer at a time
  const models = (await json<{ models: Rec[] }>(await c.get('/api/models'))).models
  expect(models.find((m) => m.id === CHATGPT_WEB_ID)).toMatchObject({ label: 'ChatGPT', api: 'chatgpt-web', credential: 'available', capabilities: { images: true, tool_calls: false }, concurrency: 1 })
  bridge.state.hold = true
  const run = await json<Run>(await c.post(`/api/sessions/${sid}/chat`, { text: `${CHATGPT} 帮我推导质能方程`, agents: [{ model: CHATGPT_WEB_ID }] }))
  expect(run.model).toBe(CHATGPT_WEB_ID)
  await until(() => bridge.state.sent.length, (n) => n === 1, 'the send')
  const sent = bridge.state.sent[0]!
  // the person's words as a participant reads them (the chip as its name), in a new conversation, on the model the
  // person chose on the page; no connector, and nothing of the folders, the restrictions or the date
  expect(sent).toEqual({ text: '@ChatGPT 帮我推导质能方程', turn_id: run.id, new_conversation: true, model: 'gpt-6-pro' })
  // the page's progress reaches the thread while it forms
  bridge.state.progress.set(run.id, { thinking: 'Considering', text: '推导', steps: [] })
  await until(() => events(run.id).map((e) => e.event), (names) => names.includes('text_delta') && names.includes('thinking_delta'), 'progress')
  bridge.state.progress.set(run.id, { thinking: 'Considering the units.', text: '推导如下', steps: [] })
  await until(() => events(run.id).filter((e) => e.event === 'text_delta').length, (n) => n >= 2, 'more progress')
  bridge.release(run.id)
  const done = await waitDone(app!.state, run.id)
  expect(done.status).toBe('done')
  const deltas = events(run.id).filter((e) => e.event === 'text_delta').map((e) => e.data.text)
  expect(deltas.slice(0, 2)).toEqual(['推导', '如下'])                                   // each poll's new tail only
  // the answer: its picture kept as the session's attachment, pointed at where the page named it
  const assets = repo.listAssetsWithRole(app!.state.conn, done.project_id, 'image', 'attachment').filter((a) => a.meta.name === 'plot.png')
  expect(assets).toHaveLength(1)
  const final = String(done.receipt.final_text)
  expect(final).toBe(`推导如下：$$E = mc^2$$\n\n![图](/api/sessions/${sid}/attachments/${assets[0]!.id})`)
  expect(events(run.id).find((e) => e.event === 'text_block')!.data.text).toBe(final)
  expect(events(run.id).find((e) => e.event === 'thinking_block')!.data.text).toBe('Considering the units.')
  // measured: one message, no tool of the harness, tokens and cost unknown
  const mechanical = rec(done.receipt.mechanical)
  expect(mechanical.requests).toBe(1)
  expect(mechanical.tool_calls).toBe(0)
  expect(rec(mechanical.usage).input_tokens).toBeNull()
  expect(mechanical.cost_status).toBe('unknown')
  expect(done.manifest.chatgpt).toMatchObject({ conversation_url: 'https://chatgpt.com/c/conv-1', new_conversation: true, chatgpt_model: 'gpt-6-pro', answered_by: 'GPT-6 Pro', images: 1 })
  expect(done.manifest.tools).toEqual([])
  // the record: the words sent and the answer, a response of another system for any later route
  const history = loadValue(JSON.parse(repo.getRunHistory(app!.state.conn, run.id)!)) as ModelMessage[]
  expect(promptsOf(history)).toEqual(['@ChatGPT 帮我推导质能方程'])
  const response = history.find(isResponse)!
  expect(response.provider_name).toBe(CHATGPT_WEB_ID)
  expect(response.parts.map((p) => p.part_kind)).toEqual(['thinking', 'text'])
  // the session's next message (its model is ChatGPT's now) goes on in the same ChatGPT conversation
  bridge.state.hold = false
  expect(repo.getSession(app!.state.conn, sid)!.model).toBe(CHATGPT_WEB_ID)
  const next = await json<Run>(await c.post(`/api/sessions/${sid}/chat`, { text: '再详细一点' }))
  expect(next.resumes_run_id).toBe(run.id)
  const second = await waitDone(app!.state, next.id)
  expect(bridge.state.sent[1]).toEqual({ text: '再详细一点', turn_id: next.id, new_conversation: false, conversation_url: 'https://chatgpt.com/c/conv-1', model: 'gpt-6-pro' })
  expect(second.receipt.final_text).toBe('Continuing: 再详细一点')
  expect(promptsOf(loadValue(JSON.parse(repo.getRunHistory(app!.state.conn, next.id)!)) as ModelMessage[])).toEqual(['@ChatGPT 帮我推导质能方程', '再详细一点'])
  // a later route reads the exchange as a handoff from ChatGPT (a model of another system)
  setModel(app!.state, 'scripted:a', scriptedModel(() => modelResponse([textPart('read')])))
  const claude = await json<Run>(await c.post(`/api/sessions/${sid}/chat`, { text: `${FABLE} check it`, agents: [{ model: 'scripted:a' }] }))
  const read = await waitDone(app!.state, claude.id)
  expect(read.status, read.error ?? 'the API route continues the web history').toBe('done')
  expect(rec(read.manifest.handoff).foreign_responses).toBe(2)
})

test("the message's images go to the page with its words, read from the session's attachments; the record keeps them; a page that did not take them sent nothing", async () => {
  const bridge = fakeBridge(() => ({ text: 'A red rectangle.' }))
  const { c, sid } = await session(bridge)
  const upload = async (name: string) => (await json(await c.app.app.request(`http://localhost/api/sessions/${sid}/attachments?name=${name}`, {
    method: 'POST', body: readFileSync(join(import.meta.dir, 'fixtures', 'images', 'red-7x5.png')), headers: { ...c.headers, 'content-type': 'application/octet-stream' },
  }))).asset_id as string
  const [first, second] = [await upload('red.png'), await upload('again.png')]
  const run = await json<Run>(await c.post(`/api/sessions/${sid}/chat`, { text: `${CHATGPT} what is this?`, agents: [{ model: CHATGPT_WEB_ID }], attachments: [first, second] }))
  const done = await waitDone(app!.state, run.id)
  expect(done.status).toBe('done')
  expect(bridge.state.sent[0]!.images).toEqual([{ name: 'red.png', media_type: 'image/png', data_base64: PNG }, { name: 'again.png', media_type: 'image/png', data_base64: PNG }])
  expect(bridge.state.sent[0]!.text).toBe('@ChatGPT what is this?')
  const history = loadValue(JSON.parse(repo.getRunHistory(app!.state.conn, run.id)!)) as ModelMessage[]
  const prompt = history.filter(isRequest).flatMap((m) => m.parts).filter(isUserPrompt)[0]!
  expect((prompt.content as unknown[]).filter(isImagePiece).map((p) => p.name)).toEqual(['red.png', 'again.png'])
  // words alone carry no images
  const words = await json<Run>(await c.post(`/api/sessions/${sid}/chat`, { text: 'and now?' }))
  await waitDone(app!.state, words.id)
  expect('images' in bridge.state.sent[1]!).toBe(false)
  // the page did not take them: the run fails saying so
  bridge.state.refuseImages = 'upload_timeout'
  const refused = await json<Run>(await c.post(`/api/sessions/${sid}/chat`, { text: 'once more', attachments: [first] }))
  const failed = await waitDone(app!.state, refused.id)
  expect(failed.status).toBe('error')
  expect(String(failed.error)).toContain("did not take the message's files (upload_timeout)")
  expect(bridge.state.sent).toHaveLength(2)
})

test('one answer forms at a time: a second run waits, queued and saying so, and goes once the first answered', async () => {
  const bridge = fakeBridge((body) => ({ text: `answer to ${String(body.text)}` }))
  const { c, sid, project } = await session(bridge)
  const other = await json(await c.post(`/api/projects/${project}/sessions`, { title: 'another' }))
  bridge.state.hold = true
  const first = await json<Run>(await c.post(`/api/sessions/${sid}/chat`, { text: `${CHATGPT} one`, agents: [{ model: CHATGPT_WEB_ID }] }))
  await until(() => bridge.state.sent.length, (n) => n === 1, 'the first send')
  const second = await json<Run>(await c.post(`/api/sessions/${other.id}/chat`, { text: `${CHATGPT} two`, agents: [{ model: CHATGPT_WEB_ID }] }))
  await until(() => repo.getRun(app!.state.conn, second.id)!.status, (s) => s === 'queued', 'the second run queued')
  const queued = events(second.id).find((e) => e.event === 'run_queued')!
  expect(String(queued.data.reason)).toContain('ChatGPT answers one message at a time')
  expect(queued.data.behind).toEqual([first.id])
  await sleep(60)
  expect(bridge.state.sent).toHaveLength(1)                                                // nothing typed while the page answers
  bridge.state.hold = false
  expect((await waitDone(app!.state, first.id)).status).toBe('done')
  const done = await waitDone(app!.state, second.id)
  expect(done.status).toBe('done')
  expect(done.receipt.final_text).toBe('answer to @ChatGPT two')
  expect(events(second.id).some((e) => e.event === 'slot_acquired')).toBe(true)
  // a page busy with a message of the person's (or a director's): the run waits for it, and says so once
  bridge.state.busy = true
  const third = await json<Run>(await c.post(`/api/sessions/${sid}/chat`, { text: 'three' }))
  await until(() => events(third.id).filter((e) => e.event === 'run_queued').length, (n) => n === 1, 'the busy note')
  expect(String(events(third.id).find((e) => e.event === 'run_queued')!.data.reason)).toContain("ChatGPT's page is answering another message")
  await sleep(80)
  bridge.state.busy = false
  expect((await waitDone(app!.state, third.id)).status).toBe('done')
  expect(events(third.id).filter((e) => e.event === 'run_queued')).toHaveLength(1)
  // an agent acting on the page (computer use): the run waits for it to let go, and says who holds it
  bridge.state.inUse = 'run_agent'
  const fourth = await json<Run>(await c.post(`/api/sessions/${sid}/chat`, { text: 'four' }))
  await until(() => events(fourth.id).filter((e) => e.event === 'run_queued').length, (n) => n === 1, 'the in-use note')
  expect(String(events(fourth.id).find((e) => e.event === 'run_queued')!.data.reason)).toContain("an agent is using ChatGPT's page (computer use, run_agent)")
  await sleep(80)
  expect(bridge.state.sent.map((b) => b.text)).not.toContain('four')
  bridge.state.inUse = null
  expect((await waitDone(app!.state, fourth.id)).status).toBe('done')
})

test('a message the page was given before with no sign that it went is not asked for again: the run says so', async () => {
  const bridge = fakeBridge(() => ({ text: 'never' }))
  const { c, sid } = await session(bridge)
  bridge.state.unconfirmed = true
  const run = await json<Run>(await c.post(`/api/sessions/${sid}/chat`, { text: `${CHATGPT} once only`, agents: [{ model: CHATGPT_WEB_ID }] }))
  const done = await waitDone(app!.state, run.id)
  expect(done.status).toBe('error')
  expect(done.error).toContain('it is not sent again')
  expect(bridge.state.calls.filter((call) => call === 'POST /send')).toHaveLength(1)
  expect(bridge.state.sent).toEqual([])
})

test('an answer the page cannot read back (the desktop app restarted after the message went) ends the run at once, not sent again', async () => {
  const bridge = fakeBridge(() => ({ text: 'never' }))
  const { c, sid } = await session(bridge)
  bridge.state.answerAs = { status: 'lost', reason: 'restarted', detail: 'the message went at 12:00, before the desktop app restarted; its answer is on the ChatGPT page' }
  const run = await json<Run>(await c.post(`/api/sessions/${sid}/chat`, { text: `${CHATGPT} once only`, agents: [{ model: CHATGPT_WEB_ID }] }))
  const done = await waitDone(app!.state, run.id)
  expect(done.status).toBe('error')
  expect(done.error).toContain('before the desktop app restarted')
  expect(done.error).toContain('it is not sent again')
  expect(bridge.state.sent).toHaveLength(1)
})

test('Stop ends the wait: an answer forming is stopped on the page; a queued run is never sent', async () => {
  const bridge = fakeBridge(() => ({ text: 'never read' }))
  const { c, sid, project } = await session(bridge)
  const other = await json(await c.post(`/api/projects/${project}/sessions`, { title: 'another' }))
  bridge.state.hold = true
  const answering = await json<Run>(await c.post(`/api/sessions/${sid}/chat`, { text: `${CHATGPT} a long proof`, agents: [{ model: CHATGPT_WEB_ID }] }))
  await until(() => bridge.state.sent.length, (n) => n === 1, 'the send')
  const waiting = await json<Run>(await c.post(`/api/sessions/${other.id}/chat`, { text: `${CHATGPT} after it`, agents: [{ model: CHATGPT_WEB_ID }] }))
  await until(() => repo.getRun(app!.state.conn, waiting.id)!.status, (s) => s === 'queued', 'queued')
  expect((await json(await c.post(`/api/runs/${waiting.id}/cancel`, {}))).cancelled).toBe(true)
  expect((await waitDone(app!.state, waiting.id)).status).toBe('cancelled')
  expect((await json(await c.post(`/api/runs/${answering.id}/cancel`, {}))).cancelled).toBe(true)
  const stopped = await waitDone(app!.state, answering.id)
  expect(stopped.status).toBe('cancelled')
  expect(bridge.state.stops).toEqual([{ turn_id: answering.id }])
  expect(bridge.state.sent.map((b) => b.turn_id)).toEqual([answering.id])                  // the queued one never reached the page
  expect(bridge.state.answering).toBeNull()
  // a run left queued by a process that died is ended at the next start, as a running one is
  repo.setRunStatus(app!.state.conn, waiting.id, 'queued')
  const report = await app!.state.runs.reconcile()
  expect(report.dead_runs).toEqual([waiting.id])
  expect(repo.getRun(app!.state.conn, waiting.id)!.status).toBe('error')
})

test('a page signed out, a bridge not there: the run fails at once with what it means', async () => {
  const bridge = fakeBridge(() => ({ text: 'unused' }))
  const { c, sid } = await session(bridge)
  bridge.state.logged_in = false
  const signedOut = await waitDone(app!.state, (await json<Run>(await c.post(`/api/sessions/${sid}/chat`, { text: `${CHATGPT} hi`, agents: [{ model: CHATGPT_WEB_ID }] }))).id)
  expect(signedOut.status).toBe('error')
  expect(signedOut.error).toContain('ChatGPT is not signed in')
  expect(repo.listEvents(app!.state.conn, signedOut.id, -1).find((e) => e.event === 'error')!.data).toMatchObject({ kind: 'chatgpt_signin', model: CHATGPT_WEB_ID })
  bridge.state.logged_in = true
  bridge.state.reachable = false
  const away = await waitDone(app!.state, (await json<Run>(await c.post(`/api/sessions/${sid}/chat`, { text: 'hi again' }))).id)
  expect(away.status).toBe('error')
  expect(away.error).toContain('ChatGPT runs through the oasis-code desktop app')
  expect(repo.listEvents(app!.state.conn, away.id, -1).find((e) => e.event === 'error')!.data.kind).toBe('chatgpt_unreachable')
  expect(bridge.state.sent).toHaveLength(0)
  // the page there but not loaded (its proxy refused the tunnel): said as such, never as a sign-in
  bridge.state.reachable = true
  bridge.state.notLoaded = 'ERR_TUNNEL_CONNECTION_FAILED (-111)'
  const unloaded = await waitDone(app!.state, (await json<Run>(await c.post(`/api/sessions/${sid}/chat`, { text: 'once more' }))).id)
  expect(unloaded.error).toContain("the desktop app's ChatGPT page did not load (ERR_TUNNEL_CONNECTION_FAILED (-111))")
  expect(repo.listEvents(app!.state.conn, unloaded.id, -1).find((e) => e.event === 'error')!.data.kind).toBe('chatgpt_unreachable')
})

test('an interaction: ChatGPT derives, Claude challenges it, ChatGPT answers the challenge in its own conversation — each handed the other\'s words as written', async () => {
  const DERIVATION = 'DERIVATION: from E^2 = (pc)^2 + (mc^2)^2 at p = 0, E = mc^2.'
  const bridge = fakeBridge((body, n) => ({ text: n === 1 ? DERIVATION : `REPLY: the rest frame is chosen on purpose. (I was handed: ${String(body.text).includes('CHALLENGE') ? 'the challenge' : 'nothing'})` }))
  const { c, sid } = await session(bridge)
  const fable: ModelMessage[][] = []
  setModel(app!.state, 'scripted:a', scriptedModel((messages: ModelMessage[]) => {
    fable.push(messages)
    if (!lastToolReturn(messages, 'read_file')) return modelResponse([toolCallPart('read_file', { path: 'calc.py' }, '')])
    return modelResponse([textPart('CHALLENGE: p = 0 assumes the rest frame; say why that is general.')])
  }))
  // the director (the router): ChatGPT first, Claude handed its answer, ChatGPT handed Claude's — in its own conversation
  setModel(app!.state, 'scripted:b', scriptedModel((messages: ModelMessage[]) => {
    const last = promptsOf(messages).at(-1)!
    const planning = /Plan interaction (ix_[0-9a-f]+)/.exec(last)
    if (planning && !lastToolReturn(messages, 'schedule')) {
      return modelResponse([toolCallPart('schedule', {
        interaction_id: planning[1], then: 'stop',
        nodes: [
          { id: 'a1', participant: 'pt_c0ffee', depends_on: [], receives: [], workspace: 'own' },
          { id: 'b1', participant: 'pt_fab1e5', depends_on: ['a1'], receives: ['a1'], workspace: 'own', instruction: 'respond to the answer you were handed' },
          { id: 'a2', participant: 'pt_c0ffee', depends_on: ['b1'], receives: ['b1'], workspace: 'own', instruction: 'respond to the answer you were handed' },
        ],
      }, '')])
    }
    return modelResponse([textPart('Planned.')])
  }, 'scripted-b'))
  const text = `${CHATGPT} 帮我推导质能方程，然后 ${FABLE} 你来质疑这个公式，${CHATGPT} 再回应`
  legacyV1Director(app!.state, sid, { transport: 'native', model: 'scripted:b' })   // a pre-surface director row (director.v1): this test pins v1's planning texts; v2's are in test_collab_integration
  const detail = await json<InteractionDetail>(await c.post(`/api/sessions/${sid}/interactions`, { text, director_model: 'scripted:b' }))
  expect(detail.participants.map((p) => [p.id, p.label, p.model])).toEqual([['pt_c0ffee', 'ChatGPT', CHATGPT_WEB_ID], ['pt_fab1e5', 'Claude Fable 5.1', 'scripted:a']])
  const end = Date.now() + 30_000
  let done = detail
  while (!['done', 'error', 'waiting', 'cancelled'].includes(done.status)) {
    if (Date.now() > end) throw new Error(`interaction is ${done.status}`)
    await sleep(20)
    done = await json<InteractionDetail>(await c.get(`/api/interactions/${detail.id}`))
  }
  expect(done.status).toBe('done')
  expect(done.nodes.map((n) => [n.id, n.status])).toEqual([['a1', 'done'], ['b1', 'done'], ['a2', 'done']])
  const [first, second] = bridge.state.sent
  // ChatGPT's first step: the roster and the step's note, then the person's words — nothing of a working copy
  expect(first!.new_conversation).toBe(true)
  expect(first!.mention).toBeUndefined()
  expect(String(first!.text)).toContain('pt_c0ffee: ChatGPT (chatgpt:web)\npt_fab1e5: Claude Fable 5.1 (scripted:a)\nYou are pt_c0ffee.')
  expect(String(first!.text)).toContain('Step a1 of the plan')
  expect(String(first!.text)).toEndWith('@pt_c0ffee 帮我推导质能方程，然后 @pt_fab1e5 你来质疑这个公式，@pt_c0ffee 再回应')
  for (const words of [first!.text, second!.text]) {
    expect(String(words)).not.toMatch(/Working (copy|folder)|Temporary folder|File restrictions|Date: /)
  }
  // Claude is handed ChatGPT's derivation as written
  const claudeSaw = promptsOf(fable.at(-1)!).join('\n')
  expect(claudeSaw).toMatch(/Step a1 \(pt_c0ffee, run run_[0-9a-f]+\):\nDERIVATION: from E\^2 = \(pc\)\^2 \+ \(mc\^2\)\^2 at p = 0, E = mc\^2\./)
  // ChatGPT's second step goes on in its own conversation, handed Claude's challenge as written: its tool call as a
  // line, without the tools that read a result again (ChatGPT has none of them)
  expect(second!.conversation_url).toBe('https://chatgpt.com/c/conv-1')
  expect(second!.new_conversation).toBe(false)
  expect(String(second!.text)).toContain('Step a2 of the plan (2 of 3 steps ended). Speaker: pt_c0ffee.\nAfter: b1.\nHanded the answers of: b1.')
  expect(String(second!.text)).toMatch(/Step b1 \(pt_fab1e5, run run_[0-9a-f]+\):\nCHALLENGE: p = 0 assumes the rest frame; say why that is general\.\nTool calls \(1\):\n\[read_file calc\.py → ok/)
  expect(String(second!.text)).not.toContain('bash_output')
  expect(String(second!.text)).not.toContain('DERIVATION')                                   // its own answer is in its conversation already
  const a2 = repo.getRun(app!.state.conn, done.nodes[2]!.run_id!)!
  expect(a2.resumes_run_id).toBe(done.nodes[0]!.run_id)
  expect(a2.receipt.final_text).toBe('REPLY: the rest frame is chosen on purpose. (I was handed: the challenge)')
})

test('where the desktop app never started its bridge, the route is there but not available, and a group naming it is refused', async () => {
  app = await makeApp()
  const c = new Client(app)
  const models = (await json<{ models: Rec[] }>(await c.get('/api/models'))).models
  expect(models.find((m) => m.id === CHATGPT_WEB_ID)).toMatchObject({ credential: 'unavailable', credential_hint: 'open ChatGPT in the oasis-code desktop app', account: 'chatgpt-web' })
  const project = await json(await c.post('/api/projects', { source_path: buggyRepo() }))
  const s = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'no page' }))
  const refused = await json(await c.post(`/api/sessions/${s.id}/interactions`, { text: `${CHATGPT} and ${FABLE}`, plan: { template: 'independent' } }), 400)
  expect(String(refused.detail)).toContain('ChatGPT has no credential here (open ChatGPT in the oasis-code desktop app)')
})

test("the bridge is where the desktop app wrote it, read at every call: an attached backend started without the app's port finds it", () => {
  const dir = tempDir('oasis-bridge-url-')
  const saved = { url: process.env.OASIS_CODE_BRIDGE_URL, port: process.env.OASIS_CODE_BRIDGE_PORT }
  delete process.env.OASIS_CODE_BRIDGE_URL
  delete process.env.OASIS_CODE_BRIDGE_PORT
  try {
    const bridge = new ChatGptBridge(dir)
    expect(bridge.url).toBe('http://127.0.0.1:8323')                                 // nothing written: the default
    writeFileSync(join(dir, BRIDGE_URL_FILE), 'http://127.0.0.1:8343\n')
    expect(bridge.url).toBe('http://127.0.0.1:8343')                                 // the app started it on 8343 since
    process.env.OASIS_CODE_BRIDGE_PORT = '8399'
    expect(localBridgeUrl(dir)).toBe('http://127.0.0.1:8343')                        // the app's word over a port in the env
    writeFileSync(join(dir, BRIDGE_URL_FILE), 'https://elsewhere.example:443')
    expect(localBridgeUrl(dir)).toBe('http://127.0.0.1:8399')                        // only a loopback address is taken
    process.env.OASIS_CODE_BRIDGE_URL = 'http://127.0.0.1:9100/'
    expect(localBridgeUrl(dir)).toBe('http://127.0.0.1:9100')                        // an explicit address wins
    expect(new ChatGptBridge(dir, { url: 'http://bridge.test/' }).url).toBe('http://bridge.test')
  } finally {
    if (saved.url === undefined) delete process.env.OASIS_CODE_BRIDGE_URL; else process.env.OASIS_CODE_BRIDGE_URL = saved.url
    if (saved.port === undefined) delete process.env.OASIS_CODE_BRIDGE_PORT; else process.env.OASIS_CODE_BRIDGE_PORT = saved.port
  }
})

test('a bridge that is there but slow is said to be slow, not absent', async () => {
  const slow = (_input: string | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
  })
  const late = await bridgeRequest(slow, 'http://127.0.0.1:8323', 't', 'POST', '/send', { text: 'x' }, undefined, 30).catch((e) => e)
  expect(late).toBeInstanceOf(BridgeError)
  expect(late.kind).toBe('timeout')
  expect(late.message).toContain('did not answer POST /send within 0 s')
  const absent = await bridgeRequest(() => Promise.reject(new TypeError('fetch failed')), 'http://127.0.0.1:8323', 't', 'GET', '/state').catch((e) => e)
  expect(absent.kind).toBe('unreachable')
})

test('a connection that drops after the bridge took the message is a message that may have been sent, never a bridge not there', async () => {
  // a real loopback server that reads the body and drops the socket
  let took = 0
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (d) => { body += String(d) })
    req.on('end', () => { if (body) took += 1; res.socket?.destroy() })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  try {
    const port = (server.address() as { port: number }).port
    const dropped = await bridgeRequest(fetch, `http://127.0.0.1:${port}`, 't', 'POST', '/send', { text: 'x', turn_id: 't' }).catch((e) => e)
    expect(took).toBe(1)
    expect(dropped).toBeInstanceOf(BridgeError)
    expect(dropped.kind).toBe('lost')
  } finally { server.close() }
  // a run whose /send reply was lost says the message may have gone
  const bridge = fakeBridge(() => ({ text: 'unused' }))
  const fake = bridge.fetchImpl
  const { c, sid } = await session({ ...bridge, fetchImpl: async (input, init) => {
    if (new URL(String(input)).pathname === '/send') { await fake(input, init); throw new TypeError('socket hang up') }
    return fake(input, init)
  } })
  const run = await waitDone(app!.state, (await json<Run>(await c.post(`/api/sessions/${sid}/chat`, { text: `${CHATGPT} a task`, agents: [{ model: CHATGPT_WEB_ID }] }))).id)
  expect(bridge.state.sent).toHaveLength(1)
  expect(run.status).toBe('error')
  expect(run.error).toContain('it may have been sent')
  expect(run.error).not.toContain('nothing answers')
})

test('a Stop while the message is still with the page tells the page, which drops it; a Stop the page could not carry out says so', async () => {
  const bridge = fakeBridge(() => ({ text: 'never read' }))
  const fake = bridge.fetchImpl
  let uploading = true
  let stopReply: Rec = { stopped: true, sent: false }
  const { c, sid } = await session({ ...bridge, fetchImpl: async (input, init) => {
    const path = new URL(String(input)).pathname
    // the page uploads the message's files for a long while: the reply waits
    if (path === '/send' && uploading) {
      bridge.state.calls.push('POST /send')
      return await new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)) })
    }
    if (path === '/stop') { await fake(input, init); return Response.json(stopReply) }
    return fake(input, init)
  } })
  const early = await json<Run>(await c.post(`/api/sessions/${sid}/chat`, { text: `${CHATGPT} a long upload`, agents: [{ model: CHATGPT_WEB_ID }] }))
  await until(() => bridge.state.calls.includes('POST /send'), (on) => on, 'the send')
  expect((await json(await c.post(`/api/runs/${early.id}/cancel`, {}))).cancelled).toBe(true)
  const dropped = await waitDone(app!.state, early.id)
  expect(dropped.status).toBe('cancelled')
  expect(dropped.error ?? null).toBeNull()
  expect(bridge.state.stops).toEqual([{ turn_id: early.id }])
  // sent, and the page's stop button did not end the answer: the run says the answer still forms there
  uploading = false
  bridge.state.hold = true
  stopReply = { stopped: false, reason: 'still_generating' }
  const late = await json<Run>(await c.post(`/api/sessions/${sid}/chat`, { text: `${CHATGPT} a long proof`, agents: [{ model: CHATGPT_WEB_ID }] }))
  await until(() => bridge.state.sent.length, (n) => n === 1, 'the send')
  expect((await json(await c.post(`/api/runs/${late.id}/cancel`, {}))).cancelled).toBe(true)
  const forming = await waitDone(app!.state, late.id)
  expect(forming.status).toBe('cancelled')
  expect(forming.error).toContain('the answer still forms there')
  expect((repo.getRun(app!.state.conn, late.id)!.manifest.chatgpt as Rec).stop).toBe(forming.error!)
})

test('a signed-in page with no composer the app knows is said to have changed, not to be signed out', async () => {
  const bridge = fakeBridge(() => ({ text: 'unused' }))
  const fake = bridge.fetchImpl
  const { c, sid } = await session({ ...bridge, fetchImpl: async (input, init) => (new URL(String(input)).pathname === '/send' ? Response.json({ accepted: false, reason: 'no_composer' }) : fake(input, init)) })
  const run = await waitDone(app!.state, (await json<Run>(await c.post(`/api/sessions/${sid}/chat`, { text: `${CHATGPT} hi`, agents: [{ model: CHATGPT_WEB_ID }] }))).id)
  expect(run.status).toBe('error')
  expect(run.error).toContain('shows no message box the app knows')
  expect(run.error).not.toContain('not signed in')
})
