import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SurfaceFrame } from '../src/state/desktop.ts'
import { surfaceFrames } from '../src/state/desktop.ts'
import { computerLine, doingLine, pointerPlace, screenSteps, screenSurface, siteOf, watching } from '../src/state/screen.ts'

const call = (tool: string, args: Record<string, unknown>, result?: Record<string, unknown>, id = 'c') => ({ kind: 'activity', tool, args, result, toolCallId: id })

test("a run's looks that kept a picture are the window's steps, in order; the page it is on is its latest call's", () => {
  const entries = [
    { kind: 'agent', text: 'I will look.' },
    call('computer_observe', {}, { surface: 'browser', screenshot_asset_id: 'a_1', url: 'https://example.com/', title: 'Example' }, 'c1'),
    call('fetch_url', { url: 'https://example.com/' }, { screenshot_asset_id: 'a_x' }, 'c2'),                  // not computer use
    call('computer_act', { action: 'click', ref: 'e7' }, { surface: 'browser', screenshot_asset_id: 'a_2', url: 'https://example.com/done', title: 'Done' }, 'c3'),
    call('computer_observe', { read_text: true }, { surface: 'browser', text: 'words' }, 'c4'),                // no picture
    call('computer_act', { surface: 'chatgpt', action: 'type', text: 'hi' }, undefined, 'c5'),                 // still running
  ]
  assert.deepEqual(screenSteps(entries), [
    { key: 'c1', assetId: 'a_1', surface: 'browser', url: 'https://example.com/', title: 'Example', line: 'look at browser · Example' },
    { key: 'c3', assetId: 'a_2', surface: 'browser', url: 'https://example.com/done', title: 'Done', line: 'click e7 on browser · Done' },
  ])
  assert.equal(screenSurface(entries), 'chatgpt')
  assert.equal(screenSurface(entries.slice(0, 5)), 'browser')
  const pageless = [{ kind: 'agent', text: 'no page' }, call('bash', { command: 'ls' })]
  assert.equal(screenSurface(pageless), null)
  assert.deepEqual(screenSteps([]), [])
  assert.equal(computerLine({ action: 'navigate', url: 'https://a.b/' }, { surface: 'browser', status: 'stale' }), 'navigate https://a.b/ on browser · stale')
})

test('the window is live while its run holds the page and the page drew; the pointer stands in percent of the page', () => {
  const frame: SurfaceFrame = {
    surface: 'browser', holder: 'run_1', last: { owner: 'run_1', party: 'session:s_1' }, doing: { action: 'double_click', target: 'e42', since: 1 }, pointer: { x: 320, y: 600, action: 'click', at: 2 },
    image: { media_type: 'image/jpeg', data_base64: 'AAAA', width: 960, height: 600 }, url: 'https://example.com/a', title: 'A', viewport: { width: 1280, height: 800 },
  }
  assert.equal(watching(frame, 'run_1'), true)
  assert.equal(watching(frame, 'run_2'), false)                                    // another run's page
  assert.equal(watching({ ...frame, holder: null, doing: null }, 'run_1'), true)   // its quiet lease ran out (a slow model): still its page
  // nobody holds the page and another run held it last (another session's, which let go): never this run's page
  const theirs = { ...frame, holder: null, last: { owner: 'run_9', party: 'session:s_2' }, doing: null, pointer: null }
  assert.equal(watching(theirs, 'run_1'), false)
  assert.equal(watching(theirs, 'run_9'), true)
  assert.equal(watching({ ...frame, holder: null, last: { owner: 'bridge', party: 'bridge' } }, 'run_1'), false)   // the bridge's send
  assert.equal(watching({ ...frame, holder: null, last: null }, 'run_1'), false)   // nobody took it yet
  assert.equal(watching({ ...frame, image: null }, 'run_1'), false)                // nothing drawn (a dialog holds the page)
  assert.equal(watching(null, 'run_1'), false)
  assert.deepEqual(pointerPlace(frame.pointer, frame.viewport), { left: 25, top: 75 })
  assert.equal(pointerPlace(null, frame.viewport), null)
  assert.equal(pointerPlace(frame.pointer, undefined), null)
  assert.equal(pointerPlace(frame.pointer, { width: 0, height: 0 }), null)
  assert.equal(pointerPlace({ ...frame.pointer!, x: 2000 }, frame.viewport), null)   // the page was resized since: outside what shows
  assert.equal(doingLine(frame.doing), 'double click e42')
  assert.equal(doingLine({ action: 'reload', target: null, since: 1 }), 'reload')
  assert.equal(doingLine(null), 'the page now · the agent decides its next step')
  assert.equal(siteOf('https://shop.example.com/cart?x=1'), 'shop.example.com')
  assert.equal(siteOf('about:blank'), 'about:blank')
})

test('the live picture is the desktop shell\'s: a plain browser has none', () => {
  assert.equal(surfaceFrames({}), null)
  assert.equal(surfaceFrames({ oasisCodeDesktop: { platform: 'darwin' } }), null)
  const read = async () => null
  assert.equal(surfaceFrames({ oasisCodeDesktop: { platform: 'darwin', surfaceFrame: read } }), read)
})


test('history steps choose the display picture and retain old screenshots as their fallback', () => {
  const entries = [
    call('computer_observe', {}, { screenshot_asset_id: 'agent_1', screenshot_display_asset_id: 'display_1' }, 'c1'),
    call('computer_act', {}, { screenshot_asset_id: 'agent_2', screenshot_display_asset_id: '' }, 'c2'),
    call('computer_observe', {}, { screenshot_asset_id: 'legacy' }, 'c3'),
  ]
  assert.deepEqual(screenSteps(entries).map((step) => step.assetId), ['display_1', 'agent_2', 'legacy'])
})
