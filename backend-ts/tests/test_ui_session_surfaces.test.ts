/** Session-scoped surfaces (contract/src/ui.ts: UiPublishOptions, uiSessionScopeRefusal, read_ui) on the backend:
 *
 *  - the contract's own schemas and pure functions under the real zod: the publishing options, read_ui's arguments and
 *    answers, the record's new optional fields, the multi-series chart's rules, one metadata row per registered tool;
 *  - present_ui scope session through the real RunManager and scripted models: created at expected_revision 0 by one
 *    main-thread run, updated in place by a later one (anchor run_id kept, updated_by_run_id and model the writer's,
 *    the event the writer's), the person's values kept as the transaction reads them, a retry at a spent revision a
 *    conflict that writes nothing; read_ui hands the calling run the record whole while the thread's rows, the
 *    transcript and a peer's packet keep to a summary;
 *  - who may: the run and session rows decide (a parent, a work order, a relay, an interaction, a UI task, another
 *    workspace — even a connector run without a parent — are refused, read and write, whatever surface id they guess),
 *    decided again inside the writing transaction;
 *  - a surface id is one scope per anchor run (no collision, no downgrade around the revision check); creation races
 *    and same-revision updates have one winner; the limits count what each run itself wrote (journal), never what
 *    other runs wrote to the same surface, and nothing that was refused;
 *  - the person's values, actions and tasks reach a session surface by its anchor path, on its revision;
 *  - v22 → v23: rows kept as `run`, the writer and the journal backfilled, one backup kept, the same structure as a
 *    fresh database; the surfaces survive a reopened app. */

import { afterEach, expect, test } from 'bun:test'
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  parseUiSurfaceSpec, SCHEMA_VERSION, splitUiPublishArgs, DIRECTOR_ONLY_METADATA_TOOLS, TOOL_CALL_METADATA_KEYS, UI_LIMITS, UI_SESSION_SURFACES_MAX, uiChartPointCount,
  UiPublishConflictSchema, UiPublishOptionsInputSchema, UiReadArgsSchema, UiReadResultSchema, uiSessionScopeRefusal, UiSurfaceEventDataSchema,
  UiSurfaceRecordSchema, uiSurfaceScope, uiSurfaceUpdatedBy,
  UiReadSnapshotSchema, uiReadSnapshot, type UiReadSnapshot,
  type Run, type Session, type TranscriptEntry, type UiSurfaceRecord,
} from '@oasis-code/contract'
import { connect, type Conn } from '../src/db/database.ts'
import * as repo from '../src/db/repo.ts'
import { peerPacket } from '../src/agent/peer_packet.ts'
import { MAX_UI_REVISIONS_PER_RUN, MAX_UI_SURFACES_PER_RUN, presentSurface, readSurface, type PresentResult } from '../src/agent/ui_surfaces.ts'
import { loopTools, parametersSchema, specOf, specs } from '../src/agent/tools/registry.ts'
import { presentUiTool, specOfArgs } from '../src/agent/tools/ui.ts'
import { PROMPT_TEXT } from '../src/prompt_texts.ts'
import { lastToolReturn, modelResponse, textPart, toolCallPart, type ModelMessage } from '../src/llm/messages.ts'
import { createApp, type App } from '../src/main.ts'
import type { Settings } from '../src/config.ts'
import { Client, json } from './api_harness.ts'
import { buggyRepo, collectEvents, scriptedModel, setModel, testConfig, testSettings } from './harness.ts'
import { tempDir } from './helpers.ts'

let app: App | null = null
afterEach(async () => { if (app) await app.close(); app = null })

type Rec = Record<string, unknown>
const SECRET = 'SECRET-PANEL-MARKER'
/** A value only the person's saved (never actioned) state holds. */
const NOTE = 'UNACTIONED-NOTE-7f3a91'

/** A panel: a note the person types (state), a frozen forecast and the actual points so far (literals in the spec, on
 *  a time axis), the last update as text. */
const T0 = Date.UTC(2026, 9, 12, 1, 0, 0)
const MIN = 60_000
function panel(actual: Array<[number, number | null]>, over: Rec = {}): Rec {
  return {
    version: 1, surface_id: 'panel', title: 'Forecast vs actual', fallback: `Forecast and ${actual.length} actual points. ${SECRET}`, kind: 'native',
    actions: [{ id: 'ask', label: 'Ask', prompt: 'Explain the gap.' }],
    root: 'r',
    elements: {
      r: { type: 'stack', children: ['note', 'chart', 'asof', 'go'] },
      note: { type: 'input', props: { label: 'Note', key: 'note', inputType: 'text' } },
      chart: { type: 'chart', props: { kind: 'line', x_axis: 'time', y_label: 'USD', series: [
        { id: 'fa', label: 'Forecast A', line_style: 'dashed', data: [0, 1, 2, 3].map((i) => ({ x: T0 + i * MIN, value: 100 + i })) },
        { id: 'act', label: 'Actual', data: actual.map(([i, v]) => ({ x: T0 + i * MIN, value: v })) },
      ] } },
      asof: { type: 'text', props: { text: `as of ${actual.length} points` } },
      go: { type: 'button', props: { label: 'Ask', action: 'ask' } },
    },
    ...over,
  }
}

/** A script that plays its steps in order; each step sees the messages so far. */
function playing(steps: ((messages: ModelMessage[]) => ReturnType<typeof modelResponse>)[]) {
  let n = 0
  return (messages: ModelMessage[]) => {
    const step = steps[n] ?? (() => modelResponse([textPart('done')]))
    n += 1
    return step(messages)
  }
}

async function openOverApi(c: Client): Promise<Session> {
  const project = await json(await c.post('/api/projects', { source_path: buggyRepo() }))
  const session = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 't', model: 'scripted:a' }))
  return repo.getSession(app!.state.conn, String(session.id))!
}

/** A run row of the session (no model call): main thread unless `over` says otherwise. */
function runRow(session: Session, over: Rec = {}): Run {
  return repo.insertRun(app!.state.conn, {
    session_id: session.id, project_id: session.project_id, workspace_id: session.workspace_id, model: 'scripted:a', model_config: {},
    user_text: 'x', status: 'running', budget: {}, ...over,
  } as never)
}

const who = (run: Run) => ({ session_id: run.session_id, run_id: run.id, model: run.model })
const session1 = { scope: 'session' as const, expected_revision: 0 }
const at = (n: number) => ({ scope: 'session' as const, expected_revision: n })
const okSurface = (r: PresentResult): UiSurfaceRecord => { expect(r.ok, JSON.stringify(r).slice(0, 400)).toBe(true); return (r as { surface: UiSurfaceRecord }).surface }

// ---- the contract, under the real zod ------------------------------------------------------------------------------

test('contract: the publishing options split from the spec; scope session needs expected_revision, scope run refuses it', () => {
  const spec = { version: 1, surface_id: 'p', title: 'P', fallback: 'p', kind: 'html', html: '<p>x</p>' }
  const legacy = splitUiPublishArgs(spec)
  expect(legacy.options).toEqual({ ok: true, value: { scope: 'run', expected_revision: null } })
  expect(legacy.spec).toEqual(spec)
  expect(splitUiPublishArgs({ ...spec, scope: null, expected_revision: null }).options).toEqual({ ok: true, value: { scope: 'run', expected_revision: null } })
  expect(splitUiPublishArgs({ ...spec, scope: 'run' }).options).toEqual({ ok: true, value: { scope: 'run', expected_revision: null } })
  const session = splitUiPublishArgs({ ...spec, scope: 'session', expected_revision: 0 })
  expect(session.options).toEqual({ ok: true, value: { scope: 'session', expected_revision: 0 } })
  expect('scope' in session.spec || 'expected_revision' in session.spec).toBe(false)                // never part of the spec
  expect(parseUiSurfaceSpec(session.spec).ok).toBe(true)
  for (const bad of [{ scope: 'session' }, { scope: 'session', expected_revision: null }, { expected_revision: 1 }, { scope: 'run', expected_revision: 0 },
    { scope: 'session', expected_revision: -1 }, { scope: 'session', expected_revision: 1.5 }, { scope: 'thread', expected_revision: 1 }, { scope: 'session', expected_revision: '1' }]) {
    expect(splitUiPublishArgs({ ...spec, ...bad }).options.ok, JSON.stringify(bad)).toBe(false)
  }
  expect(UiPublishOptionsInputSchema.safeParse({ scope: 'session', expected_revision: 2, extra: 1 }).success).toBe(false)
  // a spec that names a scope itself (inside it) is refused by the spec's own strict schema
  expect(parseUiSurfaceSpec({ ...spec, updated_by_run_id: 'run_x' }).ok).toBe(false)
  expect(UiPublishConflictSchema.safeParse({ status: 'conflict', surface_id: 'p', scope: 'session', expected_revision: 0, current_revision: 3 }).success).toBe(true)
  expect(UiPublishConflictSchema.safeParse({ status: 'conflict', surface_id: 'p', scope: 'session', expected_revision: 2, current_revision: null }).success).toBe(true)
  expect(UiPublishConflictSchema.safeParse({ status: 'conflict', surface_id: 'p', scope: 'session', expected_revision: 2, current_revision: 0 }).success).toBe(false)
})

test('contract: read_ui takes no session or run; its answers parse; a record without the new fields still parses as run', () => {
  expect(UiReadArgsSchema.safeParse({ surface_id: 'p' }).success).toBe(true)
  expect(UiReadArgsSchema.safeParse({ surface_id: 'p', scope: null }).success).toBe(true)
  expect(UiReadArgsSchema.safeParse({ surface_id: 'p', scope: 'session' }).success).toBe(true)
  for (const bad of [{ surface_id: 'p', session_id: 's_1' }, { surface_id: 'p', run_id: 'run_1' }, { surface_id: '__proto__' }, { surface_id: '1x' }, { surface_id: 'p', scope: 'all' }]) {
    expect(UiReadArgsSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
  }
  const old = { session_id: 's', run_id: 'run_a', surface_id: 'p', revision: 2, spec: { version: 1, surface_id: 'p', title: 'P', fallback: 'p', kind: 'native' }, state: {}, model: null, created_at: 't', updated_at: 't' }
  expect(UiSurfaceRecordSchema.safeParse(old).success).toBe(true)
  expect(uiSurfaceScope(old as { scope?: string })).toBe('run')
  expect(uiSurfaceUpdatedBy(old)).toBe('run_a')
  expect(uiSurfaceUpdatedBy({ ...old, updated_by_run_id: 'run_b' })).toBe('run_b')
  expect(UiSurfaceRecordSchema.safeParse({ ...old, scope: 'thread' }).success).toBe(false)
  expect(UiSurfaceEventDataSchema.safeParse({ surface: { ...old, scope: 'session', updated_by_run_id: 'run_b' } }).success).toBe(true)
  // read_ui's snapshot: every field but state — a full record (even with state {}) is refused, the snapshot taken
  expect(UiReadResultSchema.safeParse({ status: 'ok', surface: old }).success).toBe(false)
  expect(UiReadSnapshotSchema.safeParse(old).success).toBe(false)
  expect(UiReadSnapshotSchema.safeParse({ ...old, state: { note: 'x' } }).success).toBe(false)
  const snap = uiReadSnapshot(old as never)
  expect(Object.hasOwn(snap, 'state')).toBe(false)
  expect(UiReadSnapshotSchema.safeParse(snap).success).toBe(true)                                   // no scope / writer: the older shape
  expect(UiReadSnapshotSchema.safeParse({ ...snap, scope: 'session', updated_by_run_id: 'run_b' }).success).toBe(true)
  expect(UiReadSnapshotSchema.safeParse({ ...snap, extra: 1 }).success).toBe(false)
  expect(UiReadResultSchema.safeParse({ status: 'ok', surface: snap }).success).toBe(true)
  expect(UiReadResultSchema.safeParse({ status: 'not_found', surface_id: 'p', scope: 'session' }).success).toBe(true)
  expect(UiReadResultSchema.safeParse({ status: 'refused', scope: 'session', reason: 'x' }).success).toBe(true)
  expect(UiReadResultSchema.safeParse({ status: 'refused', scope: 'run', reason: 'x' }).success).toBe(false)
  expect(SCHEMA_VERSION).toBe(38)  // v26: the session cursor; v27: the sessions' latest activity; v28: the sessions' access; v29: the sessions' task and roots; v30: SSH targets; v31: SSH connect intent; v32: CNY costs, v33 read-path indexes
  // one metadata row per registered tool, twenty-one in all
  expect(Object.keys(TOOL_CALL_METADATA_KEYS).filter((name) => !(DIRECTOR_ONLY_METADATA_TOOLS as readonly string[]).includes(name)).sort()).toEqual(specs().map((s) => s.name).sort())
  expect(Object.keys(TOOL_CALL_METADATA_KEYS)).toHaveLength(26)
  expect(TOOL_CALL_METADATA_KEYS.read_ui).toEqual(['surface_id', 'scope'])
})

test('contract: uiSessionScopeRefusal decides from the rows only — every branch', () => {
  const session = { id: 's_1', workspace_id: 'ws_1' }
  const main = { session_id: 's_1', workspace_id: 'ws_1', parent_run_id: null, work_order: null, relay_id: null, interaction_id: null, spawned_by: 'human' }
  expect(uiSessionScopeRefusal(main, session)).toBeNull()
  for (const spawned_by of ['wake', 'connector']) expect(uiSessionScopeRefusal({ ...main, spawned_by }, session)).toBeNull()
  const refused: Array<[Rec, Rec | null]> = [
    [main, null], [{ ...main, session_id: 's_2' }, session], [main, { ...session, workspace_id: null }],
    [{ ...main, workspace_id: 'ws_copy' }, session], [{ ...main, workspace_id: null }, session],
    [{ ...main, spawned_by: 'connector', workspace_id: 'ws_copy' }, session],                         // a separate copy: no parent, a connector, another workspace
    [{ ...main, parent_run_id: 'run_p' }, session], [{ ...main, work_order: { prompt: 'x' } }, session],
    [{ ...main, relay_id: 'relay_1' }, session], [{ ...main, interaction_id: 'ia_1' }, session],
    [{ ...main, spawned_by: 'ui_task' }, session], [{ ...main, spawned_by: 'director' }, session],
  ]
  for (const [run, s] of refused) expect(uiSessionScopeRefusal(run as never, s as never), JSON.stringify([run, s])).not.toBeNull()
})

test('contract: a line chart of series — one of data or series, its axis, increasing x, UI_LIMITS.chartPoints points across series, gaps; the old charts as they were', () => {
  const spec = (chart: Rec, state: Rec = {}): Rec => ({ version: 1, surface_id: 'c', title: 'C', fallback: 'c', kind: 'native', initial_state: state, root: 'c', elements: { c: { type: 'chart', props: chart } } })
  const s = (id: string, xs: number[], value: unknown = 1): Rec => ({ id, label: id, data: xs.map((x) => ({ x, value })) })
  const ok = (chart: Rec, state: Rec = {}) => expect(parseUiSurfaceSpec(spec(chart, state)).ok, JSON.stringify(chart).slice(0, 200)).toBe(true)
  const bad = (chart: Rec, needle: string) => {
    const r = parseUiSurfaceSpec(spec(chart))
    expect(r.ok, JSON.stringify(chart).slice(0, 200)).toBe(false)
    expect((r as { errors: string[] }).errors.join(' | ')).toContain(needle)
  }
  ok({ kind: 'bar', data: [{ label: 'a', value: 1 }] })                                              // as ever
  ok({ kind: 'line', data: [{ label: 'a', value: 1 }], y_label: 'USD' })
  ok({ kind: 'line', x_axis: 'time', series: [s('a', [T0, T0 + MIN]), { ...s('b', []), line_style: 'dashed' }] })    // an empty series waits for data
  ok({ kind: 'line', x_axis: 'number', series: [s('a', [-1.5, 0, 2.25], null)] })                   // null: a gap
  ok({ kind: 'line', x_axis: 'number', series: [s('a', [1], { state: 'k' })] }, { k: 3 })
  ok({ kind: 'line', x_axis: 'time', series: Array.from({ length: UI_LIMITS.chartSeries }, (_, i) => s(`s${i}`, Array.from({ length: 12 }, (_, j) => T0 + j))) })
  bad({ kind: 'line' }, 'one of the three')
  bad({ kind: 'line', data: [{ label: 'a', value: 1 }], x_axis: 'time', series: [s('a', [1])] }, 'one of the three')
  // a file source: exclusive of data and series, kind line with an x axis; column names are any text without control
  // characters (a CSV header such as "val loss" or "__proto__" is a value, not a key); no points in the spec
  const src = (over: Rec = {}): Rec => ({ path: 'logs/train.jsonl', format: 'jsonl', x: 'step', series: [{ id: 'loss', label: 'Loss', column: 'train/loss' }, { id: 'val', label: 'Val', column: 'val loss', line_style: 'dashed' }], ...over })
  ok({ kind: 'line', x_axis: 'number', source: src() })
  ok({ kind: 'line', x_axis: 'time', source: src({ format: 'csv', x: 'time', series: [{ id: 'p', label: 'P', column: '__proto__' }] }) })
  bad({ kind: 'line', x_axis: 'number', source: src(), series: [s('a', [1])] }, 'one of the three')
  bad({ kind: 'line', x_axis: 'number', source: src(), data: [{ label: 'a', value: 1 }] }, 'one of the three')
  bad({ kind: 'bar', x_axis: 'number', source: src() }, 'a file source is for kind line')
  bad({ kind: 'line', source: src() }, 'names its x axis')
  bad({ kind: 'line', x_axis: 'number', source: src({ format: 'parquet' }) }, 'format')
  bad({ kind: 'line', x_axis: 'number', source: src({ x: 'st\nep' }) }, 'control characters')
  bad({ kind: 'line', x_axis: 'number', source: src({ path: 'a\u0000b' }) }, 'control characters')
  bad({ kind: 'line', x_axis: 'number', source: src({ series: [] }) }, 'series')
  bad({ kind: 'line', x_axis: 'number', source: src({ series: [{ id: 'a', label: 'A', column: 'x' }, { id: 'a', label: 'B', column: 'y' }] }) }, 'appears twice')
  bad({ kind: 'line', x_axis: 'number', source: src({ rows: [] }) }, 'rows')
  bad({ kind: 'line', x_axis: 'number', source: src({ path: '   ' }) }, 'a path names a file')
  expect(uiChartPointCount({ source: src() } as never)).toBe(0)
  bad({ kind: 'bar', x_axis: 'number', series: [s('a', [1])] }, 'series are for kind line')
  bad({ kind: 'line', series: [s('a', [1])] }, 'names its x axis')
  bad({ kind: 'line', data: [{ label: 'a', value: 1 }], x_axis: 'time' }, 'x_axis is for a chart with series')
  bad({ kind: 'line', x_axis: 'number', series: [s('a', [1]), s('a', [2])] }, 'appears twice')
  bad({ kind: 'line', x_axis: 'number', series: [s('a', [1, 1])] }, 'strictly increases')
  bad({ kind: 'line', x_axis: 'number', series: [s('a', [2, 1])] }, 'strictly increases')
  bad({ kind: 'line', x_axis: 'time', series: [s('a', [T0 + 0.5])] }, 'epoch milliseconds')
  bad({ kind: 'line', x_axis: 'time', series: [s('a', [8.64e15 + 1])] }, 'epoch milliseconds')
  // one point over the bound, split across two series (the bound is for every series together)
  bad({ kind: 'line', x_axis: 'number', series: [s('a', Array.from({ length: Math.ceil((UI_LIMITS.chartPoints + 1) / 2) }, (_, i) => i)), s('b', Array.from({ length: Math.floor((UI_LIMITS.chartPoints + 1) / 2) }, (_, i) => i))] }, 'points in all')
  bad({ kind: 'line', x_axis: 'number', series: [s('a', [1], { state: 'nope' })] }, 'no state key nope')
  bad({ kind: 'line', x_axis: 'number', series: Array.from({ length: UI_LIMITS.chartSeries + 1 }, (_, i) => s(`s${i}`, [1])) }, 'series')
  expect(uiChartPointCount({ series: [s('a', [1, 2]) as never, s('b', [3]) as never] })).toBe(3)
  expect(uiChartPointCount({ data: [{ label: 'a', value: 1 }] })).toBe(1)
  // JSON has no Infinity or NaN; a value given so is refused by the spec's shape check
  expect(parseUiSurfaceSpec(spec({ kind: 'line', x_axis: 'number', series: [s('a', [Number.POSITIVE_INFINITY])] })).ok).toBe(false)
})

// ---- the tools, end to end -----------------------------------------------------------------------------------------

test('present_ui scope session: created by one main-thread run, updated in place by the next; anchor kept, writer and model the later run\'s; values kept; a spent revision conflicts', async () => {
  app = await createApp(testSettings(), testConfig(), { probe: false })
  const c = new Client(app)
  const session = await openOverApi(c)
  const returns: Record<string, Rec> = {}
  const take = (key: string, tool = 'present_ui') => (m: ModelMessage[]) => { returns[key] = lastToolReturn(m, tool) as Rec }
  setModel(app.state, 'scripted:a', scriptedModel(playing([
    () => modelResponse([toolCallPart('present_ui', { ...panel([[0, 100]]), scope: 'session', expected_revision: 0 }, 'p1')]),
    (m) => { take('created')(m); return modelResponse([toolCallPart('present_ui', { ...panel([[0, 100]]), scope: 'session', expected_revision: 0 }, 'p2')]) },
    (m) => { take('again')(m); return modelResponse([textPart('Watching.')]) },
  ])))
  const a = await app.state.runs.start(session, 'start the panel')
  await collectEvents(app.state, a.id)
  expect(returns.created).toMatchObject({ status: 'ok', surface_id: 'panel', revision: 1, kind: 'native', scope: 'session' })
  expect(returns.again).toMatchObject({ status: 'conflict', surface_id: 'panel', scope: 'session', expected_revision: 0, current_revision: 1 })
  expect(String(returns.again!.message)).toContain('Nothing was written')
  expect(UiPublishConflictSchema.safeParse(returns.again).success).toBe(true)
  // the person types a note on it, by the anchor's path, at the revision they saw
  const base = `/api/sessions/${session.id}/ui/${a.id}/panel`
  expect(((await json(await c.put(`${base}/state`, { revision: 1, state: { note: NOTE } }))).surface as UiSurfaceRecord).state).toEqual({ note: NOTE })

  // a later main-thread run, on another model: reads it, appends an actual point at the revision it read, retries
  setModel(app.state, 'scripted:b', scriptedModel(playing([
    () => modelResponse([toolCallPart('read_ui', { surface_id: 'panel', scope: 'session' }, 'r1')]),
    (m) => { take('read', 'read_ui')(m); return modelResponse([toolCallPart('present_ui', { ...panel([[0, 100], [1, 103]]), scope: 'session', expected_revision: 1 }, 'p3')]) },
    (m) => { take('updated')(m); return modelResponse([toolCallPart('present_ui', { ...panel([[0, 100], [1, 103]]), scope: 'session', expected_revision: 1 }, 'p4')]) },
    (m) => { take('retry')(m); return modelResponse([toolCallPart('read_ui', { surface_id: 'panel' }, 'r2')]) },
    (m) => { take('as_run', 'read_ui')(m); return modelResponse([toolCallPart('read_ui', { surface_id: 'nope', scope: 'session' }, 'r3')]) },
    (m) => { take('missing', 'read_ui')(m); return modelResponse([textPart('Updated.')]) },
  ])))
  const b = await app.state.runs.start(repo.getSession(app.state.conn, session.id)!, 'add the next point', { model_id: 'scripted:b' })
  const events = await collectEvents(app.state, b.id)
  // read_ui: the published snapshot, to the calling run — the spec whole, never the person's saved values
  expect(UiReadResultSchema.safeParse(returns.read).success).toBe(true)
  const read = returns.read!.surface as UiReadSnapshot
  expect(returns.read!.status).toBe('ok')
  expect([read.run_id, read.revision, read.scope, read.updated_by_run_id, read.model]).toEqual([a.id, 1, 'session', a.id, 'scripted:a'])
  expect(Object.hasOwn(read, 'state')).toBe(false)
  expect(JSON.stringify(returns.read)).not.toContain(NOTE)
  expect(JSON.stringify(read.spec)).toContain(SECRET)
  // nor in what the model's history keeps of that call (what every later request of the run, and a follow-up, is sent)
  const history = String(repo.getRunHistory(app.state.conn, b.id))
  const kept = (JSON.parse(history) as Rec[]).flatMap((m) => (Array.isArray(m.parts) ? m.parts as Rec[] : []))
    .filter((p) => p.part_kind === 'tool-return' && p.tool_name === 'read_ui' && p.tool_call_id === 'r1')
  expect(kept).toHaveLength(1)
  expect((kept[0]!.content as Rec).status).toBe('ok')
  expect(Object.hasOwn((kept[0]!.content as Rec).surface as Rec, 'state')).toBe(false)
  expect(history).not.toContain(NOTE)
  // the routes still serve the person's values
  const got = ((await json(await c.get(`/api/sessions/${session.id}/ui`))).surfaces as UiSurfaceRecord[])[0]!
  expect(got.state).toEqual({ note: NOTE })
  // the update: in place at the anchor, the writer and its model, revision 2, the person's note kept
  expect(returns.updated).toMatchObject({ status: 'ok', surface_id: 'panel', revision: 2, scope: 'session' })
  const now = repo.getSessionUiSurface(app.state.conn, session.id, 'panel')!
  expect([now.run_id, now.revision, now.scope, now.updated_by_run_id, now.model]).toEqual([a.id, 2, 'session', b.id, 'scripted:b'])
  expect(now.state).toEqual({ note: NOTE })                                       // carried by the publish (no initial_state for it)
  expect(now.updated_at > read.updated_at).toBe(true)
  // the same call again: its revision is spent — a conflict, nothing written, nothing journalled twice
  expect(returns.retry).toMatchObject({ status: 'conflict', expected_revision: 1, current_revision: 2 })
  expect(repo.getSessionUiSurface(app.state.conn, session.id, 'panel')!.revision).toBe(2)
  expect(repo.listUiPublications(app.state.conn, session.id, 'panel').map((p) => [p.revision, p.writer_run_id, p.anchor_run_id])).toEqual([[1, a.id, a.id], [2, b.id, a.id]])
  // scope run reads only this run's own surfaces; an id that is not there is not found, whatever exists elsewhere
  expect(returns.as_run).toEqual({ status: 'not_found', surface_id: 'panel', scope: 'run' })
  expect(returns.missing).toEqual({ status: 'not_found', surface_id: 'nope', scope: 'session' })
  // the event is the writer's run; its record names the anchor and the writer
  const ui = events.filter((e) => e.event === 'ui_surface')
  expect(ui).toHaveLength(1)
  const evSurface = (ui[0]!.data as { surface: UiSurfaceRecord }).surface
  expect(UiSurfaceRecordSchema.safeParse(evSurface).success).toBe(true)
  expect([ui[0]!.run_id, evSurface.run_id, evSurface.updated_by_run_id, evSurface.revision]).toEqual([b.id, a.id, b.id, 2])
  // persisted the same way: the row is the writer's run, none of the anchor's run events changed
  const stored = app.state.conn.all("SELECT run_id, data_json FROM run_events WHERE event='ui_surface' ORDER BY created_at, seq")
  expect(stored.map((r) => [r.run_id, (JSON.parse(String(r.data_json)).surface as UiSurfaceRecord).run_id, (JSON.parse(String(r.data_json)).surface as UiSurfaceRecord).revision])).toEqual([[a.id, a.id, 1], [b.id, a.id, 2]])
  // the thread's rows stay summaries: no spec, no values, no document — for read_ui too
  const rows = events.filter((e) => (e.event === 'tool_result' || e.event === 'tool_call') && (e.data.tool === 'read_ui' || e.data.tool === 'present_ui'))
  for (const e of rows) {
    if (e.event === 'tool_result') expect(JSON.stringify(e.data), JSON.stringify(e.data).slice(0, 200)).not.toContain(SECRET)
    if (e.event === 'tool_result') expect(JSON.stringify(e.data)).not.toContain(NOTE)
  }
  const readRow = events.find((e) => e.event === 'tool_result' && e.data.tool === 'read_ui')!
  expect(readRow.data).toMatchObject({ status: 'ok', surface_id: 'panel', scope: 'session', revision: 1 })
  expect(events.filter((e) => e.event === 'tool_call' && e.data.tool === 'present_ui').map((e) => [e.data.surface_id, e.data.scope, e.data.expected_revision])).toEqual([['panel', 'session', 1], ['panel', 'session', 1]])
  // the session lists it once; the anchor's transcript shows it at its latest revision, the writer's does not repeat it
  const listed = (await json(await c.get(`/api/sessions/${session.id}/ui`))).surfaces as UiSurfaceRecord[]
  expect(listed.map((s) => [s.run_id, s.surface_id, s.revision, s.scope])).toEqual([[a.id, 'panel', 2, 'session']])
  const ta = (await json(await c.get(`/api/runs/${a.id}/transcript`))).entries as TranscriptEntry[]
  expect(ta.filter((e) => e.kind === 'ui').map((e) => [e.surface!.surface_id, e.surface!.revision])).toEqual([['panel', 2]])
  const tb = (await json(await c.get(`/api/runs/${b.id}/transcript`))).entries as TranscriptEntry[]
  expect(tb.filter((e) => e.kind === 'ui')).toEqual([])
  // the record read_ui returned is not in the transcript (a present_ui call's own arguments are, as they always were)
  expect(JSON.stringify(tb.filter((e) => e.kind === 'activity' && e.tool === 'read_ui'))).not.toContain(SECRET)
  expect(JSON.stringify(tb)).not.toContain(NOTE)
  const readEntry = tb.find((e) => e.kind === 'activity' && e.tool === 'read_ui')!
  expect(readEntry.result).toEqual({ status: 'ok', surface_id: 'panel', revision: 1, scope: 'session' })
  // a peer reads the writer's calls as lines, never the record read_ui returned
  const packet = peerPacket(app.state.conn, repo.getRun(app.state.conn, b.id)!, { turn: 2, speaker: 'B' })
  expect(packet).not.toContain(SECRET)
  expect(packet).not.toContain(NOTE)
  expect(packet).toContain('[read_ui panel → ok')
  const packetA = peerPacket(app.state.conn, repo.getRun(app.state.conn, a.id)!, { turn: 1, speaker: 'A' })
  expect(packetA).toContain('[UI surface "Forecast vs actual" (panel, revision 2, native)]')
})

test('who may: a parent, a work order, a relay, an interaction, a UI task, another workspace — refused to write and to read, whatever id they guess', async () => {
  app = await createApp(testSettings(), testConfig(), { probe: false })
  const c = new Client(app)
  const session = await openOverApi(c)
  const other = await openOverApi(c)
  const conn = app.state.conn
  const main = runRow(session)
  okSurface(presentSurface(conn, who(main), panel([[0, 1]]), session1))
  const journal = () => repo.listUiPublications(conn, session.id).length
  const before = journal()
  const strangers: Array<[string, Run]> = [
    ['parent', runRow(session, { parent_run_id: main.id })],
    ['work order', runRow(session, { work_order: { prompt: 'x' } })],
    ['relay', runRow(session, { relay_id: 'relay_x', relay_step: 0 })],
    ['interaction', runRow(session, { interaction_id: 'ia_x', interaction_node: 'n1' })],
    ['ui task', runRow(session, { spawned_by: 'ui_task' })],
    ['separate copy (connector, no parent, another workspace)', runRow(session, { spawned_by: 'connector', workspace_id: 'ws_copy' })],
    ['no workspace', runRow(session, { workspace_id: null })],
  ]
  for (const [name, run] of strangers) {
    for (const expected of [0, 1, 2]) {
      const r = presentSurface(conn, who(run), panel([[0, 9]]), at(expected))
      expect(r.ok, name).toBe(false)
      expect('refused' in r && typeof r.refused === 'string', name).toBe(true)
      expect(JSON.stringify(r)).not.toContain('current_revision')                 // a refusal says nothing about the surface
    }
    for (const id of ['panel', 'nope']) {
      const read = readSurface(conn, { session_id: session.id, run_id: run.id }, { surface_id: id, scope: 'session' })
      expect(read.status, `${name} ${id}`).toBe('refused')
      expect(JSON.stringify(read)).not.toContain(SECRET)
    }
  }
  // a run of another session, publishing into this session's id, is not of it
  const foreign = repo.insertRun(conn, { session_id: other.id, project_id: other.project_id, workspace_id: other.workspace_id, model: 'scripted:a', model_config: {}, user_text: 'x', status: 'running', budget: {} } as never)
  expect('refused' in presentSurface(conn, { session_id: session.id, run_id: foreign.id, model: 'm' }, panel([]), at(1))).toBe(true)
  expect(readSurface(conn, { session_id: session.id, run_id: foreign.id }, { surface_id: 'panel', scope: 'session' }).status).toBe('refused')
  // its own session has no such surface: not found, never another session's
  expect(readSurface(conn, { session_id: other.id, run_id: foreign.id }, { surface_id: 'panel', scope: 'session' })).toEqual({ status: 'not_found', surface_id: 'panel', scope: 'session' })
  expect(journal()).toBe(before)
  expect(repo.getSessionUiSurface(conn, session.id, 'panel')!.revision).toBe(1)
  // the strangers' own run surfaces work as ever (nothing of the old behavior narrowed)
  okSurface(presentSurface(conn, who(strangers[0]![1]), panel([[0, 1]], { surface_id: 'mine' })))

  // through the tool: the row decides at the call — a run turned into another workspace's is refused at once
  const returns: Rec[] = []
  setModel(app.state, 'scripted:a', scriptedModel(playing([
    () => modelResponse([toolCallPart('read_ui', { surface_id: 'panel', scope: 'session' }, 'r1')]),
    (m) => {
      returns.push(lastToolReturn(m, 'read_ui') as Rec)
      conn.run('UPDATE runs SET workspace_id=? WHERE id=?', ['ws_elsewhere', String(repo.latestRunOfSession(conn, session.id)?.id ?? '')])
      return modelResponse([toolCallPart('present_ui', { ...panel([[0, 5]]), scope: 'session', expected_revision: 1 }, 'p1')])
    },
    (m) => { returns.push(lastToolReturn(m, 'present_ui') as Rec); return modelResponse([toolCallPart('read_ui', { surface_id: 'panel', scope: 'session' }, 'r2')]) },
    (m) => { returns.push(lastToolReturn(m, 'read_ui') as Rec); return modelResponse([textPart('done')]) },
  ])))
  const run = await app.state.runs.start(repo.getSession(conn, session.id)!, 'look')
  const events = await collectEvents(app.state, run.id)
  expect(returns[0]!.status).toBe('ok')                                                          // a main-thread run reads it
  expect(returns[1]).toMatchObject({ status: 'refused', scope: 'session' })
  expect(String(returns[1]!.reason)).toContain('workspace')
  expect(returns[2]).toMatchObject({ status: 'refused', scope: 'session' })
  expect('surface' in returns[2]!).toBe(false)
  expect(events.some((e) => e.event === 'ui_surface')).toBe(false)
  expect(repo.getSessionUiSurface(conn, session.id, 'panel')!.revision).toBe(1)
})

test('one scope per anchor and id: no collision, no downgrade around the revision check; the run path never writes a session row', async () => {
  app = await createApp(testSettings(), testConfig(), { probe: false })
  const c = new Client(app)
  const session = await openOverApi(c)
  const conn = app.state.conn
  const a = runRow(session)
  // a run surface first: the same run cannot make the id a session surface
  okSurface(presentSurface(conn, who(a), panel([], { surface_id: 'x' })))
  const up = presentSurface(conn, who(a), panel([], { surface_id: 'x' }), session1)
  expect(up.ok).toBe(false)
  expect((up as { errors: string[] }).errors[0]).toContain('scope run')
  expect(repo.getSessionUiSurface(conn, session.id, 'x')).toBeNull()
  // a session surface first: the run path refuses its id in the anchor run (no update that skips the revision check)
  okSurface(presentSurface(conn, who(a), panel([[0, 1]], { surface_id: 'y' }), session1))
  const down = presentSurface(conn, who(a), panel([[0, 2]], { surface_id: 'y' }))
  expect(down.ok).toBe(false)
  expect((down as { errors: string[] }).errors[0]).toContain('scope session')
  const y = repo.getSessionUiSurface(conn, session.id, 'y')!
  expect([y.revision, y.scope]).toEqual([1, 'session'])
  expect(repo.getUiSurface(conn, session.id, a.id, 'y')!.scope).toBe('session')
  // the repo's run path itself never overwrites a session row (the guard under the check)
  expect(repo.putUiSurface(conn, { ...y, scope: 'run', revision: 9 })).toBeNull()
  expect(repo.getSessionUiSurface(conn, session.id, 'y')!.revision).toBe(1)
  // read_ui scope run does not see the session row anchored at this run
  expect(readSurface(conn, { session_id: session.id, run_id: a.id }, { surface_id: 'y' })).toEqual({ status: 'not_found', surface_id: 'y', scope: 'run' })
  expect(readSurface(conn, { session_id: session.id, run_id: a.id }, { surface_id: 'x' }).status).toBe('ok')
  expect(readSurface(conn, { session_id: session.id, run_id: a.id }, { surface_id: 'x', scope: 'session' })).toEqual({ status: 'not_found', surface_id: 'x', scope: 'session' })
  // a later run may hold a run surface of the same id as the session's (another anchor): two rows, two scopes
  const b = runRow(session)
  okSurface(presentSurface(conn, who(b), panel([], { surface_id: 'y', title: 'B own' })))
  expect(repo.getRunUiSurface(conn, session.id, b.id, 'y')!.spec.title).toBe('B own')
  expect(repo.getSessionUiSurface(conn, session.id, 'y')!.revision).toBe(1)
  const bUpdate = okSurface(presentSurface(conn, who(b), panel([[0, 1], [1, 2]], { surface_id: 'y' }), at(1)))
  expect([bUpdate.run_id, bUpdate.updated_by_run_id, bUpdate.revision]).toEqual([a.id, b.id, 2])
  expect(repo.getRunUiSurface(conn, session.id, b.id, 'y')!.revision).toBe(1)
})

test('races: of two creations at 0 one wins; of two updates at one revision one wins; the loser wrote and counted nothing', async () => {
  app = await createApp(testSettings(), testConfig(), { probe: false })
  const c = new Client(app)
  const session = await openOverApi(c)
  const conn = app.state.conn
  const a = runRow(session)
  const b = runRow(session)
  const r1 = presentSurface(conn, who(a), panel([[0, 1]]), session1)
  const r2 = presentSurface(conn, who(b), panel([[0, 2]]), session1)
  expect([r1.ok, r2.ok]).toEqual([true, false])
  expect((r2 as { conflict: Rec }).conflict).toEqual({ status: 'conflict', surface_id: 'panel', scope: 'session', expected_revision: 0, current_revision: 1 })
  // the key itself holds even past the check: a second session row of the id cannot be inserted
  const row = repo.getSessionUiSurface(conn, session.id, 'panel')!
  expect(repo.insertSessionUiSurface(conn, { ...row, run_id: b.id, updated_by_run_id: b.id })).toBeNull()
  expect(repo.updateSessionUiSurface(conn, { ...row, revision: 5, updated_by_run_id: b.id }, 4)).toBeNull()
  const u1 = presentSurface(conn, who(b), panel([[0, 1], [1, 3]]), at(1))
  const u2 = presentSurface(conn, who(a), panel([[0, 1], [1, 4]]), at(1))
  expect([u1.ok, u2.ok]).toEqual([true, false])
  expect((u2 as { conflict: Rec }).conflict.current_revision).toBe(2)
  // an update of a surface that is not there, and one ahead of it
  expect((presentSurface(conn, who(a), panel([], { surface_id: 'ghost' }), at(1)) as { conflict: Rec }).conflict.current_revision).toBeNull()
  expect((presentSurface(conn, who(a), panel([]), at(7)) as { conflict: Rec }).conflict.current_revision).toBe(2)
  // the loser re-reads, builds on what it read, and wins at the revision it read
  const fresh = readSurface(conn, { session_id: session.id, run_id: a.id }, { surface_id: 'panel', scope: 'session' })
  expect(fresh.status).toBe('ok')
  const latest = (fresh as { surface: UiReadSnapshot }).surface
  okSurface(presentSurface(conn, who(a), panel([[0, 1], [1, 3], [2, 4]]), at(latest.revision)))
  expect(repo.listUiPublications(conn, session.id, 'panel').map((p) => [p.revision, p.writer_run_id])).toEqual([[1, a.id], [2, b.id], [3, a.id]])
  expect(repo.countUiRevisions(conn, a.id)).toEqual({ surfaces: 1, revisions: 2 })
  expect(repo.countUiRevisions(conn, b.id)).toEqual({ surfaces: 1, revisions: 1 })
})

test('limits: each run\'s by what it wrote (both scopes together), never the session surface\'s whole history; refusals count nothing; 20 session surfaces', async () => {
  app = await createApp(testSettings(), testConfig(), { probe: false })
  const c = new Client(app)
  const session = await openOverApi(c)
  const conn = app.state.conn
  // one session surface taken to 59 revisions by many runs, 1 each
  let rev = 0
  for (let i = 0; i < MAX_UI_REVISIONS_PER_RUN - 1; i += 1) {
    const r = runRow(session)
    okSurface(presentSurface(conn, who(r), panel([[0, i]]), at(rev)))
    rev += 1
  }
  expect(repo.getSessionUiSurface(conn, session.id, 'panel')!.revision).toBe(MAX_UI_REVISIONS_PER_RUN - 1)
  // a new run is not charged with them
  const w = runRow(session)
  expect(repo.countUiRevisions(conn, w.id)).toEqual({ surfaces: 0, revisions: 0 })
  okSurface(presentSurface(conn, who(w), panel([[0, 1]]), at(rev)))
  rev += 1
  // its run surfaces and its session revisions are one budget: 59 more of its own make 60, then it is refused
  for (let i = 0; i < MAX_UI_REVISIONS_PER_RUN - 2; i += 1) okSurface(presentSurface(conn, who(w), panel([], { surface_id: 'own' })))
  okSurface(presentSurface(conn, who(w), panel([[0, 2]]), at(rev)))
  rev += 1
  expect(repo.countUiRevisions(conn, w.id)).toEqual({ surfaces: 2, revisions: MAX_UI_REVISIONS_PER_RUN })
  const over = presentSurface(conn, who(w), panel([[0, 3]]), at(rev))
  expect(over.ok).toBe(false)
  expect((over as { errors: string[] }).errors[0]).toContain('revisions')
  expect(repo.getSessionUiSurface(conn, session.id, 'panel')!.revision).toBe(rev)
  // a conflict, an invalid spec and a refusal count nothing
  const v = runRow(session)
  expect(presentSurface(conn, who(v), panel([]), at(1)).ok).toBe(false)
  expect(presentSurface(conn, who(v), { ...panel([]), root: 'missing' }, at(rev)).ok).toBe(false)
  expect(presentSurface(conn, who(v), { ...panel([]), root: 'missing' }).ok).toBe(false)
  expect(repo.countUiRevisions(conn, v.id)).toEqual({ surfaces: 0, revisions: 0 })
  // twenty surfaces per run, across scopes
  const s20 = runRow(session)
  for (let i = 0; i < MAX_UI_SURFACES_PER_RUN - 1; i += 1) okSurface(presentSurface(conn, who(s20), panel([], { surface_id: `r${i}` })))
  okSurface(presentSurface(conn, who(s20), panel([], { surface_id: 's0' }), session1))
  const s21 = presentSurface(conn, who(s20), panel([], { surface_id: 's1' }), session1)
  expect((s21 as { errors: string[] }).errors[0]).toContain('surfaces')
  okSurface(presentSurface(conn, who(s20), panel([], { surface_id: 's0' }), at(1)))           // one it wrote before still takes revisions
  // twenty session surfaces per session
  expect(repo.countSessionUiSurfaces(conn, session.id)).toBe(2)
  for (let i = 2; i < UI_SESSION_SURFACES_MAX; i += 1) okSurface(presentSurface(conn, who(runRow(session)), panel([], { surface_id: `s${i}` }), session1))
  const full = presentSurface(conn, who(runRow(session)), panel([], { surface_id: 'one_more' }), session1)
  expect(full.ok).toBe(false)
  expect((full as { errors: string[] }).errors[0]).toContain(`${UI_SESSION_SURFACES_MAX} session surfaces`)
  expect(repo.countSessionUiSurfaces(conn, session.id)).toBe(UI_SESSION_SURFACES_MAX)
})

test('the person\'s values: read in the writing transaction and kept; initial_state sets its keys again; the routes act on the anchor path at the revision', async () => {
  app = await createApp(testSettings(), testConfig(), { probe: false })
  const c = new Client(app)
  const session = await openOverApi(c)
  const conn = app.state.conn
  const a = runRow(session)
  const b = runRow(session)
  okSurface(presentSurface(conn, who(a), panel([[0, 1]]), session1))
  const base = `/api/sessions/${session.id}/ui/${a.id}/panel`
  // the person writes after the agent read revision 1, before it publishes 2: the value is kept
  const seen = readSurface(conn, { session_id: session.id, run_id: b.id }, { surface_id: 'panel', scope: 'session' })
  expect(UiReadResultSchema.safeParse(seen).success).toBe(true)
  expect(Object.hasOwn((seen as { surface: object }).surface, 'state')).toBe(false)
  await json(await c.put(`${base}/state`, { revision: 1, state: { note: 'typed meanwhile' } }))
  expect(okSurface(presentSurface(conn, who(b), panel([[0, 1], [1, 2]]), at(1))).state).toEqual({ note: 'typed meanwhile' })
  // the revision the person saw is now stale: the routes say so, by the anchor's path
  const stale = await c.put(`${base}/state`, { revision: 1, state: { note: 'late' } })
  expect(stale.status).toBe(409)
  expect(((await stale.json()) as Rec).error).toBe('stale_revision')
  const staleAction = await c.post(`${base}/actions`, { revision: 1, action_id: 'ask', state: {}, request_id: 'req-sess-0001' })
  expect(staleAction.status).toBe(409)
  // at the current revision: saved, an action prepared from the anchor's surface
  const prepared = await json(await c.post(`${base}/actions`, { revision: 2, action_id: 'ask', state: { note: 'why?' }, request_id: 'req-sess-0002' }))
  expect(String(prepared.prompt)).toContain(`(surface panel, revision 2, from run ${a.id})`)
  expect((prepared.surface as UiSurfaceRecord).state).toEqual({ note: 'why?' })
  // the writer's own run path does not reach it (it is not that run's surface)
  expect((await c.put(`/api/sessions/${session.id}/ui/${b.id}/panel/state`, { revision: 2, state: { note: 'x' } })).status).toBe(404)
  // initial_state names the key: set again, as for any republish
  expect(okSurface(presentSurface(conn, who(b), panel([[0, 1]], { initial_state: { note: 'reset' } }), at(2))).state).toEqual({ note: 'reset' })
  // a task on a run action reaches it by the anchor's path too (and the revision is checked)
  okSurface(presentSurface(conn, who(b), panel([[0, 1]], { actions: [{ id: 'ask', label: 'Ask', prompt: 'Explain.', mode: 'run' }] }), at(3)))
  const staleTask = await c.post(`${base}/tasks`, { revision: 3, action_id: 'ask', state: {}, request_id: 'req-sess-task-1' })
  expect(staleTask.status).toBe(409)
})

test('the tool schemas: present_ui takes scope and expected_revision flat; read_ui is strict (no session or run argument); the texts say mechanism only', () => {
  const present = parametersSchema(specOf('present_ui')!)
  const props = present.properties as Record<string, unknown>
  expect('scope' in props && 'expected_revision' in props).toBe(true)
  const read = specOf('read_ui')!
  expect([read.effect, read.action, read.scope]).toEqual(['read', null, undefined])            // always visible, never gated
  const readProps = Object.keys((parametersSchema(read).properties ?? {}) as Rec).sort()
  expect(readProps).toEqual(['scope', 'surface_id'])
  const tool = loopTools().find((t) => t.name === 'read_ui')!
  expect('value' in tool.validate({ surface_id: 'panel', scope: 'session' })).toBe(true)
  expect('error' in tool.validate({ surface_id: 'panel', session_id: 's_other' })).toBe(true)
  expect('error' in tool.validate({ surface_id: 'panel', run_id: 'run_other' })).toBe(true)
  const texts = [PROMPT_TEXT['tool.read_ui'], PROMPT_TEXT['tool.present_ui'], PROMPT_TEXT['parameter.present_ui.scope'], PROMPT_TEXT['parameter.present_ui.expected_revision'],
    PROMPT_TEXT['parameter.read_ui.scope'], PROMPT_TEXT['parameter.read_ui.surface_id'], PROMPT_TEXT['ui.conflict'], PROMPT_TEXT['ui.session_refused']]
  for (const t of texts) {
    expect(t).not.toMatch(/\b(e\.g\.|for instance|such as|ideal for|useful for|good for|use it (?:for|to)|calculator|dashboard|simulat\w*|game|quiz|budget|planner|comparison|forecast|price|stock|market|predict\w*|monitor\w*)\b/i)
    expect(t).not.toMatch(/Example|you should|should use|recommended/i)
  }
  const d = PROMPT_TEXT['tool.present_ui']
  for (const s of ['scope session', 'expected_revision', '0 creates it', 'A conflict writes nothing', 'At most 20 session surfaces', 'x_axis: time (x in epoch milliseconds, UTC) or number',
    `at most ${UI_LIMITS.chartPoints} points in all, across every series, and ${UI_LIMITS.chartSeries} series`, 'a value that is not a finite number is a gap']) expect(d, s).toContain(s)
  // a file source: what it is and its objective limits, in the same words (no use, no example)
  for (const s of ['source: {path, format: jsonl or csv, x, series: [id, label, column, line_style?]}', 'one of the three', 'source: at most 8 series, no point limit', 'a file this run can read, local or on its SSH host', 'after the run too',
    'a record counts at its newline, one over 1 MiB is skipped', 'null or text is a gap, an absent key or empty cell no point', "a point not above its series' last x is skipped"]) expect(d, s).toContain(s)
  // request_input takes the same catalog: its words name the same bound
  expect(PROMPT_TEXT['tool.request_input']).toContain(`chart ${UI_LIMITS.chartPoints} points`)
  for (const s of ['complete spec as last published', '(its state) are not part of it', 'updated_by_run_id', 'not_found', 'refused', 'No argument names another run or conversation', 'It changes nothing']) expect(PROMPT_TEXT['tool.read_ui'], s).toContain(s)
})

test('the surfaces survive the process: a reopened app serves the session surface, and a run after the restart updates it at its revision', async () => {
  const settings: Settings = testSettings()
  app = await createApp(settings, testConfig(), { probe: false })
  let c = new Client(app)
  const session = await openOverApi(c)
  const a = runRow(session)
  okSurface(presentSurface(app.state.conn, who(a), panel([[0, 1]]), session1))
  await app.close()
  app = await createApp(settings, testConfig(), { probe: false })
  c = new Client(app)
  const listed = (await json(await c.get(`/api/sessions/${session.id}/ui`))).surfaces as UiSurfaceRecord[]
  expect(listed.map((s) => [s.run_id, s.surface_id, s.scope, s.revision, s.updated_by_run_id])).toEqual([[a.id, 'panel', 'session', 1, a.id]])
  const returns: Rec[] = []
  setModel(app.state, 'scripted:a', scriptedModel(playing([
    () => modelResponse([toolCallPart('present_ui', { ...panel([[0, 1], [1, 2]]), scope: 'session', expected_revision: 1 }, 'p1')]),
    (m) => { returns.push(lastToolReturn(m, 'present_ui') as Rec); return modelResponse([textPart('ok')]) },
  ])))
  const b = await app.state.runs.start(repo.getSession(app.state.conn, session.id)!, 'next point')
  await collectEvents(app.state, b.id)
  expect(returns[0]).toMatchObject({ status: 'ok', revision: 2, scope: 'session' })
  const now = repo.getSessionUiSurface(app.state.conn, session.id, 'panel')!
  expect([now.run_id, now.updated_by_run_id, now.revision]).toEqual([a.id, b.id, 2])
})

test('a reserved key sent as JSON — __proto__ null, a string or an object — stays an own key and is refused: split, specOfArgs, the tool itself, the registered dispatch', async () => {
  app = await createApp(testSettings(), testConfig(), { probe: false })
  const c = new Client(app)
  const session = await openOverApi(c)
  const conn = app.state.conn
  const run = runRow(session)
  const reserved = (errors: string[]) => expect(errors.join(' | ')).toContain('reserved')
  const tool = loopTools().find((t) => t.name === 'present_ui')!
  for (const value of ['null', '"x"', '{}', '{"title":"T"}']) {
    for (const options of ['', ',"scope":"session","expected_revision":0', ',"scope":null,"expected_revision":null']) {
      // JSON.parse makes __proto__ an own key (an object literal would set the prototype instead)
      const text = JSON.stringify(panel([])).slice(0, -1) + `${options},"__proto__":${value}}`
      const raw = JSON.parse(text) as Rec
      expect(Object.hasOwn(raw, '__proto__'), text.slice(-80)).toBe(true)
      const split = splitUiPublishArgs(raw)
      expect(Object.hasOwn(split.spec, '__proto__')).toBe(true)
      const direct = parseUiSurfaceSpec(split.spec)
      expect(direct.ok).toBe(false)
      reserved((direct as { errors: string[] }).errors)
      const normalized = specOfArgs(split.spec)
      expect(Object.hasOwn(normalized, '__proto__'), `specOfArgs kept __proto__: ${value}`).toBe(true)
      const parsed = parseUiSurfaceSpec(normalized)
      expect(parsed.ok).toBe(false)
      reserved((parsed as { errors: string[] }).errors)
      // the tool's own function, called without the dispatch's precheck
      const events: unknown[] = []
      const ctx = { deps: { conn, run_id: run.id, session, emit: (name: string, data: unknown) => { events.push([name, data]) }, tool_calls: 0 }, tool_call_id: 'c1' }
      const out = await presentUiTool(ctx as never, JSON.parse(text) as never)
      expect(out.status, `${value}${options}`).toBe('invalid')
      reserved(out.errors as string[])
      expect(events.some((e) => (e as unknown[])[0] === 'ui_surface')).toBe(false)
      // and the registered dispatch refuses it before its schema reads the arguments
      const v = tool.validate(JSON.parse(text))
      expect('error' in v).toBe(true)
      expect(String((v as { error: string }).error)).toContain('reserved')
    }
  }
  expect(repo.listUiSurfaces(conn, session.id)).toEqual([])
  expect(repo.listUiPublications(conn, session.id)).toEqual([])
  // a provider's null on a field the tool declares nullable is still a field left out; a null elsewhere stays and is refused
  const withNulls = { ...panel([]), initial_state: null, html: null, html_file: null, scope: null, expected_revision: null, actions: [{ id: 'ask', label: 'Ask', prompt: 'p', mode: null }] }
  const split = splitUiPublishArgs(withNulls)
  expect(split.options.ok).toBe(true)
  expect(parseUiSurfaceSpec(specOfArgs(split.spec)).ok).toBe(true)
  expect(parseUiSurfaceSpec(specOfArgs({ ...panel([]), title: null })).ok).toBe(false)
  expect(parseUiSurfaceSpec(specOfArgs({ ...panel([]), unknown_key: null })).ok).toBe(false)
  okSurface(presentSurface(conn, who(run), specOfArgs(splitUiPublishArgs({ ...withNulls, scope: 'session', expected_revision: 0 }).spec), session1))
})

test('a row of a migrated database without the new values reads as scope run, written by its own run', () => {
  const base = tempDir()
  const conn = connect(join(base, 'db', 'index.db'))
  try {
    conn.run("INSERT INTO projects (id, name, base_repo_path, created_at, updated_at) VALUES ('p_1','legacy','/x','t','t')")
    conn.run("INSERT INTO sessions (id, project_id, title, model, created_at, updated_at) VALUES ('s_1','p_1','t','m','t','t')")
    conn.run("INSERT INTO runs (id, session_id, project_id, model, user_text, status, created_at) VALUES ('run_1','s_1','p_1','m','hi','done','t')")
    // as an old build's insert leaves it: no scope named (the column's default), no writer
    conn.run("INSERT INTO ui_surfaces (session_id, run_id, surface_id, revision, spec_json, state_json, model, created_at, updated_at) VALUES ('s_1','run_1','old',2,?,'{}','m','t','t')", [JSON.stringify(panel([], { surface_id: 'old' }))])
    const raw = conn.get("SELECT scope, updated_by_run_id FROM ui_surfaces WHERE surface_id='old'")!
    expect([raw.scope, raw.updated_by_run_id]).toEqual(['run', null])
    const rec = repo.getUiSurface(conn, 's_1', 'run_1', 'old')!
    expect([rec.scope, rec.updated_by_run_id]).toEqual(['run', 'run_1'])
    expect(UiSurfaceRecordSchema.safeParse(rec).success).toBe(true)
    expect(UiReadSnapshotSchema.safeParse(uiReadSnapshot(rec)).success).toBe(true)
    expect(readSurface(conn, { session_id: 's_1', run_id: 'run_1' }, { surface_id: 'old' })).toMatchObject({ status: 'ok', surface: { scope: 'run', updated_by_run_id: 'run_1', revision: 2 } })
  } finally { conn.close() }
})

// ---- v22 → v23 -----------------------------------------------------------------------------------------------------

/** ui_surfaces as v21 and v22 had it. */
const UI_SURFACES_V22 = `
CREATE TABLE ui_surfaces (
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  run_id      TEXT NOT NULL REFERENCES runs(id),
  surface_id  TEXT NOT NULL,
  revision    INTEGER NOT NULL,
  spec_json   TEXT NOT NULL,
  state_json  TEXT NOT NULL DEFAULT '{}',
  model       TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (session_id, run_id, surface_id)
);
CREATE INDEX ui_surfaces_by_session ON ui_surfaces(session_id, created_at);
`

function structure(conn: Conn): Record<string, unknown> {
  const tables = conn.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").map((r) => r.name as string).sort()
  const out: Record<string, unknown> = {}
  for (const t of tables) {
    out[t] = {
      columns: conn.all(`PRAGMA table_info(${t})`).map((r) => [r.name, r.type, r.notnull, r.dflt_value, r.pk]),
      indexes: conn.all(`PRAGMA index_list(${t})`).map((r) => [r.name, r.unique, r.partial]).filter(([n]) => !String(n).startsWith('sqlite_')).sort(),
    }
  }
  return out
}

test('a v22 database comes to v23: its surfaces kept as run (none becomes a session surface), the writer and the journal backfilled, one backup, a fresh one\'s structure', () => {
  const base = tempDir()
  const fresh = connect(join(base, 'fresh', 'index.db'))
  const dir = join(base, 'old')
  const path = join(dir, 'index.db')
  const made = connect(path)
  made.exec('DROP TABLE ui_publications')
  made.exec('DROP TABLE ui_surfaces')
  made.exec(UI_SURFACES_V22)
  made.exec('DROP INDEX IF EXISTS runs_read; PRAGMA user_version = 22')
  made.run("INSERT INTO projects (id, name, base_repo_path, created_at, updated_at) VALUES ('p_1','legacy','/x','t','t')")
  made.run("INSERT INTO sessions (id, project_id, title, model, created_at, updated_at, workspace_id) VALUES ('s_1','p_1','t','m','t','t','ws_1')")
  made.run("INSERT INTO runs (id, session_id, project_id, workspace_id, model, user_text, status, created_at) VALUES ('run_1','s_1','p_1','ws_1','m','hi','done','t')")
  made.run("INSERT INTO runs (id, session_id, project_id, workspace_id, model, user_text, status, created_at) VALUES ('run_2','s_1','p_1','ws_1','m','hi','done','t2')")
  const spec = JSON.stringify(panel([[0, 1]]))
  made.run("INSERT INTO ui_surfaces (session_id, run_id, surface_id, revision, spec_json, state_json, model, created_at, updated_at) VALUES ('s_1','run_1','panel',3,?, '{\"note\":\"n\"}', 'm', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:01.000Z')", [spec])
  made.run("INSERT INTO ui_surfaces (session_id, run_id, surface_id, revision, spec_json, state_json, model, created_at, updated_at) VALUES ('s_1','run_2','panel',1,?, '{}', 'm', '2026-10-02T00:00:00.000Z', '2026-10-02T00:00:00.000Z')", [spec])
  made.close()
  writeFileSync(join(dir, 'index.db.v21.bak'), 'an older upgrade\'s copy')
  const migrated = connect(path)
  try {
    expect(migrated.get('PRAGMA user_version')!.user_version).toBe(38)
    expect(structure(migrated)).toEqual(structure(fresh))
    const s = structure(migrated) as Record<string, { indexes: unknown[][] }>
    expect(s.ui_surfaces!.indexes).toContainEqual(['ui_surfaces_session_scope', 1, 1])            // unique, partial
    // the backup of v22, the only one kept
    expect(readdirSync(dir).filter((f) => f.includes('.bak')).sort()).toEqual(['index.db.v22.bak'])
    // the rows: run surfaces, as they were; written by their own runs
    const rows = repo.listUiSurfaces(migrated, 's_1')
    expect(rows.map((r) => [r.run_id, r.scope, r.updated_by_run_id, r.revision, r.state])).toEqual([['run_1', 'run', 'run_1', 3, { note: 'n' }], ['run_2', 'run', 'run_2', 1, {}]])
    expect(repo.getSessionUiSurface(migrated, 's_1', 'panel')).toBeNull()
    for (const r of rows) expect(UiSurfaceRecordSchema.safeParse(r).success).toBe(true)
    // the journal: one row per revision there was, so the limits count as before
    expect(repo.listUiPublications(migrated, 's_1').map((p) => [p.anchor_run_id, p.revision, p.writer_run_id])).toEqual([['run_1', 1, 'run_1'], ['run_1', 2, 'run_1'], ['run_1', 3, 'run_1'], ['run_2', 1, 'run_2']])
    expect(repo.countUiRevisions(migrated, 'run_1')).toEqual({ surfaces: 1, revisions: 3 })
    // a session surface of the same id now: its own row, beside the old ones (an anchor run of the main thread)
    migrated.run("INSERT INTO runs (id, session_id, project_id, workspace_id, model, user_text, status, created_at) VALUES ('run_3','s_1','p_1','ws_1','m','hi','running','t3')")
    const made3 = presentSurface(migrated, { session_id: 's_1', run_id: 'run_3', model: 'm' }, panel([[0, 1]]), session1)
    expect(made3.ok).toBe(true)
    // the old run surfaces cannot be reached as session ones, nor turned into them
    expect(presentSurface(migrated, { session_id: 's_1', run_id: 'run_1', model: 'm' }, panel([[0, 1]]), at(3)).ok).toBe(false)
    expect(repo.getUiSurface(migrated, 's_1', 'run_1', 'panel')!.revision).toBe(3)
  } finally {
    migrated.close()
    fresh.close()
  }
  // opened again: nothing to do, no new backup, the same rows
  const again = connect(path)
  try {
    expect(again.get('PRAGMA user_version')!.user_version).toBe(38)
    expect(readdirSync(dir).filter((f) => f.includes('.bak')).sort()).toEqual(['index.db.v22.bak'])
    expect(repo.listUiPublications(again, 's_1')).toHaveLength(5)
    expect(existsSync(join(dir, 'index.db.v22.bak'))).toBe(true)
  } finally { again.close() }
})
