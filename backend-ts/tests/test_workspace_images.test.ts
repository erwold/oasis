/** An image file the agent reads from its workspace travels the attachments' path: read_file copies its bytes into the
 *  session's assets (content-addressed, the upload's limit) and returns a reference; the provider boundary hydrates
 *  that reference inside the tool return and each provider places the image where its API takes it; the history
 *  keeps only the reference, and compaction never touches it. */

import { afterEach, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ImageAttachment } from '@oasis-code/contract'
import { Agent } from '../src/agent/loop.ts'
import { ContextKeeper, isCompaction, workingView } from '../src/agent/history.ts'
import { PROMPT_TEXT } from '../src/prompt_texts.ts'
import { ModelConfig } from '../src/config.ts'
import * as repo from '../src/db/repo.ts'
import { hydrateImages, ImageHydration, ImageRefused, imagePiece, isImagePiece, measureImage } from '../src/llm/images.ts'
import {
  isRequest, isToolReturn, isUserPrompt, lastToolReturn, modelRequest, modelResponse, textPart, toolCallPart, toolReturn, userPrompt, type ModelMessage, type ModelRequest,
} from '../src/llm/messages.ts'
import { AnthropicModel, GoogleModel, OpenAIChatModel, OpenAIResponsesModel } from '../src/llm/providers.ts'
import { sha256Hex } from '../src/store.ts'
import { appState, buggyRepo, closeState, collectEvents, openSession, scriptedModel, setModel, testConfig, type AppState } from './harness.ts'
import { Route, runAgent } from './helpers.ts'
import { anthropicResponses, geminiResponses, openaiResponses } from './providers_fixtures.ts'
import { rec } from './tree_helpers.ts'

const FIXTURES = join(import.meta.dir, 'fixtures', 'images')
const fixture = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)))
const PNG = fixture('red-7x5.png')
const JPEG = fixture('red-7x5.jpg')
const WEBP = fixture('red-7x5-lossy.webp')
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')

let state: AppState | null = null
afterEach(async () => { if (state) await closeState(state); state = null })

function imageConfig() {
  const config = testConfig()
  config.models = [new ModelConfig({ id: 'scripted:a', label: 'Scripted A', provider: 'anthropic', model: 'scripted-a', api_key_env: 'OASIS_TEST_KEY_A', capabilities: { images: true } })]
  return config
}

/** A script that plays its steps in order, each from what the model was handed. */
function playing(steps: ((messages: ModelMessage[]) => ReturnType<typeof modelResponse>)[]) {
  let n = 0
  return (messages: ModelMessage[]) => {
    const step = steps[n] ?? (() => modelResponse([textPart('done')]))
    n += 1
    return step(messages)
  }
}

const read = (path: string) => () => modelResponse([toolCallPart('read_file', { path }, '')])

test('an image file read from the workspace is copied into the session, referenced, and seen by the model; other files read as text', async () => {
  state = await appState({ config: imageConfig() })
  const { session, ws } = await openSession(state, buggyRepo())
  writeFileSync(join(ws.path, 'render.png'), PNG)
  writeFileSync(join(ws.path, 'photo.jpg'), JPEG)
  writeFileSync(join(ws.path, 'pic.webp'), WEBP)
  writeFileSync(join(ws.path, 'fake.png'), 'not really a picture\n')             // a name is not a format
  const big = new Uint8Array(5 * 1024 * 1024 + 1)
  big.set(PNG.subarray(0, 24))
  writeFileSync(join(ws.path, 'big.png'), big)
  const seen: Record<string, unknown> = {}
  setModel(state, 'scripted:a', scriptedModel(playing([
    read('render.png'),
    (m) => {
      seen.first = lastToolReturn(m, 'read_file')
      writeFileSync(join(ws.path, 'render.png'), JPEG)                           // the agent renders again, same name
      return read('render.png')()
    },
    (m) => { seen.second = lastToolReturn(m, 'read_file'); return read('photo.jpg')() },
    read('pic.webp'),
    read('calc.py'),
    read('fake.png'),
    read('big.png'),
  ]), 'scripted-a'))
  const run = await state.runs.start(session, 'look at your render')
  await collectEvents(state, run.id)
  expect(repo.getRun(state.conn, run.id)!.status).toBe('done')

  // what the model was handed: the bytes, inside the tool return, in place of the reference
  const firstSeen = rec(rec(seen.first).image)
  expect(firstSeen.data).toBe(b64(PNG))
  expect(rec(rec(seen.second).image).data).toBe(b64(JPEG))

  // what the history keeps: references, and the text reads as before
  const history = repo.getRunHistory(state.conn, run.id)!
  const returns = (JSON.parse(history) as ModelMessage[]).flatMap((m) => (isRequest(m) ? m.parts : [])).filter(isToolReturn).map((p) => rec(p.content))
  expect(returns).toHaveLength(7)
  const [first, second, jpeg, webp, text, fake, tooBig] = returns as [Record<string, unknown>, Record<string, unknown>, Record<string, unknown>, Record<string, unknown>, Record<string, unknown>, Record<string, unknown>, Record<string, unknown>]
  expect(first).toMatchObject({ status: 'ok', path: 'render.png', kind: 'image', media_type: 'image/png', width: 7, height: 5, bytes: PNG.length })
  expect(isImagePiece(first.image)).toBe(true)
  expect(rec(first.image)).toMatchObject({ kind: 'image', media_type: 'image/png', width: 7, height: 5, bytes: PNG.length, sha256: sha256Hex(PNG), name: 'render.png' })
  expect('data' in rec(first.image)).toBe(false)
  expect(second).toMatchObject({ path: 'render.png', media_type: 'image/jpeg' })
  expect(jpeg).toMatchObject({ path: 'photo.jpg', media_type: 'image/jpeg', width: 7, height: 5 })
  expect(webp).toMatchObject({ path: 'pic.webp', media_type: 'image/webp', width: 7, height: 5 })
  expect(text.content as string).toContain('def add')                          // a text file, line by line as before
  expect(text.kind).toBeUndefined()
  expect(fake.content as string).toBe('1\tnot really a picture')
  let limit = ''
  try { measureImage(big) } catch (error) { expect(error).toBeInstanceOf(ImageRefused); limit = (error as Error).message }
  expect(tooBig).toMatchObject({ status: 'refused' })
  expect(tooBig.reason as string).toBe(`'big.png': ${limit}`)                  // the upload's own refusal

  // the assets: session attachments holding the bytes as they were read; the overwritten file's first read still
  // resolves to the first bytes
  for (const [piece, bytes] of [[first.image, PNG], [second.image, JPEG], [jpeg.image, JPEG], [webp.image, WEBP]] as const) {
    const asset = repo.getAsset(state.conn, rec(piece).asset_id as string)!
    expect(asset.meta).toMatchObject({ role: 'attachment', session_id: session.id })
    expect(new Uint8Array(state.store.read(asset.storage_path))).toEqual(bytes)
  }
  expect(rec(first.image).asset_id).not.toBe(rec(second.image).asset_id)
  for (const bytes of [PNG, JPEG, WEBP]) expect(history).not.toContain(b64(bytes))
  expect(JSON.stringify(repo.listEvents(state.conn, run.id))).not.toContain(b64(PNG))
})

// -- the provider boundary ------------------------------------------------------------------------------------------

const ATTACHMENT: ImageAttachment = { asset_id: 'a_1', media_type: 'image/png', bytes: PNG.length, sha256: sha256Hex(PNG), width: 7, height: 5, name: 'render.png' }
const RETURNED = { status: 'ok', path: 'out/render.png', kind: 'image', media_type: 'image/png', width: 7, height: 5, bytes: PNG.length, image: imagePiece(ATTACHMENT) }

/** The person asked, the agent read its render, and the return holds the image's reference. */
const withReturnedImage = (): ModelMessage[] => [
  modelRequest([userPrompt('does the render look right?')]),
  modelResponse([toolCallPart('read_file', { path: 'out/render.png' }, 'call_1')]),
  modelRequest([toolReturn('read_file', RETURNED, 'call_1')]),
]

test("hydration fills in a tool return's image; the history keeps the reference; a model without images or a lost image fails explicitly", () => {
  const history = withReturnedImage()
  const returned = (messages: ModelMessage[]) => rec(messages.flatMap((m) => (isRequest(m) ? m.parts : [])).find(isToolReturn)!.content)
  const sent = hydrateImages(history, () => PNG, true, 'm')
  expect(rec(returned(sent).image)).toEqual({ ...imagePiece(ATTACHMENT), data: b64(PNG) })
  expect(returned(sent).path).toBe('out/render.png')
  expect(returned(history).image).toEqual(imagePiece(ATTACHMENT))              // the caller's messages are not touched
  expect(() => hydrateImages(history, () => PNG, false, 'text-only')).toThrow('does not accept images')
  expect(() => hydrateImages(history, () => null, true, 'm')).toThrow('missing or damaged')
})

test('each provider places a returned image where its API takes it; the text of the return names it without the bytes', async () => {
  const agent = new Agent<null>({ instructions: 'x', tools: [] })
  const data = b64(PNG)
  const reference = JSON.stringify(RETURNED)

  // Anthropic Messages: image blocks inside the tool_result
  const anthropic = new Route(anthropicResponses().slice(-1))
  await runAgent(agent, new ImageHydration(new AnthropicModel('claude-x', { apiKey: 'k', baseUrl: 'http://a.mock', fetchImpl: anthropic.fetch }), () => PNG, true), null, null, { history: withReturnedImage(), settings: { max_tokens: 64 } })
  const anthropicLast = (anthropic.requests[0]!.messages as { role: string; content: Record<string, unknown>[] }[]).at(-1)!
  expect(anthropicLast.content).toEqual([{ type: 'tool_result', tool_use_id: 'call_1', is_error: false, content: [
    { type: 'text', text: reference }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data } }] }])

  // OpenAI Responses: input_image inside the function_call_output's output list
  const responses = new Route(openaiResponses().slice(-1))
  await runAgent(agent, new ImageHydration(new OpenAIResponsesModel('gpt-y', { apiKey: 'k', baseUrl: 'http://o.mock/v1', fetchImpl: responses.fetch }), () => PNG, true), null, null, { history: withReturnedImage() })
  const output = (responses.requests[0]!.input as Record<string, unknown>[]).find((i) => i.type === 'function_call_output')!
  expect(output).toEqual({ type: 'function_call_output', call_id: 'call_1', output: [
    { type: 'input_text', text: reference }, { type: 'input_image', image_url: `data:image/png;base64,${data}` }] })

  // OpenAI Chat Completions: a tool message is text only — the image follows it as a user message naming the call
  const chatBody = `data: ${JSON.stringify({ id: 'c', model: 'gpt-c', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] })}\n\n`
    + `data: ${JSON.stringify({ id: 'c', model: 'gpt-c', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`
  const chat = new Route([chatBody])
  await runAgent(agent, new ImageHydration(new OpenAIChatModel('gpt-c', { apiKey: 'k', baseUrl: 'http://c.mock/v1', fetchImpl: chat.fetch }), () => PNG, true), null, null, { history: withReturnedImage() })
  const chatMessages = chat.requests[0]!.messages as Record<string, unknown>[]
  expect(chatMessages.slice(-2)).toEqual([
    { role: 'tool', tool_call_id: 'call_1', content: reference },
    { role: 'user', content: [{ type: 'text', text: 'Image from tool call call_1 (out/render.png):' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${data}` } }] },
  ])

  // Gemini 3: inline data nested in the functionResponse; before Gemini 3, the image right after it in the user turn
  const gemini3 = new Route(geminiResponses().slice(-1))
  await runAgent(agent, new ImageHydration(new GoogleModel('gemini-3.6-flash', { apiKey: 'k', baseUrl: 'http://g.mock', fetchImpl: gemini3.fetch }), () => PNG, true), null, null, { history: withReturnedImage() })
  const contents3 = gemini3.requests[0]!.contents as { role: string; parts: Record<string, unknown>[] }[]
  expect(contents3.at(-1)).toEqual({ role: 'user', parts: [{ functionResponse: { name: 'read_file', response: RETURNED, parts: [{ inline_data: { mime_type: 'image/png', data } }] } }] })
  const gemini2 = new Route(geminiResponses().slice(-1))
  await runAgent(agent, new ImageHydration(new GoogleModel('gemini-2.5-pro', { apiKey: 'k', baseUrl: 'http://g.mock', fetchImpl: gemini2.fetch }), () => PNG, true), null, null, { history: withReturnedImage() })
  const contents2 = gemini2.requests[0]!.contents as { role: string; parts: Record<string, unknown>[] }[]
  expect(contents2.at(-1)).toEqual({ role: 'user', parts: [                        // turns alternate: one user turn
    { functionResponse: { name: 'read_file', response: RETURNED } },
    { text: 'Image from tool call call_1 (out/render.png):' }, { inline_data: { mime_type: 'image/png', data } },
  ] })

  // the history the agent was handed is the reference only: every wire above was built from it, none changed it
  expect(JSON.stringify(withReturnedImage())).not.toContain(data)
})

// -- compaction -----------------------------------------------------------------------------------------------------

test("a compaction keeps an old return's image reference byte for byte in the record, and the pending tail's in the compaction request", async () => {
  const LONG = 'the quick brown fox jumps over the lazy dog '.repeat(60)
  const messages: ModelMessage[] = [modelRequest([userPrompt('render, look, fix, repeat')])]
  messages.push(modelResponse([toolCallPart('read_file', { path: 'out/render.png' }, 'tc_img')]))
  messages.push(modelRequest([toolReturn('read_file', { ...RETURNED, note: LONG }, 'tc_img')]))
  for (let i = 0; i < 6; i += 1) {
    messages.push(modelResponse([toolCallPart('bash', { command: `make step_${i}` }, `tc_${i}`)]))
    messages.push(modelRequest([toolReturn('bash', { status: 'ok', exit_code: 0, stdout: LONG }, `tc_${i}`)]))
  }
  messages.push(modelResponse([toolCallPart('read_file', { path: 'out/render.png' }, 'tc_last')]))
  messages.push(modelRequest([toolReturn('read_file', RETURNED, 'tc_last')]))
  const reference = JSON.stringify(imagePiece(ATTACHMENT))
  const imageOf = (msgs: ModelMessage[], id: string) => {
    const part = msgs.flatMap((m) => (isRequest(m) ? m.parts : [])).filter(isToolReturn).find((p) => p.tool_call_id === id)!
    return JSON.stringify(rec(part.content).image)
  }
  const model = scriptedModel((m) => {
    const last = m[m.length - 1]!
    const asked = isRequest(last) && last.parts.some((p) => isUserPrompt(p) && (typeof p.content === 'string' ? p.content : '') === PROMPT_TEXT['compaction.request'])
    return modelResponse([textPart(asked ? '<summary>rendered and rebuilt six times</summary>' : 'ok')])
  })
  const keeper = new ContextKeeper({ window: 20_000, output_reserve: 500 })
  const [record, report] = await keeper.maybeCompact(messages, { model, settings: {}, params: { function_tools: [], allow_text_output: true, thinking: null }, instructions: 'i', observed: { input_tokens: 11_400, messages: messages.length - 1 } })
  expect(report!.status).toBe('compacted')
  for (let i = 0; i < messages.length; i += 1) expect(record[i]).toBe(messages[i]!)  // the record: the same objects
  expect(imageOf(record, 'tc_img')).toBe(reference)
  const marker = record[record.length - 1]!
  expect(isCompaction(marker)).toBe(true)
  const view = workingView(record)
  expect(view).toEqual([marker])
  // the tail's result rides in the compaction request with its image reference, as a piece the boundary hydrates
  const carried = (marker as ModelRequest).parts.at(-1)!
  expect(isUserPrompt(carried) && Array.isArray(carried.content) && JSON.stringify(carried.content[1])).toBe(reference)
  const hydrated = hydrateImages(view, () => PNG, true, 'm')
  const piece = ((hydrated[0] as ModelRequest).parts.at(-1) as { content: unknown[] }).content[1] as { data?: string }
  expect(piece.data).toBe(Buffer.from(PNG).toString('base64'))
})
