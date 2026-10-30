const assert = require('node:assert/strict')
const test = require('node:test')
const { EventEmitter } = require('node:events')
const { electronSurface } = require('../computer_electron')

const gate = () => { let resolve; const promise = new Promise((done) => { resolve = done }); return { promise, resolve } }
const jpegOf = (width, height) => Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9])

// A real view capture can finish at the card's new size: fix-1x/2x new-resize probes measured an 816x472
// picture after a 1280x800 -> 408x236 resize. Its live pointer must not use the earlier viewport's proportions.
function fixture() {
  const wc = new EventEmitter(), dbg = new EventEmitter()
  const started = gate(), release = gate()
  let viewport = { width: 1280, height: 800 }, captures = 0
  dbg.attach = () => {}
  dbg.sendCommand = async (method) => {
    if (method === 'Page.getLayoutMetrics') return { cssLayoutViewport: { clientWidth: viewport.width, clientHeight: viewport.height } }
    if (method === 'Page.captureScreenshot') {
      captures += 1
      if (captures === 1) { started.resolve(); await release.promise }
      return { data: jpegOf(viewport.width * 2, viewport.height * 2).toString('base64') }
    }
    return {}
  }
  Object.assign(wc, { debugger: dbg, getURL: () => 'https://example.test/', getTitle: () => 'Example', isLoading: () => false, isDestroyed: () => false })
  const surface = electronSurface({ label: 'browser', contents: () => wc, opened: () => true, allowsUrl: () => true, deviceScale: 2 })
  return { surface, started, release, captures: () => captures, resize: (next) => { viewport = next } }
}

test('a live frame spanning a card resize is dropped for all its askers, without another capture; the next frame uses the new viewport', async () => {
  const env = fixture()
  const one = env.surface.frame(), two = env.surface.frame()
  await env.started.promise
  env.resize({ width: 408, height: 236 })
  env.release.resolve()
  assert.equal(await one, null, 'the new-sized picture must not carry the old viewport for pointer placement')
  assert.equal(await two, null)
  assert.equal(env.captures(), 1, 'dropping a mismatched live frame must not capture again')
  const fresh = await env.surface.frame()
  assert.deepEqual(fresh.viewport, { width: 408, height: 236 })
  assert.deepEqual([fresh.image.width, fresh.image.height], [816, 472])
  assert.equal(env.captures(), 2)
})

test('an unchanged live viewport keeps its first capture and shares it with concurrent askers', async () => {
  const env = fixture()
  const one = env.surface.frame(), two = env.surface.frame()
  await env.started.promise
  env.release.resolve()
  const frame = await one
  assert.equal(await two, frame)
  assert.deepEqual(frame.viewport, { width: 1280, height: 800 })
  assert.deepEqual([frame.image.width, frame.image.height], [2560, 1600])
  assert.equal(env.captures(), 1)
})
