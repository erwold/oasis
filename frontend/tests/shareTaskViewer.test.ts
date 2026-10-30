/** A task's share drawn in jsdom — the offline V3 page (its own entry, from its data block) and the live v2 page (a
 *  store set by hand) — with the same stand-ins the viewer builds put in place of the store, the API and the desk.
 *  What is checked: the rail's look for the task's sessions (its rows, its bots stacked, a member indented), the desk's
 *  Agent Teams card (the app's frame and outline: bots, badge, states, the tree's rails) still and read-only — no drag,
 *  no resize, nothing asked — a click on a row lighting its chain and gliding the thread to its turn; another session
 *  chosen shows its own thread, its own picture (the same image key, never the first session's) and its own card;
 *  nothing of the desk's store enters; no storage, no network. Synthetic data only. */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { registerHooks } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { JSDOM } from 'jsdom'
import { STAND_INS } from '../src/share/viewer/offline/standIns.ts'
import { SHARE_PAGE_FORMAT, SHARE_PAGE_VERSION_TASK, type ShareTaskDocument } from '../src/share/document.ts'
import { dataBlockJson } from '../src/state/shareHtml.ts'
import { LIVE_S1, LIVE_S2, PNG_A, PNG_B, taskFrame, taskSnapshot, teamRow } from './taskShareFixtures.ts'
import { RES_A } from './liveShareFixtures.ts'

const SRC = fileURLToPath(new URL('../src/', import.meta.url))
const OFFLINE = join(SRC, 'share/viewer/offline')
const loaded = new Set<string>()

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL?.startsWith('file:') && context.parentURL.includes('/frontend/src/')) {
      const parent = fileURLToPath(context.parentURL)
      const target = resolve(dirname(parent), specifier).replace(/\.(tsx?|jsx?)$/, '')
      const key = relative(SRC, target)
      if (!parent.startsWith(OFFLINE) && STAND_INS[key]) return next(pathToFileURL(join(OFFLINE, STAND_INS[key]!)).href, context)
      if (!/\.[a-z]+$/i.test(specifier)) {
        for (const ext of ['.ts', '.tsx']) { const u = new URL(`${specifier}${ext}`, context.parentURL); if (existsSync(u)) return next(u.href, context) }
      }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.startsWith('file:') && url.includes('/frontend/src/')) loaded.add(relative(SRC, fileURLToPath(url)).replace(/\.(tsx?|jsx?)$/, ''))
    if (/\.(css|png|svg)$/.test(url)) return { format: 'module', source: `export default ${JSON.stringify(`data:image/png;base64,${Buffer.from(url).toString('base64')}`)}`, shortCircuit: true }
    if (url.startsWith('file:') && url.endsWith('.tsx')) {
      const file = fileURLToPath(url)
      return { format: 'module', source: ts.transpileModule(readFileSync(file, 'utf8'), { fileName: file, compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText, shortCircuit: true }
    }
    return next(url, context)
  },
})

const URL_A = `data:image/png;base64,${PNG_A}`
const URL_B = `data:image/png;base64,${PNG_B}`
const BOT = 'data:image/png;base64,Ym90'
const snap = taskSnapshot()
const doc: ShareTaskDocument = {
  format: SHARE_PAGE_FORMAT, version: SHARE_PAGE_VERSION_TASK, theme: 'light',
  snapshot: { ...snap, sessions: snap.sessions.map((s) => ({ ...s, images: s.images.map((i) => ({ ...i, data_base64: '' })) })) },
  pictures: { s1: { img1: { src: URL_A, width: 1, height: 1 } }, s2: { img1: { src: URL_B, width: 1, height: 1 } } },
  page: { images_rejected: 0, images_over_page_budget: 0 },
  bots: Object.fromEntries(['20-at', '13-puzzle', '29-lighthouse', '08-prompt', '02-terminal', 'director'].map((b) => [b, BOT])),
}

const dom = new JSDOM(`<!doctype html><html><body><div id="root"></div><div id="other"></div><script type="application/json" id="share-data">${dataBlockJson(doc)}</script></body></html>`,
  { url: 'https://share.invalid/', pretendToBeVisual: true })
const touched: string[] = []
const trap = (what: string) => () => { touched.push(what); throw new Error(`the page touched ${what}`) }
for (const target of [globalThis, dom.window] as Record<string, unknown>[]) {
  for (const name of ['localStorage', 'sessionStorage', 'indexedDB']) Object.defineProperty(target, name, { configurable: true, get: trap(name) })
  for (const name of ['fetch', 'XMLHttpRequest', 'EventSource', 'WebSocket', 'Worker']) Object.defineProperty(target, name, { configurable: true, writable: true, value: trap(name) })
}
Object.defineProperty(dom.window.navigator, 'sendBeacon', { configurable: true, value: trap('sendBeacon') })
dom.window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof dom.window.matchMedia
const scrolled: string[] = []
dom.window.HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) { scrolled.push(this.dataset.testid ?? this.className) }
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, Element: dom.window.Element,
  MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} disconnect() {} unobserve() {} }, CSS: { escape: (s: string) => s }, __OASIS_CODE_BUILD__: 'test',
  requestAnimationFrame: (f: () => void) => setTimeout(f, 0), cancelAnimationFrame: (h: number) => clearTimeout(h),
})
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
const errors: unknown[] = []
const consoleError = console.error
console.error = (...args: unknown[]) => { errors.push(args); consoleError(...args) }

const { act, createElement } = await import('react')
await act(async () => { await import('../src/share/viewer/entry.tsx') })
const d = dom.window.document
const root = d.getElementById('root')!
const q = (sel: string, r: ParentNode = root) => r.querySelector(sel) as HTMLElement | null
const qa = (sel: string, r: ParentNode = root) => [...r.querySelectorAll(sel)] as HTMLElement[]
// the cards' clocks (a live row's) stop with the page
after(() => { dom.window.close() })
const click = async (el: Element | null) => { assert.ok(el, 'nothing to click'); await act(async () => { (el as HTMLElement).click() }) }

test('offline: the task\'s sessions as the rail lists them, the shared one shown; its Agent Teams card is the desk\'s, still', () => {
  assert.equal(errors.length, 0)
  const rows = qa('[data-testid="share-sessions"] .rail-session-row')
  assert.equal(rows.length, 2)
  assert.ok(rows[1]!.classList.contains('rail-member') && !rows[0]!.classList.contains('rail-member'))
  const first = q('[data-testid="share-session-s1"]')!
  assert.ok(first.classList.contains('nav-item') && first.classList.contains('rail-session') && first.classList.contains('active'))
  // the rail's bots: three stacked, the rest said in the title
  assert.deepEqual(qa('.rail-bot-slot img', first).map((i) => i.dataset.bot), ['20-at', '13-puzzle', '29-lighthouse'])
  assert.equal(q('.rail-bots', first)!.title, '4 agents')
  assert.equal(q('.thread-title')!.textContent, 'Root session')
  // the card: the desk's frame and title, its count; the app's outline inside
  const card = q('[data-testid="graph-dock"]')!
  assert.ok(card.matches('section.desk-win.kind-graph.front'))
  assert.equal(q('.desk-title .desk-name', card)!.textContent, 'Agent Teams')
  assert.equal(q('.desk-meta', card)!.textContent, '4 agents · 2 live')
  assert.ok(q('.desk-body.graph-body .agent-outline.embedded .ol-tree', card))
  assert.equal(q('.ol-node.folder .ol-nm', card)!.textContent, 'Root session')
  assert.deepEqual(qa('.ol-node:not(.folder)', card).map((n) => n.dataset.id), ['t1', 't2', 't3', 't4', 't5', 't6'])
  assert.equal(q('[data-testid="ol-t2"]', card)!.dataset.state, 'thinking')
  assert.equal(q('[data-testid="alias-t4"]', card)!.textContent, '1')
  assert.equal(q('[data-testid="ol-t3"] img', card)!.dataset.bot, 'director')
  assert.equal(q('[data-testid="ol-t5"]', card)!.classList.contains('decision'), true)
  assert.ok(q('[data-testid="ol-t1"]', card)!.title.includes('2 runs'))
  // still: no resize edge, no close; every picture embedded
  assert.equal(qa('.desk-resize', card).length, 0)
  assert.equal(qa('[data-testid="card-close"]', card).length, 0)
  for (const img of qa('img')) assert.ok(img.getAttribute('src')!.startsWith('data:image/'), img.outerHTML)
  // a running row (t2) and a sleeping plan (t3) wear their still, never an animation
  for (const img of qa('img.bot-img')) assert.equal(img.dataset.botState, 'static', img.outerHTML)
})

test('offline: a row lights its chain and glides the thread to its turn; the card folds and fills the page, nothing asked', async () => {
  const card = q('[data-testid="graph-dock"]')!
  await click(q('[data-testid="ol-t2"]', card))
  assert.ok(q('[data-testid="ol-t2"]', card)!.classList.contains('sel'))
  assert.ok(q('[data-testid="ol-t3"]', card)!.classList.contains('dim'))
  assert.deepEqual(scrolled, ['run-r2'])
  await click(q('[data-testid="ol-t3"]', card))                                  // a plan's own row: no turn to go to
  assert.deepEqual(scrolled, ['run-r2'])
  await click(q('[data-testid="card-shelve"]', card))
  assert.ok(q('[data-testid="graph-dock"]')!.classList.contains('collapsed'))
  await click(q('[data-testid="card-expand"]'))
  assert.ok(q('[data-testid="graph-dock"]')!.classList.contains('expanded'))
  await click(q('[data-testid="card-expand"]'))
  assert.ok(!q('[data-testid="graph-dock"]')!.classList.contains('expanded'))
  assert.deepEqual(touched, [])
})

test('offline: another session shows its own thread, its own picture under the same key and its own card; the first again as it was', async () => {
  const shot = () => qa('.thread-scroll img').map((i) => i.getAttribute('src')).find((s) => s === URL_A || s === URL_B)
  assert.equal(shot(), URL_A)
  await click(q('[data-testid="share-session-s2"]'))
  assert.equal(q('[data-testid="share-thread"]')!.dataset.session, 's2')
  assert.equal(q('.thread-title')!.textContent, 'Member session')
  assert.ok(q('.thread-scroll')!.textContent!.includes('Member answer.'))
  assert.ok(!q('.thread-scroll')!.textContent!.includes('Root answer.'))
  assert.equal(shot(), URL_B)
  assert.deepEqual(qa('[data-testid="graph-dock"] .ol-node:not(.folder)').map((n) => n.dataset.id), ['t1'])
  assert.equal(q('[data-testid="graph-dock"] .desk-meta')!.textContent, '1 agent')
  await click(q('[data-testid="share-session-s1"]'))
  assert.equal(shot(), URL_A)
  assert.ok(q('[data-testid="share-session-s1"]')!.classList.contains('active'))
  assert.deepEqual(touched, [])
})

test('the desk, its store and the app\'s own Desk never enter a share\'s page', () => {
  for (const m of ['state/desk', 'components/Desk', 'components/FloatingWindow', 'components/AgentOutline', 'state/store']) assert.ok(!loaded.has(m), m)
  assert.ok(loaded.has('components/OutlineView') && loaded.has('components/DeskFrame') && loaded.has('components/RailBots'))
})

test('live v2: the session the link opens on, its picture by its own resource, the backend\'s bots; a click asks the store for another', async () => {
  const { LiveShareApp } = await import('../src/share/live/viewer/LiveShareApp.tsx')
  const { createRoot } = await import('react-dom/client')
  const other = d.getElementById('other')!
  const frame = taskFrame()
  const chosen: string[] = []
  let view = { phase: 'connected' as const, frame, selected: 's1', paused: null, ended: null, pictures: new Map([[RES_A, { kind: 'shown' as const, src: 'blob:test/a', width: 1, height: 1 }]]) }
  const listeners = new Set<() => void>()
  const store = { get: () => view, subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }, start: () => undefined, close: () => undefined, nudge: () => undefined,
    select: (k: string) => { chosen.push(k); view = { ...view, selected: k, pictures: new Map() }; for (const l of listeners) l() } }
  const r = createRoot(other)
  await act(async () => { r.render(createElement(LiveShareApp, { store })) })
  assert.equal(q('[data-testid="live-title"]', other)!.textContent, 'Live root')
  assert.equal(q('[data-testid="live-status"]', other)!.textContent, 'Live · working')
  assert.ok(qa('.thread-scroll img', other).some((i) => i.getAttribute('src') === 'blob:test/a'))
  assert.equal(qa('[data-testid="share-sessions"] .rail-session-row', other).length, 2)
  assert.ok(q('[data-testid="share-session-dot-s1"]', other))                    // at work
  assert.equal(q('[data-testid="share-session-dot-s2"]', other), null)
  assert.equal(q('[data-testid="graph-dock"] .desk-meta', other)!.textContent, '4 agents · 2 live')
  // the answer's bot is the backend's, carried in the page (never the v1 page's own pick)
  const bot = q('.turn.turn-agent .turn-who img.bot-img', other)!
  assert.equal(bot.dataset.bot, '20-at')
  assert.ok(bot.getAttribute('src')!.startsWith('data:image/png;base64,'))
  await click(q('[data-testid="share-session-s2"]', other))
  assert.deepEqual(chosen, ['s2'])
  assert.equal(q('[data-testid="live-title"]', other)!.textContent, 'Live member')
  assert.ok(!qa('.thread-scroll img', other).some((i) => i.getAttribute('src') === 'blob:test/a'), 'the first session\'s picture never shows in the second')
  // the link paused (busy): nothing of any session is shown
  view = { ...view, frame: null as never, selected: null as never, paused: 'busy' as never, pictures: new Map() }
  await act(async () => { for (const l of listeners) l() })
  assert.equal(q('[data-testid="share-sessions"]', other), null)
  assert.equal(q('[data-testid="graph-dock"]', other), null)
  assert.ok(q('[data-testid="live-paused"]', other))
  assert.deepEqual(touched, [])
  await act(async () => { r.unmount() })
})

test('a share\'s bots are the stills it carries in every state — running, queued, asleep, hovered — on the card and the list; the app\'s own outline and rail still play theirs', async () => {
  const { LiveShareApp } = await import('../src/share/live/viewer/LiveShareApp.tsx')
  const { OutlineView } = await import('../src/components/OutlineView.tsx')
  const { RailBots } = await import('../src/components/RailBots.tsx')
  const { teamItems } = await import('../src/share/team.ts')
  const { createRoot } = await import('react-dom/client')
  const team = {
    rows: [
      teamRow({ key: 't1', bot: '24-badge', status: 'running', glyph: null, finished_at: null, turn: 'r1' }),
      teamRow({ key: 't2', parent: 't1', bot: '13-puzzle', status: 'queued', glyph: null, finished_at: null }),
      teamRow({ key: 't3', kind: 'plan', bot: 'director', model_label: 'Model D', status: 'waiting', glyph: null, finished_at: null }),
      teamRow({ key: 't4', bot: '02-terminal' }),
    ],
    agents: 3, live: 2, truncated: false,
  }
  const box = d.createElement('div')
  d.body.append(box)
  const view = { phase: 'connected' as const, frame: taskFrame({}, [{ ...LIVE_S1(), team }, LIVE_S2()]), selected: 's1', paused: null, ended: null, pictures: new Map() }
  const store = { get: () => view, subscribe: () => () => undefined, start: () => undefined, close: () => undefined, nudge: () => undefined, select: () => undefined }
  const r = createRoot(box)
  await act(async () => { r.render(createElement(LiveShareApp, { store })) })
  const stills = () => {
    const bots = qa('img.bot-img', box)
    assert.ok(bots.length >= 7, `${bots.length} bots`)
    for (const img of bots) {
      assert.ok(img.getAttribute('src')!.startsWith('data:image/png;base64,'), img.outerHTML)
      assert.equal(img.dataset.botState, 'static', img.outerHTML)
    }
    for (const img of qa('img', box)) assert.ok(!img.getAttribute('src')!.startsWith('/'), img.outerHTML)
  }
  stills()
  // the rows still say what they do (the running row's dot breathes); only their bots are stills
  assert.deepEqual(['t1', 't2', 't3', 't4'].map((k) => q(`[data-testid="ol-${k}"]`, box)!.dataset.state), ['thinking', 'waiting', 'idle', 'static'])
  assert.equal(q('[data-testid="ol-t1"] img', box)!.dataset.bot, '24-badge')
  assert.ok(qa('[data-testid="share-sessions"] img.bot-img', box).length >= 3)
  // hovered: the card's rows, the list's rows — nothing changes picture
  for (const el of qa('.ol-node, .rail-session, .desk-title', box)) {
    await act(async () => { for (const type of ['pointerover', 'mouseover', 'mouseenter']) el.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true })) })
  }
  stills()
  await act(async () => { r.unmount() })
  // the app's own outline and rail (no share around them, no still given): their bots play, as they always did
  const app = d.createElement('div')
  d.body.append(app)
  const a = createRoot(app)
  await act(async () => {
    a.render(createElement('div', null,
      createElement(OutlineView, { title: 'App', rows: teamItems(team), selected: null, onOpen: () => undefined, useRowState: (row) => (row.status === 'running' ? 'thinking' : 'static') }),
      createElement(RailBots, { bots: ['20-at'] })))
  })
  assert.equal(q('[data-testid="ol-t1"] img', app)!.getAttribute('src'), '/bots/anim/thinking/24-badge.webp')
  assert.equal(q('[data-testid="ol-t1"] img', app)!.dataset.botState, 'thinking')
  assert.equal(q('[data-testid="ol-t4"] img', app)!.getAttribute('src'), '/bots/icons/02-terminal.png')
  assert.equal(q('.rail-bots img', app)!.getAttribute('src'), '/bots/icons/20-at.png')
  await act(async () => { a.unmount() })
  assert.deepEqual(touched, [])
})
