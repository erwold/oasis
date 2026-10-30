/** generate_image: one tool for every agent, an image made (no reference) or edited (references) by the ChatGPT
 *  subscription's own image endpoints — the Codex backend's /images/generations and /images/edits, signed with the
 *  person's Codex sign-in for exactly those two paths. One request a call (no retry, no other route), the gate
 *  before the credentials, the result kept as the session's attachment and measured from its bytes (never the size
 *  asked for), and the model told what was asked, not which model the service used (it does not say). Every request
 *  here goes to a fake: nothing leaves the machine. */

import { afterEach, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { GrantsSchema, type ImageAttachment, type Session } from '@oasis-code/contract'
import { saveAttachment } from '../src/api/attachments.ts'
import * as authModels from '../src/auth/models.ts'
import { NativeAuthError } from '../src/auth/errors.ts'
import { OAuthCredential } from '../src/auth/store.ts'
import * as registry from '../src/agent/tools/registry.ts'
import { specOf, visibleToolNames } from '../src/agent/tools/registry.ts'
import { parseWorkOrder } from '../src/agent/work_orders.ts'
import * as repo from '../src/db/repo.ts'
import { rebuildTranscript } from '../src/agent/transcript.ts'
import { ModelConfig } from '../src/config.ts'
import { isRequest, isUserPrompt, lastToolReturn, modelResponse, textPart, toolCallPart, type ModelMessage } from '../src/llm/messages.ts'
import type { Script } from '../src/llm/scripted.ts'
import { appState, buggyRepo, closeState, openSession, scriptedModel, setModel, testConfig, waitDone, type AppState } from './harness.ts'
import { solidPng } from './png_fixture.ts'
import { rec } from './tree_helpers.ts'

const ACCESS = 'FAKE-ACCESS-TOKEN-0123456789'
const ACCOUNT = 'acct-fake-42'
const RED = solidPng(40, 30, [220, 20, 20])
const BLUE = solidPng(24, 24, [20, 20, 220])
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')

// the tool's module and its seams, loaded where they exist (a build without the tool runs every test body and fails
// on what it does, not on an import)
type ImageHooks = { setImageHooks: (h: Record<string, unknown>) => void; resetImageHooks: () => void }
const images: ImageHooks | null = await import('../src/agent/tools/images.ts').then((m) => m as unknown as ImageHooks).catch(() => null)
const setImageHooks = (h: Record<string, unknown>) => images?.setImageHooks(h)
const signerOf = (authModels as Record<string, unknown>).codexImageSigner as ((g: unknown) => (r: { url: URL; headers: Headers; body: string }) => Promise<void>) | undefined
const withoutTools = (registry as Record<string, unknown>).withoutToolsForTest as ((names: string[]) => { restore: () => void }) | undefined

let state: AppState | null = null
afterEach(async () => { images?.resetImageHooks(); if (state) await closeState(state); state = null })

interface Seen { url: string; headers: Record<string, string>; body: Record<string, unknown>; signal: AbortSignal | null }

/** A fake image service: answers each request with `reply`, keeps what was asked. */
function fakeService(reply: (seen: Seen, n: number) => Response | Promise<Response>) {
  const seen: Seen[] = []
  const grants = { reads: 0 }
  const fetchImpl = async (input: string | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((v, k) => { headers[k] = v })
    const s: Seen = { url: String(input), headers, body: JSON.parse(String(init?.body ?? '{}')), signal: init?.signal ?? null }
    seen.push(s)
    return reply(s, seen.length)
  }
  const source = { access: async (provider: string) => {
    grants.reads += 1
    if (provider !== 'openai-codex') throw new Error('unexpected provider')
    return new OAuthCredential({ access: ACCESS, refresh: 'FAKE-REFRESH', expires_ms: Date.now() + 3_600_000, account_id: ACCOUNT, email: null })
  } }
  setImageHooks({ fetchImpl, grants: source })
  return { seen, grants }
}

const ok = (png: Uint8Array, extra: Record<string, unknown> = {}) => () => Response.json({ created: 1, background: 'opaque', data: [{ b64_json: b64(png), generation_id: 'g1' }], output_format: 'png', quality: 'low', size: '1305x1206', ...extra })

function visionConfig(images = true) {
  const config = testConfig()
  config.models = [new ModelConfig({ id: 'scripted:a', label: 'Scripted A', provider: 'anthropic', model: 'scripted-a', api_key_env: 'OASIS_TEST_KEY_A', capabilities: { images } })]
  return config
}

/** Where the latest message of the person begins. */
function lastPromptAt(messages: ModelMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!
    if (isRequest(m) && m.parts.some(isUserPrompt)) return i
  }
  return 0
}

/** Calls the tool once with `args`, keeps its return, answers. */
function calling(args: Record<string, unknown>, box: Record<string, unknown>): Script {
  return (messages) => {
    // this message's own call only: an earlier run's return in the history is not this one's
    const out = lastToolReturn(messages.slice(lastPromptAt(messages)), 'generate_image')
    if (!out) return modelResponse([toolCallPart('generate_image', args, '')])
    box.out = out
    return modelResponse([textPart('done')])
  }
}

async function runWith(st: AppState, session: Session, args: Record<string, unknown>, o: { text?: string; attachments?: ImageAttachment[] } = {}) {
  const box: Record<string, unknown> = {}
  setModel(st, 'scripted:a', scriptedModel(calling(args, box), 'scripted-a'))
  const run = await waitDone(st, (await st.runs.start(session, o.text ?? 'draw', { attachments: o.attachments ?? [] })).id)
  return { out: rec(box.out), run, events: repo.listEvents(st.conn, run.id) }
}

const imageAssets = (st: AppState, session: Session) =>
  st.conn.all('SELECT id FROM assets WHERE kind=\'image\' AND project_id=?', [session.project_id]).length

const resultOf = (events: { event: string; data: Record<string, unknown> }[]) => events.find((e) => e.event === 'tool_result' && e.data.tool === 'generate_image')!.data

test('generate_image is registered for every run (network effect, network gate), and only a new conversation is given it (an older one keeps its frozen list)', async () => {
  const spec = specOf('generate_image')!
  expect(spec.effect).toBe('network')
  expect(spec.action).toBe('network')
  expect(visibleToolNames({ order: null }).has('generate_image')).toBe(true)
  state = await appState()
  const { session } = await openSession(state, buggyRepo())
  const sent: string[][] = []
  setModel(state, 'scripted:a', scriptedModel((_m: ModelMessage[], info) => { sent.push(info.function_tools.map((t) => t.name)); return modelResponse([textPart('ok')]) }, 'scripted-a'))
  await waitDone(state, (await state.runs.start(session, 'hello')).id)
  expect(sent[0]).toContain('generate_image')
  // a conversation the build before this tool began keeps the list it was sent: its next run is not given the tool
  const older = await openSession(state, buggyRepo())
  const hidden = withoutTools?.(['generate_image', 'ssh_connect', 'ssh_hosts', 'ssh_directories', 'open_ssh_session', 'forward_port']) ?? { restore: () => {} }
  try { await waitDone(state, (await state.runs.start(older.session, 'before')).id) } finally { hidden.restore() }
  await waitDone(state, (await state.runs.start(older.session, 'after')).id)
  expect(sent[1]).not.toContain('generate_image')
  expect(sent[2]).toEqual(sent[1])
  // while a new conversation now is
  const fresh = await openSession(state, buggyRepo())
  await waitDone(state, (await state.runs.start(fresh.session, 'new')).id)
  expect(sent[3]).toEqual([...sent[1]!, 'generate_image', 'ssh_connect', 'ssh_hosts', 'ssh_directories', 'open_ssh_session', 'forward_port'])
})

test('the signer signs only the two image endpoints over HTTPS, and reads no grant for anything else', async () => {
  let reads = 0
  expect(typeof signerOf).toBe('function')
  const signer = signerOf!({ access: async () => { reads += 1; return new OAuthCredential({ access: ACCESS, refresh: 'r', expires_ms: Date.now() + 3_600_000, account_id: ACCOUNT, email: null }) } })
  for (const path of ['images/generations', 'images/edits']) {
    const headers = new Headers()
    await signer({ url: new URL(`https://chatgpt.com/backend-api/codex/${path}`), headers, body: '{}' })
    expect(headers.get('authorization')).toBe(`Bearer ${ACCESS}`)
    expect(headers.get('chatgpt-account-id')).toBe(ACCOUNT)
  }
  expect(reads).toBe(2)
  for (const url of ['https://chatgpt.com/backend-api/codex/responses', 'http://chatgpt.com/backend-api/codex/images/generations',
    'https://chatgpt.com.evil.example/backend-api/codex/images/generations', 'https://chatgpt.com:8443/backend-api/codex/images/edits',
    'https://chatgpt.com/backend-api/codex/images/generations?x=1', 'https://chatgpt.com/backend-api/codex/images/generations/extra',
    'https://api.openai.com/v1/images/generations']) {
    await expect(signer({ url: new URL(url), headers: new Headers(), body: '{}' })).rejects.toThrow(/unexpected endpoint/)
  }
  expect(reads).toBe(2)
})

test('a generation: one request with the thread headers, the image kept as the session attachment, measured from its bytes', async () => {
  state = await appState({ config: visionConfig() })
  const svc = fakeService(ok(RED))
  const { session } = await openSession(state, buggyRepo())
  const { out, run, events } = await runWith(state, session, { prompt: 'a red square' })
  expect(svc.seen).toHaveLength(1)
  const req = svc.seen[0]!
  expect(req.url).toBe('https://chatgpt.com/backend-api/codex/images/generations')
  expect(req.headers.authorization).toBe(`Bearer ${ACCESS}`)
  expect(req.headers['chatgpt-account-id']).toBe(ACCOUNT)
  const thread = `oasis:session:${session.id}`
  expect([req.headers['session-id'], req.headers['thread-id'], req.headers['x-client-request-id']]).toEqual([thread, thread, thread])
  expect(req.headers['x-codex-image-turn-id']).toBe(run.id)
  expect(req.headers.originator).toBe('oasis')
  expect(req.body).toEqual({ prompt: 'a red square', model: 'gpt-image-2', n: 1, size: '1024x640', quality: 'low', background: 'opaque' })
  expect(out.status).toBe('ok')
  expect(out.operation).toBe('generate')
  expect([out.width, out.height]).toEqual([40, 30])                          // the bytes', not the 1024x640 asked for
  expect(rec(out.requested)).toMatchObject({ model: 'gpt-image-2', size: '1024x640', quality: 'low', n: 1 })
  expect(out.actual_model).toBeNull()
  expect(rec(out.image).kind).toBe('image')
  const asset = repo.getAsset(state.conn, out.asset_id as string)!
  expect(asset.meta).toMatchObject({ role: 'attachment', session_id: session.id, width: 40, height: 30, media_type: 'image/png' })
  const result = resultOf(events)
  expect(result.generated).toBe(true)
  expect(result.shown).toEqual([{ asset_id: out.asset_id, width: 40, height: 30, label: expect.stringMatching(/\.png$/) }])
  expect(result.references).toBeUndefined()
  expect(result.requested_size).toBe('1024x640')
  // nothing secret or bulky in what the thread records
  const recorded = JSON.stringify(events) + JSON.stringify(repo.getRun(state.conn, run.id))
  expect(recorded).not.toContain(ACCESS)
  expect(recorded).not.toContain(ACCOUNT)
  expect(/[A-Za-z0-9+/]{1024,}/.test(recorded)).toBe(false)
})

test('an edit sends the session\'s own images: named by asset id, or the most recent ones in message order', async () => {
  state = await appState({ config: visionConfig() })
  const svc = fakeService((s) => ok(s.url.endsWith('/edits') ? BLUE : RED)())
  const { session } = await openSession(state, buggyRepo())
  const first = await runWith(state, session, { prompt: 'a red square' })
  const generated = first.out.asset_id as string
  const upload = saveAttachment({ conn: state.conn, store: state.store }, session, solidPng(16, 16, [0, 200, 0]), 'green.png')
  // recent_images 2: the generated image, then the person's attachment (the later message)
  const second = await runWith(state, session, { prompt: 'combine them', recent_images: 2 }, { text: 'combine', attachments: [upload] })
  expect(svc.seen).toHaveLength(2)
  const edit = svc.seen[1]!
  expect(edit.url).toBe('https://chatgpt.com/backend-api/codex/images/edits')
  expect((edit.body.images as { image_url: string }[]).map((i) => i.image_url)).toEqual([
    `data:image/png;base64,${b64(RED)}`, `data:image/png;base64,${b64(solidPng(16, 16, [0, 200, 0]))}`])
  expect(second.out.operation).toBe('edit')
  expect(rec(second.out.requested).references).toEqual([generated, upload.asset_id])
  expect(resultOf(second.events).references).toEqual([generated, upload.asset_id])
  expect([second.out.width, second.out.height]).toEqual([24, 24])
  // recent_images 1: the latest (the edit just made), counted once however often it appears
  const third = await runWith(state, session, { prompt: 'again', recent_images: 1 })
  expect(rec(third.out.requested).references).toEqual([second.out.asset_id])
  // by id
  const fourth = await runWith(state, session, { prompt: 'from the upload', reference_images: [upload.asset_id] })
  expect(rec(fourth.out.requested).references).toEqual([upload.asset_id])
  expect(svc.seen).toHaveLength(4)
})

test('references outside the session, paths, URLs, too many, or both ways at once are refused before any request', async () => {
  state = await appState({ config: visionConfig() })
  const svc = fakeService(ok(RED))
  const a = await openSession(state, buggyRepo())
  const b = await openSession(state, buggyRepo())
  const foreign = saveAttachment({ conn: state.conn, store: state.store }, b.session, solidPng(8, 8, [1, 2, 3]), 'theirs.png')
  const own = saveAttachment({ conn: state.conn, store: state.store }, a.session, solidPng(8, 8, [4, 5, 6]), 'mine.png')
  const cases: Record<string, unknown>[] = [
    { prompt: 'x', reference_images: [foreign.asset_id] },
    { prompt: 'x', reference_images: ['https://example.com/a.png'] },
    { prompt: 'x', reference_images: ['data:image/png;base64,AAAA'] },
    { prompt: 'x', reference_images: ['../secret.png'] },
    { prompt: 'x', reference_images: ['a', 'b', 'c', 'd', 'e', 'f'] },
    { prompt: 'x', reference_images: [own.asset_id], recent_images: 1 },
    { prompt: 'x', recent_images: 3 },                                          // the session has only one image
    { prompt: 'x', size: '1000x1000' },                                        // not multiples of 16
    { prompt: 'x', size: '512x512' },                                          // under the pixel minimum
    { prompt: '   ' },
  ]
  for (const args of cases) {
    const { out } = await runWith(state, a.session, args)
    expect(['refused', 'error'], JSON.stringify(args)).toContain(out.status as string)
    expect(JSON.stringify(out)).not.toContain(b.session.id)
  }
  expect(svc.seen).toHaveLength(0)
  expect(svc.grants.reads).toBe(0)
})

test('a 429 is reported with what the service said of its reset, once, nothing kept; a 500 the same', async () => {
  state = await appState({ config: visionConfig() })
  const svc = fakeService((_s, n) => n === 1
    ? Response.json({ error: { type: 'usage_limit_reached', message: 'The usage limit has been reached', resets_at: 1792258702 } }, { status: 429, headers: { 'retry-after': '30' } })
    : new Response('upstream broke', { status: 500 }))
  const { session } = await openSession(state, buggyRepo())
  const before = imageAssets(state, session)
  const limited = await runWith(state, session, { prompt: 'a' })
  expect(limited.out).toMatchObject({ status: 'error', http_status: 429, retry_after_s: 30, resets_at: 1792258702, retried: false })
  expect(limited.out.error_type).toBe('usage_limit_reached')
  expect(svc.seen).toHaveLength(1)
  const broken = await runWith(state, session, { prompt: 'b' })
  expect(broken.out).toMatchObject({ status: 'error', http_status: 500, retried: false })
  expect(svc.seen).toHaveLength(2)
  expect(imageAssets(state, session)).toBe(before)
  expect(resultOf(limited.events).shown).toBeUndefined()
  expect(resultOf(limited.events).generated).toBeUndefined()
})

test('Stop aborts the one request: nothing retried, nothing kept', async () => {
  state = await appState({ config: visionConfig() })
  let release: () => void = () => {}
  const started = new Promise<void>((r) => { release = r })
  const svc = fakeService((s) => new Promise<Response>((_resolve, reject) => {
    release()
    s.signal!.addEventListener('abort', () => reject(s.signal!.reason ?? new DOMException('aborted', 'AbortError')))
  }))
  const { session } = await openSession(state, buggyRepo())
  const before = imageAssets(state, session)
  setModel(state, 'scripted:a', scriptedModel(calling({ prompt: 'slow' }, {}), 'scripted-a'))
  const run = await state.runs.start(session, 'draw')
  await started
  expect(state.runs.cancel(run.id)).toBe(true)
  const done = await waitDone(state, run.id)
  expect(done.status).toBe('cancelled')
  expect(svc.seen).toHaveLength(1)
  expect(svc.seen[0]!.signal!.aborted).toBe(true)
  expect(imageAssets(state, session)).toBe(before)
})

test('answers that are not one image are refused, a URL is never fetched, and nothing is kept', async () => {
  state = await appState({ config: visionConfig() })
  const replies: (() => Response)[] = [
    () => Response.json({ data: [] }),
    () => Response.json({ data: [{ b64_json: b64(RED) }, { b64_json: b64(BLUE) }] }),
    () => Response.json({ data: [{ url: 'https://files.example/x.png' }] }),
    () => Response.json({ data: [{ b64_json: '!!!not base64!!!' }] }),
    () => Response.json({ data: [{ b64_json: b64(new TextEncoder().encode('just some text, not an image')) }] }),
    () => new Response('<html>not json</html>', { status: 200 }),
    () => new Response(new Uint8Array(13 * 1024 * 1024), { status: 200 }),     // over the response bound
  ]
  const svc = fakeService((_s, n) => replies[n - 1]!())
  const { session } = await openSession(state, buggyRepo())
  const before = imageAssets(state, session)
  for (let i = 0; i < replies.length; i += 1) {
    const { out } = await runWith(state, session, { prompt: `p${i}` })
    expect(out.status, `reply ${i}`).toBe('error')
    expect(out.retried).toBe(false)
  }
  expect(svc.seen).toHaveLength(replies.length)                               // one each, the URL never followed
  expect(svc.seen.some((s) => s.url.includes('files.example'))).toBe(false)
  expect(imageAssets(state, session)).toBe(before)
})

test('no sign-in: refused without a request; the network off or an order without network: refused before the credentials', async () => {
  state = await appState({ config: visionConfig() })
  const seen: unknown[] = []
  let reads = 0
  setImageHooks({ fetchImpl: async () => { seen.push(1); return new Response('{}') }, grants: { access: async () => { reads += 1; throw new NativeAuthError('openai-codex is not signed in; sign in on the Accounts page') } } })
  const { project, session } = await openSession(state, buggyRepo())
  const unsigned = await runWith(state, session, { prompt: 'x' })
  expect(unsigned.out.status).toBe('refused')
  expect(String(unsigned.out.reason)).toContain('sign')
  expect(reads).toBe(1)
  repo.setSessionGrants(state.conn, session.id, { ...GrantsSchema.parse({}), network: false })
  const off = await runWith(state, repo.getSession(state.conn, session.id)!, { prompt: 'x' })
  expect(off.out.status).toBe('refused_by_policy')
  repo.setSessionGrants(state.conn, session.id, { ...GrantsSchema.parse({}), network: true })
  const box: Record<string, unknown> = {}
  setModel(state, 'scripted:b', scriptedModel(calling({ prompt: 'x' }, box)))
  const order = parseWorkOrder({ prompt: 'draw', model: 'scripted:b', execution: { network: false } })
  const childWs = await state.workspaces.createWorkspace(project, session.id, { kind: 'child', base_commit: project.base_commit })
  await waitDone(state, (await state.runs.start(repo.getSession(state.conn, session.id)!, order.prompt, { spawned_by: 'human', work_order: order, workspace_id: childWs.id })).id)
  expect(rec(box.out).status).toBe('refused_by_work_order')
  expect(reads).toBe(1)
  expect(seen).toHaveLength(0)
})

test('a model that takes no images is told in words; the image is still kept and shown', async () => {
  state = await appState({ config: visionConfig(false) })
  fakeService(ok(RED))
  const { session } = await openSession(state, buggyRepo())
  const { out, events } = await runWith(state, session, { prompt: 'a red square' })
  expect(out.status).toBe('ok')
  expect(typeof out.image).toBe('string')
  expect(resultOf(events).shown).toHaveLength(1)
})

test('nothing the service writes back is repeated: an error\'s words, its echo of a token or of image data, odd metadata', async () => {
  state = await appState({ config: visionConfig() })
  const JWT = `eyJ${'a'.repeat(40)}.${'b'.repeat(60)}.${'c'.repeat(43)}`
  const DATA = b64(solidPng(64, 64, [9, 9, 9]))
  const svc = fakeService((_s, n) => n === 1
    ? Response.json({ error: { type: `echo ${JWT}`, code: 'rate_limit_exceeded', message: `rejected token ${JWT} for ${ACCESS} account ${ACCOUNT} image ${DATA}`, resets_at: `${JWT}` } }, { status: 429 })
    : ok(RED, { size: `1024x640 ${JWT}`, quality: DATA, background: ACCESS, output_format: 'png' })())
  const { session } = await openSession(state, buggyRepo())
  const refused = await runWith(state, session, { prompt: 'a' })
  expect(refused.out).toMatchObject({ status: 'error', http_status: 429, error_type: 'rate_limit_exceeded', retried: false })
  expect(refused.out.resets_at).toBeUndefined()
  const made = await runWith(state, session, { prompt: 'b' })
  expect(made.out.status).toBe('ok')
  expect(made.out.reported).toEqual({ output_format: 'png' })
  expect(svc.seen).toHaveLength(2)
  const recorded = [refused, made].map((r) => JSON.stringify(r.out) + JSON.stringify(r.events) + JSON.stringify(repo.getRun(state!.conn, r.run.id))).join('\n')
  for (const secret of [JWT.slice(0, 20), JWT.slice(50, 70), 'b'.repeat(20), ACCESS, ACCOUNT, DATA.slice(0, 40), DATA.slice(100, 140)]) expect(recorded).not.toContain(secret)
})

test('a run stopped before the request reads no grant and sends nothing; stopped while the grant is read, it sends nothing', async () => {
  state = await appState({ config: visionConfig() })
  const svc = fakeService(ok(RED))
  const { session } = await openSession(state, buggyRepo())
  const before = imageAssets(state, session)
  // stopped as the model asks for the image
  let runId = ''
  setModel(state, 'scripted:a', scriptedModel(() => { state!.runs.cancel(runId); return modelResponse([toolCallPart('generate_image', { prompt: 'x' }, '')]) }, 'scripted-a'))
  runId = (await state.runs.start(session, 'draw')).id
  expect((await waitDone(state, runId)).status).toBe('cancelled')
  expect(svc.grants.reads).toBe(0)
  // stopped while the grant is read: the grant is read once, the request never goes
  let second = ''
  setImageHooks({ grants: { access: async () => { svc.grants.reads += 1; state!.runs.cancel(second); return new OAuthCredential({ access: ACCESS, refresh: 'r', expires_ms: Date.now() + 3_600_000, account_id: ACCOUNT, email: null }) } } })
  setModel(state, 'scripted:a', scriptedModel(calling({ prompt: 'y' }, {}), 'scripted-a'))
  second = (await state.runs.start(session, 'draw again', { fresh: true })).id
  expect((await waitDone(state, second)).status).toBe('cancelled')
  expect(svc.grants.reads).toBe(1)
  expect(svc.seen).toHaveLength(0)
  expect(imageAssets(state, session)).toBe(before)
})

test('recent_images takes only what the person attached and what generate_image made; another tool\'s image is named by its id', async () => {
  state = await appState({ config: visionConfig() })
  const svc = fakeService(ok(BLUE))
  const { session, ws } = await openSession(state, buggyRepo())
  // an image another tool returned (read_file here; a screenshot is the same kind of tool return)
  writeFileSync(join(ws.path, 'shot.png'), solidPng(20, 20, [5, 5, 5]))
  const readShot = async (st: AppState, s: Session, attachments: ImageAttachment[] = []) => {
    const box: Record<string, unknown> = {}
    setModel(st, 'scripted:a', scriptedModel((m) => {
      const out = lastToolReturn(m.slice(lastPromptAt(m)), 'read_file')
      if (!out) return modelResponse([toolCallPart('read_file', { path: 'shot.png' }, '')])
      box.out = out
      return modelResponse([textPart('read')])
    }, 'scripted-a'))
    await waitDone(st, (await st.runs.start(s, 'look', { attachments })).id)
    return rec(rec(box.out).image).asset_id as string
  }
  // only the tool's image so far: recent_images finds none, nothing is sent
  const shot = await readShot(state, session)
  const none = await runWith(state, session, { prompt: 'edit it', recent_images: 1 })
  expect(none.out.status).toBe('refused')
  expect(svc.seen).toHaveLength(0)
  // named by its id, the same session's tool image is taken
  const named = await runWith(state, session, { prompt: 'edit the shot', reference_images: [shot] })
  expect(rec(named.out.requested).references).toEqual([shot])
  // the person's image, then another tool's image after it: recent_images 1 is still the person's
  const upload = saveAttachment({ conn: state.conn, store: state.store }, session, solidPng(16, 16, [0, 200, 0]), 'mine.png')
  await readShot(state, session, [upload])
  const recent = await runWith(state, session, { prompt: 'again', recent_images: 1 })
  expect(rec(recent.out.requested).references).toEqual([upload.asset_id])
  expect(svc.seen).toHaveLength(2)
})

test('an image over 5 MB is not kept: one request, a refusal that says so, nothing stored', async () => {
  state = await appState({ config: visionConfig() })
  const big = new Uint8Array(6 * 1024 * 1024)
  big.set(RED)
  const svc = fakeService(() => Response.json({ data: [{ b64_json: b64(big) }] }))
  const { session } = await openSession(state, buggyRepo())
  const before = imageAssets(state, session)
  const { out } = await runWith(state, session, { prompt: 'huge' })
  expect(out).toMatchObject({ status: 'error', retried: false })
  expect(String(out.reason)).toContain('5 MB')
  expect(svc.seen).toHaveLength(1)
  expect(imageAssets(state, session)).toBe(before)
})

test('a sign-in that fails in any way is said in a short sentence of its own: no request, nothing of the error repeated', async () => {
  state = await appState({ config: visionConfig() })
  const seen: unknown[] = []
  setImageHooks({ fetchImpl: async () => { seen.push(1); return new Response('{}') }, grants: { access: async () => { throw new Error(`refresh failed: refresh_token=SECRET-REFRESH-0123456789 ${'eyJ'}${'x'.repeat(30)}`) } } })
  const { session } = await openSession(state, buggyRepo())
  const { out, run, events } = await runWith(state, session, { prompt: 'x' })
  expect(out.status).toBe('refused')
  expect(String(out.reason)).toContain('not available')
  const recorded = JSON.stringify(out) + JSON.stringify(events) + JSON.stringify(repo.getRun(state.conn, run.id))
  expect(recorded).not.toContain('SECRET-REFRESH')
  expect(recorded).not.toContain('x'.repeat(30))
  expect(seen).toHaveLength(0)
})

test('the image is shown again when the conversation is opened later: the transcript rebuilt from the history keeps it', async () => {
  state = await appState({ config: visionConfig() })
  fakeService(ok(RED))
  const { session } = await openSession(state, buggyRepo())
  const upload = saveAttachment({ conn: state.conn, store: state.store }, session, solidPng(16, 16, [0, 200, 0]), 'mine.png')
  const made = await runWith(state, session, { prompt: 'a red square' })
  const edited = await runWith(state, session, { prompt: 'edit', reference_images: [upload.asset_id] })
  for (const [run, out, refs] of [[made.run, made.out, undefined], [edited.run, edited.out, [upload.asset_id]]] as const) {
    const row = state.conn.get('SELECT history_json FROM runs WHERE id=?', [run.id]) as { history_json: string }
    const entry = rebuildTranscript(row.history_json).filter((e) => (e as { tool?: string }).tool === 'generate_image').at(-1) as { result: Record<string, unknown> }
    expect(entry.result).toMatchObject({ status: 'ok', generated: true, shown: [{ asset_id: out.asset_id, width: out.width, height: out.height, label: 'generated-image.png' }] })
    expect(entry.result.references).toEqual(refs)
    expect(/[A-Za-z0-9+/]{1024,}/.test(JSON.stringify(entry))).toBe(false)
  }
})
