const assert = require('node:assert/strict')
const test = require('node:test')
const { EventEmitter } = require('node:events')
const { cdpDriver } = require('../computer_electron')

const turn = () => new Promise((resolve) => setImmediate(resolve))
const gate = () => { let resolve; const promise = new Promise((done) => { resolve = done }); return { promise, resolve } }
const jpegOf = (width, height, content) => Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9]),
  Buffer.from(content),
])

/** The side effects measured on Electron 38.8.6 (see scripts/check_browser_capture.cjs for the real regression):
 *  a surface capture restores its starting viewport after finishing, and a clipped capture alters the compositor
 *  while another picture is in flight. A view capture does neither. Gates make the two races deterministic here. */
function page() {
  const wc = new EventEmitter(), dbg = new EventEmitter()
  const first = gate(), release = gate()
  let viewport = { width: 1280, height: 800 }, captures = 0, clipped = false
  dbg.attach = () => {}
  dbg.sendCommand = async (method, params = {}) => {
    if (method === 'Page.getLayoutMetrics') return { cssLayoutViewport: { clientWidth: viewport.width, clientHeight: viewport.height } }
    if (method !== 'Page.captureScreenshot') return {}
    captures += 1
    const number = captures, start = { ...viewport }
    if (params.fromSurface !== false && params.clip) clipped = true
    if (number === 1) { first.resolve(); await release.promise }
    else { await turn(); release.resolve() }
    const solid = params.fromSurface !== false && clipped && !params.clip
    if (params.fromSurface !== false) viewport = start
    return { data: jpegOf(viewport.width * 2, viewport.height * 2, solid ? 'solid' : 'content').toString('base64') }
  }
  Object.assign(wc, { debugger: dbg, getURL: () => 'https://example.test/', getTitle: () => 'Example', isLoading: () => false, isDestroyed: () => false })
  return { driver: cdpDriver(wc), first, release, resize: (size) => { viewport = size } }
}

test('a screenshot finishing during a Browser card resize preserves the new viewport', async () => {
  const env = page()
  const picture = env.driver.screenshot({ width: 1280, height: 800 })
  await env.first.promise
  env.resize({ width: 408, height: 236 })
  env.release.resolve()
  await picture
  assert.deepEqual((await env.driver.info()).viewport, { width: 408, height: 236 })
})

test('a click warming its page while a full screenshot is in flight keeps the page content', async () => {
  const env = page()
  const picture = env.driver.screenshot({ width: 1280, height: 800 })
  await env.first.promise
  const click = env.driver.click(100, 100)
  const image = await picture
  await click
  assert.ok(Buffer.from(image.data_base64, 'base64').toString().endsWith('content'), 'the full picture must not become a single compositor colour')
})
