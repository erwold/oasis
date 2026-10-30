/** Intelligent UI surfaces, the page's pure part. The protocol — the spec's parser (graph, bindings, references,
 *  bounds), the evaluator, the default and the validation of a state, the limits, the safe image sources — is the
 *  contract's (`@oasis-code/contract`, ui.ts), used here as it is: this module only adapts it to the page.
 *  - a record's spec read once with the contract's full parser (never a schema alone), its state over the defaults;
 *  - an edit written only when the contract accepts the whole state (null is a value: the person cleared a field);
 *  - (the request queue, one per surface and shared by its views, is uiQueue.ts);
 *  - an action's prompt placed once per receipt, after what the draft holds, never sent. */

import {
  UiSurfaceRecordSchema, defaultUiState, evaluateUiValue, parseUiSurfaceSpec, uiSessionScopeRefusal, uiSurfaceScope, uiSurfaceUpdatedBy, validateUiState, UI_LIMITS,
  type UiAction, type UiResolved, type UiState, type UiStateValue, type UiSurfaceRecord, type UiSurfaceSpec,
} from '@oasis-code/contract'
import { composerOf, withComposer, type ComposerFields } from './composers.ts'

export type { UiAction, UiResolved, UiState, UiStateValue, UiSurfaceRecord, UiSurfaceSpec }

// ---------------------------------------------------------------- the spec

export type SurfaceView = { ok: true; spec: UiSurfaceSpec } | { ok: false; reason: string }

/** The record's spec through the contract's complete parser: a spec it refuses (a later version, a shared or
 *  orphan element, a bad reference, a bound exceeded) is shown as its text version with the first reason. */
export function viewOf(record: Pick<UiSurfaceRecord, 'spec'>): SurfaceView {
  const parsed = parseUiSurfaceSpec(record.spec)
  return parsed.ok ? { ok: true, spec: parsed.value } : { ok: false, reason: parsed.errors[0] ?? 'the spec could not be read' }
}

const textField = (spec: unknown, key: 'title' | 'fallback'): string => {
  const v = typeof spec === 'object' && spec !== null ? (spec as Record<string, unknown>)[key] : undefined
  return typeof v === 'string' ? v.trim() : ''
}

/** The surface's plain-text version (every envelope carries one), whatever else is wrong with the spec. */
export function fallbackOf(spec: unknown): string {
  const f = textField(spec, 'fallback')
  if (!f) return 'This surface has no text version.'
  return f.length > UI_LIMITS.fallbackChars ? `${f.slice(0, UI_LIMITS.fallbackChars)}…` : f
}

export function titleOf(spec: unknown): string {
  const t = textField(spec, 'title')
  return t ? t.slice(0, UI_LIMITS.titleChars) : 'Untitled surface'
}

/** The actions no button of a native surface offers: the footer offers them (an html page can only suggest one, so
 *  the host offers every action of an html surface). */
export function footerActions(spec: UiSurfaceSpec): UiAction[] {
  const all = spec.actions ?? []
  if (spec.kind !== 'native') return all
  const used = new Set(Object.values(spec.elements ?? {}).flatMap((el) => (el.type === 'button' ? [el.props.action] : [])))
  return all.filter((a) => !used.has(a.id))
}

// ---------------------------------------------------------------- values and state

/** A resolved value in words for the page: numbers in the reader's locale (at most six decimals), yes / no, a list
 *  joined, a dash for none. (Evaluation is the contract's evaluateUiValue; this is display only.) */
export function formatValue(v: UiResolved | undefined, locale?: string): string {
  if (v === null || v === undefined) return '—'
  if (Array.isArray(v)) return v.length ? v.map((x) => formatValue(x, locale)).join(', ') : '—'
  if (typeof v === 'number') return v.toLocaleString(locale, { maximumFractionDigits: 6 })
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  return v
}

/** A value of the spec at the state, by the contract's bounded evaluator. */
export const valueAt = (value: unknown, state: UiState): UiResolved => evaluateUiValue(value, state)

/** The state a record stands at: the contract's defaults for the spec, then each value the harness kept that the
 *  contract accepts for this spec (a key of an older revision, a value of another kind, is left at its default). */
export function stateOf(spec: UiSurfaceSpec, kept: unknown): UiState {
  let state = defaultUiState(spec)
  if (typeof kept !== 'object' || kept === null || Array.isArray(kept)) return state
  for (const [key, value] of Object.entries(kept)) {
    const next = { ...state, [key]: value }
    const checked = validateUiState(spec, next)
    if (checked.ok) state = checked.value
  }
  return state
}

/** `state` with `key` set to `value` when the contract accepts the whole state for the spec (null clears a value);
 *  else the same object, nothing written. */
export function writeState(spec: UiSurfaceSpec, state: UiState, key: string, value: unknown): UiState {
  const checked = validateUiState(spec, { ...state, [key]: value })
  return checked.ok ? checked.value : state
}

/** A whole state an html page hands back, when the contract accepts it for the spec; else null (nothing written). */
export function acceptState(spec: UiSurfaceSpec, raw: unknown): UiState | null {
  const checked = validateUiState(spec, raw)
  return checked.ok ? checked.value : null
}

/** Two states equal value for value. */
export function sameState(a: UiState, b: UiState): boolean {
  const ka = Object.keys(a), kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  for (const k of ka) {
    if (!Object.hasOwn(b, k)) return false
    const x = a[k], y = b[k]
    if (Array.isArray(x) || Array.isArray(y)) {
      if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length || x.some((v, i) => v !== y[i])) return false
    } else if (x !== y) return false
  }
  return true
}

/** A number field's words: '' is null (the person cleared it: saved as null), a finite number is that number, any
 *  other words are undefined (not a value: kept as the field's text, nothing written). */
export function parseNumberInput(raw: string): number | null | undefined {
  const t = raw.trim()
  if (!t) return null
  const n = Number(t)
  return Number.isFinite(n) ? n : undefined
}

/** A number outside the field's bounds (said by the field; the contract refuses to store it). */
export function outOfRange(n: number | null | undefined, min: number | undefined, max: number | undefined): boolean {
  if (typeof n !== 'number') return false
  return (min !== undefined && n < min) || (max !== undefined && n > max)
}

/** A slider's value on its scale: clamped, on its step. */
export function sliderValue(raw: number, min: number, max: number, step?: number): number {
  const lo = Math.min(min, max), hi = Math.max(min, max)
  let v = Math.min(hi, Math.max(lo, raw))
  if (typeof step === 'number' && step > 0) v = Math.min(hi, lo + Math.round((v - lo) / step) * step)
  return Number(v.toFixed(10))
}

// ---------------------------------------------------------------- records

/** One surface per run and surface id: another run's surface of the same id is another surface. */
export const surfaceKey = (r: { run_id: string; surface_id: string }): string => `${r.run_id}/${r.surface_id}`

/** A record as the contract defines it (identity, revision, model, times): the reducer takes nothing else. */
export const isSurfaceRecord = (v: unknown): v is UiSurfaceRecord => UiSurfaceRecordSchema.safeParse(v).success

/** Whether `next` is the later word on a surface than `current`: a later spec revision; at one revision, a later
 *  write — the harness makes a surface's `updated_at` strictly increase with each write, so an equal one is the same
 *  write again (nothing to take) and the order of arrival never decides between two writes. A surface never changes
 *  scope: a record of the other scope under the same key is never the later word on it. */
export function supersedes(next: UiSurfaceRecord, current: UiSurfaceRecord | undefined): boolean {
  if (!current) return true
  if (uiSurfaceScope(next) !== uiSurfaceScope(current)) return false
  if (next.revision !== current.revision) return next.revision > current.revision
  return next.updated_at > current.updated_at
}

/** A surface the session's main thread keeps up to date across its runs (scope `session`): it stays at the run that
 *  first presented it (its run_id, the anchor) and later runs update it there. */
export const isSessionSurface = (r: { scope?: string | null }): boolean => uiSurfaceScope(r) === 'session'

/** When a live surface last changed, in the person's own clock: "14:05" today, "Oct 12, 14:05" another day (the
 *  record's updated_at — a revision of the agent's or a saved edit); '' for a time that does not read. */
export function updatedLabel(iso: string, now: Date = new Date(), locale?: string): string {
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return ''
  const time = t.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
  const sameDay = t.getFullYear() === now.getFullYear() && t.getMonth() === now.getMonth() && t.getDate() === now.getDate()
  return sameDay ? time : `${t.toLocaleDateString(locale, { month: 'short', day: 'numeric', ...(t.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) })}, ${time}`
}

/** What a `ui_surface` event of run `runId` may do with its record:
 *  - `own`: the run's own surface (run_id is the run): its row in the run's rows;
 *  - `cross`: a session surface another run of the thread presented first, updated by this run (the event's run is the
 *    one that wrote it): the anchor run's row is updated, the event's own run gets no row;
 *  - null: neither (another run's record, a writer that is not this run, a record the contract refuses): not shown.
 *  The writer is always the event's run: a run surface is only ever written by its own run. */
export function surfaceEventRole(runId: string, record: unknown): 'own' | 'cross' | null {
  if (!isSurfaceRecord(record) || uiSurfaceUpdatedBy(record) !== runId) return null
  if (record.run_id === runId) return 'own'
  return isSessionSurface(record) ? 'cross' : null
}

// ---------------------------------------------------------------- who may present a session surface (the page's check)
//
// The trust boundary. The harness decides who may create, update or read a session surface (uiSessionScopeRefusal on
// the run and session rows it holds, in the write's transaction); the page cannot make anything allowed. What the page
// does is refuse to SHOW a session surface whose run it knows to be one the contract excludes — a run with a parent,
// under a work order, a relay's turn, an interaction's node, not started by one of THREAD_SPAWNERS, of another session
// or of another workspace — whatever the record says of itself (its scope, its session_id, its run_id are the
// message's words, never the proof). The facts it checks are the run and session rows the harness answered the page
// with (session detail, the tree), never the event's. Where the page holds no row of a run:
//  - a run event (live, replay): the event's own run must be known — unknown is refused (fail closed);
//  - a record the harness answered as the session's (GET …/ui, a transcript, a state or action answer): a run the page
//    does not know is the harness's word (it filtered the list); a run it knows and the contract excludes is refused.
// A run surface (scope `run`, every surface before scopes) is not touched by any of this.

/** A run's facts the contract's check reads, as a page row holds them (a tree row or a session's run). */
export interface RunFacts {
  id: string; session_id: string; workspace_id?: string | null; parent_run_id?: string | null; work_order?: unknown
  relay_id?: string | null; interaction_id?: string | null; spawned_by: string
}
/** The session's facts, as the session detail says them. */
export interface SessionFacts { id: string; workspace_id: string | null }

/** Why `run` may not present a session surface of `session` (the contract's uiSessionScopeRefusal on the page's rows;
 *  a field an older row lacks is read as the contract's default, null), or null: it may. An unknown run or session is
 *  refused. */
export function sessionWriterRefusal(run: RunFacts | null | undefined, session: SessionFacts | null | undefined): string | null {
  if (!run) return 'the run is not known on this page'
  if (!session) return 'the session is not known on this page'
  return uiSessionScopeRefusal({
    session_id: run.session_id, workspace_id: run.workspace_id ?? null, parent_run_id: run.parent_run_id ?? null,
    work_order: (run.work_order ?? null) as never, relay_id: run.relay_id ?? null, interaction_id: run.interaction_id ?? null,
    spawned_by: run.spawned_by,
  }, session)
}

/** Whether a `ui_surface` event of `run` may be shown for what it carries: a run surface — always (its own rules
 *  apply: surfaceEventRole); a session surface — only of this session, from a run the contract lets present one
 *  (sessionWriterRefusal: the event's own run, as the page's rows know it — unknown is refused). Both the anchor's own
 *  event and a later run's update go through here. */
export function sessionEventRefusal(record: unknown, runId: string, run: RunFacts | null | undefined, session: SessionFacts | null | undefined): string | null {
  if (!isSurfaceRecord(record) || !isSessionSurface(record)) return null
  if (!session || record.session_id !== session.id) return 'the surface is not of this session'
  if (run && run.id !== runId) return 'the run is not the event\'s'
  return sessionWriterRefusal(run, session)
}

/** Whether a record the harness answered as the session's (its list, a transcript, a state or action answer) may be
 *  shown: a run surface — yes; a session surface — of this session, and neither its anchor nor its writer is a run the
 *  page knows and the contract excludes (a run the page does not know is the harness's word). */
export function admitSessionRecord(record: UiSurfaceRecord, known: (runId: string) => RunFacts | undefined, session: SessionFacts | null | undefined): boolean {
  if (!isSessionSurface(record)) return true
  if (!session || record.session_id !== session.id) return false
  for (const id of new Set([record.run_id, uiSurfaceUpdatedBy(record)])) {
    const run = known(id)
    if (run && sessionWriterRefusal(run, session) !== null) return false
  }
  return true
}

/** The very same word on a surface (a resent event, a list that brings what the page has): nothing to redraw. */
export function sameWord(a: UiSurfaceRecord, b: UiSurfaceRecord): boolean {
  return a.revision === b.revision && a.updated_at === b.updated_at && sameState(a.state ?? {}, b.state ?? {})
}

export interface LocalSurface { revision: number; state: UiState }

/** The person's state against a record that came in: a new spec revision takes the record's state (the spec it
 *  belongs to changed); at the same revision the record's state is taken only while nothing of the person's waits
 *  or is on its way — no answer to an older save, no list read before the edit, undoes a newer edit. */
export function reconcile(local: LocalSurface, record: UiSurfaceRecord, spec: UiSurfaceSpec, editing: boolean): LocalSurface {
  if (record.revision !== local.revision) return { revision: record.revision, state: stateOf(spec, record.state) }
  if (editing) return local
  const state = stateOf(spec, record.state)
  return sameState(state, local.state) ? local : { revision: record.revision, state }
}

// ---------------------------------------------------------------- actions

/** What one press of an action sends, fixed when it is pressed: the surface's own session, run, id and revision, the
 *  state as it stood, and its idempotency key. Nothing that changes afterwards (the page, the record, the person's
 *  next edits) changes where its prompt goes or what it asked. */
export interface ActionSnapshot {
  session_id: string; run_id: string; surface_id: string; revision: number; action_id: string; state: UiState; request_id: string
}

/** A press as a snapshot. A retry of a press that failed — the same surface, revision, action and state — keeps its
 *  key (the harness answers it once); a press with anything changed is a new request with a new key (an old key with
 *  a new payload would be refused for good). */
export function snapshotAction(record: Pick<UiSurfaceRecord, 'session_id' | 'run_id' | 'surface_id'>, revision: number, actionId: string, state: UiState,
  failed: ActionSnapshot | null, newId: () => string = newRequestId): ActionSnapshot {
  const same = failed !== null && failed.session_id === record.session_id && failed.run_id === record.run_id && failed.surface_id === record.surface_id
    && failed.revision === revision && failed.action_id === actionId && sameState(failed.state, state)
  return { session_id: record.session_id, run_id: record.run_id, surface_id: record.surface_id, revision, action_id: actionId, state: { ...state }, request_id: same ? failed.request_id : newId() }
}

/** A prepared prompt placed once per receipt: a retry answered with the same receipt places nothing again. */
export function placeOnce(placed: Set<string>, receiptId: string, place: () => void): boolean {
  if (placed.has(receiptId)) return false
  placed.add(receiptId)
  place()
  return true
}

/** The draft with an action's prepared words after what the person had written (kept as it was, mentions and all),
 *  a blank line between; an empty draft takes them alone. */
export function appendToDraft(draft: string, text: string): string {
  const add = text.trim()
  if (!add) return draft
  if (!draft.trim()) return add
  return `${draft.replace(/\s+$/, '')}\n\n${add}`
}

/** The composers with a prepared prompt added to the draft of `owner` — the session the surface belongs to — whether it
 *  is the one on show (`shown`) or one put away: never the draft of the session on show instead. Only the words
 *  change; its images and the rest of the composer stay as they are. */
export function withPromptInDraft(s: ComposerFields, shown: string, owner: string, text: string): Partial<ComposerFields> {
  return withComposer(s, shown, owner, { draft: appendToDraft(composerOf(s, shown, owner).draft, text) })
}

/** A fresh idempotency key (the contract's request id: 8–100 of letters, digits, _ . : -). */
export function newRequestId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  return c?.randomUUID ? `ui-${c.randomUUID()}` : `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}
