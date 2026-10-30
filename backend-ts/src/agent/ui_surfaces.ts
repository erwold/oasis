/** Intelligent UI on the server: the surfaces a run presents (present_ui), the person's values on them, and the
 *  actions the person prepares from them. The spec is the contract's (contract/src/ui.ts) and is validated whole
 *  before anything is written; the server sets who presented it (session, run, model) and when — a spec never does.
 *
 *  An action is never executed here: no tool runs, no model is called, no run starts or resumes. The server checks
 *  that the action is the surface's, at the revision the person saw, saves the values, records a receipt (one per
 *  request id: the same request again answers the same receipt, another payload under it is a conflict) and builds
 *  a bounded prompt the person reviews in their draft and sends — or not — through the session's ordinary flow.
 *
 *  Scope (contract UiPublishOptions): a surface is its run's (`run`, the default: one row per session, run and id), or —
 *  chosen explicitly by the publishing call — the session's main thread's (`session`: one row per session and id,
 *  anchored at the run that created it, updated in place at the revision the call expects, by main-thread runs only,
 *  decided from the run and session rows inside the writing transaction). Every revision written is journalled with
 *  the run that wrote it (ui_publications), and a run's limits count those rows: its own writes, of either scope. */

import { createHash } from 'node:crypto'
import {
  buildUiActionPrompt, checkUiJson, defaultUiState, parseUiSurfaceSpec, UI_LIMITS, UI_SESSION_SURFACES_MAX, uiSessionScopeRefusal,
  uiReadSnapshot, uiSurfaceScope, validateUiState,
  type UiActionBody, type UiActionResponse, type UiPublishConflict, type UiPublishOptions, type UiReadResult, type UiState,
  type UiStateBody, type UiSurfaceRecord, type UiSurfaceScope, type UiSurfaceSpec,
} from '@oasis-code/contract'
import type { Conn } from '../db/database.ts'
import * as repo from '../db/repo.ts'
import { nowIso } from '../timebase.ts'

/** A run presents at most this many surfaces, and this many revisions in all: what a run's record (and so what a
 *  provider is sent again) can grow by through present_ui stays bounded. */
export const MAX_UI_SURFACES_PER_RUN = 20
export const MAX_UI_REVISIONS_PER_RUN = 60
/** The largest body the state and action routes read, in UTF-8 bytes as it arrives (a body declared or streamed past
 *  it is refused without being read further). Room for the largest state (UI_LIMITS.stateChars UTF-16 units of JSON,
 *  at most 3 bytes each, or 6 for a client that writes \uXXXX escapes) and the request's other fields; the state's
 *  own limits are checked after, on the parsed value. */
export const MAX_UI_BODY_BYTES = 128 * 1024

/** A refusal the API answers with its status, a machine code and (some) the surface as it stands. */
export class UiError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 413 | 422 | 503, readonly code: string, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message)
    this.name = 'UiError'
  }
}

/** What presentSurface answers: the surface written; or nothing written — the spec or a limit refused it (`errors`),
 *  the calling run may not publish a session surface (`refused`, its reason), or the revision the call expected is not
 *  the surface's (`conflict`). */
export type PresentResult =
  | { ok: true; surface: UiSurfaceRecord }
  | { ok: false; errors: string[] }
  | { ok: false; refused: string; errors: string[] }
  | { ok: false; conflict: UiPublishConflict; errors: string[] }

/** The state a new revision starts with: its defaults; then the person's values from the revision before for every
 *  key the new spec still has (and accepts the value of); the keys the new spec's initial_state names take its value. */
export function carriedState(prev: UiSurfaceRecord | null, spec: UiSurfaceSpec): UiState {
  const out: UiState = defaultUiState(spec)
  if (prev === null) return out
  const explicit = new Set(Object.keys(spec.initial_state ?? {}))
  for (const [k, v] of Object.entries(prev.state)) {
    if (explicit.has(k)) continue
    if (spec.kind === 'native' && !Object.hasOwn(out, k)) continue
    if (validateUiState(spec, { [k]: v }).ok) out[k] = v
  }
  const whole = validateUiState(spec, out)
  return whole.ok ? whole.value : defaultUiState(spec)
}

/** Why a run may not create, update or read its session's `session` surfaces (null: it may), from the run and session
 *  rows as they stand now — never from what a call or a model says (contract uiSessionScopeRefusal). */
export function sessionScopeRefusal(conn: Conn, sessionId: string, runId: string): string | null {
  const run = repo.getRun(conn, runId)
  if (run === null) return 'the run is not of this session'
  return uiSessionScopeRefusal(run, repo.getSession(conn, sessionId))
}

/** The limits a run's publications count against: from the journal of what this run itself wrote (either scope), so
 *  the revisions other runs wrote to a session surface never count for this one. */
function runLimitErrors(conn: Conn, writerRunId: string, sessionId: string, anchorRunId: string, surfaceId: string): string[] {
  const count = repo.countUiRevisions(conn, writerRunId)
  if (!repo.hasUiPublication(conn, writerRunId, sessionId, anchorRunId, surfaceId) && count.surfaces >= MAX_UI_SURFACES_PER_RUN) {
    return [`this run has presented ${count.surfaces} surfaces, the most one run may; update one of them (the same surface_id) instead`]
  }
  if (count.revisions >= MAX_UI_REVISIONS_PER_RUN) return [`this run has presented ${count.revisions} revisions, the most one run may`]
  return []
}

/** present_ui: validate the spec whole; then, in one transaction, check and write — scope `run` (the default): revision
 *  1 of the surface id in this run, or its next one; scope `session`: the session surface of that id, created (expected
 *  revision 0) or updated in place (expected revision n, the one it is at), by a run of the session's main thread only.
 *  A conflict, a refusal or a limit writes nothing and counts nothing; a revision written is journalled with the run
 *  that wrote it, in the same transaction. */
export function presentSurface(conn: Conn, who: { session_id: string; run_id: string; model: string | null }, input: unknown,
  options: UiPublishOptions = { scope: 'run', expected_revision: null }): PresentResult {
  if (options.scope === 'session') return presentSessionSurface(conn, who, input, options.expected_revision)
  const parsed = parseUiSurfaceSpec(input)
  if (!parsed.ok) return parsed
  const spec = parsed.value
  return conn.transaction((): PresentResult => {
    const prev = repo.getUiSurface(conn, who.session_id, who.run_id, spec.surface_id)
    // one row per (session, run, surface_id): a session surface this run anchors keeps that id, and is never written
    // here (it changes only at the revision a session publish expects)
    if (prev !== null && uiSurfaceScope(prev) !== 'run') return { ok: false, errors: [`surface_id ${spec.surface_id}: this run's surface of that id has scope session; it is published with scope session and expected_revision`] }
    const limits = runLimitErrors(conn, who.run_id, who.session_id, who.run_id, spec.surface_id)
    if (limits.length > 0) return { ok: false, errors: limits }
    const t = nowIso()
    const surface: UiSurfaceRecord = {
      session_id: who.session_id, run_id: who.run_id, surface_id: spec.surface_id, scope: 'run', updated_by_run_id: who.run_id,
      revision: prev === null ? 1 : prev.revision + 1,
      spec, state: carriedState(prev, spec), model: who.model, created_at: prev?.created_at ?? t, updated_at: t,
    }
    const stamp = repo.putUiSurface(conn, surface)
    if (stamp === null) return { ok: false, errors: [`surface_id ${spec.surface_id}: this run's surface of that id has scope session`] }
    surface.updated_at = stamp
    repo.insertUiPublication(conn, { session_id: who.session_id, anchor_run_id: who.run_id, surface_id: spec.surface_id, revision: surface.revision, writer_run_id: who.run_id })
    return { ok: true, surface }
  })
}

function presentSessionSurface(conn: Conn, who: { session_id: string; run_id: string; model: string | null }, input: unknown, expected: number): PresentResult {
  return conn.transaction((): PresentResult => {
    // who may: the run and session rows as they are now, inside the transaction that writes
    const run = repo.getRun(conn, who.run_id)
    const refusal = run === null ? 'the run is not of this session' : uiSessionScopeRefusal(run, repo.getSession(conn, who.session_id))
    if (refusal !== null) return { ok: false, refused: refusal, errors: [`scope session: ${refusal}`] }
    const parsed = parseUiSurfaceSpec(input)
    if (!parsed.ok) return parsed
    const spec = parsed.value
    const prev = repo.getSessionUiSurface(conn, who.session_id, spec.surface_id)
    const conflict = (current: number | null): PresentResult => {
      const c: UiPublishConflict = { status: 'conflict', surface_id: spec.surface_id, scope: 'session', expected_revision: expected, current_revision: current }
      return { ok: false, conflict: c, errors: [current === null ? `surface ${spec.surface_id} does not exist (expected revision ${expected})` : `surface ${spec.surface_id} is at revision ${current}, not ${expected}`] }
    }
    if (expected === 0 && prev !== null) return conflict(prev.revision)
    if (expected > 0 && (prev === null || prev.revision !== expected)) return conflict(prev?.revision ?? null)
    if (prev === null) {
      // a new one: anchored at this run, which must not hold a run surface of the same id (a scope never changes)
      const mine = repo.getUiSurface(conn, who.session_id, who.run_id, spec.surface_id)
      if (mine !== null) return { ok: false, errors: [`surface_id ${spec.surface_id}: this run has a surface of that id with scope run; a surface keeps its scope`] }
      const held = repo.countSessionUiSurfaces(conn, who.session_id)
      if (held >= UI_SESSION_SURFACES_MAX) return { ok: false, errors: [`this session holds ${held} session surfaces, the most one session may`] }
    }
    const anchor = prev?.run_id ?? who.run_id
    const limits = runLimitErrors(conn, who.run_id, who.session_id, anchor, spec.surface_id)
    if (limits.length > 0) return { ok: false, errors: limits }
    const t = nowIso()
    const surface: UiSurfaceRecord & { updated_by_run_id: string } = {
      session_id: who.session_id, run_id: anchor, surface_id: spec.surface_id, scope: 'session', updated_by_run_id: who.run_id,
      revision: prev === null ? 1 : prev.revision + 1,
      // the person's values as they are now (read in this transaction), carried as for any republish
      spec, state: carriedState(prev, spec), model: run!.model || who.model, created_at: prev?.created_at ?? t, updated_at: t,
    }
    const stamp = prev === null ? repo.insertSessionUiSurface(conn, surface) : repo.updateSessionUiSurface(conn, surface, expected)
    if (stamp === null) {
      const now = repo.getSessionUiSurface(conn, who.session_id, spec.surface_id)
      return conflict(now?.revision ?? null)
    }
    surface.updated_at = stamp
    repo.insertUiPublication(conn, { session_id: who.session_id, anchor_run_id: anchor, surface_id: spec.surface_id, revision: surface.revision, writer_run_id: who.run_id })
    return { ok: true, surface }
  })
}

/** read_ui: the surface's published snapshot (contract uiReadSnapshot: the spec, revision, scope, anchor, writer,
 *  model and times — never the person's current state, which reaches a model only through an action they take) — a
 *  `run` surface of the calling run, or (scope session, for a run of the session's main thread) the session's surface
 *  of that id. Nothing outside what the calling run may read is told apart from nothing at all; a refusal names no
 *  surface. */
export function readSurface(conn: Conn, who: { session_id: string; run_id: string }, args: { surface_id: string; scope?: UiSurfaceScope | null }): UiReadResult {
  const scope: UiSurfaceScope = args.scope === 'session' ? 'session' : 'run'
  return conn.transaction((): UiReadResult => {
    if (scope === 'run') {
      const rec = repo.getRunUiSurface(conn, who.session_id, who.run_id, args.surface_id)
      return rec === null ? { status: 'not_found', surface_id: args.surface_id, scope } : { status: 'ok', surface: uiReadSnapshot(rec) }
    }
    const refusal = sessionScopeRefusal(conn, who.session_id, who.run_id)
    if (refusal !== null) return { status: 'refused', scope: 'session', reason: refusal }
    const rec = repo.getSessionUiSurface(conn, who.session_id, args.surface_id)
    return rec === null ? { status: 'not_found', surface_id: args.surface_id, scope } : { status: 'ok', surface: uiReadSnapshot(rec) }
  })
}

/** The surface of a run of this session; a run of another session, or a surface it never presented, is not found. */
export function ownedSurface(conn: Conn, sessionId: string, runId: string, surfaceId: string): UiSurfaceRecord {
  const run = repo.getRun(conn, runId)
  if (run === null || run.session_id !== sessionId) throw new UiError(404, 'not_found', `run not found in this session: ${runId}`)
  const surface = repo.getUiSurface(conn, sessionId, runId, surfaceId)
  if (surface === null) throw new UiError(404, 'not_found', `surface not found: ${surfaceId}`)
  return surface
}

/** The spec of a stored surface this build can act on (a later version, or one that no longer reads, only shows). */
export function actionableSpec(surface: UiSurfaceRecord): UiSurfaceSpec {
  const parsed = parseUiSurfaceSpec(surface.spec)
  if (!parsed.ok) throw new UiError(409, 'unsupported_spec', `this surface's spec cannot take input on this build (${parsed.errors[0] ?? 'unknown'})`, { surface })
  return parsed.value
}

export function checkRevision(surface: UiSurfaceRecord, revision: number): void {
  if (surface.revision !== revision) {
    throw new UiError(409, 'stale_revision', `the surface is at revision ${surface.revision}, not ${revision}: the agent presented it again`, { surface })
  }
}

/** The values the person sent merged over the stored ones, checked against the spec: nothing is written otherwise. */
export function mergedState(spec: UiSurfaceSpec, current: UiState, sent: unknown): UiState {
  const shape = checkUiJson(sent, 4, { maxChars: UI_LIMITS.stateChars })
  if (shape !== null) throw new UiError(400, 'invalid_state', `state: ${shape}`, { errors: [`state: ${shape}`] })
  const own = validateUiState(spec, sent)
  if (!own.ok) throw new UiError(400, 'invalid_state', own.errors.join('; '), { errors: own.errors })
  const merged: UiState = Object.assign(Object.create(null) as UiState, current, own.value)
  const whole = validateUiState(spec, merged)
  if (!whole.ok) throw new UiError(400, 'invalid_state', whole.errors.join('; '), { errors: whole.errors })
  return whole.value
}

/** PUT …/state: the person's values at the revision they saw. */
export function saveSurfaceState(conn: Conn, sessionId: string, runId: string, surfaceId: string, body: UiStateBody): UiSurfaceRecord {
  return conn.transaction(() => {
    const surface = ownedSurface(conn, sessionId, runId, surfaceId)
    const spec = actionableSpec(surface)
    checkRevision(surface, body.revision)
    const state = mergedState(spec, surface.state, body.state)
    if (!repo.setUiSurfaceState(conn, sessionId, runId, surfaceId, body.revision, state)) checkRevision(ownedSurface(conn, sessionId, runId, surfaceId), body.revision)
    return repo.getUiSurface(conn, sessionId, runId, surfaceId)!
  })
}

/** JSON with every object's keys sorted: the same payload hashes the same whatever order its keys came in. */
export function canonicalJson(value: unknown, depth = 0): string {
  // callers check the value's shape first (checkUiJson); the guard keeps a value that skipped it from the stack's end
  if (depth > 32) throw new UiError(400, 'invalid_state', 'the value is nested too deep')
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v, depth + 1)).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k], depth + 1)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function payloadSha(runId: string, surfaceId: string, body: UiActionBody): string {
  return createHash('sha256').update(canonicalJson({ run_id: runId, surface_id: surfaceId, revision: body.revision, action_id: body.action_id, state: body.state })).digest('hex')
}

/** POST …/actions: the receipt of an action the person pressed, its prompt for the draft. Nothing is run or sent. */
export function prepareAction(conn: Conn, sessionId: string, runId: string, surfaceId: string, body: UiActionBody): UiActionResponse {
  return conn.transaction((): UiActionResponse => {
    const surface = ownedSurface(conn, sessionId, runId, surfaceId)
    // the values' shape before anything walks them (the hash recurses): a callable service, not only the route's
    const shape = checkUiJson(body.state, 4, { maxChars: UI_LIMITS.stateChars })
    if (shape !== null) throw new UiError(400, 'invalid_state', `state: ${shape}`, { errors: [`state: ${shape}`] })
    // a request seen before answers as it did — before the current revision or spec is consulted
    const sha = payloadSha(runId, surfaceId, body)
    const earlier = repo.getUiActionReceipt(conn, sessionId, body.request_id)
    if (earlier !== null) {
      if (earlier.payload_sha !== sha) throw new UiError(409, 'request_conflict', `request ${body.request_id} was already used for another action or other values`)
      return { receipt_id: earlier.id, status: 'prepared', prompt: earlier.prompt, surface }
    }
    const spec = actionableSpec(surface)
    checkRevision(surface, body.revision)
    const action = (spec.actions ?? []).find((a) => a.id === body.action_id)
    if (action === undefined) throw new UiError(400, 'unknown_action', `the surface has no action ${body.action_id}`)
    const state = mergedState(spec, surface.state, body.state)
    const prompt = buildUiActionPrompt({ run_id: runId, surface_id: surfaceId, revision: surface.revision, title: spec.title, action, state })
    repo.setUiSurfaceState(conn, sessionId, runId, surfaceId, surface.revision, state)
    const receipt = repo.insertUiActionReceipt(conn, {
      session_id: sessionId, run_id: runId, surface_id: surfaceId, request_id: body.request_id, revision: surface.revision,
      action_id: action.id, payload_sha: sha, state, prompt,
    })
    return { receipt_id: receipt.id, status: 'prepared', prompt, surface: repo.getUiSurface(conn, sessionId, runId, surfaceId)! }
  })
}
