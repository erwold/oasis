const assert = require('node:assert/strict')
const test = require('node:test')
const { EventEmitter } = require('node:events')
const { cdpDriver, jpegSize } = require('../computer_electron')

function jpegOf(width, height) {
  return Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9])
}
function fixture(width, height, { failDisplay = false, hugeDisplay = false, hugeRaw = false } = {}) {
  const dbg = new EventEmitter()
  const sent = [], resized = [], lines = []
  const raw = Buffer.concat([jpegOf(width, height), ...(hugeRaw ? [Buffer.alloc(5 * 1024 * 1024)] : [])])
  dbg.attach = () => {}
  dbg.sendCommand = async (method, params) => { sent.push([method, params]); return { data: raw.toString('base64') } }
  const nativeImage = { createFromBuffer: () => ({ resize: (to) => {
    resized.push(to)
    if (failDisplay && to.width > 1280) throw new Error('display resize failed')
    return { toJPEG: (quality) => { resized.at(-1).encoded = quality; return Buffer.concat([jpegOf(to.width, to.height), ...(hugeDisplay && to.width > 1280 ? [Buffer.alloc(5 * 1024 * 1024)] : [])]) } }
  } }) }
  const page = cdpDriver({ debugger: dbg }, { nativeImage, log: (line) => lines.push(line) })
  return { page, sent, resized, raw, lines }
}

test('a browser history picture preserves device pixels from the same capture while the agent keeps its CSS-pixel picture', async () => {
  const { page, sent, raw, lines } = fixture(2560, 1600)
  const shot = await page.screenshot({ width: 1280, height: 800 }, { displayImage: true })
  assert.deepEqual([shot.width, shot.height], [1280, 800])
  assert.ok(shot.display_image, 'the history needs the device-pixel picture')
  assert.deepEqual([shot.display_image.width, shot.display_image.height], [2560, 1600])
  assert.deepEqual(Buffer.from(shot.display_image.data_base64, 'base64'), raw)
  assert.deepEqual(sent, [['Page.captureScreenshot', { format: 'jpeg', quality: 90, fromSurface: false }]])
  assert.ok(lines.some((line) => /display picture:.*sent 2560x1600/.test(line)))
  assert.equal('display_image' in await page.screenshot({ width: 1280, height: 800 }), false)
})

test('a narrow browser keeps a sharp history picture and large pictures are bounded without upscaling', async () => {
  for (const [width, height, css, expected] of [[816, 1200, [408, 600], [816, 1200]], [3840, 2400, [1920, 1200], [2560, 1600]]]) {
    const { page } = fixture(width, height)
    const shot = await page.screenshot({ width: css[0], height: css[1] }, { displayImage: true })
    assert.ok(shot.display_image, 'a display picture is kept')
    assert.deepEqual([shot.display_image.width, shot.display_image.height], expected)
    assert.deepEqual(jpegSize(Buffer.from(shot.display_image.data_base64, 'base64')), { width: expected[0], height: expected[1] })
    assert.ok(Math.max(shot.width, shot.height) <= 1280)
  }
})

test('a display encoder failure or an oversized display falls back to the usable agent picture', async () => {
  for (const options of [{ failDisplay: true }, { hugeDisplay: true }]) {
    const { page } = fixture(3840, 2400, options)
    const shot = await page.screenshot({ width: 1920, height: 1200 }, { displayImage: true })
    assert.deepEqual([shot.width, shot.height], [1280, 800])
    assert.equal(shot.display_image, undefined)
  }
  const { page, resized } = fixture(2560, 1600, { hugeRaw: true })
  const shot = await page.screenshot({ width: 1280, height: 800 }, { displayImage: true })
  assert.ok(shot.display_image, 'an oversized raw picture is re-encoded within the bound')
  assert.ok(Buffer.from(shot.display_image.data_base64, 'base64').length <= 4 * 1024 * 1024)
  assert.ok(resized.some((size) => size.width === 2560))
})
