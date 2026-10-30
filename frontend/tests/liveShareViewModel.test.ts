/** The share's view read from a live state (src/share/viewModel.ts shareViewOf, the same reading as the offline file):
 *  an answer being written is a streaming answer row, a running tool a running row (only on the live page), a picture
 *  found by its opaque resource; the page's own faces are stable and of the product's set; the offline reading is
 *  unchanged (a tool is never drawn running there). */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerHooks } from 'node:module'
import { shareView, shareViewOf } from '../src/share/viewModel.ts'
import { SHARE_PAGE_FORMAT, SHARE_PAGE_VERSION, SHARE_BOTS } from '../src/share/document.ts'
import { liveRun, liveSnapshot, RES_A } from './liveShareFixtures.ts'
import { richSnapshot } from './shareFixtures.ts'

// the page's bot stills are pictures the build inlines: here, a data URL each
registerHooks({ load: (url, context, next) => (/\.png$/.test(url) ? { format: 'module', source: 'export default "data:image/png;base64,AAAA"', shortCircuit: true } : next(url, context)) })
const { liveFaces } = await import('../src/share/live/viewer/faces.ts')

test('a live state: the running turn holds the open answer as a streaming row and the running tool as a running row; the picture by its resource', () => {
  const snapshot = liveSnapshot()
  const asked: string[] = []
  const view = shareViewOf({ snapshot, live: true, faces: liveFaces(snapshot.runs), bots: {},
    picture: (r) => { asked.push(r); return r === RES_A ? { src: 'blob:x/1', width: 1, height: 1 } : null } })
  const r2 = view.blocks.find((b) => b.kind === 'run' && b.run.id === 'r2')
  assert.ok(r2 && r2.kind === 'run')
  assert.equal(r2.run.status, 'running')
  assert.equal(r2.run.user_text, 'Now fix the build')
  const open = r2.entries.find((e) => e.eventId === 'i8')!
  assert.deepEqual([open.kind, open.running, open.text], ['agent', true, 'Working on it, first line done'])
  assert.equal(r2.entries.find((e) => e.eventId === 'i6')!.running, true)
  assert.equal(r2.entries.find((e) => e.eventId === 'i4')!.running, false)
  assert.equal(r2.entries.find((e) => e.eventId === 'i7')!.steer!.status, 'queued')
  // the generated picture after its call: that call's picture, read by its resource id
  assert.deepEqual(view.presentation.tool('i4')!.pictures, [{ key: 'i5', origin: 'generated' }])
  assert.deepEqual(view.presentation.picture('i5'), { kind: 'shown', src: 'blob:x/1', width: 1, height: 1, label: 'Generated image' })
  assert.deepEqual(asked, [RES_A])
  // still loading: said so, not as an export's omission
  const loading = shareViewOf({ snapshot, live: true, faces: {}, bots: {}, picture: () => null, pictureMissing: () => 'loading…' })
  assert.deepEqual(loading.presentation.picture('i5'), { kind: 'omitted', label: 'Generated image', why: 'loading…' })
  // the same state read as not live: nothing runs
  const still = shareViewOf({ snapshot, faces: {}, bots: {}, picture: () => null })
  const r2s = still.blocks.find((b) => b.kind === 'run' && b.run.id === 'r2')
  assert.ok(r2s && r2s.kind === 'run' && r2s.entries.find((e) => e.eventId === 'i6')!.running === false)
})

test('the offline reading is unchanged: no tool runs, the pictures are the document\'s', () => {
  const snap = richSnapshot()
  const view = shareView({ format: SHARE_PAGE_FORMAT, version: SHARE_PAGE_VERSION, theme: 'light', snapshot: snap, pictures: {}, page: { images_rejected: 0, images_over_page_budget: 0 }, faces: {}, bots: {} })
  for (const b of view.blocks) if (b.kind === 'run') for (const e of b.entries) assert.equal(e.running ?? false, false)
})

test('the page\'s faces: stable for the same labels, of the product\'s set, none for an action\'s run, ChatGPT\'s mark for ChatGPT', () => {
  const runs = [liveRun({ key: 'r1' }), liveRun({ key: 'r2', model_label: 'Model B' }), liveRun({ key: 'r3', request: 'action' }), liveRun({ key: 'r4', model_label: 'ChatGPT' }),
    liveRun({ key: 'r5', participant: 'p1', role: 'member', model_label: 'Model B' })]
  const a = liveFaces(runs)
  assert.deepEqual(a, liveFaces(runs))
  assert.equal(a.r3!.bot, null)
  assert.equal(a.r4!.bot, 'chatgpt')
  assert.equal(a.r5!.enclosed, true)
  assert.equal(a.r1!.enclosed, false)
  for (const f of Object.values(a)) if (f.bot) assert.ok(SHARE_BOTS.includes(f.bot), f.bot)
})
