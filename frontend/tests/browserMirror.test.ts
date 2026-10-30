/** The actual BrowserPage event handlers, with React's render sinks and the shell bridge supplied by the fixture. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import ts from 'typescript'

type Ref = { current: unknown }
type Element = { type: string; props: Record<string, any> }
const hooks = { refs: [] as Ref[], effects: [] as Array<() => unknown>, states: [] as unknown[] }
const frame = { page: 'tab-1#1', image: { media_type: 'image/jpeg', data_base64: 'AAAA', width: 2560, height: 1600 } }
Object.assign(globalThis, {
  __browserMirrorTest: {
    ref: (current: unknown) => { const ref = { current }; hooks.refs.push(ref); return ref },
    effect: (effect: () => unknown) => hooks.effects.push(effect),
    state: () => [frame, (next: unknown) => hooks.states.push(next)],
    status: () => ({ shown_page: 'tab-1#1' }),
  },
})
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.endsWith('/BrowserPage.tsx')) {
      if (specifier === 'react') return { url: 'data:text/javascript,export const useRef = (v) => globalThis.__browserMirrorTest.ref(v); export const useEffect = (f) => globalThis.__browserMirrorTest.effect(f); export const useState = () => globalThis.__browserMirrorTest.state(); export const useSyncExternalStore = () => globalThis.__browserMirrorTest.status();', shortCircuit: true }
      if (specifier === './useBrowserPlacement') return { url: 'data:text/javascript,export const useBrowserPlacement = () => ({shown:true,standIn:false,frame:{width:457,height:286}});', shortCircuit: true }
      if (specifier === '../state/store') return { url: 'data:text/javascript,export const useStore = () => null;', shortCircuit: true }
      if (specifier === './icons') return { url: 'data:text/javascript,export const ChevronLeftIcon = null, ChevronRightIcon = null, PickIcon = null, PlusIcon = null, RefreshIcon = null, XIcon = null;', shortCircuit: true }
      if (specifier === '../state/desktop') return next(new URL('../state/desktop.ts', context.parentURL).href, context)
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.endsWith('/BrowserPage.tsx')) {
      const out = ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), { fileName: fileURLToPath(url), compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } })
      return { format: 'module', source: out.outputText, shortCircuit: true }
    }
    return next(url, context)
  },
})
const { BrowserPage } = await import('../src/components/BrowserPage.tsx')

function fixture() {
  hooks.refs.length = 0; hooks.effects.length = 0; hooks.states.length = 0
  const events: Array<Record<string, unknown>> = []
  const timers: Array<() => void> = []
  let wheel: ((event: unknown) => void) | undefined
  let focused = 0
  let prevented = 0
  let captures = 0
  let reads = 0
  Object.assign(globalThis, {
    window: { oasisCodeDesktop: { browserInput: async (event: Record<string, unknown>) => { events.push(event); return { ok: true } }, surfaceFrame: async () => { reads += 1; return frame } }, setTimeout: (tick: () => void) => { timers.push(tick); return 1 }, clearTimeout: () => {} },
    document: { visibilityState: 'visible' },
  })
  const tree = BrowserPage({ place: () => {} }) as unknown as Element
  const pane = tree.props.children[1] as Element
  const children = (Array.isArray(pane.props.children) ? pane.props.children : [pane.props.children]).filter(Boolean) as Element[]
  const image = children.find((child) => child.type === 'img')
  const input = children.find((child) => child.type === 'textarea')
  const host = { addEventListener: (_: string, fn: (event: unknown) => void) => { wheel = fn }, removeEventListener: () => {}, setPointerCapture: () => { captures += 1 }, hasPointerCapture: () => true, releasePointerCapture: () => { captures -= 1 } }
  hooks.refs[0]!.current = host
  if (image) hooks.refs[1]!.current = { getBoundingClientRect: () => ({ left: 100, top: 80, width: 457, height: 286 }) }
  if (input) hooks.refs[2]!.current = { focus: () => { focused += 1 } }
  const pointer = (x = 328.5, y = 223) => ({ clientX: x, clientY: y, button: 0, buttons: 1, pointerId: 1, detail: 1, altKey: false, ctrlKey: false, shiftKey: false, metaKey: false, currentTarget: host, preventDefault: () => { prevented += 1 } })
  const key = (name: string, extra = {}) => ({ key: name, code: `Key${name.toUpperCase()}`, repeat: false, location: 0, nativeEvent: { isComposing: false }, altKey: false, ctrlKey: false, shiftKey: false, metaKey: false, getModifierState: () => false, preventDefault: () => { prevented += 1 }, ...extra })
  return { pane, image, input, events, pointer, key, timers, get reads() { return reads }, get focused() { return focused }, get prevented() { return prevented }, get captures() { return captures }, installWheel: () => hooks.effects.at(-1)!(), wheel: (event: unknown) => wheel!(event) }
}

test('an uncovered Browser card still renders the whole desktop image and reads subsequent frames', async () => {
  const f = fixture()
  assert.ok(f.image, 'the visible card renders its complete desktop mirror, including while uncovered')
  assert.deepEqual(f.image.props.style, { width: 457, height: 286 })
  assert.ok(f.input, 'the mirror accepts keyboard and composition input')
  const cleanup = hooks.effects[1]!() as () => void
  await Promise.resolve(); await Promise.resolve()
  assert.equal(f.reads, 1)
  assert.equal(f.timers.length, 1)
  f.timers.shift()!()
  await Promise.resolve(); await Promise.resolve()
  assert.equal(f.reads, 2, 'the visible page receives live frames instead of one stale screenshot')
  cleanup()
})

test('card clicks, picker hover and a drag beyond its image use fixed page coordinates; the blank margin does nothing', () => {
  const f = fixture()
  assert.equal(typeof f.pane.props.onPointerDown, 'function', 'the mirror forwards pointer input')
  f.pane.props.onPointerDown(f.pointer(99, 100))
  assert.equal(f.events.length, 0)
  f.pane.props.onPointerDown(f.pointer())
  assert.deepEqual(f.events[0], { page: 'tab-1#1', type: 'mouseDown', x: 640, y: 400, button: 'left', clickCount: 1, buttons: 1, modifiers: [] })
  assert.equal(f.focused, 1)
  f.pane.props.onPointerMove(f.pointer(800, 900))
  assert.deepEqual(f.events[1], { page: 'tab-1#1', type: 'mouseMove', x: 1279, y: 799, button: 'left', buttons: 1, modifiers: [] })
  f.pane.props.onPointerUp(f.pointer(800, 900))
  assert.equal(f.events[2]!.type, 'mouseUp')
  assert.equal(f.captures, 0)
  f.pane.props.onPointerMove(f.pointer(100, 80))
  assert.deepEqual(f.events[3], { page: 'tab-1#1', type: 'mouseMove', x: 0, y: 0, buttons: 1, modifiers: [] })
})

test('wheel scroll stays on the page, and keyboard text, IME and paste are inserted exactly once', () => {
  const f = fixture()
  assert.ok(f.input, 'the mirror has its keyboard input proxy')
  f.installWheel()
  f.wheel({ ...f.pointer(), deltaX: 0, deltaY: 3, deltaMode: 1 })
  assert.deepEqual(f.events.pop(), { page: 'tab-1#1', type: 'mouseWheel', x: 640, y: 400, deltaX: 0, deltaY: 48, modifiers: [] })
  assert.equal(f.prevented, 1)
  const keyboard = f.input.props
  keyboard.onKeyDown(f.key('a'))
  keyboard.onInput({ currentTarget: { value: 'a' }, nativeEvent: { isComposing: false } })
  keyboard.onKeyUp(f.key('a'))
  assert.deepEqual(f.events.map((event) => event.type), ['keyDown', 'text', 'keyUp'])
  assert.equal(f.events[1]!.text, 'a')
  f.events.length = 0
  keyboard.onCompositionStart()
  keyboard.onKeyDown(f.key('Process', { nativeEvent: { isComposing: true } }))
  const target = { value: '上海' }
  keyboard.onInput({ currentTarget: target, nativeEvent: { isComposing: true } })
  assert.equal(f.events.length, 0)
  keyboard.onCompositionEnd({ currentTarget: target, data: '上海' })
  keyboard.onInput({ currentTarget: target, nativeEvent: { isComposing: false } })
  assert.deepEqual(f.events, [{ page: 'tab-1#1', type: 'text', text: '上海' }])
  keyboard.onPaste({ currentTarget: target, preventDefault: () => {}, clipboardData: { getData: () => '粘贴 text' } })
  assert.equal(f.events.at(-1)!.text, '粘贴 text')
  keyboard.onKeyDown(f.key('Enter'))
  assert.equal((f.events.at(-1) as Record<string, unknown>).keyCode, 'Enter')
  assert.equal(f.prevented, 2, 'navigation/editing keys act only on the remote page')
})


test('double clicks retain their click count when Chromium pointer events report detail zero', () => {
  const f = fixture()
  assert.equal(typeof f.pane.props.onPointerDown, 'function')
  const click = (at: number, x = 328.5) => {
    f.pane.props.onPointerDown({ ...f.pointer(x), detail: 0, timeStamp: at })
    f.pane.props.onPointerUp({ ...f.pointer(x), detail: 0, timeStamp: at + 20, buttons: 0 })
  }
  click(100)
  click(240)
  assert.deepEqual(f.events.map((event) => event.clickCount), [1, 1, 2, 2], 'down and up carry the same double-click count')
  click(300, 360)
  click(1000, 360)
  assert.deepEqual(f.events.slice(4).map((event) => event.clickCount), [1, 1, 1, 1], 'moving away or waiting resets the sequence')
})
