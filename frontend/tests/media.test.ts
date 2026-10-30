import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mediaKind, mediaUrl, shownImagesOf, workspacePath } from '../src/state/media.ts'

test('a picture or a clip of the working folder is known by its extension; web links, absolute paths and anchors are not', () => {
  assert.equal(mediaKind('review/v2_blink.png'), 'image')
  assert.equal(mediaKind('./evidence/Neutral Reference.JPG'), 'image')
  assert.equal(mediaKind('out/walk.mp4'), 'video')
  assert.equal(mediaKind('clip.webm?t=3'), 'video')
  assert.equal(mediaKind('result.blend'), null)
  assert.equal(mediaKind('https://example.com/a.png'), null)
  assert.equal(mediaKind('/etc/a.png'), null)
  assert.equal(mediaKind('#a.png'), null)
  assert.equal(mediaKind('sandbox:/mnt/data/a.png'), null)
  assert.equal(mediaKind(''), null)
})

test("a path reads as the workspace names it, and its bytes come from the workspace's media route", () => {
  assert.equal(workspacePath('./evidence/Neutral%20Reference.png'), 'evidence/Neutral Reference.png')
  assert.equal(mediaUrl('ws_1', './evidence/a b.png'), '/api/workspaces/ws_1/media?path=evidence%2Fa%20b.png')
})

test("the images a tool result records are read from its `shown`; anything else shows none", () => {
  const one = { asset_id: 'a_1', width: 64, height: 32, label: 'front' }
  assert.deepEqual(shownImagesOf({ shown: [one, { width: 1 }, null] }), [one])
  assert.deepEqual(shownImagesOf({ images: 2 }), [])
  assert.deepEqual(shownImagesOf(undefined), [])
})
