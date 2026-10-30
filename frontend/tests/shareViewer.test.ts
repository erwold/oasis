/** The session share's viewer, drawn in jsdom from a rich synthetic snapshot: the app's OWN thread components
 *  (ThreadTranscript.tsx, Prose, CallDetail, Media, SourceChip, BotImage) under the share's presentation, with the
 *  same stand-ins the viewer build puts in place of the page store, the API, the desk and the interactive blocks
 *  (src/share/viewer/offline/standIns.ts). The page's storage and every network API are traps: the test fails if the
 *  viewer touches one. What is checked: the product's markup and classes, every snapshot item shown once, folds and the
 *  palette working, and no control that would act, no link that would open, no picture that would load. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerHooks } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { JSDOM } from 'jsdom'
import { STAND_INS } from '../src/share/viewer/offline/standIns.ts'
import { SHARE_PAGE_FORMAT, SHARE_PAGE_VERSION, type ShareDocument } from '../src/share/document.ts'
import { dataBlockJson } from '../src/state/shareHtml.ts'
import { richSnapshot } from './shareFixtures.ts'

const SRC = fileURLToPath(new URL('../src/', import.meta.url))
const OFFLINE = join(SRC, 'share/viewer/offline')
const used = new Set<string>()

// the app is bundled by Vite: for Node, extensionless imports resolve to .ts/.tsx, components compile with TypeScript,
// a stylesheet or an image is its URL — and, as in the viewer build, the app's modules that would reach the harness or
// the storage resolve to the offline stand-ins
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL?.startsWith('file:') && context.parentURL.includes('/frontend/src/')) {
      const parent = fileURLToPath(context.parentURL)
      const target = resolve(dirname(parent), specifier).replace(/\.(tsx?|jsx?)$/, '')
      const key = relative(SRC, target)
      if (!parent.startsWith(OFFLINE) && STAND_INS[key]) { used.add(key); return next(pathToFileURL(join(OFFLINE, STAND_INS[key]!)).href, context) }
      if (!/\.[a-z]+$/i.test(specifier)) {
        for (const ext of ['.ts', '.tsx']) { const u = new URL(`${specifier}${ext}`, context.parentURL); if (existsSync(u)) return next(u.href, context) }
      }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (/\.(css|png|svg)$/.test(url)) return { format: 'module', source: `export default ${JSON.stringify(url)}`, shortCircuit: true }
    if (url.startsWith('file:') && url.endsWith('.tsx')) {
      const file = fileURLToPath(url)
      return { format: 'module', source: ts.transpileModule(readFileSync(file, 'utf8'), { fileName: file, compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText, shortCircuit: true }
    }
    return next(url, context)
  },
})

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const doc: ShareDocument = {
  format: SHARE_PAGE_FORMAT, version: SHARE_PAGE_VERSION, theme: 'dark', snapshot: richSnapshot(),
  pictures: Object.fromEntries(['img1', 'img2', 'img3', 'img4', 'img5'].map((k) => [k, { src: PNG, width: 1, height: 1 }])),
  page: { images_rejected: 0, images_over_page_budget: 0 },
  faces: { r1: { bot: '05-bubble', enclosed: false }, r2: { bot: '13-puzzle', enclosed: true } }, bots: { '05-bubble': PNG, '13-puzzle': PNG, director: PNG, chatgpt: PNG },
}

// ---- the page: jsdom, its storage and every network API a trap ---------------------------------------------------
const dom = new JSDOM(`<!doctype html><html><body><div id="root"></div><script type="application/json" id="share-data">${dataBlockJson(doc)}</script></body></html>`,
  { url: 'https://share.invalid/', pretendToBeVisual: true })
const touched: string[] = []
const trap = (what: string) => () => { touched.push(what); throw new Error(`the viewer touched ${what}`) }
for (const target of [globalThis, dom.window] as Record<string, unknown>[]) {
  for (const name of ['localStorage', 'sessionStorage', 'indexedDB']) Object.defineProperty(target, name, { configurable: true, get: trap(name) })
  for (const name of ['fetch', 'XMLHttpRequest', 'EventSource', 'WebSocket', 'Worker']) Object.defineProperty(target, name, { configurable: true, writable: true, value: trap(name) })
}
Object.defineProperty(dom.window.navigator, 'sendBeacon', { configurable: true, value: trap('sendBeacon') })
Object.defineProperty(dom.window.navigator, 'clipboard', { configurable: true, get: trap('clipboard') })
let dark = false
const queries: (() => void)[] = []
dom.window.matchMedia = ((q: string) => ({ get matches() { return dark && q.includes('dark') }, media: q, addEventListener: (_: string, f: () => void) => queries.push(f), removeEventListener: () => undefined })) as unknown as typeof dom.window.matchMedia
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node,
  MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} disconnect() {} unobserve() {} }, __OASIS_CODE_BUILD__: 'test',
})
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
const errors: unknown[] = []
const consoleError = console.error
console.error = (...args: unknown[]) => { errors.push(args); consoleError(...args) }

const { act } = await import('react')
// the viewer's own entry: it reads the data block, checks it, and draws
await act(async () => { await import('../src/share/viewer/entry.tsx') })
const d = dom.window.document
const q = (sel: string, root: ParentNode = d) => root.querySelector(sel) as HTMLElement | null
const qa = (sel: string, root: ParentNode = d) => [...root.querySelectorAll(sel)] as HTMLElement[]
const click = async (el: Element | null) => { assert.ok(el, 'nothing to click'); await act(async () => { (el as HTMLElement).click() }) }
const section = (id: string) => q(`[data-testid="${id}"]`)!

test('the viewer is the app\'s thread: its shell, its turns, its classes; the stand-ins took the store, the API and the desk', () => {
  for (const m of ['state/store', 'api/client', 'components/Desk']) assert.ok(used.has(m), m)
  assert.ok(q('.app-shell .thread.desk-main > .thread-header .thread-title'))
  assert.equal(q('.thread-title')!.textContent, 'Rich synthetic session')
  assert.ok(q('.thread-scroll[data-testid="thread"]'))
  assert.equal(d.documentElement.dataset.theme, 'dark')
  const r1 = section('run-r1')
  assert.ok(r1.classList.contains('turn-group'))
  assert.equal(q('.turn.turn-user .turn-text', r1)!.textContent, 'Fix the parser, see the screenshots')
  // the person's pictures: the page's own data URL, and a card for the one not carried
  assert.equal(qa('.turn-images img', r1)[0]!.getAttribute('src'), PNG)
  assert.ok(q('[data-testid="attachment-omitted"]', r1)!.textContent!.includes('over the export'))
  // the answer: the bot the app drew, the model's name, the product's prose (code block, table, math)
  const answer = qa('.turn.turn-agent', r1).at(-1)!
  assert.equal(q('.turn-who img.bot-img', answer)!.getAttribute('src'), PNG)
  assert.equal(q('.turn-who img.bot-img', answer)!.dataset.bot, '05-bubble')
  assert.ok(q('.turn-who', answer)!.textContent!.includes('Model A'))
  assert.ok(q('.code-block .code-lang', answer)!.textContent === 'ts')
  assert.ok(q('.code-block', answer)!.textContent!.includes('const a = "</script>"'))
  assert.ok(q('.prose-table table', answer))
  assert.ok(q('.katex', answer))
  // a participant's turn enclosed in its bot's colour, as the app drew it
  assert.ok(q('.agent-span', section('run-r2')))
  assert.equal(errors.length, 0)
})

test('nothing acts and nothing loads: no copy, records, put-back, accounts, undo, download; no link to open; only data: pictures', async () => {
  const forbidden = ['copy-text', 'code-copy', 'steer-put-back', 'failure-accounts', 'failure-chatgpt', 'undo-run', 'node-adopt', 'relay-continue', 'interaction-continue',
    'generated-image-download', 'media-viewer-download', 'opened-session', 'share-open', 'stop', 'replay', 'director-turn-cancel', 'call-raw']
  for (const id of forbidden) assert.equal(qa(`[data-testid="${id}"]`).length, 0, id)
  assert.equal(qa('[data-testid^="records-"],[data-testid^="cite-run-"],[data-testid^="receive-run-"]').length, 0)
  assert.equal(qa('a[href],form,input,textarea,iframe,video,audio,link').length, 0)
  for (const img of qa('img')) assert.ok(img.getAttribute('src')!.startsWith('data:image/png;base64,'), img.outerHTML)
  // the words' links and pictures: inert, their words kept
  const answer = qa('.turn.turn-agent', section('run-r1')).at(-1)!
  assert.ok(q('.source-chip[data-testid="link-inert"]', answer)!.title.includes('example.invalid/docs'))
  assert.deepEqual(qa('[data-testid="prose-img-inert"]', answer).map((s) => s.textContent), ['remote', 'inline'])
  // every button left is a fold, a picture to open in place, or the palette
  for (const b of qa('button')) {
    assert.ok(b.matches('.work-head, .activity-line.expandable, .note-fold, .sources-toggle, .generated-image-open, .shown-image, [data-testid^="share-theme-"], .media-viewer-close'), b.outerHTML.slice(0, 160))
  }
  assert.deepEqual(touched, [])
})

test('folds open the rows: a tool\'s line is the snapshot\'s target, its detail the snapshot\'s cut preview, a withheld one says so', async () => {
  const r1 = section('run-r1')
  const work = q('.work', r1)!
  assert.ok(!work.classList.contains('open'), 'an earlier turn\'s work is folded, as in the app')
  await click(q('.work-head', work))
  const rows = qa('.activity.row', work)
  assert.deepEqual(rows.map((r) => r.dataset.tool), ['read_file', 'bash'])
  assert.equal(q('.line', rows[0])!.textContent, 'src/parser.ts')
  await click(q('.activity-line', rows[0]))
  assert.ok(q('[data-testid="call-preview"]', rows[0])!.textContent!.includes('export function parse'))
  assert.ok(q('[data-testid="call-preview-note"]', rows[0])!.textContent!.includes('cut here'))
  await click(q('.activity-line', rows[1]))
  assert.ok(q('[data-testid="call-withheld"]', rows[1]))
  // the look's screenshot: under its row once opened, the page's own picture
  const look = qa('.activity.row', r1).find((r) => r.dataset.tool === 'computer_observe')
  if (!look) await click(qa('.work-head', r1)[1]!)
  const row = qa('.activity.row', r1).find((r) => r.dataset.tool === 'computer_observe')!
  assert.ok(q('.activity-shot-mark', row))
  await click(q('.activity-line', row))
  assert.equal(q('[data-testid="activity-shot"] img', row)!.getAttribute('src'), PNG)
  assert.deepEqual(touched, [])
})

test('steers say who sent them as the snapshot does — never "you", an unrecorded one by its own words — with their state', () => {
  const who = qa('[data-testid="steer-who"]').map((s) => s.textContent)
  assert.ok(who.includes('Person · while it worked'))
  assert.ok(who.includes('Director · while it worked'))
  assert.ok(who.some((w) => w === 'ChatGPT Web · GPT6 Astra Pro'))
  assert.ok(who.includes('Words sent while it worked'))
  assert.ok(!who.some((w) => /\byou\b/.test(w!)))
  assert.ok(qa('[data-testid="steer-state"]').some((s) => s.textContent!.startsWith('not delivered')))
})

test('director exchanges, groups, a child\'s opening, a failure and a stray, each where it stood', async () => {
  const ask = section('note-i14')
  assert.ok(q('.turn-images img', ask))
  assert.ok(q('.turn-who', ask)!.textContent!.includes('Person → director'))
  // an image-only exchange keeps its picture (here: the card of one not carried) and its answer
  const imageOnly = section('note-i16')
  assert.ok(q('[data-testid="attachment-omitted"]', imageOnly))
  assert.ok(imageOnly.textContent!.includes('I see the picture.'))
  const failed = section('note-i18')
  assert.equal(q('[data-testid="director-turn-status"]', failed)!.textContent, 'Failed')
  assert.ok(failed.textContent!.includes('And then?'))
  assert.ok(q('[data-testid="director-event"]', section('note-i19'))!.textContent!.includes('reported that runs it started ended'))
  const group = section('group-g1')
  assert.ok(group.textContent!.includes('→ Reviewer'))
  assert.ok(group.textContent!.includes('Relay the review'))
  assert.equal(q('[data-testid="group-state"]', group)!.textContent, 'relay · done')
  assert.ok(q('.turn-images img', group))
  assert.ok(q('[data-testid="run-opened-by"]', section('run-r3'))!.textContent!.includes('Parent agent'))
  // a failure: the card without its ways out, the harness's words said once
  const r4 = section('run-r4')
  assert.ok(q('[data-testid="failure-card"]', r4))
  assert.equal(q('details', q('[data-testid="failure-card"]', r4)!), null)
  await click(q('.work-head', r4))
  assert.equal(r4.textContent!.split('provider said no (synthetic)').length - 1, 1)
  assert.ok(section('share-stray').textContent!.includes('A stray notice of no run'))
  assert.deepEqual(touched, [])
})

test('a control the copy leaves out keeps the app\'s room: an empty, hidden box of the same class where the copy button was — no button', () => {
  // the words of a run, a group, a director exchange: the app's action strip under them (24 px, shown on hover)
  for (const [id, sel] of [['run-r1', '.turn.turn-user'], ['group-g1', '.turn.turn-user'], ['note-i14', '.turn.turn-user']] as const) {
    const strip = q(`${sel} > .turn-user-actions`, section(id))
    assert.ok(strip, `${id}: the words keep their action strip`)
    assert.equal(qa('button', strip!).length, 0)
    const space = q('.turn-action.share-action-space', strip!)!
    assert.equal(space.tagName, 'SPAN'); assert.equal(space.getAttribute('aria-hidden'), 'true'); assert.equal(space.childNodes.length, 0)
  }
  // a director's short answer (no fold) and one that ended without an answer: their footer stands as in the app
  for (const id of ['note-i14', 'note-i18']) {
    const foot = q('.turn.turn-agent > .turn-footer.turn-foot', section(id))
    assert.ok(foot, `${id}: the answer keeps its footer`)
    assert.equal(qa('button', foot!).length, 0)
    assert.ok(q('.turn-action.share-action-space[aria-hidden="true"]', foot!))
  }
  // a code block's head: the room of its copy button, no button
  const head = q('.code-block .code-head', section('run-r1'))!
  assert.equal(qa('button', head).length, 0)
  assert.ok(q('.code-copy.share-action-space[aria-hidden="true"]', head))
  for (const space of qa('.share-action-space')) assert.equal(space.tagName, 'SPAN')
})

test('generated pictures open whole in place, without a download; the palette changes and follows the system on System', async () => {
  const r2 = section('run-r2')
  const figure = q('[data-testid="generated-image"]', r2)!
  assert.equal(q('img', figure)!.getAttribute('src'), PNG)
  await click(q('.generated-image-open', figure))
  const viewer = q('[data-testid="media-viewer"]')!
  assert.ok(viewer)
  assert.equal(q('[data-testid="media-viewer-download"]', viewer), null)
  await click(q('.media-viewer-close', viewer))
  await click(q('[data-testid="share-theme-claude"]'))
  assert.equal(d.documentElement.dataset.theme, 'claude')
  await click(q('[data-testid="share-theme-light"]'))
  assert.equal(d.documentElement.dataset.theme, 'light')
  dark = true
  await click(q('[data-testid="share-theme-system"]'))
  assert.equal(d.documentElement.dataset.theme, 'dark')
  dark = false
  await act(async () => { for (const f of queries) f() })
  assert.equal(d.documentElement.dataset.theme, 'light')
  assert.ok(section('share-about').textContent!.includes('email: 2'))
  assert.deepEqual(touched, [])
  assert.equal(errors.length, 0)
})

// ---- action lines and the person's words to a group's members: the app's own components in both -----------------
const { createElement } = await import('react')
const { createRoot } = await import('react-dom/client')
const { ShareApp } = await import('../src/share/viewer/ShareApp.tsx')
const { ActionLine, MemberWords } = await import('../src/components/ThreadTranscript.tsx')
const { threadActions } = await import('../src/state/outline.ts')
const { checkShareDocument } = await import('../src/share/document.ts')
const { actionSnapshot, legacyV1Snapshot } = await import('./shareFixtures.ts')

/** A second page in the same window: drawn into its own root, taken down after. */
async function mount(node: ReturnType<typeof createElement>) {
  const el = d.createElement('div')
  d.body.appendChild(el)
  const root = createRoot(el)
  await act(async () => { root.render(node) })
  return { el, unmount: async () => { await act(async () => { root.unmount() }); el.remove() } }
}
const shareDoc = (snapshot: ShareDocument['snapshot']): ShareDocument => checkShareDocument({
  format: SHARE_PAGE_FORMAT, version: SHARE_PAGE_VERSION, theme: 'light', snapshot, pictures: {}, page: { images_rejected: 0, images_over_page_budget: 0 }, faces: {}, bots: { chatgpt: PNG },
})
// the same action as the app's thread reads it from its run tree (no presentation: the app's own drawing)
const appRow = (id: string, label: string, user_text: string, created_at: string) => threadActions([{ id, spawned_by: 'human_action', label, created_at, user_text }])[0]!
const sameMarkup = (el: Element) => el.outerHTML.replace(/data-testid="action-[^"]+"/, 'data-testid="action-X"').replace(/ src="[^"]*"/g, ' src=""')
const allowedButton = '.work-head, .activity-line.expandable, .activity-line.action-line, .note-fold, .sources-toggle, [data-testid^="share-theme-"]'

test('an action line in the copy is the app\'s own line: the same markup and classes, folded and opened; its whole text in the default export', async () => {
  const share = await mount(createElement(ShareApp, { doc: shareDoc(actionSnapshot()) }))
  const app = await mount(createElement('div', { className: 'thread-scroll' },
    createElement(ActionLine, { action: appRow('run_cmd', 'command (ChatGPT)', '$ python3 toy.py --seed 0\n  --steps 3\n→ exit 0', '2026-10-22T03:02:00.000Z') }),
    createElement(ActionLine, { action: appRow('run_cp', 'checkpoint (by hand)', 'checkpoint [id]: before the sweep', '2026-10-22T03:03:00.000Z') })))
  try {
    // a direct child of the thread's column, between the turns, as the app places it — never a turn
    const line = q('[data-testid="thread"] > [data-testid="action-i3"]', share.el)!
    assert.ok(line)
    assert.equal(qa('section[data-testid="run-r2"], section[data-testid="run-r3"], section[data-testid="run-r4"], section[data-testid="run-r5"]', share.el).length, 0)
    assert.ok(!share.el.textContent!.includes('tool call'), 'no "0 tool calls" round')
    assert.ok(!share.el.textContent!.includes('A recorded action'))
    const appLine = q('[data-testid="action-run_cmd"]', app.el)!
    assert.equal(sameMarkup(line), sameMarkup(appLine))
    assert.deepEqual([q('.action-who', line)!.textContent, q('.action-head', line)!.textContent, q('.action-outcome', line)!.textContent], ['ChatGPT', '$ python3 toy.py --seed 0 …', '→ exit 0'])
    assert.equal(q('.action-who img', line)!.getAttribute('src'), PNG)
    await click(q('button.action-line', line)); await click(q('button.action-line', appLine))
    assert.equal(sameMarkup(line), sameMarkup(appLine))
    assert.equal(q('[data-testid="action-full"]', line)!.textContent, '$ python3 toy.py --seed 0\n  --steps 3\n→ exit 0')
    assert.equal(q('[data-testid="action-details"]', line), null)
    await click(q('button.action-line', line))
    assert.equal(q('[data-testid="action-full"]', line), null)
    // the person: "you" in the app, "Person" in the copy — nothing else differs
    const cp = q('[data-testid="action-i4"]', share.el)!, appCp = q('[data-testid="action-run_cp"]', app.el)!
    assert.equal(q('.action-who', cp)!.textContent, 'Person')
    assert.equal(q('.action-who', appCp)!.textContent, 'you')
    assert.equal(sameMarkup(cp), sameMarkup(appCp).replace('<span class="action-who">you</span>', '<span class="action-who">Person</span>'))
    // withheld: the line keeps who and the exit; nothing of the command, opened or not
    const hidden = q('[data-testid="action-i5"]', share.el)!
    assert.equal(hidden.dataset.missing, 'withheld')
    assert.deepEqual([q('.action-head', hidden)!.textContent, q('.action-outcome', hidden)!.textContent], ['withheld (sensitive source)', '→ exit 0'])
    await click(q('button.action-line', hidden))
    assert.ok(q('[data-testid="action-missing"]', hidden)!.textContent!.startsWith('Content withheld: a sensitive source'))
    assert.equal(q('[data-testid="action-full"]', hidden), null)
    // an action of a run the snapshot does not list is drawn; a time it does not hold leaves the title without a date
    const lost = q('[data-testid="action-i11"]', share.el)!
    assert.equal(q('button', lost)!.title, 'approved bash')
    for (const b of qa('button', share.el)) assert.ok(!b.title.includes('Invalid Date'), b.title)
    // a record that kept no text says so when opened
    const none = q('[data-testid="action-i12"]', share.el)!
    assert.equal(q('.action-head', none)!.textContent, 'command')
    await click(q('button.action-line', none))
    assert.equal(q('[data-testid="action-missing"]', none)!.textContent, 'The record kept no text of this action.')
    for (const b of qa('button', share.el)) assert.ok(b.matches(allowedButton), b.outerHTML.slice(0, 160))
    assert.equal(qa('a[href],form,input,textarea,iframe', share.el).length, 0)
    for (const img of qa('img', share.el)) assert.ok(img.getAttribute('src')!.startsWith('data:image/png;base64,'), img.outerHTML)
    assert.deepEqual(touched, [])
  } finally { await share.unmount(); await app.unmount() }
})

test('with tool details the opened line shows the command, then its measures and a cut preview of its output; a withheld one still nothing', async () => {
  const share = await mount(createElement(ShareApp, { doc: shareDoc(actionSnapshot({ details: true })) }))
  try {
    const line = q('[data-testid="action-i3"]', share.el)!
    assert.equal(q('[data-testid="action-details"]', line), null, 'folded: no details')
    await click(q('button.action-line', line))
    const full = q('[data-testid="action-full"]', line)!, details = q('[data-testid="action-details"]', line)!
    assert.ok(full.compareDocumentPosition(details) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING, 'the details stand below the command')
    assert.equal(q('[data-testid="call-preview"]', details)!.textContent, 'step 1 loss 0.9\nstep 2 loss 0.5')
    assert.equal(q('[data-testid="call-fields"]', details)!.textContent, 'exit_code 0 · duration_ms 812')
    assert.ok(q('[data-testid="call-preview-note"]', details)!.textContent!.includes('cut here'))
    const hidden = q('[data-testid="action-i5"]', share.el)!
    await click(q('button.action-line', hidden))
    assert.equal(q('[data-testid="action-details"]', hidden), null)
    assert.deepEqual(touched, [])
  } finally { await share.unmount() }
})

test('an older (V1) export read by this viewer: each recorded action a compact line saying its content was not carried — no turn, no text made up', async () => {
  const share = await mount(createElement(ShareApp, { doc: shareDoc(legacyV1Snapshot()) }))
  try {
    assert.equal(qa('section[data-testid="run-r2"], section[data-testid="run-r3"]', share.el).length, 0)
    assert.ok(!share.el.textContent!.includes('tool call'))
    assert.ok(!share.el.textContent!.includes('A recorded action of the person'))
    const cmd = q('[data-testid="thread"] > [data-testid="action-i3"]', share.el)!
    assert.equal(cmd.dataset.missing, 'not_carried')
    assert.deepEqual([q('.action-who', cmd)!.textContent, q('.action-head', cmd)!.textContent, q('.action-outcome', cmd)], ['ChatGPT', 'content not carried in this export', null])
    await click(q('button.action-line', cmd))
    assert.ok(q('[data-testid="action-missing"]', cmd)!.textContent!.includes('were not carried'))
    const cp = q('[data-testid="action-i4"]', share.el)!
    assert.equal(q('.action-who', cp)!.textContent, 'Person')
    assert.equal(q('button', cp)!.title, 'checkpoint')
    // the stray item of the action's run: shown as itself
    assert.ok(q('[data-testid="share-stray"]', share.el)!.textContent!.includes('stray of an action run'))
    assert.deepEqual(touched, [])
  } finally { await share.unmount() }
})

test('the person\'s words to a group\'s members: the app\'s MemberWords — "Person" for "you", their state, no copy button; a woken run its wake header', async () => {
  const share = await mount(createElement(ShareApp, { doc: shareDoc(actionSnapshot()) }))
  const app = await mount(createElement(MemberWords, { to: 'everyone', text: 'keep it short', status: 'partly', state: 'delivered to Critic; queued for the rest' }))
  try {
    const notes = qa('[data-testid="interaction-note"]', share.el)
    assert.deepEqual(notes.map((n) => n.dataset.noteStatus), ['delivered', 'partly', 'queued', 'undelivered'])
    assert.deepEqual(notes.map((n) => q('.turn-who', n)!.textContent), ['Person → Reviewer', 'Person → everyone', 'Person → Critic', 'Person → everyone'])
    assert.deepEqual(notes.map((n) => q('.member-words-state', n)?.textContent ?? null), [null, 'delivered to Critic; queued for the rest', 'queued', 'not delivered: the interaction ended first'])
    for (const n of notes) { assert.equal(qa('button', n).length, 0); assert.ok(q('.turn-user-actions > .share-action-space', n)) }
    // the same markup as the app's, but for the person's name and the copy button's room
    const appNote = q('[data-testid="interaction-note"]', app.el)!
    assert.equal(q('.turn-who', appNote)!.textContent, 'you → everyone')
    assert.ok(q('[data-testid="copy-text"]', appNote))
    const shape = (n: Element) => [n.className, q('.turn', n)!.className, q('.turn-who', n)!.className, q('.turn-text', n)!.textContent, q('.member-words-state', n)!.className, q('.member-words-state', n)!.textContent]
    assert.deepEqual(shape(notes[1]!), shape(appNote))
    // a run a watch woke: the app's wake header, no empty fold, no notice row
    const woken = q('section[data-testid="run-r6"]', share.el)!
    assert.ok(q('[data-testid="run-woken"]', woken)!.textContent!.includes('a watch reported'))
    assert.equal(q('.note-fold', woken), null)
    assert.equal(q('[data-event="woken_by_watch"]', woken), null)
    assert.deepEqual(touched, [])
  } finally { await share.unmount(); await app.unmount() }
})
