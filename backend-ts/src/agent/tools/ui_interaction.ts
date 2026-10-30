/** Intelligent UI's interaction tools (contract/src/ui_interaction.ts).
 *
 *  request_input: a native form shown in the thread; the call waits (the run stays running, held at this call) until
 *  the person submits or dismisses it, or the run is stopped — and returns that answer as its result. Every run sees
 *  it (a work order's run too: its stream is shown to the person like any other).
 *
 *  return_ui_result: the structured data a UI task's run sends to the surface that started it. Visible to the
 *  thread's runs (registry scope 'thread', so the tool list — what a provider's prompt cache keys on first — is the
 *  same from run to run); it works only in a run a UI task started and answers `invalid` in any other.
 *
 *  Both change nothing outside the conversation: reads in the permission layer's terms. The provider gets back the
 *  contract's small results; the form and the data reach the thread through `ui_input` / `ui_task` events. */

import {
  checkUiJson, checkUiTaskJson, parseUiInputRequest, UI_INPUT_LIMITS, UI_TASK_LIMITS, z,
  type UiInputRecord, type UiInputToolResult, type UiResultToolResult,
} from '@oasis-code/contract'
import * as repo from '../../db/repo.ts'
import { PROMPT_TEXT } from '../../prompt_texts.ts'
import { awaitAnswer } from '../ui_inputs.ts'
import { finish, type Ctx, type Payload } from './common.ts'
import { register } from './registry.ts'
import { specOfArgs } from './ui.ts'

const P = (tool: string, key: string) => PROMPT_TEXT[`parameter.${tool}.${key}` as keyof typeof PROMPT_TEXT]

/** request_input's arguments as the model is told them: flat and loose (an element is an object with a type; its
 *  props and children, a button, an unknown key all reach parseUiInputRequest, which checks the form whole and names
 *  what it refuses). */
const FormElementArgSchema = z.looseObject({ type: z.string() })

export const RequestInputArgsSchema = z.looseObject({
  title: z.string().describe(P('request_input', 'title')),
  message: z.string().nullable().optional().describe(P('request_input', 'message')),
  root: z.string().describe(P('request_input', 'root')),
  elements: z.record(z.string(), FormElementArgSchema).describe(P('request_input', 'elements')),
  initial_state: z.record(z.string(), z.unknown()).nullable().optional().describe(P('request_input', 'initial_state')),
  required: z.array(z.string()).nullable().optional().describe(P('request_input', 'required')),
  submit_label: z.string().nullable().optional().describe(P('request_input', 'submit_label')),
})
export type RequestInputArgs = z.infer<typeof RequestInputArgsSchema>

function inputResult(record: UiInputRecord): UiInputToolResult {
  if (record.status === 'submitted') return { status: 'submitted', input_id: record.id, values: record.values ?? {} }
  if (record.status === 'dismissed') return { status: 'dismissed', input_id: record.id }
  return { status: 'closed', input_id: record.id, reason: record.closed_reason ?? 'cancelled' }
}

export async function requestInputTool(ctx: Ctx, args: RequestInputArgs): Promise<Payload> {
  const deps = ctx.deps
  const parsed = parseUiInputRequest(specOfArgs(args))
  const invalid = (errors: string[]) => finish(ctx, 'request_input', { status: 'invalid', errors } satisfies UiInputToolResult, { summary: `not shown: ${errors[0] ?? 'invalid'}`.slice(0, 200) })
  if (!parsed.ok) return invalid(parsed.errors)
  const made = repo.countUiInputsOfRun(deps.conn, deps.run_id)
  if (made >= UI_INPUT_LIMITS.perRun) return invalid([`this run has made ${made} input requests, the most one run may`])
  // written, waited on and announced in one synchronous stretch: no answer can come before the wait is in place
  const pending = repo.insertUiInput(deps.conn, { session_id: deps.session.id, run_id: deps.run_id, tool_call_id: ctx.tool_call_id, request: parsed.value })
  const answered = awaitAnswer(deps.conn, pending.id, deps.cancel_signal, deps.stop_reason)
  deps.emit('ui_input', { input: pending })
  const record = await answered
  // the answer (or the close) on the run's stream before the call's own result
  deps.emit('ui_input', { input: record })
  const result = inputResult(record)
  return finish(ctx, 'request_input', result, { summary: `${parsed.value.title}: ${record.status}`.slice(0, 200), input_id: record.id })
}

export const ReturnUiResultArgsSchema = z.object({
  data: z.unknown().optional().describe(P('return_ui_result', 'data')),
  ok: z.boolean().nullable().optional().describe(P('return_ui_result', 'ok')),
  message: z.string().nullable().optional().describe(P('return_ui_result', 'message')),
})
export type ReturnUiResultArgs = z.infer<typeof ReturnUiResultArgsSchema>

export async function returnUiResultTool(ctx: Ctx, args: ReturnUiResultArgs): Promise<Payload> {
  const deps = ctx.deps
  const invalid = (errors: string[]) => finish(ctx, 'return_ui_result', { status: 'invalid', errors } satisfies UiResultToolResult, { summary: `not sent: ${errors[0] ?? 'invalid'}`.slice(0, 200) })
  const taskId = deps.ui_task
  if (taskId === null) return invalid(['this run was not started by a UI task: there is no surface to return a result to'])
  const errors: string[] = []
  if (args.data !== undefined) {
    const bad = checkUiTaskJson(args.data, 'data')
    if (bad !== null) errors.push(bad)
  }
  if (typeof args.message === 'string' && args.message.length > UI_TASK_LIMITS.messageChars) errors.push(`message: more than ${UI_TASK_LIMITS.messageChars} characters`)
  if (errors.length) return invalid(errors)
  const ok = args.ok !== false
  if (!repo.setUiTaskResult(deps.conn, taskId, deps.run_id, args.data ?? null, ok, args.message ?? null)) return invalid([`task ${taskId} is no longer running`])
  const task = repo.getUiTask(deps.conn, taskId)!
  // the surface's data update, live and in the run's events (replay, reconnect)
  deps.emit('ui_task', { task })
  return finish(ctx, 'return_ui_result', { status: 'ok', task_id: taskId } satisfies UiResultToolResult, { summary: ok ? 'data sent' : 'data sent; the task will end as failed', task_id: taskId })
}

register({
  name: 'request_input', effect: 'read', action: null, renderer: 'generic', summary: 'ask the person through a form and wait for the answer',
  description: PROMPT_TEXT['tool.request_input'],
  schema: RequestInputArgsSchema, fn: requestInputTool,
  // a reserved key anywhere in the form is refused by name, never silently dropped
  precheck: (args) => checkUiJson(args),
})

register({
  name: 'return_ui_result', effect: 'read', action: null, renderer: 'generic', summary: "send data to the surface whose task this run is",
  description: PROMPT_TEXT['tool.return_ui_result'],
  schema: ReturnUiResultArgsSchema, fn: returnUiResultTool, scope: 'thread',
  precheck: (args) => checkUiJson(args),
})
