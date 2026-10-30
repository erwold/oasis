/** The live link's owner side, pure (src/state/liveShare.ts): expiries inside the contract's bounds, the canonical
 *  create request, a link's line, the listener's state, the public URL check, the runs offered, the errors in the
 *  person's words; the dialog's store selectors allocate nothing; and the viewer builds' network guard
 *  (vite.share-plugins.ts): the offline file's script holds no network call site, the live page's exactly one fetch. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { LIVE_SHARE_DEFAULT_SETTINGS, LIVE_SHARE_LIMITS, ShareLinkCreateRequestSchema, type ShareLink } from '@oasis-code/contract'
import {
  customExpiry, DEFAULT_EXPIRY, EXPIRY_CHOICES, expirySeconds, linkOptionsLine, linkRequest, linkTimeLine, liveRunChoices, liveShareError, publicBaseUrl, serviceState,
} from '../src/state/liveShare.ts'
import { ApiError } from '../src/api/client.ts'
import { networkCallSites, networkReferences } from '../vite.share-plugins.ts'
import type { Run } from '../src/api/types.ts'

const link = (over: Partial<ShareLink> = {}): ShareLink => ({
  id: `sl_${'A'.repeat(22)}`, session_id: 's1', label: '', options: { include_tool_details: false, include_images: false, exclude_run_ids: [] },
  created_at: '2026-10-22T00:00:00.000Z', expires_at: '2026-10-23T00:00:00.000Z', revoked_at: null, revoked_reason: null, state: 'active', viewers: 0, ...over,
})

test('expiries: the five convenient ones (one day the default), a custom one only inside 5 minutes … 30 days', () => {
  assert.deepEqual(EXPIRY_CHOICES.map((c) => c.seconds), [300, 3600, 86400, 604800, 2592000, null])
  assert.equal(DEFAULT_EXPIRY, '86400')
  assert.equal(expirySeconds(DEFAULT_EXPIRY, 0, 'minutes'), LIVE_SHARE_LIMITS.default_expiry_s)
  assert.equal(customExpiry(5, 'minutes'), 300)
  assert.equal(customExpiry(4, 'minutes'), null)
  assert.equal(customExpiry(30, 'days'), 2592000)
  assert.equal(customExpiry(31, 'days'), null)
  assert.equal(customExpiry(Number.NaN, 'hours'), null)
  assert.equal(expirySeconds('custom', 2, 'hours'), 7200)
  assert.equal(expirySeconds('nonsense', 2, 'hours'), null)
})

test('the create request is canonical (ids sorted, once) and passes the strict schema', () => {
  const body = linkRequest({ tools: true, images: false, excluded: ['run_b', 'run_a', 'run_b'] }, 3600)
  assert.deepEqual(body, { label: '', expires_in_s: 3600, include_tool_details: true, include_images: false, exclude_run_ids: ['run_a', 'run_b'] })
  assert.deepEqual(ShareLinkCreateRequestSchema.parse(body), body)
})

test('a link in a line: its options, its time left or how it ended', () => {
  assert.equal(linkOptionsLine(link()), 'text only')
  assert.equal(linkOptionsLine(link({ options: { include_tool_details: true, include_images: true, exclude_run_ids: ['run_a', 'run_b'] } })), 'tool details · images · 2 runs left out')
  // a task's link (v2) says so first, with how many of its sessions are there now
  assert.equal(linkOptionsLine({ ...link(), scope: 'task', members: 3 }), 'all sessions (3)')
  assert.equal(linkOptionsLine({ ...link({ options: { include_tool_details: true, include_images: false, exclude_run_ids: [] } }), scope: 'task', members: 0 }), 'all sessions · tool details')
  assert.equal(linkOptionsLine({ ...link(), scope: 'session', members: 1 }), 'text only')
  const now = Date.parse('2026-10-22T00:00:00.000Z')
  assert.equal(linkTimeLine(link(), now), '24 h left')
  assert.equal(linkTimeLine(link({ expires_at: '2026-10-22T00:10:00.000Z' }), now), '10 min left')
  assert.equal(linkTimeLine(link({ expires_at: '2026-10-29T00:00:00.000Z' }), now), '7 days left')
  assert.equal(linkTimeLine(link({ state: 'expired' }), now), 'expired')
  assert.equal(linkTimeLine(link({ state: 'revoked', revoked_reason: 'revoked' }), now), 'revoked')
  assert.equal(linkTimeLine(link({ state: 'revoked', revoked_reason: 'session_deleted' }), now), 'session deleted')
})

test('the listener: off by default; on, its address; an error, its words; the viewer not built said so', () => {
  const status = { listening: false, address: null, error: null, viewers: 0, viewer_built: true }
  assert.equal(serviceState(LIVE_SHARE_DEFAULT_SETTINGS, status).kind, 'off')
  const on = { ...LIVE_SHARE_DEFAULT_SETTINGS, enabled: true }
  assert.deepEqual(serviceState(on, { ...status, listening: true, address: '127.0.0.1:8325', viewers: 2 }), { kind: 'listening', line: 'On · 127.0.0.1:8325 · 2 viewing' })
  assert.deepEqual(serviceState(on, { ...status, error: 'port 8325 is taken' }), { kind: 'error', line: 'port 8325 is taken' })
  assert.equal(serviceState(on, { ...status, viewer_built: false }).kind, 'unbuilt')
})

test('a public URL is an http(s) origin and nothing more', () => {
  assert.equal(publicBaseUrl(''), null)
  assert.equal(publicBaseUrl('  https://share.example.com/ '), 'https://share.example.com')
  assert.equal(publicBaseUrl('http://192.168.1.20:8325'), 'http://192.168.1.20:8325')
  for (const bad of ['share.example.com', 'ftp://x.example', 'https://x.example/live', 'https://u:p@x.example', 'https://x.example/?a=1', 'https://x.example/#k', 'javascript:alert(1)']) {
    assert.equal(publicBaseUrl(bad), undefined, bad)
  }
})

test('the runs offered: the session\'s own, never an action\'s, by their label or first words', () => {
  const r = (over: Partial<Run>) => ({ id: 'run_a', session_id: 's1', label: null, user_text: '', model: 'm', status: 'done', spawned_by: 'human', ...over }) as Run
  assert.deepEqual(liveRunChoices([
    r({ id: 'run_a', label: 'Named' }), r({ id: 'run_b', user_text: '\n  first words\nmore' }), r({ id: 'run_c', spawned_by: 'human_action' }), r({ id: 'run_d', session_id: 's2' }),
  ], 's1'), [{ run_id: 'run_a', label: 'Named', status: 'done' }, { run_id: 'run_b', label: 'first words', status: 'done' }])
})

test('errors in the person\'s words: the harness\'s own code first, then its status', () => {
  assert.match(liveShareError(new ApiError(409, 'x', { code: 'share_link_limit' })), /20 active links/)
  assert.match(liveShareError(new ApiError(410, 'x', { code: 'share_link_inactive' })), /no longer active/)
  assert.match(liveShareError(new ApiError(403, 'x', { code: 'share_owner_only' })), /app itself/)
  assert.equal(liveShareError(new ApiError(404, 'Not Found', null), 'nope'), 'nope')
  assert.equal(liveShareError(new ApiError(422, 'public_base_url must be an origin', null)), 'Not accepted: public_base_url must be an origin')
  assert.equal(liveShareError(new ApiError(500, 'x', null)), 'The app refused (500).')
})

/** Every `useStore(...)` selector of the files the live share added or changed: a plain read of the store (a field, or
 *  a field of a field) — never a new array or object per call (a filter, a map, a literal), which would draw again on
 *  every change of the store. */
test('the share dialog\'s and the header\'s store selectors read a field; none allocates', () => {
  for (const rel of ['../src/components/ShareLivePanel.tsx', '../src/components/ShareDialog.tsx', '../src/components/LiveShareSettings.tsx', '../src/components/Thread.tsx']) {
    const file = fileURLToPath(new URL(rel, import.meta.url))
    const src = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const bad: string[] = []
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'useStore' && node.arguments.length === 1) {
        const f = node.arguments[0]!
        let ok = false
        if (ts.isArrowFunction(f) && !ts.isBlock(f.body)) {
          // s.a, s.a.b, s.a?.b, s.a[k] — each a read of what the store holds
          const plain = (e: ts.Expression): boolean => ts.isIdentifier(e) || ((ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) && plain(e.expression)) || (ts.isNonNullExpression(e) && plain(e.expression))
          ok = plain(f.body as ts.Expression)
        }
        if (!ok) bad.push(node.getText(src).slice(0, 100))
      }
      ts.forEachChild(node, visit)
    }
    visit(src)
    assert.deepEqual(bad, [], rel)
  }
})

test('the builds\' network guard: call sites by syntax tree, and any network API named outside a call', () => {
  assert.deepEqual(networkCallSites('fetch("/x"); this.fetch(); new WebSocket("w"); navigator.sendBeacon("/b"); import("./m.js")'), ['fetch()', 'new WebSocket', 'navigator.sendBeacon()', 'import()'])
  assert.deepEqual(networkReferences('const f = fetch; f("/x")'), ['fetch'])
  assert.deepEqual(networkReferences('globalThis["fetch"]("/x")'), ['[fetch]'])
  assert.deepEqual(networkReferences('const o = { fetch: 1 }; o.fetch; this.fetch(); fetch("/a"); window.fetch("/b")'), [])
})

const OFFLINE_JS = fileURLToPath(new URL('../share-viewer-dist/share-viewer.js', import.meta.url))
const LIVE_JS = fileURLToPath(new URL('../live-share-dist/live-share.js', import.meta.url))
test('the built bundles (when built): the offline file\'s script holds no network call site; the live page\'s exactly one fetch and no other', { skip: !existsSync(OFFLINE_JS) || !existsSync(LIVE_JS) ? 'run npm run build:share and npm run build:live-share first' : false }, () => {
  assert.deepEqual(networkCallSites(readFileSync(OFFLINE_JS, 'utf8')), [])
  const live = readFileSync(LIVE_JS, 'utf8')
  assert.deepEqual(networkCallSites(live), ['fetch()'])
  assert.deepEqual(networkReferences(live), [])
  // the live page carries its stream and image paths, and nothing of the app's session token or the page's storage
  // (the contract's route catalogue, as text, is in both bundles: no call site reaches it)
  assert.ok(live.includes('/live/api/stream') && live.includes('/live/api/image/'))
  for (const never of ['x-oasis-code-token', 'oasis-code.token', 'localStorage', 'sessionStorage', 'indexedDB']) assert.ok(!live.includes(never), never)
})
