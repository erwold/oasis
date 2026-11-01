/** A conversation's tool list never changes under it (schema v25): an older conversation (recorded before v25, no
 *  list of its own) goes on only with the list its record proves — names and the fingerprint of the rows it was sent,
 *  rebuilt from the baseline surface (src/agent/surfaces/agent.v1.json) — through runs that recorded no history of
 *  their own; a record that proves nothing (another build's rows, a tool this build has no record of, no list at all)
 *  is refused before anything is written, with a new conversation as the explicit way on. The list it gets is kept on
 *  the conversation and survives a restart. Scripted models only; no network. */

import { afterEach, expect, test } from 'bun:test'
import * as crepo from '../src/db/collab_repo.ts'
import * as repo from '../src/db/repo.ts'
import { schemaRowsFingerprint } from '../src/llm/usage.ts'
import { parametersSchema, specOf, withoutToolsForTest } from '../src/agent/tools/registry.ts'
import { z } from '@oasis-code/contract'
import { ElementArgSchema } from '../src/agent/tools/ui.ts'
import type { App } from '../src/main.ts'
import baseline from '../src/agent/surfaces/agent.v1.json' with { type: 'json' }
import { Client, json, makeApp } from './api_harness.ts'
import { AGENT, attempt, chat, ended, independent, isPrefix, nodeOf, openSnapshot, PA, PB, Recorder } from './collaboration_acceptance_helpers.ts'
import { testSettings } from './harness.ts'

let app: App | null = null
afterEach(async () => { if (app) await app.close(); app = null })

/** The run made a pre-v25 row: its collab rows gone (the session's projection reads it as the build before did). */
function asPreV25(sid: string, runIds: string[]): void {
  const conn = app!.state.conn
  for (const id of runIds) conn.run('DELETE FROM run_collab WHERE run_id=?', [id])
  conn.run('DELETE FROM collab_edges WHERE session_id=?', [sid])
  conn.run('DELETE FROM conversations WHERE session_id=?', [sid])
  conn.run('DELETE FROM participants WHERE session_id=?', [sid])
}

/** Every tool's parameters made the baseline's where a parameter's description differs (the parameter schema
 *  described as the baseline describes it) or a parameter came after it (left out), checked to give the baseline's
 *  JSON exactly; restore() puts them back. */
function asBaselineParameters(): { restore: () => void } {
  const kept: [ReturnType<typeof specOf>, unknown][] = []
  for (const row of (baseline as { rows: { name: string; parameters: Record<string, unknown> }[] }).rows) {
    const spec = specOf(row.name)
    if (spec === null || JSON.stringify(parametersSchema(spec)) === JSON.stringify(row.parameters)) continue
    const shape = (spec.schema as unknown as { shape: Record<string, z.ZodType> }).shape
    const was = (row.parameters.properties ?? {}) as Record<string, { description?: string; enum?: string[] }>
    const now = (parametersSchema(spec).properties ?? {}) as Record<string, { description?: string; enum?: string[] }>
    // a parameter whose values came after it (more of an enum's) takes the baseline's values
    const valued = (k: string): z.ZodType => (was[k]!.enum && JSON.stringify(was[k]!.enum) !== JSON.stringify(now[k]?.enum) ? z.enum(was[k]!.enum as [string, ...string[]]) : shape[k]!)
    const differs = (k: string) => was[k]!.description !== now[k]?.description || JSON.stringify(was[k]!.enum) !== JSON.stringify(now[k]?.enum)
    const described = Object.fromEntries(Object.keys(was).filter((k) => differs(k) && shape[k]).map((k) => [k, valued(k).describe(was[k]!.description ?? '')]))
    // The native catalog grew after the frozen baseline too (a nested enum, not a top-level parameter).
    if (row.name === 'present_ui') {
      const old = row.parameters.properties as { elements: { anyOf: [{ additionalProperties: { properties: { type: { enum: [string, ...string[]] } } } }] } }
      described.elements = z.record(z.string(), ElementArgSchema.extend({ type: z.enum(old.elements.anyOf[0].additionalProperties.properties.type.enum) })).nullable().optional().describe(was.elements!.description ?? '')
    }
    const later = Object.fromEntries(Object.keys(now).filter((k) => !(k in was)).map((k) => [k, true as const]))
    kept.push([spec, spec.schema])
    type Obj = { extend: (s: Record<string, z.ZodType>) => z.ZodType; omit: (m: Record<string, true>) => Obj }
    spec.schema = (spec.schema as unknown as Obj).omit(later).extend(described) as never
    expect(JSON.stringify(parametersSchema(spec)), row.name).toBe(JSON.stringify(row.parameters))
  }
  return { restore: () => { for (const [spec, schema] of kept) spec!.schema = schema as never } }
}

const rowsOf = (names: string[]) => (baseline as { rows: { name: string; description: string; parameters: Record<string, unknown> }[] }).rows.filter((r) => names.includes(r.name))

test('a record that proves no list is refused before anything is written: a tool this build has no record of, rows another build sent, no list at all', async () => {
  app = await makeApp()
  const rec = new Recorder()
  rec.install(app, AGENT, () => 'ok')
  const { c, sid } = await openSnapshot(app)
  const t0 = await chat(c, sid, { text: 'T0' })
  asPreV25(sid, [String(t0.id)])
  const conn = app.state.conn
  const manifest = repo.getRun(conn, String(t0.id))!.manifest
  const cases: [string, Record<string, unknown>, RegExp][] = [
    ['an unknown tool', { ...manifest, tools: ['read_file', 'spawn_agent'], tool_schema_sha256: schemaRowsFingerprint(rowsOf(['read_file'])) }, /no record of \(spawn_agent\)/],
    ['other rows', { ...manifest, tools: ['read_file'], tool_schema_sha256: '0'.repeat(64) }, /fingerprint matches neither/],
    ['no fingerprint', { ...manifest, tool_schema_sha256: null }, /no fingerprint/],
    ['no list', {}, /lists no tools/],
  ]
  for (const [what, m, reason] of cases) {
    repo.setRunManifest(conn, String(t0.id), m)
    const before = { runs: repo.listRuns(conn, sid).length, conversations: crepo.listConversations(conn, sid).length, participants: crepo.listParticipants(conn, sid).length }
    for (const [path, body] of [[`/api/sessions/${sid}/chat`, { text: 'NEXT' }], [`/api/runs/${t0.id}/resume`, { text: 'NEXT' }]] as const) {
      const res = await attempt(c, path, body)
      expect(res.status, `${what} via ${path}: ${res.text}`).toBe(409)
      expect(res.body.code).toBe('tool_surface_unrecoverable')
      expect(String(res.body.detail)).toMatch(reason)
    }
    expect({ runs: repo.listRuns(conn, sid).length, conversations: crepo.listConversations(conn, sid).length, participants: crepo.listParticipants(conn, sid).length }).toEqual(before)
  }
  expect(rec.opening('NEXT')).toHaveLength(0)                                               // no request was sent
}, 60_000)

test('a member\'s follow-up of an unprovable conversation is refused before its step is added: the group, its budget and its board are as they were', async () => {
  app = await makeApp()
  new Recorder().install(app, AGENT, () => 'ok')
  const { c, sid } = await openSnapshot(app)
  const d = await independent(c, sid, [PA, PB])
  const a1 = String(nodeOf(d, PA).run_id)
  const conn = app.state.conn
  asPreV25(sid, repo.listRuns(conn, sid).map((r) => r.id))
  repo.setRunManifest(conn, a1, { ...repo.getRun(conn, a1)!.manifest, tool_schema_sha256: 'an earlier build' })
  const ixBefore = repo.getInteraction(conn, d.id)!
  const nodesBefore = repo.listNodes(conn, d.id).length
  const res = await attempt(c, `/api/runs/${a1}/resume`, { text: 'MORE' })
  expect(res.status, res.text).toBe(409)
  expect(res.body.code).toBe('tool_surface_unrecoverable')
  expect(repo.listNodes(conn, d.id).length).toBe(nodesBefore)
  const ixAfter = repo.getInteraction(conn, d.id)!
  expect([ixAfter.revision, ixAfter.runs_started, ixAfter.budget, ixAfter.status]).toEqual([ixBefore.revision, ixBefore.runs_started, ixBefore.budget, ixBefore.status])
}, 60_000)

test('through a run that recorded no history (cut off before its first request), an older conversation goes on with the list it was sent — byte for byte, the history a prefix — and keeps it across a restart', async () => {
  const settings = testSettings()
  app = await makeApp(settings)
  const rec = new Recorder()
  rec.install(app, AGENT, () => 'ok')
  const { c, sid } = await openSnapshot(app)
  // T0 as the baseline build (v24) sent it: the tools described as the baseline describes them (this build may say
  // more since — a conversation of its own keeps what it was sent, an older one is rebuilt from the baseline)
  const changed = (baseline as { rows: { name: string; description: string }[] }).rows
    .map((row) => ({ spec: specOf(row.name), description: row.description })).filter((x) => x.spec !== null && x.spec.description !== x.description)
  const current = changed.map((x) => x.spec!.description)
  for (const x of changed) x.spec!.description = x.description
  // and its parameters as the baseline describes them (a parameter's description this build says more in, the same way)
  const schemas = asBaselineParameters()
  // and without the tools that came after it (generate_image, the SSH tools)
  const later = withoutToolsForTest(['generate_image', 'ssh_connect', 'ssh_hosts', 'ssh_directories', 'open_ssh_session', 'forward_port'])
  let t0: Awaited<ReturnType<typeof chat>>
  try { t0 = await chat(c, sid, { text: 'OLD-T0' }) } finally { changed.forEach((x, i) => { x.spec!.description = current[i]! }); schemas.restore(); later.restore() }
  const conn = app.state.conn
  // the cut-off run: its row as v24 wrote it — no history, no manifest, continuing T0
  const t0row = conn.get('SELECT * FROM runs WHERE id=?', [String(t0.id)])!
  const cut = 'run_cutoff00000000001'
  conn.run(`INSERT INTO runs (id, session_id, project_id, workspace_id, resumes_run_id, spawned_by, model, model_config_json, user_text, status, history_json, usage_json, manifest_json, budget_json, receipt_json, error, created_at, finished_at, attachments_json)
    VALUES (?, ?, ?, ?, ?, 'human', ?, ?, 'CUT', 'error', '[]', '{}', '{}', '{}', '{}', 'the harness stopped before this run began', ?, ?, '[]')`,
    [cut, sid, String(t0row.project_id), String(t0row.workspace_id), String(t0.id), String(t0row.model), String(t0row.model_config_json), new Date(Date.now() + 5).toISOString(), new Date(Date.now() + 5).toISOString()])
  asPreV25(sid, [String(t0.id)])
  // T0's record as the baseline build wrote it (the rows it was sent are the baseline's: the fingerprint proves them)
  const m0 = repo.getRun(conn, String(t0.id))!.manifest
  const names = (m0.tools as string[])
  expect(m0.tool_schema_sha256).toBe(schemaRowsFingerprint(rowsOf(names)))
  await Bun.sleep(10)
  const x1 = await ended(c, String((await json(await c.post(`/api/runs/${cut}/resume`, { text: 'AFTER-CUT' }))).id))
  expect(x1.status).toBe('done')
  const old = rec.one('OLD-T0')
  const next = rec.one('AFTER-CUT')
  expect(next.toolsJson).toBe(old.toolsJson)                                                // the same list, the same order, the same bytes
  expect(isPrefix(old.wire, next.wire)).toBe(true)
  const conv = crepo.getConversation(conn, String((x1.collab as Record<string, unknown>).conversation_id))!
  expect(conv.tool_snapshot).toMatchObject({ basis: 'reconstructed', sha256: m0.tool_schema_sha256 })
  expect(conv.tool_snapshot!.names).toEqual(JSON.parse(old.toolsJson).map((t: { name: string }) => t.name))
  await app.close()
  // another process: the conversation's own list, the same bytes again
  app = await makeApp(settings)
  const rec2 = new Recorder()
  rec2.install(app, AGENT, () => 'ok')
  const c2 = new Client(app)
  const x2 = await ended(c2, String((await json(await c2.post(`/api/runs/${x1.id}/resume`, { text: 'AFTER-RESTART' }))).id))
  expect(x2.status).toBe('done')
  expect(rec2.one('AFTER-RESTART').toolsJson).toBe(old.toolsJson)
  expect(collabOfConv(x2)).toBe(conv.id)
}, 90_000)

const collabOfConv = (run: Record<string, unknown>) => (run.collab as Record<string, unknown>).conversation_id
