/** A native director's reach: the session it was opened in, and the sessions its own create_session calls made (kept
 *  on the director session's config, `authorized_session_ids`, by the harness — never taken from a tool argument).
 *  Every tool argument that names something — a session, a project, a run, a workspace, a checkpoint (by itself, in a
 *  list, or as an order's base), an attachment, a proposal, an approval, an interaction, a relay, a director turn, a
 *  run cited or whose answer is handed over, at any depth of the arguments (a plan's steps included) — is resolved to
 *  the session it belongs to and refused when that is not a session the director reaches, before the harness is
 *  asked. One call names things of one session only: an answer is never carried from one task's session into
 *  another's. An id the director learnt somewhere is not an authorization; an id that names nothing gets the same
 *  answer as one that names another session's thing, so the refusal tells nothing about what exists. An outside
 *  director (the ChatGPT connector, the HTTP endpoint) is not bound here: its reach is the person's explicit choice to
 *  give it the whole harness. */

import type { Conn } from '../db/database.ts'
import * as repo from '../db/repo.ts'
import { getTurn } from './store.ts'
import { PROPOSAL_ROLE } from '../policy/gate.ts'
import { ATTACHMENT_ROLE } from '../api/attachments.ts'
import { surfaceText, type DirectorToolSurface } from './surfaces/index.ts'

type Rec = Record<string, unknown>

const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {})

/** The session a named thing belongs to, or null when nothing of that name exists. */
export function sessionOf(conn: Conn, kind: string, id: string): string | null {
  switch (kind) {
    case 'director_turn': return getTurn(conn, id)?.session_id ?? null
    case 'session': return repo.getSession(conn, id)?.id ?? null
    case 'run': return repo.getRun(conn, id)?.session_id ?? null
    case 'interaction': return repo.getInteraction(conn, id)?.session_id ?? null
    case 'relay': return repo.getRelay(conn, id)?.session_id ?? null
    case 'workspace': return repo.getWorkspace(conn, id)?.session_id ?? null
    case 'checkpoint': {
      const cp = repo.getCheckpoint(conn, id)
      return cp ? (repo.getWorkspace(conn, cp.workspace_id)?.session_id ?? null) : null
    }
    case 'approval': return repo.getApproval(conn, id)?.session_id ?? null
    case 'proposal':
    case 'attachment': {
      const asset = repo.getAsset(conn, id)
      if (asset === null || asset.meta.role !== (kind === 'proposal' ? PROPOSAL_ROLE : ATTACHMENT_ROLE)) return null
      return typeof asset.meta.session_id === 'string' ? asset.meta.session_id : null
    }
    case 'asset': {
      const asset = repo.getAsset(conn, id)
      return asset !== null && typeof asset.meta.session_id === 'string' ? asset.meta.session_id : null
    }
    default: return null
  }
}

/** Every session a named thing belongs to: one, but a folder edited in place — one workspace shared by its project's
 *  sessions — belongs to each session working in it; none when nothing of that name exists. */
export function sessionsOf(conn: Conn, kind: string, id: string): string[] {
  if (kind === 'workspace') {
    const ws = repo.getWorkspace(conn, id)
    if (ws === null) return []
    const working = repo.sessionsOfWorkspace(conn, id).map((s) => s.id)
    return working.length ? working : ws.session_id ? [ws.session_id] : []
  }
  const one = sessionOf(conn, kind, id)
  return one === null ? [] : [one]
}

/** The argument keys whose runs a call may take from another session it reaches (director.v6 and later: an explicit
 *  handover of ended runs' answers, with where they came from; api: receive_across_sessions). */
const ACROSS_SESSION_KEYS = new Set(['receive_run_ids'])
const SINGLE_SESSION_SURFACES = new Set(['director.v1', 'director.v2', 'director.v3', 'director.v4', 'director.v5'])

/** Keys whose values are words, never references: a run id quoted in prose is not a reference to it. */
const FREE_TEXT_KEYS = new Set(['text', 'instruction', 'instructions', 'note', 'prompt', 'title', 'question', 'answer', 'label', 'reason', 'message', 'command', 'path', 'cwd', 'name', 'source', 'model', 'thinking', 'data_base64'])
/** A whole value that has an id's form, by its prefix: what it names when no explicit path says. */
const ID_FORMS: [RegExp, string][] = [
  [/^run_[0-9a-f]{12}$/, 'run'], [/^s_[0-9a-f]{12}$/, 'session'], [/^ws_[0-9a-f]{12}$/, 'workspace'], [/^cp_[0-9a-f]{12}$/, 'checkpoint'],
  [/^ix_[0-9a-f]{12}$/, 'interaction'], [/^relay_[0-9a-f]{12}$/, 'relay'], [/^turn_[0-9a-f]{12}$/, 'director_turn'], [/^ap_[0-9a-f]{12}$/, 'approval'],
  [/^a_[0-9a-f]{12}$/, 'asset'],
]

/** The named things in a director tool's arguments: [kind, id, the argument that named it]. The explicit paths first
 *  (the baseline's keys, an order's base and resumed run, the cited runs and handed-over answers of a call and of
 *  every step of a plan), then any other value of an id's form anywhere in the arguments, outside the free-text keys. */
export function namedThings(args: Rec): [string, string, string][] {
  const out: [string, string, string][] = []
  const seen = new Set<string>()
  const one = (kind: string, key: string, value: unknown) => {
    if (typeof value !== 'string' || !value) return
    out.push([kind, value, key])
    seen.add(`${key}\u0000${value}`)
  }
  const many = (kind: string, key: string, value: unknown) => { if (Array.isArray(value)) for (const v of value) one(kind, key, v) }
  const cited = (key: string, value: unknown) => { if (Array.isArray(value)) value.forEach((c, i) => one('run', `${key}[${i}].run_id`, typeof c === 'string' ? c : rec(c).run_id)) }
  one('session', 'session_id', args.session_id)
  one('session', 'task_session_id', args.task_session_id)
  one('director_turn', 'source_turn_id', args.source_turn_id)
  one('run', 'run_id', args.run_id)
  one('run', 'resume_run_id', args.resume_run_id)
  one('run', 'expected_head_run_id', args.expected_head_run_id)
  one('interaction', 'interaction_id', args.interaction_id)
  one('checkpoint', 'base_checkpoint_id', args.base_checkpoint_id)
  one('workspace', 'workspace_id', args.workspace_id)
  one('checkpoint', 'checkpoint_id', args.checkpoint_id)
  many('checkpoint', 'checkpoint_ids', args.checkpoint_ids)
  one('proposal', 'proposal_id', args.proposal_id)
  one('proposal', 'proposal_asset_id', args.proposal_asset_id)
  one('approval', 'approval_id', args.approval_id)
  many('attachment', 'attachments', args.attachments)
  cited('cites', args.cites)
  many('run', 'receive_run_ids', args.receive_run_ids)
  for (const key of ['work_order', 'constraints']) {
    const order = rec(args[key])
    const base = rec(order.workspace).base
    if (typeof base === 'string' && base && base !== 'parent') one('checkpoint', `${key}.workspace.base`, base)
    one('run', `${key}.resumes_run_id`, order.resumes_run_id)
  }
  if (Array.isArray(args.nodes)) {
    args.nodes.forEach((n, i) => {
      cited(`nodes[${i}].cites`, rec(n).cites)
      many('run', `nodes[${i}].receive_runs`, rec(n).receive_runs)
      many('run', `nodes[${i}].receive_run_ids`, rec(n).receive_run_ids)
    })
  }
  // whatever else has an id's form, at any depth: a reference hidden in structure is still checked
  const walk = (value: unknown, path: string, depth: number) => {
    if (depth > 8) return
    if (typeof value === 'string') {
      if (seen.has(`${path}\u0000${value}`)) return
      for (const [form, kind] of ID_FORMS) if (form.test(value)) { out.push([kind, value, path]); seen.add(`${path}\u0000${value}`); return }
      return
    }
    if (Array.isArray(value)) { value.forEach((v, i) => walk(v, `${path}[${i}]`, depth + 1)); return }
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Rec)) if (!FREE_TEXT_KEYS.has(k)) walk(v, path ? `${path}.${k}` : k, depth + 1)
    }
  }
  walk(args, '', 0)
  // explicit paths keep their own key (the walk names the same value by its element path, already counted)
  const unique = new Map<string, [string, string, string]>()
  for (const item of out) { const key = `${item[0]}\u0000${item[1]}`; if (!unique.has(key)) unique.set(key, item) }
  return [...unique.values()]
}

/** Why a native director bound to `sessionId` may not make this call, or null. A `project_id` must be the bound
 *  session's project; everything named must belong to one session the director reaches: the bound one, or one of
 *  `reach` (the sessions its create_session calls made). `surface` picks the refusal's words (v1's text is frozen). */
export function scopeRefusal(conn: Conn, sessionId: string, _toolName: string, args: Rec, reach: readonly string[] = [], surface: DirectorToolSurface = 'director.v1'): string | null {
  const bound = repo.getSession(conn, sessionId)
  if (bound === null) return `this director's session ${sessionId} is gone`
  const allowed = new Set([sessionId, ...reach])
  // the surface's own words: v1's text is the snapshot's (one session), v2's names every session reached
  const outside = surfaceText(surface, 'director.session_refusal', { session_id: sessionId, session_ids: [...allowed].join(', ') })
  if (typeof args.project_id === 'string' && args.project_id && args.project_id !== bound.project_id) return outside
  // the sessions the call can be of: every named thing in one of them (a shared folder's workspace is each of its
  // sessions'); a run handed over across sessions (director.v6) only has to be one the director reaches
  const across = !SINGLE_SESSION_SURFACES.has(surface)
  let common: Set<string> | null = null
  for (const [kind, id, key] of namedThings(args)) {
    // v1–v5 keep the reach they had: a workspace is its own session's (a shared folder's first session's)
    const owners = (across ? sessionsOf(conn, kind, id) : [sessionOf(conn, kind, id)].filter((o): o is string => o !== null)).filter((o) => allowed.has(o))
    if (!owners.length) return outside
    if (across && kind === 'run' && ACROSS_SESSION_KEYS.has(key)) continue
    common = common === null ? new Set(owners) : new Set(owners.filter((o) => common!.has(o)))
    // one call, one session: nothing of one task's session is carried into another's (save an explicit handover)
    if (!common.size) return outside
  }
  return null
}

/** The session a call's named things belong to (after scopeRefusal passed), else null: the bound session when every
 *  named thing is of it (a shared folder's workspace is), else the first one's. */
export function targetSession(conn: Conn, args: Rec, preferred: string | null = null): string | null {
  const named = namedThings(args).map(([kind, id]) => sessionsOf(conn, kind, id))
  if (preferred !== null && named.length && named.every((owners) => owners.includes(preferred))) return preferred
  for (const owners of named) if (owners.length) return owners[0]!
  return null
}
