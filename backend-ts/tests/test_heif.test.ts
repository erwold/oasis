/** A HEIC photo (an iPhone's — sometimes handed on under a .JPG name) made a JPEG so it can be attached: known by its
 *  bytes, converted by the system's own converter on macOS, refused in words elsewhere; the JPEG is measured as every
 *  image is, and one over the limit is made smaller. The page asks for it at POST /api/images/jpeg, and uploads the
 *  JPEG as any image; an upload of the HEIC itself is still refused. */

import { afterEach, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ImageAttachment } from '@oasis-code/contract'
import { heifToJpeg, isHeif, MAX_HEIF_BYTES, type HeifConverter } from '../src/llm/heif.ts'
import { ImageRefused, MAX_IMAGE_BYTES, measureImage } from '../src/llm/images.ts'
import { createApp, type App } from '../src/main.ts'
import { Client, json } from './api_harness.ts'
import { testConfig, testSettings } from './harness.ts'

const FIXTURES = join(import.meta.dir, 'fixtures', 'images')
const fixture = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)))
const HEIC = fixture('red-7x5.heic')
const JPEG = fixture('red-7x5.jpg')
const onMac = process.platform === 'darwin'

let app: App | null = null
afterEach(async () => { if (app) await app.close(); app = null })

/** A converter the test plays: it writes what it is told, and keeps what it was asked. */
function playing(outputs: (Uint8Array | null)[]): { convert: HeifConverter; asked: { side: number | null; quality: number }[] } {
  const asked: { side: number | null; quality: number }[] = []
  return {
    asked,
    convert: async (from, to, opts) => {
      expect(isHeif(new Uint8Array(readFileSync(from)))).toBe(true)
      asked.push(opts)
      const out = outputs[asked.length - 1] ?? null
      if (out === null) return false
      writeFileSync(to, out)
      return true
    },
  }
}

test('HEIC is known by its bytes, whatever the file is called', () => {
  expect(isHeif(HEIC)).toBe(true)
  expect(isHeif(fixture('heic-named.JPG'))).toBe(true)                               // an iPhone photo handed on as .JPG
  for (const name of ['red-7x5.jpg', 'red-7x5.png', 'red-7x5-lossy.webp', 'dot.gif', 'dot.svg']) expect(isHeif(fixture(name)), name).toBe(false)
  expect(isHeif(new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]))).toBe(false)   // an ftyp box cut before its brand
  // another ISO media file (an MP4 video) is no photo
  expect(isHeif(new Uint8Array([0, 0, 0, 24, ...Buffer.from('ftypisom0000')]))).toBe(false)
})

test('the conversion: refused off macOS and for bytes that are no HEIC; a JPEG over the limit is made smaller; a file the converter cannot read is said', async () => {
  await expect(heifToJpeg(JPEG)).rejects.toThrow(/not a HEIC image/)
  await expect(heifToJpeg(HEIC, { platform: 'linux' })).rejects.toThrow(/on macOS only; export it as JPEG or PNG/)
  const big = new Uint8Array(MAX_HEIF_BYTES + 1)
  big.set(HEIC)
  await expect(heifToJpeg(big, { platform: 'darwin', convert: playing([JPEG]).convert })).rejects.toThrow(/one up to 30 MB is converted/)
  // the first JPEG is over the image limit: asked again at a smaller side and a lighter quality
  const over = new Uint8Array(MAX_IMAGE_BYTES + 1)
  over.set(JPEG)
  const twice = playing([over, JPEG])
  expect(await heifToJpeg(HEIC, { platform: 'darwin', convert: twice.convert })).toEqual(JPEG)
  expect(twice.asked).toEqual([{ side: null, quality: 85 }, { side: 4096, quality: 80 }])
  const never = playing([over, over, over])
  await expect(heifToJpeg(HEIC, { platform: 'darwin', convert: never.convert })).rejects.toThrow(/still over 5 MB as a JPEG/)
  expect(never.asked.length).toBe(3)
  await expect(heifToJpeg(HEIC, { platform: 'darwin', convert: playing([null]).convert })).rejects.toThrow(ImageRefused)
  // what the converter wrote is measured as every image is: bytes that are no image are refused
  await expect(heifToJpeg(HEIC, { platform: 'darwin', convert: playing([new Uint8Array([1, 2, 3])]).convert })).rejects.toThrow(/not a PNG, JPEG or WebP/)
})

test.skipIf(!onMac)("on macOS the system's converter makes a real JPEG of the photo, at its own size", async () => {
  const jpeg = await heifToJpeg(HEIC)
  expect(measureImage(jpeg)).toEqual({ media_type: 'image/jpeg', width: 7, height: 5 })
})

test.skipIf(!onMac)('the page asks for the JPEG and uploads it as any image; the HEIC itself, and anything else, is refused', async () => {
  app = await createApp(testSettings(), testConfig())
  const c = new Client(app)
  const post = (path: string, bytes: Uint8Array) => c.app.app.request(`http://localhost${path}`, { method: 'POST', headers: { ...c.headers, 'content-type': 'application/octet-stream' }, body: bytes })
  const made = await post('/api/images/jpeg', fixture('heic-named.JPG'))
  expect(made.status).toBe(200)
  expect(made.headers.get('content-type')).toBe('image/jpeg')
  const jpeg = new Uint8Array(await made.arrayBuffer())
  expect(measureImage(jpeg)).toEqual({ media_type: 'image/jpeg', width: 7, height: 5 })
  const refused = await post('/api/images/jpeg', JPEG)
  expect(refused.status).toBe(415)
  expect((await json(refused, 415)).detail).toMatch(/not a HEIC image/)
  // the upload: the JPEG is stored; the HEIC is not an image the harness keeps
  const project = await json(await c.post('/api/projects', { no_folder: true }))
  const session = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'photo' }))
  const kept = await json<ImageAttachment>(await post(`/api/sessions/${session.id}/attachments?name=1790788534158.JPG`, jpeg))
  expect([kept.media_type, kept.width, kept.height, kept.name]).toEqual(['image/jpeg', 7, 5, '1790788534158.JPG'])
  expect((await post(`/api/sessions/${session.id}/attachments?name=1790788534158.JPG`, HEIC)).status).toBe(415)
}, 60_000)
