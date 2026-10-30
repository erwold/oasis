/** Wire types shared with the backend: the contract package (`@oasis-code/contract`, the zod schemas the backend
 *  validates with) is the one source; this module re-exports its types under the names the components use, and
 *  narrows the few the page reads in a looser or a richer form than the row itself (a run listed without its
 *  manifest, a project with its sessions, a check with its staleness). Runtime checks at the boundaries that matter
 *  live in api/client.ts (event payloads are validated by shape in state/thread.ts). */

import type {
  Budget as ContractBudget, CheckResult as ContractCheckResult, LockMode, Project as ContractProject, Receipt, Run as ContractRun, Session,
  SessionDetail as ContractSessionDetail,
} from '@oasis-code/contract'

export type {
  Grants, Session, Workspace, RunStatus, Receipt, WorkOrder, RunTreeRow, ModelRequestRecord, Approval, DirectorNote,
  Execution, Checkpoint, WorkspaceDetail, DiffResponse, ModelEntry, BuildInfo, OutputWindow, TranscriptEntry, QuotaWindow, AccountUsage,
  UsageSnapshot, AuthProviderId, LoginSession, AuthProvider, KeyProviderId, KeyRow, AuthAccounts, ContextSegment, CacheRequest, ContextReport,
  SurfaceTool, LockMode, RunControl, ActionProposal, DirListing, ImportRefusal,
  DirectorSession, DirectorTurn, DirectorDetail, DirectorTransport, DirectorTransportInfo, DirectorLiveTurn, DirectorToolCall, DirectorOpenBody,
  DirectorUpdateBody, Relay, RelayParticipant, RelayStep, RelayStatus, AgentMention, Interaction, InteractionDetail, InteractionNode, InteractionParticipant,
  InteractionBody, IntegrationResult, Watch, WakeEvent, SessionActivity, SessionActivityRun, SessionActivityResponse,
} from '@oasis-code/contract'

export type Budget = ContractBudget

/** A project as the list route sends it: with its sessions. */
export type Project = ContractProject & { sessions?: Session[] }

/** A run as the page reads it: the list routes leave the manifest out (the detail route carries it); the receipt is
 *  the runner's summary once the run ended and `{}` before. */
export type Run = Omit<ContractRun, 'manifest' | 'receipt'> & { manifest?: Record<string, unknown>; receipt: Receipt | Record<string, never> }

/** A session as the detail route sends it: its thread's runs are listed without their manifests. */
export type SessionDetail = Omit<ContractSessionDetail, 'runs'> & { runs: Run[] }

/** The detail route: the run with its manifest, its live flag, its children, its requests and its executions. */
export type RunDetailResponse = Run & {
  live: boolean; depth: number; requests: import('@oasis-code/contract').ModelRequestRecord[]; executions: import('@oasis-code/contract').Execution[]
  children: { id: string; label: string | null; status: import('@oasis-code/contract').RunStatus; model: string }[]
}

/** A check as the workspace detail lists it: stale once the tree moved on since it ran. */
export type CheckResult = ContractCheckResult & { stale?: boolean; tree_sha?: string | null }

/** A lock as the page composes it (the backend fills symbol and label in). */
export interface LockSpec { path: string; symbol?: string | null; mode: LockMode; label?: string | null }

/** One event of a run's stream as the page receives it (the SSE frame: its name, its payload, its cursor). */
export interface SSEItem { event: string; data: Record<string, unknown>; id?: string }
