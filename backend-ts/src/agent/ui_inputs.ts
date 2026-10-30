/** request_input on the server (contract/src/ui_interaction.ts): a tool call that shows the person a native form and
 *  waits for their answer. The call writes the request `pending` and awaits a promise in its own run — the run stays
 *  `running`, the agent loop is held at this call, no model request is made meanwhile. The submit and dismiss routes
 *  write the answer first (a transaction), then wake the waiting call through this process's waiters; the same call
 *  returns the answer as its result and the same run goes on. A Stop of the run (or its hard limit) closes the
 *  request and ends the wait; a request left pending by a process that died is closed `interrupted` at startup (its
 *  run is reconciled as dead: nothing resumes it). */

import { validateUiInputValues, type UiInputClosedReason, type UiInputRecord, type UiState } from '@oasis-code/contract'
import type { Conn } from '../db/database.ts'
import * as repo from '../db/repo.ts'
import { UiError } from './ui_surfaces.ts'

/** The waiting calls of this process, by request id: each wakes its own call with the request as answered. */
const waiters = new Map<string, (record: UiInputRecord) => void>()

/** Whether a call of this process waits on the request. */
export function isWaiting(inputId: string): boolean {
  return waiters.has(inputId)
}

/** The call's wait: resolves with the request once it is answered (submit, dismiss) or closed when the run is stopped
 *  — with the reason `stoppedBy` gives: the person's Stop (cancelled), the run's hard limit (budget), the app shutting
 *  down (interrupted). The waiter is registered before
 *  this returns (synchronously), so no answer can come between the request's write and the wait. */
export function awaitAnswer(conn: Conn, inputId: string, signal: AbortSignal, stoppedBy: () => UiInputClosedReason): Promise<UiInputRecord> {
  return new Promise<UiInputRecord>((resolve) => {
    let done = false
    const settle = (record: UiInputRecord) => {
      if (done) return
      done = true
      waiters.delete(inputId)
      signal.removeEventListener('abort', onAbort)
      resolve(record)
    }
    const onAbort = () => {
      repo.answerUiInput(conn, inputId, { status: 'closed', closed_reason: stoppedBy() })
      // answered in the same moment the run was stopped: the record says which came first
      settle(repo.getUiInput(conn, inputId)!)
    }
    waiters.set(inputId, settle)
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** A request of this session (another session's is not found). */
export function ownedInput(conn: Conn, sessionId: string, inputId: string): UiInputRecord {
  const input = repo.getUiInput(conn, inputId)
  if (input === null || input.session_id !== sessionId) throw new UiError(404, 'not_found', `input request not found in this session: ${inputId}`)
  return input
}

/** A request no call of this process waits on any more (its run ended without closing it): closed now, so it is
 *  never shown as pending again. */
function closeOrphan(conn: Conn, inputId: string): UiInputRecord {
  repo.answerUiInput(conn, inputId, { status: 'closed', closed_reason: 'interrupted' })
  return repo.getUiInput(conn, inputId)!
}

/** POST …/ui-inputs/:input_id/submit and …/dismiss: the answer written (values checked against the form and merged
 *  over its defaults), then the waiting call woken. The same request_id again answers the request as it stands;
 *  any other answer to a request no longer pending is 409 not_pending. */
export function answerInput(conn: Conn, sessionId: string, inputId: string, answer: { kind: 'submit'; values: Record<string, unknown>; request_id?: string } | { kind: 'dismiss'; request_id?: string }): UiInputRecord {
  const outcome = conn.transaction((): { record: UiInputRecord; woke: boolean } | { refused: UiInputRecord } => {
    const row = repo.getUiInputRow(conn, inputId)
    if (row === null || row.record.session_id !== sessionId) throw new UiError(404, 'not_found', `input request not found in this session: ${inputId}`)
    const current = row.record
    const want = answer.kind === 'submit' ? 'submitted' : 'dismissed'
    if (current.status !== 'pending') {
      if (answer.request_id !== undefined && row.answer_request_id === answer.request_id && current.status === want) return { record: current, woke: false }
      return { refused: current }
    }
    if (!waiters.has(inputId)) return { refused: closeOrphan(conn, inputId) }
    let values: UiState | null = null
    if (answer.kind === 'submit') {
      const checked = validateUiInputValues(current.request, answer.values)
      if (!checked.ok) throw new UiError(400, 'invalid_values', checked.errors.join('; '), { errors: checked.errors })
      values = checked.value
    }
    repo.answerUiInput(conn, inputId, { status: want, values, request_id: answer.request_id ?? null })
    return { record: repo.getUiInput(conn, inputId)!, woke: true }
  })
  if ('refused' in outcome) throw new UiError(409, 'not_pending', `the request is ${outcome.refused.status}${outcome.refused.closed_reason ? ` (${outcome.refused.closed_reason})` : ''}: only a pending one takes an answer`, { input: outcome.refused })
  // after the commit: the call reads the answer the database holds
  if (outcome.woke) waiters.get(inputId)?.(outcome.record)
  return outcome.record
}

/** The harness's own question before a Full access command runs on a machine that has not confirmed Full access: one
 *  choice, full or sandbox, in the conversation where the command was asked for. Marked `harness` — a key request_input's
 *  arguments cannot carry (its schema is strict), so no agent's form passes for it. */
export const FULL_ACCESS_ASK = 'full_access'

export interface RemoteAccessScope { target_id: string; root_id: string; generation: string; path: string; label?: string }
export function fullAccessRequest(remote?: RemoteAccessScope): Record<string, unknown> {
  if (remote) return {
    harness: 'remote_full_access', remote_target_id: remote.target_id, remote_root_id: remote.root_id, remote_generation: remote.generation,
    title: 'Full access', message: `${remote.label ?? remote.target_id}\n${remote.path}`, root: 'access',
    elements: { access: { type: 'select', props: { label: 'Access', key: 'access', options: [{ label: 'Full access', value: 'full' }] } } },
    initial_state: { access: 'full' }, required: ['access'],
  }
  return {
    harness: FULL_ACCESS_ASK, title: 'Run commands as you on this computer?', root: 'access',
    elements: { access: { type: 'select', props: { label: 'Access', key: 'access', options: [{ label: 'Full access', value: 'full' }, { label: 'Sandbox', value: 'sandbox' }] } } },
    initial_state: { access: 'full' }, required: ['access'],
  }
}

/** Whether Full access is confirmed on this machine: by the operator's setting, or by a yes to the harness's question.
 *  An SSH host is confirmed once, as this Mac is: a yes on any of its folders, in any session, holds for the host (its
 *  saved target); another host is asked again. A yes here never confirms a host, nor a host's yes this Mac. */
export function fullAccessConfirmed(conn: Conn, configured: boolean | undefined, remote?: RemoteAccessScope): boolean {
  if (configured === true) return true
  if (remote) return conn.get(`SELECT 1 AS yes FROM ui_inputs WHERE status='submitted' AND json_extract(request_json,'$.harness')='remote_full_access' AND json_extract(request_json,'$.remote_target_id')=? AND json_extract(values_json,'$.access')='full' LIMIT 1`, [remote.target_id]) !== null
  return conn.get(`SELECT 1 AS yes FROM ui_inputs WHERE status = 'submitted' AND json_extract(request_json, '$.harness') = ? AND json_extract(values_json, '$.access') = 'full' LIMIT 1`, [FULL_ACCESS_ASK]) !== null
}

/** A yes answers the same question waiting in any other run of this process: the machine (this Mac, or one SSH host
 *  by its saved target) is confirmed once. */
export function answerOtherFullAccessAsks(conn: Conn, answeredId: string, remoteTarget: string | null = null): void {
  const rows = (remoteTarget === null
    ? conn.all(`SELECT id, session_id FROM ui_inputs WHERE status = 'pending' AND id != ? AND json_extract(request_json, '$.harness') = ?`, [answeredId, FULL_ACCESS_ASK])
    : conn.all(`SELECT id, session_id FROM ui_inputs WHERE status = 'pending' AND id != ? AND json_extract(request_json, '$.harness') = 'remote_full_access' AND json_extract(request_json, '$.remote_target_id') = ?`, [answeredId, remoteTarget])) as { id: string; session_id: string }[]
  for (const row of rows) {
    if (!waiters.has(row.id)) continue
    try { answerInput(conn, row.session_id, row.id, { kind: 'submit', values: { access: 'full' } }) } catch { /* answered meanwhile */ }
  }
}
