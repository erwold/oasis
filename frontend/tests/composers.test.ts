import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PendingImage } from '../src/state/attachments.ts'
import { composerOf, EMPTY_COMPOSER, forgottenComposer, START_COMPOSER, switchedComposer, withComposer, type ComposerFields } from '../src/state/composers.ts'

const image = (id: string): PendingImage => ({ id, file: {} as File, url: `blob:${id}`, name: `${id}.png`, state: 'ready', error: null, uploaded: null })
const shown = (s: ComposerFields) => [s.draft, s.images.map((i) => i.id), s.relayRounds]
const D = 'director' as const

test('each session keeps its own composer: words, images and rounds go away with the place and come back with it, never under another', () => {
  // writing in A (an image and two rounds with it), then B opened: B's composer is empty, A's is kept aside
  let s: ComposerFields = { draft: 'draft A', images: [image('a1')], relayRounds: 2, orchestration: 'turns', composers: {} }
  s = { ...s, ...switchedComposer(s, 'A', 'B') }
  assert.deepEqual(shown(s), ['', [], 1])
  assert.deepEqual(Object.keys(s.composers), ['A'])
  // writing in B, then back to A: A's words, image and rounds are what they were; B's are kept aside now
  s = { ...s, draft: 'draft B', images: [image('b1')] }
  s = { ...s, ...switchedComposer(s, 'B', 'A') }
  assert.deepEqual(shown(s), ['draft A', ['a1'], 2])
  assert.equal(s.orchestration, 'turns')                                                  // how A's agents work together comes back with A
  assert.deepEqual(s.composers.B, { draft: 'draft B', images: [image('b1')], relayRounds: 1, orchestration: D })
  assert.equal(s.composers.A, undefined)
  // the same place again (a replay's end reloads the session): nothing moves
  assert.deepEqual(switchedComposer(s, 'A', 'A'), {})
  // the start screen has a composer of its own too
  s = { ...s, ...switchedComposer(s, 'A', START_COMPOSER) }
  assert.deepEqual(shown(s), ['', [], 1])
  s = { ...s, draft: 'a new task' }
  s = { ...s, ...switchedComposer(s, START_COMPOSER, 'B') }
  assert.deepEqual(shown(s), ['draft B', ['b1'], 1])
  assert.equal(s.composers[START_COMPOSER]?.draft, 'a new task')
  assert.equal(s.composers.A?.draft, 'draft A')
  // a session deleted takes its composer with it and hands back the images to release
  const gone = forgottenComposer(s.composers, 'A')
  assert.deepEqual(Object.keys(gone.composers).sort(), [START_COMPOSER])
  assert.deepEqual(gone.images.map((i) => i.id), ['a1'])
  assert.deepEqual(forgottenComposer(gone.composers, 'nobody').images, [])
  assert.deepEqual(EMPTY_COMPOSER, { draft: '', images: [], relayRounds: 1, orchestration: D })
})

test('a send that comes back after the person moved on clears its owner\'s composer only, never the one on show', () => {
  // A sent its words and image, then B was opened (A put away, B on show with its own draft and image)
  let s: ComposerFields = { draft: 'draft A pending', images: [image('A-pending')], relayRounds: 2, orchestration: D, composers: { B: { draft: 'B must survive', images: [image('B-unsent')], relayRounds: 3, orchestration: D } } }
  s = { ...s, ...switchedComposer(s, 'A', 'B') }
  // the upload's marks and the send's end read and write A's composer, which is put away now
  assert.deepEqual(composerOf(s, 'B', 'A').images.map((i) => i.id), ['A-pending'])
  s = { ...s, ...withComposer(s, 'B', 'A', { images: composerOf(s, 'B', 'A').images.map((i) => ({ ...i, state: 'uploading' as const })) }) }
  assert.equal(s.composers.A?.images[0]?.state, 'uploading')
  const sent = composerOf(s, 'B', 'A')
  s = { ...s, ...withComposer(s, 'B', 'A', { draft: '', images: [] }) }
  assert.deepEqual(sent.images.map((i) => i.url), ['blob:A-pending'])                   // what the sender releases
  assert.deepEqual([s.draft, s.images.map((i) => i.id), s.relayRounds], ['B must survive', ['B-unsent'], 3])   // B untouched
  assert.deepEqual(s.composers.A, { draft: '', images: [], relayRounds: 2, orchestration: D })   // A's cleared, its rounds kept
  // back in A: an empty composer, as the send left it
  s = { ...s, ...switchedComposer(s, 'B', 'A') }
  assert.deepEqual([s.draft, s.images, s.relayRounds], ['', [], 2])
  // the sender still on show: the fields on show are what change
  assert.deepEqual(withComposer(s, 'A', 'A', { draft: '' }), { draft: '' })
  assert.deepEqual(composerOf(s, 'A', 'nobody'), EMPTY_COMPOSER)
})
