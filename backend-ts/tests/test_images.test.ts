/** Images attached to a message, end to end: the bytes measured (format from the signature, size from the header),
 *  refused with a reason; the upload stored under the session and read back only there; a chat naming them checked
 *  against the session and the model's declared image input; the model handed the bytes while the history keeps a
 *  reference — so the image is seen again on the next turn and after a restart, and a missing image is said, not
 *  dropped; each provider's wire shape. */

import { afterEach, expect, test } from 'bun:test'
import { readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { ImageAttachment } from '@oasis-code/contract'
import { ModelConfig, type Settings } from '../src/config.ts'
import * as repo from '../src/db/repo.ts'
import { hydrateImages, ImageHydration, ImageRefused, imagePiece, isImagePiece, measureImage, MAX_IMAGE_SIDE } from '../src/llm/images.ts'
import { isRequest, isUserPrompt, modelRequest, modelResponse, textPart, userPrompt, type ModelMessage } from '../src/llm/messages.ts'
import { AnthropicModel, GoogleModel, OpenAIChatModel, OpenAIResponsesModel } from '../src/llm/providers.ts'
import { createApp, type App } from '../src/main.ts'
import { sha256Hex } from '../src/store.ts'
import { Client, json } from './api_harness.ts'
import { buggyRepo, scriptedModel, setModel, testConfig, testSettings, waitDone } from './harness.ts'
import { Route, runAgent } from './helpers.ts'
import { anthropicResponses, geminiResponses, openaiResponses } from './providers_fixtures.ts'
import { Agent } from '../src/agent/loop.ts'

const FIXTURES = join(import.meta.dir, 'fixtures', 'images')
const fixture = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)))
const PNG = fixture('red-7x5.png')

let app: App | null = null
afterEach(async () => { if (app) await app.close(); app = null })

// -- measuring ------------------------------------------------------------------------------------------------------

test('the format comes from the bytes and the size from the header, for PNG, JPEG and the three kinds of WebP', () => {
  expect(measureImage(PNG)).toEqual({ media_type: 'image/png', width: 7, height: 5 })
  expect(measureImage(fixture('red-7x5.jpg'))).toEqual({ media_type: 'image/jpeg', width: 7, height: 5 })
  for (const name of ['red-7x5-lossy.webp', 'red-7x5-lossless.webp', 'red-7x5-alpha.webp']) {
    expect(measureImage(fixture(name)), name).toEqual({ media_type: 'image/webp', width: 7, height: 5 })
  }
})

test('what is not a PNG, JPEG or WebP, or is damaged, empty, too big or too wide, is refused with the reason', () => {
  const refusal = (bytes: Uint8Array) => { try { measureImage(bytes); return null } catch (e) { expect(e).toBeInstanceOf(ImageRefused); return (e as Error).message } }
  expect(refusal(fixture('dot.gif'))).toContain('not a PNG, JPEG or WebP')
  expect(refusal(fixture('dot.svg'))).toContain('not a PNG, JPEG or WebP')
  expect(refusal(new Uint8Array())).toContain('empty')
  expect(refusal(PNG.subarray(0, 12))).toContain('could not be read')
  expect(refusal(new Uint8Array(5 * 1024 * 1024 + 1))).toContain('the limit is 5 MB')
  const wide = new Uint8Array(PNG)
  new DataView(wide.buffer).setUint32(16, MAX_IMAGE_SIDE + 1)                   // the IHDR width
  expect(refusal(wide)).toContain(`${MAX_IMAGE_SIDE + 1}×5 px`)
})

// -- the provider boundary ------------------------------------------------------------------------------------------

const ATTACHMENT: ImageAttachment = { asset_id: 'a_1', media_type: 'image/png', bytes: PNG.length, sha256: sha256Hex(PNG), width: 7, height: 5, name: 'red.png' }
const withImage = (): ModelMessage[] => [modelRequest([userPrompt(['what colour is this?', imagePiece(ATTACHMENT)])])]
const pieces = (messages: ModelMessage[]) => messages.flatMap((m) => (isRequest(m) ? m.parts : [])).filter(isUserPrompt).flatMap((p) => (Array.isArray(p.content) ? p.content : [p.content]))

test('the request carries the bytes; the caller keeps the reference; a missing image or a model without images fails explicitly', () => {
  const history = withImage()
  const sent = hydrateImages(history, () => PNG, true, 'm')
  const image = pieces(sent).find(isImagePiece)!
  expect(image.data).toBe(Buffer.from(PNG).toString('base64'))
  expect(pieces(history).find(isImagePiece)!.data).toBeUndefined()           // the history is not touched
  expect(() => hydrateImages(history, () => null, true, 'm')).toThrow('missing or damaged')
  expect(() => hydrateImages(history, () => PNG, false, 'text-only')).toThrow('does not accept images')
  const plain = [modelRequest([userPrompt('no images here')])]
  expect(hydrateImages(plain, () => PNG, true, 'm')).toBe(plain)              // nothing to do: the same array
})

function wireImage(route: Route): unknown {
  return JSON.stringify(route.requests[0]).includes(Buffer.from(PNG).toString('base64'))
}

test('each provider carries the image in its own shape, beside the text', async () => {
  const agent = new Agent<null>({ instructions: 'x', tools: [] })
  const prompt = ['what colour is this?', imagePiece(ATTACHMENT)]
  const b64 = Buffer.from(PNG).toString('base64')

  const anthropic = new Route(anthropicResponses().slice(-1))
  await runAgent(agent, new ImageHydration(new AnthropicModel('claude-x', { apiKey: 'k', baseUrl: 'http://a.mock', fetchImpl: anthropic.fetch }), () => PNG, true), prompt, null, { settings: { max_tokens: 64 } })
  expect((anthropic.requests[0]!.messages as { content: unknown[] }[])[0]!.content).toEqual([
    { type: 'text', text: 'what colour is this?' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } }])

  const responses = new Route(openaiResponses().slice(-1))
  await runAgent(agent, new ImageHydration(new OpenAIResponsesModel('gpt-y', { apiKey: 'k', baseUrl: 'http://o.mock/v1', fetchImpl: responses.fetch }), () => PNG, true), prompt, null)
  const item = (responses.requests[0]!.input as { role?: string; content?: unknown }[]).find((i) => i.role === 'user')!
  expect(item.content).toEqual([{ type: 'input_text', text: 'what colour is this?' }, { type: 'input_image', image_url: `data:image/png;base64,${b64}` }])

  const google = new Route(geminiResponses().slice(-1))
  await runAgent(agent, new ImageHydration(new GoogleModel('gemini-z', { apiKey: 'k', baseUrl: 'http://g.mock', fetchImpl: google.fetch }), () => PNG, true), prompt, null)
  expect((google.requests[0]!.contents as { parts: unknown[] }[])[0]!.parts).toEqual([{ text: 'what colour is this?' }, { inline_data: { mime_type: 'image/png', data: b64 } }])

  const chatBody = `data: ${JSON.stringify({ id: 'c', model: 'gpt-c', choices: [{ index: 0, delta: { content: 'red' }, finish_reason: null }] })}\n\n`
    + `data: ${JSON.stringify({ id: 'c', model: 'gpt-c', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`
  const chat = new Route([chatBody])
  await runAgent(agent, new ImageHydration(new OpenAIChatModel('gpt-c', { apiKey: 'k', baseUrl: 'http://c.mock/v1', fetchImpl: chat.fetch }), () => PNG, true), prompt, null)
  expect((chat.requests[0]!.messages as { role: string; content: unknown }[]).find((m) => m.role === 'user')!.content).toEqual([
    { type: 'text', text: 'what colour is this?' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } }])
  // a text-only message stays the plain string the Chat Completions route always sent
  const plain = new Route([chatBody])
  await runAgent(agent, new OpenAIChatModel('gpt-c', { apiKey: 'k', baseUrl: 'http://c.mock/v1', fetchImpl: plain.fetch }), 'just words', null)
  expect((plain.requests[0]!.messages as { role: string; content: unknown }[]).find((m) => m.role === 'user')!.content).toBe('just words')
  expect(wireImage(plain)).toBe(false)
})

// -- over the API ---------------------------------------------------------------------------------------------------

function imageConfig() {
  const config = testConfig()
  config.models = [
    new ModelConfig({ id: 'scripted:a', label: 'Scripted A', provider: 'anthropic', model: 'scripted-a', api_key_env: 'OASIS_TEST_KEY_A', capabilities: { images: true } }),
    new ModelConfig({ id: 'scripted:b', label: 'Scripted B', provider: 'openai', model: 'scripted-b', api_key_env: 'OASIS_TEST_KEY_B' }),
    new ModelConfig({ id: 'scripted:c', label: 'Scripted C', provider: 'google', model: 'scripted-c', api_key_env: 'OASIS_TEST_KEY_B', capabilities: { images: true } }),
  ]
  return config
}

async function imageApp(settings: Settings = testSettings()): Promise<App> {
  return createApp(settings, imageConfig(), { probe: false })
}

async function sessionOn(c: Client, repoPath = buggyRepo()) {
  const project = await json(await c.post('/api/projects', { source_path: repoPath }))
  return json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'images' }))
}

function upload(c: Client, sessionId: string, bytes: Uint8Array, name = 'red.png') {
  return c.app.app.request(`http://localhost/api/sessions/${sessionId}/attachments?name=${encodeURIComponent(name)}`, {
    method: 'POST', body: bytes, headers: { ...c.headers, 'content-type': 'application/octet-stream' },
  })
}

test('an upload is measured and stored under its session; read back there only; refused with the right status', async () => {
  app = await imageApp()
  const c = new Client(app)
  const session = await sessionOn(c)
  const other = await sessionOn(c)
  const attachment = await json<ImageAttachment>(await upload(c, session.id as string, PNG, '../../etc/red shot.png'))
  expect(attachment).toMatchObject({ media_type: 'image/png', width: 7, height: 5, bytes: PNG.length, sha256: sha256Hex(PNG), name: 'red shot.png' })
  const read = await c.get(`/api/sessions/${session.id}/attachments/${attachment.asset_id}`)
  expect(read.status).toBe(200)
  expect(read.headers.get('content-type')).toBe('image/png')
  expect(read.headers.get('x-content-type-options')).toBe('nosniff')
  expect(new Uint8Array(await read.arrayBuffer())).toEqual(PNG)
  expect((await c.get(`/api/sessions/${other.id}/attachments/${attachment.asset_id}`)).status).toBe(404)
  expect((await upload(c, session.id as string, fixture('dot.svg'), 'x.svg')).status).toBe(415)
  expect((await upload(c, session.id as string, new Uint8Array(5 * 1024 * 1024 + 1))).status).toBe(413)
  expect((await upload(c, 's_nope', PNG)).status).toBe(404)
  expect((await c.app.app.request(`http://localhost/api/sessions/${session.id}/attachments`, { method: 'POST', body: PNG })).status).toBe(401)
})

test('a chat names only its own session images, only on a model that takes images', async () => {
  app = await imageApp()
  const c = new Client(app)
  const session = await sessionOn(c)
  const other = await sessionOn(c)
  const mine = await json<ImageAttachment>(await upload(c, session.id as string, PNG))
  const theirs = await json<ImageAttachment>(await upload(c, other.id as string, PNG))
  expect((await c.post(`/api/sessions/${session.id}/chat`, { text: 'look', attachments: [theirs.asset_id] })).status).toBe(400)
  expect((await c.post(`/api/sessions/${session.id}/chat`, { text: 'look', attachments: ['a_nope'] })).status).toBe(400)
  expect((await c.post(`/api/sessions/${session.id}/chat`, { text: 'look', attachments: [mine.asset_id, mine.asset_id] })).status).toBe(400)
  const refused = await c.post(`/api/sessions/${session.id}/chat`, { text: 'look', model: 'scripted:b', attachments: [mine.asset_id] })
  expect(refused.status).toBe(400)
  expect((await refused.json() as { detail: string }).detail).toContain('Scripted B is not configured to take images')
  expect(repo.listRuns(app.state.conn, session.id as string)).toEqual([])
})

test('an image goes without words: the model gets the context and the image, no empty words; neither is refused', async () => {
  app = await imageApp()
  let handed: unknown[] = []
  setModel(app.state, 'scripted:a', scriptedModel((messages) => { handed = pieces(messages); return modelResponse([textPart('a red square')]) }))
  const c = new Client(app)
  const session = await sessionOn(c)
  const empty = await c.post(`/api/sessions/${session.id}/chat`, { text: '  ' })
  expect(empty.status).toBe(400)
  expect((await empty.json() as { detail: string }).detail).toBe('text is required unless the message carries an attachment')
  const attachment = await json<ImageAttachment>(await upload(c, session.id as string, PNG))
  const run = await json(await c.post(`/api/sessions/${session.id}/chat`, { text: '', attachments: [attachment.asset_id] }))
  expect((await waitDone(app.state, run.id as string)).status).toBe('done')
  const words = handed.filter((p): p is string => typeof p === 'string')
  expect(words).toHaveLength(1)                                                  // the context lines, and nothing after them
  expect(words[0]).toContain('Working folder:')
  expect(words[0]!.endsWith('\n')).toBe(false)
  expect(handed.filter(isImagePiece).map((i) => i.name)).toEqual(['red.png'])
})

test('the model sees the image on the first turn, again on the next, and after a restart; the record keeps only the reference', async () => {
  const settings = testSettings()
  app = await imageApp(settings)
  const seen: string[][] = []
  const watching = () => scriptedModel((messages) => {
    const images = pieces(messages).filter(isImagePiece)
    seen.push(images.map((i) => (typeof i.data === 'string' ? `${i.name}:${i.data.length}` : `${i.name}:no bytes`)))
    return modelResponse([textPart(`I see ${images.length} image(s)`)])
  })
  setModel(app.state, 'scripted:a', watching())
  const c = new Client(app)
  const session = await sessionOn(c)
  const attachment = await json<ImageAttachment>(await upload(c, session.id as string, PNG))
  const b64 = Buffer.from(PNG).toString('base64').length
  const first = await json(await c.post(`/api/sessions/${session.id}/chat`, { text: 'what colour is it?', attachments: [attachment.asset_id] }))
  await waitDone(app.state, first.id as string)
  expect(seen.at(-1)).toEqual([`red.png:${b64}`])
  const stored = repo.getRun(app.state.conn, first.id as string)!
  expect(stored.attachments).toEqual([attachment])
  const historyJson = app.state.conn.get('SELECT history_json FROM runs WHERE id=?', [first.id as string])!.history_json as string
  expect(historyJson).toContain(attachment.asset_id)
  expect(historyJson).not.toContain(Buffer.from(PNG).toString('base64'))       // no bytes in the record
  const events = JSON.stringify(repo.listEvents(app.state.conn, first.id as string))
  expect(events).not.toContain(Buffer.from(PNG).toString('base64'))

  const second = await json(await c.post(`/api/sessions/${session.id}/chat`, { text: 'and the stripe?' }))
  await waitDone(app.state, second.id as string)
  expect(seen.at(-1)).toEqual([`red.png:${b64}`])                              // the earlier turn's image, again

  await app.close()
  app = await imageApp(settings)                                               // a restart on the same data directory
  setModel(app.state, 'scripted:a', watching())
  const c2 = new Client(app)
  const third = await json(await c2.post(`/api/sessions/${session.id}/chat`, { text: 'still there?' }))
  await waitDone(app.state, third.id as string)
  expect(seen.at(-1)).toEqual([`red.png:${b64}`])
  const listed = (await json<{ attachments: ImageAttachment[] }>(await c2.get(`/api/runs/${first.id}`))).attachments
  expect(listed).toEqual([attachment])

  // A damaged asset is an explicit preflight refusal, never a different replay sent to the provider.
  unlinkSync(app.state.store.abspath(repo.getAsset(app.state.conn, attachment.asset_id)!.storage_path))
  const fourth = await c2.post(`/api/sessions/${session.id}/chat`, { text: 'and now?' })
  expect(fourth.status).toBe(400)
  expect(JSON.stringify(await fourth.json())).toContain('missing, damaged')
  expect(seen.at(-1)).toEqual([`red.png:${b64}`])

})

test('a session continued on another provider keeps its images: a model that takes them sees them, one that does not is told', async () => {
  app = await imageApp()
  const seen: Record<string, unknown[]> = {}
  const watching = (id: string) => scriptedModel((messages) => {
    seen[id] = pieces(messages).map((p) => (isImagePiece(p) ? `image ${p.name} ${typeof p.data === 'string' ? 'with bytes' : 'without bytes'}` : p))
    return modelResponse([textPart('ok')], { provider_name: id === 'scripted:a' ? 'anthropic' : id === 'scripted:b' ? 'openai' : 'google' })
  })
  for (const id of ['scripted:a', 'scripted:b', 'scripted:c']) setModel(app.state, id, watching(id))
  const c = new Client(app)
  const session = await sessionOn(c)
  const attachment = await json<ImageAttachment>(await upload(c, session.id as string, PNG))
  await waitDone(app.state, (await json(await c.post(`/api/sessions/${session.id}/chat`, { text: 'look', attachments: [attachment.asset_id] }))).id as string)
  await waitDone(app.state, (await json(await c.post(`/api/sessions/${session.id}/chat`, { text: 'and you?', model: 'scripted:c' }))).id as string)
  expect(seen['scripted:c']).toContain('image red.png with bytes')                  // another provider, the same image
  const refused = await c.post(`/api/sessions/${session.id}/chat`, { text: 'and you?', model: 'scripted:b' })
  expect(refused.status).toBe(400)
  expect(JSON.stringify(await refused.json())).toContain('not configured to take images')
  expect(seen['scripted:b']).toBeUndefined()

})
