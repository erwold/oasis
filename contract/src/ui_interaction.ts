/** Intelligent UI, interaction (v1 additions to contract/src/ui.ts):
 *
 *  1. UI tasks — an action whose mode is `run` starts an agent task when the person presses it on a native surface,
 *     or when an html surface's script calls `oasisUI.run(actionId, …)` inside the person's click. The task is one run
 *     of the session's conversation made by the existing RunManager (the prompt is the action's, built as
 *     buildUiActionPrompt builds it, plus the optional `input`); its progress (status, streamed text, tool calls,
 *     data) and its terminal result (text + structured `data` + success/failure) come back to the surface that
 *     started it. The agent sends structured data with the `return_ui_result` tool: visible to every run of the
 *     conversation (the tool list stays the same from run to run), it works only in a task's run.
 *  2. request_input — a tool whose call shows the person a native form (the present_ui native element catalog,
 *     without buttons) and waits; the person's submitted values are the call's result, and the same run goes on.
 *
 *  Everything here is pure (no I/O): schemas, limits, and the checks both ends share. */

import { z } from 'zod'
import {
  checkUiJson, defaultUiState, parseUiSurfaceSpec, uiBindings, UI_LIMITS, UI_SPEC_VERSION, UiElementSchema, UiIdSchema,
  UiRequestIdSchema, UiStateSchema, UiSurfaceRecordSchema, validateUiState,
  type UiParseResult, type UiState, type UiSurfaceRecord, type UiSurfaceSpec,
} from './ui.ts'

// =====================================================================================================================
// UI tasks
// =====================================================================================================================

export const UI_TASK_LIMITS = {
  /** `input` (the page's extra JSON beside its state), as JSON characters, and its nesting */
  inputChars: 8_000,
  inputDepth: 8,
  /** `data` (return_ui_result's structured result), as JSON characters, and its nesting */
  dataChars: 60_000,
  dataDepth: 16,
  /** the final answer text kept on the task (clipped, … marked) */
  textChars: 20_000,
  /** the accumulated text a `text` progress update carries (the tail, when longer) */
  progressTextChars: 8_000,
  /** return_ui_result's `message`, an error's message */
  messageChars: 2_000,
  /** tasks of one session waiting for the conversation to be free; past it a start is refused (409 queue_full) */
  queuedPerSession: 4,
  /** the most tasks one list answers (newest first) */
  list: 50,
} as const

/** queued: waiting for the session's conversation to be free (no agent run yet); running: its agent run is live;
 *  succeeded / failed / cancelled: terminal. */
export const UI_TASK_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const
export type UiTaskStatus = (typeof UI_TASK_STATUSES)[number]
export const UiTaskStatusSchema = z.enum(UI_TASK_STATUSES)
export const UI_TASK_ACTIVE_STATUSES: readonly UiTaskStatus[] = ['queued', 'running']
export function isUiTaskActive(status: string): boolean {
  return status === 'queued' || status === 'running'
}

/** Why a task failed (error.code of a `failed` task): its run ended in an error; the agent reported failure through
 *  return_ui_result (ok false); the app stopped while it was queued or running; its run could not be started. */
export const UI_TASK_FAILURE_CODES = ['run_error', 'agent_reported', 'interrupted', 'start_failed'] as const
export type UiTaskFailureCode = (typeof UI_TASK_FAILURE_CODES)[number]

export const UiTaskErrorSchema = z.object({ code: z.string(), message: z.string() })
export type UiTaskError = z.infer<typeof UiTaskErrorSchema>

/** A task as the server keeps it (table ui_tasks), one row per (session, request_id). */
export const UiTaskRecordSchema = z.object({
  id: z.string(),
  session_id: z.string(),
  /** the surface that started it: the run that presented it, its id, the revision the person pressed on */
  surface_run_id: z.string(),
  surface_id: z.string(),
  revision: z.number().int().min(1),
  action_id: z.string(),
  request_id: z.string(),
  /** the agent run doing it: null while queued (and when it failed to start) */
  agent_run_id: z.string().nullable(),
  status: UiTaskStatusSchema,
  /** the page's `input`, as sent (null: none) */
  input: z.unknown().nullable().default(null),
  /** the run's final answer text, set when the task ends ('' before; the live text comes from the run's stream) */
  text: z.string().default(''),
  /** the last data return_ui_result sent (null: none); set as soon as it is sent, before the task ends */
  data: z.unknown().nullable().default(null),
  /** set for `failed` (code from UI_TASK_FAILURE_CODES); null otherwise */
  error: UiTaskErrorSchema.nullable().default(null),
  created_at: z.string(),
  started_at: z.string().nullable().default(null),
  finished_at: z.string().nullable().default(null),
  /** ISO 8601 UTC with milliseconds, strictly increasing at each write of the row */
  updated_at: z.string(),
})
export type UiTaskRecord = z.infer<typeof UiTaskRecordSchema>

/** The run event of a task (persisted, on the agent run's stream): data `{ task }`, at the run's start, at each
 *  return_ui_result, and once with the terminal record before the run's `run_finished`. */
export const UI_TASK_EVENT = 'ui_task'
export const UiTaskEventDataSchema = z.object({ task: UiTaskRecordSchema })

/** POST /api/sessions/:session_id/ui/:run_id/:surface_id/tasks — start a task from a `run` action. The state is
 *  saved first (merged and checked as the state PUT does); `input` is extra JSON for this task only (not saved in the
 *  state). The same request_id with the same payload answers the same task (200); with another payload, a 409. */
export const UiTaskBodySchema = z.strictObject({
  revision: z.number().int().min(1),
  action_id: UiIdSchema,
  state: z.record(z.string(), z.unknown()),
  request_id: UiRequestIdSchema,
  input: z.unknown().optional(),
})
export type UiTaskBody = z.infer<typeof UiTaskBodySchema>
/** 202 (a new task, queued or running) or 200 (the request_id's earlier task, as it stands now). */
export const UiTaskStartResponseSchema = z.object({ task: UiTaskRecordSchema, surface: UiSurfaceRecordSchema })
export type UiTaskStartResponse = { task: UiTaskRecord; surface: UiSurfaceRecord }

/** GET /api/sessions/:session_id/ui-tasks?run_id=&surface_id=&active= — the session's tasks, newest first, at most
 *  UI_TASK_LIMITS.list; run_id + surface_id narrow to one surface (run_id is the surface's run); active=1 only
 *  queued / running ones. */
export const UiTaskListQuerySchema = z.object({
  run_id: z.string().optional(),
  surface_id: z.string().optional(),
  active: z.enum(['1', '0', 'true', 'false']).optional(),
})
export const UiTasksResponseSchema = z.object({ tasks: z.array(UiTaskRecordSchema) })
/** GET /api/sessions/:session_id/ui-tasks/:task_id, and POST …/:task_id/cancel answer one task. The cancel: a queued
 *  task ends `cancelled` now (200); a running one's run is stopped (202, the task ends `cancelled` with it) unless the
 *  run is already writing its end (409 task_finishing); an ended one is answered as it stands (200). */
export const UiTaskResponseSchema = z.object({ task: UiTaskRecordSchema })

/** The refusal body of every ui / ui-tasks / ui-inputs route (as the existing ui routes answer): `detail` for
 *  people, `error` a code, extra fields by code (`surface` with stale_revision / unsupported_spec, `task` with
 *  task_active / task_finishing, `input` with not_pending, `errors` with invalid_*). task_finishing (409): a cancel of
 *  a running task whose run is already writing its end — a Stop can no longer change how it ends; the task ends with
 *  its run. */
export const UiRefusalSchema = z.looseObject({ detail: z.string(), error: z.string() })
export const UI_REFUSAL_CODES = [
  'not_found', 'stale_revision', 'unsupported_spec', 'unknown_action', 'not_a_run_action', 'invalid_state',
  'invalid_input', 'request_conflict', 'task_active', 'queue_full', 'session_unavailable', 'too_large',
  'not_pending', 'invalid_values', 'task_finishing',
] as const

/** A JSON value bounded for `input` / `data`: reserved keys, nesting, size. null when it fits. */
export function checkUiTaskJson(value: unknown, which: 'input' | 'data'): string | null {
  const depth = which === 'input' ? UI_TASK_LIMITS.inputDepth : UI_TASK_LIMITS.dataDepth
  const chars = which === 'input' ? UI_TASK_LIMITS.inputChars : UI_TASK_LIMITS.dataChars
  const shape = checkUiJson(value, depth, { maxChars: chars })
  if (shape !== null) return `${which}: ${shape}`
  const n = (JSON.stringify(value) ?? '').length
  return n > chars ? `${which}: ${n} characters as JSON, more than ${chars}` : null
}

// ---- what the surface gets back --------------------------------------------------------------------------------------

/** A task's outcome as a surface receives it (the Promise of oasisUI.run, a native surface's result line). `ok` is
 *  true exactly when status is `succeeded`. `refused`: no task was started (task_id null; error.code is the route's
 *  refusal code, or a bridge code: no_gesture, unknown_action, too_fast, unavailable). */
export type UiTaskResult =
  | { ok: true; task_id: string; status: 'succeeded'; text: string; data: unknown; error: null }
  | { ok: false; task_id: string | null; status: 'failed' | 'cancelled' | 'refused'; text: string; data: unknown; error: UiTaskError }
export const UiTaskResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), task_id: z.string(), status: z.literal('succeeded'), text: z.string(), data: z.unknown(), error: z.null() }),
  z.object({ ok: z.literal(false), task_id: z.string().nullable(), status: z.enum(['failed', 'cancelled', 'refused']), text: z.string(), data: z.unknown(), error: UiTaskErrorSchema }),
])

/** The result of a terminal task record; null while it is queued or running. */
export function uiTaskResult(task: Pick<UiTaskRecord, 'id' | 'status' | 'text' | 'data' | 'error'>): UiTaskResult | null {
  const data = task.data ?? null
  switch (task.status) {
    case 'succeeded': return { ok: true, task_id: task.id, status: 'succeeded', text: task.text, data, error: null }
    case 'cancelled': return { ok: false, task_id: task.id, status: 'cancelled', text: task.text, data, error: task.error ?? { code: 'cancelled', message: 'the task was stopped' } }
    case 'failed': return { ok: false, task_id: task.id, status: 'failed', text: task.text, data, error: task.error ?? { code: 'run_error', message: 'the task failed' } }
    default: return null
  }
}

/** The result of a start that was refused before any task existed. */
export function uiTaskRefusal(code: string, message: string): UiTaskResult {
  return { ok: false, task_id: null, status: 'refused', text: '', data: null, error: { code, message: message.slice(0, UI_TASK_LIMITS.messageChars) } }
}

/** A task as a surface's page sees it (oasisUI.tasks(), and in updates): no session or run ids. */
export const UiTaskViewSchema = z.object({
  task_id: z.string(),
  action_id: z.string(),
  status: UiTaskStatusSchema,
  input: z.unknown().nullable(),
  text: z.string(),
  data: z.unknown().nullable(),
  error: UiTaskErrorSchema.nullable(),
  created_at: z.string(),
  finished_at: z.string().nullable(),
})
export type UiTaskView = z.infer<typeof UiTaskViewSchema>
export function uiTaskView(t: UiTaskRecord): UiTaskView {
  return { task_id: t.id, action_id: t.action_id, status: t.status, input: t.input ?? null, text: t.text, data: t.data ?? null, error: t.error ?? null, created_at: t.created_at, finished_at: t.finished_at ?? null }
}

/** One progress update of a task, as the host hands it to the surface (oasisUI.run's onProgress, oasisUI.onTask):
 *  derived by the host from the agent run's stream (`ui_task` → status / data; `text_delta` → text; `tool_call` →
 *  tool) and, while queued, from GET …/ui-tasks/:task_id. `done` is the last one of a task. */
export const UiTaskUpdateSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('status'), task_id: z.string(), action_id: z.string(), status: z.enum(['queued', 'running']) }),
  /** delta: the new text; text: the answer so far (its last UI_TASK_LIMITS.progressTextChars characters) */
  z.object({ type: z.literal('text'), task_id: z.string(), action_id: z.string(), delta: z.string(), text: z.string() }),
  /** a tool call of the agent run: its name and a bounded one-line summary (≤ 200 characters) */
  z.object({ type: z.literal('tool'), task_id: z.string(), action_id: z.string(), name: z.string(), summary: z.string() }),
  /** return_ui_result sent data (the latest; the task may still run) */
  z.object({ type: z.literal('data'), task_id: z.string(), action_id: z.string(), data: z.unknown() }),
  z.object({ type: z.literal('done'), task_id: z.string(), action_id: z.string(), result: UiTaskResultSchema }),
])
export type UiTaskUpdate = z.infer<typeof UiTaskUpdateSchema>

/** The additions to `window.oasisUI` in an html surface (existing: version, getState, setState, action). The frame
 *  speaks to the host through the existing nonce'd postMessage bridge; nothing here reaches the network. */
export interface OasisUiTaskApi {
  /** Start a task from the surface's action `actionId` (its mode must be `run`), with the current state and
   *  optional `input` JSON. Must be called inside the person's own click (as action()); throws TypeError only for a
   *  malformed id / options. The Promise resolves once, with the terminal result (or a `refused` one) — it never
   *  rejects and has no timeout of its own. */
  run(actionId: string, options?: { input?: unknown; onProgress?: (update: UiTaskUpdate) => void }): Promise<UiTaskResult>
  /** Ask the task to stop; resolves true when the stop was accepted (the task's own result says `cancelled`). */
  stop(taskId: string): Promise<boolean>
  /** This surface's tasks (newest first, at most UI_TASK_LIMITS.list), as they stand. */
  tasks(): Promise<UiTaskView[]>
  /** Every update of this surface's tasks, whoever started them and whenever (a task started before this frame
   *  loaded included); returns the function that unsubscribes. */
  onTask(listener: (update: UiTaskUpdate) => void): () => void
}

// ---- return_ui_result ------------------------------------------------------------------------------------------------

/** The tool through which a task's agent run sends structured data to the surface that started the task. Visible
 *  to the thread's runs (registry scope 'thread', so the tool list — the prompt cache's key — stays the same from
 *  run to run); it works only in a run a UI task started and answers `invalid` in any other. Each call replaces the
 *  task's `data`; `ok: false` marks the task failed (code agent_reported) when the run ends, a later `ok` true or
 *  absent clears that. */
export const UI_RESULT_TOOL = 'return_ui_result'
export const UiResultArgsSchema = z.object({
  data: z.unknown().optional(),
  ok: z.boolean().optional(),
  message: z.string().max(UI_TASK_LIMITS.messageChars).optional(),
})
export type UiResultArgs = z.infer<typeof UiResultArgsSchema>
/** What the tool answers the model. */
export type UiResultToolResult =
  | { status: 'ok'; task_id: string }
  | { status: 'invalid'; errors: string[] }

// =====================================================================================================================
// request_input
// =====================================================================================================================

export const REQUEST_INPUT_TOOL = 'request_input'

export const UI_INPUT_LIMITS = {
  messageChars: 4_000,
  submitLabelChars: UI_LIMITS.labelChars,
  /** the most requests one run may make in all */
  perRun: 20,
} as const

/** The arguments of request_input: a native form — the present_ui native catalog (root + elements + initial_state),
 *  every element type but `button` — plus the keys that must be filled, and the text around it. */
export const UiInputRequestSchema = z.strictObject({
  title: z.string().min(1).max(UI_LIMITS.titleChars),
  message: z.string().max(UI_INPUT_LIMITS.messageChars).optional(),
  root: UiIdSchema,
  elements: z.record(UiIdSchema, UiElementSchema),
  initial_state: UiStateSchema.optional(),
  /** bound state keys whose value may not be empty: not null, not '' (after trim), not [], a checkbox true */
  required: z.array(UiIdSchema).max(UI_LIMITS.stateKeys).optional(),
  submit_label: z.string().min(1).max(UI_INPUT_LIMITS.submitLabelChars).optional(),
})
export type UiInputRequest = z.infer<typeof UiInputRequestSchema>

/** The native spec a request renders as (never stored as a surface): surface_id `request_input`, no actions. */
export function uiInputRequestSpec(req: UiInputRequest): UiSurfaceSpec {
  return {
    version: UI_SPEC_VERSION, surface_id: 'request_input', title: req.title, fallback: req.message || req.title, kind: 'native',
    root: req.root, elements: req.elements, ...(req.initial_state ? { initial_state: req.initial_state } : {}),
  }
}

/** Validate request_input's arguments whole: the shape, the schema, no button, the native spec's checks
 *  (parseUiSurfaceSpec), at least one input, `required` names bound keys. A provider's top-level nulls are fields
 *  left out. */
export function parseUiInputRequest(input: unknown): UiParseResult<UiInputRequest> {
  const shape = checkUiJson(input, UI_LIMITS.jsonDepth, { maxChars: UI_LIMITS.specChars })
  if (shape !== null) return { ok: false, errors: [shape] }
  const raw = input !== null && typeof input === 'object' && !Array.isArray(input)
    ? Object.fromEntries(Object.entries(input as Record<string, unknown>).filter(([, v]) => v !== null && v !== undefined))
    : input
  const parsed = UiInputRequestSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.slice(0, UI_LIMITS.errors).map((i) => `${i.path.map(String).join('.') || '(request)'}: ${i.message}`) }
  const req = parsed.data
  const errors: string[] = []
  for (const [id, el] of Object.entries(req.elements)) {
    if (el.type === 'button') errors.push(`elements.${id}: request_input has no buttons (the form has its own submit)`)
    // a file source is read for a surface (its own route); a form is never one
    if (el.type === 'progress') errors.push(`elements.${id}: file progress is for present_ui, not request_input`)
    if (el.type === 'chart' && el.props.source !== undefined) errors.push(`elements.${id}.props.source: a chart in request_input has data or series (a file source is for present_ui)`)
  }
  if (errors.length > 0) return { ok: false, errors }
  const spec = parseUiSurfaceSpec(uiInputRequestSpec(req))
  if (!spec.ok) return spec
  const bound = uiBindings(spec.value)
  if (bound.size === 0) errors.push('elements: no input (input, select, slider or checkbox)')
  for (const k of req.required ?? []) if (!bound.has(k)) errors.push(`required: ${k} is not a key an input binds`)
  if (errors.length > 0) return { ok: false, errors: errors.slice(0, UI_LIMITS.errors) }
  return { ok: true, value: req }
}

function emptyValue(v: unknown, checkbox: boolean): boolean {
  if (checkbox) return v !== true
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0)
}

/** The person's values for a request: merged over the form's defaults (keys left out keep them), checked as a
 *  native surface's state is checked (validateUiState), then `required`. The whole state on success. */
export function validateUiInputValues(req: UiInputRequest, values: unknown): UiParseResult<UiState> {
  const shape = checkUiJson(values, 4, { maxChars: UI_LIMITS.stateChars })
  if (shape !== null) return { ok: false, errors: [`values: ${shape}`] }
  if (values === null || typeof values !== 'object' || Array.isArray(values)) return { ok: false, errors: ['values: an object of state keys'] }
  const spec = uiInputRequestSpec(req)
  const merged = { ...defaultUiState(spec), ...(values as Record<string, unknown>) }
  const checked = validateUiState(spec, merged)
  if (!checked.ok) return checked
  const bindings = uiBindings(spec)
  const errors: string[] = []
  for (const k of req.required ?? []) {
    const b = bindings.get(k)
    if (b && emptyValue(checked.value[k], b.kind === 'boolean')) errors.push(`values.${k}: required`)
  }
  return errors.length > 0 ? { ok: false, errors } : checked
}

/** pending: shown, waiting; submitted: the person sent values; dismissed: the person declined; closed: the run
 *  ended (stopped, its budget, the app restarting) while it waited. Only `pending` takes an answer. */
export const UI_INPUT_STATUSES = ['pending', 'submitted', 'dismissed', 'closed'] as const
export type UiInputStatus = (typeof UI_INPUT_STATUSES)[number]
export const UI_INPUT_CLOSED_REASONS = ['cancelled', 'budget', 'interrupted'] as const
export type UiInputClosedReason = (typeof UI_INPUT_CLOSED_REASONS)[number]

/** A request as the server keeps it (table ui_inputs). `request` is the arguments as validated (read through a
 *  loose envelope, so a later build's request still lists with its title). */
export const UiInputRecordSchema = z.object({
  id: z.string(),
  session_id: z.string(),
  run_id: z.string(),
  tool_call_id: z.string(),
  request: z.looseObject({ title: z.string() }),
  status: z.enum(UI_INPUT_STATUSES),
  /** the submitted values (whole state); null unless submitted */
  values: z.record(z.string(), z.unknown()).nullable().default(null),
  closed_reason: z.enum(UI_INPUT_CLOSED_REASONS).nullable().default(null),
  created_at: z.string(),
  answered_at: z.string().nullable().default(null),
  updated_at: z.string(),
})
export type UiInputRecord = Omit<z.infer<typeof UiInputRecordSchema>, 'request' | 'values'> & { request: UiInputRequest; values: UiState | null }

/** The run event of a request (persisted, on its run's stream): data `{ input }`, when it is made (pending) and
 *  when it is answered or closed (before the call's tool_result). */
export const UI_INPUT_EVENT = 'ui_input'
export const UiInputEventDataSchema = z.object({ input: UiInputRecordSchema })

/** A request as plain words, for a reader that renders no form (a director, another agent): its title, id and status,
 *  its message, and the submitted values as `key: value` (a list joined by commas) — never the elements. At most
 *  `maxChars` characters (cut with …). */
export function uiInputText(rec: { id: string; status: string; closed_reason: string | null; values: Record<string, unknown> | null; request: { title: string; message?: string } }, maxChars = 1200): string {
  const one = (s: string) => s.replace(/\s+/g, ' ').trim()
  const status = rec.status === 'closed' && rec.closed_reason ? `closed: ${rec.closed_reason}` : rec.status
  const parts = [`[UI input "${one(rec.request.title).slice(0, UI_LIMITS.titleChars)}" (${rec.id}, ${status})]`]
  if (rec.request.message) parts.push(one(rec.request.message))
  if (rec.status === 'submitted' && rec.values) {
    const scalar = (v: unknown) => (v === null ? 'null' : one(String(v)))
    parts.push(Object.entries(rec.values).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.map(scalar).join(', ') : scalar(v)}`).join('; '))
  }
  const text = parts.join(' ')
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1))}…`
}

/** POST /api/sessions/:session_id/ui-inputs/:input_id/submit. The same request_id again on an answered request
 *  answers it as it stands (200); any other answer to a request no longer pending is 409 not_pending. */
export const UiInputSubmitBodySchema = z.strictObject({
  values: z.record(z.string(), z.unknown()),
  request_id: UiRequestIdSchema.optional(),
})
export type UiInputSubmitBody = z.infer<typeof UiInputSubmitBodySchema>
/** POST /api/sessions/:session_id/ui-inputs/:input_id/dismiss */
export const UiInputDismissBodySchema = z.strictObject({ request_id: UiRequestIdSchema.optional() })
export const UiInputResponseSchema = z.object({ input: UiInputRecordSchema })
/** GET /api/sessions/:session_id/ui-inputs?run_id=&status= — newest first, at most 50. */
export const UiInputListQuerySchema = z.object({ run_id: z.string().optional(), status: z.enum(UI_INPUT_STATUSES).optional() })
export const UiInputsResponseSchema = z.object({ inputs: z.array(UiInputRecordSchema) })

/** What request_input answers the model (the call's result). */
export type UiInputToolResult =
  | { status: 'submitted'; input_id: string; values: UiState }
  | { status: 'dismissed'; input_id: string }
  | { status: 'closed'; input_id: string; reason: UiInputClosedReason }
  | { status: 'invalid'; errors: string[] }
