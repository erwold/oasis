/** A synthetic ShareSnapshotV2 (no real session, no real secret): runs with a parent, a continuation, a group member,
 *  a run with no entries, a run whose group item is absent; hostile text in every kind of field; a long message; a
 *  folded tool preview; a fullwidth word; images carried, omitted and rejected. */
import { SHARE_LIMITS, SHARE_OMISSION_KEYS, SHARE_REDACTION_KEYS, ShareSnapshotV1Schema, ShareSnapshotV2Schema, type ShareItem, type ShareItemV1, type ShareRun, type ShareSnapshotV1, type ShareSnapshotV2 } from '@oasis-code/contract'

export const HOSTILE = '</script><script>alert(1)</script><img src=x onerror=alert(2)><a href="https://evil.invalid/x" onclick="alert(3)">x</a>'

const zero = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>

const run = (over: Partial<ShareRun> & { key: string }): ShareRun => ({
  parent: null, continues: null, participant: null, role: 'main', surface: 'thread', group: null, started_by: 'person', request: 'message', client: null,
  label: null, model_label: 'Model A', status: 'done', status_label: 'done', started_at: '2026-10-21T01:00:00.000Z', finished_at: '2026-10-21T01:05:00.000Z', error: null, ...over,
})

export function snapshotFixture(over: Partial<ShareSnapshotV2> = {}): ShareSnapshotV2 {
  const items: ShareItem[] = [
    { kind: 'message', key: 'i1', run: 'r1', at: '2026-10-21T01:00:00.000Z', author: 'person', author_label: 'Person', source: 'opening', text: `Please fix the README ${HOSTILE}`, steer: null },
    { kind: 'tool', key: 'i2', run: 'r1', at: '2026-10-21T01:00:10.000Z', name: 'read_file', status: 'ok', target: 'docs/ＲＥＡＤＭＥ.md', details: { summary: 'read 12 lines', fields: [{ name: 'lines', value: 12 }], preview: 'folded-needle-xyz in the preview', preview_truncated: true }, withheld: null },
    { kind: 'tool', key: 'i3', run: 'r1', at: '2026-10-21T01:00:20.000Z', name: 'bash', status: 'ok', target: 'env', details: null, withheld: 'sensitive_source' },
    { kind: 'message', key: 'i4', run: 'r1', at: '2026-10-21T01:01:00.000Z', author: 'assistant', author_label: 'Agent', source: 'answer', text: 'Done.\n\n```ts\nconst a = "</script>"\n```\n\n| a | b |\n|:-|-:|\n| `x|y` | **bold** |\n\n- one\n- two\n\n[docs](javascript:alert(1)) and ![pic](https://evil.invalid/p.png)', steer: null },
    { kind: 'director_note', key: 'i5', run: null, at: '2026-10-21T01:02:00.000Z', source_label: 'Director', model_label: 'Model D', asker: 'person', question: 'What next?', answer: 'Run the relay.', status_label: 'answered' },
    { kind: 'group', key: 'i6', group: 'g1', run: null, at: '2026-10-21T01:03:00.000Z', group_kind: 'relay', author: 'person', author_label: 'Person', client: null, text: 'Relay the review', status_label: 'done', participants: ['p1'] },
    { kind: 'message', key: 'i7', run: 'r2', at: '2026-10-21T01:03:10.000Z', author: 'assistant', author_label: '', source: 'answer', text: `Long ${'word '.repeat(900)}deep-long-needle end`, steer: null },
    { kind: 'image', key: 'i8', run: 'r2', at: '2026-10-21T01:03:20.000Z', origin: 'screenshot', image: 'img1', omitted: null },
    { kind: 'image', key: 'i9', run: 'r2', at: '2026-10-21T01:03:30.000Z', origin: 'attachment', image: null, omitted: 'missing' },
    { kind: 'message', key: 'i10', run: 'r1', at: '2026-10-21T01:04:00.000Z', author: 'person', author_label: 'Person', source: 'steer', text: 'also check **bo**ld split-needle', steer: { status: 'delivered', by: 'person', client: null, reason: null } },
    { kind: 'notice', key: 'i11', run: 'r5', at: '2026-10-21T01:05:00.000Z', code: 'run_failed', text: 'The run failed.' },
  ]
  return ShapeCheck({
    format: 'oasis-code.session-share', version: 2, generated_at: '2026-10-21T02:00:00.000Z', title: 'Fix\u200B the README / ../etc',
    session: { created_at: '2026-10-21T00:59:00.000Z', last_activity_at: '2026-10-21T01:05:00.000Z', model_label: 'Model A' },
    options: { include_tool_details: true, include_images: true },
    participants: [{ key: 'p1', role: 'member', label: 'Reviewer', model_label: 'Model B' }],
    runs: [
      run({ key: 'r1', label: 'Main run' }),
      run({ key: 'r2', role: 'member', participant: 'p1', group: 'g1', surface: 'group', request: 'relay_turn', model_label: 'Model B' }),
      run({ key: 'r3', parent: 'r1', role: 'child', request: 'child', started_by: 'agent', label: 'Empty child' }),
      run({ key: 'r4', parent: 'r3', continues: 'r2', group: 'g2', label: 'Lost group member', status: 'cancelled', status_label: 'cancelled' }),
      run({ key: 'r5', label: 'Failed', status: 'error', status_label: 'failed', error: 'boom' }),
    ],
    items,
    images: [],
    stats: { omitted: { ...zero(SHARE_OMISSION_KEYS), thinking: 2, sensitive_tool_content: 1 }, redacted: { ...zero(SHARE_REDACTION_KEYS), session_token: 1, path: 3 }, truncated_fields: 1, items_truncated: true },
    limits: { ...SHARE_LIMITS },
    ...over,
  })
}

function ShapeCheck(s: ShareSnapshotV2): ShareSnapshotV2 { return ShareSnapshotV2Schema.parse(s) }

/** A snapshot of every item kind as the backend orders them (each run's items together, blocks by time): the person's
 *  opening with a carried and an omitted attachment; answers with code, a table, math, a web link, a markdown image (a
 *  web URL and a data: SVG — neither may load); tools with details and a cut preview, withheld, without details; a
 *  screenshot after a look, a generated image after its call, a picture with no call before it; steers by the
 *  person, a director, a connector, one unrecorded, one queued; notices; a failed run; a cancelled child; director
 *  exchanges (answered with a picture, image-only, failed without an answer, the app's own question); a relay group with
 *  a picture and its member's turn; a stray notice of no run. Synthetic: no real session, id or secret. */
export function richSnapshot(over: Partial<ShareSnapshotV2> = {}): ShareSnapshotV2 {
  const at = (m: number) => `2026-10-21T02:${String(m).padStart(2, '0')}:00.000Z`
  let n = 0
  const k = () => `i${++n}`
  const items: ShareItem[] = [
    { kind: 'message', key: k(), run: 'r1', at: at(0), author: 'person', author_label: 'Person', source: 'opening', text: 'Fix the parser, see the screenshots', steer: null },
    { kind: 'image', key: k(), run: 'r1', at: at(0), origin: 'attachment', image: 'img1', omitted: null },
    { kind: 'image', key: k(), run: 'r1', at: at(0), origin: 'attachment', image: null, omitted: 'over_budget' },
    { kind: 'tool', key: k(), run: 'r1', at: at(1), name: 'read_file', status: 'ok', target: 'src/parser.ts', details: { summary: 'read 40 lines', fields: [{ name: 'lines', value: 40 }], preview: 'export function parse() {}', preview_truncated: true }, withheld: null },
    { kind: 'tool', key: k(), run: 'r1', at: at(1), name: 'bash', status: 'ok', target: null, details: null, withheld: 'sensitive_source' },
    { kind: 'message', key: k(), run: 'r1', at: at(2), author: 'person', author_label: 'Person', source: 'steer', text: 'also check the tests', steer: { status: 'delivered', by: 'person', client: null, reason: null } },
    { kind: 'tool', key: k(), run: 'r1', at: at(2), name: 'computer_observe', status: 'ok', target: 'https://example.invalid/page', details: null, withheld: null },
    { kind: 'image', key: k(), run: 'r1', at: at(2), origin: 'screenshot', image: 'img2', omitted: null },
    { kind: 'message', key: k(), run: 'r1', at: at(3), author: 'assistant', author_label: 'Model A', source: 'answer', text: 'Done.\n\n```ts\nconst a = "</script>"\n```\n\n| a | b |\n|:-|-:|\n| 1 | 2 |\n\n$$E = mc^2$$\n\nSee [the docs](https://example.invalid/docs?q=1) and ![remote](https://example.invalid/p.png) ![inline](data:image/svg+xml;base64,PHN2Zz4=)', steer: null },
    { kind: 'message', key: k(), run: 'r1', at: at(3), author: 'director', author_label: 'Director', source: 'steer', text: 'director words', steer: { status: 'delivered', by: 'director', client: null, reason: null } },
    { kind: 'message', key: k(), run: 'r1', at: at(3), author: 'connector', author_label: 'ChatGPT', source: 'steer', text: 'connector words', steer: { status: 'undelivered', by: 'connector', client: 'ChatGPT', reason: 'stopped' } },
    { kind: 'message', key: k(), run: 'r1', at: at(3), author: 'unattributed', author_label: 'Words sent while it worked', source: 'steer', text: 'unrecorded words', steer: { status: 'delivered', by: 'unrecorded', client: null, reason: null } },
    { kind: 'message', key: k(), run: 'r1', at: at(3), author: 'person', author_label: 'Person', source: 'steer', text: 'undelivered person words', steer: { status: 'undelivered', by: 'person', client: null, reason: 'failed' } },
    { kind: 'director_note', key: k(), run: null, at: at(4), source_label: 'oasis-code', model_label: 'Model D', asker: 'person', question: 'What next?', answer: 'Run the relay.', status_label: 'Answered' },
    { kind: 'image', key: k(), run: null, at: at(4), origin: 'attachment', image: 'img3', omitted: null },
    { kind: 'director_note', key: k(), run: null, at: at(5), source_label: 'oasis-code', model_label: 'Model D', asker: 'person', question: '', answer: 'I see the picture.', status_label: 'Answered' },
    { kind: 'image', key: k(), run: null, at: at(5), origin: 'attachment', image: null, omitted: 'images_off' },
    { kind: 'director_note', key: k(), run: null, at: at(6), source_label: 'oasis-code', model_label: 'Model D', asker: 'person', question: 'And then?', answer: null, status_label: 'Failed' },
    { kind: 'director_note', key: k(), run: null, at: at(6), source_label: 'oasis-code', model_label: 'Model D', asker: 'app', question: 'oasis-code reported that runs it started ended', answer: 'Noted.', status_label: 'Answered' },
    { kind: 'group', key: k(), group: 'g1', run: null, at: at(7), group_kind: 'relay', author: 'person', author_label: 'Person', client: null, text: 'Relay the review', status_label: 'done', participants: ['p1'] },
    { kind: 'image', key: k(), run: null, at: at(7), origin: 'attachment', image: 'img4', omitted: null },
    { kind: 'notice', key: k(), run: 'r2', at: at(8), code: 'context_compacted', text: 'Earlier context was summarized for the model' },
    { kind: 'message', key: k(), run: 'r2', at: at(8), author: 'assistant', author_label: 'Reviewer', source: 'answer', text: 'Reviewed.', steer: null },
    { kind: 'tool', key: k(), run: 'r2', at: at(8), name: 'generate_image', status: 'ok', target: null, details: null, withheld: null },
    { kind: 'image', key: k(), run: 'r2', at: at(8), origin: 'generated', image: 'img5', omitted: null },
    { kind: 'image', key: k(), run: 'r2', at: at(8), origin: 'generated', image: null, omitted: 'damaged' },
    { kind: 'message', key: k(), run: 'r3', at: at(9), author: 'agent', author_label: 'Parent agent', source: 'opening', text: 'child: count the lines', steer: null },
    { kind: 'image', key: k(), run: 'r3', at: at(9), origin: 'generated', image: null, omitted: 'missing' },
    { kind: 'message', key: k(), run: 'r3', at: at(9), author: 'person', author_label: 'Person', source: 'steer', text: 'queued words', steer: { status: 'queued', by: 'person', client: null, reason: null } },
    { kind: 'notice', key: k(), run: 'r3', at: at(10), code: 'run_stopped', text: 'Stopped before it finished' },
    { kind: 'message', key: k(), run: 'r4', at: at(11), author: 'person', author_label: 'Person', source: 'opening', text: 'try again', steer: null },
    { kind: 'notice', key: k(), run: 'r4', at: at(12), code: 'run_failed', text: 'provider said no (synthetic)' },
    { kind: 'notice', key: k(), run: null, at: at(13), code: 'history_unavailable', text: 'A stray notice of no run' },
  ]
  return ShapeCheck({
    format: 'oasis-code.session-share', version: 2, generated_at: '2026-10-21T03:00:00.000Z', title: 'Rich synthetic session',
    session: { created_at: at(0), last_activity_at: at(13), model_label: 'Model A' },
    options: { include_tool_details: true, include_images: true },
    participants: [{ key: 'p1', role: 'member', label: 'Reviewer', model_label: 'Model B' }],
    runs: [
      run({ key: 'r1' }),
      run({ key: 'r2', role: 'member', participant: 'p1', group: 'g1', surface: 'group', request: 'relay_turn', model_label: 'Model B' }),
      run({ key: 'r3', parent: 'r1', role: 'child', request: 'child', started_by: 'agent', label: 'Child', status: 'cancelled', status_label: 'cancelled', error: 'stopped by the person' }),
      run({ key: 'r4', status: 'error', status_label: 'failed', error: 'provider said no (synthetic)' }),
    ],
    items,
    images: [],
    stats: { omitted: { ...zero(SHARE_OMISSION_KEYS), thinking: 1 }, redacted: { ...zero(SHARE_REDACTION_KEYS), email: 2 }, truncated_fields: 0, items_truncated: false },
    limits: { ...SHARE_LIMITS },
    ...over,
  })
}

const statsZero = () => ({ omitted: zero(SHARE_OMISSION_KEYS), redacted: zero(SHARE_REDACTION_KEYS), truncated_fields: 0, items_truncated: false })

/** A V2 snapshot of the actions taken beside the agents and of the person's words to a group's members, around one
 *  ordinary run: a ChatGPT command of several lines (its outcome kept), a checkpoint taken by hand, a command withheld
 *  as a sensitive source (no head, no text, its exit kept), an action of a run the snapshot does not list, a command
 *  whose record kept no text, a run a watch woke; group notes queued, partly delivered, delivered and undelivered, one
 *  to everyone. `details`: the export was made with tool details (the ChatGPT command then carries its measures and a
 *  cut preview). Synthetic: no real session, command output or secret. */
export function actionSnapshot(o: { details?: boolean } = {}): ShareSnapshotV2 {
  const details = o.details ?? false
  const at = (m: number) => `2026-10-22T03:${String(m).padStart(2, '0')}:00.000Z`
  const items: ShareItem[] = [
    { kind: 'message', key: 'i1', run: 'r1', at: at(0), author: 'person', author_label: 'Person', source: 'opening', text: 'Run the toy model', steer: null },
    { kind: 'message', key: 'i2', run: 'r1', at: at(1), author: 'assistant', author_label: 'Model A', source: 'answer', text: 'Ran it.', steer: null },
    { kind: 'action', key: 'i3', run: 'r2', at: at(2), action: 'command', actor: 'connector', what: 'command', by: 'ChatGPT', head: '$ python3 toy.py --seed 0 …', outcome: '→ exit 0',
      text: '$ python3 toy.py --seed 0\n  --steps 3\n→ exit 0', withheld: null,
      details: details ? { summary: null, fields: [{ name: 'exit_code', value: 0 }, { name: 'duration_ms', value: 812 }], preview: 'step 1 loss 0.9\nstep 2 loss 0.5', preview_truncated: true } : null },
    { kind: 'action', key: 'i4', run: 'r3', at: at(3), action: 'checkpoint', actor: 'person', what: 'checkpoint', by: null, head: 'checkpoint [id]: before the sweep', outcome: null, text: 'checkpoint [id]: before the sweep', details: null, withheld: null },
    { kind: 'action', key: 'i5', run: 'r4', at: at(4), action: 'command', actor: 'connector', what: 'command', by: 'ChatGPT', head: null, outcome: '→ exit 0', text: null, details: null, withheld: 'sensitive_source' },
    { kind: 'group', key: 'i6', group: 'g1', run: null, at: at(5), group_kind: 'interaction', author: 'person', author_label: 'Person', client: null, text: 'Review the toy model', status_label: 'done', participants: ['p1', 'p2'] },
    { kind: 'group_note', key: 'i7', run: null, at: at(6), group: 'g1', to: 'Reviewer', text: 'look at the seed too', status: 'delivered', delivered_to: ['Reviewer'] },
    { kind: 'group_note', key: 'i8', run: null, at: at(6), group: 'g1', to: null, text: 'keep it short', status: 'partly', delivered_to: ['Critic'] },
    { kind: 'group_note', key: 'i9', run: null, at: at(7), group: 'g1', to: 'Critic', text: 'one more thing', status: 'queued', delivered_to: [] },
    { kind: 'group_note', key: 'i10', run: null, at: at(7), group: 'g1', to: null, text: 'too late', status: 'undelivered', delivered_to: [] },
    { kind: 'action', key: 'i11', run: 'r9', at: null, action: 'other', actor: 'person', what: 'approved bash', by: null, head: 'approved proposal [id]: applied', outcome: null, text: 'approved proposal [id]: applied', details: null, withheld: null },
    { kind: 'action', key: 'i12', run: 'r5', at: at(8), action: 'command', actor: 'connector', what: 'command', by: 'connector', head: null, outcome: null, text: null, details: null, withheld: null },
    { kind: 'notice', key: 'i13', run: 'r6', at: at(9), code: 'woken_by_watch', text: 'Woken by a watch the agent set' },
    { kind: 'message', key: 'i14', run: 'r6', at: at(9), author: 'assistant', author_label: 'Model A', source: 'answer', text: 'The watch reported; all done.', steer: null },
  ]
  return ShapeCheck({
    format: 'oasis-code.session-share', version: 2, generated_at: at(30), title: 'Actions synthetic session',
    session: { created_at: at(0), last_activity_at: at(9), model_label: 'Model A' },
    options: { include_tool_details: details, include_images: false },
    participants: [{ key: 'p1', role: 'member', label: 'Reviewer', model_label: 'Model B' }, { key: 'p2', role: 'member', label: 'Critic', model_label: 'Model C' }],
    runs: [
      run({ key: 'r1' }),
      run({ key: 'r2', surface: 'record', started_by: 'harness', request: 'action', label: 'command (ChatGPT)', model_label: 'unknown model', role: null, started_at: at(2), finished_at: at(2) }),
      run({ key: 'r3', surface: 'record', started_by: 'harness', request: 'action', label: 'checkpoint (by hand)', model_label: 'unknown model', role: null, started_at: at(3), finished_at: at(3) }),
      run({ key: 'r4', surface: 'record', started_by: 'harness', request: 'action', label: 'command (ChatGPT)', model_label: 'unknown model', role: null, started_at: at(4), finished_at: at(4) }),
      run({ key: 'r5', surface: 'record', started_by: 'harness', request: 'action', label: 'command (connector)', model_label: 'unknown model', role: null, started_at: at(8), finished_at: at(8) }),
      run({ key: 'r6', started_by: 'watch', request: 'wake', started_at: at(9), finished_at: at(9) }),
    ],
    items,
    images: [],
    stats: { ...statsZero(), omitted: { ...zero(SHARE_OMISSION_KEYS), app_notes: 1, sensitive_tool_content: 1, tool_details: details ? 0 : 1 } },
    limits: { ...SHARE_LIMITS },
  })
}

/** A V1 snapshot as an earlier oasis-code wrote it (frozen schema): an ordinary run, a ChatGPT command and a checkpoint
 *  taken by hand recorded only as the `recorded_action` notice of their run (the label says what and who; their text
 *  was not carried), and a stray item of an action run. */
export function legacyV1Snapshot(): ShareSnapshotV1 {
  const at = (m: number) => `2026-10-20T03:${String(m).padStart(2, '0')}:00.000Z`
  const items: ShareItemV1[] = [
    { kind: 'message', key: 'i1', run: 'r1', at: at(0), author: 'person', author_label: 'Person', source: 'opening', text: 'An older export', steer: null },
    { kind: 'message', key: 'i2', run: 'r1', at: at(1), author: 'assistant', author_label: 'Model A', source: 'answer', text: 'Answered.', steer: null },
    { kind: 'notice', key: 'i3', run: 'r2', at: at(2), code: 'recorded_action', text: 'A recorded action of the person (no model ran)' },
    { kind: 'notice', key: 'i4', run: 'r3', at: null, code: 'recorded_action', text: 'A recorded action of the person (no model ran)' },
    { kind: 'notice', key: 'i5', run: 'r3', at: null, code: 'history_unavailable', text: 'stray of an action run' },
  ]
  return ShareSnapshotV1Schema.parse({
    format: 'oasis-code.session-share', version: 1, generated_at: at(30), title: 'Legacy synthetic session',
    session: { created_at: at(0), last_activity_at: at(2), model_label: 'Model A' },
    options: { include_tool_details: false, include_images: false },
    participants: [],
    runs: [
      run({ key: 'r1' }),
      run({ key: 'r2', surface: 'record', started_by: 'harness', request: 'action', label: 'command (ChatGPT)', model_label: 'unknown model', role: null, started_at: at(2), finished_at: at(2) }),
      run({ key: 'r3', surface: 'record', started_by: 'harness', request: 'action', label: 'checkpoint (by hand)', model_label: 'unknown model', role: null, started_at: null, finished_at: null }),
    ],
    items,
    images: [],
    stats: statsZero(),
    limits: { ...SHARE_LIMITS },
  })
}
