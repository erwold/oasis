// The Browser card's page as a pane (2026-10-16): where the shell places the agent's browser over the card (the body's
// own laid-out size, pixel-snapped), when it steps aside (anything over any part of it, past the window's edge), the
// card's own controls, and a picked element as a line of the person's message. Read through the module's namespace so
// that, run against the code before this change, these fail on what they assert rather than on an import.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as desktop from '../src/state/desktop.ts'

type Rect = { left: number; top: number; width: number; height: number }
type Box = { left: number; top: number; right: number; bottom: number }
type Place = { x: number; y: number; width: number; height: number; visible: boolean }
type Picked = { tag: string; selector: string; role: string | null; text: string; url: string }
const api = desktop as unknown as {
  browserPlaceOf?: (rect: Rect, layout: { width: number; height: number }, uncovered: (x: number, y: number) => boolean, shown: boolean, view: { width: number; height: number }, overlays?: Box[]) => Place
  coveringBoxes?: (body: Rect, c: { rect: Box; overlay: boolean; topAt: (x: number, y: number) => boolean }[]) => Box[]
  browserControls?: (scope: { oasisCodeDesktop?: unknown }) => unknown
  pickedLine?: (p: Picked) => string
}
function need<T>(f: T | undefined, what: string): T {
  assert.equal(typeof f, 'function', `${what} is part of the desktop state`)
  return f as T
}
const { chatGptPlaceOf } = desktop

test("the agent's browser shows over its card at the body's own laid-out size, pixel-snapped; anything over any part of it, an overlay crossing it or a card past the window's edge hides it — with its size kept", () => {
  const placeOf = need(api.browserPlaceOf, 'browserPlaceOf')
  const view = { width: 1440, height: 900 }
  const rect = { left: 600.4, top: 80.2, width: 480, height: 600 }
  const layout = { width: 480, height: 600 }
  const clear = () => true
  assert.deepEqual(placeOf(rect, layout, clear, true, view), { x: 600, y: 80, width: 480, height: 600, visible: true })
  // a card lifted by a drag (scale 1.025): the page keeps its layout size — no new viewport for a drag — centred on it
  const lifted = { left: 594.4, top: 72.7, width: 492, height: 615 }
  assert.deepEqual(placeOf(lifted, layout, clear, true, view), { x: 600, y: 80, width: 480, height: 600, visible: true })
  // covered anywhere a grid of probes reaches — not only at five points as the ChatGPT page is
  const at = (px: number, py: number) => (x: number, y: number) => !(Math.abs(x - px) < 2 && Math.abs(y - py) < 2)
  const probeX = 600.4 + 6 + (480 - 12) / 4, probeY = 80.2 + 6 + ((600 - 12) * 3) / 4
  assert.equal(placeOf(rect, layout, at(probeX, probeY), true, view).visible, false)
  assert.equal(chatGptPlaceOf(rect, at(probeX, probeY), true).visible, true)          // the ChatGPT page's own rule, as it was
  // a menu or dialog crossing the body (even where no probe falls), and only one that crosses it
  assert.equal(placeOf(rect, layout, clear, true, view, [{ left: 1070, top: 300, right: 1200, bottom: 340 }]).visible, false)
  assert.equal(placeOf(rect, layout, clear, true, view, [{ left: 100, top: 300, right: 590, bottom: 340 }]).visible, true)
  // past the window's edge, the app hidden, too small: hidden, the place and size still said (the shell keeps the size)
  assert.deepEqual(placeOf({ ...rect, left: 1000 }, layout, clear, true, view), { x: 1000, y: 80, width: 480, height: 600, visible: false })
  assert.equal(placeOf({ ...rect, top: -4 }, layout, clear, true, view).visible, false)
  assert.equal(placeOf(rect, layout, clear, false, view).visible, false)
  assert.equal(placeOf({ left: 0, top: 0, width: 480, height: 10 }, { width: 480, height: 10 }, clear, true, view).visible, false)
})

test('what lies over the Browser card hides its page: an overlay wherever it crosses the body; anything else only where it is the topmost thing — a 2 px line between the probes included, a card behind not', () => {
  const placeOf = need(api.browserPlaceOf, 'browserPlaceOf')
  const covering = need(api.coveringBoxes, 'coveringBoxes')
  const body = { left: 100, top: 100, width: 480, height: 600 }
  const view = { width: 1440, height: 900 }
  const at = (box: Box) => (x: number, y: number) => x >= box.left && x <= box.right && y >= box.top && y <= box.bottom
  // a 2 px line across the body, between two rows of probes (rows at 106, 253, 400, 547, 694)
  const line = { left: 50, top: 180, right: 700, bottom: 182 }
  const over = covering(body, [{ rect: line, overlay: false, topAt: at(line) }])
  assert.equal(over.length, 1)
  assert.equal(placeOf(body, body, () => true, true, view, over).visible, false)
  // the probes alone would not have seen it
  assert.equal(placeOf(body, body, (x, y) => !at(line)(x, y), true, view).visible, true)
  // a card behind the Browser card (never the topmost where they cross), something beside it: nothing covers it
  const behind = { left: 80, top: 80, right: 600, bottom: 720 }
  const beside = { left: 600, top: 100, right: 800, bottom: 300 }
  assert.deepEqual(covering(body, [{ rect: behind, overlay: false, topAt: () => false }, { rect: beside, overlay: false, topAt: () => true }]), [])
  // an overlay of the app (a menu, a dialog) crossing it covers even where the hit test would not say so
  assert.equal(covering(body, [{ rect: { left: 560, top: 300, right: 700, bottom: 340 }, overlay: true, topAt: () => false }]).length, 1)
})

test("the Browser card's controls are the shell's when it has them all; a picked element reads as a line of the person's message, its address without query or fragment", () => {
  const controls = need(api.browserControls, 'browserControls')
  const line = need(api.pickedLine, 'pickedLine')
  assert.equal(controls({}), null)
  const f = async () => null
  assert.equal(controls({ oasisCodeDesktop: { platform: 'darwin', browserTab: f, browserNavigate: f } }), null)
  assert.ok(controls({ oasisCodeDesktop: { platform: 'darwin', browserTab: f, browserNavigate: f, pickBrowserElement: f, cancelBrowserPick: async () => true } }))
  // the old "Use it" is gone from the shell's surface
  assert.equal('browserTakeOver' in desktop, false)
  assert.equal(line({ tag: 'button', selector: '#buy', role: null, text: 'Buy now', url: 'https://shop.example/cart' }), 'The element `#buy` (<button> "Buy now") on https://shop.example/cart')
  assert.equal(line({ tag: 'div', selector: 'main > div:nth-of-type(2)', role: 'tab', text: '', url: 'https://x.example/' }), 'The element `main > div:nth-of-type(2)` (<div> role=tab) on https://x.example/')
  assert.match(line({ tag: 'p', selector: 'p', role: null, text: 'w'.repeat(200), url: 'https://x.example/' }), /"w{79}…"/)
  assert.match(line({ tag: 'a', selector: 'a', role: null, text: '', url: 'https://x.example/p?token=abc#frag' }), / on https:\/\/x\.example\/p$/)
})

type Frame = { page?: string | null; image: { media_type: string; data_base64: string; width: number; height: number } | null }
const api2 = desktop as unknown as {
  passesPointer?: (s: { pointerEvents: string; position: string }) => boolean
  browserStandIn?: (place: Place, pageShown: boolean, bodyVisible: boolean, rect: Rect, view: { width: number; height: number }) => boolean
  standInImage?: (frame: Frame | null, page: string | null | undefined) => Frame['image']
  OVERLAY_SELECTOR?: string
}

test("hover previews the pointer passes through (the thread's change preview, a media hover) cover the card as overlays do", () => {
  const passes = need(api2.passesPointer, 'passesPointer')
  assert.equal(passes({ pointerEvents: 'none', position: 'fixed' }), true)
  assert.equal(passes({ pointerEvents: 'none', position: 'absolute' }), true)
  assert.equal(passes({ pointerEvents: 'none', position: 'static' }), false)
  assert.equal(passes({ pointerEvents: 'auto', position: 'fixed' }), false)
  assert.match(api2.OVERLAY_SELECTOR ?? '', /\.change-preview/)
  assert.match(api2.OVERLAY_SELECTOR ?? '', /\.media-hover/)
  const covering = need(api.coveringBoxes, 'coveringBoxes')
  // a preview that never answers the hit test still covers where it crosses
  assert.equal(covering({ left: 0, top: 0, width: 400, height: 300 }, [{ rect: { left: 350, top: 20, right: 710, bottom: 300 }, overlay: passes({ pointerEvents: 'none', position: 'fixed' }), topAt: () => false }]).length, 1)
})

test('the stand-in picture is asked for only while the card is on screen and covered — not folded, put away, past the window or with the app hidden — and is drawn only for the page it is of', () => {
  const standIn = need(api2.browserStandIn, 'browserStandIn')
  const image = need(api2.standInImage, 'standInImage')
  const view = { width: 1440, height: 900 }
  const rect = { left: 100, top: 100, width: 480, height: 600 }
  const hidden = { x: 100, y: 100, width: 480, height: 600, visible: false }
  assert.equal(standIn(hidden, true, true, rect, view), true)                                 // covered: a picture
  assert.equal(standIn({ ...hidden, visible: true }, true, true, rect, view), false)            // the page shows itself
  assert.equal(standIn(hidden, true, false, rect, view), false)                               // a folded card's hidden body
  assert.equal(standIn({ ...hidden, height: 0 }, true, true, { ...rect, height: 0 }, view), false)
  assert.equal(standIn(hidden, true, true, { ...rect, left: 1000 }, view), false)             // past the window's edge
  assert.equal(standIn(hidden, false, true, rect, view), false)                               // the app hidden
  // A covered (its picture kept), shown again, tab B shown and covered: A's picture is never drawn for B
  const pic = { media_type: 'image/jpeg', data_base64: 'AAAA', width: 7, height: 5 }
  const ofA = { page: 'tab-1#1', image: pic }
  assert.equal(image(ofA, 'tab-1#1'), pic)
  assert.equal(image(ofA, 'tab-2#2'), null)
  assert.equal(image(ofA, 'tab-1#3'), null)                                                   // A again, after B: a new showing
  assert.equal(image(null, 'tab-1#1'), null)
})
