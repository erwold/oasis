import assert from 'node:assert/strict'
import { test } from 'node:test'
import { approvalFacts, proposalTitle } from '../src/state/approvals.ts'

test('a network approval for a computer action shows its whole target: element or point, text, keys, the look', () => {
  assert.deepEqual(approvalFacts({ surface: 'browser', action: 'click', snapshot_id: 'browser-4', ref: 'e15' }), [
    { name: 'action', value: 'click on browser' }, { name: 'element', value: 'e15' }, { name: 'look', value: 'browser-4' },
  ])
  assert.deepEqual(approvalFacts({ surface: 'browser', action: 'type', snapshot_id: 'browser-4', x: 120, y: 340, text: 'amount=5000', clear: true }), [
    { name: 'action', value: 'type on browser' }, { name: 'point', value: '120,340' }, { name: 'look', value: 'browser-4' },
    { name: 'text', value: '"amount=5000"' }, { name: 'clear', value: 'true' },
  ])
  assert.deepEqual(approvalFacts({ surface: 'browser', action: 'key', keys: 'Meta+A', snapshot_id: 'browser-1' }).map((f) => f.name), ['action', 'look', 'keys'])
  // any other request: every parameter named; a long one cut where a person still reads it
  const facts = approvalFacts({ url: 'x'.repeat(500) })
  assert.equal(facts[0]!.name, 'url')
  assert.equal(facts[0]!.value, JSON.stringify(`${'x'.repeat(300)}…`))
})

test('a proposal is named by what it does; one made before labels by its tool', () => {
  assert.equal(proposalTitle({ tool_name: 'computer_act', label: 'computer_act accept the open dialog (the confirm the run last saw: "Delete?") on browser' }),
    'computer_act accept the open dialog (the confirm the run last saw: "Delete?") on browser')
  assert.equal(proposalTitle({ tool_name: 'write_file', label: null }), 'write_file')
  assert.equal(proposalTitle({ tool_name: 'write_file' }), 'write_file')
})
