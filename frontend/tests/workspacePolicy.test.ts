import assert from 'node:assert/strict'
import { test } from 'node:test'
import { adoptionBoundaryKnown, isolationLine, protectsSource, sourceMount } from '../src/state/workspacePolicy.ts'
import { THINKING_LEVELS, thinkingLabel, thinkingOption, participantThinking } from '../src/state/accounts.ts'
import { loadedTarget, messageDestination } from '../src/state/messageTarget.ts'
import { pendingSendKeys } from '../src/state/sendKey.ts'

test('v24 workspace root/name/readonly are the only source-mount evidence; unknown isolation is not a live-source claim', () => {
  const isolated = { workspace_policy: 'isolated', base_checkpoint_id: null }
  assert.equal(protectsSource(isolated), false)
  assert.doesNotMatch(isolationLine(isolated)!, /read-only|copy|checkpoint/)
  const mounted = { source_mount: { root: '/fixture/data', name: 'data', readonly: true } }
  assert.deepEqual(sourceMount(mounted), { root: '/fixture/data', name: 'data' })
  assert.equal(adoptionBoundaryKnown(mounted), false)
  assert.equal(isolationLine(isolated, mounted), null)                       // a read-only source says nothing on the board
  assert.match(isolationLine(isolated, { source_mount: null })!, /Separate copy/)
  assert.equal(adoptionBoundaryKnown({}), false)
  assert.equal(adoptionBoundaryKnown({ source_mount: null }), true)
  assert.equal(isolationLine({ kind: 'direct' }), null)
})

test('max is a distinct requested effort; participant identity is kept when one model is repeated', () => {
  assert.ok(THINKING_LEVELS.includes('max'))
  assert.equal(thinkingLabel('max'), 'Thinking: maximum')
  assert.equal(thinkingOption('max'), 'Maximum')
  assert.deepEqual(participantThinking([{ id: 'pt_000001', model: 'm' }, { id: 'pt_000002', model: 'm' }], { m: 'max' }), { pt_000001: 'max', pt_000002: 'max' })
})

test('notes are explicit and scoped to one interaction; × wins a delayed lookup', () => {
  assert.deepEqual(messageDestination('director', 'ix', 'everyone', null), { kind: 'director' })
  assert.deepEqual(messageDestination('director', 'ix', 'everyone', 'ix'), { kind: 'note', interactionId: 'ix', to: 'everyone' })
  // the group chosen is not open now: still that note, marked gone (sending refuses it) — never the director
  assert.deepEqual(messageDestination('director', 'ix2', 'everyone', 'ix'), { kind: 'note', interactionId: 'ix', to: 'everyone', gone: true })
  assert.deepEqual(messageDestination('agent', 'ix', 'director', null), { kind: 'agent' })
  assert.equal(loadedTarget('agent', 'chatgpt'), 'agent')
  assert.equal(loadedTarget('director', 'chatgpt'), 'chatgpt')
})

test('acknowledging one scoped signature does not evict any other failed request', () => {
  const pending = pendingSendKeys()
  const a = pending.get('A', 'director:first'), otherA = pending.get('A', 'agent:first'), b = pending.get('B', 'director:first')
  pending.acknowledge(b)
  assert.equal(pending.get('A', 'director:first'), a)
  assert.equal(pending.get('A', 'agent:first'), otherA)
  pending.acknowledge(a)
  const next = pending.get('A', 'director:first')
  assert.notEqual(next.key, a.key)
  pending.acknowledge(a) // a late duplicate response cannot evict the newer request
  assert.equal(pending.get('A', 'director:first'), next)
})
