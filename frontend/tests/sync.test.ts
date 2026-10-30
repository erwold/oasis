import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { DirectorNote, Run } from '../src/api/types'
import { besideChanged, hasChanges, joinNewRuns, noteLabel, noteQuestion, sessionDelta, threadItems } from '../src/state/sync.ts'

const run = (id: string, created_at: string, status: Run['status'] = 'done', extra: Partial<Run> = {}): Run => ({
  id, session_id: 's', project_id: 'p', workspace_id: 'w', parent_run_id: null, resumes_run_id: null, spawned_by: 'human', label: null,
  model: 'm', model_config_snapshot: {}, user_text: id, status, usage: {}, manifest: {}, budget: {}, error: null, created_at, finished_at: null,
  saved_seq: 0, receipt: {}, work_order: null, attachments: [], relay_id: null, relay_step: null, interaction_id: null, interaction_node: null, ...extra,
})

const note = (id: string, created_at: string, model = 'GPT-6 Pro'): DirectorNote =>
  ({ id, session_id: 's', source: 'chatgpt', model, question: 'why?', answer: 'because', turn_id: null, created_at })

test('the thread orders runs and notes by time, a note before the run of the same moment', () => {
  const items = threadItems([run('r1', '2026-09-26T10:00:05Z'), run('r2', '2026-09-26T10:02:00Z')],
                            [note('n1', '2026-09-26T10:00:05Z'), note('n2', '2026-09-26T10:01:00Z')])
  assert.deepEqual(items.map((i) => (i.kind === 'run' ? i.run.id : i.note.id)), ['n1', 'r1', 'n2', 'r2'])
  assert.deepEqual(threadItems([], []), [])
})

test("a question asked before the director's runs stands before them; its answer after", () => {
  const n = note('n1', '2026-09-27T05:04:45Z')
  const items = threadItems([run('opus', '2026-09-27T05:02:05Z')], [n], { n1: '2026-09-27T05:01:16Z' })
  assert.deepEqual(items.map((i) => `${i.kind}:${i.kind === 'run' ? i.run.id : i.note.id}`), ['asked:n1', 'run:opus', 'note:n1'])
  assert.equal((items[2] as { split?: boolean }).split, true)
  // no turn known, or no question: the note stays whole at its own time
  assert.deepEqual(threadItems([run('opus', '2026-09-27T05:02:05Z')], [n]).map((i) => i.kind), ['run', 'note'])
  assert.deepEqual(threadItems([], [{ ...n, question: '' }], { n1: '2026-09-27T05:01:16Z' }).map((i) => i.kind), ['note'])
})

test("a director's answer written while the run it started still worked stands before that run; after the runs it waited for", () => {
  // the owner's session: the person's run, the director woken by its end, answering "I handed it to Fable" 6 s after it
  // started the run that then worked for 4 minutes; then woken by that run's end
  const fe = run('run_fe', '2026-09-29T07:16:11.104Z', 'done', { finished_at: '2026-09-29T07:16:20.476Z' })
  const d8 = run('run_d8', '2026-09-29T07:18:28.236Z', 'done', { finished_at: '2026-09-29T07:22:27.074Z' })
  const handed = { ...note('n_handed', '2026-09-29T07:18:34.526Z', 'Claude Opus 5.5'), source: 'oasis-code', question: 'oasis-code task event:\n- run run_fe finished: done' }
  const judged = { ...note('n_judged', '2026-09-29T07:22:47.199Z', 'Claude Opus 5.5'), source: 'oasis-code', question: 'oasis-code task event:\n- run run_d8 finished: done' }
  const items = threadItems([fe, d8], [handed, judged], { n_handed: '2026-09-29T07:16:20.479Z', n_judged: '2026-09-29T07:22:27.078Z' }, { n_handed: ['run_d8'], n_judged: [] })
  assert.deepEqual(items.map((i) => `${i.kind}:${i.kind === 'run' ? i.run.id : i.note.id}`), ['run:run_fe', 'asked:n_handed', 'note:n_handed', 'run:run_d8', 'asked:n_judged', 'note:n_judged'])
  // a director that waited for its run to end (the bridge's ChatGPT, get_run until done) answers after it
  const waited = threadItems([{ ...d8, finished_at: '2026-09-29T07:18:30.000Z' }], [handed], {}, { n_handed: ['run_d8'] })
  assert.deepEqual(waited.map((i) => i.kind), ['run', 'note'])
})

test('the delta names what another client added or moved, never what this page streams', () => {
  const known = { runs: [run('r1', 't1'), run('r2', 't2', 'running')], notes: [note('n1', 't0')] }
  const fresh = { runs: [run('r1', 't1'), run('r2', 't2', 'done', { receipt: { mechanical: { checks: { passed: 1, failed: 0, unknown: 0, not_run: 0 } } } as Run['receipt'] }), run('r3', 't3', 'running')],
                  director_notes: [note('n1', 't0'), note('n2', 't2')] }
  const delta = sessionDelta(known, fresh)
  assert.deepEqual(delta.newRuns.map((r) => r.id), ['r3'])
  assert.deepEqual(delta.newNotes.map((n) => n.id), ['n2'])
  assert.deepEqual(delta.changedRuns.map((r) => r.id), ['r2'])
  assert.equal(hasChanges(delta), true)
  assert.equal(hasChanges(sessionDelta(known, { runs: known.runs, director_notes: known.notes })), false)
  assert.equal(hasChanges(sessionDelta(known, { runs: known.runs })), false)
})

test("the person's words lose the chat client's app-mention markup, nothing else", () => {
  assert.equal(noteQuestion('[@oasis-code](plugin://dev-6ab76cd@openai-curated-remote) You direct my harness.'), '@oasis-code You direct my harness.')
  assert.equal(noteQuestion('see [the docs](https://example.com/x) and @path/to/file'), 'see [the docs](https://example.com/x) and @path/to/file')
})

test('a note is labelled by where it was said and which model answered', () => {
  assert.equal(noteLabel({ source: 'chatgpt', model: 'GPT-6 Pro' }), 'ChatGPT · GPT-6 Pro')
  assert.equal(noteLabel({ source: 'chatgpt', model: '' }), 'ChatGPT')
  assert.equal(noteLabel({ source: 'claude.ai', model: 'Opus' }), 'claude.ai · Opus')
  assert.equal(noteLabel({ source: 'oasis-code', model: 'Claude Opus 5.5' }), 'Claude Opus 5.5')          // the session's own director: its model, not this program's name
  assert.equal(noteLabel({ source: 'oasis-code', model: '' }), '')
})

test('runs beside the thread added, starting or ending are a change the tree is read again for', () => {
  assert.equal(besideChanged({ active_children: [] }, { active_children: [{ id: 'run_b' }] }), true)      // a director dispatched an order
  assert.equal(besideChanged({ active_children: [{ id: 'run_b' }] }, { active_children: [] }), true)      // it ended
  assert.equal(besideChanged({ active_children: [{ id: 'run_a' }, { id: 'run_b' }] }, { active_children: [{ id: 'run_b' }, { id: 'run_a' }] }), false)
  assert.equal(besideChanged(null, {}), false)
  assert.equal(besideChanged({ active_children: [], run_count: 3 }, { active_children: [], run_count: 4 }), true)   // one came and went between two reads
})

test("a relay's first turn keeps the answer its stream brought while the next turn's transcript was read", () => {
  // the page took in A (its send) and streamed A's whole turn while a sync read B's transcript: the sync joins B
  // without putting back the empty thread A had when the read began
  const a = run('run_a', '2026-10-01T10:00:00Z', 'done', { relay_id: 'relay_1', relay_step: 0 })
  const b = run('run_b', '2026-10-01T10:00:01Z', 'done', { relay_id: 'relay_1', relay_step: 1 })
  const page = { runs: [a], threads: { run_a: ['read_file calc.py', 'RELAY_MARKER_7f3a'] } }
  const joined = joinNewRuns(page, [b], { run_b: ['REVIEW_CONTEXT_OK'] })
  assert.deepEqual(joined.threads, { run_a: ['read_file calc.py', 'RELAY_MARKER_7f3a'], run_b: ['REVIEW_CONTEXT_OK'] })
  assert.deepEqual(joined.runs.map((r) => r.id), ['run_a', 'run_b'])
  assert.deepEqual(joined.added.map((r) => r.id), ['run_b'])
  // a run the page's own send took in while the read went on is neither added twice nor emptied
  const sent = joinNewRuns({ runs: [a], threads: { run_a: ['streamed'] } }, [a, b], { run_a: [], run_b: [] })
  assert.deepEqual(sent.runs.map((r) => r.id), ['run_a', 'run_b'])
  assert.deepEqual(sent.threads.run_a, ['streamed'])
  assert.deepEqual(sent.added.map((r) => r.id), ['run_b'])
})
