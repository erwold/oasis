/** The real placement hook driven one frame at a time. Geometry follows the isolated Electron fold/raise trace:
 *  a folded card can keep moving with a zero-height body; that is one hidden page, not a new native placement. */
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import type { ChatGptPlace } from '../src/state/desktop.ts'

type PlacementState = { shown: boolean; frame: { width: number; height: number } }
let mounted: (() => void) | undefined
const states: PlacementState[] = []
Object.assign(globalThis, {
  __browserPlacementHookTest: {
    effect: (effect: () => (() => void)) => { mounted = effect() },
    state: (initial: PlacementState) => [initial, (next: PlacementState) => states.push(next)],
  },
})
// Keep the hook and all geometry helpers real; only React's mount and state sinks are supplied by this unit fixture.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'react' && context.parentURL?.endsWith('/useBrowserPlacement.ts')) {
      return { url: 'data:text/javascript,export const useEffect = (f) => globalThis.__browserPlacementHookTest.effect(f); export const useState = (s) => globalThis.__browserPlacementHookTest.state(s);', shortCircuit: true }
    }
    if (specifier === '../state/desktop' && context.parentURL?.endsWith('/useBrowserPlacement.ts')) return next(new URL('../state/desktop.ts', context.parentURL).href, context)
    return next(specifier, context)
  },
})
const { useBrowserPlacement } = await import('../src/components/useBrowserPlacement.ts')

function fixture() {
  let frame: (() => void) | null = null
  let bodyVisible = true
  let covered = false
  let rect = { left: 770, top: 150, width: 712, height: 236 }
  const sent: ChatGptPlace[] = []
  const card = { contains: (target: unknown) => target === card }
  const body = { offsetWidth: rect.width, offsetHeight: rect.height, closest: () => card, getBoundingClientRect: () => ({ ...rect }) }
  states.length = 0
  Object.assign(globalThis, {
    window: { innerWidth: 1500, innerHeight: 900 },
    document: { visibilityState: 'visible', querySelectorAll: () => [], elementFromPoint: () => covered ? null : card },
    getComputedStyle: () => ({ visibility: bodyVisible ? 'visible' : 'hidden', pointerEvents: 'auto' }),
    requestAnimationFrame: (next: () => void) => { frame = next; return 1 },
    cancelAnimationFrame: () => { frame = null },
  })
  useBrowserPlacement({ current: body as unknown as HTMLDivElement }, (place) => sent.push(place))
  return {
    sent,
    tick(next: Partial<typeof rect> = {}, visible = true, occluded = false) {
      rect = { ...rect, ...next }
      body.offsetWidth = rect.width; body.offsetHeight = rect.height
      bodyVisible = visible; covered = occluded
      assert.ok(frame, 'the hook scheduled its next placement sample')
      frame()
    },
    close() { mounted?.(); mounted = undefined },
  }
}

test('folding a moving Browser card publishes one hide, keeps its native viewport, and shows its latest place when raised', () => {
  const f = fixture()
  try {
    f.tick()
    assert.deepEqual(f.sent, [{ x: 770, y: 150, width: 712, height: 236, visible: true }])
    // Real Electron: the folded body has zero height; its hidden x/y still change with transform/hover animation.
    for (let i = 0; i < 40; i += 1) f.tick({ left: 770 + i, top: 498 + i, height: 0 }, false)
    const hidden = f.sent.filter((place) => !place.visible)
    assert.equal(hidden.length, 1, 'one hide is enough: moving a folded body must not repeatedly place the native page')
    assert.deepEqual(states.at(-1)!.frame, { width: 0, height: 0 })
    f.tick({ left: 650, top: 170, width: 832, height: 420 })
    assert.deepEqual(f.sent.at(-1), { x: 650, y: 170, width: 832, height: 420, visible: true })
    assert.equal(f.sent.length, 3)
  } finally { f.close() }
  assert.deepEqual(f.sent.at(-1), { x: 0, y: 0, width: 0, height: 0, visible: false }, 'unmount still hides the native page')
})

test('mirror resize and drag publish current geometry; overlays and partial clipping keep uncovered content interactive', () => {
  const f = fixture()
  try {
    f.tick()
    f.tick({ left: 700 })
    f.tick({ width: 780, height: 400 })
    f.tick()
    assert.deepEqual(f.sent, [
      { x: 770, y: 150, width: 712, height: 236, visible: true },
      { x: 700, y: 150, width: 712, height: 236, visible: true },
      { x: 700, y: 150, width: 780, height: 400, visible: true },
    ])
    f.tick({}, true, true)
    assert.deepEqual(states.at(-1), { shown: true, frame: { width: 640, height: 400 } })
    assert.equal(f.sent.length, 3, 'an overlay is ordinary DOM clipping, not a reason to hide the live mirror')
    f.tick({ left: 730 }, true, true)
    assert.equal(f.sent.at(-1)!.visible, true, 'partly past the window edge still has usable visible content')
    f.tick({ left: 1501 }, true, true)
    assert.deepEqual(states.at(-1), { shown: false, frame: { width: 640, height: 400 } })
    f.tick({ left: 1510 }, true, true)
    assert.equal(f.sent.length, 5, 'fully offscreen movement publishes one hide')
    f.tick({ left: 700 }, true, false)
    assert.deepEqual(f.sent.at(-1), { x: 700, y: 150, width: 780, height: 400, visible: true })
  } finally { f.close() }
})
