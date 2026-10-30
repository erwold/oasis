/** A session's permission preset applied: the grants, the run control and the audit entry together. Callers run it
 *  inside a transaction with whatever else must land with it (the session's creation, or nothing). */

import type { Session } from '@oasis-code/contract'
import { modePolicy, type HarnessMode } from '@oasis-code/contract/modes'
import type { Conn } from '../db/database.ts'
import * as repo from '../db/repo.ts'
import { recordRunControl } from './gate.ts'

export function applySessionMode(conn: Conn, session: Session, mode: HarnessMode, actor: 'user' | 'director' | 'agent' = 'user'): void {
  const policy = modePolicy(mode)
  repo.setSessionGrants(conn, session.id, { ...session.grants, ...policy.grants })
  recordRunControl(conn, session.id, policy.control.desired_state, policy.control.gate_effects, null, actor)
  repo.logGovernance(conn, session.id, 'session_mode', { actor, params: { mode } })
}
