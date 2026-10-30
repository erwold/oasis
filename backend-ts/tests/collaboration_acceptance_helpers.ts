/** Helpers of the collaboration acceptance tests (tests/test_collaboration_acceptance.test.ts): a scripted model that
 *  records every request it is sent (the messages as sent, the tool list as sent), small session / interaction
 *  drivers over the HTTP surface, the collaboration graph read through the contract's own schema, and the builder of
 *  a pre-v25 (schema v24) database holding the legacy shapes the unification design has to project. Scripted models
 *  only: nothing here reaches a network (the suite's preload refuses every non-loopback host). */

import { Database } from 'bun:sqlite'
import { expect } from 'bun:test'
import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  CollaborationGraphSchema, RunCollabSchema, type CollaborationGraph, type RunCollab,
} from '@oasis-code/contract'
import type { Conn } from '../src/db/database.ts'
import {
  dumpJson, isRequest, isUserPrompt, loadValue, modelRequest, modelResponse, textPart, userPrompt, type ModelMessage, type ModelResponse,
} from '../src/llm/messages.ts'
import type { App } from '../src/main.ts'
import { Client, json, makeApp } from './api_harness.ts'
import type { Settings } from '../src/config.ts'
import { buggyRepo, scriptedModel, setModel, sleep } from './harness.ts'

export const AGENT = 'scripted:a'
export const OTHER = 'scripted:b'
export const PA = 'pt_aaaaaa'
export const PB = 'pt_bbbbbb'
export const PC = 'pt_cccccc'

// ---- a recording scripted model ---------------------------------------------------------------------------------

/** One request a model was sent: the messages (deep-copied as sent), the text of every user prompt in them, the text
 *  of the LAST request's user prompts (what this turn added), and the tool list (names, and the whole list as JSON). */
export interface Seen {
  model: string
  messages: ModelMessage[]
  wire: string[]
  text: string
  last: string
  tools: string[]
  toolsJson: string
}

const promptText = (m: ModelMessage): string => isRequest(m)
  ? m.parts.filter(isUserPrompt).map((p) => (typeof p.content === 'string' ? p.content : p.content.filter((c): c is string => typeof c === 'string').join('\n'))).join('\n')
  : ''

/** The participant alias a request's history introduces (`You are pt_….`), else null (a thread run). */
export const aliasOf = (text: string): string | null => /You are (pt_[a-z0-9]+)\./.exec(text)?.[1] ?? null

export type Answer = (s: Seen) => string | ModelResponse | Promise<string | ModelResponse>

export class Recorder {
  readonly seen: Seen[] = []

  /** Install a recording scripted model under `id` (answers with `answer`; a thrown error fails the run). */
  install(app: App, id: string, answer: Answer): void {
    setModel(app.state, id, scriptedModel(async (messages, info) => {
      const copy = JSON.parse(JSON.stringify(messages)) as ModelMessage[]
      const requests = copy.filter(isRequest)
      const s: Seen = {
        model: id, messages: copy, wire: copy.map((m) => JSON.stringify(m)),
        text: copy.map(promptText).filter(Boolean).join('\n'),
        last: requests.length ? promptText(requests[requests.length - 1]!) : '',
        tools: info.function_tools.map((t) => t.name).sort(),
        toolsJson: JSON.stringify(info.function_tools),
      }
      this.seen.push(s)
      const out = await answer(s)
      return typeof out === 'string' ? modelResponse([textPart(out)]) : out
    }))
  }

  /** The requests whose newest user turn carries `marker` (a run's own opening message). */
  opening(marker: string): Seen[] { return this.seen.filter((s) => s.last.includes(marker)) }
  one(marker: string): Seen {
    const found = this.opening(marker)
    expect(found.length, `exactly one request opens with ${marker}; saw ${found.length}`).toBe(1)
    return found[0]!
  }
}

/** a is a message-for-message prefix of b, byte for byte as each message was serialised */
export function isPrefix(a: string[], b: string[]): boolean {
  if (a.length > b.length) return false
  return a.every((m, i) => m === b[i])
}

// ---- driving the app over HTTP ------------------------------------------------------------------------------------

export async function until<T>(read: () => T | Promise<T>, ok: (v: T) => boolean, what = 'condition', ms = 30_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await read()
    if (ok(v)) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v).slice(0, 500)}`)
    await sleep(25)
  }
}

export interface Opened { c: Client; sid: string; ws: string; pid: string }

export async function openSnapshot(app: App, title = 'acceptance'): Promise<Opened> {
  const c = new Client(app)
  const p = await json(await c.post('/api/projects', { source_path: buggyRepo() }))
  return await openSessionOf(c, String(p.id), title)
}

export async function openSessionOf(c: Client, pid: string, title: string): Promise<Opened> {
  const s = await json(await c.post(`/api/projects/${pid}/sessions`, { title, model: AGENT }))
  const ws = s.workspace_id ?? (s.workspace as Record<string, unknown> | null | undefined)?.id
  return { c, sid: String(s.id), ws: String(ws), pid }
}

export async function openDirect(app: App, root: string): Promise<Opened> {
  const c = new Client(app)
  const p = await json(await c.post('/api/projects', { source_path: root, mode: 'direct' }))
  return await openSessionOf(c, String(p.id), 'acceptance direct')
}

/** The run row as the API answers it (GET /api/runs/:id). */
export async function getRun(c: Client, id: string): Promise<Record<string, unknown>> {
  return await json(await c.get(`/api/runs/${id}`))
}

const ENDED = ['done', 'error', 'cancelled', 'interrupted']
export async function ended(c: Client, id: string, ms = 30_000): Promise<Record<string, unknown>> {
  return await until(() => getRun(c, id), (r) => ENDED.includes(String(r.status)), `run ${id} to end`, ms)
}

export async function chat(c: Client, sid: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const run = await json(await c.post(`/api/sessions/${sid}/chat`, body))
  return await ended(c, String(run.id))
}

export type Detail = Record<string, unknown> & { id: string; status: string; live: boolean; runs_started: number; revision: number; nodes: Record<string, unknown>[] }

export async function interactionDetail(c: Client, id: string): Promise<Detail> {
  return await json<Detail>(await c.get(`/api/interactions/${id}`))
}

const SETTLED = ['done', 'waiting', 'error', 'cancelled', 'interrupted']
export async function settled(c: Client, id: string): Promise<Detail> {
  return await until(() => interactionDetail(c, id), (d) => SETTLED.includes(d.status) && !d.live, `interaction ${id} to settle`)
}

/** An interaction of the given participants on the independent template (each alone on its own copy), settled. */
export async function independent(c: Client, sid: string, aliases: string[], extra: Record<string, unknown> = {}): Promise<Detail> {
  const body = { text: 'each of you, alone', participants: aliases.map((id) => ({ model: AGENT, id })), plan: { template: 'independent' }, ...extra }
  const ix = await json(await c.post(`/api/sessions/${sid}/interactions`, body))
  return await settled(c, String(ix.id))
}

export const nodeOf = (d: Detail, alias: string): Record<string, unknown> => {
  const n = d.nodes.find((x) => x.participant === alias)
  expect(n, `a node of ${alias}`).toBeDefined()
  return n!
}

/** POST, answering status and the parsed body (or the text when it is not JSON). */
export async function attempt(c: Client, path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
  const res = await c.post(path, body)
  const text = await res.text()
  let parsed: Record<string, unknown> = {}
  try { parsed = JSON.parse(text) as Record<string, unknown> } catch { /* not JSON */ }
  return { status: res.status, body: parsed, text }
}

// ---- the collaboration model as the API answers it ------------------------------------------------------------------

/** GET /api/sessions/:id/collaboration, through the contract's schema: a backend that does not serve it fails here,
 *  named (the route is the design's, docs/multi-agent-unification-design.md §7.1). */
export async function graphOf(c: Client, sid: string): Promise<CollaborationGraph> {
  const res = await c.get(`/api/sessions/${sid}/collaboration`)
  const text = await res.text()
  expect(res.status, `GET /api/sessions/${sid}/collaboration answered ${res.status}: ${text.slice(0, 300)}`).toBe(200)
  return CollaborationGraphSchema.parse(JSON.parse(text))
}

/** The `collab` a run answer carries (Run.collab, schema v25), parsed by the contract. */
export function collabOf(run: Record<string, unknown>): RunCollab {
  expect(run.collab, `run ${String(run.id)} carries collab (schema v25 RunCollab)`).toBeDefined()
  expect(run.collab, `run ${String(run.id)} carries collab`).not.toBeNull()
  return RunCollabSchema.parse(run.collab)
}

export function graphRun(g: CollaborationGraph, id: string) {
  const r = g.runs.find((x) => x.id === id)
  expect(r, `run ${id} is in the collaboration graph`).toBeDefined()
  return r!
}

export const edgesOf = (g: CollaborationGraph, kind: string, from: string | null, to: string | null) =>
  g.edges.filter((e) => e.kind === kind && (from === null || e.from.id === from) && (to === null || e.to.id === to))

// ---- counting what a refused call must not have left ---------------------------------------------------------------

export interface Footprint { runs: number; workspaces: number; nodes: number; rows: Record<string, number> }

/** Rows that a refused call must leave as they were: the session's runs, all workspaces, all interaction nodes, and
 *  every collaboration table the schema has (whatever its name: the counts of tables that exist, so the check holds
 *  for any table layout a v25 implementation chose). */
export function footprint(conn: Conn, sid: string): Footprint {
  const count = (sql: string, args: unknown[] = []) => Number((conn.get(sql, args as never) as { n: number }).n)
  const rows: Record<string, number> = {}
  for (const t of conn.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").map((r) => String(r.name))) {
    if (['run_events', 'model_requests', 'governance_log', 'executions', 'snapshots', 'checkpoints', 'assets', 'file_journal'].includes(t)) continue
    rows[t] = count(`SELECT count(*) AS n FROM "${t}"`)
  }
  return {
    runs: count('SELECT count(*) AS n FROM runs WHERE session_id = ?', [sid]),
    workspaces: count('SELECT count(*) AS n FROM workspaces'),
    nodes: count('SELECT count(*) AS n FROM interaction_nodes'),
    rows,
  }
}

// ---- schema structure (as tests/test_migrations.test.ts compares it) ------------------------------------------------

export function structure(db: Database): Record<string, unknown> {
  const all = (sql: string) => db.query(sql).all() as Record<string, unknown>[]
  const tables = all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").map((r) => String(r.name)).sort()
  const out: Record<string, unknown> = {}
  for (const t of tables) {
    out[t] = {
      columns: all(`PRAGMA table_info(${t})`).map((r) => [r.name, r.type, r.notnull, r.dflt_value, r.pk]),
      indexes: all(`PRAGMA index_list(${t})`).map((r) => String(r.name)).filter((n) => !n.startsWith('sqlite_')).sort(),
    }
  }
  return out
}

// ---- a v24 database with the legacy shapes ---------------------------------------------------------------------------

export const V24_FIXTURE = join(import.meta.dir, 'fixtures', 'collaboration_v24.sql')

/** A database made from the v24 fixture (schema.sql as it stood at schema v24), user_version 24. */
export function v24Database(path: string): Database {
  const db = new Database(path, { create: true })
  db.exec(readFileSync(V24_FIXTURE, 'utf8'))
  db.exec('PRAGMA user_version = 24')
  return db
}

const columnsOf = (db: Database, table: string, schema = 'main'): string[] =>
  (db.query(`PRAGMA ${schema}.table_info("${table}")`).all() as { name: string }[]).map((r) => r.name)

/** Rebuild `dbPath` as a v24 database: every table of the v24 fixture takes the rows the current database has, column
 *  for column where both have the column (what a v24 build would have written: no column, no table of a later
 *  schema comes along). The current database must be closed. Answers the v24 database, open, for more rows. */
export function rewriteAsV24(dbPath: string): Database {
  const v24Path = `${dbPath}.v24-build`
  rmSync(v24Path, { force: true })
  const db = v24Database(v24Path)
  db.exec(`ATTACH DATABASE '${dbPath.replaceAll("'", "''")}' AS cur`)
  const tables = (db.query("SELECT name FROM main.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((r) => r.name)
  const present = new Set((db.query("SELECT name FROM cur.sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name))
  for (const t of tables) {
    if (!present.has(t)) continue
    const theirs = new Set(columnsOf(db, t, 'cur'))
    const cols = columnsOf(db, t).filter((c) => theirs.has(c)).map((c) => `"${c}"`).join(', ')
    db.exec(`INSERT INTO main."${t}" (${cols}) SELECT ${cols} FROM cur."${t}"`)
  }
  db.exec('DETACH DATABASE cur')
  db.close()
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true })
  renameSync(v24Path, dbPath)
  expect(existsSync(`${dbPath}-wal`)).toBe(false)
  const out = new Database(dbPath)
  expect(Number((out.query('PRAGMA user_version').get() as { user_version: number }).user_version)).toBe(24)
  return out
}

/** The history of a run that continued `before` with one more exchange (built with the message model's own
 *  constructors, serialised by its own dumpJson — never hand-written JSON). */
export function extendHistory(before: string | null, ask: string, answer: string): string {
  const messages: ModelMessage[] = before ? loadValue(JSON.parse(before)) : []
  return dumpJson([...messages, modelRequest([userPrompt(ask)]), modelResponse([textPart(answer)], { model_name: 'scripted' })])
}

export type Row = Record<string, unknown>

/** Insert a run row: a copy of `like` with the given fields replaced (so every column a v24 build writes is present,
 *  as the runtime wrote it). */
export function insertRunLike(db: Database, like: Row, fields: Row, copyRequestEvidence = false): void {
  const row = { ...like, ...fields }
  const cols = Object.keys(row)
  db.query(`INSERT INTO runs (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...(cols.map((c) => row[c]) as never[]))
  // A synthetic *completed* legacy run made the same request as the row it models. Keep the request-side evidence
  // a real v24 runtime wrote as well as its manifest. Empty interrupted rows and actions deliberately opt out.
  if (copyRequestEvidence) {
    const requests = db.query('SELECT * FROM model_requests WHERE run_id=? ORDER BY seq').all(String(like.id)) as Row[]
    expect(requests.length, `the source of completed legacy run ${String(row.id)} has request evidence`).toBeGreaterThan(0)
    for (const source of requests) {
      const request = { ...source, id: `${String(source.id)}:${String(row.id)}`, run_id: row.id, started_at: row.created_at }
      const keys = Object.keys(request)
      db.query(`INSERT INTO model_requests (${keys.map((k) => `"${k}"`).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...(keys.map((k) => (request as Row)[k]) as never[]))
    }
  }
}

/** Every legacy column of the named runs, as stored (the bytes a migration and a projection must leave alone). */
export function legacyRows(db: Database, ids: string[], columns: string[]): Record<string, Row> {
  const out: Record<string, Row> = {}
  const cols = columns.map((c) => `"${c}"`).join(', ')
  for (const id of ids) out[id] = db.query(`SELECT ${cols} FROM runs WHERE id = ?`).get(id) as Row
  return out
}

// ---- the legacy fixture: a v24 database holding every pre-v25 shape the projection must read ------------------------

/** How every model of the legacy fixture answers: A, B and the thread each by a line of their own. */
export const legacyAnswer = (s: Seen): string => {
  const who = aliasOf(s.text)
  return who === PA ? 'LEGACY-A-ANSWER' : who === PB ? 'LEGACY-B-ANSWER' : `LEGACY-THREAD-ANSWER ${s.model}`
}

export interface LegacyFixture {
  sid: string
  ws: string
  d: Detail
  relayId: string
  /** the history of A's v24 follow-up (the one before the empty run), as stored */
  orphanHistory: string
  ids: {
    t1: string; t2: string; ra: string; rb: string; firstTurn: string; lastTurn: string; wo1: string; wo2: string
    afterRelay: string; orphan1: string; orphan2: string; action: string; child: string; dangling: string
  }
}

/** Build, in `settings`' data folder, the database a v24 build would have left, closed and at user_version 24:
 *  1. the runtime makes real rows over the HTTP surface with scripted models — a thread of two runs, an independent
 *     interaction of A and B (each on its own copy), a two-agent relay, a read-only separate task and its follow-up;
 *  2. the database is rebuilt from the v24 schema fixture with those rows (v24 columns only);
 *  3. the shapes only v24 code wrote are added as it wrote them (histories made by the message model's constructors):
 *     the thread continuing the relay's last turn (P3 shape), A's follow-up without its interaction (P1 shape) and a
 *     follow-up of that cut off before its first request with an empty history (P11 shape), a person's action row, a
 *     pre-v12 child run (parent_run_id, spawned_by run:…), and a run continuing a run that no longer exists.
 *  Workspaces and checkpoints are the runtime's own (real folders), so the old runs can be continued. */
export async function buildLegacyV24(settings: Settings): Promise<LegacyFixture> {
  const app = await makeApp(settings)
  let built: Omit<LegacyFixture, 'orphanHistory' | 'ids'> & { ids: Pick<LegacyFixture['ids'], 't1' | 't2' | 'ra' | 'rb' | 'firstTurn' | 'lastTurn' | 'wo1' | 'wo2'> }
  try {
    new Recorder().install(app, AGENT, legacyAnswer)
    new Recorder().install(app, OTHER, legacyAnswer)
    const { c, sid, ws } = await openSnapshot(app)
    const t1 = String((await chat(c, sid, { text: 'LEGACY-T1' })).id)
    const t2 = String((await chat(c, sid, { text: 'LEGACY-T2' })).id)
    const d = await independent(c, sid, [PA, PB])
    const ra = String(nodeOf(d, PA).run_id)
    const rb = String(nodeOf(d, PB).run_id)
    await json(await c.post(`/api/sessions/${sid}/chat`, { text: 'LEGACY-RELAY', agents: [{ model: AGENT }, { model: OTHER }] }))
    const turns = await until(
      () => app.state.conn.all('SELECT id, status, relay_id FROM runs WHERE session_id = ? AND relay_id IS NOT NULL ORDER BY relay_step', [sid]),
      (rows) => rows.length === 2 && rows.every((r) => r.status === 'done'), 'the relay to finish')
    const wo1 = String((await ended(c, String((await json(await c.post(`/api/sessions/${sid}/work-orders`, { work_order: { prompt: 'LEGACY-WO1', read_only: true, tools: ['read_file'] } }))).id))).id)
    const wo2 = String((await ended(c, String((await json(await c.post(`/api/runs/${wo1}/resume`, { text: 'LEGACY-WO2' }))).id))).id)
    built = { sid, ws, d, relayId: String(turns[0]!.relay_id), ids: { t1, t2, ra, rb, firstTurn: String(turns[0]!.id), lastTurn: String(turns[1]!.id), wo1, wo2 } }
  } finally {
    await app.close()
  }

  const db = rewriteAsV24(settings.db_path)
  try {
    const row = (id: string) => db.query('SELECT * FROM runs WHERE id = ?').get(id) as Row
    const { t1, t2, ra, lastTurn, wo1 } = built.ids
    const RA = row(ra)
    const T2 = row(t2)
    // just after the newest real row: later than all of them, earlier than anything the test starts afterwards
    const newest = String((db.query('SELECT max(max(created_at), max(coalesce(finished_at, created_at))) AS t FROM runs').get() as { t: string }).t)
    const after = (ms: number) => new Date(Date.parse(newest) + ms).toISOString()
    const early = (n: number) => `2020-01-01T00:00:0${n}.000Z`
    const receipt = (like: Row, text: string) => JSON.stringify({ ...(JSON.parse(String(like.receipt_json)) as Row), final_text: text })
    const ids = {
      ...built.ids,
      afterRelay: 'run_legacyafterrelay01', orphan1: 'run_legacyorphan00001', orphan2: 'run_legacyorphan00002',
      action: 'run_legacyaction00001', child: 'run_legacychild000001', dangling: 'run_legacydangling001',
    }
    // the thread after the relay continued its last turn (P3 shape: another participant's history)
    insertRunLike(db, T2, {
      id: ids.afterRelay, resumes_run_id: lastTurn, user_text: 'LEGACY-AFTER-RELAY', client_request_id: 'legacy-after-relay-key',
      history_json: extendHistory(String(row(lastTurn).history_json), 'LEGACY-AFTER-RELAY', 'LEGACY-AFTER-RELAY-ANSWER'),
      receipt_json: receipt(T2, 'LEGACY-AFTER-RELAY-ANSWER'), created_at: after(1), finished_at: after(2),
    }, true)
    // A's follow-up as v24 made it (P1 shape): no interaction_id, on A's own copy; then one cut off before its first
    // request (P11 shape: an empty history in the middle of the chain)
    const orphanHistory = extendHistory(String(RA.history_json), 'LEGACY-ORPHAN-1', 'LEGACY-ORPHAN-1-ANSWER')
    insertRunLike(db, RA, {
      id: ids.orphan1, resumes_run_id: ra, interaction_id: null, interaction_node: null, user_text: 'LEGACY-ORPHAN-1', client_request_id: null,
      history_json: orphanHistory, receipt_json: receipt(RA, 'LEGACY-ORPHAN-1-ANSWER'), created_at: after(3), finished_at: after(4),
    }, true)
    insertRunLike(db, RA, {
      id: ids.orphan2, resumes_run_id: ids.orphan1, interaction_id: null, interaction_node: null, user_text: 'LEGACY-ORPHAN-2', client_request_id: null,
      history_json: '[]', receipt_json: '{}', status: 'error', error: 'the harness stopped before this run began', created_at: after(5), finished_at: after(5),
    })
    // a person's action recorded as a row; a pre-v12 child run under a separate task's copy; a run continuing a run
    // that is gone (the anomalous ones dated before the session: they must not become anyone's head)
    insertRunLike(db, T2, { id: ids.action, spawned_by: 'human_action', resumes_run_id: null, model: 'human', user_text: 'adopted a step', history_json: null, receipt_json: '{}', client_request_id: null, created_at: early(1), finished_at: early(1) })
    insertRunLike(db, row(wo1), { id: ids.child, parent_run_id: t1, spawned_by: `run:${t1}`, resumes_run_id: null, user_text: 'LEGACY-CHILD', client_request_id: null, history_json: extendHistory(null, 'LEGACY-CHILD', 'child answer'), created_at: after(6), finished_at: after(7) }, true)
    insertRunLike(db, T2, { id: ids.dangling, resumes_run_id: 'run_gone000000000000', user_text: 'LEGACY-DANGLING', client_request_id: null, history_json: extendHistory(null, 'LEGACY-DANGLING', 'dangling answer'), created_at: early(3), finished_at: early(3) }, true)
    expect(Number((db.query('PRAGMA user_version').get() as { user_version: number }).user_version)).toBe(24)
    await sleep(Math.max(0, Date.parse(after(20)) - Date.now()))
    return { ...built, orphanHistory, ids }
  } finally {
    db.close()
  }
}
