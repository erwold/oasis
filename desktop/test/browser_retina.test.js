const assert = require('node:assert/strict')
const test = require('node:test')
const { EventEmitter } = require('node:events')
const { browserAllows, cdpDriver, electronSurface, jpegSize } = require('../computer_electron')

/** The head of a JPEG of this size (its frame header is what jpegSize reads). */
function jpegOf(width, height) {
  return Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9])
}

/** A page on a 1x screen as Electron 38 gives it (measured 2026-10-16, --force-device-scale-factor=1): it draws a
 *  1280 x 800 viewport at 1280 x 800 until a device scale of 2 is set on its debugger session, then at 2560 x 1600;
 *  the setting goes with the session (a detach). Every command is kept with its parameters. */
function oneXPage() {
  const wc = new EventEmitter()
  const dbg = new EventEmitter()
  dbg.attached = false
  dbg.attach = () => { if (dbg.attached) throw new Error('Debugger is already attached to the target'); dbg.attached = true }
  dbg.detach = () => { dbg.attached = false }
  dbg.sent = []
  wc.scale = 1
  dbg.on('detach', () => { wc.scale = 1 })
  dbg.sendCommand = async (method, params = {}) => {
    dbg.sent.push([method, params])
    if (method === 'Emulation.setDeviceMetricsOverride') { wc.scale = params.deviceScaleFactor; return {} }
    if (method === 'Page.getLayoutMetrics') return { layoutViewport: { clientWidth: 1280, clientHeight: 800, pageX: 0, pageY: 0 }, cssLayoutViewport: { clientWidth: 1280, clientHeight: 800, pageX: 0, pageY: 0 }, cssContentSize: { width: 1280, height: 2000 } }
    if (method === 'Page.captureScreenshot') { await new Promise((r) => setImmediate(r)); return { data: jpegOf(1280 * wc.scale, 800 * wc.scale).toString('base64') } }
    return {}
  }
  wc.debugger = dbg
  wc.getURL = () => 'https://example.com/private?token=secret'
  wc.getTitle = () => 'Example'
  wc.isLoading = () => false
  wc.isDestroyed = () => false
  return wc
}

// Electron's nativeImage as far as a picture made smaller goes: what it is asked, and a JPEG of the size asked
function fakeNativeImage() {
  const resized = []
  return { resized, createFromBuffer: () => ({ resize: (to) => { resized.push(to); return { toJPEG: (quality) => { resized.at(-1).encoded = quality; return jpegOf(to.width, to.height) } } } }) }
}

const sentOf = (wc, method) => wc.debugger.sent.filter(([m]) => m === method).map(([, p]) => p)
const settle = () => new Promise((r) => setImmediate(r))

test("the agent's browser draws at 2x on any screen: set once per attach on its own debugger, its live picture keeps all 2560 x 1600 pixels; an agent's look stays CSS-sized", async () => {
  const wc = oneXPage()
  const nativeImage = fakeNativeImage()
  const lines = []
  const surface = electronSurface({ label: "the agent's browser", contents: () => wc, opened: () => true, allowsUrl: browserAllows, nativeImage, deviceScale: 2, log: (l) => lines.push(l) })
  const page = surface.open()
  await settle()
  // its own page only, on its debugger session (no app-wide switch), the size left to the view (0 x 0: not overridden)
  assert.deepEqual(sentOf(wc, 'Emulation.setDeviceMetricsOverride'), [{ width: 0, height: 0, deviceScaleFactor: 2, mobile: false }])
  // the live picture (the Browser card, the thread's live view): the page's own 2560 x 1600, sent as the page made it
  // at quality 80 — not made smaller to 1920, never a 1x picture blown up
  const frames = []
  for (let i = 0; i < 5; i += 1) frames.push(await surface.frame())
  const live = frames[0].image
  assert.deepEqual([live.width, live.height], [2560, 1600])
  assert.deepEqual(jpegSize(Buffer.from(live.data_base64, 'base64')), { width: 2560, height: 1600 })   // the bytes sent, not a label
  assert.deepEqual(frames[0].viewport, { width: 1280, height: 800 })
  assert.deepEqual(nativeImage.resized, [])
  // every picture is taken as the page draws itself: no clip, no scale (the card would see the page shrink and grow)
  const shots = sentOf(wc, 'Page.captureScreenshot')
  assert.equal(shots.length, 5)
  for (const shot of shots) assert.deepEqual(shot, { format: 'jpeg', quality: 80, fromSurface: false })
  // the frame loop never touches the metrics again
  assert.equal(sentOf(wc, 'Emulation.setDeviceMetricsOverride').length, 1)
  // an agent's look: CSS pixels (1280 x 800) made from the 2x picture, at the look's quality 70; its size read off the JPEG
  const look = await page.screenshot({ width: 1280, height: 800 })
  assert.deepEqual([look.width, look.height], [1280, 800])
  assert.deepEqual(nativeImage.resized, [{ width: 1280, height: 800, quality: 'good', encoded: 70 }])
  assert.deepEqual(sentOf(wc, 'Page.captureScreenshot').at(-1), { format: 'jpeg', quality: 90, fromSurface: false })
  // said once per kind of picture, with its sizes — no address, no page content
  assert.deepEqual(lines.filter((l) => /picture/.test(l)), [
    "[computer] the agent's browser's live picture: CSS viewport 1280x800, page drew 2560x1600 (2x), sent 2560x1600 at quality 80",
    "[computer] the agent's browser's look picture: CSS viewport 1280x800, page drew 2560x1600 (2x), sent 1280x800 at quality 70",
  ])
  assert.ok(lines.includes("[computer] the agent's browser draws at 2x"))
  assert.ok(!lines.some((l) => /example\.com|secret|Example/.test(l)))
  // the debugger taken away (the page crashed, a manual detach) and had again: the scale is set again with the new session
  wc.debugger.attached = false
  wc.debugger.emit('detach', {}, 'target closed')
  const again = await surface.frame()
  assert.equal(sentOf(wc, 'Emulation.setDeviceMetricsOverride').length, 2)
  assert.deepEqual([again.image.width, again.image.height], [2560, 1600])
})

test('a page without a device scale (the ChatGPT page) keeps its screen: no emulation, its live picture as before', async () => {
  const wc = oneXPage()
  const nativeImage = fakeNativeImage()
  const surface = electronSurface({ label: 'the ChatGPT page', contents: () => wc, opened: () => true, allowsUrl: browserAllows, nativeImage })
  surface.open()
  await settle()
  const frame = await surface.frame()
  assert.deepEqual(sentOf(wc, 'Emulation.setDeviceMetricsOverride'), [])
  assert.deepEqual([frame.image.width, frame.image.height], [1280, 800])
  assert.deepEqual(sentOf(wc, 'Page.captureScreenshot'), [{ format: 'jpeg', quality: 90, fromSurface: false }])
})

/** A driver over a page whose layout and snapshot answer as Electron 38 measured them (2026-10-16): a box at CSS
 *  (300, 300) 120 x 40, the page scrolled down 100 CSS pixels. */
function layoutPage({ device, css, dpr, bounds, scrollY }) {
  const dbg = new EventEmitter()
  dbg.attach = () => {}
  dbg.detach = () => {}
  dbg.sendCommand = async (method) => {
    if (method === 'Page.getLayoutMetrics') return { layoutViewport: { clientWidth: device, clientHeight: device * 0.625, pageX: 0, pageY: scrollY }, cssLayoutViewport: { clientWidth: css, clientHeight: css * 0.625, pageX: 0, pageY: 100 } }
    if (method === 'Runtime.evaluate') return { result: { value: dpr } }
    if (method === 'DOMSnapshot.captureSnapshot') return { documents: [{ nodes: { backendNodeId: [7] }, layout: { nodeIndex: [0], bounds: [bounds] }, scrollOffsetX: 0, scrollOffsetY: scrollY }] }
    return {}
  }
  return cdpDriver({ debugger: dbg, isDestroyed: () => false })
}

test("the agent's boxes stay in CSS pixels under a device scale set on the debugger (its snapshot is in the view's pixels, not devicePixelRatio's)", async () => {
  const box = { x: 300, y: 200, width: 120, height: 40 }
  // a 1x screen, device scale 2 set: devicePixelRatio says 2, the snapshot is at 1 per CSS pixel
  assert.deepEqual((await layoutPage({ device: 1280, css: 1280, dpr: 2, bounds: [300, 300, 120, 40], scrollY: 100 }).layout()).get(7), box)
  // the same, the card's zoom 0.5 on it: devicePixelRatio 1, the snapshot at 0.5
  assert.deepEqual((await layoutPage({ device: 1280, css: 2560, dpr: 1, bounds: [150, 150, 60, 20], scrollY: 50 }).layout()).get(7), box)
  // a Retina screen, with or without it: both say 2
  assert.deepEqual((await layoutPage({ device: 2560, css: 1280, dpr: 2, bounds: [600, 600, 240, 80], scrollY: 200 }).layout()).get(7), box)
  // a 1x screen, no scale set (the ChatGPT page), zoomed to 0.5: both say 0.5
  assert.deepEqual((await layoutPage({ device: 1280, css: 2560, dpr: 0.5, bounds: [150, 150, 60, 20], scrollY: 50 }).layout()).get(7), box)
})
