import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EVENT_ROWS, applyEvent, compactionNote, costText, formingLine, fromTranscript, reportedTokens, searchLine, uncountedNote, uncountedRequests, type ThreadEntry } from '../src/state/thread.ts'

const ev = (event: string, data: Record<string, unknown>, id?: string) => ({ event, data, id })

test('tool call and result correlate by tool_call_id in either order and never duplicate', () => {
  let t: ThreadEntry[] = []
  t = applyEvent(t, 'r1', ev('tool_result', { tool: 'read_file', tool_call_id: 'c1', status: 'ok', lines: '1-6/6' }, '3'))
  t = applyEvent(t, 'r1', ev('tool_call', { tool: 'read_file', tool_call_id: 'c1', summary: '{"path":"calc.py"}', path: 'calc.py' }, '2'))
  assert.equal(t.length, 1)
  assert.equal(t[0].running, false)
  assert.equal(t[0].tool, 'read_file')
  t = applyEvent(t, 'r1', ev('tool_call', { tool: 'read_file', tool_call_id: 'c1', summary: 'x' }, '2'))       // replay
  assert.equal(t.length, 1)
  t = applyEvent(t, 'r2', ev('tool_call', { tool: 'read_file', tool_call_id: 'c1', summary: 'x' }, '2'))       // another run, same id
  assert.equal(t.length, 2)
})

test('text deltas stream into one row and the block closes it', () => {
  let t: ThreadEntry[] = []
  t = applyEvent(t, 'r1', ev('text_delta', { text: 'Hel', start: true }))
  t = applyEvent(t, 'r1', ev('text_delta', { text: 'lo' }))
  assert.equal(t[0].text, 'Hello')
  assert.equal(t[0].running, true)
  t = applyEvent(t, 'r1', ev('text_block', { text: 'Hello' }, '5'))
  assert.equal(t.length, 1)
  assert.equal(t[0].running, false)
  // a replayed block after a restart (no deltas) is its own row
  assert.equal(applyEvent([], 'r1', ev('text_block', { text: 'Only block' }, '9')).length, 1)
})

test('gate, closing, slot_wait, errors and unknown events are visible rows', () => {
  let t: ThreadEntry[] = []
  t = applyEvent(t, 'r1', ev('action_gated', { action: 'network', reason: 'not granted' }, '1'))
  t = applyEvent(t, 'r1', ev('budget_closing', { reason: 'tool_calls 3 of 3' }, '2'))
  t = applyEvent(t, 'r1', ev('slot_wait', { scope: 'openai', behind: ['x'] }, '3'))
  t = applyEvent(t, 'r1', ev('error', { kind: 'auth', message: '401' }, '4'))
  t = applyEvent(t, 'r1', ev('something_new', { a: 1 }, '5'))
  assert.deepEqual(t.map((e) => e.kind), ['gate', 'note', 'note', 'error', 'system'])
  assert.equal(t[4].text, 'something_new')
  t = applyEvent(t, 'r1', ev('something_new', { a: 1 }, '5'))     // replay by event id
  assert.equal(t.length, 5)
})

test('run_finished closes running rows and reports non-done states', () => {
  let t: ThreadEntry[] = [{ kind: 'activity', runId: 'r1', toolCallId: 'c', tool: 'run_command', running: true }]
  t = applyEvent(t, 'r1', ev('run_finished', { status: 'cancelled' }, '7'))
  assert.equal(t[0].running, false)
  assert.equal(t[1].text, 'Run cancelled')
})

test('a run done with an answer the provider stopped says so; one that ended as asked adds nothing', () => {
  const filtered = applyEvent([], 'r1', ev('run_finished', { status: 'done', answer_end: { reason: 'content_filter', attempts: 0 } }, '7'))
  assert.equal(filtered.length, 1)
  assert.equal(filtered[0].kind, 'note')
  assert.match(filtered[0].text ?? '', /provider stopped the answer/)
  // an event saved before the end rode on its own: the receipt says it
  const saved = applyEvent([], 'r1', ev('run_finished', { status: 'done', receipt: { mechanical: { answer_end: { reason: 'content_filter', attempts: 0 } } } }, '7'))
  assert.match(saved[0].text ?? '', /provider stopped the answer/)
  assert.deepEqual(applyEvent([], 'r1', ev('run_finished', { status: 'done', answer_end: null }, '7')), [])
})

test('a run that starts beside a command still running in its folder says which', () => {
  const t = applyEvent([], 'r2', ev('run_started', { model: 'm', running_commands: [{ execution_id: 'x_1', run_id: 'r1', command: 'npm run watch' }] }, '0'))
  assert.equal(t.length, 2)
  assert.equal(t[1].kind, 'note')
  assert.match(t[1].text ?? '', /npm run watch \(x_1\)/)
  assert.equal(applyEvent(t, 'r2', ev('run_started', { model: 'm', running_commands: [{ execution_id: 'x_1', run_id: 'r1', command: 'npm run watch' }] }, '0')).length, 2)
  assert.equal(applyEvent([], 'r2', ev('run_started', { model: 'm', running_commands: [] }, '0')).length, 1)
})

test('transcript rows and money words', () => {
  const rows = fromTranscript('r1', [
    { kind: 'user', text: 'fix' }, { kind: 'activity', tool: 'apply_patch', toolCallId: 'c', summary: '{}', result: { status: 'ok' }, running: false },
    { kind: 'agent', text: 'done' }])
  assert.deepEqual(rows.map((r) => r.kind), ['activity', 'agent'])
  assert.equal(costText(null, 'unknown'), 'unknown (no price list)')
  assert.equal(costText(0.0123, 'estimated', 'list@1'), '≈ $0.0123 (list@1)')
  assert.equal(costText(null, 'no_requests'), 'no requests')
})

test('an unknown cost says why: no price list, or requests the provider reported no count for', () => {
  // a request record: one request, uncounted
  assert.equal(costText(null, 'unknown', null, { uncounted: 1, requests: 1 }), 'unknown (the provider reported no count)')
  assert.equal(costText(null, 'unknown', null, { uncounted: 0, requests: 1 }), 'unknown (no price list)')
  // a run: every request uncounted, or some counted without a price list
  assert.equal(costText(null, 'unknown', null, { uncounted: 3, requests: 3 }), 'unknown (the provider reported no counts)')
  assert.equal(costText(null, 'unknown', null, { uncounted: 1, requests: 3 }), 'unknown (no price list; 1 of 3 requests not counted)')
  // priced in part: the requests left out are named, so the figure does not read as whole
  assert.equal(costText(0.01, 'partial', null, { uncounted: 2, requests: 5 }), 'at least $0.0100 (2 of 5 requests not counted)')
  assert.equal(costText(0.01, 'partial'), 'at least $0.0100 (partly unpriced)')
  assert.equal(uncountedRequests({ uncounted_requests: 2 }), 2)
  assert.equal(uncountedRequests({}), 0)
  assert.equal(uncountedNote(1, 1), '1 of 1 request not counted')
})

test('a stored transcript of a stopped run: the call the stop came before reads cancelled, not running', () => {
  const rows = fromTranscript('r1', [
    { kind: 'user', text: 'read both' },
    { kind: 'activity', tool: 'read_file', toolCallId: 'first', summary: '{}', args: { path: 'calc.py' }, result: { status: 'ok', path: 'calc.py' }, running: false },
    { kind: 'activity', tool: 'read_file', toolCallId: 'second', summary: '{}', args: { path: 'README.md' },
      result: { status: 'cancelled', reason: 'not executed: the run was stopped before this tool call started' }, running: false },
    { kind: 'activity', tool: 'write_file', toolCallId: 'third', summary: '{}', args: { path: 'x.txt' }, result: { status: 'interrupted', reason: 'the run ended (error) before this tool call was answered' }, running: false },
  ])
  assert.deepEqual(rows.map((r) => [r.toolCallId, r.status, r.running]), [['first', 'ok', false], ['second', 'cancelled', false], ['third', 'interrupted', false]])
  // a live-stream tool_result for a call that never started closes the row the same way, with no call row before it
  const live = applyEvent([], 'r1', ev('tool_result', { tool: 'read_file', tool_call_id: 'second', status: 'cancelled', reason: 'not executed: the run was stopped before this tool call started' }, '7'))
  assert.equal(live.length, 1)
  assert.deepEqual([live[0].kind, live[0].toolCallId, live[0].status, live[0].running], ['activity', 'second', 'cancelled', false])
})

test('continuations and integrations are visible rows with their reasons', () => {
  let t: ThreadEntry[] = []
  t = applyEvent(t, 'r1', ev('run_continued', { reason: 'request_boundary', requests_before: 60, segment: 2 }, '1'))
  t = applyEvent(t, 'r1', ev('integration', { status: 'conflict', applied: ['cp_a'], conflicts: ['calc.py'], applied_to_workspace: false }, '2'))
  assert.deepEqual(t.map((e) => e.kind), ['note', 'note'])
  assert.match(t[0].text ?? '', /after 60 requests.*segment 2/)
  assert.match(t[1].text ?? '', /conflict.*calc\.py/)
})

test('every event the backend emits has a registered row; an unknown one still shows', () => {
  // the backend's emits (runner, tools, gate) and the stream mapping's (agent/events.py)
  const emitted = ['run_started', 'text_delta', 'text_block', 'thinking_delta', 'thinking_block', 'tool_call', 'tool_result',
    'execution_started', 'checkpoint', 'action_gated', 'budget_closing', 'slot_wait', 'slot_acquired', 'run_continued',
    'integration', 'context_compacted', 'model_request', 'error', 'run_finished', 'lock_violation', 'run_queued']
  assert.deepEqual(emitted.filter((e) => !(e in EVENT_ROWS)), [])
  const t = applyEvent([], 'r1', ev('lock_violation', { violations: ['test_calc.py is locked read-only'] }, '1'))
  assert.equal(t[0].kind, 'error')
  assert.match(t[0].text ?? '', /locked read-only/)
  assert.equal(applyEvent([], 'r1', ev('brand_new', { x: 1 }, '2'))[0].kind, 'system')
})

test('an answer cut off by a broken stream and continued reads as one answer', () => {
  let t: ThreadEntry[] = []
  t = applyEvent(t, 'r1', ev('text_delta', { text: 'The bug is ', start: true }, '1'))
  t = applyEvent(t, 'r1', ev('text_delta', { text: 'in add(): it subtr' }, '2'))
  t = applyEvent(t, 'r1', ev('run_continued', { reason: 'transport_error', recovery: 1, of: 3, kept_chars: 29 }, '3'))
  t = applyEvent(t, 'r1', ev('text_delta', { text: 'acts instead', start: true }, '4'))
  t = applyEvent(t, 'r1', ev('text_delta', { text: ' of adding.' }, '5'))
  t = applyEvent(t, 'r1', ev('text_block', { text: 'acts instead of adding.' }, '6'))
  const answers = t.filter((e) => e.kind === 'agent')
  assert.deepEqual(answers.map((e) => [e.text, e.running]), [['The bug is in add(): it subtracts instead of adding.', false]])
  // nothing kept: the next answer is its own row, as before
  let u: ThreadEntry[] = []
  u = applyEvent(u, 'r1', ev('run_continued', { reason: 'transport_error', recovery: 1, of: 3, kept_chars: 0 }, '1'))
  u = applyEvent(u, 'r1', ev('text_block', { text: 'fresh' }, '2'))
  assert.deepEqual(u.filter((e) => e.kind === 'agent').map((e) => e.text), ['fresh'])
})

test('an answer cut at the output limit and continued reads as one answer; the notes say what happened', () => {
  let t: ThreadEntry[] = []
  t = applyEvent(t, 'r1', ev('text_delta', { text: 'The bug is in add(): it ret', start: true }, '1'))
  t = applyEvent(t, 'r1', ev('text_block', { text: 'The bug is in add(): it ret' }, '2'))
  t = applyEvent(t, 'r1', ev('run_continued', { reason: 'output_limit', attempt: 1, of: 2, kept_chars: 27 }, '3'))
  t = applyEvent(t, 'r1', ev('text_delta', { text: 'urns a - b.', start: true }, '4'))
  t = applyEvent(t, 'r1', ev('text_block', { text: 'urns a - b.' }, '5'))
  assert.deepEqual(t.filter((e) => e.kind === 'agent').map((e) => [e.text, e.running]), [['The bug is in add(): it returns a - b.', false]])
  assert.match(t.find((e) => e.kind === 'note')!.text!, /output limit — asked for the rest \(1 of 2\)/)
  const empty = applyEvent([], 'r1', ev('run_continued', { reason: 'no_answer', attempt: 1, of: 1, kept_chars: 0 }, '1'))
  assert.match(empty[0].text!, /no answer text — asked once more/)
  const overflow = applyEvent([], 'r1', ev('run_continued', { reason: 'context_overflow', recovery: 1, of: 1 }, '1'))
  assert.match(overflow[0].text!, /refused the conversation for its size — compacting once/)
})

test('a request the provider counted nothing for (stopped, failed, or served without a count) shows its tokens as unknown, not 0', () => {
  const zero = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }
  assert.equal(reportedTokens({ status: 'error', ...zero }), null)
  assert.equal(reportedTokens({ status: 'ok', ...zero }), null)
  assert.deepEqual(reportedTokens({ status: 'ok', ...zero, input_tokens: 12, output_tokens: 3 }), { input: 12, output: 3, cached: 0 })
  assert.deepEqual(reportedTokens({ status: 'error', ...zero, input_tokens: 10 }), { input: 10, output: 0, cached: 0 })
})

test('a compaction line shows only estimated before/after counts, not maintenance diagnostics', () => {
  const base = { status: 'compacted', estimate_tokens: 11133, after_tokens: 5766, threshold_tokens: 10000 }
  assert.equal(compactionNote({ ...base, trigger_tokens: 10000 }), 'Context compacted · ~11,133 → ~5,766 tokens')
  assert.equal(compactionNote({ ...base, trigger_tokens: 13573, summary_cut_chars: 420 }),
    'Context compacted · ~11,133 → ~5,766 tokens')
  assert.equal(compactionNote({ status: 'failed', reason: 'boom', estimate_tokens: 1, threshold_tokens: 2 }), 'Context compaction failed')
})

test("a web search row names what it did: a query, or the page the provider's search opened or searched in", () => {
  assert.equal(searchLine({ query: 'Flow-GRPO paper' }), 'Flow-GRPO paper')
  assert.equal(searchLine({ action: 'open_page', url: 'https://arxiv.org/abs/2505.05470' }), 'open https://arxiv.org/abs/2505.05470')
  assert.equal(searchLine({ action: 'find', url: 'https://arxiv.org/abs/2505.05470', pattern: 'GRPO' }), 'find "GRPO" in https://arxiv.org/abs/2505.05470')
  assert.equal(searchLine({ action: 'open_page' }), 'open')
})

test('a call still being written shows as one row that grows, and gives way to the call when it comes or the run ends', () => {
  let t: ThreadEntry[] = []
  t = applyEvent(t, 'r1', ev('tool_call_progress', { tool: 'write_file', tool_call_id: 'c1', chars: 4200 }))
  assert.equal(t.length, 1)
  assert.equal(formingLine(t[0]), 'writing… 4.1 KB so far')
  t = applyEvent(t, 'r1', ev('tool_call_progress', { tool: 'write_file', tool_call_id: 'c1', chars: 48_000, path: 'site/flow.html' }))
  assert.equal(t.length, 1)
  assert.equal(formingLine(t[0]), 'site/flow.html · writing… 47 KB so far')
  // the call itself replaces it, under the provider's final id even if it differs
  t = applyEvent(t, 'r1', ev('tool_call', { tool: 'write_file', tool_call_id: 'call_final', summary: '{"path":"site/flow.html"}', path: 'site/flow.html' }, '7'))
  assert.equal(t.length, 1)
  assert.equal(t[0].forming, undefined)
  assert.equal(t[0].toolCallId, 'call_final')
  // a run that ends while a call forms leaves no row behind
  t = applyEvent(t, 'r1', ev('tool_call_progress', { tool: 'present_ui', tool_call_id: 'c2', chars: 900, title: 'Flow-GRPO' }))
  assert.equal(formingLine(t[1]), 'Flow-GRPO · writing… 900 characters so far')
  t = applyEvent(t, 'r1', ev('run_finished', { status: 'cancelled' }, '9'))
  assert.equal(t.some((e) => e.forming), false)
})

test('currency-aware costs keep CNY and USD separate, suppress unused USD zero and preserve uncertainty', () => {
  assert.equal(costText({ cost_usd: null, cost_cny: 0.1234 }, 'estimated', 'BigModel list'), '≈ ¥0.1234 CNY (BigModel list)')
  assert.equal(costText({ cost_usd: 0, cost_cny: 0.1234 }, 'estimated'), '≈ ¥0.1234 CNY (estimate)')
  assert.equal(costText({ cost_usd: 0.2, cost_cny: 1.2 }, 'estimated'), '≈ $0.2000 + ¥1.2000 CNY (estimate)')
  assert.equal(costText({ cost_usd: 0.2, cost_cny: 1.2 }, 'partial'), 'at least $0.2000 + ¥1.2000 CNY (partly unpriced)')
  assert.equal(costText({ cost_cny: 1.2 }, 'partial', null, { uncounted: 1, requests: 2 }), 'at least ¥1.2000 CNY (1 of 2 requests not counted)')
  assert.equal(costText({ cost_usd: null, cost_cny: null }, 'unknown'), 'unknown (no price list)')
  assert.equal(costText({ cost_cny: NaN }, 'estimated'), 'unknown (no price list)')
  assert.equal(costText({ cost_cny: 0 }, 'estimated'), '≈ ¥0.0000 CNY (estimate)')
  assert.equal(costText({ cost_usd: 0, cost_cny: null }, 'estimated'), '≈ $0.0000 (estimate)')
})

test('an answer part that stays empty (Antigravity, Gemini) takes no row, live or from the transcript; one that fills shows its words', () => {
  let t: ThreadEntry[] = []
  t = applyEvent(t, 'r1', ev('text_delta', { text: '', start: true }))
  assert.deepEqual(t, [], 'an empty start draws nothing')
  t = applyEvent(t, 'r1', ev('text_block', { text: '' }))
  t = applyEvent(t, 'r1', ev('tool_call', { tool: 'bash', tool_call_id: 'c1', summary: 'ls' }))
  t = applyEvent(t, 'r1', ev('text_delta', { text: '', start: true }))
  t = applyEvent(t, 'r1', ev('text_delta', { text: 'Done' }))
  t = applyEvent(t, 'r1', ev('text_block', { text: 'Done' }))
  assert.deepEqual(t.filter((e) => e.kind === 'agent').map((e) => [e.text, e.running]), [['Done', false]])
  assert.equal(t.filter((e) => e.kind === 'agent').length, 1)
  assert.deepEqual(fromTranscript('r1', [{ kind: 'agent', text: '' }, { kind: 'agent', text: 'Words' }] as never).filter((e) => e.kind === 'agent').map((e) => e.text), ['Words'])
})
