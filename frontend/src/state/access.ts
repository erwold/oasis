import { accessOf, type AccessMode } from '@oasis-code/contract/modes'

/** Where a session's agent commands run (full | sandbox), beside its mode (auto / approve / plan), which it never
 *  touches: the composer's access chip and the start screen's choice for the next session. The first Full command on a
 *  machine not confirmed for it asks in the conversation (UiInput.tsx, the harness's question). */

/** What the harness says of a session's access: the mode, whether it can change now and what holds it. */
export interface AccessBlockers { runs: number; executions: number; approvals: number }
export interface AccessState { session_id: string; access_mode: AccessMode; switchable: boolean; blocked_by: AccessBlockers }

/** A session's access as a page holds it: the harness's word for the session (absent from an older answer: the
 *  sandbox, as such a session ran). */
export function sessionAccess(session: { access_mode?: unknown } | null | undefined): AccessMode {
  return accessOf(session?.access_mode)
}

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0)

/** The blockers a 409's body (or an answer) names; null when it names none. */
export function blockersOf(body: unknown): AccessBlockers | null {
  if (typeof body !== 'object' || body === null) return null
  const b = (body as { blocked_by?: unknown }).blocked_by
  if (typeof b !== 'object' || b === null) return null
  const r = b as Record<string, unknown>
  return { runs: count(r.runs), executions: count(r.executions), approvals: count(r.approvals) }
}

/** The access chip's short reason it cannot change now; null when nothing holds it. */
export function blockedHint(blocked: AccessBlockers | null | undefined): string | null {
  if (!blocked) return null
  if (blocked.runs > 0) return 'Stop the active runs first.'
  if (blocked.executions > 0) return 'Stop the running commands first.'
  if (blocked.approvals > 0) return 'Answer the pending approvals first.'
  return null
}

/** The harness's answer as the page's access state, or null when it is not one. */
export function accessStateOf(sessionId: string, answer: unknown): AccessState | null {
  if (typeof answer !== 'object' || answer === null) return null
  const a = answer as { access_mode?: unknown; switchable?: unknown }
  const blocked = blockersOf(answer) ?? { runs: 0, executions: 0, approvals: 0 }
  return { session_id: sessionId, access_mode: accessOf(a.access_mode), switchable: a.switchable === true, blocked_by: blocked }
}

/** What the session shows as busy here (a live run, an active run, an active child, a proposal waiting): when this
 *  moves, the harness is asked again whether the access can change — once per move, never on a timer. */
export function accessActivityKey(s: { liveRunId: string | null; session: { id: string; active_run?: unknown; active_children?: unknown[] | null } | null; proposals: unknown[] }): string {
  const active = s.session?.active_run as { id?: string } | null | undefined
  return [s.session?.id ?? '', s.liveRunId ?? '', active?.id ?? '', s.session?.active_children?.length ?? 0, s.proposals.length].join('|')
}
