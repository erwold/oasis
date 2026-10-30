import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { BuildInfo } from '../src/api/types'
import { handshake } from '../src/state/handshake.ts'

const build = (over: Partial<BuildInfo> = {}): BuildInfo => ({ package_version: '0.1.0', source_fingerprint: 'b1', api_version: 'code-v1',
  schema_version: 3, ui_build: 'u1', isolation: { runtime: 'seatbelt', enforcement: 'full' }, host: '127.0.0.1', port: 8321, ...over })

test('only an incompatible API blocks; an older page is told to reload', () => {
  assert.deepEqual(handshake(build(), 'u1'), { block: null, stale: null })
  assert.match(handshake(build({ api_version: 'code-v0' }), 'u1').block ?? '', /code-v0 ≠ code-v1/)
  const older = handshake(build({ ui_build: 'u2' }), 'u1')
  assert.equal(older.block, null)
  assert.match(older.stale ?? '', /UI build u1; the backend now serves u2/)
  assert.deepEqual(handshake(build({ ui_build: null }), 'dev'), { block: null, stale: null })   // no dist: nothing to compare
})
