/** request_input's forms, the page's part. A form is the request of one tool call (the present_ui native catalog, no
 *  buttons) that its run waits on; the person's submitted values are that call's result and the same run goes on.
 *
 *  - the record (UiInputRecord) is the harness's word: its `ui_input` events on the run's stream, the list of pending
 *    ones after a refresh, the answer to a submit or a dismiss; a later `updated_at` is the later word;
 *  - in a run's rows a form is one row per input id, placed where its run asked for it (never folded into the work);
 *  - what the person is filling in and where the answer stands (sending, refused with the contract's errors, a request
 *    that failed) is held per input id in a registry, not by a view: the thread's row and an agent card's show the same
 *    values, and leaving the session and coming back keeps them. Only a pending form takes an answer. */

import {
  parseUiInputRequest, uiInputRequestSpec, UiInputRecordSchema, validateUiInputValues,
  type UiInputRecord, type UiInputRequest, type UiState, type UiSurfaceSpec,
} from '@oasis-code/contract'
import type { ThreadEntry } from './thread.ts'
import { newRequestId, sameState, stateOf, writeState } from './uiSurface.ts'

export type { UiInputRecord, UiInputRequest }

/** A record as the contract defines it (the request read loosely: a later build's form still lists by its title). */
export function isInputRecord(v: unknown): v is UiInputRecord {
  return UiInputRecordSchema.safeParse(v).success
}

/** Whether `next` is the later word on an input than `current` (updated_at strictly increases with each write). */
export function inputSupersedes(next: Pick<UiInputRecord, 'updated_at'>, current: Pick<UiInputRecord, 'updated_at'> | undefined): boolean {
  return !current || next.updated_at > current.updated_at
}

export type InputForm = { ok: true; request: UiInputRequest; spec: UiSurfaceSpec } | { ok: false; reason: string }

/** The form a record's request draws as: read again with the contract's full check (a request it refuses shows why). */
export function formOf(record: Pick<UiInputRecord, 'request'>): InputForm {
  const parsed = parseUiInputRequest(record.request)
  if (!parsed.ok) return { ok: false, reason: parsed.errors[0] ?? 'the form could not be read' }
  const spec = uiInputRequestSpec(parsed.value)
  // a required text or number field says so in the field itself
  const required = new Set(parsed.value.required ?? [])
  const elements = Object.fromEntries(Object.entries(spec.elements ?? {}).map(([id, el]) =>
    [id, el.type === 'input' && required.has(el.props.key) ? { ...el, props: { ...el.props, required: true } } : el]))
  return { ok: true, request: parsed.value, spec: { ...spec, elements } }
}

/** The run's rows with an input's record: its row updated in place when the record is the later word; a request not
 *  yet in the rows joins at their end (where the run asked for it). */
export function upsertInput(thread: ThreadEntry[], runId: string, record: UiInputRecord, eventId?: string): ThreadEntry[] {
  const at = thread.findIndex((e) => e.kind === 'input' && e.input?.id === record.id)
  if (at < 0) return [...thread, { kind: 'input', runId, eventId, eventName: 'ui_input', toolCallId: record.tool_call_id, input: record }]
  const current = thread[at]!.input
  if (!inputSupersedes(record, current)) return thread
  const next = [...thread]
  next[at] = { ...next[at]!, input: record }
  return next
}

/** What closed a form, in words. */
export function closedLine(record: Pick<UiInputRecord, 'status' | 'closed_reason'>): string {
  if (record.status === 'submitted') return 'Submitted — the agent continues with your answer'
  if (record.status === 'dismissed') return 'Declined — the agent was told you declined'
  if (record.status !== 'closed') return ''
  switch (record.closed_reason) {
    case 'cancelled': return 'Closed — the run was stopped while it waited'
    case 'budget': return 'Closed — the run reached its budget while it waited'
    case 'interrupted': return 'Closed — the app stopped while it waited'
    default: return 'Closed'
  }
}

// ---------------------------------------------------------------- answering a form

export type InputPhase =
  | { kind: 'idle' }
  | { kind: 'sending'; what: 'submit' | 'dismiss' }
  /** the contract (here, or the harness) refused the values: nothing was sent, or the harness kept nothing */
  | { kind: 'invalid'; errors: string[] }
  /** the request failed (the network, the harness): the person may try again; a retry of the same answer keeps its key */
  | { kind: 'error'; message: string; what: 'submit' | 'dismiss' }

export interface InputView { values: UiState; phase: InputPhase }

export interface InputDeps {
  submit: (sessionId: string, inputId: string, body: { values: UiState; request_id: string }) => Promise<UiInputRecord>
  dismiss: (sessionId: string, inputId: string, body: { request_id: string }) => Promise<UiInputRecord>
  /** a record the harness answered with (into the store and the rows) */
  adopt: (record: UiInputRecord) => void
  newId?: () => string
}

export interface InputController {
  view: () => InputView
  subscribe: (listener: (v: InputView) => void) => () => void
  /** the person changed a field (kept only when the contract takes the whole state for the form) */
  setValue: (spec: UiSurfaceSpec, key: string, value: unknown) => void
  /** send the values (checked first: a refused state is said here, not sent) */
  submit: (record: UiInputRecord, form: Extract<InputForm, { ok: true }>) => Promise<void>
  dismiss: (record: UiInputRecord) => Promise<void>
}

function errorOf(e: unknown): { status: number | null; code: string | null; body: Record<string, unknown> | null; message: string } {
  const x = e as { status?: unknown; detail?: unknown; body?: unknown; message?: unknown } | null
  const body = x && typeof x.body === 'object' && x.body !== null ? (x.body as Record<string, unknown>) : null
  return {
    status: typeof x?.status === 'number' ? x.status : null,
    code: typeof body?.error === 'string' ? body.error : null,
    body,
    message: typeof x?.detail === 'string' && x.detail ? x.detail : typeof x?.message === 'string' ? x.message : String(e),
  }
}

export function createInputController(record: UiInputRecord, deps: InputDeps): InputController {
  const form = formOf(record)
  let values: UiState = form.ok ? stateOf(form.spec, form.request.initial_state ?? {}) : {}
  let phase: InputPhase = { kind: 'idle' }
  /** the last answer that failed in transit, with its key: the same answer again keeps it (the harness answers once) */
  let failed: { what: 'submit' | 'dismiss'; values: UiState | null; request_id: string } | null = null
  const listeners = new Set<(v: InputView) => void>()
  let snapshot: InputView | null = null
  const view = () => (snapshot ??= { values, phase })
  const emit = () => { snapshot = null; const v = view(); for (const l of [...listeners]) l(v) }
  const keyFor = (what: 'submit' | 'dismiss', vals: UiState | null): string =>
    failed && failed.what === what && (vals === null || (failed.values !== null && sameState(failed.values, vals))) ? failed.request_id : (deps.newId ?? newRequestId)()

  const answer = async (what: 'submit' | 'dismiss', send: (requestId: string) => Promise<UiInputRecord>, vals: UiState | null) => {
    if (phase.kind === 'sending') return
    const requestId = keyFor(what, vals)
    phase = { kind: 'sending', what }
    emit()
    try {
      const answered = await send(requestId)
      failed = null
      phase = { kind: 'idle' }
      deps.adopt(answered)
    } catch (e) {
      const err = errorOf(e)
      if (err.code === 'not_pending' && isInputRecord(err.body?.input)) {
        // answered already (elsewhere, or its run ended): the record says how
        failed = null
        phase = { kind: 'idle' }
        deps.adopt(err.body!.input as UiInputRecord)
      } else if (err.code === 'invalid_values' || err.status === 400 || err.status === 422) {
        failed = null
        const errors = Array.isArray(err.body?.errors) ? (err.body!.errors as unknown[]).map(String) : [err.message]
        phase = { kind: 'invalid', errors }
      } else {
        failed = { what, values: vals, request_id: requestId }
        phase = { kind: 'error', message: err.message, what }
      }
    }
    emit()
  }

  return {
    view,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    setValue: (spec, key, value) => {
      const next = writeState(spec, values, key, value)
      if (next === values) return
      values = next
      // an edit answers the refusal the person read: it is said again when they submit
      if (phase.kind === 'invalid') phase = { kind: 'idle' }
      emit()
    },
    submit: async (rec, f) => {
      if (rec.status !== 'pending') return
      const checked = validateUiInputValues(f.request, values)
      if (!checked.ok) { phase = { kind: 'invalid', errors: checked.errors }; emit(); return }
      const vals = { ...values }
      await answer('submit', (request_id) => deps.submit(rec.session_id, rec.id, { values: vals, request_id }), vals)
    },
    dismiss: async (rec) => {
      if (rec.status !== 'pending') return
      await answer('dismiss', (request_id) => deps.dismiss(rec.session_id, rec.id, { request_id }), null)
    },
  }
}

/** The controllers by input id, kept for the page's life (a form left and come back to keeps what was filled in). */
export function createInputRegistry() {
  const all = new Map<string, InputController>()
  return {
    acquire: (record: UiInputRecord, deps: InputDeps): InputController => {
      let found = all.get(record.id)
      if (!found) { found = createInputController(record, deps); all.set(record.id, found) }
      return found
    },
    peek: (inputId: string) => all.get(inputId),
  }
}

export const inputControllers = createInputRegistry()
