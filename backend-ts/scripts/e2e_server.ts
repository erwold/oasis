import { naturalFixtureRoutes, SOURCE_NAME, NATURAL_DIRECTOR, NATURAL_FABLE, NATURAL_SLOW, GAN_BATTLE_SENTENCE, INDEPENDENT_SENTENCE, SLOW_SENTENCE } from './natural_interaction_fixture.ts'
import { liveShareRoutes } from './live_share_fixture.ts'
import { isAnyFilePiece } from '../src/llm/attachments.ts'
/** A backend for the browser e2e test: a fresh data directory, a scripted model that fixes the fixture repository's
 *  bug through the real tools (a real sandboxed command run included), and the built UI. Nothing here reaches a
 *  cloud; the port and the fixture path are printed as JSON on the first line of stdout.
 *
 *      bun run scripts/e2e_server.ts [port]
 */

import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ModelConfig, Settings } from '../src/config.ts'
import { isImagePiece } from '../src/llm/images.ts'
import { isRequest, isResponse, isUserPrompt, lastToolReturn, modelResponse, textPart, toolCallPart, toolReturns, userText, userTexts, type ModelMessage, type UserPromptPart } from '../src/llm/messages.ts'
import { scriptedModel, stampedModel, steps } from '../src/llm/scripted.ts'
import { createApp } from '../src/main.ts'
import type { Conn } from '../src/db/database.ts'
import { unsealStoredFile } from '../src/workspace/attachment_access.ts'
import { setWebHooks, type hooks as webHooks } from '../src/agent/tools/web.ts'
import { setImageHooks } from '../src/agent/tools/images.ts'
import { OAuthCredential } from '../src/auth/store.ts'
import { solidPng } from '../tests/png_fixture.ts'
import { ModelHTTPError } from '../src/llm/model.ts'
import { BRIDGE_TOKEN_FILE } from '../src/llm/chatgpt_web.ts'
import type { ComputerClient } from '../src/computer/desktop.ts'
import { BUGGY_CALC, CALC_TEST, FAKE_FULL, git, PassthroughRuntime, testConfig } from '../tests/harness.ts'
import { installNetworkGuard, TestNetworkBlocked } from '../tests/network_guard.ts'
// the frontend's own calculator fixture (a spec the contract's parser takes): the same surface the UI tests draw
import { calculator } from '../../frontend/tests/uiFixtures.ts'

// a synthetic user's name, put into its home path at run time: the committed source holds no literal home path for the
// repository's privacy scan to find (scripts/oss/lib/scan.mjs)
const SYNTH_HOME_USER = 'synthuser'

function fixtureRepo(root: string, name = 'userrepo'): string {
  const src = join(root, name)
  mkdirSync(src, { recursive: true })
  git(['init', '-q', '-b', 'main'], src)
  writeFileSync(join(src, 'calc.py'), BUGGY_CALC)
  writeFileSync(join(src, 'test_calc.py'), CALC_TEST)
  writeFileSync(join(src, 'AGENTS.md'), '# calc\nRun the tests with `python3 -m unittest -v`.\n')
  writeFileSync(join(src, '.gitignore'), '__pycache__/\n*.pyc\n')
  git(['add', '-A'], src)
  git(['commit', '-q', '-m', 'calc with a bug'], src)
  return src
}

const rec = (v: unknown) => (v ?? {}) as Record<string, unknown>

function fixingScript() {
  const final = (messages: ModelMessage[]) => {
    const run = rec(lastToolReturn(messages, 'bash'))
    return modelResponse([textPart(`**Fixed** \`add()\` in calc.py.\n\nTests: execution \`${run.execution_id}\` exit ${run.exit_code}.`)])
  }
  return steps(
    [textPart('Reading the code first.'), toolCallPart('read_file', { path: '.' }, '')],
    [toolCallPart('read_file', { path: 'calc.py' }, '')],
    [toolCallPart('edit_file', { path: 'calc.py', old_string: '    return a - b   # the bug: this should add', new_string: '    return a + b' }, '')],
    // the test runner writes its report on stderr, as they do: the card's terminal must show it on its own
    [toolCallPart('bash', { command: 'python3 -m unittest -v' }, '')],
    final,
  )
}

/** A second-turn script: one long command, so Stop now has something to kill. */
function slowScript() {
  return steps([toolCallPart('bash', { command: 'echo START; sleep 120; echo END', wait_s: 100 }, '')], [textPart('should not be reached')])
}

/** One command each message, read from the conversation itself (no counter of its own, unlike steps): every message
 *  sent runs it once, however many scenarios used the model before; then the answer. */
function commandEachTurn(command: string, waitS: number) {
  return (messages: ModelMessage[]) => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i]!
      if (!isRequest(m)) continue
      if (m.parts.some((p) => p.part_kind === 'tool-return' && p.tool_name === 'bash')) return modelResponse([textPart('ran it')])
      if (m.parts.some(isUserPrompt)) break
    }
    return modelResponse([toolCallPart('bash', { command, wait_s: waitS }, '')])
  }
}

/** A page on the e2e's own pretend web (`*.e2e.example`, played in process: nothing leaves the machine) that names
 *  its icon, and the icon: what a fetched page's source chip wears. */
const E2E_WEB = '.e2e.example'
const GUIDE_PAGE = '<html><head><title>Guide</title><link rel="icon" type="image/png" href="/assets/icon.png"></head><body><h1>Guide</h1><p>How the pretend site works.</p></body></html>'
const SITE_ICON = readFileSync(join(import.meta.dir, '..', '..', 'frontend', 'public', 'bots', 'icons', '08-prompt.png'))

/** The web tools' transport on the pretend web: its names resolve to a public address and its pages are served here;
 *  any other name is refused loudly — never looked up, never fetched. */
export function pretendWeb(): Pick<typeof webHooks, 'resolve' | 'fetchImpl'> {
  return {
    resolve: async (host) => {
      if (!host.endsWith(E2E_WEB)) throw new TestNetworkBlocked(`lookup ${host}`)
      return ['93.184.216.34']
    },
    fetchImpl: async (input) => {
      const u = new URL(String(input))
      if (!u.hostname.endsWith(E2E_WEB)) throw new TestNetworkBlocked(`fetch ${u.hostname}`)
      if (u.pathname === '/assets/icon.png') return new Response(SITE_ICON, { headers: { 'content-type': 'image/png' } })
      if (u.hostname === 'docs.e2e.example' && u.pathname === '/guide') return new Response(GUIDE_PAGE, { headers: { 'content-type': 'text/html' } })
      // a site only cited, whose home page names its icon (the chip asks the harness for it)
      if (u.hostname === 'cited.e2e.example' && u.pathname === '/') return new Response(GUIDE_PAGE, { headers: { 'content-type': 'text/html' } })
      return new Response('<html><body>Not found</body></html>', { status: 404, headers: { 'content-type': 'text/html' } })
    },
  }
}

/** A route that reads one page and cites it, beside two sites it only names (one with an icon, one without). */
function fetchScript() {
  return (messages: ModelMessage[]) => {
    const turn = messages.findLastIndex((m) => isRequest(m) && m.parts.some(isUserPrompt))
    if (!lastToolReturn(messages.slice(turn), 'fetch_url')) return modelResponse([toolCallPart('fetch_url', { url: 'https://docs.e2e.example/guide' }, '')])
    return modelResponse([textPart('Read [the guide](https://docs.e2e.example/guide); see also [the cited site](https://cited.e2e.example/news) and [the other site](https://other.e2e.example/).')])
  }
}

/** Computer use: a look at the page, a click on its button (the desktop app takes a moment over it), then the answer. */
function screenScript() {
  return (messages: ModelMessage[]) => {
    const turn = messages.findLastIndex((m) => isRequest(m) && m.parts.some(isUserPrompt))
    const since = messages.slice(turn)
    const looked = lastToolReturn(since, 'computer_observe')
    if (!looked) return modelResponse([toolCallPart('computer_observe', { surface: 'browser' }, '')])
    if (!lastToolReturn(since, 'computer_act')) return modelResponse([toolCallPart('computer_act', { surface: 'browser', action: 'click', ref: 'e7', snapshot_id: 'browser-1' }, '')])
    return modelResponse([textPart('SCREEN_DONE: the button is pressed.')])
  }
}

/** The desktop app's computer as the e2e plays it: a look answers at once, an action after a moment (the page's
 *  window in the thread is live meanwhile), each with a small picture. */
function fakeComputer(): ComputerClient {
  const picture = readFileSync(join(import.meta.dir, '..', 'tests', 'fixtures', 'images', 'red-7x5.jpg')).toString('base64')
  let looks = 0
  const look = (title: string) => {
    looks += 1
    return {
      status: 'ok', surface: 'browser', snapshot_id: `browser-${looks}`, url: 'https://shop.e2e.example/cart', title, loading: false,
      viewport: { width: 1280, height: 800 }, image: { media_type: 'image/jpeg', data_base64: picture, width: 7, height: 5 }, outline: '- button "Buy" [ref=e7]', dialog: null, notes: [],
    }
  }
  return {
    downloadsDir: null,
    request: async (path) => {
      if (path === '/computer/release') return { status: 'ok', released: ['browser'] }
      if (path === '/computer/observe') return look('Cart')
      await new Promise((r) => setTimeout(r, 2500))
      return { ...look('Thank you'), action: 'click', done: { clicked: 'e7' } }
    },
  }
}

/** A director of this harness (native): asked in words, it has Scripted Worker do the work and says it handed it on,
 *  ending its turn; woken by that run's end, it says the work is done. */
function directorScript() {
  return (messages: ModelMessage[]) => {
    const texts = userTexts(messages)
    const now = texts[texts.length - 1] ?? ''
    if (/App note: Runs (finished|ended):/.test(now)) return modelResponse([textPart('DIRECTOR_JUDGED: the worker is done.')])
    const turn = messages.findLastIndex((m) => isRequest(m) && m.parts.some(isUserPrompt))
    if (lastToolReturn(messages.slice(turn), 'start_run')) return modelResponse([textPart('DIRECTOR_HANDED: I asked Scripted Worker to do it.')])
    const session = /Session: (s_[0-9a-f]+)\./.exec(now)?.[1] ?? ''
    return modelResponse([toolCallPart('start_run', { session_id: session, text: 'do the work the person asked the director for', model: 'scripted:w' }, '')])
  }
}

/** The director's worker: a command that takes two seconds (so the director answers while it works), then done. */
function workerScript() {
  return (messages: ModelMessage[]) => {
    const turn = messages.findLastIndex((m) => isRequest(m) && m.parts.some(isUserPrompt))
    if (!toolReturns(messages.slice(turn)).some((p) => p.tool_name === 'bash')) return modelResponse([toolCallPart('bash', { command: 'sleep 2; echo worked', wait_s: 30 }, '')])
    return modelResponse([textPart('WORK_DONE: worked.')])
  }
}

/** A run under a work order: read the tree, answer with the count (stateless: it reads its own history). */
function orderScript() {
  return (messages: ModelMessage[]) => {
    const listed = lastToolReturn(messages, 'read_file')
    if (!listed) return modelResponse([textPart('Listing the files first.'), toolCallPart('read_file', { path: '.' }, '')])
    return modelResponse([textPart(`Inventory done: ${String(rec(listed).count)} files listed.`)])
  }
}

/** A change the session's mode may hold for approval: a note written into the worktree. */
function noteScript() {
  return (messages: ModelMessage[]) => {
    // the session's earlier turns patched calc.py: only what happened since this turn's words counts
    const turn = messages.findLastIndex((m) => isRequest(m) && m.parts.some((p) => isUserPrompt(p) && JSON.stringify(p.content).includes('write a note')))
    const wrote = rec(lastToolReturn(messages.slice(Math.max(0, turn)), 'write_file'))
    if (!wrote.status) return modelResponse([toolCallPart('write_file', { path: 'NOTES.md', content: 'reviewed before written\n' }, '')])
    return modelResponse([textPart(wrote.status === 'action_gated' ? 'The note waits for your approval.' : 'The note is written.')])
  }
}

/** An answer with math in the spellings models write — a line of `$$…$$` (the owner's formula), a `\[…\]` block,
 *  `\(…\)` and `$…$` inline, a star escaped for markdown (`\*`) — beside a price and a code span that are no math. */
const MATH_ANSWER = [
  '结论：',
  String.raw`$$ \epsilon_{\rm cov}(\mu,\pi^*)\ \text{实际上是}\ \epsilon_{\rm cov}^{\mathcal A}(\mu,\pi^*),\qquad \epsilon_{\rm cov}^{\rm DPO}\ \ge\ \epsilon_{\rm cov}^{\rm RM+RL} $$`,
  String.raw`where \(x_i\) is an input and $L(\theta)$ the loss:`,
  String.raw`\[`,
  String.raw`L(\theta^\*) = \sum_{i=1}^{n} \ell(f_\theta(x_i), y_i)`,
  String.raw`\]`,
  'A room costs $120–$180 per night; `echo $x$` prints it.',
].join('\n')

/** A plain folder a person keeps things in (three files): over the e2e's snapshot limit of two, so the page is
 *  refused the copy and offers to attach it. */
function stuffFolder(root: string): string {
  const stuff = join(root, 'stuff')
  mkdirSync(join(stuff, 'notes'), { recursive: true })
  writeFileSync(join(stuff, 'a.txt'), 'hello attached\n')
  writeFileSync(join(stuff, 'notes', 'todo.md'), '# todo\n- find the receipt\n')
  writeFileSync(join(stuff, 'b.txt'), 'second\n')
  return stuff
}

/** A route that takes images: it says what it was actually handed — how many images came with bytes, their names and
 *  sizes — so the page's upload, the chat and the provider boundary are checked by what reached the model. */
function eyeScript() {
  return (messages: ModelMessage[]) => {
    const images = messages.flatMap((m) => (isRequest(m) ? m.parts : [])).filter(isUserPrompt)
      .flatMap((p) => (Array.isArray(p.content) ? p.content : [])).filter(isImagePiece)
    const seen = images.map((i) => `${i.name} ${i.width}x${i.height}${typeof i.data === 'string' ? ` with ${Buffer.from(i.data, 'base64').length} bytes` : ' without bytes'}`)
    const files = messages.flatMap((m) => isRequest(m) ? m.parts : []).filter(isUserPrompt).flatMap((p) => Array.isArray(p.content) ? p.content : []).filter(isAnyFilePiece)
    return modelResponse([textPart(`I was handed ${images.length} image(s): ${seen.join('; ') || 'none'}. Files: ${files.map((f) => `${f.name} ${f.media_type} ${f.data ? 'with content' : 'MISSING'}`).join('; ')}.`)])
  }
}

/** A route that takes no PDF or video itself (and no image): it answers back, as one line `PATHPROBE <JSON>`, every
 *  reference note (`ref-v1`, contract refFileNote) it was handed, word for word, and the sha256 of its whole tool
 *  definitions as offered (names, descriptions and parameter schemas) — so the browser test reads, from the real
 *  run's record, what reached the model through the real upload, the real store and the real provider boundary, run
 *  after run. JSON, not markdown: a `#`, `_` or `*` in a path stays as it is. */
export const REF_NOTE_PREFIX = '[attached file (reference v1): '
function pathScript() {
  return (messages: ModelMessage[], info: { function_tools: unknown[] }) => {
    const notes = messages.flatMap((m) => (isRequest(m) ? m.parts : [])).filter(isUserPrompt)
      .flatMap((p) => (Array.isArray(p.content) ? p.content : [p.content])).filter((c): c is string => typeof c === 'string' && c.startsWith(REF_NOTE_PREFIX))
    const tools = createHash('sha256').update(JSON.stringify(info.function_tools)).digest('hex')
    const pieces = messages.flatMap((m) => (isRequest(m) ? m.parts : [])).filter(isUserPrompt).flatMap((p) => (Array.isArray(p.content) ? p.content : [])).filter(isAnyFilePiece)
    return modelResponse([textPart(`PATHPROBE ${JSON.stringify({ notes, tools_sha256: tools, tool_count: info.function_tools.length, file_pieces: pieces.length })}`)])
  }
}

/** The media script: makes a picture in the working folder with a command, reads it (the result names the image it
 *  hands the model, so the thread shows it), and names it in its answer as code and as an image. */
const PIXEL_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

function mediaScript() {
  return (messages: ModelMessage[]) => {
    const done = new Set(toolReturns(messages).map((p) => p.tool_name))
    if (!done.has('bash')) return modelResponse([toolCallPart('bash', { command: `python3 -c "import base64, os; b = base64.b64decode('${PIXEL_PNG_B64}'); open('shot.png', 'wb').write(b); os.makedirs('renders', exist_ok=True); open('renders/frame.png', 'wb').write(b)"` }, '')])
    if (!done.has('read_file')) return modelResponse([toolCallPart('read_file', { path: 'shot.png' }, '')])
    return modelResponse([textPart('Rendered `shot.png`:\n\n![the shot](shot.png)\n\nIn `renders/`:\n- `frame.png`\n- `gone.png`')])
  }
}

/** scripted:img: what the person's latest message asks, read from the conversation itself (no counter of its own):
 *  no image attached, generate_image makes one; an image attached, generate_image edits it (recent_images 1). After
 *  the tool's answer, one line: IMG_DONE / IMG_EDITED <asset_id>, or IMG_FAILED <status>. */
export function imageScript() {
  return (messages: ModelMessage[]) => {
    let at = 0
    for (let i = messages.length - 1; i >= 0; i -= 1) { const m = messages[i]!; if (isRequest(m) && m.parts.some(isUserPrompt)) { at = i; break } }
    const prompt = (messages[at] as { parts: UserPromptPart[] }).parts.filter(isUserPrompt)
    const attached = prompt.some((p) => Array.isArray(p.content) && p.content.some(isImagePiece))
    const done = rec(lastToolReturn(messages.slice(at), 'generate_image'))
    if (Object.keys(done).length) {
      if (done.status !== 'ok') return modelResponse([textPart(`IMG_FAILED ${String(done.status)}`)])
      return modelResponse([textPart(`${done.operation === 'edit' ? 'IMG_EDITED' : 'IMG_DONE'} ${String(done.asset_id)}`)])
    }
    // the person's own words: the last text piece of the message (the context lines come before it)
    const pieces = prompt.flatMap((p) => (typeof p.content === 'string' ? [p.content] : p.content.filter((c): c is string => typeof c === 'string')))
    const text = (pieces[pieces.length - 1] ?? '').trim() || 'an image'
    return modelResponse([toolCallPart('generate_image', { prompt: text, ...(attached ? { recent_images: 1 } : {}), size: '1024x640', quality: 'low' }, '')])
  }
}

/** The e2e's own image service (in process, no credentials read, nothing sent anywhere): a 64x64 PNG, red for a
 *  generation and blue for an edit; every request kept for GET /api/__e2e/image-requests. */
export const imageRequests: { kind: 'generate' | 'edit'; prompt: string; reference_sha256: string[] }[] = []
export function fakeImageService(): void {
  const red = solidPng(64, 64, [220, 30, 30])
  const blue = solidPng(64, 64, [30, 60, 220])
  setImageHooks({
    grants: { access: async () => new OAuthCredential({ access: 'e2e-fake-access', refresh: 'e2e-fake-refresh', expires_ms: Date.now() + 3_600_000, account_id: 'e2e-account', email: null }) },
    fetchImpl: async (input, init) => {
      const url = new URL(String(input))
      const kind = url.pathname.endsWith('/images/edits') ? 'edit' : url.pathname.endsWith('/images/generations') ? 'generate' : null
      if (url.hostname !== 'chatgpt.com' || kind === null) return new Response('not the image service', { status: 404 })
      const body = JSON.parse(String(init?.body ?? '{}')) as { prompt?: string; images?: { image_url?: string }[] }
      const reference_sha256 = (body.images ?? []).map((i) => createHash('sha256').update(Buffer.from(String(i.image_url ?? '').replace(/^data:[^,]*,/, ''), 'base64')).digest('hex'))
      imageRequests.push({ kind, prompt: String(body.prompt ?? ''), reference_sha256 })
      const png = kind === 'edit' ? blue : red
      return Response.json({ created: Math.floor(Date.now() / 1000), background: 'opaque', data: [{ b64_json: Buffer.from(png).toString('base64') }], output_format: 'png', quality: 'low', size: '64x64' })
    },
  })
}

/** The relay's first participant (an Anthropic-stamped route): reads calc.py and answers with a marker of its own —
 *  stateless, it reads its record, so a re-run or a second round answers the same way. */
export const RELAY_MARKER = 'RELAY_MARKER_7f3a'

function relayExecutorScript() {
  return (messages: ModelMessage[]) => {
    if (!toolReturns(messages).some((p) => p.tool_name === 'read_file' && rec(p.content).path === 'calc.py')) return modelResponse([toolCallPart('read_file', { path: 'calc.py' }, '')])
    return modelResponse([textPart(`${RELAY_MARKER}: add() subtracts — calc.py says \`return a - b\`; it should add.`)])
  }
}

/** The relay's second participant (an OpenAI-stamped route): it asserts, on the messages its provider is handed,
 *  that the packet of A's turn is there — A's answer with its marker, and the line of its read_file of calc.py
 *  that succeeded (the record of the read, which B can read again by path) — that the roster names B by its id,
 *  label and route with A before it in the speaking order, and that the note opening its turn has B speaking right
 *  after A; only then REVIEW_CONTEXT_OK. The participants' ids are whatever the person's chips carry: the roster's
 *  lines tell them. Nothing else (a resumed run id, a stored history, two answers on a page) counts as proof that it
 *  saw the first turn; no role is named anywhere, what it does with the turn is the person's message. */
export function relayReviewerScript() {
  return (messages: ModelMessage[]) => {
    const prompts = userTexts(messages)
    const idOf = (route: string) => prompts.map((t) => new RegExp(`^([\\w-]+): [^\\n]* \\(${route}\\)$`, 'm').exec(t)?.[1]).find(Boolean)
    const [a, b] = [idOf('scripted:relay-a'), idOf('scripted:relay-b')]
    // the packets of earlier turns: "Turn n (id, run …):" up to its "Measured:" line
    const packets = prompts.flatMap((t) => [...t.matchAll(/Turn (\d+) \(([\w-]+), run (run_[0-9a-f]+)\):\n([\s\S]*?)\nMeasured: /g)])
    const fromA = packets.filter((m) => a !== undefined && m[2] === a).map((m) => m[4]!)
    const marker = fromA.some((body) => body.includes(RELAY_MARKER))
    const read = fromA.some((body) => /\[read_file calc\.py → ok\b/.test(body))
    const roster = a !== undefined && b !== undefined && prompts.some((t) => t.includes(`${b}: Scripted Relay B (scripted:relay-b)`) && t.includes(`Speaking order: ${a}, ${b}.`))
    // the note that opened this turn is the last one: a later round has notes of its own, each with the turns before it
    const note = prompts.flatMap((t) => [...t.matchAll(/Turn (\d+) of (\d+)\. Speaker: ([\w-]+)\.\nEarlier turns: ([^\n]*)\./g)]).at(-1)
    const turn = note !== undefined && note[3] === b && note[4]!.split(', ').at(-1) === a
    if (marker && read && roster && turn) return modelResponse([textPart(`REVIEW_CONTEXT_OK — A (Scripted Relay A) read calc.py and found the bug; feedback: change \`a - b\` to \`a + b\` and run the tests.`)])
    return modelResponse([textPart(`REVIEW_CONTEXT_MISSING — marker ${marker}, read_file ${read}, roster ${roster}, turn ${turn}`)])
  }
}

/** The relay's slow first participant: one long command every time it is asked (stateless, so a Stop test can run
 *  after any other), never a second step. */
function relaySlowScript() {
  return (messages: ModelMessage[]) => {
    if (!toolReturns(messages).some((p) => p.tool_name === 'bash')) return modelResponse([toolCallPart('bash', { command: 'echo START; sleep 120; echo END', wait_s: 100 }, '')])
    return modelResponse([textPart('the command ended')])
  }
}

/** A run in a folder opened in place: list it, read a file, note what it said beside it, answer. */
function browseScript() {
  return steps(
    [toolCallPart('read_file', { path: '.' }, '')],
    [toolCallPart('read_file', { path: 'a.txt', offset: 1, limit: 40 }, '')],
    [toolCallPart('write_file', { path: 'found.md', content: 'a.txt says: hello attached\n' }, '')],
    [textPart('a.txt says "hello attached"; I noted it in found.md.')],
  )
}

/** The desktop app's ChatGPT bridge, played in process (the page signed in, its answers scripted): a message with
 *  the connector is ChatGPT directing, one without is ChatGPT answering as a participant — its answer forms over a
 *  poll (the reasoning, the first words) and is done on the next. What it was sent is read back at /e2e/sent. */
const BRIDGE_TOKEN = 'bridge-e2e'

function fakeChatGptBridge(): { url: string; stop: () => void } {
  const sent: Record<string, unknown>[] = []
  const polls = new Map<string, number>()
  let conversations = 0
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (req.headers.get('authorization') !== `Bearer ${BRIDGE_TOKEN}`) return Response.json({ detail: 'bad bridge token' }, { status: 401 })
      if (url.pathname === '/state') return Response.json({ ok: true, logged_in: true, generating: false, conversation: null, model: 'GPT-6 Pro' })
      if (url.pathname === '/e2e/sent') return Response.json(sent)
      if (url.pathname === '/stop') return Response.json({ stopped: false, reason: 'not_generating' })
      if (url.pathname === '/send') {
        const body = (await req.json()) as Record<string, unknown>
        sent.push(body)
        return Response.json({ accepted: true, message_id: `m${sent.length}`, conversation: { url: typeof body.conversation_url === 'string' ? body.conversation_url : `https://chatgpt.com/c/e2e-${(conversations += 1)}` } })
      }
      if (url.pathname === '/answer') {
        const turn = url.searchParams.get('turn_id') ?? ''
        const body = sent.find((b) => b.turn_id === turn)
        if (!body) return Response.json({ status: 'unknown' })
        const n = (polls.get(turn) ?? 0) + 1
        polls.set(turn, n)
        if (body.mention) return Response.json({ status: 'done', text: 'CHATGPT_DIRECTED: add() subtracts; I would have the agent change it to a + b.', model: 'GPT-6 Pro' })
        if (n === 1) return Response.json({ status: 'generating', progress: { thinking: 'Reading the words.', text: 'CHATGPT_', steps: [] } })
        return Response.json({ status: 'done', text: `CHATGPT_ANSWER: I read "${String(body.text).split('\n').at(-1)}".`, thinking: 'Reading the words.', model: 'GPT-6 Pro' })
      }
      return new Response('not found', { status: 404 })
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

/** Intelligent UI: a route that presents the price calculator through the real present_ui tool, then answers. It
 *  judges by this turn's own history (after the person's last words), never by a shared step count — so every run
 *  of the route presents once. Two test-only gates, each released by the test process (POST /e2e/ui-release?gate=…):
 *  words carrying UI_HOLD keep the run running after the surface is shown (gate "after"), so the surface is seen
 *  arriving live over SSE; words carrying UI_HOLD_BEFORE keep it running before present_ui is called (gate "before"),
 *  so the surface can be published while the page is disconnected. */
export const UI_HOLD = 'UI_HOLD_LIVE'
export const UI_HOLD_BEFORE = 'UI_HOLD_BEFORE'
const uiGates = new Map<string, () => void>()
function holdUi(name: string): Promise<void> {
  return new Promise<void>((resolve) => {
    // never held for ever: a test that fails before releasing must not keep the server from closing
    const timer = setTimeout(() => { uiGates.delete(name); resolve() }, 90_000)
    uiGates.set(name, () => { clearTimeout(timer); uiGates.delete(name); resolve() })
  })
}

/** In-run steering: one route whose run the test holds and releases (POST /e2e/ui-release?gate=steer), so the person's
 *  words can be sent while it works. Its opening words name the case; the words the person sent while the run worked
 *  (the user parts the harness marks with their steer_id — never any other prompt, the person's or the harness's) are
 *  answered back encoded —
 *  `STEER_ECHO <encodeURIComponent(words)>` — so the page compares them character for character. Stateless: it reads
 *  only this run's own history (from the request that carried the case), never a shared step count.
 *  - TOOL: held in its first request, then one quick command; the words go into the request after its result.
 *  - TEXT: held in its first request, then a plain answer with no tool; the run asks once more with the words.
 *  - STOP: a long command (stopped by the test); the words queued under it are never delivered.
 *  - RACE: held, then a plain answer: the test lets the run end before its words arrive (the harness's 409).
 *  Words sent before the run's first request reaches the model join that first request (the harness hands waiting
 *  words to the next request, the first one included) and are not echoed: the test sends them only once the run is
 *  held at its gate (GET /e2e/ui-gate?gate=steer says so), or — STOP — once its long command runs. */
export const STEER_CASES = { tool: 'STEER_CASE_TOOL', text: 'STEER_CASE_TEXT', stop: 'STEER_CASE_STOP', race: 'STEER_CASE_RACE' } as const
const STEER_MARKS = Object.values(STEER_CASES) as string[]
const isSteerPart = (p: UserPromptPart) => typeof (p as { steer_id?: unknown }).steer_id === 'string'
export function steerScript() {
  return async (messages: ModelMessage[]) => {
    const opens = (m: ModelMessage) => isRequest(m) && m.parts.some((p) => isUserPrompt(p) && STEER_MARKS.some((k) => userText(p).includes(k)))
    const start = Math.max(0, messages.findLastIndex(opens))
    const own = messages.slice(start)
    const words = JSON.stringify(own[0] ?? '')
    const kase = STEER_MARKS.find((k) => words.includes(k)) ?? STEER_CASES.text
    const answered = own.filter(isResponse).length
    const steered = own.slice(1).flatMap((m) => (isRequest(m) ? m.parts.filter(isUserPrompt).filter(isSteerPart) : []))
      .map((p) => (typeof p.content === 'string' ? p.content : userText(p)))
    if (steered.length) return modelResponse([textPart(`STEER_ECHO ${steered.map(encodeURIComponent).join(' ')} · answer ${answered + 1}`)])
    if (kase === STEER_CASES.stop) {
      if (answered === 0) return modelResponse([toolCallPart('bash', { command: 'echo START; sleep 120; echo END', wait_s: 100 }, '')])
      return modelResponse([textPart('STEER_STOP_REACHED')])
    }
    if (answered === 0) await holdUi('steer')
    if (kase === STEER_CASES.tool) {
      if (answered === 0) return modelResponse([toolCallPart('bash', { command: 'echo STEER_TOOL_RAN', wait_s: 30 }, '')])
      return modelResponse([textPart('STEER_NO_WORDS after the tool')])
    }
    return modelResponse([textPart(answered === 0 ? `STEER_FIRST_ANSWER (${kase})` : 'STEER_NO_WORDS')])
  }
}

function uiScript(title: string) {
  return async (messages: ModelMessage[]) => {
    const turn = messages.findLastIndex((m) => isRequest(m) && m.parts.some(isUserPrompt))
    const since = messages.slice(Math.max(0, turn))
    const shown = rec(lastToolReturn(since, 'present_ui'))
    const words = JSON.stringify(messages[turn] ?? '')
    if (!shown.status) {
      if (words.includes(UI_HOLD_BEFORE)) await holdUi('before')
      return modelResponse([toolCallPart('present_ui', calculator({ title }), '')])
    }
    if (words.includes(UI_HOLD)) await holdUi('after')
    return modelResponse([textPart(`UI_SHOWN ${title}: ${String(shown.status)} revision ${String(shown.revision)}.`)])
  }
}

/** The offline session share's fixture (frontend/e2e/session-share.e2e.ts): every value is synthetic. The canaries
 *  are written into the session's own records by real tools — a dotenv file, an opaque auth file, an environment
 *  dump of a cleared environment (only the synthetic variable is in it), a bearer header, an e-mail and a home path in
 *  a command's output, a long output whose tail only a folded preview holds — and the answer carries Chinese prose,
 *  markdown (table, code) and hostile HTML. The e2e file holds the same strings: change them in both places. */
export const SHARE_FIXTURE = {
  dotenv: 'DOTENVCANARY_7c1f',
  auth: 'OPAQUEAUTHCANARY_9f8e',
  env: 'ENVOUTCANARY_51d3',
  bearer: 'BEARERCANARY0123456789abcdef',
  needle: 'FOLDEDNEEDLE',
  answer_mark: 'MAIN_ANSWER_ONCE_4b2',
  /** the actions the e2e file takes beside the agents through the real routes (POST /api/workspaces/:id/commands with
   *  the connector's client header ChatGPT, a checkpoint by hand): a benign command of several lines that prints a
   *  bearer header (redacted in its text and its output preview) and its own mark; a command that writes and reads a
   *  dotenv and an auth file of its own under the worktree, and a dump of a cleared environment (only the synthetic
   *  variable in it) — both withheld whole. Nothing reads the machine's own environment or files. */
  action: {
    mark: 'ACTION_MULTI_MARK_3e9a',
    bearer: 'ACTIONBEARERCANARY0123456789abcd',
    dotenv: 'ACTIONDOTENVCANARY_5b7c',
    auth: 'ACTIONAUTHCANARY_2d4f',
    env: 'ACTIONENVCANARY_8a61',
    checkpoint_note: 'before the share (synthetic)',
  },
} as const

function shareScript() {
  return (messages: ModelMessage[]) => {
    const turn = messages.findLastIndex((m) => isRequest(m) && m.parts.some(isUserPrompt))
    const words = JSON.stringify(messages[turn] ?? '')
    // a run the person leaves out of the share: its words come back, nothing else
    const excluded = /EXCLUDEDRUNCANARY_\w+/.exec(words)?.[0]
    if (excluded) return modelResponse([textPart(`Answered ${excluded} as asked.`)])
    if (words.includes('SHARE_RESUME')) return modelResponse([textPart('续写：在同一个对话里继续，之前的回答不重复。RESUMED_ANSWER_MARK')])
    const done = toolReturns(messages.slice(turn)).length
    const F = SHARE_FIXTURE
    const calls = [
      () => toolCallPart('bash', { command: `printf 'SYNTH_DB_PASSWORD=${F.dotenv}\\n' > .env && printf '{"refresh":"${F.auth}"}' > auth.json && echo wrote`, wait_s: 30 }, ''),
      () => toolCallPart('read_file', { path: '.env' }, ''),
      () => toolCallPart('read_file', { path: 'auth.json' }, ''),
      () => toolCallPart('bash', { command: `env -i SYNTH_ONLY=${F.env} printenv`, wait_s: 30 }, ''),
      () => toolCallPart('bash', { command: `echo "Authorization: Bearer ${F.bearer}"; echo alice.synthetic@example.com; echo /Users/${SYNTH_HOME_USER}/private/notes.txt`, wait_s: 30 }, ''),
      // the needle is joined only in the output (never written whole in the command): only the folded preview holds it
      () => toolCallPart('bash', { command: `python3 -c "print('${F.needle.slice(0, 6)}' + '${F.needle.slice(6)} ' + '长输出 ' * 1500)"`, wait_s: 30 }, ''),
      () => toolCallPart('read_file', { path: 'calc.py' }, ''),
    ]
    if (done < calls.length) return modelResponse([...(done === 0 ? [textPart('先看一下配置。')] : []), calls[done]!()])
    return modelResponse([textPart([
      `## 内部说明 ${F.answer_mark}`,
      '',
      '这是内部文档的说明：`calc.py` 里的 `add()` 把加法写成了减法，测试会失败。',
      '',
      '| 文件 | 状态 |',
      '| --- | --- |',
      '| calc.py | 需要修改 |',
      '',
      '```python',
      'def add(a, b):',
      '    return a + b  # </script><script>window.__xss = "fence"</script>',
      '```',
      '',
      'Hostile: </script><script>window.__xss = "answer"</script> <img src=x onerror="window.__xss=\'img\'"> <iframe src="https://evil.e2e.example/"></iframe>',
      '[a javascript link](javascript:window.__xss=\'link\') and ![a tracker](https://tracker.e2e.example/t.png) and [a site](https://docs.e2e.example/guide?token=QUERYCANARY_33aa).',
      `Mail alice.synthetic@example.com, home /Users/${SYNTH_HOME_USER}/private/notes.txt.`,
    ].join('\n'))])
  }
}

/** POST /e2e/live-share/expires-at?link=<sl_…>&in_ms=<n> (the session token as a bearer): the link's stored expiry set
 *  to now + n ms (n from −60 s to 10 min), so a test sees a link expire in seconds where the product's shortest life is
 *  five minutes — the product's own bounds untouched. Only on this server's port: the share listener is the product's
 *  own and never routes here. */
function liveShareExpiresAt(req: Request, url: URL, conn: Conn): Response {
  if (req.method !== 'POST' || req.headers.get('authorization') !== 'Bearer e2e-token') return new Response('no', { status: 403 })
  const link = url.searchParams.get('link') ?? ''
  const inMs = Number(url.searchParams.get('in_ms'))
  if (!/^sl_[A-Za-z0-9_-]{22}$/.test(link) || !Number.isInteger(inMs) || inMs < -60_000 || inMs > 600_000) return Response.json({ detail: 'link and in_ms' }, { status: 422 })
  if (!conn.get('SELECT id FROM share_links WHERE id = ?', [link])) return Response.json({ detail: 'no such link' }, { status: 404 })
  const expires_at = new Date(Date.now() + inMs).toISOString()
  conn.run('UPDATE share_links SET expires_at = ? WHERE id = ?', [expires_at, link])
  return Response.json({ link, expires_at })
}

async function main(): Promise<void> {
  const port = Number(process.argv[2] ?? 8399)
  // under /tmp: the browser path walks to the fixture through the page's folder dialog, and on macOS the default
  // temp root (/private/var/folders/…) cannot be listed on the way down
  // OASIS_CODE_E2E_TMP: another parent where /tmp cannot be written (a sandboxed runner); the folder-dialog tests
  // then need a parent the dialog can walk to
  const root = mkdtempSync(join(process.env.OASIS_CODE_E2E_TMP || '/tmp', 'oasis-code-e2e-'))
  const src = fixtureRepo(root)
  // a second repository of the same synthetic content: the project of a task's session that joins from another project
  // (the task share's e2e: sessions of one task across projects, only by their task relation)
  const srcB = fixtureRepo(root, 'userrepo_b')
  const stuff = stuffFolder(root)
  const naturalSource = join(root, SOURCE_NAME)
  mkdirSync(naturalSource)
  writeFileSync(join(naturalSource, 'experiment.jsonl'), '{"seed":7,"loss":0.125}\n')
  // the scripted routes name these variables; a fake value makes them "available (env)" in the catalogue
  process.env.OASIS_TEST_KEY_A ??= 'e2e-fake-key-a'
  process.env.OASIS_TEST_KEY_B ??= 'e2e-fake-key-b'
  // a snapshot limit of two files: the fixture repository is cloned (no measure), the plain folder is refused
  const settings = new Settings({ data_dir: join(root, 'data'), host: '127.0.0.1', port, session_token: 'e2e-token', snapshot_max_files: 2 })
  const config = testConfig()
  config.checks = [{ id: 'unit', command: 'python3 -m unittest -v 2>&1', parser: 'exit_code', timeout_s: 600, required: true }]
  // confirmed as on a machine where the person said yes once; the scenario of the question itself starts unconfirmed
  config.full_access_confirmed = !process.argv.slice(3).includes('--full-access-unconfirmed')
  // a third route for work orders: list the files, answer with the count
  config.models.push(new ModelConfig({ id: 'scripted:c', label: 'Scripted C', provider: 'openai', model: 'scripted-c', api_key_env: 'OASIS_TEST_KEY_B' }))
  // a fourth route for the attached folder: browse it, note a file in the scratch
  config.models.push(new ModelConfig({ id: 'scripted:d', label: 'Scripted D', provider: 'openai', model: 'scripted-d', api_key_env: 'OASIS_TEST_KEY_B' }))
  // a fifth route that takes images
  config.models.push(new ModelConfig({ id: 'scripted:e', label: 'Scripted Eye', provider: 'anthropic', model: 'scripted-e', api_key_env: 'OASIS_TEST_KEY_A', capabilities: { images: true, pdf: true, video: ['video/mp4', 'video/webm', 'video/quicktime'] } }))
  // a route that takes no PDF, video or image itself: every reference is its path line (the full-stack upload test)
  config.models.push(new ModelConfig({ id: 'scripted:path', label: 'Scripted Path', provider: 'openai', model: 'scripted-path', api_key_env: 'OASIS_TEST_KEY_B', capabilities: { images: false } }))
  config.models.push(new ModelConfig({ id: 'scripted:media', label: 'Scripted Media', provider: 'anthropic', model: 'scripted-media', api_key_env: 'OASIS_TEST_KEY_A', capabilities: { images: true } }))
  config.models.push(new ModelConfig({ id: 'scripted:cmd', label: 'Scripted Echo', provider: 'anthropic', model: 'scripted-cmd', api_key_env: 'OASIS_TEST_KEY_A' }))
  config.models.push(new ModelConfig({ id: 'scripted:long', label: 'Scripted Long', provider: 'anthropic', model: 'scripted-long', api_key_env: 'OASIS_TEST_KEY_A' }))
  // a route that writes a note (held for approval under Ask before changes)
  // takes images: the live-share e2e's approval turn runs on a session whose history carries a picture (no suite counts
  // on this route refusing one; the composer's refusal is Scripted D's)
  config.models.push(new ModelConfig({ id: 'scripted:g', label: 'Scripted Note', provider: 'openai', model: 'scripted-g', api_key_env: 'OASIS_TEST_KEY_B', capabilities: { images: true } }))
  // a route that answers with links: three the renderer refuses, a relative path, a web page
  config.models.push(new ModelConfig({ id: 'scripted:l', label: 'Scripted Links', provider: 'openai', model: 'scripted-l', api_key_env: 'OASIS_TEST_KEY_B' }))
  config.models.push(new ModelConfig({ id: 'scripted:m', label: 'Scripted Math', provider: 'openai', model: 'scripted-m', api_key_env: 'OASIS_TEST_KEY_B' }))
  // a route that reads a page of the pretend web
  config.models.push(new ModelConfig({ id: 'scripted:f', label: 'Scripted Fetch', provider: 'openai', model: 'scripted-f', api_key_env: 'OASIS_TEST_KEY_B' }))
  // a route that uses the desktop app's pages (computer use)
  config.models.push(new ModelConfig({ id: 'scripted:screen', label: 'Scripted Screen', provider: 'anthropic', model: 'scripted-screen', api_key_env: 'OASIS_TEST_KEY_A', capabilities: { images: true } }))
  // a session's own director and the worker it hands work to
  config.models.push(new ModelConfig({ id: 'scripted:dir', label: 'Scripted Director', provider: 'anthropic', model: 'scripted-dir', api_key_env: 'OASIS_TEST_KEY_A' }))
  config.models.push(new ModelConfig({ id: 'scripted:w', label: 'Scripted Worker', provider: 'openai', model: 'scripted-w', api_key_env: 'OASIS_TEST_KEY_B' }))
  // a route whose credentials the provider refuses (its error quotes the key, as some do)
  config.models.push(new ModelConfig({ id: 'scripted:x', label: 'Scripted Locked', provider: 'anthropic', model: 'scripted-x', api_key_env: 'OASIS_TEST_KEY_A' }))
  // the relay's two routes, on two providers: the first reads and marks, the second proves what it was handed
  config.models.push(new ModelConfig({ id: 'scripted:relay-a', label: 'Scripted Relay A', provider: 'anthropic', model: 'scripted-relay-a', api_key_env: 'OASIS_TEST_KEY_A' }))
  config.models.push(new ModelConfig({ id: 'scripted:relay-b', label: 'Scripted Relay B', provider: 'openai', model: 'scripted-relay-b', api_key_env: 'OASIS_TEST_KEY_B' }))
  // Intelligent UI: two routes that present the same surface id (the calculator) under different titles
  config.models.push(new ModelConfig({ id: 'scripted:ui-a', label: 'Scripted UI A', provider: 'openai', model: 'scripted-ui-a', api_key_env: 'OASIS_TEST_KEY_B' }))
  config.models.push(new ModelConfig({ id: 'scripted:ui-b', label: 'Scripted UI B', provider: 'openai', model: 'scripted-ui-b', api_key_env: 'OASIS_TEST_KEY_B' }))
  config.models.push(new ModelConfig({ id: 'scripted:relay-slow', label: 'Scripted Relay Slow', provider: 'anthropic', model: 'scripted-relay-slow', api_key_env: 'OASIS_TEST_KEY_A' }))
  // in-run steering: a run the test holds and releases, which answers back the words sent while it worked
  // image generation and editing through a fake image service
  config.models.push(new ModelConfig({ id: 'scripted:img', label: 'Scripted Image', provider: 'anthropic', model: 'scripted-img', api_key_env: 'OASIS_TEST_KEY_A', capabilities: { images: true } }))
  config.models.push(new ModelConfig({ id: 'scripted:steer', label: 'Scripted Steer', provider: 'anthropic', model: 'scripted-steer', api_key_env: 'OASIS_TEST_KEY_A' }))
  // the offline session share's fixture route (synthetic canaries through real tools)
  config.models.push(new ModelConfig({ id: 'scripted:share', label: 'Scripted Share', provider: 'anthropic', model: 'scripted-share', api_key_env: 'OASIS_TEST_KEY_A' }))
  const natural = naturalFixtureRoutes()
  config.models.push(...natural.config)
  // the live session share's route (frontend/e2e/live-share.e2e.ts): held by gates of this server's own
  const live = liveShareRoutes(holdUi)
  config.models.push(...live.config)
  // Opt-in for the natural-language browser instance only; all existing suites keep testConfig's default.
  if (process.argv.slice(3).includes('--natural-default')) config.default_model = NATURAL_DIRECTOR
  const models = {
    ...natural.models,
    ...live.models,
    'scripted:a': scriptedModel(fixingScript(), 'scripted-a'), 'scripted:b': scriptedModel(slowScript(), 'scripted-b'), 'scripted:c': scriptedModel(orderScript(), 'scripted-c'),
    'scripted:d': scriptedModel(browseScript(), 'scripted-d'), 'scripted:e': scriptedModel(eyeScript(), 'scripted-e'),
    'scripted:media': scriptedModel(mediaScript(), 'scripted-media'),
    'scripted:cmd': scriptedModel(commandEachTurn('echo ran', 30), 'scripted-cmd'),
    'scripted:long': scriptedModel(commandEachTurn('echo START; sleep 120; echo END', 100), 'scripted-long'),
    'scripted:path': scriptedModel(pathScript(), 'scripted-path'),
    'scripted:x': scriptedModel(() => { throw new ModelHTTPError(401, 'scripted-x', { error: { message: 'invalid x-api-key: sk-ant-api03-E2ESECRETE2ESECRET' } }) }, 'scripted-x'),
    'scripted:g': scriptedModel(noteScript(), 'scripted-g'),
    'scripted:m': scriptedModel(() => modelResponse([textPart(MATH_ANSWER)]), 'scripted-m'),
    'scripted:f': scriptedModel(fetchScript(), 'scripted-f'),
    'scripted:screen': scriptedModel(screenScript(), 'scripted-screen'),
    'scripted:dir': scriptedModel(directorScript(), 'scripted-dir'), 'scripted:w': scriptedModel(workerScript(), 'scripted-w'),
    'scripted:l': scriptedModel(() => modelResponse([textPart('Links: [JS sentinel](javascript:alert(1)) [Data sentinel](data:text/html,<b>x</b>) [File sentinel](file:///etc/hosts) [relative](calc.py) [site](https://example.com/page)')]), 'scripted-l'),
    'scripted:relay-a': stampedModel(relayExecutorScript(), 'anthropic', 'scripted-relay-a'),
    'scripted:relay-b': stampedModel(relayReviewerScript(), 'openai', 'scripted-relay-b'),
    'scripted:relay-slow': stampedModel(relaySlowScript(), 'anthropic', 'scripted-relay-slow'),
    'scripted:ui-a': scriptedModel(uiScript('Price calculator A'), 'scripted-ui-a'),
    'scripted:ui-b': scriptedModel(uiScript('Price calculator B'), 'scripted-ui-b'),
    'scripted:steer': scriptedModel(steerScript(), 'scripted-steer'),
    'scripted:img': scriptedModel(imageScript(), 'scripted-img'),
    'scripted:share': scriptedModel(shareScript(), 'scripted-share'),
  }
  // OASIS_CODE_E2E_PASSTHROUGH=1: a machine without the OS sandbox (a CI container) runs the fixture's commands as
  // they are, reporting the fake full isolation the unit tests use — a test of the product's path, never of the sandbox
  const passthrough = process.env.OASIS_CODE_E2E_PASSTHROUGH === '1'
  // nothing but the pretend web and the loopback: the global fetch refuses every other host
  installNetworkGuard()
  setWebHooks(pretendWeb())
  fakeImageService()
  // the desktop app's ChatGPT bridge and the token it keeps in the data directory
  const bridge = fakeChatGptBridge()
  mkdirSync(settings.data_dir, { recursive: true })
  writeFileSync(join(settings.data_dir, BRIDGE_TOKEN_FILE), BRIDGE_TOKEN, { mode: 0o600 })
  const built = await createApp(settings, config, { model_overrides: models, probe: !passthrough, chatgpt: { url: bridge.url, poll_ms: 200 }, computer: fakeComputer(),
    ...(passthrough ? { runtime: new PassthroughRuntime(), isolation: { ...FAKE_FULL, runtime: 'passthrough' } } : {}) })
  await built.start()
  // the one route of the test's own: the release of a held Intelligent UI run (behind the session token)
  // the server goes on with the request: the app reads the caller's address from it (a loopback caller is "local")
  const fetch = (req: Request, srv: unknown) => {
    const url = new URL(req.url)
    // what the fake image service was asked (prompts and the sha256 of the references): test data only, no secret
    if (url.pathname === '/api/__e2e/image-requests' && req.method === 'GET') return Response.json(imageRequests)
    // whether a run is held at a test gate now (its model request entered and waits): read only, behind the token
    if (url.pathname === '/e2e/ui-gate') {
      if (req.method !== 'GET' || req.headers.get('authorization') !== 'Bearer e2e-token') return new Response('no', { status: 403 })
      return Response.json({ held: uiGates.has(url.searchParams.get('gate') ?? 'after') })
    }
    // the live share's expiry, brought near (test-only, this port only — never the share listener's): the link's row
    // is given a new expires_at, which the share reads when a viewer connects (frontend/e2e/live-share.e2e.ts)
    if (url.pathname === '/e2e/live-share/expires-at') return liveShareExpiresAt(req, url, built.state.conn)
    if (url.pathname !== '/e2e/ui-release') return built.fetch(req, srv)
    if (req.method !== 'POST' || req.headers.get('authorization') !== 'Bearer e2e-token') return new Response('no', { status: 403 })
    const release = uiGates.get(url.searchParams.get('gate') ?? 'after')
    const held = release !== undefined
    release?.()
    return Response.json({ released: held })
  }
  const server = Bun.serve({ hostname: '127.0.0.1', port, fetch, idleTimeout: 255 })
  console.log(JSON.stringify({ port: server.port, repo: src, repo_b: srcB, stuff, default_model: config.default_model, natural_source: naturalSource, natural_director: NATURAL_DIRECTOR, natural_fable: NATURAL_FABLE, natural_slow: NATURAL_SLOW, natural_sentences: { battle: GAN_BATTLE_SENTENCE, independent: INDEPENDENT_SENTENCE, slow: SLOW_SENTENCE }, token: 'e2e-token', data: join(root, 'data'), isolation: built.state.isolation.enforcement, chatgpt_bridge: bridge.url, bridge_token: BRIDGE_TOKEN }))
  // the uploads this server's own store sealed are unsealed before its folder goes (only its own store's files)
  const unsealOwnUploads = () => {
    const store = built.state.store.root
    for (const project of (() => { try { return readdirSync(store) } catch { return [] } })()) {
      const ref = join(store, project, 'ref')
      for (const name of (() => { try { return readdirSync(ref) } catch { return [] } })()) {
        const file = join(ref, name)
        try { if (lstatSync(file).isFile()) unsealStoredFile(file, { data_dir: settings.data_dir, store_root: store }) } catch { /* not a store file */ }
      }
    }
  }
  const stop = async () => { server.stop(); bridge.stop(); await built.close(); unsealOwnUploads(); rmSync(root, { recursive: true, force: true }); process.exit(0) }
  process.on('SIGTERM', () => { void stop() })
  process.on('SIGINT', () => { void stop() })
}

// imported by a test for its scripts: only the entry point starts the server
if (import.meta.main) await main()
