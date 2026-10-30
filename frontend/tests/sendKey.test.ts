import assert from 'node:assert/strict'
import { test } from 'node:test'
import { keyFor, signatureOf } from '../src/state/sendKey.ts'

test('the same message sent again in the same session keeps its key; another message or session gets a new one', () => {
  let n = 0
  const mint = () => `key-${(n += 1)}`
  const first = keyFor(null, 's_1', signatureOf('fix it', ['img_1']), mint)
  assert.equal(first.key, 'key-1')
  assert.equal(keyFor(first, 's_1', signatureOf('fix it', ['img_1']), mint), first)
  assert.equal(keyFor(first, 's_1', signatureOf('fix it!', ['img_1']), mint).key, 'key-2')
  assert.equal(keyFor(first, 's_1', signatureOf('fix it', []), mint).key, 'key-3')
  assert.equal(keyFor(first, 's_2', signatureOf('fix it', ['img_1']), mint).key, 'key-4')
  assert.match(keyFor(null, 's_1', 'x').key, /^[0-9a-f-]{36}$/)
})
