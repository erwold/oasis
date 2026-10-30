/** The run events: what the runner emits, persists (`run_events`, seq-ordered; deltas stay transient) and streams
 *  over SSE. The frontend's thread reducer has a row per name and a generic row for anything else. */

import { z } from 'zod'

/** Every event name the backend emits; a test on each side pins that the two lists agree. */
export const EVENT_NAMES = [
  'run_started', 'text_delta', 'text_block', 'thinking_delta', 'thinking_block', 'tool_call', 'tool_result',
  'execution_started', 'checkpoint', 'action_gated', 'budget_closing', 'slot_wait', 'slot_acquired', 'run_continued',
  'integration', 'context_compacted', 'model_request', 'error', 'run_finished', 'lock_violation', 'run_queued',
  'tool_call_progress',
  // Intelligent UI (contract/src/ui.ts): data { surface: UiSurfaceRecord }, one per successful present_ui
  'ui_surface',
  // Intelligent UI interaction (contract/src/ui_interaction.ts): data { task: UiTaskRecord } on a UI task's agent run;
  // data { input: UiInputRecord } on the run of a request_input call
  'ui_task', 'ui_input',
  // in-run steering (contract/src/steering.ts): data { steer: SteerRecord } — queued, then delivered or undelivered
  'steer_queued', 'steer_delivered', 'steer_undelivered',
  // an attached file the run's tools cannot reach (docs/large-file-attachments.md): data { scope: 'command' | 'placement',
  // reason, asset_id?, name?, path? } — an upload a command is not granted, a legacy file not placed where its note says
  'attachment_refused',
] as const
export type EventName = (typeof EVENT_NAMES)[number]

/** Events streamed live but never written (their text_block / thinking_block / tool_call counterpart is). */
export const TRANSIENT_EVENTS: readonly EventName[] = ['text_delta', 'thinking_delta', 'tool_call_progress']

/** One item of a run's event stream, as persisted and as sent: seq is the cursor a client resumes from. */
export const RunEventSchema = z.object({
  seq: z.number().int(),
  event: z.string(),
  data: z.record(z.string(), z.unknown()),
  v: z.number().int().optional(),
  run_id: z.string().optional(),
})
export type RunEvent = z.infer<typeof RunEventSchema>

/** The session's one event stream (GET /api/sessions/:session_id/events): every run of the session on one connection.
 *  Each frame is named as the run event it carries; its data is a SessionStreamFrame; its SSE id is the session cursor
 *  (`run_events.cursor`, schema v26: one counter over every persisted event, never reused) a client resumes after
 *  (Last-Event-ID, or `?after=` with the `event_cursor` a session detail names). A transient event (a delta) carries the
 *  cursor already reached. Once the events the cursor left behind have been sent, one `stream_ready` frame says so. */
export const SESSION_STREAM_READY = 'stream_ready'
export const SessionStreamFrameSchema = z.object({ run_id: z.string(), seq: z.number().int(), data: z.record(z.string(), z.unknown()) })
export type SessionStreamFrame = z.infer<typeof SessionStreamFrameSchema>
/** stream_ready's data: the cursor reached and the runs of the session live when the stream began. */
export const SessionStreamReadySchema = z.object({ cursor: z.number().int(), live_runs: z.array(z.string()) })
export type SessionStreamReady = z.infer<typeof SessionStreamReadySchema>

/** What the SSE client hands the reducer. */
export interface SSEItem { event: string; data: Record<string, unknown>; id?: string }

/** A replayed event: a persisted event with the moment it was written. */
export const ReplayEventSchema = z.object({
  run_id: z.string(),
  seq: z.number().int(),
  event: z.string(),
  data: z.record(z.string(), z.unknown()),
  t: z.string(),
})
export type ReplayEvent = z.infer<typeof ReplayEventSchema>

/** The arguments the tool_call event summarises per tool (bounded previews of what the call names), one row per tool
 *  the harness offers: a stored event already holds what was picked when it was sent. */
export const DIRECTOR_ONLY_METADATA_TOOLS = ['start_interaction', 'start_run', 'list_models', 'schedule', 'get_workspace'] as const
export const TOOL_CALL_METADATA_KEYS: Record<string, readonly string[]> = {
  web_search: ['query', 'action', 'url', 'pattern'], fetch_url: ['url', 'offset'],
  read_file: ['path', 'offset'], write_file: ['path'], edit_file: ['path'],
  bash: ['command', 'cwd'], bash_output: ['execution_id', 'stream', 'offset'], stop_command: ['execution_id'],
  watch: ['kind', 'execution_id', 'note'],
  generate_image: ['prompt', 'reference_images', 'recent_images'],
  ssh_connect: ['destination', 'port', 'identity_file', 'name', 'target_id'], ssh_hosts: [], ssh_directories: ['target_id', 'path'],
  open_ssh_session: ['target_id', 'path', 'remote_state_path', 'model'], forward_port: ['remote_port'],
  computer_observe: ['surface', 'read_text', 'ref'], computer_act: ['surface', 'action', 'ref', 'url', 'keys'],
  present_ui: ['surface_id', 'kind', 'title', 'scope', 'expected_revision'], read_ui: ['surface_id', 'scope'],
  request_input: ['title'], return_ui_result: ['ok'],
  start_interaction: ['session_id', 'mode', 'participants', 'cross_rounds', 'source_turn_id'],
  get_workspace: ['workspace_id', 'include_diff', 'path', 'cursor'],
  start_run: ['session_id', 'model', 'thinking', 'source_turn_id'], list_models: [],
  schedule: ['interaction_id', 'nodes', 'then', 'expected_revision'],
}
