import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inexpensiveTranscript } from '../src/state/transcriptCost.ts'
import type { Run } from '../src/api/types.ts'
import type { ThreadEntry } from '../src/state/thread.ts'
const r = { id: 'r', user_text: 'plain question', attachments: [] } as unknown as Run
const entries: ThreadEntry[] = [{ kind: 'thinking', runId: 'r', text: 'brief ended reasoning' }, { kind: 'activity', runId: 'r', tool: 'bash', summary: 'synthetic', args: { command: 'echo test' }, result: { status: 'refused', reason: 'not allowed' }, running: false }]
test('tiny ended work skips deferral; giant single turns and rich/active records never use the hint', () => {
  assert.equal(inexpensiveTranscript([r], { r: entries }, true), true)
  for (const user_text of ['x'.repeat(100000), '$x$', '![picture](image.png)', '| a | b |']) assert.equal(inexpensiveTranscript([{ ...r, user_text }], { r: entries }, true), false)
  for (const extra of [{ running: true }, { result: { shown: [{ asset_id: 'picture' }] } }, { args: { nested: {} } }, { result: { stdout: 'x'.repeat(100000) } }]) {
    assert.equal(inexpensiveTranscript([r], { r: [{ ...entries[1]!, ...extra }] }, true), false)
  }
  assert.equal(inexpensiveTranscript([r], { r: Array.from({ length: 17 }, () => entries[0]!) }, true), false)
  assert.equal(inexpensiveTranscript([r], { r: entries }, false), false)
})


test('only compact ended harness access notes, not pending or generic rich forms, use the cheap path', () => {
  const input = { status: 'closed', request: { harness: 'remote_full_access', title: 'Access', elements: { pick: { type: 'select', props: { options: [{ label: 'Full', value: 'full' }] } } } } } as unknown as NonNullable<ThreadEntry['input']>
  const row: ThreadEntry = { kind: 'input', runId: 'r', input }
  assert.equal(inexpensiveTranscript([r], { r: [...entries, row] }, true), true)
  for (const value of [{ ...input, status: 'pending' }, { ...input, request: { ...input.request, harness: 'other' } }, { ...input, request: { ...input.request, message: 'x'.repeat(3000) } }]) {
    assert.equal(inexpensiveTranscript([r], { r: [{ ...row, input: value as typeof input }] }, true), false)
  }
})
