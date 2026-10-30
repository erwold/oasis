/** The live link's page, drawn in jsdom: the app's OWN thread components (ThreadTranscript.tsx) under the share's
 *  presentation, with the same stand-ins the live build puts in place of the page store, the API and the desk. The
 *  page's storage and every network API are traps. What is checked: a link without its key asks nothing; a session at
 *  work is drawn live (a running turn, a running tool, an answer being written, a queued steer) with NO control that
 *  would act — no stop, cancel, send, approve, put back, copy; only folds and the palette; each end is said by its
 *  own words and leaves nothing of the session on the page; the LiveLine's Stop/Cancel exist in the app and never
 *  under the share's presentation. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerHooks } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { JSDOM } from 'jsdom'
import { STAND_INS } from '../src/share/viewer/offline/standIns.ts'
import { liveFrame, RES_A } from './liveShareFixtures.ts'
import type { LiveStore, LiveView } from '../src/share/live/liveState.ts'

const SRC = fileURLToPath(new URL('../src/', import.meta.url))
const OFFLINE = join(SRC, 'share/viewer/offline')
const used = new Set<string>()

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
    if (/\.(css|png|svg)$/.test(url)) return { format: 'module', source: `export default ${JSON.stringify(/\.png$/.test(url) ? 'data:image/png;base64,AAAA' : url)}`, shortCircuit: true }
    if (url.startsWith('file:') && url.endsWith('.tsx')) {
      const file = fileURLToPath(url)
      return { format: 'module', source: ts.transpileModule(readFileSync(file, 'utf8'), { fileName: file, compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText, shortCircuit: true }
    }
    return next(url, context)
  },
})

// ---- the page: jsdom at the link's page WITHOUT a key; its storage and every network API a trap ----------------------
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div><div id="other"></div></body></html>', { url: 'https://share.invalid/live/', pretendToBeVisual: true })
const touched: string[] = []
const trap = (what: string) => () => { touched.push(what); throw new Error(`the page touched ${what}`) }
for (const target of [globalThis, dom.window] as Record<string, unknown>[]) {
  for (const name of ['localStorage', 'sessionStorage', 'indexedDB']) Object.defineProperty(target, name, { configurable: true, get: trap(name) })
  for (const name of ['fetch', 'XMLHttpRequest', 'EventSource', 'WebSocket', 'Worker']) Object.defineProperty(target, name, { configurable: true, writable: true, value: trap(name) })
}
Object.defineProperty(dom.window.navigator, 'sendBeacon', { configurable: true, value: trap('sendBeacon') })
Object.defineProperty(dom.window.navigator, 'clipboard', { configurable: true, get: trap('clipboard') })
dom.window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof dom.window.matchMedia
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node,
  MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} disconnect() {} unobserve() {} }, __OASIS_CODE_BUILD__: 'test',
})
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
const errors: unknown[] = []
const consoleError = console.error
console.error = (...args: unknown[]) => { errors.push(args); consoleError(...args) }

const { act, createElement } = await import('react')
const { createRoot } = await import('react-dom/client')
// the page's own entry, at a link without its key: it draws the incomplete-link page and asks nothing
await act(async () => { await import('../src/share/live/viewer/entry.tsx') })
const { LiveShareApp } = await import('../src/share/live/viewer/LiveShareApp.tsx')
const { LiveLine } = await import('../src/components/ThreadTranscript.tsx')
const { ThreadPresentationContext } = await import('../src/components/ThreadPresentation.ts')
const { capabilityOf } = await import('../src/share/live/viewer/entry.tsx')

const d = dom.window.document
const q = (sel: string, root: ParentNode = d) => root.querySelector(sel) as HTMLElement | null
const qa = (sel: string, root: ParentNode = d) => [...root.querySelectorAll(sel)] as HTMLElement[]

/** a store the test sets by hand (the page reads it as it reads the real one) */
function fakeStore(initial: LiveView) {
  let view = initial
  const listeners = new Set<() => void>()
  const store: LiveStore = { get: () => view, subscribe: (l) => { listeners.add(l); return () => listeners.delete(l) }, start: () => undefined, select: () => undefined, close: () => undefined, nudge: () => undefined }
  return { store, set: (v: Partial<LiveView>) => { view = { ...view, ...v }; for (const l of listeners) l() } }
}

test('a link without its key: the page says so and asks nothing; only an exact capability is read from the fragment', () => {
  const s = q('#root [data-testid="live-status"]')!
  assert.equal(s.dataset.status, 'ended')
  assert.equal(s.dataset.reason, 'no_capability')
  assert.ok(q('#root [data-testid="live-ended"]'))
  assert.deepEqual(touched, [])
  assert.equal(capabilityOf('#' + 'A'.repeat(43)), 'A'.repeat(43))
  for (const bad of ['', '#', '#short', `#${'A'.repeat(44)}`, `#${'A'.repeat(42)}=`, `#${'A'.repeat(43)}&x=1`]) assert.equal(capabilityOf(bad), null, bad)
})

const other = d.getElementById('other')!
const root = createRoot(other)
const fake = fakeStore({ phase: 'connecting', frame: null, selected: null, paused: null, ended: null, pictures: new Map() })
await act(async () => { root.render(createElement(LiveShareApp, { store: fake.store })) })

test('a session at work: the app\'s thread, its live turn and running rows, with no control that acts', async () => {
  assert.equal(q('#other [data-testid="live-status"]')!.dataset.status, 'connecting')
  assert.ok(q('#other [data-testid="live-waiting"]'))
  await act(async () => { fake.set({ phase: 'connected', frame: liveFrame(), pictures: new Map([[RES_A, { kind: 'shown', src: 'blob:https://share.invalid/1', width: 1, height: 1 }]]) }) })
  for (const m of ['state/store', 'api/client', 'components/Desk']) assert.ok(used.has(m), m)
  const status = q('#other [data-testid="live-status"]')!
  assert.equal(status.dataset.status, 'connected')
  assert.match(status.textContent!, /Live/)
  assert.equal(q('#other [data-testid="live-title"]')!.textContent, 'Synthetic live session')
  const live = q('#other [data-testid="run-r2"]')!
  assert.ok(live.classList.contains('live'), 'the running run is drawn live')
  assert.ok(q('[data-testid="live-line"]', live), 'with its live line (its state only)')
  assert.ok(q('.turn.turn-agent.streaming', live), 'the answer being written streams')
  assert.match(q('.turn.turn-agent.streaming', live)!.textContent!, /first line done/)
  assert.ok(q('.activity.row.running', live) || q('.work.live', live), 'its running tool is drawn running')
  assert.ok(q('[data-testid^="steer-"][data-status="queued"]', live), 'the queued steer is there')
  assert.ok(!q('#other [data-testid="run-r1"]')!.classList.contains('live'), 'the finished run is not')
  // nothing that would act
  const forbidden = ['stop', 'waiting-cancel', 'waiting-stop-command', 'steer-put-back', 'copy-text', 'code-copy', 'failure-accounts', 'failure-chatgpt', 'undo-run',
    'node-adopt', 'relay-continue', 'interaction-continue', 'generated-image-download', 'media-viewer-download', 'opened-session', 'share-open', 'replay', 'director-turn-cancel', 'call-raw']
  for (const id of forbidden) assert.equal(qa(`#other [data-testid="${id}"]`).length, 0, id)
  assert.equal(qa('#other a[href],#other form,#other input,#other textarea,#other iframe,#other video,#other audio').length, 0)
  for (const b of qa('#other button')) {
    assert.ok(b.matches('.work-head, .activity-line.expandable, .note-fold, .sources-toggle, .generated-image-open, .shown-image, [data-testid^="share-theme-"], .media-viewer-close'), b.outerHTML.slice(0, 160))
  }
  assert.ok(qa('#other img').some((i) => i.getAttribute('src') === 'blob:https://share.invalid/1'), 'the state\'s picture, by its resource, as the store holds it')
  for (const img of qa('#other img')) assert.ok(/^(blob:https:\/\/share\.invalid\/|data:image\/png;base64,)/.test(img.getAttribute('src')!), img.outerHTML)
  assert.deepEqual(touched, [])
})

test('each end says its own reason and leaves nothing of the session on the page; a pause says it reconnects', async () => {
  const seen: Record<string, string> = {}
  for (const ended of ['unauthorized', 'expired', 'revoked', 'session_deleted', 'unreadable', 'refused'] as const) {
    await act(async () => { fake.set({ phase: 'ended', ended, frame: null, pictures: new Map() }) })
    const s = q('#other [data-testid="live-status"]')!
    assert.equal(s.dataset.status, 'ended')
    assert.equal(s.dataset.reason, ended)
    seen[ended] = s.textContent!
    assert.equal(qa('#other [data-testid^="run-"]').length, 0, ended)
    assert.equal(qa('#other img').length, 0, ended)
    assert.ok(q('#other [data-testid="live-ended"]'))
  }
  assert.equal(new Set(Object.values(seen)).size, 6, 'every end has words of its own (unknown ≠ expired ≠ revoked)')
  await act(async () => { fake.set({ phase: 'reconnecting', ended: null, paused: 'disabled' }) })
  assert.equal(q('#other [data-testid="live-status"]')!.dataset.status, 'paused')
  assert.match(q('#other [data-testid="live-paused"]')!.textContent!, /reconnects/)
  await act(async () => { fake.set({ phase: 'reconnecting', paused: null }) })
  assert.equal(q('#other [data-testid="live-status"]')!.dataset.status, 'reconnecting')
  assert.deepEqual(touched, [])
  assert.equal(errors.length, 0)
})

test('the live line: Stop command and Cancel in the app, none of them under the share\'s presentation', async () => {
  const waiting = { reason: 'folder busy', workspace_id: null, blocking_owner: 'command', blocking_kind: 'command', blocking_run_id: null, blocking_execution_ids: ['x1'], blocking_session_id: null } as never
  const host = d.createElement('div')
  d.body.appendChild(host)
  const r = createRoot(host)
  await act(async () => { r.render(createElement(LiveLine, { bot: null, state: 'working', waiting, runId: 'r9' })) })
  assert.ok(q('[data-testid="waiting-cancel"]', host) && q('[data-testid="waiting-stop-command"]', host), 'the app has them')
  const presentation = { kind: 'share', face: () => ({ bot: null, enclosed: false }), botSrc: () => null, picture: () => null, tool: () => null, author: () => null, opening: () => null, note: () => null, action: () => null } as never
  await act(async () => { r.render(createElement(ThreadPresentationContext.Provider, { value: presentation }, createElement(LiveLine, { bot: null, state: 'working', waiting, runId: 'r9' }))) })
  assert.ok(q('[data-testid="live-line"]', host))
  assert.equal(qa('button', host).length, 0)
  await act(async () => { r.unmount() })
})
