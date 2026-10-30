import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerHooks } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { JSDOM } from 'jsdom'
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL?.includes('/frontend/src/') && !/\.[a-z]+$/i.test(specifier)) {
      for (const ext of ['.ts', '.tsx']) { const u = new URL(`${specifier}${ext}`, context.parentURL); if (existsSync(u)) return next(u.href, context) }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (/\.(css|png|svg|gif|webp)$/.test(url)) return { format: 'module', source: `export default ${JSON.stringify(url)}`, shortCircuit: true }
    if (url.startsWith('file:') && url.endsWith('.tsx')) return { format: 'module', source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText, shortCircuit: true }
    return next(url, context)
  },
})
// The thread's live window of computer use in a real React tree over an in-memory DOM, the desktop shell a stand-in
// whose pictures answer when the test says: each run asks for its own tab, and a picture asked for one run never
// shows in another's window — nor in the same window once it shows another run.
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://ui.invalid/', pretendToBeVisual: true })
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true, __OASIS_CODE_BUILD__: 'test' })
const { createElement, act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { ComputerScreen } = await import('../src/components/ComputerScreen.tsx')

type Asked = { surface: string; owner: string | null | undefined; args: number; answer: (frame: unknown) => void }
const asked: Asked[] = []
Object.assign(dom.window, {
  oasisCodeDesktop: { surfaceFrame: (...args: [string, string?]) => new Promise((answer) => { asked.push({ surface: args[0], owner: args[1], args: args.length, answer }) }) },
})
const frameOf = (owner: string, url: string) => ({
  surface: 'browser', holder: owner, last: { owner, party: `session:s_${owner}` }, doing: null, pointer: null, tab_id: `tab-${owner}`,
  image: { media_type: 'image/jpeg', data_base64: 'AAAA', width: 7, height: 5 }, url, title: owner, viewport: { width: 1280, height: 800 },
})
const entries = (surface: string) => [{ kind: 'activity', tool: 'computer_act', args: { surface, action: 'click' }, result: { surface }, toolCallId: 'c1' }] as never
const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)) }) }
const site = () => document.querySelector('[data-testid="computer-screen"][data-live="yes"] .screen-site')?.textContent ?? null

test("each run's live window asks for its own tab; a picture asked for another run is never shown", async () => {
  const container = document.getElementById('root')!
  const root = createRoot(container)
  await act(async () => { root.render(createElement(ComputerScreen, { runId: 'run_a', sessionId: 's_1', entries: entries('browser'), live: true })) })
  assert.deepEqual(asked.map((a) => [a.surface, a.owner]), [['browser', 'run_a']])
  // the window shows another run before run A's picture comes back: A's late picture is dropped
  const late = asked.pop()!
  await act(async () => { root.render(createElement(ComputerScreen, { runId: 'run_b', sessionId: 's_1', entries: entries('browser'), live: true })) })
  assert.deepEqual(asked.map((a) => [a.surface, a.owner]), [['browser', 'run_b']])
  late.answer(frameOf('run_a', 'https://a.example/'))
  await flush()
  assert.equal(site(), null)
  // run B's own picture shows; one that says another run holds the page does not
  asked.pop()!.answer(frameOf('run_b', 'https://b.example/'))
  await flush()
  assert.equal(site(), 'b.example')
  await act(async () => { await new Promise((r) => setTimeout(r, 150)) })
  asked.pop()!.answer(frameOf('run_a', 'https://a.example/'))
  await flush()
  assert.equal(site(), null)
  await act(async () => { root.unmount() })
  asked.length = 0
})

test('the ChatGPT page is asked for as before, with no run named', async () => {
  const root = createRoot(document.getElementById('root')!)
  await act(async () => { root.render(createElement(ComputerScreen, { runId: 'run_a', sessionId: 's_1', entries: entries('chatgpt'), live: true })) })
  assert.deepEqual(asked.map((a) => [a.surface, a.args]), [['chatgpt', 1]])
  await act(async () => { root.unmount() })
  asked.length = 0
})
