/** The thread shows a run's pictures and clips from its working folder: the media route serves only those kinds, only
 *  inside the workspace, with byte ranges so a player can seek; and an image a tool handed the model is named in its
 *  result so the thread can show it. */

import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type App } from '../src/main.ts'
import { Client, json, makeApp } from './api_harness.ts'
import { buggyRepo } from './harness.ts'

let app: App | null = null
afterEach(async () => { if (app) await app.close(); app = null })

const PIXEL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')

test('pictures and clips of the workspace are served as themselves, with byte ranges; nothing else is', async () => {
  app = await makeApp()
  const c = new Client(app)
  const project = await json(await c.post('/api/projects', { source_path: buggyRepo() }))
  const session = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'media' }))
  const ws = session.workspace as { id: string; path: string }
  mkdirSync(join(ws.path, 'review'), { recursive: true })
  writeFileSync(join(ws.path, 'review', 'front view.png'), PIXEL_PNG)
  const clip = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251))
  writeFileSync(join(ws.path, 'walk.mp4'), clip)
  writeFileSync(join(ws.path, 'page.html'), '<script>alert(1)</script>')
  const route = `/api/workspaces/${ws.id}/media`

  const image = await c.get(route, { path: 'review/front view.png' })
  expect(image.status).toBe(200)
  expect(image.headers.get('content-type')).toBe('image/png')
  expect(image.headers.get('content-security-policy')).toBe("default-src 'none'")
  expect(Buffer.from(await image.arrayBuffer())).toEqual(PIXEL_PNG)

  const whole = await c.get(route, { path: 'walk.mp4' })
  expect(whole.headers.get('accept-ranges')).toBe('bytes')
  expect((await whole.arrayBuffer()).byteLength).toBe(1000)
  const part = await c.get(route, { path: 'walk.mp4' }, { range: 'bytes=100-199' })
  expect(part.status).toBe(206)
  expect(part.headers.get('content-range')).toBe('bytes 100-199/1000')
  expect(Buffer.from(await part.arrayBuffer())).toEqual(clip.subarray(100, 200))
  const tail = await c.get(route, { path: 'walk.mp4' }, { range: 'bytes=-10' })
  expect(tail.headers.get('content-range')).toBe('bytes 990-999/1000')
  expect((await c.get(route, { path: 'walk.mp4' }, { range: 'bytes=5000-' })).status).toBe(416)

  expect((await c.get(route, { path: 'page.html' })).status).toBe(415)            // a page would run under this origin
  expect((await c.get(route, { path: 'calc.py' })).status).toBe(415)
  expect((await c.get(route, { path: 'missing.png' })).status).toBe(404)
  expect((await c.get(route, { path: '../../outside.png' })).status).toBe(400)   // the file tools' path policy
  expect((await c.get(route)).status).toBe(422)
})

test('a picture named by its file name alone (its folder said a line above) is the one file of the workspace ending with it; two are not one', async () => {
  app = await makeApp()
  const c = new Client(app)
  const project = await json(await c.post('/api/projects', { source_path: buggyRepo() }))
  const session = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'media by name' }))
  const ws = session.workspace as { id: string; path: string }
  mkdirSync(join(ws.path, 'image-subscription', 'evidence', 'images'), { recursive: true })
  writeFileSync(join(ws.path, 'image-subscription', 'evidence', 'images', '04_edit_sunburst_0.png'), PIXEL_PNG)
  const route = `/api/workspaces/${ws.id}/media`
  for (const named of ['04_edit_sunburst_0.png', 'images/04_edit_sunburst_0.png', './evidence/images/04_edit_sunburst_0.png']) {
    const found = await c.get(route, { path: named })
    expect(found.status).toBe(200)
    expect(Buffer.from(await found.arrayBuffer())).toEqual(PIXEL_PNG)
  }
  expect((await c.get(route, { path: 'sunburst_0.png' })).status).toBe(404)      // a whole file name, never a part of one
  mkdirSync(join(ws.path, 'other'), { recursive: true })
  writeFileSync(join(ws.path, 'other', '04_edit_sunburst_0.png'), PIXEL_PNG)
  expect((await c.get(route, { path: '04_edit_sunburst_0.png' })).status).toBe(404)
  expect((await c.get(route, { path: 'images/04_edit_sunburst_0.png' })).status).toBe(200)
})
