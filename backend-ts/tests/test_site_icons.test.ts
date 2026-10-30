/** A fetched page's site icon: taken from the site the run just read (the icon the page names, else its
 *  /favicon.ico), through the same checks as the page, kept once per project and host, named on the thread's row and
 *  never to the model, and served to the session's page; a site with no icon leaves the fetch as it was. The pinned
 *  connection reports the named URL, not the address it connected to. Offline: a scripted transport plays the web,
 *  a fake resolver plays DNS, a local server plays the one real connection. */
import { afterEach, expect, test } from 'bun:test'
import * as web from '../src/agent/tools/web.ts'
import * as repo from '../src/db/repo.ts'
import { lastToolReturn, modelResponse, textPart, toolCallPart } from '../src/llm/messages.ts'
import { Client, makeApp } from './api_harness.ts'
import { buggyRepo, openSession, scriptedModel, setModel, waitDone } from './harness.ts'
import type { App } from '../src/main.ts'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
let app: App | null = null
const original = { ...web.hooks }
afterEach(async () => { web.setWebHooks(original); web.forgetMissingIcons(); if (app) await app.close(); app = null })

test('where a page says its icon is, and what an icon is', () => {
  const page = 'https://docs.example/guide/intro'
  expect(web.iconHref('<head><link rel="icon" type="image/png" href="/static/icon-32.png"></head>', page)).toBe('https://docs.example/static/icon-32.png')
  expect(web.iconHref("<link href='favicon.svg?v=1&amp;x=2' rel='shortcut icon'>", page)).toBe('https://docs.example/guide/favicon.svg?v=1&x=2')
  expect(web.iconHref('<link rel="mask-icon" href="/mask.svg"><link rel="apple-touch-icon" href="/touch.png">', page)).toBe('https://docs.example/touch.png')   // a stencil is no icon
  expect(web.iconHref('<link rel="stylesheet" href="/a.css">', page)).toBe('https://docs.example/favicon.ico')
  expect(web.iconHref(null, page)).toBe('https://docs.example/favicon.ico')
  expect(web.iconType(PNG)).toBe('image/png')
  expect(web.iconType(new Uint8Array([0, 0, 1, 0, 1, 0]))).toBe('image/x-icon')
  expect(web.iconType(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe('image/gif')
  expect(web.iconType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
  expect(web.iconType(new TextEncoder().encode('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe('image/svg+xml')
  expect(web.iconType(new TextEncoder().encode('<!doctype html><html><body>Not found</body></html>'))).toBeNull()
  expect(web.iconType(new Uint8Array([0, 0, 2, 0]))).toBeNull()                                          // a cursor
})

test("the site's icon is kept once per host beside the page, named on the thread's row only, and served to the session", async () => {
  const asked: string[] = []
  web.setWebHooks({
    resolve: async () => ['93.184.216.34'],
    fetchImpl: async (input) => {
      const u = new URL(String(input))
      asked.push(`${u.host}${u.pathname}`)
      if (u.pathname === '/static/icon.png') return new Response(PNG, { headers: { 'content-type': 'image/png' } })
      if (u.host === 'bare.example') {
        // a site that names no icon and has none at /favicon.ico
        if (u.pathname === '/favicon.ico') return new Response('<html>Not found</html>', { status: 404, headers: { 'content-type': 'text/html' } })
        return new Response(`<html><head><title>bare</title></head><body><p>page ${u.pathname}</p></body></html>`, { headers: { 'content-type': 'text/html' } })
      }
      return new Response(`<html><head><title>${u.pathname}</title><link rel="icon" href="/static/icon.png"></head><body><p>page ${u.pathname}</p></body></html>`, { headers: { 'content-type': 'text/html' } })
    },
  })
  app = await makeApp()
  const c = new Client(app)
  const st = app.state
  const { session } = await openSession(st, buggyRepo())
  const urls = ['https://icons.example/a', 'https://icons.example/b', 'https://bare.example/x']
  const returns: Record<string, unknown>[] = []
  let n = 0
  setModel(st, 'scripted:a', scriptedModel((messages) => {
    if (n > 0) returns.push(lastToolReturn(messages, 'fetch_url') as Record<string, unknown>)
    const url = urls[n++]
    return url ? modelResponse([toolCallPart('fetch_url', { url }, '')]) : modelResponse([textPart('read')])
  }))
  const run = await st.runs.start(session, 'read three pages')
  await waitDone(st, run.id)
  // the model reads the pages; nothing about an icon reaches it
  expect(returns.map((r) => r.status)).toEqual(['ok', 'ok', 'ok'])
  // one icon fetch for the host, however many of its pages were read; a host without one is asked once
  expect(asked).toEqual(['icons.example/a', 'icons.example/static/icon.png', 'icons.example/b', 'bare.example/x', 'bare.example/favicon.ico'])
  const icons = repo.listAssetsWithRole(st.conn, session.project_id, 'image', web.SITE_ICON_ROLE)
  expect(icons.map((a) => [a.meta.host, a.meta.media_type, a.meta.url])).toEqual([['icons.example', 'image/png', 'https://icons.example/static/icon.png']])
  for (const r of returns) { expect(r).not.toHaveProperty('icon_asset_id'); expect(JSON.stringify(r)).not.toContain(icons[0]!.id) }
  // the thread's rows name it: both pages of the host wear the one icon, the bare site none
  const rows = repo.listEvents(st.conn, run.id).filter((e) => e.event === 'tool_result' && e.data.tool === 'fetch_url').map((e) => e.data)
  expect(rows.map((d) => d.icon_asset_id ?? null)).toEqual([icons[0]!.id, icons[0]!.id, null])
  // the session's page reads it back; another project's session does not
  const served = await c.get(`/api/sessions/${session.id}/site-icons/${icons[0]!.id}`)
  expect(served.status).toBe(200)
  expect(served.headers.get('content-type')).toBe('image/png')
  expect(served.headers.get('x-content-type-options')).toBe('nosniff')
  expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG)
  const other = await openSession(st, buggyRepo())
  expect((await c.get(`/api/sessions/${other.session.id}/site-icons/${icons[0]!.id}`)).status).toBe(404)
  expect((await c.get(`/api/sessions/${session.id}/site-icons/${rows[0]!.asset_id as string}`)).status).toBe(404)   // a saved page is no icon
}, 60_000)

test('the pinned connection reports the named URL, never the address it connected to', async () => {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (req) => new Response(`host ${req.headers.get('host')}`) })
  try {
    const named = `http://pinned.example:${server.port}/page?q=1`
    const response = await web.pinnedFetch(named, { address: '127.0.0.1' })
    expect(await response.text()).toBe(`host pinned.example:${server.port}`)
    expect(response.url).toBe(named)
  } finally {
    server.stop(true)
  }
})

test("a site a link names (a page the session never read) gets its own icon from that site, once; none to give, or a private host, is a 404", async () => {
  const asked: string[] = []
  web.setWebHooks({
    resolve: async (host) => (host === 'intranet.corp' ? ['10.0.0.7'] : ['93.184.216.34']),
    fetchImpl: async (input) => {
      const u = new URL(String(input))
      asked.push(`${u.host}${u.pathname}`)
      if (u.host === 'cited.example' && u.pathname === '/') return new Response('<html><head><link rel="icon" href="/brand.png"></head></html>', { headers: { 'content-type': 'text/html' } })
      if (u.pathname === '/brand.png' || (u.host === 'plain.example' && u.pathname === '/favicon.ico')) return new Response(PNG, { headers: { 'content-type': 'image/png' } })
      if (u.host === 'plain.example') return new Response('nope', { status: 503 })
      return new Response('<html>Not found</html>', { status: 404, headers: { 'content-type': 'text/html' } })
    },
  })
  app = await makeApp()
  const c = new Client(app)
  const { session } = await openSession(app.state, buggyRepo())
  const icon = (host: string) => c.get(`/api/sessions/${session.id}/site-icons/by-host/${encodeURIComponent(host)}`)
  // two chips of one site at once: the site is asked once
  const [one, two] = await Promise.all([icon('cited.example'), icon('cited.example')])
  expect([one.status, two.status, one.headers.get('content-type')]).toEqual([200, 200, 'image/png'])
  expect(new Uint8Array(await one.arrayBuffer())).toEqual(PNG)
  expect(asked.filter((a) => a.startsWith('cited.example'))).toEqual(['cited.example/', 'cited.example/brand.png'])
  expect((await icon('cited.example')).status).toBe(200)                                      // kept: not asked again
  expect(asked.filter((a) => a.startsWith('cited.example'))).toHaveLength(2)
  const kept = repo.listAssetsWithRole(app.state.conn, String(session.project_id), 'image', web.SITE_ICON_ROLE)
  expect(kept.map((a) => [a.meta.host, a.meta.url])).toEqual([['cited.example', 'https://cited.example/brand.png']])
  // a home page that did not answer: its /favicon.ico still
  expect((await icon('plain.example')).status).toBe(200)
  // no icon at all: a 404, and the site is not asked again within the hour
  expect((await icon('none.example')).status).toBe(404)
  const before = asked.length
  expect((await icon('none.example')).status).toBe(404)
  expect(asked.length).toBe(before)
  // nothing is sent to a private host, or for what is no host
  expect((await icon('intranet.corp')).status).toBe(404)
  expect((await icon('localhost:8321')).status).toBe(404)
  expect((await icon('a b')).status).toBe(404)
  expect(asked.some((a) => a.startsWith('intranet.corp') || a.startsWith('localhost'))).toBe(false)
})
