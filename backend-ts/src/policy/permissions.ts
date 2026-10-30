/** Grants and the approval gate. A session's grants say what the agent may do without asking (workspace
 *  read/write, commands, network). Anything outside them is refused at the call with a persisted approval request
 *  the person can decide on; the run does not hold a model slot while it waits, and a decided approval is bound to
 *  the exact parameters it was asked for. */

import { createHash } from 'node:crypto'
import type { Approval, Grants, Session } from '@oasis-code/contract'
import type { Conn } from '../db/database.ts'
import * as repo from '../db/repo.ts'
import { canonicalJson } from '../llm/usage.ts'

export function paramsSha(params: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(params), 'utf8').digest('hex')
}

export function networkGranted(grants: Grants): boolean {
  if (!grants.network) return false
  if (grants.network_until) {
    const until = Date.parse(grants.network_until)
    if (Number.isNaN(until)) return false
    return Date.now() < until
  }
  return true
}

export interface PolicyRefusal {
  status: 'refused_by_policy'; action: string; approval_id: string; reason: string; note: string
}

export class ActionGate {
  constructor(readonly conn: Conn) {}

  /** null when the session's grants cover the action; otherwise the refusal payload (with the pending approval's
   *  id) the tool returns. */
  check(session: Session, action: string, params: Record<string, unknown>, opts: { run_id: string | null; tool_call_id: string | null }): PolicyRefusal | null {
    const grants = session.grants
    const allowed = ({
      workspace_write: grants.workspace_write, run_command: grants.run_commands, network: networkGranted(grants),
      write_original: false, push: false, publish: false, deploy: false,
    } as Record<string, boolean>)[action] ?? false
    if (allowed) return null
    const sha = paramsSha(params)
    // an approval already decided for exactly these parameters is consumed once
    for (const approval of repo.listApprovals(this.conn, session.id, 'approved')) {
      if (approval.action === action && approval.params_sha256 === sha) {
        repo.decideApproval(this.conn, approval.id, 'consumed')
        return null
      }
    }
    const pending = repo.listApprovals(this.conn, session.id, 'pending').filter((a) => a.action === action && a.params_sha256 === sha)
    const approval = pending[0] ?? repo.insertApproval(this.conn, session.id, opts.run_id, opts.tool_call_id, action, params, sha)
    return {
      status: 'refused_by_policy', action, approval_id: approval.id,
      reason: `the session's grants do not cover '${action}'; approval ${approval.id} is pending the person's decision`,
      note: 'continue with what the grants allow, or end your turn and say what you need approved',
    }
  }

  listPending(sessionId: string): Approval[] {
    return repo.listApprovals(this.conn, sessionId, 'pending')
  }

  decide(approvalId: string, approve: boolean): Approval {
    const approval = repo.getApproval(this.conn, approvalId)
    if (approval === null) throw new NotFound(approvalId)
    if (approval.status !== 'pending') throw new Error(`approval ${approvalId} is ${approval.status}, not pending`)
    repo.decideApproval(this.conn, approvalId, approve ? 'approved' : 'denied')
    return repo.getApproval(this.conn, approvalId)!
  }
}

export class NotFound extends Error {
  constructor(what: string) { super(what); this.name = 'NotFound' }
}
