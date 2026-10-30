/** Schema v25 on a pre-v25 record (docs/multi-agent-unification-design.md §9; docs/multi-agent-baseline-audit.md §7–8):
 *  an offline, synthetic v24 database holding the history patterns the owner's record is said to hold — the main
 *  thread with a fresh break and a run that kept no record, a director's planned isolated interaction (a received
 *  step, a step run again, notes, an adoption), follow-ups of a participant that lost their interaction (the P1
 *  orphans: on its own copy, and in place), a legacy in-place step the thread then continued, a relay with a long
 *  answer cut in its packet and the thread after it, a wake and a UI task, a pre-v12 child run, a resume of a run the
 *  record no longer has, and 43 separate tasks across four sessions (some inside a bridge director's turn, some
 *  followed up). Migrated by the real migration, read through the real API: no row is changed, every run has exactly
 *  one participant and conversation, every heuristic is named, the graph is the same each time it is read.
 *
 *  SYNTHETIC: none of this is the owner's database (nothing under ~/.oasis-code is read); a real copy was not
 *  available, so the projection is NOT verified against a real database. */

import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { CollaborationGraph } from '@oasis-code/contract'
import { connect } from '../src/db/database.ts'
import { dumpJson, modelRequest, modelResponse, textPart, userPrompt, type ModelMessage } from '../src/llm/messages.ts'
import { Client, json, makeApp } from './api_harness.ts'
import { testSettings } from './harness.ts'
import { tempDir } from './helpers.ts'

const t = (n: number) => `2026-09-01T00:${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}.000Z`

function rowsHash(db: Database, table: string, order: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const row of db.query(`SELECT * FROM ${table} ORDER BY ${order}`).all() as Record<string, unknown>[]) {
    out[String(row.id ?? `${row.interaction_id}/${row.id}`)] = createHash('sha256').update(JSON.stringify(row)).digest('hex')
  }
  return out
}

/** A v24 database: the current schema with v25's additions taken back out, at user_version 24. */
function v24Database(path: string): Database {
  connect(path).close()
  const db = new Database(path)
  db.exec(`DROP TABLE run_collab; DROP TABLE participants; DROP TABLE conversations; DROP TABLE collab_edges;
    ALTER TABLE interaction_nodes DROP COLUMN receive_runs_json; ALTER TABLE interaction_nodes DROP COLUMN cites_json;
    ALTER TABLE interaction_nodes DROP COLUMN message_json; ALTER TABLE interaction_nodes DROP COLUMN kind; PRAGMA user_version = 24;`)
  return db
}

interface RunRow { id: string; session: string; ws: string | null; at: number; text?: string; answer?: string; status?: string; resumes?: string | null; spawned?: string; label?: string | null
  order?: Record<string, unknown> | null; key?: string | null; relay?: [string, number] | null; node?: [string, string] | null; parent?: string | null; empty?: boolean }

function fill(db: Database, root: string): void {
  // each run's record holds the conversation it continued and its own exchange (as the runner writes it): the
  // inherited part is the nearest earlier record up its resume chain (a run that kept none is passed over)
  const records = new Map<string, ModelMessage[]>()
  const inherited = (id: string | null | undefined): ModelMessage[] => {
    for (let at = id ?? null, seen = 0; at !== null && seen < 100; seen++) {
      const kept = records.get(at)
      if (kept && kept.length) return kept
      at = parents.get(at) ?? null
    }
    return []
  }
  const parents = new Map<string, string | null>()
  const run = (r: RunRow) => {
    const text = r.text ?? `asked ${r.id}`
    const answer = r.answer ?? `answer of ${r.id}`
    parents.set(r.id, r.resumes ?? null)
    const own: ModelMessage[] = [modelRequest([userPrompt(text)]), modelResponse([textPart(answer)])]
    const record = r.empty ? [] : [...inherited(r.resumes), ...own]
    records.set(r.id, record)
    db.run(`INSERT INTO runs (id, session_id, project_id, workspace_id, parent_run_id, resumes_run_id, spawned_by, label, model, model_config_json, user_text, status, history_json,
      usage_json, manifest_json, budget_json, receipt_json, error, created_at, finished_at, saved_seq, work_order_json, attachments_json, client_request_id, relay_id, relay_step, interaction_id, interaction_node)
      VALUES (?,?,?,?,?,?,?,?,?,'{}',?,?,?,'{}',?,'{}',?,NULL,?,?,0,?,'[]',?,?,?,?,?)`, [
      r.id, r.session, 'p_fx', r.ws, r.parent ?? null, r.resumes ?? null, r.spawned ?? 'human', r.label ?? null, 'scripted:a', text, r.status ?? 'done',
      r.empty ? '[]' : dumpJson(record), JSON.stringify({ tools: ['read_file', 'write_file'], tool_schema_sha256: 'v24-build' }),
      JSON.stringify({ final_text: answer }), t(r.at), t(r.at + 1), r.order ? JSON.stringify(r.order) : null, r.key ?? null,
      r.relay?.[0] ?? null, r.relay?.[1] ?? null, r.node?.[0] ?? null, r.node?.[1] ?? null,
    ])
  }
  db.run(`INSERT INTO projects (id, name, base_repo_path, created_at, updated_at, kind) VALUES ('p_fx', 'fixture', ?, ?, ?, 'snapshot')`, [join(root, 'repo'), t(0), t(0)])
  const sessions = ['s_main', 's_sep1', 's_sep2', 's_sep3', 's_sep4', 's_child']
  for (const [i, s] of sessions.entries()) {
    db.run(`INSERT INTO sessions (id, project_id, title, workspace_id, model, created_at, updated_at) VALUES (?, 'p_fx', ?, ?, 'scripted:a', ?, ?)`, [s, s, `ws_${s}`, t(i), t(i)])
    db.run(`INSERT INTO workspaces (id, project_id, session_id, path, branch, base_commit, kind, created_at) VALUES (?, 'p_fx', ?, ?, 'main', 'c0', 'task', ?)`, [`ws_${s}`, s, join(root, s), t(i)])
  }
  for (const w of ['ws_a', 'ws_b', 'ws_sepchild']) db.run(`INSERT INTO workspaces (id, project_id, session_id, path, branch, base_commit, kind, created_at, source_mount_json) VALUES (?, 'p_fx', 's_main', ?, 'b', 'c0', 'child', ?, NULL)`, [w, join(root, w), t(5)])
  // the native director of s_main and its turn that planned ix_plan
  db.run(`INSERT INTO director_sessions (id, session_id, transport, model, label, state, config_json, created_at, updated_at) VALUES ('ds_native', 's_main', 'native', 'scripted:d', 'Director', 'idle', '{}', ?, ?)`, [t(1), t(1)])
  db.run(`INSERT INTO director_turns (id, director_session_id, session_id, seq, kind, input, status, tool_calls_json, dispatched_json, created_at, started_at, finished_at, dispatched_interactions_json)
    VALUES ('dt_plan', 'ds_native', 's_main', 1, 'user', 'plan it', 'done', '[]', '["run_a1","run_b1","run_a2x","run_a2"]', ?, ?, ?, '["ix_plan"]')`, [t(20), t(20), t(60)])
  // the main thread: T1 ← T2 ← T3 (kept no record) ← T4; T5 fresh
  run({ id: 'run_t1', session: 's_main', ws: 'ws_s_main', at: 10, key: 'k-t1-000001' })
  run({ id: 'run_t2', session: 's_main', ws: 'ws_s_main', at: 12, resumes: 'run_t1', key: 'k-t2-000001' })
  run({ id: 'run_t3', session: 's_main', ws: 'ws_s_main', at: 14, resumes: 'run_t2', key: 'k-t3-000001', empty: true, status: 'error' })
  run({ id: 'run_t4', session: 's_main', ws: 'ws_s_main', at: 16, resumes: 'run_t3', key: 'k-t4-000001' })
  // the director's planned isolated interaction: a1, b1; a2 after both, receiving b1, run again once (a2x → a2)
  db.run(`INSERT INTO interactions (id, session_id, status, user_text, participants_json, controller, template, then_action, revision, budget_json, runs_started, base_checkpoint_id, resumes_run_id,
    director_session_id, created_at, updated_at, finished_at, workspace_policy, source_turn_id) VALUES ('ix_plan', 's_main', 'done', 'compare', ?, 'director', NULL, 'stop', 1, '{"max_runs":8,"concurrency":2}', 4, 'cp_base', 'run_t4', 'ds_native', ?, ?, ?, 'isolated', 'dt_plan')`,
    [JSON.stringify([{ id: 'pt_a', label: 'Alpha', model: 'scripted:a' }, { id: 'pt_b', label: 'Beta', model: 'scripted:a' }]), t(20), t(60), t(60)])
  const node = (id: string, p: string, deps: string[], receives: string[], runIds: string[], ws: string) => db.run(`INSERT INTO interaction_nodes (interaction_id, id, seq, participant, depends_on_json, receives_json, workspace, status, run_id, run_ids_json, workspace_id, revision, created_at, updated_at)
    VALUES ('ix_plan', ?, ?, ?, ?, ?, 'own', 'done', ?, ?, ?, 1, ?, ?)`, [id, runIds.length, p, JSON.stringify(deps), JSON.stringify(receives), runIds.at(-1)!, JSON.stringify(runIds), ws, t(20), t(60)])
  run({ id: 'run_a1', session: 's_main', ws: 'ws_a', at: 21, resumes: 'run_t4', node: ['ix_plan', 'a1'] })
  run({ id: 'run_b1', session: 's_main', ws: 'ws_b', at: 22, resumes: 'run_t4', node: ['ix_plan', 'b1'], answer: 'B1 SAID THIS' })
  run({ id: 'run_a2x', session: 's_main', ws: 'ws_a', at: 30, resumes: 'run_a1', node: ['ix_plan', 'a2'], status: 'error', text: 'App note:\nStep a2\n\nStep b1 (pt_b, run run_b1):\nB1 SAID THIS\nMeasured: status done.' })
  run({ id: 'run_a2', session: 's_main', ws: 'ws_a', at: 33, resumes: 'run_a2x', node: ['ix_plan', 'a2'], text: 'App note: Continue step a2 as pt_a.' })
  node('a1', 'pt_a', [], [], ['run_a1'], 'ws_a')
  node('b1', 'pt_b', [], [], ['run_b1'], 'ws_b')
  node('a2', 'pt_a', ['a1', 'b1'], ['b1'], ['run_a2x', 'run_a2'], 'ws_a')
  db.run(`INSERT INTO interaction_notes (id, interaction_id, to_participant, text, status, delivered_json, created_at, updated_at) VALUES ('note_1', 'ix_plan', 'pt_a', 'mind the edge case', 'delivered', '{"pt_a":"run_a2x"}', ?, ?)`, [t(25), t(30)])
  db.run(`INSERT INTO interaction_events (interaction_id, seq, kind, actor, payload_json, created_at) VALUES ('ix_plan', 1, 'adopted', 'person', '{"node":"b1","checkpoint_id":"cp_b1","status":"integrated","composed_checkpoint_id":"cp_c"}', ?)`, [t(61)])
  run({ id: 'run_adopt', session: 's_main', ws: 'ws_s_main', at: 61, spawned: 'human_action', label: 'adopt b1' })
  // P1 orphans: follow-ups of pt_a that lost the interaction — on its own copy (no key: a card), then again
  run({ id: 'run_f1', session: 's_main', ws: 'ws_a', at: 70, resumes: 'run_a2', text: 'more from A' })
  run({ id: 'run_f2', session: 's_main', ws: 'ws_a', at: 72, resumes: 'run_f1', text: 'still more from A' })
  // a legacy in-place interaction (its step on the session's folder), a follow-up of it from the page (H2a), and the
  // thread's next message, which continued the step's conversation (participant_change)
  db.run(`INSERT INTO interactions (id, session_id, status, user_text, participants_json, controller, template, then_action, revision, budget_json, runs_started, created_at, updated_at, finished_at, workspace_policy)
    VALUES ('ix_inplace', 's_main', 'done', 'in place', ?, 'fixed', 'independent', 'stop', 1, '{"max_runs":4,"concurrency":1}', 1, ?, ?, ?, 'legacy')`, [JSON.stringify([{ id: 'A', label: 'A', model: 'scripted:a' }]), t(80), t(82), t(82)])
  db.run(`INSERT INTO interaction_nodes (interaction_id, id, seq, participant, depends_on_json, receives_json, workspace, status, run_id, run_ids_json, workspace_id, revision, created_at, updated_at)
    VALUES ('ix_inplace', 'a1', 1, 'A', '[]', '[]', 'shared', 'done', 'run_s1', '["run_s1"]', 'ws_s_main', 1, ?, ?)`, [t(80), t(82)])
  run({ id: 'run_s1', session: 's_main', ws: 'ws_s_main', at: 81, resumes: 'run_t4', node: ['ix_inplace', 'a1'] })
  run({ id: 'run_s1f', session: 's_main', ws: 'ws_s_main', at: 84, resumes: 'run_s1', text: 'a word to A only' })
  run({ id: 'run_t5', session: 's_main', ws: 'ws_s_main', at: 86, resumes: 'run_s1', key: 'k-t5-000001' })
  // a relay of A and B: B's turn hands A's long answer, cut at the packet limit; then the thread after it
  db.run(`INSERT INTO relays (id, session_id, status, user_text, participants_json, steps_json, rounds, round, current_step, created_at, updated_at, finished_at, resumes_run_id)
    VALUES ('relay_1', 's_main', 'done', 'take turns', ?, ?, 1, 1, 1, ?, ?, ?, 'run_t5')`, [JSON.stringify([{ id: 'A', model: 'scripted:a', label: 'A' }, { id: 'B', model: 'scripted:a', label: 'B' }]),
    JSON.stringify([{ seq: 0, round: 1, participant: 0, status: 'done', run_id: 'run_r0', run_ids: ['run_r0'] }, { seq: 1, round: 1, participant: 1, status: 'done', run_id: 'run_r1', run_ids: ['run_r1'] }]), t(90), t(95), t(95)])
  run({ id: 'run_r0', session: 's_main', ws: 'ws_s_main', at: 90, resumes: 'run_t5', relay: ['relay_1', 0], key: 'k-relay-0001', answer: 'L'.repeat(30_000) })
  run({ id: 'run_r1', session: 's_main', ws: 'ws_s_main', at: 92, resumes: 'run_t5', relay: ['relay_1', 1], text: `App note: Turn 2\n\nTurn 1 (A, run run_r0):\n${'L'.repeat(24_000)}\n[The answer continues for 6000 more characters; they are in run run_r0.]\nMeasured: status done.` })
  run({ id: 'run_t6', session: 's_main', ws: 'ws_s_main', at: 96, resumes: 'run_r1', key: 'k-t6-000001' })
  // a wake, a UI task, a fresh break, a resume of a run the record does not have
  db.run(`INSERT INTO watches (id, session_id, run_id, spec_json, note, summary, status, repeats, cooldown_s, max_fires, fires, expires_at, created_at, updated_at) VALUES ('w_1', 's_main', 'run_t6', '{}', 'n', 's', 'ended', 0, 0, 1, 1, ?, ?, ?)`, [t(200), t(97), t(99)])
  run({ id: 'run_wake', session: 's_main', ws: 'ws_s_main', at: 100, resumes: 'run_t6', spawned: 'wake', key: 'wake:e1-000001' })
  db.run(`INSERT INTO wake_events (id, watch_id, session_id, kind, detail, status, run_id, created_at) VALUES ('we_1', 'w_1', 's_main', 'fired', 'd', 'delivered', 'run_wake', ?)`, [t(99)])
  run({ id: 'run_ui', session: 's_main', ws: 'ws_s_main', at: 104, resumes: 'run_wake', key: 'ui:task-000001' })
  db.run(`INSERT INTO ui_tasks (id, session_id, surface_run_id, surface_id, revision, action_id, request_id, payload_sha, prompt, agent_run_id, status, created_at, updated_at)
    VALUES ('uit_1', 's_main', 'run_t6', 'sf', 1, 'go', 'req', 'sha', 'p', 'run_ui', 'succeeded', ?, ?)`, [t(103), t(105)])
  run({ id: 'run_fresh', session: 's_main', ws: 'ws_s_main', at: 108, key: 'k-fresh-0001' })
  run({ id: 'run_dangling', session: 's_main', ws: 'ws_s_main', at: 110, resumes: 'run_gone', key: 'k-dangle-001' })
  // 43 separate tasks over four sessions; the first session's ChatGPT bridge held a turn while some were sent
  db.run(`INSERT INTO director_sessions (id, session_id, transport, model, label, state, config_json, created_at, updated_at) VALUES ('ds_bridge', 's_sep1', 'bridge', 'chatgpt', 'ChatGPT', 'idle', '{}', ?, ?)`, [t(200), t(200)])
  db.run(`INSERT INTO director_turns (id, director_session_id, session_id, seq, kind, input, status, created_at, started_at, finished_at) VALUES ('dt_bridge', 'ds_bridge', 's_sep1', 1, 'user', 'do them', 'done', ?, ?, ?)`, [t(200), t(200), t(230)])
  const counts = [11, 11, 11, 10]
  let at = 200
  for (const [i, n] of counts.entries()) {
    for (let k = 0; k < n; k++) {
      const id = `run_sep${i + 1}_${k}`
      run({ id, session: `s_sep${i + 1}`, ws: k % 3 === 0 ? `ws_s_sep${i + 1}` : `ws_s_sep${i + 1}`, at: at++, spawned: 'connector', label: 'ChatGPT', order: { version: 3, prompt: `task ${k}`, label: `task ${k}` } })
      if (k % 4 === 0) run({ id: `${id}_fu`, session: `s_sep${i + 1}`, ws: `ws_s_sep${i + 1}`, at: at++, resumes: id, spawned: 'human', order: { version: 3, prompt: 'more', label: `task ${k}`, resumes_run_id: id } })
    }
  }
  // a pre-v12 child run (the run tree that no longer exists)
  run({ id: 'run_parent', session: 's_child', ws: 'ws_s_child', at: 400 })
  run({ id: 'run_child', session: 's_child', ws: 'ws_sepchild', at: 402, parent: 'run_parent', spawned: 'run:run_parent' })
}

test('a synthetic v24 record of every pre-v25 pattern migrates without a changed row; its graph is projected, deterministic, and names every heuristic', async () => {
  const settings = testSettings()
  mkdirSync(settings.data_dir, { recursive: true })
  // the in-place step's folder (a direct workspace in the fixture's session is not needed: its rows are only read)
  const root = tempDir('oasis-fixture-')
  const raw = v24Database(settings.db_path)
  fill(raw, root)
  const before = { runs: rowsHash(raw, 'runs', 'id'), turns: rowsHash(raw, 'director_turns', 'id'), relays: rowsHash(raw, 'relays', 'id'), notes: rowsHash(raw, 'interaction_notes', 'id') }
  const histories = Object.fromEntries((raw.query('SELECT id, history_json, receipt_json, manifest_json FROM runs').all() as Record<string, string>[]).map((r) => [r.id, createHash('sha256').update(`${r.history_json}|${r.receipt_json}|${r.manifest_json}`).digest('hex')]))
  raw.close()
  const app = await makeApp(settings)
  try {
    expect(existsSync(`${settings.db_path}.v24.bak`)).toBe(true)                               // the copy before the upgrade
    const c = new Client(app)
    const read = async (sid: string) => json<CollaborationGraph>(await c.get(`/api/sessions/${sid}/collaboration`))
    const g = await read('s_main')
    expect(JSON.stringify(await read('s_main'))).toBe(JSON.stringify(g))                       // the same rows, the same graph
    const of = (id: string) => g.runs.find((r) => r.id === id)!.collab
    const participant = (id: string) => g.participants.find((p) => p.id === of(id).participant_id)!
    // every run: one participant and one conversation (a person's action: neither)
    for (const r of g.runs) {
      if (r.id === 'run_adopt') { expect(r.collab).toMatchObject({ participant_id: null, conversation_id: null, placement: { surface: 'record' } }); continue }
      expect(r.collab.participant_id).not.toBeNull()
      expect(g.conversations.filter((cv) => cv.run_ids.includes(r.id))).toHaveLength(1)
      expect(['projected', 'inferred']).toContain(r.collab.basis)
    }
    // the thread: T1..T4 one conversation (T3 kept no record), the fresh break a new one
    expect(of('run_t4').conversation_id).toBe(of('run_t1').conversation_id)
    expect(of('run_fresh').conversation_id).not.toBe(of('run_t1').conversation_id)
    expect(of('run_t1').participant_id).toBe(g.main_participant_id)
    // the planned interaction: members, a received packet by exact run, the waits, a step run again, the director's dispatch
    expect(participant('run_a1')).toMatchObject({ role: 'member', alias: 'pt_a', label: 'Alpha', group: { kind: 'interaction', id: 'ix_plan' } })
    expect(of('run_a2').origin.request).toBe('node_retry')
    expect(g.edges.find((e) => e.kind === 'received' && e.to.id === 'run_a2x')).toMatchObject({ from: { id: 'run_b1' }, basis: 'projected', meta: { via: 'node_receives', packet: 'whole', node: 'b1', content_delivered: true } })
    expect(g.edges.filter((e) => e.kind === 'after' && e.to.id === 'run_a2x').map((e) => e.from.id).sort()).toEqual(['run_a1', 'run_b1'])
    expect(g.edges.some((e) => e.kind === 'dispatched' && e.from.id === 'dt_plan' && e.to.id === 'run_a1')).toBe(true)
    expect(g.edges.some((e) => e.kind === 'note' && e.from.id === 'note_1' && e.to.id === 'run_a2x')).toBe(true)
    expect(g.edges.some((e) => e.kind === 'adopted' && e.from.id === 'run_b1')).toBe(true)
    // a step is the scheduler's; the plan it is a step of is the director's turn's
    expect(of('run_a1').origin).toMatchObject({ actor: 'scheduler', request: 'node', interaction_id: 'ix_plan' })
    expect(g.groups.find((x) => x.id === 'ix_plan')).toMatchObject({ origin: { actor: 'director', director_turn_id: 'dt_plan' }, anchor: { kind: 'director_turn', id: 'dt_plan' } })
    // the P1 orphans: pt_a's own follow-ups (H1: its own copy, no key), one conversation with its steps
    expect(of('run_f1').participant_id).toBe(of('run_a1').participant_id)
    expect(of('run_f2').participant_id).toBe(of('run_a1').participant_id)
    expect(of('run_f2').conversation_id).toBe(of('run_a2').conversation_id)
    expect(of('run_f1').placement).toMatchObject({ surface: 'group', group: { kind: 'interaction', id: 'ix_plan' } })
    // in place: the page's follow-up of A is A's (H2a, inferred); the thread's next message is the main agent's, a fork
    expect(of('run_s1f')).toMatchObject({ participant_id: of('run_s1').participant_id, basis: 'inferred' })
    expect(of('run_t5').participant_id).toBe(g.main_participant_id)
    expect(g.edges.find((e) => e.kind === 'forks' && e.to.id === 'run_t5')).toMatchObject({ from: { id: 'run_s1' }, meta: { reason: 'participant_change' } })
    // the relay: its turns members of it, the cut packet said so, the thread after it a fork of the last turn
    expect(participant('run_r1')).toMatchObject({ role: 'member', alias: 'B', group: { kind: 'relay', id: 'relay_1' } })
    expect(g.edges.find((e) => e.kind === 'received' && e.to.id === 'run_r1')).toMatchObject({ from: { id: 'run_r0' }, meta: { via: 'relay_turn', packet: 'cut', handed_chars: 24_000, answer_chars: 30_000 } })
    expect(g.edges.find((e) => e.kind === 'forks' && e.to.id === 'run_t6')).toMatchObject({ meta: { reason: 'participant_change' } })
    // a wake and a UI task are the main agent's, their origins said
    expect(of('run_wake').origin).toMatchObject({ actor: 'watch', request: 'wake', watch_id: 'w_1' })
    expect(of('run_ui').origin).toMatchObject({ actor: 'ui_task', ui_task_id: 'uit_1' })
    // a resume of a run the record does not have: shown as starting there, and said so
    expect(g.legacy.notes.some((n) => n.includes('run_gone'))).toBe(true)
    expect(g.legacy.inferred_facts).toBeGreaterThan(0)
    expect(g.legacy.projected_runs).toBe(g.runs.length)
    // 43 separate tasks over four sessions: one participant each (a follow-up keeps its task's), a card each
    let separates = 0
    for (const sid of ['s_sep1', 's_sep2', 's_sep3', 's_sep4']) {
      const gs = await read(sid)
      const tasks = gs.participants.filter((p) => p.role === 'separate')
      separates += tasks.length
      for (const r of gs.runs) expect(r.collab.placement.surface).toBe('card')
      for (const r of gs.runs.filter((x) => x.id.endsWith('_fu'))) expect(r.collab.participant_id).toBe(gs.runs.find((x) => x.id === r.id.replace(/_fu$/, ''))!.collab.participant_id)
      if (sid === 's_sep1') {
        // inside the bridge's held turn: the director's, inferred; after it: the connector's
        expect(gs.runs.find((r) => r.id === 'run_sep1_0')!.collab.origin).toMatchObject({ actor: 'director', director_turn_id: 'dt_bridge', basis: 'inferred', client: 'ChatGPT' })
        expect(gs.thread_items.filter((i) => i.kind === 'dispatch').length).toBeGreaterThan(0)
      }
    }
    expect(separates).toBe(43)
    const child = await read('s_child')
    expect(child.runs.find((r) => r.id === 'run_child')!.collab).toMatchObject({ participant_role: 'child', placement: { surface: 'card', anchor: { kind: 'run', id: 'run_parent' } } })
    expect(child.edges.some((e) => e.kind === 'spawned' && e.from.id === 'run_parent' && e.to.id === 'run_child')).toBe(true)
    // the session's thread: the main agent's runs and the relay's turns, never the steps, the orphans or a record
    const detail = await json(await c.get('/api/sessions/s_main'))
    const thread = (detail.runs as Record<string, unknown>[]).map((r) => r.id)
    for (const id of ['run_a1', 'run_f1', 'run_f2', 'run_s1', 'run_s1f', 'run_adopt']) expect(thread).not.toContain(id)
    for (const id of ['run_t1', 'run_t5', 'run_r0', 'run_r1', 'run_t6']) expect(thread).toContain(id)
    // the transcripts read from the walk the runner makes: T4 shows its own exchange only, not T1's or T2's
    const tr = JSON.stringify((await json(await c.get('/api/runs/run_t4/transcript'))).entries)
    expect(tr).toContain('asked run_t4')
    expect(tr).not.toContain('asked run_t2')
  } finally {
    await app.close()
  }
  // nothing written back: every older row byte for byte as it was
  const after = new Database(settings.db_path, { readonly: true })
  expect(rowsHash(after, 'runs', 'id')).toEqual(before.runs)
  expect(rowsHash(after, 'director_turns', 'id')).toEqual(before.turns)
  expect(rowsHash(after, 'relays', 'id')).toEqual(before.relays)
  expect(rowsHash(after, 'interaction_notes', 'id')).toEqual(before.notes)
  expect(Object.fromEntries((after.query('SELECT id, history_json, receipt_json, manifest_json FROM runs').all() as Record<string, string>[]).map((r) => [r.id, createHash('sha256').update(`${r.history_json}|${r.receipt_json}|${r.manifest_json}`).digest('hex')]))).toEqual(histories)
  expect(Number((after.query('SELECT count(*) AS n FROM participants').get() as { n: number }).n)).toBe(0)   // a read materializes nothing
  expect(Number((after.query('SELECT count(*) AS n FROM run_collab').get() as { n: number }).n)).toBe(0)
  after.close()
}, 60_000)
