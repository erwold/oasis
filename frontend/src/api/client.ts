import type { WebSearchSettings } from '../state/webSearch'
import type { TargetRef } from './ssh'
import type { ReplayBody } from '../state/replayState'
import type { Mention } from '../state/entities'
import type { AccessMode, HarnessMode, EffectiveMode } from '@oasis-code/contract/modes'
import type { ChunkApi, UploadSession } from '../state/chunkedUpload'
import type {
  Attachment, DirectorSayBody, InteractionDetail, InteractionTemplate, IntegrationResult, Relay, ScheduleNode, UndoResult, UiActionBody, UiActionResponse, UiStateBody,
  UiSurfaceRecord, UiSurfacesResponse, UiChartSourcePage, UiInputRecord, UiInputStatus, UiInputSubmitBody, UiTaskBody, UiTaskRecord, UiTaskStartResponse, Watch,
  SteerBody, SteerList, SteerRecord, SteerResponse, ShareSnapshotRequest, RunDiffResponse,
  CollaborationGraph, RunCollaboration, ParticipantDetail, ParticipantMessageBody, WorkOrderBody, QueuedFollowup, SessionActivityResponse,
} from '@oasis-code/contract'
import { isQueuedFollowup } from '@oasis-code/contract'
import {
  LiveShareSettingsResponseSchema, ShareLinkListResponseSchema, ShareLinkRevokeResponseSchema, ShareLinkSecretResponseSchema,
  ShareLinkV2ListResponseSchema, ShareLinkV2RevokeResponseSchema, ShareLinkV2SecretResponseSchema,
  type ShareLinkCreateV2Request, type ShareLinkV2ListResponse, type ShareLinkV2RevokeResponse, type ShareLinkV2SecretResponse, type ShareSnapshotV3Request,
  type LiveShareSettings, type LiveShareSettingsResponse, type ShareLinkCreateRequest, type ShareLinkListResponse, type ShareLinkRevokeResponse,
  type ShareLinkSecretResponse,
} from '@oasis-code/contract'

/** The body of a separate task from the composer: the contract's work-order body (workspace_policy, cites and
 *  receive_run_ids at the top level). */
export type SeparateTaskBody = Omit<WorkOrderBody, 'work_order'> & { work_order: { prompt: string; label?: string | null; model?: string | null } & Record<string, unknown> }
import type {
  Approval, AuthAccounts, BuildInfo, DiffResponse, LoginSession, ModelEntry, OutputWindow, Project, Run, RunDetailResponse,
  Session, SessionDetail, TranscriptEntry, UsageSnapshot, WorkspaceDetail, ContextReport, SurfaceTool, ActionProposal, RunControl, RunTreeRow, Receipt, DirListing,
  DirectorDetail, DirectorOpenBody, DirectorTurn, DirectorUpdateBody } from './types'

/** The director persists this envelope and forwards its materials to the actual agent runs. Attachments do not
 * require the director model itself to accept their media. Kept compatible with the pre-v24 contract while the
 * backend/contract change is integrated; v24 owns validation of these fields. */
export type DirectorMessageBody = Partial<Omit<DirectorSayBody, 'attachments' | 'mentions' | 'budget'>> & {
  text: string; attachments?: string[]; mentions?: Mention[]; model?: string | null; thinking?: string | null
  participant_thinking?: Record<string, string>; fresh?: boolean; resumes_run_id?: string | null
  budget?: Record<string, number>; client_request_id?: string
}

const TOKEN_KEY = 'oasis-code.token'

const uiPath = (sessionId: string, runId: string, surfaceId: string) =>
  `/api/sessions/${encodeURIComponent(sessionId)}/ui/${encodeURIComponent(runId)}/${encodeURIComponent(surfaceId)}`
const tasksPath = (sessionId: string) => `/api/sessions/${encodeURIComponent(sessionId)}/ui-tasks`
const inputsPath = (sessionId: string) => `/api/sessions/${encodeURIComponent(sessionId)}/ui-inputs`
const query = (q: Record<string, string | undefined>): string => {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(q)) if (v !== undefined) p.set(k, v)
  const s = p.toString()
  return s ? `?${s}` : ''
}
export interface StoredTranscript { run_id: string; status: string; model: string; entries: TranscriptEntry[]; steers?: SteerRecord[] }
export type SessionOpening = SessionDetail & { transcripts?: Record<string, StoredTranscript>; transcript_errors?: Record<string, string> }

export interface SessionMode { mode: EffectiveMode; session: SessionDetail; control: RunControl }
/** GET / PUT /api/sessions/:id/access (contract SessionAccess, with the page's SessionDetail) */
/** GET / PUT /api/sessions/:id/roots (schema v29; typed here until the contract names it) */
export interface SessionAccess { access_mode: AccessMode; switchable: boolean; blocked_by: { runs: number; executions: number; approvals: number }; session: SessionDetail }

export function rememberTokenFromUrl(): void {
  const params = new URLSearchParams(window.location.search)
  const token = params.get('token')
  if (token) {
    try { localStorage.setItem(TOKEN_KEY, token) } catch { /* private mode */ }
    window.history.replaceState({}, '', window.location.pathname)
  }
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  let token: string | null = null
  try { token = localStorage.getItem(TOKEN_KEY) } catch { /* none */ }
  return { ...(token ? { 'x-oasis-code-token': token } : {}), ...extra }
}

/** A refused request: the status and the body the harness answered with (a 413 carries what it measured). */
export class ApiError extends Error {
  readonly status: number
  readonly detail: string
  readonly body: Record<string, unknown> | null
  constructor(status: number, detail: string, body: Record<string, unknown> | null) {
    super(`${status}: ${detail}`)
    this.name = 'ApiError'
    this.status = status
    this.detail = detail
    this.body = body
  }
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, { ...init, headers: headers({ ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers as Record<string, string> | undefined) }) })
  if (!res.ok) {
    let detail = res.statusText
    let body: Record<string, unknown> | null = null
    try {
      const parsed: unknown = await res.json()
      if (isObject(parsed)) { body = parsed; if (typeof parsed.detail === 'string') detail = parsed.detail }
    } catch { /* keep */ }
    throw new ApiError(res.status, detail, body)
  }
  return res.json() as Promise<T>
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function assertRun(value: unknown): Run {
  if (!isObject(value) || typeof value.id !== 'string' || typeof value.status !== 'string') throw new Error('malformed run')
  return value as unknown as Run
}

/** A follow-up's answer: the Run it started (200), or the interaction step it waits as (202, no run yet). */
function assertFollowup(value: unknown): Run | QueuedFollowup {
  if (isQueuedFollowup(value)) return value
  return assertRun(value)
}

/** A diff's query: one file (`path`), each file whole (`full`). */
function diffQuery(opts: { path?: string; full?: boolean }): string {
  const q = new URLSearchParams()
  if (opts.path) q.set('path', opts.path)
  if (opts.full) q.set('full', '1')
  const text = q.toString()
  return text ? `?${text}` : ''
}

export const api = {
  build: () => request<BuildInfo>('/api/meta/build'),
  models: () => request<{ models: ModelEntry[]; default: string }>('/api/models'),
  isolation: () => request<Record<string, unknown>>('/api/meta/isolation'),
  projects: () => request<Project[]>('/api/projects'),
  /** every session's agents now and how many of their runs ended (the rail's dots) */
  sessionActivity: () => request<SessionActivityResponse>('/api/session-activity'),
  createProject: (body: { target?: TargetRef; name?: string; source_path?: string; instructions?: string; mode?: 'snapshot' | 'attached' | 'direct'; no_folder?: boolean; client_request_id?: string }) =>
    request<Project>('/api/projects', { method: 'POST', body: JSON.stringify(body) }),
  // every session starts in Auto, set by the server with the session in one transaction; its access (where its
  // commands run) as the start screen chose it (omitted: the harness's default, full)
  createSession: (projectId: string, body: { title?: string; model?: string; access_mode?: AccessMode; client_request_id?: string }) =>
    request<SessionDetail>(`/api/projects/${projectId}/sessions`, { method: 'POST', body: JSON.stringify({ ...body, mode: 'auto' }) }),
  session: (id: string, opening?: { signal: AbortSignal }) => request<SessionOpening>(`/api/sessions/${id}${opening ? '?transcripts=1' : ''}`, opening ? { signal: opening.signal, cache: 'no-store' } : {}),
  renameSession: (id: string, title: string) => request<SessionDetail>(`/api/sessions/${id}`, { method: 'PUT', body: JSON.stringify({ title }) }),
  pinSession: (id: string, pinned: boolean) => request<Session>(`/api/sessions/${id}/pin`, { method: 'PUT', body: JSON.stringify({ pinned }) }),
  deleteSession: (id: string) => request<{ deleted: boolean; session_id: string }>(`/api/sessions/${id}`, { method: 'DELETE' }),
  sessionMode: (id: string) => request<SessionMode>(`/api/sessions/${id}/mode`),
  setSessionMode: (id: string, mode: HarnessMode) => request<SessionMode>(`/api/sessions/${id}/mode`, { method: 'PUT', body: JSON.stringify({ mode }) }),
  /** where the session's commands run, whether that can change now and what holds it (orthogonal to its mode) */
  sessionAccess: (id: string) => request<SessionAccess>(`/api/sessions/${encodeURIComponent(id)}/access`),
  /** change it: a 409 (ApiError, body.blocked_by) while a run, a command or an approval of the session is outstanding */
  setSessionAccess: (id: string, access_mode: AccessMode) => request<SessionAccess>(`/api/sessions/${encodeURIComponent(id)}/access`, { method: 'PUT', body: JSON.stringify({ access_mode }) }),
  /** the session's further folders (schema v29 roots) with whether they can change now and what holds them */
  /** the session's whole list of folders, replaced (the person's only): a 409 roots_blocked (ApiError: code, detail,
   *  next_step, blocked_by) while a run, a command or an approval of the session is outstanding */
  setGrants: (id: string, body: Record<string, unknown>) =>
    request<SessionDetail>(`/api/sessions/${id}/grants`, { method: 'PUT', body: JSON.stringify(body) }),
  /** an image for the session: the file's bytes as the body; the harness measures and names what it stores */
  uploadAttachment: async (sessionId: string, file: Blob, name: string): Promise<Attachment> => {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/attachments?name=${encodeURIComponent(name)}`, {
      method: 'POST', body: file, headers: headers({ 'content-type': file.type || 'application/octet-stream' }),
    })
    if (!res.ok) {
      let detail = res.statusText
      try { const parsed: unknown = await res.json(); if (isObject(parsed) && typeof parsed.detail === 'string') detail = parsed.detail } catch { /* keep */ }
      throw new ApiError(res.status, detail, null)
    }
    return res.json() as Promise<Attachment>
  },
  /** a PDF's or a video's chunked upload for the session (state/chunkedUpload.ts): opened with the file's name, size and
   *  type; each chunk PUT at its offset with a slice of the File as the body (the browser reads it from disk as it
   *  sends); where the harness got, asked; completed into the reference; dropped */
  uploads: (sessionId: string): ChunkApi => {
    const base = `/api/sessions/${encodeURIComponent(sessionId)}/uploads`
    const one = (uploadId: string) => `${base}/${encodeURIComponent(uploadId)}`
    return {
      create: (body, signal) => request<UploadSession>(base, { method: 'POST', body: JSON.stringify(body), signal }),
      put: (uploadId, offset, chunk, signal) => request<{ received: number }>(`${one(uploadId)}?offset=${offset}`, { method: 'PUT', body: chunk, signal, headers: { 'content-type': 'application/octet-stream' } }),
      status: (uploadId, signal) => request<{ received: number }>(one(uploadId), { signal }),
      complete: (uploadId, signal) => request<unknown>(`${one(uploadId)}/complete`, { method: 'POST', signal }),
      cancel: (uploadId) => request<unknown>(one(uploadId), { method: 'DELETE' }),
    }
  },
  /** a HEIC photo as a JPEG (the harness converts it; nothing is stored): what the composer then shows and uploads */
  imageToJpeg: async (file: Blob): Promise<Blob> => {
    const res = await fetch('/api/images/jpeg', { method: 'POST', body: file, headers: headers({ 'content-type': 'application/octet-stream' }) })
    if (!res.ok) {
      let detail = res.statusText
      try { const parsed: unknown = await res.json(); if (isObject(parsed) && typeof parsed.detail === 'string') detail = parsed.detail } catch { /* keep */ }
      throw new ApiError(res.status, detail, null)
    }
    return res.blob()
  },
  // /chat is the explicit agent path; director conversation turns have their own endpoint and response type.
  chat: async (sessionId: string, body: { text: string; model?: string | null; fresh?: boolean; thinking?: string | null; budget?: Record<string, number>; mentions?: Mention[]; attachments?: string[]; client_request_id?: string; agents?: { model: string }[]; rounds?: number; participant_thinking?: Record<string, string>; cites?: { run_id: string; note?: string | null }[]; receive_run_ids?: string[] }) =>
    assertRun(await request<unknown>(`/api/sessions/${sessionId}/chat`, { method: 'POST', body: JSON.stringify(body) })),
  run: (id: string) => request<RunDetailResponse>(`/api/runs/${id}`),
  // the relay: one message to several agents who take turns on it (started by chat with two or more agents)
  relays: (sessionId: string) => request<{ session_id: string; relays: (Relay & { live: boolean })[] }>(`/api/sessions/${sessionId}/relays`),
  relay: (id: string) => request<Relay & { live: boolean }>(`/api/relays/${id}`),
  cancelRelay: (id: string) => request<{ cancelled: boolean; relay: Relay }>(`/api/relays/${id}/cancel`, { method: 'POST' }),
  continueRelay: (id: string, rounds?: number | null) => request<Relay>(`/api/relays/${id}/continue`, { method: 'POST', body: JSON.stringify(rounds ? { rounds } : {}) }),
  // the interaction: one message to several agents run as a graph of nodes (the director's plan, or a template's)
  startInteraction: (sessionId: string, body: {
    text: string; thinking?: string | null; mentions?: Mention[]; attachments?: string[]; fresh?: boolean; client_request_id?: string; director_model?: string | null
    participant_thinking?: Record<string, string>; workspace_policy?: 'legacy' | 'isolated'
    plan?: { template: InteractionTemplate; cross_rounds?: number } | { nodes: ScheduleNode[]; then?: 'stop' | 'director' } | null; max_runs?: number; concurrency?: number
    cites?: { run_id: string; note?: string | null }[]
  }) => request<InteractionDetail>(`/api/sessions/${sessionId}/interactions`, { method: 'POST', body: JSON.stringify(body) }),
  interaction: (id: string) => request<InteractionDetail>(`/api/interactions/${id}`),
  undoRun: (id: string) => request<UndoResult>(`/api/runs/${id}/undo`, { method: 'POST' }),
  cancelWatch: (id: string) => request<{ cancelled: boolean; watch: Watch | null }>(`/api/watches/${id}/cancel`, { method: 'POST' }),
  cancelInteraction: (id: string) => request<{ cancelled: boolean; interaction: InteractionDetail }>(`/api/interactions/${id}/cancel`, { method: 'POST' }),
  continueInteraction: (id: string) => request<InteractionDetail>(`/api/interactions/${id}/continue`, { method: 'POST', body: JSON.stringify({}) }),
  adoptNode: (id: string, nodeId: string) => request<IntegrationResult>(`/api/interactions/${id}/adopt`, { method: 'POST', body: JSON.stringify({ node_id: nodeId }) }),
  pauseInteraction: (id: string) => request<InteractionDetail>(`/api/interactions/${id}/pause`, { method: 'POST' }),
  noteInteraction: (id: string, to: string, text: string) => request<InteractionDetail>(`/api/interactions/${id}/notes`, { method: 'POST', body: JSON.stringify({ to, text }) }),
  /** steps the person asks for (another round, a synthesis): the harness grows the budget to fit them */
  addInteractionSteps: (id: string, body: { nodes: ScheduleNode[]; then?: 'stop' | 'director' }) => request<InteractionDetail>(`/api/interactions/${id}/steps`, { method: 'POST', body: JSON.stringify(body) }),
  context: (sessionId: string, model?: string | null) => request<ContextReport>(`/api/sessions/${sessionId}/context${model ? `?model=${encodeURIComponent(model)}` : ''}`),
  control: (sessionId: string) => request<{ control: RunControl; effect_tags: string[]; gateable_tools: string[] }>(`/api/sessions/${sessionId}/agent-control`),
  proposals: (sessionId: string) => request<{ proposals: ActionProposal[] }>(`/api/sessions/${sessionId}/action-proposals`),
  proposal: (id: string) => request<{ proposal_asset_id: string; payload: Record<string, unknown>; decision: unknown }>(`/api/action-proposals/${id}`),
  decideProposal: (id: string, decision: 'approve' | 'reject', reason = '') =>
    request<{ status: string; result?: Record<string, unknown> }>(`/api/action-proposals/${id}/decide`, { method: 'POST', body: JSON.stringify({ decision, reason }) }),
  entities: (workspaceId: string, q: string) =>
    request<{ query: string; paths: string[]; symbols: { path: string; name: string; kind: string; line: number }[] }>(`/api/workspaces/${workspaceId}/entities?q=${encodeURIComponent(q)}&limit=12`),
  /** a page of a run's events after `after` (the session stream's catch-up: a bounded read, never a stream) */
  runEventsPage: (runId: string, after: number, limit: number) =>
    request<{ run_id: string; session_id: string; events: { seq: number; event: string; data: Record<string, unknown> }[] }>(`/api/runs/${encodeURIComponent(runId)}/events/page?after=${after}&limit=${limit}`),
  tree: (sessionId: string, signal?: AbortSignal) => request<{ session_id: string; runs: RunTreeRow[] }>(`/api/sessions/${sessionId}/runs/tree`, { signal }),
  /** a follow-up of an ended run: its Run, or (a group member's step queued behind its group) the QueuedFollowup */
  resume: async (runId: string, body: { text: string; model?: string | null; thinking?: string | null; client_request_id?: string; expected_head_run_id?: string | null }) =>
    assertFollowup(await request<unknown>(`/api/runs/${runId}/resume`, { method: 'POST', body: JSON.stringify(body) })),
  /** the session's collaboration graph (schema v25); `ifRevision`: the revision held — 304 answers `unchanged` */
  collaboration: async (sessionId: string, ifRevision?: string | null, signal?: AbortSignal): Promise<CollaborationGraph | { unchanged: true }> => {
    const q = ifRevision ? `?if_revision=${encodeURIComponent(ifRevision)}` : ''
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/collaboration${q}`, { headers: headers(), cache: 'no-store', signal })
    if (res.status === 304) return { unchanged: true }
    if (!res.ok) {
      let detail = res.statusText
      let body: Record<string, unknown> | null = null
      try { const parsed: unknown = await res.json(); if (isObject(parsed)) { body = parsed; if (typeof parsed.detail === 'string') detail = parsed.detail } } catch { /* keep */ }
      throw new ApiError(res.status, detail, body)
    }
    return res.json() as Promise<CollaborationGraph>
  },
  runCollaboration: (runId: string) => request<RunCollaboration>(`/api/runs/${encodeURIComponent(runId)}/collaboration`),
  participant: (participantId: string, q: { limit?: number; before?: string } = {}) =>
    request<ParticipantDetail>(`/api/participants/${encodeURIComponent(participantId)}${query({ limit: q.limit !== undefined ? String(q.limit) : undefined, before: q.before })}`),
  /** a message continuing a participant's current conversation (a follow-up of its head run) */
  participantMessage: async (participantId: string, body: ParticipantMessageBody) =>
    assertFollowup(await request<unknown>(`/api/participants/${encodeURIComponent(participantId)}/messages`, { method: 'POST', body: JSON.stringify(body) })),
  /** a separate task: a work order of the session, on a workspace of its own when `workspace_policy` is isolated */
  workOrder: async (sessionId: string, body: SeparateTaskBody) =>
    assertRun(await request<unknown>(`/api/sessions/${encodeURIComponent(sessionId)}/work-orders`, { method: 'POST', body: JSON.stringify(body) })),
  /** one tool call as its model saw it: the arguments and the whole return (long texts cut past a bound: `cut`) */
  toolCall: (runId: string, callId: string) => request<{ run_id: string; tool_call_id: string; tool: string; args: unknown; result: unknown; cut: boolean }>(`/api/runs/${encodeURIComponent(runId)}/calls/${encodeURIComponent(callId)}`),
  /** a run's own measured changes, with their attribution (409 attribution_unavailable: no reliable baseline) */
  runDiff: (runId: string, opts: { path?: string; full?: boolean } = {}) => request<RunDiffResponse>(`/api/runs/${runId}/diff${diffQuery(opts)}`),
  receipt: (runId: string) => request<{ run_id: string; status: string; receipt: Receipt | null }>(`/api/runs/${runId}/receipt`),
  replay: (sessionId: string) => request<ReplayBody>(`/api/sessions/${sessionId}/replay`),
  /** the offline share's strict snapshot of a quiescent session (contract/src/share.ts; state/share.ts checks it) */
  shareSnapshot: (sessionId: string, body: ShareSnapshotRequest, signal?: AbortSignal) =>
    request<unknown>(`/api/sessions/${encodeURIComponent(sessionId)}/share-snapshot`, { method: 'POST', body: JSON.stringify(body), signal, cache: 'no-store' }),
  // the live share (contract/src/live_share.ts), owner-only: the share listener's settings and status, a session's
  // links (never their capability), a link made, its capability revealed again (the same one every time), revoked.
  // Every answer is checked by its strict schema; a capability is never logged or kept beyond the dialog that asked.
  liveShareSettings: async (signal?: AbortSignal): Promise<LiveShareSettingsResponse> =>
    LiveShareSettingsResponseSchema.parse(await request<unknown>('/api/settings/live-share', { signal, cache: 'no-store' })),
  saveLiveShareSettings: async (body: LiveShareSettings): Promise<LiveShareSettingsResponse> =>
    LiveShareSettingsResponseSchema.parse(await request<unknown>('/api/settings/live-share', { method: 'PUT', body: JSON.stringify(body), cache: 'no-store' })),
  shareLinks: async (sessionId: string, signal?: AbortSignal): Promise<ShareLinkListResponse> =>
    ShareLinkListResponseSchema.parse(await request<unknown>(`/api/sessions/${encodeURIComponent(sessionId)}/share-links`, { signal, cache: 'no-store' })),
  createShareLink: async (sessionId: string, body: ShareLinkCreateRequest): Promise<ShareLinkSecretResponse> =>
    ShareLinkSecretResponseSchema.parse(await request<unknown>(`/api/sessions/${encodeURIComponent(sessionId)}/share-links`, { method: 'POST', body: JSON.stringify(body), cache: 'no-store' })),
  revealShareLink: async (linkId: string): Promise<ShareLinkSecretResponse> =>
    ShareLinkSecretResponseSchema.parse(await request<unknown>(`/api/share-links/${encodeURIComponent(linkId)}/reveal`, { method: 'POST', body: '{}', cache: 'no-store' })),
  revokeShareLink: async (linkId: string): Promise<ShareLinkRevokeResponse> =>
    ShareLinkRevokeResponseSchema.parse(await request<unknown>(`/api/share-links/${encodeURIComponent(linkId)}/revoke`, { method: 'POST', body: '{}', cache: 'no-store' })),
  // V3 / v2: the Agent Teams card, the faces, and (when asked) every session of the task — what the dialog uses now; the
  // routes above stay for older pages
  shareSnapshotV3: (sessionId: string, body: ShareSnapshotV3Request, signal?: AbortSignal) =>
    request<unknown>(`/api/sessions/${encodeURIComponent(sessionId)}/share-snapshot/v3`, { method: 'POST', body: JSON.stringify(body), signal, cache: 'no-store' }),
  shareLinksV2: async (sessionId: string, signal?: AbortSignal): Promise<ShareLinkV2ListResponse> =>
    ShareLinkV2ListResponseSchema.parse(await request<unknown>(`/api/sessions/${encodeURIComponent(sessionId)}/share-links/v2`, { signal, cache: 'no-store' })),
  createShareLinkV2: async (sessionId: string, body: ShareLinkCreateV2Request): Promise<ShareLinkV2SecretResponse> =>
    ShareLinkV2SecretResponseSchema.parse(await request<unknown>(`/api/sessions/${encodeURIComponent(sessionId)}/share-links/v2`, { method: 'POST', body: JSON.stringify(body), cache: 'no-store' })),
  revealShareLinkV2: async (linkId: string): Promise<ShareLinkV2SecretResponse> =>
    ShareLinkV2SecretResponseSchema.parse(await request<unknown>(`/api/share-links/${encodeURIComponent(linkId)}/v2/reveal`, { method: 'POST', body: '{}', cache: 'no-store' })),
  revokeShareLinkV2: async (linkId: string): Promise<ShareLinkV2RevokeResponse> =>
    ShareLinkV2RevokeResponseSchema.parse(await request<unknown>(`/api/share-links/${encodeURIComponent(linkId)}/v2/revoke`, { method: 'POST', body: '{}', cache: 'no-store' })),
  // Intelligent UI: the session's surfaces (every run's, latest revision and state), a surface's state saved at the
  // revision it was edited at, an action prepared into a prompt (the harness runs nothing; the page puts it in the draft)
  uiSurfaces: (sessionId: string) => request<UiSurfacesResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/ui`),
  saveUiState: (sessionId: string, runId: string, surfaceId: string, body: UiStateBody) =>
    request<{ surface: UiSurfaceRecord }>(`${uiPath(sessionId, runId, surfaceId)}/state`, { method: 'PUT', body: JSON.stringify(body) }),
  prepareUiAction: (sessionId: string, runId: string, surfaceId: string, body: UiActionBody) =>
    request<UiActionResponse>(`${uiPath(sessionId, runId, surfaceId)}/actions`, { method: 'POST', body: JSON.stringify(body) }),
  // a `run` action's agent task (started, or queued behind the conversation's live run), its record, its stop
  startUiTask: (sessionId: string, runId: string, surfaceId: string, body: UiTaskBody) =>
    request<UiTaskStartResponse>(`${uiPath(sessionId, runId, surfaceId)}/tasks`, { method: 'POST', body: JSON.stringify(body) }),
  // a chart's file source: one page of the file, read by the harness under the publishing run's read bounds
  uiChartSourcePage: (sessionId: string, runId: string, surfaceId: string, elementId: string, q: { revision: number; offset: number; limit: number; verify: boolean }, signal?: AbortSignal) =>
    request<UiChartSourcePage>(`${uiPath(sessionId, runId, surfaceId)}/sources/${encodeURIComponent(elementId)}${query({ revision: String(q.revision), offset: String(q.offset), limit: String(q.limit), verify: q.verify ? '1' : undefined })}`, { cache: 'no-store', signal }),
  uiTasks: (sessionId: string, q: { run_id?: string; surface_id?: string; active?: boolean } = {}) =>
    request<{ tasks: UiTaskRecord[] }>(`${tasksPath(sessionId)}${query({ run_id: q.run_id, surface_id: q.surface_id, active: q.active ? '1' : undefined })}`, { cache: 'no-store' }),
  uiTask: (sessionId: string, taskId: string) => request<{ task: UiTaskRecord }>(`${tasksPath(sessionId)}/${encodeURIComponent(taskId)}`, { cache: 'no-store' }),
  cancelUiTask: (sessionId: string, taskId: string) =>
    request<{ task: UiTaskRecord }>(`${tasksPath(sessionId)}/${encodeURIComponent(taskId)}/cancel`, { method: 'POST', body: JSON.stringify({}) }),
  // request_input's forms: listed (pending ones after a refresh), answered (the waiting call's result) or declined
  uiInputs: (sessionId: string, q: { run_id?: string; status?: UiInputStatus } = {}) =>
    request<{ inputs: UiInputRecord[] }>(`${inputsPath(sessionId)}${query(q)}`, { cache: 'no-store' }),
  uiInput: (sessionId: string, inputId: string) => request<{ input: UiInputRecord }>(`${inputsPath(sessionId)}/${encodeURIComponent(inputId)}`, { cache: 'no-store' }),
  submitUiInput: (sessionId: string, inputId: string, body: UiInputSubmitBody) =>
    request<{ input: UiInputRecord }>(`${inputsPath(sessionId)}/${encodeURIComponent(inputId)}/submit`, { method: 'POST', body: JSON.stringify(body) }),
  dismissUiInput: (sessionId: string, inputId: string, body: { request_id?: string } = {}) =>
    request<{ input: UiInputRecord }>(`${inputsPath(sessionId)}/${encodeURIComponent(inputId)}/dismiss`, { method: 'POST', body: JSON.stringify(body) }),
  dirs: (path?: string) => request<DirListing>(`/api/fs/dirs${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  surface: () => request<{ tools: SurfaceTool[] }>('/api/agent/surface'),
  // `steers`: the run's steer records (contract SteerRecord; each checked by state/steer.ts before it is shown)
  transcript: (id: string) => request<StoredTranscript>(`/api/runs/${id}/transcript`),
  /** words for the run while it works: into its next model request (the harness answers with the steer's record; the
   *  same key and words again answer with the same record) */
  steer: (runId: string, body: SteerBody) =>
    request<SteerResponse>(`/api/runs/${encodeURIComponent(runId)}/steer`, { method: 'POST', body: JSON.stringify(body) }),
  /** the run's steers, in the order they were queued */
  steers: (runId: string) => request<SteerList>(`/api/runs/${encodeURIComponent(runId)}/steers`, { cache: 'no-store' }),
  cancel: (id: string) => request<{ cancelled: boolean }>(`/api/runs/${id}/cancel`, { method: 'POST' }),
  /** stop a command by its execution id (its process group): one holding a folder another run waits for */
  stopExecution: (id: string) => request<{ stopped: boolean }>(`/api/executions/${encodeURIComponent(id)}/stop`, { method: 'POST' }),
  workspace: (id: string) => request<WorkspaceDetail>(`/api/workspaces/${id}`),
  diff: (id: string, opts: { path?: string; full?: boolean } = {}) => request<DiffResponse>(`/api/workspaces/${id}/diff${diffQuery(opts)}`),
  output: (executionId: string, stream: string, offset = 0, limit = 65536) =>
    request<OutputWindow>(`/api/executions/${executionId}/output?stream=${stream}&offset=${offset}&limit=${limit}`),
  decide: (approvalId: string, approve: boolean) =>
    request<Approval>(`/api/approvals/${approvalId}`, { method: 'POST', body: JSON.stringify({ approve }) }),
  getWebSearch: (signal?: AbortSignal) => request<WebSearchSettings>('/api/settings/web-search', { signal, cache: 'no-store' }),
  saveWebSearch: (settings: WebSearchSettings) => request<WebSearchSettings>('/api/settings/web-search', { method: 'PUT', body: JSON.stringify(settings) }),
  getAuthAccounts: (signal?: AbortSignal) => request<AuthAccounts>('/api/auth/accounts', { signal, cache: 'no-store' }),
  getAccountUsage: (refresh = false, signal?: AbortSignal) =>
    request<UsageSnapshot>(`/api/auth/usage${refresh ? '?refresh=true' : ''}`, { signal, cache: 'no-store' }),
  startLogin: (provider: string) => request<LoginSession>(`/api/auth/login/${provider}`, { method: 'POST' }),
  getLogin: (id: string, signal?: AbortSignal) => request<LoginSession>(`/api/auth/login/${id}`, { signal, cache: 'no-store' }),
  submitLoginCode: (id: string, input: string) => request<LoginSession>(`/api/auth/login/${id}/code`, { method: 'POST', body: JSON.stringify({ input }) }),
  cancelLogin: (id: string) => request<LoginSession>(`/api/auth/login/${id}`, { method: 'DELETE' }),
  logout: (provider: string) => request<{ provider: string; removed: boolean }>(`/api/auth/accounts/${provider}`, { method: 'DELETE' }),
  saveApiKey: (provider: string, key: string, custom?: { label: string; env: string }) =>
    request<{ provider: string; source: 'stored'; hint: string }>(`/api/auth/keys/${provider}`, { method: 'PUT', body: JSON.stringify({ key, ...custom }) }),
  forgetApiKey: (provider: string) => request<{ provider: string; removed: boolean }>(`/api/auth/keys/${provider}`, { method: 'DELETE' }),
  // the director session: the harness holding the conversation with an outside director
  director: (sessionId: string) => request<DirectorDetail>(`/api/sessions/${sessionId}/director`),
  openDirector: (sessionId: string, body: DirectorOpenBody) => request<DirectorDetail>(`/api/sessions/${sessionId}/director`, { method: 'POST', body: JSON.stringify(body) }),
  updateDirector: (sessionId: string, body: DirectorUpdateBody) => request<DirectorDetail>(`/api/sessions/${sessionId}/director`, { method: 'PUT', body: JSON.stringify(body) }),
  closeDirector: (sessionId: string) => request<{ closed: boolean }>(`/api/sessions/${sessionId}/director`, { method: 'DELETE' }),
  sayToDirector: (sessionId: string, body: DirectorMessageBody) => request<DirectorTurn>(`/api/sessions/${sessionId}/director/messages`, { method: 'POST', body: JSON.stringify(body) }),
  directorTurn: (turnId: string) => request<DirectorTurn>(`/api/director-turns/${turnId}`),
  cancelDirectorTurn: (turnId: string) => request<DirectorTurn>(`/api/director-turns/${turnId}/cancel`, { method: 'POST' }),
  assetText: async (assetId: string) => {
    const res = await fetch(`/api/assets/${assetId}`, { headers: headers() })
    if (!res.ok) throw new Error(`${res.status}`)
    return res.text()
  },
}

export function directorTurnEventsUrl(turnId: string, after: number | null): string {
  const q = new URLSearchParams()
  if (after != null && after >= 0) q.set('after', String(after))
  const query = q.toString()
  return `/api/director-turns/${turnId}/events${query ? `?${query}` : ''}`
}

/** The session's one stream, after the session cursor (contract events.ts SESSION_STREAM_READY). */
export function sessionEventsUrl(sessionId: string, after: number): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/events?after=${Math.max(0, Math.trunc(after))}`
}

export function eventSourceUrl(runId: string, after: number | null): string {
  const q = new URLSearchParams()
  if (after != null && after >= 0) q.set('after', String(after))
  const query = q.toString()
  return `/api/runs/${runId}/events${query ? `?${query}` : ''}`
}
