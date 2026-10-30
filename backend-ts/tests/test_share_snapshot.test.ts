/** POST /api/sessions/:id/share-snapshot (src/share/snapshot.ts): the strict projection of a quiescent session, from
 *  synthetic rows only — runs, histories, persisted events, steers, director turns and notes, relays, images. */

import { afterEach, expect, test } from 'bun:test'
import { ShareSnapshotResponseSchema, ShareSnapshotV2Schema, type ShareItem, type ShareSnapshotResponse, type SteerRecord } from '@oasis-code/contract'
import * as repo from '../src/db/repo.ts'
import { insertDirectorSession, insertTurn, updateTurn } from '../src/director/store.ts'
import { saveAttachment } from '../src/api/attachments.ts'
import { agentRouteAllowed } from '../src/policy/delegation.ts'
import type { App } from '../src/main.ts'
import type { AppState } from '../src/api/state.ts'
import { Client, json, makeApp } from './api_harness.ts'
import { buggyRepo } from './harness.ts'
import { solidPng } from './png_fixture.ts'
import { PROMPT_TEXT } from '../src/prompt_texts.ts'

// a synthetic user's name, put into its home path at run time: the committed source holds no literal home path for the
// repository's privacy scan to find (scripts/oss/lib/scan.mjs)
const ENV_HOME_USER = 'zed'

let app: App | null = null
afterEach(async () => { if (app) await app.close(); app = null })

type Rec = Record<string, unknown>
const MODEL = 'scripted:a'
const SECRET = 'SYNTH-SECRET-VALUE-42'
const GH = 'ghp_' + 'Z'.repeat(36)
const SHARE_LIMITS_TOTAL = 4_000_000

const req = (parts: Rec[]) => ({ kind: 'request', parts })
const resp = (parts: Rec[]) => ({ kind: 'response', parts, timestamp: new Date().toISOString() })
const user = (content: string, origin: 'person' | 'app' = 'person') => ({ part_kind: 'user-prompt', content, origin })
const text = (content: string) => ({ part_kind: 'text', content })
const call = (tool_name: string, args: Rec, tool_call_id: string) => ({ part_kind: 'tool-call', tool_name, args, tool_call_id })
const ret = (tool_name: string, content: unknown, tool_call_id: string) => ({ part_kind: 'tool-return', tool_name, content, tool_call_id })

async function open(c: Client) {
  const project = await json(await c.post('/api/projects', { source_path: buggyRepo() }))
  const session = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: `Share demo ${SECRET.slice(0, 5)} for test-token` }))
  return repo.getSession(app!.state.conn, session.id as string)!
}

/** A finished run with its record and its events (seq from 1). */
function addRun(state: AppState, session: ReturnType<typeof repo.getSession> & {}, o: {
  user_text: string; history?: unknown[] | string | null; events?: [string, Rec][]; status?: string; resumes_run_id?: string | null; error?: string | null; attachments?: unknown[]
  spawned_by?: string; relay_id?: string | null; relay_step?: number | null; model?: string
}): string {
  const run = repo.insertRun(state.conn, {
    session_id: session.id, project_id: session.project_id, workspace_id: session.workspace_id, model: o.model ?? MODEL, model_config: {}, user_text: o.user_text, status: 'running', budget: {},
    resumes_run_id: o.resumes_run_id ?? null, attachments: (o.attachments ?? []) as never, spawned_by: o.spawned_by ?? 'human', relay_id: o.relay_id ?? null, relay_step: o.relay_step ?? null,
  })
  let seq = 0
  for (const [event, data] of o.events ?? []) repo.insertEvent(state.conn, run.id, ++seq, event, data)
  const history = o.history === undefined ? null : typeof o.history === 'string' || o.history === null ? o.history : JSON.stringify(o.history)
  repo.finishRun(state.conn, run.id, o.status ?? 'done', { history_json: history, usage: {}, error: o.error ?? null, receipt: {}, saved_seq: seq })
  return run.id
}

function steer(runId: string, sessionId: string, over: Partial<SteerRecord>): SteerRecord {
  return { id: 'st_1', run_id: runId, session_id: sessionId, text: 'please also check README', client_request_id: 'k-12345678', status: 'delivered', queued_at: new Date().toISOString(),
    queued_seq: 1, delivered_at: new Date().toISOString(), delivered_seq: 2, request_index: 2, reason: null, ...over }
}

async function snapshot(c: Client, sessionId: string, body: Rec = {}): Promise<ShareSnapshotResponse> {
  const res = await c.post(`/api/sessions/${sessionId}/share-snapshot`, body)
  const parsed = ShareSnapshotResponseSchema.parse(await json(res))
  return parsed
}
const itemsOf = <K extends ShareItem['kind']>(s: ShareSnapshotResponse, kind: K) => s.snapshot.items.filter((i): i is Extract<ShareItem, { kind: K }> => i.kind === kind)

test('the route: strict body, 404, agent runs refused by the route table, the selection apart from the snapshot', async () => {
  app = await makeApp()
  const c = new Client(app)
  const session = await open(c)
  expect((await c.post('/api/sessions/s_nope/share-snapshot', {})).status).toBe(404)
  expect((await c.post(`/api/sessions/${session.id}/share-snapshot`, { include_images: true, extra: 1 })).status).toBe(422)
  expect((await c.post(`/api/sessions/${session.id}/share-snapshot`, { exclude_run_ids: ['not-a-run'] })).status).toBe(422)
  expect(agentRouteAllowed('POST', `/api/sessions/${session.id}/share-snapshot`)).toBe(false)
  const s = await snapshot(c, session.id)
  expect(s.snapshot.format).toBe('oasis-code.session-share')
  expect(s.snapshot.options).toEqual({ include_tool_details: false, include_images: false })
  // the title passed the sanitizer: the app's token (the suite's short one) is gone
  expect(s.snapshot.title).not.toContain('test-token')
  expect(Object.keys(s)).toEqual(['snapshot', 'selection'])
  expect(JSON.stringify(s.snapshot)).not.toContain('run_')
})

test('only a quiescent session is exported: a running run, and a queued director turn that is no one\'s current turn, answer 409', async () => {
  app = await makeApp()
  const c = new Client(app)
  const session = await open(c)
  const run = repo.insertRun(app.state.conn, { session_id: session.id, project_id: session.project_id, workspace_id: session.workspace_id, model: MODEL, model_config: {}, user_text: 'hi', status: 'running', budget: {} })
  const busy = await c.post(`/api/sessions/${session.id}/share-snapshot`, {})
  expect(busy.status).toBe(409)
  expect((await busy.json() as Rec).code).toBe('session_active')
  repo.finishRun(app.state.conn, run.id, 'done', { history_json: null, usage: {}, error: null, receipt: {}, saved_seq: 0 })
  expect((await c.post(`/api/sessions/${session.id}/share-snapshot`, {})).status).toBe(200)
  const ds = insertDirectorSession(app.state.conn, { session_id: session.id, transport: 'native', model: MODEL, label: 'Director', config: {} })
  const turn = insertTurn(app.state.conn, { director_session_id: ds.id, session_id: session.id, kind: 'user', input: 'plan it' })
  expect(ds.current_turn_id ?? null).toBeNull()
  expect((await c.post(`/api/sessions/${session.id}/share-snapshot`, {})).status).toBe(409)
  updateTurn(app.state.conn, turn.id, { status: 'awaiting_answer' })
  expect((await c.post(`/api/sessions/${session.id}/share-snapshot`, {})).status).toBe(409)
  updateTurn(app.state.conn, turn.id, { status: 'error', error: 'provider said no' })
  expect((await c.post(`/api/sessions/${session.id}/share-snapshot`, {})).status).toBe(200)
})

test('the conversation: own words only, partials kept, steers placed and attributed, hidden parts and secrets absent', async () => {
  app = await makeApp()
  const { state } = app
  const c = new Client(app)
  const session = await open(c)
  const ws = repo.getWorkspace(state.conn, session.workspace_id!)!
  // A: the person's message; the answer quotes the app token, a credential, a key shape and a path in the session's folder
  const aHistory = [
    req([{ part_kind: 'system-prompt', content: 'SYSTEM-PROMPT-HIDDEN' }, user('fix the bug')]),
    resp([{ part_kind: 'thinking', content: 'THINKING-HIDDEN' }, text(`Looking. The token test-token, password="${SECRET}" and ${GH} at ${ws.path}/src/calc.py.`), call('bash', { command: 'ls -la' }, 'c1')]),
    req([ret('bash', { status: 'ok', exit_code: 0, stdout: `calc.py\nREADME.md\nAPI_KEY=${SECRET}\n` }, 'c1')]),
    req([{ part_kind: 'user-prompt', content: 'please also check README', steer_id: 'st_1' }]),
    resp([text('Done: patched calc.py.')]),
  ]
  const a = addRun(state, session, {
    user_text: 'fix the bug', history: aHistory,
    events: [['tool_call', { tool: 'bash', tool_call_id: 'c1', summary: '{"command":"ls -la"}', command: 'ls -la' }],
      ['tool_result', { tool: 'bash', tool_call_id: 'c1', status: 'ok', exit_code: 0, execution_id: 'x_safe', summary: 'ok' }],
      ['steer_queued', { steer: steer('', session.id, { status: 'queued', delivered_at: null, delivered_seq: null, request_index: null, by: 'director' }) }],
      ['steer_delivered', { steer: steer('', session.id, { by: 'director' }) }]].map(([e, d]) => [e as string, fixSteerRun(d as Rec)]),
  })
  function fixSteerRun(d: Rec): Rec { return d }
  // the steer records name their run: rewrite them now that the run id is known
  state.conn.run("UPDATE run_events SET data_json=replace(data_json, '\"run_id\":\"\"', ?) WHERE run_id=?", [`"run_id":"${a}"`, a])
  // B continues A: its record holds A's messages first; its own words follow
  const b = addRun(state, session, { user_text: 'now add a test', resumes_run_id: a, history: [...aHistory, req([user('now add a test')]), resp([text('Added test_calc.py.')])] })
  // C: a reconnect kept a partial (record only) and asked for the rest; an output-limit cut joined too; a failed answer
  // asked again (app.no_answer) is a new answer; a stop kept a partial
  const cRun = addRun(state, session, {
    user_text: 'explain', status: 'cancelled',
    history: [req([user('explain')]), resp([text('The first half of the answer')]), req([user(`${PROMPT_TEXT['app.reconnected']} ${PROMPT_TEXT['app.cut_off']}`, 'app')]), resp([text(' and its second half,')]),
      req([user(`${PROMPT_TEXT['app.output_limit']} ${PROMPT_TEXT['app.cut_off']}`, 'app')]), resp([text(' cut and continued.')]),
      req([user('fix the next one too')]),
      resp([text('Provider error words')]), req([user(PROMPT_TEXT['app.no_answer'], 'app')]), resp([text('The retried answer.')]),
      req([user(PROMPT_TEXT['app.reconnected'], 'app')]), resp([text('Stopped partial words')])],
    events: [['run_continued', { reason: 'transport_error', kept_chars: 28 }], ['run_continued', { reason: 'output_limit', kept_chars: 50 }], ['run_continued', { reason: 'no_answer', kept_chars: 0 }]],
  })
  // D: no record at all: the events stand in — a kept continuation joined, the steer before the answer it led to
  const d = addRun(state, session, {
    user_text: 'summarize',
    events: [['text_block', { text: 'Part one, ' }], ['run_continued', { reason: 'output_limit', kept_chars: 10 }], ['text_block', { text: 'part two.' }],
      ['text_block', { text: 'Event error words' }], ['run_continued', { reason: 'no_answer', kept_chars: 0 }], ['text_block', { text: 'Event retried answer.' }],
      ['steer_delivered', { steer: { ...steer('', session.id, { id: 'st_d', text: 'shorter please', by: 'connector', client: 'ChatGPT' }) } }], ['text_block', { text: `Short answer ${GH} via test-token in ${ws.path}/x.ts.` }],
      ['thinking_block', { text: 'THINKING-EVENT-HIDDEN' }]],
  })
  state.conn.run("UPDATE run_events SET data_json=replace(data_json, '\"run_id\":\"\"', ?) WHERE run_id=?", [`"run_id":"${d}"`, d])
  // E: an environment dump (its output withheld whatever the options); F: a later run polls that execution's output
  const e = addRun(state, session, {
    user_text: 'what is set?',
    history: [req([user('what is set?')]), resp([call('bash', { command: '/usr/bin/env -0' }, 'e1')]), req([ret('bash', { status: 'ok', execution_id: 'x_env', stdout: `HOME=/Users/${ENV_HOME_USER}\nOPAQUE=${SECRET}` }, 'e1')]), resp([text('Listed.')])],
    events: [['tool_result', { tool: 'bash', tool_call_id: 'e1', status: 'ok', execution_id: 'x_env' }]],
  })
  const f = addRun(state, session, {
    user_text: 'show the rest', resumes_run_id: e,
    history: [...[req([user('what is set?')]), resp([call('bash', { command: '/usr/bin/env -0' }, 'e1')]), req([ret('bash', { status: 'ok', execution_id: 'x_env', stdout: 'x' }, 'e1')]), resp([text('Listed.')])],
      req([user('show the rest')]), resp([call('bash_output', { execution_id: 'x_env' }, 'f1')]), req([ret('bash_output', { status: 'ok', text: `OPAQUE=${SECRET}`, stdout: `OPAQUE=${SECRET}` }, 'f1')]), resp([text('That is all.')])],
  })
  // G: a long command whose sensitive part lies past the event's 300-character preview: the record's whole command decides
  const longCommand = `echo ${'harmless '.repeat(45)}; cat .env`
  addRun(state, session, {
    user_text: 'run the long one',
    history: [req([user('run the long one')]), resp([call('bash', { command: longCommand }, 'g1')]), req([ret('bash', { status: 'ok', execution_id: 'x_long', stdout: `OPAQUE_FROM_ENV_FILE=${SECRET}` }, 'g1')]), resp([text('Ran it.')])],
    events: [['tool_call', { tool: 'bash', tool_call_id: 'g1', command: longCommand.slice(0, 300) }], ['tool_result', { tool: 'bash', tool_call_id: 'g1', status: 'ok', execution_id: 'x_long' }]],
  })
  expect(longCommand.slice(0, 300)).not.toContain('.env')
  void cRun; void f

  for (const details of [false, true]) {
    const s = await snapshot(c, session.id, { include_tool_details: details })
    const all = JSON.stringify(s.snapshot)
    for (const hidden of ['test-token', SECRET, GH, 'SYSTEM-PROMPT-HIDDEN', 'THINKING-HIDDEN', 'THINKING-EVENT-HIDDEN', 'the connection dropped', ws.path, '{"command":"ls -la"}'])
      expect(all).not.toContain(hidden)
    const messages = itemsOf(s, 'message')
    const answers = messages.filter((m) => m.source === 'answer').map((m) => m.text)
    // A's answer, sanitized: the path became project-relative
    expect(answers.some((t) => t.includes('src/calc.py') && t.includes('password="[redacted]"'))).toBe(true)
    // B's own words once; A's are not repeated under B
    expect(messages.filter((m) => m.text === 'fix the bug').length).toBe(1)
    expect(messages.filter((m) => m.text.startsWith('Looking.')).length).toBe(1)
    expect(answers).toContain('Added test_calc.py.')
    // C: the reconnect's kept partial, its rest and an output-limit continuation joined as one answer; a failed answer and
    // its retry are two answers; a reconnect with nothing kept starts a new one; the stopped partial is kept
    expect(answers).toContain('The first half of the answer and its second half, cut and continued.')
    expect(answers).toContain('Provider error words')
    expect(answers).toContain('The retried answer.')
    expect(answers).toContain('Stopped partial words')
    // D (events only): the output-limit continuation joined; the connector's steer stands before the answer it led to
    expect(answers).toContain('Part one, part two.')
    expect(answers).toContain('Event error words')
    expect(answers).toContain('Event retried answer.')
    const dItems = s.snapshot.items.filter((i) => i.run === s.selection.runs.find((r) => r.run_id === d)!.key)
    const steerAt = dItems.findIndex((i) => i.kind === 'message' && i.source === 'steer')
    const shortAt = dItems.findIndex((i) => i.kind === 'message' && i.text.startsWith('Short answer'))
    expect(steerAt).toBeGreaterThan(-1)
    expect(steerAt).toBeLessThan(shortAt)
    const dSteer = dItems[steerAt] as Extract<ShareItem, { kind: 'message' }>
    expect(dSteer.author).toBe('connector')
    expect(dSteer.author_label).toBe('ChatGPT')
    expect(dSteer.steer).toEqual({ status: 'delivered', by: 'connector', client: 'ChatGPT', reason: null })
    // A's steer: one row (queued then delivered records), the director's, delivered — never the person's
    const aSteers = messages.filter((m) => m.source === 'steer' && m.text === 'please also check README')
    expect(aSteers.length).toBe(1)
    expect(aSteers[0]!.author).toBe('director')
    // the env dump and the later poll of its output are withheld; nothing of them is in the snapshot
    const tools = itemsOf(s, 'tool')
    expect(tools.filter((t) => t.withheld === 'sensitive_source').map((t) => t.name).sort()).toEqual(['bash', 'bash', 'bash_output'])
    for (const t of tools.filter((t) => t.withheld)) { expect(t.target).toBeNull(); expect(t.details).toBeNull() }
    const ls = tools.find((t) => t.target === 'ls -la')!
    if (details) {
      // the event kept no output: the preview is the record's return, sanitized, labelled as a preview
      expect(ls.details!.preview).toContain('calc.py')
      expect(ls.details!.preview).toContain('API_KEY=[redacted]')
      expect(ls.details!.fields).toContainEqual({ name: 'exit_code', value: 0 })
    } else expect(ls.details).toBeNull()
    expect(s.snapshot.stats.omitted.thinking).toBeGreaterThanOrEqual(2)
    expect(s.snapshot.stats.omitted.system_prompts).toBeGreaterThanOrEqual(1)
    expect(s.snapshot.stats.redacted.session_token).toBeGreaterThanOrEqual(1)
    expect(s.snapshot.stats.omitted.sensitive_tool_content).toBe(3)
    expect(all).not.toContain('OPAQUE_FROM_ENV_FILE')
    // relationships resolve: continues, every run key unique
    const runs = new Map(s.snapshot.runs.map((r) => [r.key, r]))
    expect(runs.get(s.selection.runs.find((r) => r.run_id === b)!.key)!.continues).toBe(s.selection.runs.find((r) => r.run_id === a)!.key)
    for (const item of s.snapshot.items) if (item.run !== null) expect(runs.has(item.run)).toBe(true)
    expect(ShareSnapshotV2Schema.safeParse(s.snapshot).success).toBe(true)
  }
  // an excluded run is absent, counted, and its continuation no longer names it
  const s = await snapshot(c, session.id, { exclude_run_ids: [a] })
  expect(s.snapshot.stats.omitted.runs_excluded).toBe(1)
  expect(s.snapshot.items.some((i) => i.kind === 'message' && i.text.startsWith('Looking.'))).toBe(false)
  expect(s.snapshot.runs.find((r) => r.key === s.selection.runs.find((x) => x.run_id === b)!.key)!.continues).toBeNull()
})

test('director turns and notes: one exchange each, failed questions kept, forwarded words said once; groups resolve by key', async () => {
  app = await makeApp()
  const { state } = app
  const c = new Client(app)
  const session = await open(c)
  const ds = insertDirectorSession(state.conn, { session_id: session.id, transport: 'native', model: MODEL, label: 'Director', config: {} })
  const asked = insertTurn(state.conn, { director_session_id: ds.id, session_id: session.id, kind: 'user', input: 'ctx\nplease plan the fix', envelope: { text: 'please plan the fix', attachments: [], mentions: [] } as never })
  const run = addRun(state, session, { user_text: 'please plan the fix', history: [req([user('please plan the fix')]), resp([text('Planned.')])] })
  const note = repo.insertDirectorNote(state.conn, session.id, { source: 'native', model: MODEL, question: 'please plan the fix', answer: `Dispatched one run; key ${GH}.`, turn_id: asked.id })
  updateTurn(state.conn, asked.id, { status: 'done', dispatched_run_ids: [run], note_id: note.id })
  const failed = insertTurn(state.conn, { director_session_id: ds.id, session_id: session.id, kind: 'user', input: 'and deploy?', envelope: { text: 'and deploy?', attachments: [], mentions: [] } as never })
  updateTurn(state.conn, failed.id, { status: 'error', error: 'provider error with Bearer abcdefgh' })
  repo.insertDirectorNote(state.conn, session.id, { source: 'ChatGPT', model: 'gpt', question: 'a mirrored question', answer: 'a mirrored answer' })
  const relay = repo.insertRelay(state.conn, { session_id: session.id, user_text: 'compare the two fixes', participants: [{ model: MODEL, label: 'A', id: 'A' }], steps: [], rounds: 1, thinking: null, budget: {}, mentions: [], attachments: [], client_request_id: null })
  // a relay that runs keeps the session from being exported; once it is done it is
  expect((await c.post(`/api/sessions/${session.id}/share-snapshot`, {})).status).toBe(409)
  state.conn.run("UPDATE relays SET status='done' WHERE id=?", [relay.id])
  const s = await snapshot(c, session.id)
  const notes = itemsOf(s, 'director_note')
  expect(notes.map((n) => [n.question, n.answer, n.status_label])).toEqual([
    ['please plan the fix', 'Dispatched one run; key [redacted].', 'Answered'],
    ['and deploy?', null, 'Failed'],
    ['a mirrored question', 'a mirrored answer', 'Answered'],
  ])
  expect(JSON.stringify(s.snapshot)).not.toContain('abcdefgh')
  // the run's words were the person's words to the director, handed on unchanged: said once, over the director's turn
  expect(itemsOf(s, 'message').some((m) => m.source === 'opening' && m.text === 'please plan the fix')).toBe(false)
  const groups = itemsOf(s, 'group')
  expect(groups.length).toBe(1)
  expect(groups[0]!.group).toBe('g1')
  expect(groups[0]!.author).toBe('person')
  expect(groups[0]!.text).toBe('compare the two fixes')
  for (const r of s.snapshot.runs) if (r.group !== null) expect(groups.some((g) => g.group === r.group)).toBe(true)
})

test('images: off by default, the session\'s own validated rasters when asked, another session\'s never read', async () => {
  app = await makeApp()
  const { state } = app
  const c = new Client(app)
  const session = await open(c)
  const other = repo.getSession(state.conn, (await json(await c.post(`/api/projects/${session.project_id}/sessions`, { title: 'other' }))).id as string)!
  const mine = saveAttachment(state, session, solidPng(8, 6, [10, 120, 200]), 'passport-of-someone.png')
  const theirs = saveAttachment(state, other, solidPng(4, 4, [200, 0, 0]), 'theirs.png')
  addRun(state, session, { user_text: 'look at these', attachments: [mine, theirs], history: [req([user('look at these')]), resp([text('Seen.')])] })
  const off = await snapshot(c, session.id)
  expect(itemsOf(off, 'image').map((i) => i.omitted)).toEqual(['images_off', 'images_off'])
  expect(off.snapshot.images).toEqual([])
  const on = await snapshot(c, session.id, { include_images: true })
  const items = itemsOf(on, 'image')
  expect(items.map((i) => i.omitted)).toEqual([null, 'missing'])
  expect(on.snapshot.images.length).toBe(1)
  const img = on.snapshot.images[0]!
  expect([img.media_type, img.width, img.height]).toEqual(['image/png', 8, 6])
  expect(Buffer.from(img.data_base64, 'base64').subarray(1, 4).toString()).toBe('PNG')
  expect(JSON.stringify(on.snapshot)).not.toContain('passport-of-someone')
  expect(on.snapshot.stats.omitted.images_missing).toBe(1)
})

test('an image at the item cap keeps no bytes; a director question\'s own images stand once; polling a cwd-relative credential read is withheld', async () => {
  app = await makeApp()
  const { state } = app
  const c = new Client(app)
  const session = await open(c)
  const asked = saveAttachment(state, session, solidPng(5, 5, [1, 2, 3]), 'asked.png')
  const ds = insertDirectorSession(state.conn, { session_id: session.id, transport: 'native', model: MODEL, label: 'Director', config: {} })
  const turn = insertTurn(state.conn, { director_session_id: ds.id, session_id: session.id, kind: 'user', input: 'see this', envelope: { text: 'see this', attachments: [asked.asset_id], mentions: [] } as never })
  updateTurn(state.conn, turn.id, { status: 'cancelled' })
  // a command in a folder that is a credential store, polled later by another run
  addRun(state, session, {
    user_text: 'read it',
    history: [req([user('read it')]), resp([call('bash', { command: 'cat config', cwd: '/home/x/.aws' }, 'k1')]), req([ret('bash', { status: 'running', execution_id: 'x_aws' }, 'k1')])],
  })
  addRun(state, session, {
    user_text: 'poll',
    history: [req([user('poll')]), resp([call('bash_output', { execution_id: 'x_aws' }, 'k2')]), req([ret('bash_output', { status: 'ok', stdout: `aws_secret=${SECRET}` }, 'k2')])],
  })
  const s = await snapshot(c, session.id, { include_images: true, include_tool_details: true })
  expect(itemsOf(s, 'director_note')[0]!.status_label).toBe('Cancelled')
  const img = itemsOf(s, 'image')
  expect(img.length).toBe(1)
  expect(img[0]!.image).toBe('img1')
  expect(itemsOf(s, 'tool').map((t) => t.withheld)).toEqual(['sensitive_source', 'sensitive_source'])
  expect(JSON.stringify(s.snapshot)).not.toContain(SECRET)
  // fill to exactly max_items with tool rows, then an image: the image item is not emitted and no bytes are kept
  const many: unknown[] = [req([user('fill')])]
  // the fill run's opening words and its tool rows take the snapshot to exactly max_items
  const filler = s.snapshot.limits.max_items - s.snapshot.items.length - 1
  for (let i = 0; i < filler; i++) { many.push(resp([call('read_file', { path: `f${i}.txt` }, `t${i}`)])); many.push(req([ret('read_file', { status: 'ok' }, `t${i}`)])) }
  addRun(state, session, { user_text: 'fill', history: many })
  // the next item would be an image (a run with no words of its own, one attachment)
  const late = saveAttachment(state, session, solidPng(6, 6, [9, 9, 9]), 'late.png')
  addRun(state, session, { user_text: '', attachments: [late] })
  const capped = await snapshot(c, session.id, { include_images: true })
  expect(capped.snapshot.items.length).toBe(capped.snapshot.limits.max_items)
  const referenced = new Set(itemsOf(capped, 'image').map((i) => i.image).filter((k): k is string => k !== null))
  expect(capped.snapshot.images.length).toBe(1)
  expect(capped.snapshot.images.every((i) => referenced.has(i.key))).toBe(true)
  expect(capped.snapshot.stats.items_truncated).toBe(true)
})

test('an image the total text budget no longer takes keeps no bytes', async () => {
  app = await makeApp()
  const { state } = app
  const c = new Client(app)
  const session = await open(c)
  const size = (v: unknown): number => typeof v === 'string' ? v.length : Array.isArray(v) ? v.reduce((n: number, x) => n + size(x), 0) : v && typeof v === 'object' ? Object.values(v).reduce((n: number, x) => n + size(x), 0) : 0
  const used = async () => size((await snapshot(c, session.id)).snapshot.items)
  const answers = (n: number, chars: number) => { const h: unknown[] = []; for (let i = 0; i < n; i++) { h.push(req([user(i === 0 ? 'go' : 'more', i === 0 ? 'person' : 'app')])); h.push(resp([text('x'.repeat(chars))])) } return h }
  const budget = SHARE_LIMITS_TOTAL
  // fill most of the budget, then measure what one answer row costs beside its words, then fill to 10 characters short
  addRun(state, session, { user_text: '', history: answers(20, 199_000) })
  const before = await used()
  addRun(state, session, { user_text: '', history: [req([user('go')]), resp([text('y'.repeat(1_000))])] })
  const overhead = (await used()) - before - 1_000
  const remaining = budget - before - (overhead + 1_000)
  addRun(state, session, { user_text: '', history: [req([user('go')]), resp([text('z'.repeat(remaining - overhead - 10))])] })
  expect(budget - (await used())).toBe(10)
  // the next item is an image (a run with no words of its own): its item costs more than 10 characters
  const late = saveAttachment(state, session, solidPng(6, 6, [9, 9, 9]), 'late.png')
  addRun(state, session, { user_text: '', attachments: [late] })
  const s = await snapshot(c, session.id, { include_images: true })
  expect(itemsOf(s, 'image').length).toBe(0)
  expect(s.snapshot.images).toEqual([])
  expect(s.snapshot.stats.items_truncated).toBe(true)
}, 120_000)

test('unreadable or inconsistent records fall back to the events; a huge record is truncated explicitly, never a 500', async () => {
  app = await makeApp()
  const { state } = app
  const c = new Client(app)
  const session = await open(c)
  addRun(state, session, { user_text: 'one', history: '[null]', events: [['text_block', { text: 'from the events' }]] })
  addRun(state, session, { user_text: 'two', history: JSON.stringify([{ kind: 'response', parts: [null, text('kept despite a null part')] }]) })
  const s = await snapshot(c, session.id)
  expect(itemsOf(s, 'message').map((m) => m.text)).toContain('from the events')
  expect(itemsOf(s, 'message').map((m) => m.text)).toContain('kept despite a null part')
  expect(s.snapshot.stats.omitted.histories_unreadable).toBe(1)
  // 6 000 tool calls in one record: past max_items the snapshot says it was cut
  const many: unknown[] = [req([user('loop')])]
  for (let i = 0; i < 6_000; i++) { many.push(resp([call('read_file', { path: `f${i}.txt` }, `t${i}`)])); many.push(req([ret('read_file', { status: 'ok' }, `t${i}`)])) }
  addRun(state, session, { user_text: 'loop', history: many })
  const big = await snapshot(c, session.id)
  expect(big.snapshot.items.length).toBe(big.snapshot.limits.max_items)
  expect(big.snapshot.stats.items_truncated).toBe(true)
})

test('main runs on different models: each answer is named by the model that ran it, never by the session\'s current model', async () => {
  app = await makeApp()
  const { state } = app
  const c = new Client(app)
  const session = await open(c)
  addRun(state, session, { user_text: 'first on A', model: 'scripted:a', history: [req([user('first on A')]), resp([text('answer from A')])] })
  addRun(state, session, { user_text: 'then on B', model: 'scripted:b', history: [req([user('then on B')]), resp([text('answer from B')])] })
  // the session now runs on B: the graph's main participant is labelled with B
  repo.setSessionModel(state.conn, session.id, 'scripted:b')
  const s = await snapshot(c, session.id)
  const answers = itemsOf(s, 'message').filter((m) => m.author === 'assistant').map((m) => [m.text, m.author_label])
  expect(answers).toEqual([['answer from A', 'Scripted A'], ['answer from B', 'Scripted B']])
  expect(s.snapshot.runs.map((r) => r.model_label)).toEqual(['Scripted A', 'Scripted B'])
  const main = s.snapshot.participants.filter((p) => p.role === 'main')
  expect(main.map((p) => [p.label, p.model_label])).toEqual(main.map(() => ['Main agent', null]))
})
