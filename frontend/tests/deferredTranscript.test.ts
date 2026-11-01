import assert from 'node:assert/strict'
import { after, test } from 'node:test'
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
const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: 'https://test.invalid/', pretendToBeVisual: true })
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
  MutationObserver: dom.window.MutationObserver, CSS: { escape: (s: string) => s }, localStorage: dom.window.localStorage,
  IS_REACT_ACT_ENVIRONMENT: true, __OASIS_CODE_BUILD__: 'test' })
after(() => dom.window.close())
const { createElement: h, act, useCallback, useLayoutEffect, useState } = await import('react')
const { createRoot } = await import('react-dom/client')
const { flushSync } = await import('react-dom')
const { DeferredTranscript } = await import('../src/components/DeferredTranscript.tsx')
const { useStore } = await import('../src/state/store.ts')
const { focusTurn } = await import('../src/components/focusTurn.ts')
const { jumpToRun } = await import('../src/components/Relations.tsx')
const { followThread } = await import('../src/state/threadFollow.ts')
const noop = () => {}
const props = { sessionId: 'A', scrollerRef: null, onScroll: noop, onInitialFollow: noop }

for (const transition of ['live → ended', 'director → ended', 'replay → normal']) test(`${transition} never rolls back/unmounts already committed rows`, async () => {
  const root = createRoot(document.getElementById('root')!)
  let mounts = 0, unmounts = 0
  const commits: string[] = []
  function Fold({ phase }: { phase: string }) {
    const [open] = useState(true)
    useLayoutEffect(() => { mounts++; return () => { unmounts++ } }, [])
    useLayoutEffect(() => { commits.push(`${phase}:${open}`) })
    return h('section', { 'data-phase': phase }, String(open))
  }
  function Transition() {
    const [immediate, setImmediate] = useState(true)
    useLayoutEffect(() => { setImmediate(false) }, []) // before the initial deferred value could commit
    return h(DeferredTranscript, { ...props, immediate, children: h(Fold, { phase: immediate ? 'live' : 'ended' }) })
  }
  await act(async () => { root.render(h(Transition)) })
  assert.equal(mounts, 1)
  assert.equal(unmounts, 0)
  assert.equal(document.querySelector('[data-phase="ended"]')?.textContent, 'true')
  assert.deepEqual(commits, ['live:true', 'ended:true'])
  await act(async () => root.unmount())
})

test('readiness belongs to each keyed opening: A → pending B → A, and Records → Back', async () => {
  const root = createRoot(document.getElementById('root')!)
  const show = (sessionId: string) => h(DeferredTranscript, { ...props, key: sessionId, sessionId, immediate: false, children: h('section', { 'data-testid': `run-${sessionId}` }, sessionId) })
  await act(async () => { root.render(show('A')) })
  assert.equal(document.querySelector('.thread-scroll')?.hasAttribute('data-transcript-pending'), false)
  await act(async () => {
    flushSync(() => root.render(show('B')))
    assert.equal(document.querySelector('.thread-scroll')?.getAttribute('data-session-id'), 'B')
    assert.equal(document.querySelector('.thread-scroll')?.hasAttribute('data-transcript-pending'), true)
    flushSync(() => root.render(show('A')))
    assert.equal(document.querySelector('.thread-scroll')?.hasAttribute('data-transcript-pending'), true)
    assert.equal(document.querySelector('[data-testid="run-B"]'), null)
  })
  await act(async () => { root.render(h('div', {}, 'Records')) })
  await act(async () => {
    flushSync(() => root.render(show('A')))
    assert.equal(document.querySelector('.thread-scroll')?.hasAttribute('data-transcript-pending'), true)
  })
  assert.equal(document.querySelector('[data-testid="run-A"]')?.textContent, 'A')
  await act(async () => root.unmount())
})

test('real reference navigation waits for a pending turn, and a later follow/session intent cancels it', async () => {
  const initial = useStore.getState()
  const host = document.getElementById('root')!
  const scrolled: string[] = []
  dom.window.HTMLElement.prototype.scrollIntoView = function () { scrolled.push(this.getAttribute('data-testid') ?? '') }
  const fresh = () => {
    host.innerHTML = '<div class="thread-scroll" data-session-id="A" data-transcript-pending="true"></div>'
    useStore.setState({ session: { id: 'A' } as never, runs: [{ id: 'r', session_id: 'A' }] as never })
    return host.firstElementChild!
  }
  const mount = (scroller: Element) => { scroller.innerHTML = '<section data-testid="run-r"><div class="agent-span">answer</div></section>'; scroller.removeAttribute('data-transcript-pending') }
  try {
    let scroller = fresh()
    // This is the reference button's real navigation function, including the card fallback decision.
    const button = document.createElement('button'); button.onclick = () => jumpToRun('r'); host.append(button); button.click()
    mount(scroller); await new Promise(r => setTimeout(r, 0))
    assert.deepEqual(scrolled, ['run-r'])
    scrolled.length = 0
    scroller = fresh(); assert.equal(focusTurn('r'), true); followThread(); mount(scroller)
    await new Promise(r => setTimeout(r, 0)); assert.deepEqual(scrolled, [], 'a newer Jump/Send follow intent wins')
    scroller = fresh(); assert.equal(focusTurn('r'), true)
    host.innerHTML = '<div class="thread-scroll" data-session-id="B"><section data-testid="run-r">not the old opening</section></div>'
    await new Promise(r => setTimeout(r, 0)); assert.deepEqual(scrolled, [], 'a removed opening cannot steal a new session')
  } finally { host.innerHTML = ''; useStore.setState(initial) }
})


test('initial follow sees the latest committed height exactly once, and a held view performs no write', async () => {
  const { useFollowBottom } = await import('../src/components/useFollowBottom.ts')
  Object.assign(globalThis, {
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: () => 1, cancelAnimationFrame: () => {},
  })
  for (const [held, immediate] of [[false, false], [true, false], [false, true]]) {
    const writes: number[] = [], callbacks: { height: number; writes: number }[] = []
    const root = createRoot(document.getElementById('root')!)
    function Content({ height, mounted }: { height: number; mounted: () => void }) {
      useLayoutEffect(mounted, [mounted])
      return h('section', { 'data-height': height }, 'complete transcript')
    }
    function Harness() {
      const follow = useFollowBottom()
      const [height, setHeight] = useState(100)
      const mounted = useCallback(() => setHeight(300), [])
      const attach = useCallback((node: HTMLDivElement | null) => {
        if (node) {
          let top = 0
          Object.defineProperty(node, 'scrollHeight', { configurable: true, get: () => Number(node.querySelector<HTMLElement>('[data-height]')?.dataset.height ?? 0) })
          Object.defineProperty(node, 'scrollTop', { configurable: true, get: () => top, set: (n: number) => { top = n; writes.push(n) } })
        }
        follow.ref(node)
      }, [follow.ref])
      useLayoutEffect(() => follow.setPinned(!held), [follow.setPinned])
      const initial = useCallback(() => {
        const before = writes.length
        const height = follow.node.current!.scrollHeight
        follow.initialFollow()
        callbacks.push({ height, writes: writes.length - before })
      }, [follow.initialFollow, follow.node])
      return h(DeferredTranscript, { sessionId: 'height', scrollerRef: attach, onScroll: follow.onScroll, immediate: immediate!, onInitialFollow: initial,
        children: h(Content, { height, mounted }) })
    }
    await act(async () => { root.render(h(Harness)) })
    assert.deepEqual(callbacks, [{ height: 300, writes: held ? 0 : 1 }])
    if (!held) assert.equal(writes.at(-1), 300)
    await act(async () => root.unmount())
  }
})
