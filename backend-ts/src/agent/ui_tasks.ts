/** Intelligent UI tasks on the server (contract/src/ui_interaction.ts): an action whose mode is `run`, pressed on a
 *  surface, starts an agent task. A task is one run of the session's conversation made by the RunManager — a `human`
 *  thread run whose message is the action's prompt (built as a draft action's is) plus a line naming the task and
 *  the page's optional input — so it stays in the conversation's history like the same prompt sent from the draft.
 *
 *  The start saves the person's values and writes the task `queued` in one transaction; the task then starts at once
 *  when the conversation is free, else waits until it is (each run's end drains the session's queue). The run is
 *  bound to its task inside RunManager.start, before the run executes anything: the task is `running` with its
 *  agent_run_id before the first model request, so no result of the run can come before the task knows its run. The
 *  runner writes the task's end (succeeded / failed / cancelled) and emits it before the run's run_finished. */

import { createHash } from 'node:crypto'
import {
  buildUiActionPrompt, checkUiJson, checkUiTaskJson, uiActionMode, uiPromptJson, UI_LIMITS, UI_TASK_LIMITS,
  type Session, type UiTaskBody, type UiTaskError, type UiTaskRecord, type UiTaskStartResponse,
} from '@oasis-code/contract'
import { ACTIVE_INTERACTION_STATUSES, ACTIVE_RELAY_STATUSES } from '@oasis-code/contract'
import type { AppState } from '../api/state.ts'
import type { Conn } from '../db/database.ts'
import * as repo from '../db/repo.ts'
import { mainHeadRun } from './collab.ts'
import { newId } from '../ids.ts'
import { text } from '../prompt_texts.ts'
import { actionableSpec, canonicalJson, checkRevision, mergedState, ownedSurface, UiError } from './ui_surfaces.ts'

/** How long a queue waits before it looks again when the conversation is taken by a relay or an interaction between
 *  its runs (no run's end would wake it). */
export const UI_TASK_RETRY_MS = 1_000

/** The idempotency key of a task's run (RunManager.startOnce, runs.client_request_id). */
export function uiTaskRunKey(taskId: string): string {
  return `ui-task:${taskId}`
}

function payloadSha(runId: string, surfaceId: string, body: UiTaskBody): string {
  return createHash('sha256').update(canonicalJson({
    run_id: runId, surface_id: surfaceId, revision: body.revision, action_id: body.action_id, state: body.state, input: body.input ?? null,
  })).digest('hex')
}

/** The final answer as a task keeps it: at most UI_TASK_LIMITS.textChars, a clipped one marked with …. */
export function uiTaskText(answer: string): string {
  return answer.length <= UI_TASK_LIMITS.textChars ? answer : `${answer.slice(0, UI_TASK_LIMITS.textChars - 1)}…`
}

function clipMessage(message: string): string {
  return message.length <= UI_TASK_LIMITS.messageChars ? message : `${message.slice(0, UI_TASK_LIMITS.messageChars - 1)}…`
}

/** The message a task's run is sent: the action's prompt with the person's values, the task's line, the page's input. */
export function uiTaskPrompt(o: { task_id: string; surface_run_id: string; surface_id: string; revision: number; title: string; action: Parameters<typeof buildUiActionPrompt>[0]['action']; state: Parameters<typeof buildUiActionPrompt>[0]['state']; input: unknown }): string {
  const built = buildUiActionPrompt({ run_id: o.surface_run_id, surface_id: o.surface_id, revision: o.revision, title: o.title, action: o.action, state: o.state })
  const line = text('ui.task', { task_id: o.task_id, surface_id: o.surface_id })
  const input = o.input === undefined || o.input === null ? '' : `\n${text('ui.task_input', {})}\n<ui_input>\n${uiPromptJson(o.input)}\n</ui_input>`
  return `${built}\n${line}${input}`
}

/** A run's end as its task's end: done → succeeded unless the last return_ui_result said ok false (failed,
 *  agent_reported); cancelled → cancelled; anything else → failed (run_error). */
export function uiTaskOutcome(runStatus: string, runError: string | null, reported: { ok: boolean | null; message: string | null }): { status: 'succeeded' | 'failed' | 'cancelled'; error: UiTaskError | null } {
  if (runStatus === 'done') {
    if (reported.ok === false) return { status: 'failed', error: { code: 'agent_reported', message: clipMessage(reported.message || 'the agent reported that the task failed') } }
    return { status: 'succeeded', error: null }
  }
  if (runStatus === 'cancelled') return { status: 'cancelled', error: null }
  return { status: 'failed', error: { code: 'run_error', message: clipMessage(runError || `the run ended ${runStatus}`) } }
}

/** The runner's end of a task's run (before its run_finished): the task's terminal record, or null when the task was
 *  not this run's running task (already ended). A run the app's shutdown stopped fails the task `interrupted` (the
 *  person did not stop it). */
export function settleRunTask(conn: Conn, taskId: string, runId: string, run: { status: string; error: string | null; final_text: string; interrupted?: boolean }): UiTaskRecord | null {
  const row = repo.getUiTaskRow(conn, taskId)
  if (row === null) return null
  const end = run.interrupted ? { status: 'failed' as const, error: { code: 'interrupted', message: 'the app stopped before the task finished' } }
    : uiTaskOutcome(run.status, run.error, { ok: row.reported_ok, message: row.reported_message })
  if (!repo.endUiTask(conn, taskId, { ...end, text: uiTaskText(run.final_text), from: ['running'], run_id: runId })) return null
  return repo.getUiTask(conn, taskId)
}

/** The tasks of the sessions: started from a surface, queued behind the conversation, drained as it frees, cancelled. */
export class UiTaskService {
  private closed = false
  private readonly retries = new Map<string, ReturnType<typeof setTimeout>>()
  /** the tasks whose start is on its way (a rejected start settles asynchronously) */
  private readonly starting = new Set<string>()

  constructor(private readonly state: AppState) {}

  private get conn() { return this.state.conn }

  /** A run's end frees its conversation: the session's next queued task starts. Attached after the relay's and the
   *  interaction's hooks (their next step's run comes first) and before the watches' (a person's press goes before a
   *  wake). */
  attachHooks(): void {
    this.state.runs.onRunFinished((runId) => {
      if (this.closed) return
      try {
        const run = repo.getRun(this.conn, runId)
        if (run !== null) this.drain(run.session_id)
      } catch (error) {
        console.warn(`ui tasks: the end of ${runId}: ${(error as Error).message}`)
      }
    })
  }

  /** The app closing: nothing drains any more, and a task still queued (its run never started) ends now, failed
   *  `interrupted` — as a running one cut off by the shutdown does — instead of reading as queued until the next start. */
  close(): void {
    this.closed = true
    for (const t of this.retries.values()) clearTimeout(t)
    this.retries.clear()
    try {
      for (const row of repo.activeUiTasks(this.conn)) {
        if (row.record.status !== 'queued') continue
        repo.endUiTask(this.conn, row.record.id, { status: 'failed', error: { code: 'interrupted', message: 'the app stopped before the task started' }, from: ['queued'] })
      }
    } catch (error) {
      // the database already gone: the next start's reconcile ends them
      console.warn(`ui tasks: the queued tasks were not ended at close: ${(error as Error).message}`)
    }
  }

  /** Whether the conversation is taken: a run of it under way, or a relay or an interaction in progress (its next
   *  step starts on its own). */
  private busy(sessionId: string): { busy: boolean; run: boolean } {
    if (this.state.runs.activeRunOfSession(sessionId) !== null) return { busy: true, run: true }
    if (repo.listInteractions(this.conn, sessionId).some((i) => (ACTIVE_INTERACTION_STATUSES as readonly string[]).includes(i.status))) return { busy: true, run: false }
    if (repo.listRelays(this.conn, sessionId).some((r) => (ACTIVE_RELAY_STATUSES as readonly string[]).includes(r.status))) return { busy: true, run: false }
    return { busy: false, run: false }
  }

  private retryLater(sessionId: string): void {
    if (this.closed || this.retries.has(sessionId)) return
    const timer = setTimeout(() => { this.retries.delete(sessionId); this.drain(sessionId) }, UI_TASK_RETRY_MS)
    timer.unref?.()
    this.retries.set(sessionId, timer)
  }

  private failQueued(taskId: string, message: string): boolean {
    return repo.endUiTask(this.conn, taskId, { status: 'failed', error: { code: 'start_failed', message: clipMessage(message) }, from: ['queued'] })
  }

  /** The session's oldest queued task started, when the conversation is free. Synchronous up to the run's start: the
   *  task is bound to its run (running, agent_run_id) inside RunManager.start before this returns. */
  drain(sessionId: string): void {
    if (this.closed) return
    for (;;) {
      const row = repo.nextQueuedUiTask(this.conn, sessionId)
      if (row === null) return
      const task = row.record
      if (this.starting.has(task.id)) return
      const session = repo.getSession(this.conn, sessionId)
      if (session === null || session.status === repo.DELETED_SESSION || !session.workspace_id) {
        if (!this.failQueued(task.id, session === null || session.status === repo.DELETED_SESSION ? 'the session was deleted' : 'the session has no workspace')) return
        continue
      }
      const taken = this.busy(sessionId)
      if (taken.busy) {
        // a run's end drains again; a relay or an interaction between its runs is looked at again shortly
        if (!taken.run) this.retryLater(sessionId)
        return
      }
      this.startQueued(session, row.record.id, row.prompt)
      return
    }
  }

  private startQueued(session: Session, taskId: string, prompt: string): void {
    const key = uiTaskRunKey(taskId)
    const latest = mainHeadRun(this.state, session.id)
    const thinking = typeof latest?.model_config_snapshot.thinking === 'string' ? latest.model_config_snapshot.thinking : null
    this.starting.add(taskId)
    let started: Promise<unknown>
    try {
      started = this.state.runs.startOnce(session.id, key, () => this.state.runs.start(session, prompt, { spawned_by: 'human', client_request_id: key, ui_task: taskId, thinking }))
    } catch (error) {
      started = Promise.reject(error)
    }
    started.then(() => { this.starting.delete(taskId) }, (error: unknown) => {
      this.starting.delete(taskId)
      const message = error instanceof Error ? error.message : String(error)
      // the conversation taken meanwhile: the task waits for that run's end
      if (/already has an active run/.test(message)) return
      this.failQueued(taskId, message)
      this.drain(session.id)
    })
  }

  /** POST …/tasks: the person pressed a `run` action. The values are saved and the task written queued in one
   *  transaction; then the queue drains (the task starts now when the conversation is free). */
  startTask(sessionId: string, runId: string, surfaceId: string, body: UiTaskBody): { created: boolean; response: UiTaskStartResponse } {
    const conn = this.conn
    const out = conn.transaction((): { created: boolean; task_id: string } => {
      const surface = ownedSurface(conn, sessionId, runId, surfaceId)
      const shape = checkUiJson(body.state, 4, { maxChars: UI_LIMITS.stateChars })
      if (shape !== null) throw new UiError(400, 'invalid_state', `state: ${shape}`, { errors: [`state: ${shape}`] })
      if (body.input !== undefined) {
        const bad = checkUiTaskJson(body.input, 'input')
        if (bad !== null) throw new UiError(400, 'invalid_input', bad, { errors: [bad] })
      }
      // a request seen before answers with its task as it stands — before the revision or the spec is consulted
      const sha = payloadSha(runId, surfaceId, body)
      const earlier = repo.getUiTaskByRequest(conn, sessionId, body.request_id)
      if (earlier !== null) {
        if (earlier.payload_sha !== sha) throw new UiError(409, 'request_conflict', `request ${body.request_id} was already used for another task or other values`)
        return { created: false, task_id: earlier.record.id }
      }
      const session = repo.getSession(conn, sessionId)
      if (session === null || session.status === repo.DELETED_SESSION || !session.workspace_id) throw new UiError(409, 'session_unavailable', 'the session was deleted or has no workspace')
      const spec = actionableSpec(surface)
      checkRevision(surface, body.revision)
      const action = (spec.actions ?? []).find((a) => a.id === body.action_id)
      if (action === undefined) throw new UiError(400, 'unknown_action', `the surface has no action ${body.action_id}`)
      if (uiActionMode(action) !== 'run') throw new UiError(400, 'not_a_run_action', `action ${action.id} is a draft action: it prepares a message, it starts no task`)
      const state = mergedState(spec, surface.state, body.state)
      const active = repo.listUiTasks(conn, sessionId, { surface_run_id: runId, surface_id: surfaceId, active: true, limit: 1 })[0]
      if (active !== undefined) throw new UiError(409, 'task_active', `the surface's task ${active.id} is ${active.status}`, { task: active })
      const queued = repo.countQueuedUiTasks(conn, sessionId)
      if (queued >= UI_TASK_LIMITS.queuedPerSession) throw new UiError(409, 'queue_full', `${queued} tasks of this session are waiting for the conversation, the most it keeps`)
      const id = newId('uit')
      const prompt = uiTaskPrompt({ task_id: id, surface_run_id: runId, surface_id: surfaceId, revision: surface.revision, title: spec.title, action, state, input: body.input })
      repo.setUiSurfaceState(conn, sessionId, runId, surfaceId, surface.revision, state)
      repo.insertUiTask(conn, {
        id, session_id: sessionId, surface_run_id: runId, surface_id: surfaceId, revision: surface.revision, action_id: action.id,
        request_id: body.request_id, payload_sha: sha, prompt, input: body.input ?? null,
      })
      return { created: true, task_id: id }
    })
    if (out.created) this.drain(sessionId)
    return { created: out.created, response: { task: repo.getUiTask(conn, out.task_id)!, surface: repo.getUiSurface(conn, sessionId, runId, surfaceId)! } }
  }

  /** POST …/ui-tasks/:task_id/cancel: a queued task ends now (cancelled, 200; the queue moves on); a running one's run
   *  is stopped (202: its end makes the task cancelled); an ended one is answered as it stands (200). */
  cancelTask(sessionId: string, taskId: string): { status: 200 | 202; task: UiTaskRecord } {
    const task = this.ownedTask(sessionId, taskId)
    if (task.status === 'queued' && repo.endUiTask(this.conn, taskId, { status: 'cancelled', error: null, from: ['queued'] })) {
      this.drain(sessionId)
      return { status: 200, task: repo.getUiTask(this.conn, taskId)! }
    }
    const now = repo.getUiTask(this.conn, taskId)!
    if (now.status === 'running' && now.agent_run_id !== null) {
      // a run already writing its end has taken its status: a Stop now would be accepted and change nothing, so it is
      // refused (the task ends with its run, as its run ends) — checked and sent with no await between
      if (!this.state.runs.canStop(now.agent_run_id)) throw new UiError(409, 'task_finishing', `the task's run ${now.agent_run_id} is already ending; the task ends with it`, { task: now })
      // the run stops; the task ends with it (the runner writes cancelled before the run's run_finished)
      this.state.runs.cancel(now.agent_run_id)
      return { status: 202, task: repo.getUiTask(this.conn, taskId)! }
    }
    return { status: 200, task: now }
  }

  /** A task of this session (another session's is not found). */
  ownedTask(sessionId: string, taskId: string): UiTaskRecord {
    const task = repo.getUiTask(this.conn, taskId)
    if (task === null || task.session_id !== sessionId) throw new UiError(404, 'not_found', `task not found in this session: ${taskId}`)
    return task
  }

  /** A deleted session's queued tasks can never start. */
  sessionDeleted(sessionId: string): void {
    for (const task of repo.listUiTasks(this.conn, sessionId, { active: true, limit: 1_000 })) if (task.status === 'queued') this.failQueued(task.id, 'the session was deleted')
  }
}
