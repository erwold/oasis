import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseUiInputRequest, type UiInputRecord, type UiTaskRecord } from '@oasis-code/contract'
import { applyEvent, fromTranscript, type ThreadEntry } from '../src/state/thread.ts'
import type { TranscriptEntry } from '../src/api/types'
import { turnParts } from '../src/state/turns.ts'
import { createInputController, formOf, type InputDeps } from '../src/state/uiInputs.ts'

const tick = () => new Promise((r) => setImmediate(r))
let n = 0
const at = () => new Date(Date.UTC(2026, 9, 12, 1, 0, 0, ++n)).toISOString()

const request = {
  title: 'Pick a plan', message: 'Which plan should I set up?', root: 'main', submit_label: 'Set it up',
  elements: {
    main: { type: 'stack', children: ['plan', 'seats', 'note', 'agree'] },
    plan: { type: 'select', props: { label: 'Plan', key: 'plan', options: [{ label: 'Team', value: 'team' }, { label: 'Pro', value: 'pro' }] } },
    seats: { type: 'input', props: { label: 'Seats', key: 'seats', inputType: 'number', min: 1, max: 50 } },
    note: { type: 'input', props: { label: 'Note', key: 'note', inputType: 'text' } },
    agree: { type: 'checkbox', props: { label: 'I agree', key: 'agree' } },
  },
  initial_state: { seats: 1 },
  required: ['plan', 'seats', 'agree'],
}

function input(over: Partial<UiInputRecord> = {}): UiInputRecord {
  return {
    id: 'uin_1', session_id: 's1', run_id: 'r1', tool_call_id: 'call_7', request: request as unknown as UiInputRecord['request'], status: 'pending',
    values: null, closed_reason: null, created_at: '2026-10-12T01:00:00.000Z', answered_at: null, updated_at: at(), ...over,
  }
}

test('the fixture request is one the contract takes (the tests draw what the tool would)', () => {
  assert.equal(parseUiInputRequest(request).ok, true)
})

test('a form is one row per input id where its run asked for it, its own part of the turn, updated in place when answered', () => {
  let t: ThreadEntry[] = []
  t = applyEvent(t, 'r1', { event: 'text_block', data: { text: 'I need one thing from you.' } })
  t = applyEvent(t, 'r1', { event: 'tool_call', data: { tool: 'request_input', tool_call_id: 'call_7', title: 'Pick a plan' }, id: '4' })
  const pending = input()
  t = applyEvent(t, 'r1', { event: 'ui_input', data: { input: pending }, id: '5' })
  assert.deepEqual(turnParts(t).map((p) => p.kind), ['agent', 'work', 'input'], 'never folded into the work')
  const answered = input({ status: 'submitted', values: { plan: 'pro', seats: 3, note: '', agree: true }, answered_at: at() })
  t = applyEvent(t, 'r1', { event: 'ui_input', data: { input: answered }, id: '6' })
  t = applyEvent(t, 'r1', { event: 'tool_result', data: { tool: 'request_input', tool_call_id: 'call_7', status: 'submitted' }, id: '7' })
  const rows = t.filter((e) => e.kind === 'input')
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.input!.status, 'submitted')
  assert.equal(rows[0]!.toolCallId, 'call_7', 'found by its tool call')
  // a replayed older word changes nothing
  assert.equal(applyEvent(t, 'r1', { event: 'ui_input', data: { input: pending }, id: '5' }), t)
})

test("a form event the page cannot read, or another run's, is a note — never a form; a run without a form has no form row", () => {
  assert.deepEqual(applyEvent([], 'r1', { event: 'ui_input', data: { input: { id: 'x' } }, id: '1' }).map((e) => e.kind), ['note'])
  assert.deepEqual(applyEvent([], 'r2', { event: 'ui_input', data: { input: input() }, id: '1' }).map((e) => e.kind), ['note'])
  const plain = applyEvent(applyEvent([], 'r1', { event: 'tool_call', data: { tool: 'read_file', tool_call_id: 'c' }, id: '1' }), 'r1', { event: 'run_finished', data: { status: 'done' }, id: '2' })
  assert.ok(!plain.some((e) => e.kind === 'input'))
})

test("a UI task's run carries one line for its task, replaced in place by a later record", () => {
  const task = (over: Partial<UiTaskRecord>): UiTaskRecord => ({
    id: 'uit_1', session_id: 's1', surface_run_id: 'r0', surface_id: 'calc', revision: 1, action_id: 'order', request_id: 'ui-req-1', agent_run_id: 'r1',
    status: 'running', input: null, text: '', data: null, error: null, created_at: '2026-10-12T00:00:00.000Z', started_at: null, finished_at: null, updated_at: at(), ...over,
  })
  let t = applyEvent([], 'r1', { event: 'ui_task', data: { task: task({}) }, id: '1' })
  t = applyEvent(t, 'r1', { event: 'ui_task', data: { task: task({ data: { total: 3 } }) }, id: '5' })
  t = applyEvent(t, 'r1', { event: 'ui_task', data: { task: task({ status: 'succeeded', data: { total: 3 }, text: 'ok' }) }, id: '9' })
  const lines = t.filter((e) => e.eventName === 'ui_task')
  assert.equal(lines.length, 1)
  assert.equal(lines[0]!.text, 'UI task · action order on surface calc · done · result data sent to the surface')
  assert.equal(lines[0]!.task!.status, 'succeeded')
})

test('the form draws with the native catalog; a required text or number field says so itself', () => {
  const form = formOf(input())
  assert.ok(form.ok)
  const seats = form.spec.elements!.seats!
  assert.equal(seats.type === 'input' && seats.props.required, true)
  const note = form.spec.elements!.note!
  assert.equal(note.type === 'input' && note.props.required, undefined)
  assert.deepEqual(formOf(input({ request: { title: 'Bad', root: 'x', elements: {} } as unknown as UiInputRecord['request'] })).ok, false)
})

function world() {
  const sent: Array<{ what: string; body: unknown }> = []
  const adopted: UiInputRecord[] = []
  let answer: () => Promise<UiInputRecord> = async () => input({ status: 'submitted', answered_at: at() })
  let ids = 0
  const deps: InputDeps = {
    newId: () => `ui-ans-${++ids}`,
    submit: (_s, _i, body) => { sent.push({ what: 'submit', body }); return answer() },
    dismiss: (_s, _i, body) => { sent.push({ what: 'dismiss', body }); return answer() },
    adopt: (r) => { adopted.push(r) },
  }
  return { sent, adopted, deps, set answer(f: () => Promise<UiInputRecord>) { answer = f } }
}
const apiError = (status: number, body: Record<string, unknown>) => Object.assign(new Error(String(body.detail)), { status, detail: String(body.detail), body })

test('submit: the contract\'s own check first (nothing sent while a required field is empty), then the values, the defaults merged in', async () => {
  const w = world()
  const record = input()
  const form = formOf(record)
  assert.ok(form.ok)
  const c = createInputController(record, w.deps)
  await c.submit(record, form)
  assert.equal(w.sent.length, 0)
  const phase = c.view().phase
  assert.equal(phase.kind, 'invalid')
  assert.deepEqual(phase.kind === 'invalid' && phase.errors.sort(), ['values.agree: required', 'values.plan: required'])
  c.setValue(form.spec, 'plan', 'pro')
  assert.equal(c.view().phase.kind, 'idle', 'an edit answers the refusal the person read')
  c.setValue(form.spec, 'seats', 99)   // out of range: the contract refuses the state, nothing is written
  assert.equal(c.view().values.seats, 1)
  c.setValue(form.spec, 'seats', 4)
  c.setValue(form.spec, 'agree', true)
  await c.submit(record, form)
  assert.deepEqual(w.sent, [{ what: 'submit', body: { values: { seats: 4, plan: 'pro', agree: true, note: '' }, request_id: 'ui-ans-1' } }])
  assert.equal(w.adopted[0]!.status, 'submitted', 'the record the harness answered goes to the store')
})

test('the harness refuses the values (400 invalid_values): its errors are shown; a form no longer pending (409): its record says how it ended', async () => {
  const w = world()
  const record = input()
  const form = formOf(record)
  assert.ok(form.ok)
  const c = createInputController(record, w.deps)
  c.setValue(form.spec, 'plan', 'team'); c.setValue(form.spec, 'agree', true)
  w.answer = async () => { throw apiError(400, { detail: 'values refused', error: 'invalid_values', errors: ['values.plan: not an option'] }) }
  await c.submit(record, form)
  assert.deepEqual(c.view().phase, { kind: 'invalid', errors: ['values.plan: not an option'] })
  const closed = input({ status: 'closed', closed_reason: 'cancelled' })
  w.answer = async () => { throw apiError(409, { detail: 'not pending', error: 'not_pending', input: closed }) }
  await c.submit(record, form)
  assert.equal(c.view().phase.kind, 'idle')
  assert.equal(w.adopted.at(-1)!.status, 'closed')
})

test('a request that fails in transit: said with Retry; the same answer again keeps its key (the harness takes it once), another answer gets a new one', async () => {
  const w = world()
  const record = input()
  const form = formOf(record)
  assert.ok(form.ok)
  const c = createInputController(record, w.deps)
  c.setValue(form.spec, 'plan', 'team'); c.setValue(form.spec, 'agree', true)
  w.answer = async () => { throw new Error('network down') }
  await c.submit(record, form)
  assert.deepEqual(c.view().phase, { kind: 'error', message: 'network down', what: 'submit' })
  await c.submit(record, form)
  c.setValue(form.spec, 'plan', 'pro')
  await c.submit(record, form)
  const keys = w.sent.map((s) => (s.body as { request_id: string }).request_id)
  assert.equal(keys[0], keys[1])
  assert.notEqual(keys[1], keys[2])
  // sending: a second press while the first is on its way sends nothing more
  let release!: () => void
  w.answer = () => new Promise((resolve) => { release = () => resolve(input({ status: 'dismissed', answered_at: at() })) })
  const one = c.dismiss(record)
  await c.dismiss(record)
  assert.equal(w.sent.filter((s) => s.what === 'dismiss').length, 1)
  assert.deepEqual(c.view().phase, { kind: 'sending', what: 'dismiss' })
  release(); await one; await tick()
  assert.equal(w.adopted.at(-1)!.status, 'dismissed')
})

test('only a pending form takes an answer', async () => {
  const w = world()
  const record = input({ status: 'closed', closed_reason: 'budget' })
  const form = formOf(record)
  assert.ok(form.ok)
  const c = createInputController(record, w.deps)
  await c.submit(record, form)
  await c.dismiss(record)
  assert.equal(w.sent.length, 0)
})

// ---- a finished run read from its stored transcript (hard reload, session switch): the form where the call showed it ----

test("a stored transcript's form comes back where its call stood, as it ended — one row per input id, the later word kept", () => {
  const submitted = input({ status: 'submitted', values: { plan: 'pro', seats: 3, note: 'n', agree: true }, answered_at: '2026-10-12T01:05:00.000Z', updated_at: '2026-10-12T01:05:00.000Z' })
  const entries = [
    { kind: 'user', text: 'set it up' },
    { kind: 'agent', text: 'I need one thing from you.' },
    { kind: 'activity', tool: 'request_input', toolCallId: 'call_7', summary: '{}', args: { title: 'Pick a plan' }, result: { status: 'submitted', input_id: 'uin_1' }, running: false },
    { kind: 'input', toolCallId: 'call_7', input: submitted },
    { kind: 'agent', text: 'Set up Pro with 3 seats.' },
  ] as TranscriptEntry[]
  const rows = fromTranscript('r1', entries)
  assert.deepEqual(rows.map((r) => r.kind), ['agent', 'activity', 'input', 'agent'], 'right after its call, before the words that followed the answer')
  const form = rows[2]!
  assert.equal(form.runId, 'r1')
  assert.equal(form.toolCallId, 'call_7')
  assert.equal(form.input!.id, 'uin_1')
  assert.equal(form.input!.status, 'submitted')
  assert.deepEqual(form.input!.values, { plan: 'pro', seats: 3, note: 'n', agree: true }, 'the values sent, not the defaults')
  assert.deepEqual(turnParts(rows).map((p) => p.kind), ['agent', 'work', 'input', 'agent'], 'its own part, never folded into the work')

  // the same input id twice: one row at the first place; an older word after a later one changes nothing; a later one replaces it in place
  const older = input({ status: 'pending', updated_at: '2026-10-12T01:01:00.000Z' })
  const twice = fromTranscript('r1', [...entries, { kind: 'input', toolCallId: 'call_7', input: older }] as TranscriptEntry[])
  assert.equal(twice.filter((r) => r.kind === 'input').length, 1)
  assert.equal(twice.find((r) => r.kind === 'input')!.input!.status, 'submitted')
  const closedLater = input({ status: 'closed', closed_reason: 'cancelled', updated_at: '2026-10-12T01:09:00.000Z' })
  const replaced = fromTranscript('r1', [entries[0], entries[1], entries[2], { kind: 'input', toolCallId: 'call_7', input: older }, entries[4], { kind: 'input', toolCallId: 'call_7', input: closedLater }] as TranscriptEntry[])
  assert.deepEqual(replaced.map((r) => r.kind), ['agent', 'activity', 'input', 'agent'])
  assert.equal(replaced[2]!.input!.status, 'closed')
})

test("a transcript's form of another run (the conversation a continued run inherited), or one that does not read, is no row of this run", () => {
  const earlier = input({ id: 'uin_0', run_id: 'r0', tool_call_id: 'call_0', status: 'submitted', values: { plan: 'team', seats: 1, note: '', agree: true } })
  const rows = fromTranscript('r1', [
    { kind: 'input', toolCallId: 'call_0', input: earlier },
    { kind: 'input', toolCallId: 'call_x', input: { id: 'broken' } },
    { kind: 'agent', text: 'continuing' },
  ] as unknown as TranscriptEntry[])
  assert.deepEqual(rows.map((r) => r.kind), ['agent'])
  // the run that asked keeps it
  assert.deepEqual(fromTranscript('r0', [{ kind: 'input', toolCallId: 'call_0', input: earlier }] as TranscriptEntry[]).map((r) => r.input?.id), ['uin_0'])
})

test('pending, dismissed and closed forms read back with their status; a replayed older live event leaves the stored word', () => {
  for (const [status, extra] of [['pending', {}], ['dismissed', { answered_at: '2026-10-12T01:02:00.000Z' }], ['closed', { closed_reason: 'interrupted' }]] as const) {
    const rec = input({ status, ...extra, updated_at: '2026-10-12T02:00:00.000Z' } as Partial<UiInputRecord>)
    const rows = fromTranscript('r1', [
      { kind: 'activity', tool: 'request_input', toolCallId: 'call_7', summary: '{}', args: { title: 'Pick a plan' }, result: status === 'pending' ? undefined : { status }, running: status === 'pending' },
      { kind: 'input', toolCallId: 'call_7', input: rec },
    ] as TranscriptEntry[])
    assert.equal(rows[1]!.input!.status, status)
    const stale = applyEvent(rows, 'r1', { event: 'ui_input', data: { input: input({ status: 'pending', updated_at: '2026-10-12T01:00:00.500Z' }) }, id: '3' })
    assert.equal(stale, rows, 'an older word is no change')
  }
})
