/** Where a command runs: a session's access (full | sandbox, contract/modes.ts) narrowed by what the command runs
 *  under — the cap of the run (what a director of surface v1–v5 started holds the sandbox it was described with), an
 *  approval's pinned access — and, for the connector's command route, the request's own cap. Nothing here widens:
 *  every input can only narrow to the sandbox. A restriction chosen for a Full access command (a work order's bounds,
 *  the network off, a hard lock, read-only) keeps it on the host with only that restriction held by the OS
 *  (agent/tools/commands.ts, execution/isolation.ts hostProfile); every narrowing is said (AccessReason).
 *
 *  A request's cap is read once, from its headers, where the request enters the API (the middleware in main.ts) and
 *  held for what the request starts (runs, relays, interactions, sessions); what those start later (a relay's next
 *  turn, an interaction's queued step, a continuation, a child run) reads the cap stored with them. */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { Session, WorkOrder } from '@oasis-code/contract'
import { DIRECTOR_TOOL_SURFACES } from '@oasis-code/contract'
import { accessOf, narrowestAccess, type AccessMode } from '@oasis-code/contract/modes'

/** The director tool surfaces whose commands, sessions and dispatches keep the sandbox (their descriptions say
 *  "sandboxed"): every surface before director.v6. */
export const SANDBOX_SURFACES: ReadonlySet<string> = new Set(['director.v1', 'director.v2', 'director.v3', 'director.v4', 'director.v5'])

/** The cap a director tool surface puts on what it starts: the sandbox for v1–v5 and for a name this build does not
 *  know (fail closed), none for director.v6 and later known surfaces; none when no surface is named. */
export function surfaceCap(surface: string | null | undefined): AccessMode | null {
  if (surface === null || surface === undefined || surface === '') return null
  if (SANDBOX_SURFACES.has(surface)) return 'sandbox'
  return (DIRECTOR_TOOL_SURFACES as readonly string[]).includes(surface) ? null : 'sandbox'
}

/** A request's cap from what it says it is: a director tool surface (its header), or a connector's client that names
 *  none — a client of the connector that predates access modes: the sandbox. A request of the person (the page, the
 *  desktop app, a REST client with neither header): none. */
export function requestCap(headers: { surface?: string | null; connector?: string | null }): AccessMode | null {
  const surface = (headers.surface ?? '').trim()
  if (surface) return surfaceCap(surface)
  return (headers.connector ?? '').trim() ? 'sandbox' : null
}

/** The agent run a request comes from (its checked header, policy/delegation.ts): a run's own tool calling the app's
 *  API in process (open_ssh_session). What the request starts is that run's — never the person's. */
export interface RequestAgent { run_id: string; session_id: string }

const current = new AsyncLocalStorage<{ cap: AccessMode | null; live: boolean; agent: RequestAgent | null }>()

/** Serve a request with its cap in force for what it starts, until it is answered: work the request set going that
 *  goes on after the answer (a run's task, a scheduler's loop) no longer reads it — what that work starts later reads
 *  the caps stored with the runs, relays and interactions instead. */
export async function withRequestCap<T>(cap: AccessMode | null, fn: () => Promise<T>, agent: RequestAgent | null = null): Promise<T> {
  const store = { cap, live: true, agent }
  return current.run(store, async () => {
    try { return await fn() } finally { store.live = false }
  })
}

/** The cap of the request being served, or null (none; no request; or the request was answered: a hook, a run's own
 *  task, a restart's recovery). */
export function currentRequestCap(): AccessMode | null {
  const store = current.getStore()
  return store !== undefined && store.live ? store.cap : null
}

/** The agent run the request being served comes from, or null (the person, a director, a connector: see their own
 *  readings; no request; or the request was answered). */
export function currentRequestAgent(): RequestAgent | null {
  const store = current.getStore()
  return store !== undefined && store.live ? store.agent : null
}

/** Run `fn` outside any request's cap (a run's own task: what it starts is the run's, never the request's). */
export function outsideRequest<T>(fn: () => T): T {
  return current.exit(fn)
}

/** Why a command's access or its restrictions are what they are: a stable code, what holds, and how to proceed. */
export type AccessReasonCode = 'run_cap' | 'request_cap' | 'approval_pin' | 'route_sandbox' | 'order_bounds' | 'network_off' | 'hard_lock'
  | 'read_only' | 'read_only_root' | 'no_session' | 'sandbox_unavailable' | 'restriction_unavailable'

export interface AccessReason { code: AccessReasonCode; detail: string; next_step: string }

const REASONS: Record<AccessReasonCode, { detail: string; next_step: string }> = {
  run_cap: {
    detail: 'This run was started by a director tool surface v1–v5 (or continues one): its commands run in the sandbox.',
    next_step: 'Send the request as a message of the person\'s, or through director.v6 with access "session", to run with the session\'s Full access.',
  },
  request_cap: {
    detail: 'This request came through a director tool surface v1–v5, or a connector client that names no surface: its commands run in the sandbox.',
    next_step: 'Use director.v6 with access "session" to run with the session\'s Full access.',
  },
  approval_pin: {
    detail: 'The approved proposal was made while commands ran in the sandbox; an approval runs no wider than its proposal.',
    next_step: 'Ask for the command again: a new proposal carries the session\'s current access.',
  },
  route_sandbox: {
    detail: 'This command route runs in the sandbox unless the session\'s access is asked for.',
    next_step: 'Ask for access "session" (director.v6) to run with the session\'s access.',
  },
  order_bounds: {
    detail: 'The work order\'s read-only, read-scope or write-scope bounds are held by the OS on the host; the rest stays Full access.',
    next_step: 'The bounds come with the work order; a dispatch without them runs without them.',
  },
  network_off: {
    detail: 'The network is off for this command (the session\'s network grant or the work order); the OS denies it.',
    next_step: 'Turn the session\'s network grant on (or dispatch the order with network) to run with network.',
  },
  hard_lock: {
    detail: 'Files under a hard lock in the folder edited in place are denied writes by the OS.',
    next_step: 'Release the lock to let a command write those files.',
  },
  read_only: {
    detail: 'The command runs read-only: the OS denies its writes to the working folder, its Git metadata, an attached folder and the session\'s folders.',
    next_step: 'Run the command without read_only to write; a writing command takes the folder\'s writer lock.',
  },
  read_only_root: {
    detail: 'Folders the session holds with read access are denied writes by the OS.',
    next_step: 'Give the folder write access in the session to let a command write it.',
  },
  no_session: {
    detail: 'The command is bound to no session, so no session\'s access applies: it runs in the sandbox.',
    next_step: 'Run it from a session (its checks follow that session\'s access).',
  },
  sandbox_unavailable: {
    detail: 'The sandbox could not be verified on this host; nothing runs unisolated.',
    next_step: 'Switch the session to Full access (the person\'s choice in oasis-code), or fix the isolation runtime its diagnostics name.',
  },
  restriction_unavailable: {
    detail: 'A restriction chosen for this command cannot be enforced by the OS on this host; nothing ran (no fallback).',
    next_step: 'Run it without that restriction, or on a host whose isolation runtime enforces it (macOS Seatbelt with the probe passing).',
  },
}

/** A reason by its code, with what holds said more exactly when `detail` is given. */
export function reason(code: AccessReasonCode, detail?: string): AccessReason {
  const base = REASONS[code]
  return { code, detail: detail ?? base.detail, next_step: base.next_step }
}

/** Where a command runs and why: what the session (or the route) asked for, where it runs, and every narrowing. */
export interface AccessDecision { requested: AccessMode; effective: AccessMode; reasons: AccessReason[] }

/** A work order's bounds the OS holds for a command: read-only, a read scope, a write scope (the network is the
 *  command's network: commands.ts). With Full access they are held on the host by the host-restricted profile
 *  (execution/isolation.ts), the user's environment kept; in the sandbox, by the sandbox's profile. */
export function orderFilesystemBounds(order: WorkOrder | null | undefined): { read_only: boolean; read: string[] | null; write: string[] | null } | null {
  if (!order) return null
  const read = order.scope?.read ?? null
  const write = order.scope?.write ?? null
  if (order.read_only !== true && read === null && write === null) return null
  return { read_only: order.read_only === true, read, write }
}

/** The access a command gets, and why: the session's, narrowed to the sandbox by the run's cap, an approval's pin or
 *  the request's cap (each a sandbox its starter described); a work order's bounds keep the access and are held on
 *  the host (the reason says so). */
export function accessDecision(o: { session: Pick<Session, 'access_mode'>; run_cap?: AccessMode | null; order?: WorkOrder | null; pinned?: AccessMode | null; request?: AccessMode | null }): AccessDecision {
  const requested = accessOf(o.session.access_mode)
  const reasons: AccessReason[] = []
  if (requested === 'full') {
    if (o.run_cap === 'sandbox') reasons.push(reason('run_cap'))
    if (o.pinned === 'sandbox') reasons.push(reason('approval_pin'))
    if (o.request === 'sandbox') reasons.push(reason('request_cap'))
  }
  const effective = narrowestAccess(requested, o.run_cap ?? null, o.pinned ?? null, o.request ?? null)
  const bounds = orderFilesystemBounds(o.order)
  if (effective === 'full' && bounds !== null) {
    const held = [bounds.read_only ? 'read-only' : null, bounds.read !== null ? `read scope ${JSON.stringify(bounds.read)}` : null, bounds.write !== null ? `write scope ${JSON.stringify(bounds.write)}` : null].filter(Boolean).join(', ')
    reasons.push(reason('order_bounds', `The work order's bounds (${held}) are held by the OS on the host; the rest stays Full access.`))
  }
  return { requested, effective, reasons }
}

/** The access a command gets: the session's, narrowed by the run's cap, an approval's pin and the request. */
export function effectiveAccess(o: { session: Pick<Session, 'access_mode'>; run_cap?: AccessMode | null; order?: WorkOrder | null; pinned?: AccessMode | null; request?: AccessMode | null }): AccessMode {
  return accessDecision(o).effective
}
