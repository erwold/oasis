import assert from 'node:assert/strict'
import { test } from 'node:test'
import { citedUrls, hostOf, markOf, pathLabel, siteIconUrl, siteIconsOf, siteOf, sourcesOf, STATUS_WORDS } from '../src/state/sources.ts'
import type { ThreadEntry } from '../src/state/thread.ts'

test('cited urls are found once, markdown links included, trailing punctuation dropped', () => {
  const text = 'See [the docs](https://docs.python.org/3/library/unittest.html), and https://github.com/x/y/issues/1. Again https://docs.python.org/3/library/unittest.html#top'
  assert.deepEqual(citedUrls(text), ['https://docs.python.org/3/library/unittest.html', 'https://github.com/x/y/issues/1'])
  assert.equal(hostOf('https://a.example:8443/x'), 'a.example:8443')
  assert.equal(pathLabel('https://docs.python.org/3/library/unittest.html'), 'unittest.html')
  assert.equal(pathLabel('https://example.com/'), 'example.com')
})

test('fetched pages come first with how the fetch went; cited ones follow once', () => {
  const entries: ThreadEntry[] = [
    { kind: 'activity', tool: 'fetch_url', runId: 'r', status: 'stored', args: { url: 'https://docs.example/api', purpose: 'the API' },
      result: { url: 'https://docs.example/api', asset_id: 'a_1', purpose: 'the API' }, running: false },
    { kind: 'activity', tool: 'fetch_url', runId: 'r', status: 'blocked_by_bot_check', args: { url: 'https://wall.example/' }, result: {}, running: false },
    { kind: 'activity', tool: 'fetch_url', runId: 'r', status: 'refused', args: { url: 'http://192.168.1.2/' }, result: {}, running: false },
    { kind: 'activity', tool: 'read_file', runId: 'r', status: 'ok', args: { path: 'a' }, result: {}, running: false },
  ]
  const sources = sourcesOf(entries, 'Used https://docs.example/api and https://other.example/page.')
  assert.deepEqual(sources.map((s) => [s.host, s.status]), [['docs.example', 'stored'], ['wall.example', 'blocked'], ['192.168.1.2', 'refused'], ['other.example', 'cited']])
  // fetch_url's words today: a page fetched and saved is `ok` — fetched, never "unreachable"
  const fetch = (url: string, status: string, result: Record<string, unknown> = {}): ThreadEntry =>
    ({ kind: 'activity', tool: 'fetch_url', runId: 'r', status, args: { url }, result: { url, ...result }, running: false })
  const today = sourcesOf([
    fetch('https://arxiv.org/abs/2506.21495', 'ok', { asset_id: 'a_2', final_url: 'https://198.18.1.39/abs/2506.21495' }),
    fetch('https://gone.example/x', 'http_error', { asset_id: 'a_3', http_status: 404 }),
    fetch('https://down.example/', 'unreachable'),
    fetch('https://slow.example/', 'cancelled'),
    fetch('https://new.example/', 'some_new_word', { asset_id: 'a_4' }),
  ], '')
  assert.deepEqual(today.map((s) => [s.host, s.status, STATUS_WORDS[s.status]]), [
    ['arxiv.org', 'stored', 'fetched'], ['gone.example', 'http_error', 'HTTP error'], ['down.example', 'error', 'unreachable'],
    ['slow.example', 'cancelled', 'stopped'], ['new.example', 'stored', 'fetched'],
  ])
  assert.equal(sources[0].assetId, 'a_1')
  assert.equal(sources[0].purpose, 'the API')
})

test('a site is named without www or a port, and marked by its letter and a steady hue', () => {
  assert.equal(siteOf('www.booking.com'), 'booking.com')
  assert.equal(siteOf('www2.example.org:8443'), 'example.org')
  assert.equal(siteOf('docs.python.org'), 'docs.python.org')
  const booking = markOf('www.booking.com')
  assert.deepEqual(booking, markOf('booking.com'))                                // the same site, the same mark
  assert.equal(booking.letter, 'B')
  assert.ok(Number.isInteger(booking.hue) && booking.hue >= 0 && booking.hue < 360)
  assert.notEqual(markOf('google.com').hue, markOf('trip.com').hue)
  assert.equal(markOf('携程.com').letter, '携')
  assert.equal(markOf('').letter, '?')
})

test("a site's kept icon comes from the session's fetch rows, by site; a site only cited has none", () => {
  const row = (url: string, result: Record<string, unknown>): ThreadEntry => ({ kind: 'activity', tool: 'fetch_url', runId: 'r', status: 'ok', args: { url }, result: { url, ...result }, running: false })
  const threads: Record<string, ThreadEntry[]> = {
    r1: [row('https://arxiv.org/abs/2506.21495', { icon_asset_id: 'a_icon1' }), row('https://www.example.com/a', {})],
    r2: [row('https://www.arxiv.org/abs/2407.14503', { icon_asset_id: 'a_icon1' }), { kind: 'activity', tool: 'fetch_url', runId: 'r2', status: 'running', args: { url: 'https://live.example/' }, result: { icon_asset_id: 'a_x' }, running: true }],
  }
  const icons = siteIconsOf(threads)
  assert.deepEqual([...icons], [['arxiv.org', 'a_icon1']])                  // www. or not, one site; a live row names nothing yet
  assert.equal(siteIconsOf(threads), icons)                                // the same threads: the same map, not read again
  assert.equal(siteIconUrl('s_1', 'a_icon1'), '/api/sessions/s_1/site-icons/a_icon1')
})
