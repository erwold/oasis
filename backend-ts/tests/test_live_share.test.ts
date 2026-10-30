/** Live read-only session sharing (src/share/live/*, src/api/live_share.ts): the settings (off by default), the
 *  person's link routes (owner-only), the share-only listener (its five paths and nothing else), the state stream
 *  (whole safe states, active runs, coalesced, one producer per projection), and the ends (revoke, expiry, session
 *  deleted, listener off) while viewers are connected. Synthetic data only; the listener binds an ephemeral port. */

import { afterEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { LiveShareSettingsResponseSchema, ShareLinkListResponseSchema, ShareLinkSecretResponseSchema } from '@oasis-code/contract'
import * as repo from '../src/db/repo.ts'
import { saveAttachment } from '../src/api/attachments.ts'
import { agentRouteAllowed } from '../src/policy/delegation.ts'
import type { App } from '../src/main.ts'
import { Client, json } from './api_harness.ts'
import { testSettings } from './harness.ts'
import { solidPng } from './png_fixture.ts'
import { enable, liveApp, liveRun, local, makeLink, openSession, Viewer } from './live_share_helpers.ts'
import { InlineProjector, type Projector } from '../src/share/live/projector.ts'
import { ProjectorCore } from '../src/share/live/projector_core.ts'
import { appShareSource } from '../src/share/snapshot.ts'

const apps: App[] = []
const viewers: Viewer[] = []
const cleanups: (() => void)[] = []
afterEach(async () => {
  for (const v of viewers.splice(0)) v.close()
  for (const f of cleanups.splice(0)) f()
  for (const a of apps.splice(0)) await a.close()
})
async function app(opts = {}, settings?: ReturnType<typeof testSettings>): Promise<App> { const a = await liveApp(opts, settings); apps.push(a); return a }
async function view(port: number, cap: string, read = true): Promise<Viewer> { const v = await Viewer.open(port, cap, read); viewers.push(v); return v }

const GH = 'ghp_' + 'L'.repeat(36)

test('settings: off by default, nothing listens after start; owner-only GET and PUT; a bad origin is refused', async () => {
  const a = await app()
  await a.start()
  const s = a.state.live_share!
  expect(s.listeningPort).toBeNull()
  expect(existsSync(join(a.state.settings.data_dir, 'live-share.json'))).toBe(false)
  const got = LiveShareSettingsResponseSchema.parse(await json(await local(a).get('/api/settings/live-share')))
  expect(got.settings).toEqual({ enabled: false, bind: 'loopback', port: 8325, public_base_url: null })
  expect(got.status.listening).toBe(false)
  // not this machine, a connector, a director surface, the agent's browser: refused, GET included
  expect((await new Client(a).get('/api/settings/live-share')).status).toBe(403)
  expect((await local(a).get('/api/settings/live-share', undefined, { 'x-oasis-code-connector': 'ChatGPT' })).status).toBe(403)
  expect((await local(a).get('/api/settings/live-share', undefined, { 'x-oasis-tool-surface': 'director.v6' })).status).toBe(403)
  expect((await local(a).put('/api/settings/live-share', { enabled: true, bind: 'loopback', port: 8325, public_base_url: 'https://x.example.com/path' })).status).toBe(422)
  expect((await local(a).put('/api/settings/live-share', { enabled: true, bind: 'loopback', port: 8325, public_base_url: null, extra: 1 })).status).toBe(422)
  const on = LiveShareSettingsResponseSchema.parse(await json(await local(a).put('/api/settings/live-share', { enabled: true, bind: 'loopback', port: 8325, public_base_url: 'https://Share.Example.com/' })))
  expect(on.settings.public_base_url).toBe('https://share.example.com')
  expect(on.status.listening).toBe(true)
  expect(on.status.address).toMatch(/^127\.0\.0\.1:\d+$/)
  const off = LiveShareSettingsResponseSchema.parse(await json(await local(a).put('/api/settings/live-share', { ...on.settings, enabled: false })))
  expect(off.status.listening).toBe(false)
})

test('links: create / list / reveal / revoke are the person\'s; the list never carries a capability; reveal gives the same one', async () => {
  const a = await app()
  const session = await openSession(a)
  const made = ShareLinkSecretResponseSchema.parse(await json(await local(a).post(`/api/sessions/${session.id}/share-links`, { label: ' demo  link ', include_tool_details: true, exclude_run_ids: ['run_b', 'run_a', 'run_b'] }), 201))
  expect(made.link.label).toBe('demo link')
  expect(made.link.options.exclude_run_ids).toEqual(['run_a', 'run_b'])
  expect(made.link.state).toBe('active')
  expect(made.url).toBe(`http://127.0.0.1:8325/live/#${made.capability}`)
  expect(made.capability).not.toContain('test-token')
  const listed = await local(a).get(`/api/sessions/${session.id}/share-links`)
  const text = await listed.text()
  expect(text).not.toContain(made.capability)
  expect(ShareLinkListResponseSchema.parse(JSON.parse(text)).links.map((l) => l.id)).toEqual([made.link.id])
  // only the hash is stored
  const row = a.state.conn.get('SELECT * FROM share_links WHERE id=?', [made.link.id])!
  expect(JSON.stringify(row)).not.toContain(made.capability)
  const again = ShareLinkSecretResponseSchema.parse(await json(await local(a).post(`/api/share-links/${made.link.id}/reveal`, {})))
  expect(again.capability).toBe(made.capability)
  // refused callers, every route
  for (const [method, path] of [['GET', `/api/sessions/${session.id}/share-links`], ['POST', `/api/sessions/${session.id}/share-links`], ['POST', `/api/share-links/${made.link.id}/reveal`], ['POST', `/api/share-links/${made.link.id}/revoke`]] as const) {
    expect((await new Client(a).request(method, path, { json: method === 'POST' ? {} : undefined })).status, `${method} ${path} remote`).toBe(403)
    for (const h of [{ 'x-oasis-code-connector': 'ChatGPT' }, { 'x-oasis-tool-surface': 'director.v6' }, { 'x-oasis-director-session-id': 'ds_x' }, { 'x-oasis-director-turn-id': 'dt_x' }] as Record<string, string>[]) {
      expect((await local(a).request(method, path, { json: method === 'POST' ? {} : undefined, headers: h })).status, `${method} ${path} ${JSON.stringify(h)}`).toBe(403)
    }
  }
  // an agent's GET reaches every other read; these routes refuse it themselves (agentRouteAllowed lets GETs through)
  expect(agentRouteAllowed('GET', `/api/sessions/${session.id}/share-links`)).toBe(true)
  expect(agentRouteAllowed('POST', `/api/share-links/${made.link.id}/reveal`)).toBe(false)
  // strict body, bounds
  expect((await local(a).post(`/api/sessions/${session.id}/share-links`, { expires_in_s: 10 })).status).toBe(422)
  expect((await local(a).post(`/api/sessions/${session.id}/share-links`, { capability: 'x' })).status).toBe(422)
  expect((await local(a).post('/api/sessions/s_nope/share-links', {})).status).toBe(404)
  const revoked = await json<{ link: { state: string; revoked_reason: string } }>(await local(a).post(`/api/share-links/${made.link.id}/revoke`, {}))
  expect(revoked.link).toMatchObject({ state: 'revoked', revoked_reason: 'revoked' })
  expect((await local(a).post(`/api/share-links/${made.link.id}/reveal`, {})).status).toBe(410)
})

test('the listener: five GET paths only; no app route, token route, query, upgrade, body, agent browser or cookie', async () => {
  const a = await app()
  const port = await enable(a)
  const session = await openSession(a)
  const link = await makeLink(a, session.id)
  const base = `http://127.0.0.1:${port}`
  const page = await fetch(`${base}/live/`, { headers: { cookie: 'oasis_code_session=test-token' } })
  expect(page.status).toBe(200)
  expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
  expect(page.headers.get('cache-control')).toBe('no-store')
  expect(page.headers.get('x-content-type-options')).toBe('nosniff')
  expect(page.headers.get('referrer-policy')).toBe('no-referrer')
  expect(page.headers.get('cross-origin-resource-policy')).toBe('same-origin')
  expect(page.headers.get('set-cookie')).toBeNull()
  expect(await page.text()).toContain('/live/assets/live-share.js')
  expect((await fetch(`${base}/live/assets/live-share.js`)).status).toBe(200)
  expect((await fetch(`${base}/live/assets/live-share.css`)).headers.get('content-type')).toContain('text/css')
  const notFound = ['/', '/live', '/live/index.html', '/api/sessions', '/api/auth/session?token=test-token', '/api/meta/build', '/mcp', '/live/assets/other.js', '/live/api/image/nope', '/%6Cive/', '/live/?x=1', `/live/api/stream?cap=${link.capability}`]
  for (const p of notFound) expect((await fetch(`${base}${p}`, { headers: { authorization: `Bearer ${link.capability}` } })).status, p).toBe(404)
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD']) expect((await fetch(`${base}/live/api/stream`, { method })).status, method).toBe(405)
  expect((await fetch(`${base}/live/api/stream`, { headers: { authorization: `Bearer ${link.capability}`, 'x-oasis-code-agent-browser': '1' } })).status).toBe(403)
  expect((await fetch(`${base}/live/api/stream`, { headers: { authorization: `Bearer ${link.capability}`, upgrade: 'websocket', connection: 'Upgrade' } })).status).toBe(403)
  // no capability, a wrong one, the app's session token, a cookie: unauthorized
  for (const h of [{}, { authorization: 'Bearer ' + 'A'.repeat(43) }, { authorization: 'Bearer test-token' }, { 'x-oasis-code-token': 'test-token' }, { cookie: 'oasis_code_session=test-token' }] as Record<string, string>[]) {
    const r = await fetch(`${base}/live/api/stream`, { headers: h })
    expect(r.status, JSON.stringify(h)).toBe(401)
    expect(await r.json()).toEqual({ error: 'unauthorized' })
  }
})

test('a request that throws gets the listener\'s fixed 503 over real TCP: no message, stack, path or error page; no viewer left behind; it keeps working', async () => {
  const a = await app()
  const port = await enable(a)
  const session = await openSession(a)
  const link = await makeLink(a, session.id)
  const base = `http://127.0.0.1:${port}`
  const service = a.state.live_share!
  const conn = a.state.conn
  const saved = conn.get.bind(conn)
  cleanups.push(() => { conn.get = saved })
  // the fault's own words: a synthetic marker (put together at run time) and this file's folder, as an error that
  // quotes what it was doing would
  const marker = ['LIVE', 'PUBLIC', 'FAULT', 'CANARY', 'k3'].join('_')
  const fault = () => new Error(`${marker} reading ${import.meta.dir}`)
  // what the server logs is kept here (and checked), not printed
  const logged: string[] = []
  const quiet = console.error
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')) }
  cleanups.push(() => { console.error = quiet })
  const fixed = async (path: string, r: Response) => {
    const text = await r.text()
    expect(r.status, path).toBe(503)
    expect(text, path).toBe('{"error":"unavailable"}')
    expect(r.headers.get('content-type'), path).toBe('application/json')
    expect(r.headers.get('cache-control'), path).toBe('no-store')
    expect(r.headers.get('x-content-type-options'), path).toBe('nosniff')
    expect(r.headers.get('referrer-policy'), path).toBe('no-referrer')
    expect(r.headers.get('cross-origin-resource-policy'), path).toBe('same-origin')
    expect(r.headers.get('x-frame-options'), path).toBe('DENY')
    expect(r.headers.get('content-security-policy'), path).toContain("default-src 'none'")
    for (const leak of [marker, import.meta.dir, 'service.ts', 'links.ts', '<!doctype', '<html', 'Internal Server Error', 'stack']) expect(text.toLowerCase().includes(leak.toLowerCase()), `${path}: ${leak}`).toBe(false)
  }

  // 1. the capability's lookup fails (a database read): the stream and a picture alike
  conn.get = ((sql: string, params?: unknown[]) => {
    if (sql.includes('capability_hash')) throw fault()
    return saved(sql, params as never)
  }) as typeof conn.get
  for (const path of ['/live/api/stream', `/live/api/image/m${'0'.repeat(24)}`]) await fixed(path, await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${link.capability}` } }))
  expect(service.status().viewers).toBe(0)

  // 2. a fault after the viewer was counted (the link read again before the first state goes out): answered the same,
  // and the viewer it had begun is not left behind
  conn.get = saved
  const first = await view(port, link.capability)
  await first.until((v) => v.states().length > 0)
  expect(service.status().viewers).toBe(1)
  let reads = 0
  conn.get = ((sql: string, params?: unknown[]) => {
    if (sql.startsWith('SELECT * FROM share_links WHERE id=') && ++reads === 2) throw fault()
    return saved(sql, params as never)
  }) as typeof conn.get
  await fixed('/live/api/stream (after attach)', await fetch(`${base}/live/api/stream`, { headers: { authorization: `Bearer ${link.capability}` } }))
  expect(reads).toBeGreaterThanOrEqual(2)
  expect(service.status().viewers).toBe(1)

  // the faults are in this machine's log only, each under a reference the viewer was never told
  expect(logged.filter((l) => l.includes(marker) && /live share: internal error err_[0-9a-f]{8} on GET \/live\/api\//.test(l)).length).toBe(3)
  // the listener goes on: the fault gone, the same link streams again; the first viewer was never disturbed
  conn.get = saved
  const again = await view(port, link.capability)
  await again.until((v) => v.states().length > 0)
  expect(first.ended).toBe(false)
  expect((await fetch(`${base}/live/`)).status).toBe(200)
})

test('a viewer whose link cannot be read while a state is broadcast (the first one, a later one) is cut alone over real TCP: nothing leaks, no count left, the others get it, it recovers', async () => {
  // the projection held until the viewers are connected, so the FIRST state goes out from a build (a timer's work,
  // outside any request), not from a connect
  let held = true
  let release: (() => void) | null = null
  let state: App['state'] | null = null
  const inner = new InlineProjector(() => new ProjectorCore(appShareSource(state!)))
  const gated: Projector = {
    kind: 'inline',
    get builds() { return inner.builds },
    async project(req) { if (held) await new Promise<void>((r) => { release = r }); return inner.project(req) },
    image: (req) => inner.image(req),
    close: () => inner.close(),
  }
  const a = await app({ projector: gated })
  state = a.state
  const port = await enable(a)
  const service = a.state.live_share!
  const session = await openSession(a)
  // two links of the same projection: `bad` is the one whose row cannot be read; `good` is another's
  const bad = await makeLink(a, session.id)
  const good = await makeLink(a, session.id)
  const conn = a.state.conn
  const saved = conn.get.bind(conn)
  cleanups.push(() => { conn.get = saved })
  const marker = ['LIVE', 'BROADCAST', 'FAULT', 'CANARY', 'm5'].join('_')
  let failing: string | null = null
  conn.get = ((sql: string, params?: unknown[]) => {
    if (failing !== null && sql.startsWith('SELECT * FROM share_links WHERE id=') && params?.[0] === failing) throw new Error(`${marker} reading ${import.meta.dir}`)
    return saved(sql, params as never)
  }) as typeof conn.get
  // the server's log is kept here (and checked), not printed; an unhandled rejection is caught to be counted
  const logged: string[] = []
  const quiet = console.error
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')) }
  cleanups.push(() => { console.error = quiet })
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
  process.on('unhandledRejection', onUnhandled)
  cleanups.push(() => { process.off('unhandledRejection', onUnhandled) })

  // 1. the first broadcast: the failing viewer first in the projection's order, then another. Both connect while the
  // projection is held (an event stream's head goes out with its first bytes, so neither answer has come yet): what
  // the failing one receives is read whole, whatever it is
  const a1Got = fetch(`http://127.0.0.1:${port}/live/api/stream`, { headers: { authorization: `Bearer ${bad.capability}` } })
    .then(async (r) => ({ status: r.status, type: r.headers.get('content-type'), body: await r.text().catch(() => '') }), () => ({ status: 0, type: null, body: '' }))
  const bOpen = view(port, good.capability)
  for (let i = 0; (release === null || service.status().viewers < 2) && i < 400; i++) await Bun.sleep(5)
  expect(release).not.toBeNull()
  expect(service.status().viewers).toBe(2)
  failing = bad.id
  held = false
  release!()
  const b = await bOpen
  await b.until((v) => v.states().length >= 1)
  const a1 = await a1Got
  // cut: not one byte (the stream's head, then its end), or the connection closed; never a state, never a message
  if (a1.status !== 0) expect([a1.status, a1.type, a1.body]).toEqual([200, 'text/event-stream; charset=utf-8', ''])
  expect(service.status().viewers).toBe(1)

  // 2. a later broadcast (a run's new words): the failing viewer between two others
  failing = null
  const a2 = await view(port, bad.capability)
  await a2.until((v) => v.states().length >= 1)
  const c = await view(port, good.capability)
  await c.until((v) => v.states().length >= 1)
  expect(service.status().viewers).toBe(3)
  failing = bad.id
  const run = liveRun(a, session, 'Alice, tell Bob')
  cleanups.push(() => run.drop())
  const words = ['Bob', 'sees', 'the', 'update', 'q9'].join(' ')
  run.emit('run_started', {})
  run.emit('text_block', { text: words })
  await b.until((v) => JSON.stringify(v.last()).includes(words))
  await c.until((v) => JSON.stringify(v.last()).includes(words))
  await a2.until((v) => v.ended)
  expect(JSON.stringify(a2.frames)).not.toContain(words)
  expect(service.status().viewers).toBe(2)

  // nothing of the fault reached any viewer; it is in this machine's log only, once per broadcast; nothing unhandled
  for (const seen of [a1.body, ...[a2, b, c].map((v) => JSON.stringify(v.frames) + v.body)]) {
    expect(seen).not.toContain(marker)
    expect(seen).not.toContain(import.meta.dir)
  }
  expect(logged.filter((l) => l.includes(marker) && /live share: internal error err_[0-9a-f]{8} on GET \/live\/api\/stream \(broadcast\)/.test(l)).length).toBe(2)
  expect(unhandled).toEqual([])

  // 3. the read works again: the same link reconnects and gets the latest state at once (the one its cut send missed)
  failing = null
  const a3 = await view(port, bad.capability)
  await a3.until((v) => JSON.stringify(v.last()).includes(words))
  expect(service.status().viewers).toBe(3)
  expect(b.ended || c.ended).toBe(false)
})

test('the stream: a whole safe state at once, an active run and its open answer sanitized, coalesced revisions, no revision without change', async () => {
  const a = await app()
  const port = await enable(a)
  const session = await openSession(a)
  const run = liveRun(a, session, `use ${GH} here`)
  cleanups.push(() => run.drop())
  run.emit('run_started', {})
  run.emit('text_delta', { text: 'Working on it.\nThe token ', start: true })
  const link = await makeLink(a, session.id)
  const v = await view(port, link.capability)
  await v.until((x) => x.states().length >= 1)
  const first = v.last()!
  expect(first.snapshot.format).toBe('oasis-code.session-live')
  expect(first.snapshot.session.active).toBe(true)
  expect(first.snapshot.runs[0]!.status).toBe('running')
  const open = first.snapshot.items.find((i) => i.kind === 'message_open')
  expect(open).toMatchObject({ kind: 'message_open', text: 'Working on it.\n', withheld_tail: true })
  expect(JSON.stringify(first)).not.toContain(GH)
  // more words: one coalesced revision; the secret completed on its line is masked
  run.emit('text_delta', { text: `is ${GH}\nnext ` })
  run.emit('text_delta', { text: 'line\n' })
  await v.until((x) => (x.last()?.revision ?? 0) > first.revision && JSON.stringify(x.last()).includes('next line'))
  expect(JSON.stringify(v.last())).not.toContain(GH)
  // a tool call in flight: complete call only, status running; progress never shown
  run.emit('tool_call_progress', { tool: 'write_file', tool_call_id: 'tc_1', chars: 10, path: 'secrets/forming.env' })
  run.emit('text_block', { text: 'done talking' })
  run.emit('tool_call', { tool: 'read_file', tool_call_id: 'tc_2', path: 'src/app.ts', summary: '{}' })
  await v.until((x) => x.last()!.snapshot.items.some((i) => i.kind === 'tool' && i.status === 'running'))
  expect(JSON.stringify(v.last())).not.toContain('forming.env')
  expect(v.last()!.snapshot.items.some((i) => i.kind === 'message_open')).toBe(false)
  // nothing changes: the poll keeps reading, no new revision is sent
  const quiet = v.states().length
  await Bun.sleep(250)
  expect(v.states().length).toBe(quiet)
  // a title change (not on the run hub) is seen by the fingerprint
  a.state.conn.run('UPDATE sessions SET title=?, updated_at=? WHERE id=?', ['Renamed live demo', new Date().toISOString(), session.id])
  await v.until((x) => x.last()!.snapshot.title === 'Renamed live demo')
  // every state passed the strict schema (Viewer.states parses each)
  expect(v.states().every((s) => s.epoch === first.epoch)).toBe(true)
})

test('a tool call whose event metadata may be cut is withheld; a sensitive one is withheld', async () => {
  const a = await app()
  const port = await enable(a)
  const session = await openSession(a)
  const run = liveRun(a, session)
  cleanups.push(() => run.drop())
  run.emit('tool_call', { tool: 'bash', tool_call_id: 'tc_cut', command: 'echo ' + 'x'.repeat(295), summary: '' })
  run.emit('tool_call', { tool: 'read_file', tool_call_id: 'tc_env', path: '.env', summary: '' })
  const link = await makeLink(a, session.id, { include_tool_details: true })
  const v = await view(port, link.capability)
  await v.until((x) => x.states().length >= 1)
  const tools = v.last()!.snapshot.items.filter((i) => i.kind === 'tool')
  expect(tools.map((t) => t.kind === 'tool' && t.withheld)).toEqual(['sensitive_source', 'sensitive_source'])
  expect(JSON.stringify(tools)).not.toContain('xxxxxxxxxx')
})

test('revoke while open: the stream ends `revoked` and nothing more comes; a new connect is 410', async () => {
  const a = await app()
  const port = await enable(a)
  const session = await openSession(a)
  const link = await makeLink(a, session.id)
  const v = await view(port, link.capability)
  await v.until((x) => x.states().length >= 1)
  await json(await local(a).post(`/api/share-links/${link.id}/revoke`, {}))
  await v.until((x) => x.ended)
  expect(v.endedWith()).toBe('revoked')
  const after = await view(port, link.capability)
  expect(after.status).toBe(410)
  expect(JSON.parse(after.body)).toEqual({ error: 'gone', reason: 'revoked' })
})

test('expiry while open ends the stream by itself, on time', async () => {
  const a = await app()
  const port = await enable(a)
  const session = await openSession(a)
  const link = await makeLink(a, session.id)
  // the shortest a link may live is minutes: the row is moved to expire in a moment (what the timer reads)
  a.state.conn.run('UPDATE share_links SET expires_at=? WHERE id=?', [new Date(Date.now() + 400).toISOString(), link.id])
  const v = await view(port, link.capability)
  await v.until((x) => x.states().length >= 1)
  await v.until((x) => x.ended, 3000)
  expect(v.endedWith()).toBe('expired')
  expect((await view(port, link.capability)).status).toBe(410)
})

test('session deleted: its streams end `session_deleted`, its links are revoked; the listener off ends streams `disabled`', async () => {
  const a = await app()
  const port = await enable(a)
  const one = await openSession(a, 'One')
  const two = await openSession(a, 'Two')
  const l1 = await makeLink(a, one.id)
  const l2 = await makeLink(a, two.id)
  const v1 = await view(port, l1.capability)
  const v2 = await view(port, l2.capability)
  await v1.until((x) => x.states().length >= 1)
  await v2.until((x) => x.states().length >= 1)
  // cross-session: each sees its own
  expect(v1.last()!.snapshot.title).toBe('One')
  expect(v2.last()!.snapshot.title).toBe('Two')
  expect((await new Client(a).delete(`/api/sessions/${one.id}`)).status).toBe(200)
  await v1.until((x) => x.ended)
  expect(v1.endedWith()).toBe('session_deleted')
  expect(a.state.conn.get('SELECT revoked_reason FROM share_links WHERE id=?', [l1.id])!.revoked_reason).toBe('session_deleted')
  expect(v2.ended).toBe(false)
  await json(await local(a).put('/api/settings/live-share', { enabled: false, bind: 'loopback', port: 8325, public_base_url: null }))
  await v2.until((x) => x.ended)
  expect(v2.endedWith()).toBe('disabled')
  await expect(fetch(`http://127.0.0.1:${port}/live/`)).rejects.toThrow()
})

test('one producer per projection: 1 viewer and 20 viewers cost the same builds; other options are another projection', async () => {
  const counts: number[] = []
  for (const n of [1, 20]) {
    const a = await app()
    const port = await enable(a)
    const session = await openSession(a)
    const links = [await makeLink(a, session.id), await makeLink(a, session.id)]
    const vs: Viewer[] = []
    for (let i = 0; i < n; i++) vs.push(await view(port, links[i % 2]!.capability))
    for (const v of vs) await v.until((x) => x.states().length >= 1)
    expect(a.state.live_share!.producerCount).toBe(1)
    const before = a.state.live_share!.builds
    for (let k = 0; k < 5; k++) {
      a.state.conn.run('UPDATE sessions SET title=?, updated_at=? WHERE id=?', [`Title ${k}`, new Date().toISOString(), session.id])
      await Promise.all(vs.map((v) => v.until((x) => x.last()!.snapshot.title === `Title ${k}`)))
    }
    counts.push(a.state.live_share!.builds - before)
    // every viewer of the projection holds the same bytes of the same revision
    expect(new Set(vs.map((v) => `${v.last()!.epoch}.${v.last()!.revision}`)).size).toBe(1)
    const other = await makeLink(a, session.id, { include_tool_details: true })
    const ov = await view(port, other.capability)
    await ov.until((x) => x.states().length >= 1)
    expect(a.state.live_share!.producerCount).toBe(2)
    expect(ov.last()!.snapshot.options.include_tool_details).toBe(true)
    for (const v of vs) v.close()
    ov.close()
    await a.close()
    apps.splice(apps.indexOf(a), 1)
  }
  expect(counts[1]).toBe(counts[0])
})

test('a slow viewer holds one pending state, is closed when it stalls, and does not hold back the others', async () => {
  const a = await app({ stall_ms: 300 })
  const port = await enable(a)
  const session = await openSession(a)
  // a big state (about 3 MB of answers) so a viewer that does not read fills its connection
  for (let r = 0; r < 20; r++) {
    const run = repo.insertRun(a.state.conn, { session_id: session.id, project_id: session.project_id, workspace_id: session.workspace_id, model: 'scripted:a', model_config: {}, user_text: `q${r}`, status: 'running', budget: {}, resumes_run_id: null, attachments: [] as never, spawned_by: 'human', relay_id: null, relay_step: null })
    repo.insertEvent(a.state.conn, run.id, 1, 'text_block', { text: `answer ${r} ` + 'w'.repeat(150_000) })
    repo.finishRun(a.state.conn, run.id, 'done', { history_json: null, usage: {}, error: null, receipt: {}, saved_seq: 1 })
  }
  const link = await makeLink(a, session.id)
  const slow = await view(port, link.capability, false)
  const fast = await view(port, link.capability)
  await fast.until((x) => x.states().length >= 1, 10_000)
  for (let k = 0; k < 4; k++) {
    a.state.conn.run('UPDATE sessions SET title=?, updated_at=? WHERE id=?', [`Big ${k}`, new Date().toISOString(), session.id])
    await fast.until((x) => x.last()!.snapshot.title === `Big ${k}`, 10_000)
  }
  const svc = a.state.live_share! as unknown as { viewersByLink: Map<string, Set<{ pending: unknown[] | null; closed: boolean }>> }
  for (const v of svc.viewersByLink.get(link.id) ?? []) if (v.pending !== null) expect(v.pending.length).toBe(3)   // one frame: head, shared snapshot, tail
  await Bun.sleep(400)
  a.state.live_share!.sweepNow()
  // the stalled one is gone from the service; the reading one is still there
  expect([...(svc.viewersByLink.get(link.id) ?? [])].length).toBe(1)
  expect(fast.ended).toBe(false)
})

test('images: stripped bytes by an opaque resource of the current projection only; a guess never starts a projection', async () => {
  const a = await app()
  const port = await enable(a)
  const session = await openSession(a)
  const marker = 'SYNTH-' + 'IMGMARKER'
  const png = solidPng(6, 4, [9, 99, 199])
  // a tEXt chunk with the marker before IEND
  const text = new TextEncoder().encode(`Comment\0${marker}`)
  const chunk = new Uint8Array(12 + text.length)
  const view_ = new DataView(chunk.buffer)
  view_.setUint32(0, text.length); chunk.set(new TextEncoder().encode('tEXt'), 4); chunk.set(text, 8)
  view_.setUint32(8 + text.length, Bun.hash.crc32(chunk.subarray(4, 8 + text.length)) >>> 0)
  const dirty = new Uint8Array(png.length + chunk.length)
  dirty.set(png.subarray(0, png.length - 12)); dirty.set(chunk, png.length - 12); dirty.set(png.subarray(png.length - 12), png.length - 12 + chunk.length)
  const att = saveAttachment(a.state, session, dirty, 'shot.png')
  const run = repo.insertRun(a.state.conn, { session_id: session.id, project_id: session.project_id, workspace_id: session.workspace_id, model: 'scripted:a', model_config: {}, user_text: 'look', status: 'running', budget: {}, resumes_run_id: null, attachments: [att] as never, spawned_by: 'human', relay_id: null, relay_step: null })
  repo.finishRun(a.state.conn, run.id, 'done', { history_json: null, usage: {}, error: null, receipt: {}, saved_seq: 0 })
  const withImages = await makeLink(a, session.id, { include_images: true })
  const without = await makeLink(a, session.id)
  const base = `http://127.0.0.1:${port}/live/api/image/`
  // before anyone watches: no projection, a guess is 404 and starts nothing
  expect((await fetch(`${base}m${'0'.repeat(24)}`, { headers: { authorization: `Bearer ${withImages.capability}` } })).status).toBe(404)
  expect(a.state.live_share!.producerCount).toBe(0)
  const v = await view(port, withImages.capability)
  await v.until((x) => x.states().length >= 1)
  const snap = v.last()!.snapshot
  expect(snap.images.length).toBe(1)
  const ref = snap.images[0]!
  expect(snap.items.find((i) => i.kind === 'image')).toMatchObject({ image: ref.resource, omitted: null })
  expect(JSON.stringify(snap)).not.toContain(att.asset_id)
  const res = await fetch(base + ref.resource, { headers: { authorization: `Bearer ${withImages.capability}` } })
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toBe('image/png')
  expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  const bytes = new Uint8Array(await res.arrayBuffer())
  expect(bytes.length).toBe(ref.bytes)
  expect(Buffer.from(bytes).toString('latin1')).not.toContain(marker)
  // the same resource through a link of other options (no images, not watched) is not served; nor without a capability
  expect((await fetch(base + ref.resource, { headers: { authorization: `Bearer ${without.capability}` } })).status).toBe(404)
  expect((await fetch(base + ref.resource)).status).toBe(401)
  // without images the item says images_off
  const v2 = await view(port, without.capability)
  await v2.until((x) => x.states().length >= 1)
  expect(v2.last()!.snapshot.items.find((i) => i.kind === 'image')).toMatchObject({ image: null, omitted: 'images_off' })
  expect(v2.last()!.snapshot.images).toEqual([])
  // revoked: the image route answers 410 at once
  await json(await local(a).post(`/api/share-links/${withImages.id}/revoke`, {}))
  expect((await fetch(base + ref.resource, { headers: { authorization: `Bearer ${withImages.capability}` } })).status).toBe(410)
})

test('restart: a link is copied again and works; a new epoch; a revoked link stays revoked; the listener comes back on start', async () => {
  const settings = testSettings()
  const a = await app({}, settings)
  await enable(a)
  const session = await openSession(a)
  const keep = await makeLink(a, session.id)
  const gone = await makeLink(a, session.id)
  await json(await local(a).post(`/api/share-links/${gone.id}/revoke`, {}))
  const port1 = a.state.live_share!.listeningPort!
  const v = await view(port1, keep.capability)
  await v.until((x) => x.states().length >= 1)
  const epoch1 = v.last()!.epoch
  await a.close()
  apps.splice(apps.indexOf(a), 1)
  expect(v.endedWith() ?? 'closed').toMatch(/server_closing|closed/)

  const b = await app({}, settings)
  expect(b.state.live_share!.listeningPort).toBeNull()      // nothing binds before start
  await b.start()
  const port2 = b.state.live_share!.listeningPort!
  expect(port2).not.toBeNull()
  const again = ShareLinkSecretResponseSchema.parse(await json(await local(b).post(`/api/share-links/${keep.id}/reveal`, {})))
  expect(again.capability).toBe(keep.capability)
  const w = await view(port2, keep.capability)
  await w.until((x) => x.states().length >= 1)
  expect(w.last()!.epoch).not.toBe(epoch1)
  expect((await view(port2, gone.capability)).status).toBe(410)
})

test('the worker projector: same safe state off the event loop; stopped when nothing is watched', async () => {
  const a = await app({ projector: 'worker' })
  const port = await enable(a)
  const session = await openSession(a)
  const run = liveRun(a, session)
  cleanups.push(() => run.drop())
  run.emit('text_delta', { text: `Line one\nsecret ${GH}\n`, start: true })
  const link = await makeLink(a, session.id)
  expect(a.state.live_share!.projectorKind).toBe('worker')
  const v = await view(port, link.capability)
  await v.until((x) => x.states().length >= 1, 15_000)
  const open = v.last()!.snapshot.items.find((i) => i.kind === 'message_open')
  expect(open && open.kind === 'message_open' && open.text.startsWith('Line one\n')).toBe(true)
  expect(JSON.stringify(v.last())).not.toContain(GH)
  expect(JSON.stringify(v.last())).not.toContain('test-token')
  v.close()
  await Bun.sleep(300)
  const proj = (a.state.live_share! as unknown as { projector: { running: boolean } }).projector
  expect(a.state.live_share!.producerCount).toBe(0)
  expect(proj.running).toBe(false)
})

test('a live bash whose sensitive part lies past the event cut: the call AND the polling of its output are withheld in every state', async () => {
  const a = await app()
  const port = await enable(a)
  const session = await openSession(a)
  const run = liveRun(a, session)
  cleanups.push(() => run.drop())
  const marker = 'POLLED-' + 'OUTPUT-MARKER-' + 'q'.repeat(8)
  const link = await makeLink(a, session.id, { include_tool_details: true })
  const v = await view(port, link.capability)
  await v.until((x) => x.states().length >= 1)
  // the event keeps the first 300 characters of the command (toolCallMetadata): the `cat .env` after them is cut away
  const whole = 'echo ' + 'a'.repeat(300) + ' && cat .env'
  run.emit('tool_call', { tool: 'bash', tool_call_id: 'tc_long', command: whole.slice(0, 300), summary: '' })
  run.emit('tool_result', { tool: 'bash', tool_call_id: 'tc_long', status: 'running', execution_id: 'x_000000000001', summary: 'running' })
  run.emit('tool_call', { tool: 'bash_output', tool_call_id: 'tc_poll', execution_id: 'x_000000000001', summary: '' })
  run.emit('tool_result', { tool: 'bash_output', tool_call_id: 'tc_poll', status: 'ok', execution_id: 'x_000000000001', stdout: marker, summary: marker })
  // a read with no metadata at all (its call event missing): what it read cannot be classified
  run.emit('tool_result', { tool: 'read_file', tool_call_id: 'tc_blind', status: 'ok', summary: marker })
  await v.until((x) => x.last()!.snapshot.items.filter((i) => i.kind === 'tool').length === 3)
  for (const s of v.states()) expect(JSON.stringify(s)).not.toContain(marker)
  const tools = v.last()!.snapshot.items.filter((i) => i.kind === 'tool')
  expect(tools.map((t) => t.kind === 'tool' && [t.name, t.withheld])).toEqual([['bash', 'sensitive_source'], ['bash_output', 'sensitive_source'], ['read_file', 'sensitive_source']])
})

test('reconnect within the idle retention after words that change no record: the latest state still comes', async () => {
  const a = await app({ idle_ms: 2000 })
  const port = await enable(a)
  const session = await openSession(a)
  const run = liveRun(a, session)
  cleanups.push(() => run.drop())
  run.emit('text_delta', { text: 'first line\n', start: true })
  const link = await makeLink(a, session.id)
  const v = await view(port, link.capability)
  await v.until((x) => JSON.stringify(x.last()).includes('first line'))
  v.close()
  await Bun.sleep(100)
  expect(a.state.live_share!.producerCount).toBe(1)          // kept for the retention
  run.emit('text_delta', { text: 'second line\n' })           // a transient delta while nobody watches
  const w = await view(port, link.capability)
  await w.until((x) => JSON.stringify(x.last()).includes('second line'))
})

test('the lifecycle is one step at a time: enable/disable interleaved ends as the last one asked; two enables bind once; nothing reopens after close', async () => {
  const a = await app()
  const s = a.state.live_share!
  const on = { enabled: true, bind: 'loopback' as const, port: 8325, public_base_url: null }
  const off = { ...on, enabled: false }
  await Promise.all([s.applySettings(on), s.applySettings(off)])
  expect(s.status().listening).toBe(false)
  expect(s.getSettings().enabled).toBe(false)
  await Promise.all([s.applySettings(off), s.applySettings(on)])
  expect(s.status().listening).toBe(true)
  const port = s.listeningPort
  await Promise.all([s.applySettings(on), s.applySettings(on)])
  expect(s.status().listening).toBe(true)
  expect(s.status().error).toBeNull()
  expect(s.listeningPort).not.toBe(null)
  expect(port).not.toBeNull()
  const closing = s.close()
  await expect(s.applySettings(on)).rejects.toThrow()
  await closing
  await s.start()
  expect(s.status().listening).toBe(false)
})

test('the share key: a missing or damaged key never rekeys active links; the person revokes them, then new links work', async () => {
  const a = await app()
  const port = await enable(a)
  const session = await openSession(a)
  const old = await makeLink(a, session.id)
  const keyPath = join(a.state.settings.data_dir, 'live-share-key')
  for (const damage of ['missing', 'damaged'] as const) {
    if (damage === 'missing') (await import('node:fs')).rmSync(keyPath)
    else (await import('node:fs')).writeFileSync(keyPath, 'not-a-key\n')
    expect((await local(a).post(`/api/sessions/${session.id}/share-links`, {})).status, damage).toBe(409)
    expect((await local(a).post(`/api/share-links/${old.id}/reveal`, {})).status, damage).toBe(410)
    expect((await view(port, old.capability)).status, damage).toBe(401)
  }
  await json(await local(a).post(`/api/share-links/${old.id}/revoke`, {}))
  const fresh = await makeLink(a, session.id)
  expect(fresh.capability).not.toBe(old.capability)
  const v = await view(port, fresh.capability)
  await v.until((x) => x.states().length >= 1)
})
