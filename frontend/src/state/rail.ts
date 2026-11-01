import { resourceTarget, targetKey, type ExecutionTarget } from './target.ts'
import { plainAgentMentions } from '@oasis-code/contract'
import type { Project, Session } from '../api/types'

/** Where a new task starts: a folder the person picked (a project is made from it, or the one already made from
 *  it is reused) or a project from the rail. No target at all is a task that needs no folder: it opens in the one
 *  project kept for such tasks. */
export type TaskTarget =
  | { kind: 'folder'; target?: ExecutionTarget; path: string; mode?: 'snapshot' | 'attached' }
  | { kind: 'project'; target?: ExecutionTarget; projectId: string; name: string; path: string | null }

/** What the folder chip says for a target. */
export function targetLabel(target: TaskTarget | null): string {
  if (!target) return 'No folder'
  if (resourceTarget(target).kind !== 'local' && !target.path) return 'Project folder'
  if (target.kind === 'project') return target.path ? folderName(target.path) : target.name
  return target.mode === 'attached' ? `${folderName(target.path)} (attached, read-only)` : folderName(target.path)
}

/** What the import refusal says under the chip: the folder, what was measured (a lower bound when the measure
 *  stopped at a limit), the limit it crossed. */
export function refusalLine(refusal: { source_path: string; measured: { bytes: number; files: number; stopped_early: boolean }; limits: { max_bytes: number; max_files: number } }): string {
  const atLeast = refusal.measured.stopped_early ? 'at least ' : ''
  const files = refusal.measured.files.toLocaleString('en-US')
  const limit = refusal.measured.bytes > refusal.limits.max_bytes ? `the snapshot limit is ${humanBytes(refusal.limits.max_bytes)}` : `the snapshot limit is ${refusal.limits.max_files.toLocaleString('en-US')} files`
  return `${folderName(refusal.source_path)} is ${atLeast}${humanBytes(refusal.measured.bytes)} in ${files} files — too big to copy (${limit}).`
}

export function humanBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(bytes >= 10 * 1024 ** 3 ? 0 : 1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(bytes >= 10 * 1024 ** 2 ? 0 : 1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} kB`
  return `${bytes} B`
}

/** Pure helpers of the rail and the start screen: which sessions a project shows, the title a task gets from its
 *  first words, how a folder is shown (after oasis's rail and hero; the grouping is this product's, since a
 *  conversation here is a session inside a project — a folder). */

/** The title of a session started from the person's first words: their first line, cut at a word boundary. */
export function sessionTitle(text: string, max = 60): string {
  // an agent named with @ reads as its name in the title, never as the chip's token
  const line = plainAgentMentions(text).trim().split(/\r?\n/)[0]?.trim() ?? ''
  if (!line) return 'New task'
  if (line.length <= max) return line
  const cut = line.slice(0, max)
  if (line[max] === ' ') return `${cut}…`                     // the cut lands on a word boundary already
  const space = cut.lastIndexOf(' ')
  return `${space > max / 2 ? cut.slice(0, space) : cut}…`
}

/** The last path segment: what a folder chip says. */
export function folderName(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || path
}

/** When a session was last active: the harness's word (schema v27 `last_activity_at`: a run, words sent, a call to its
 *  director — never a rename, a setting or a restart's recovery); a harness before it says only `updated_at`. */
function sessionActivity(session: Session): string {
  return session.last_activity_at ?? session.updated_at
}

/** A session as the rail reads it: schema v29's task — the session whose task it joined (`task_root_id`; null or
 *  absent: its own). Read loosely until the contract names it. */
type TaskSession = Session & { task_root_id?: string | null }

/** A session of a task whose first session stands in another row of the rail: under that session, with the folder
 *  (project) it works in. */
export interface RailMember { session: Session; project: Project }
export interface RailGroup { project: Project; sessions: Session[]; members: Record<string, RailMember[]> }

/** The task a session belongs to: the session its `task_root_id` names, followed while it names another the list
 *  holds; null or its own id — itself. A root the list does not hold (deleted, not listed) leaves it where it is:
 *  nothing is regrouped without the harness's word. */
export function taskRootOf(session: Session, byId: ReadonlyMap<string, Session>): string {
  let current = session as TaskSession
  const seen = new Set<string>([current.id])
  for (;;) {
    const root = current.task_root_id
    if (!root || root === current.id || seen.has(root)) return current.id
    const next = byId.get(root) as TaskSession | undefined
    if (!next) return current.id
    seen.add(root)
    current = next
  }
}

/** Projects and tasks sort by unpinned activity; equal times by the later made, then id. An empty/all-pinned
 *  folder stands at its creation. A task member stays under its root, even if that root is pinned or in another
 *  folder. Unpinned members contribute to both their physical folder and the root's display group, as before;
 *  pinned members contribute to neither. Group the complete set so pinning cannot break task ancestry. */
export function railGroups(projects: Project[]): RailGroup[] {
  const stamp = (t: string) => Date.parse(t) || 0
  const order = (a: { at: number; made: string; id: string }, b: { at: number; made: string; id: string }) =>
    b.at - a.at || stamp(b.made) - stamp(a.made) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
  const every = projects.flatMap((project) => (project.sessions ?? []).map((session) => ({ session, project })))
  const byId = new Map(every.map(({ session }) => [session.id, session]))
  const members: Record<string, RailMember[]> = {}
  for (const entry of every) {
    const root = taskRootOf(entry.session, byId)
    if (root !== entry.session.id) (members[root] ??= []).push(entry)
  }
  const ownKey = (s: Session) => ({ at: stamp(sessionActivity(s)), made: s.created_at, id: s.id })
  for (const list of Object.values(members)) list.sort((a, b) => order(ownKey(a.session), ownKey(b.session)))
  const contribution = (s: Session) => sessionPinned(s) ? 0 : stamp(sessionActivity(s))
  const keyOf = (s: Session) => ({ ...ownKey(s), at: Math.max(contribution(s), ...(members[s.id] ?? []).map((m) => contribution(m.session))) })
  // A complete session list is authoritative, including immediately after pin/unpin: a cached/older project
  // aggregate can still include a pin. updated_at also carries pin activity via touchSession, so never use it.
  const projectActivity = (p: Project) => Math.max(stamp(p.created_at), ...(p.sessions
    ? p.sessions.map(contribution)
    : [stamp(p.last_activity_at ?? p.created_at)]))
  return [...projects]
    .map((project) => ({ project, sessions: (project.sessions ?? []).filter((s) => taskRootOf(s, byId) === s.id).sort((a, b) => order(keyOf(a), keyOf(b))) }))
    .map((g) => ({ ...g, key: { at: Math.max(projectActivity(g.project), g.sessions[0] ? keyOf(g.sessions[0]).at : 0), made: g.project.created_at, id: g.project.id } }))
    .sort((a, b) => order(a.key, b.key))
    .map(({ project, sessions }) => ({ project, sessions, members: Object.fromEntries(sessions.filter((s) => members[s.id]).map((s) => [s.id, members[s.id]!])) }))
}

export interface RailTask { id: string; session: Session | null; members: RailMember[] }
export interface RailProject { project: Project; tasks: RailTask[] }

export function sessionPinned(session: Session): boolean {
  return session.status === 'open' && session.pin_order != null && session.pin_order > 0
}

/** Project only after grouping the complete set: pins contribute no activity to Projects, while a pinned root
 *  leaves its unpinned members anchored in the original project.
 *  Pin order is independent of activity; the id breaks ties deterministically even for a loose/older response. */
export function railView(projects: Project[]): { pinned: RailMember[]; groups: RailProject[] } {
  const groups = railGroups(projects)
  const pinned = projects.flatMap((project) => (project.sessions ?? []).filter(sessionPinned).map((session) => ({ session, project })))
    .sort((a, b) => a.session.pin_order! - b.session.pin_order! || (a.session.id < b.session.id ? -1 : a.session.id > b.session.id ? 1 : 0))
  return { pinned, groups: groups.map(({ project, sessions, members }) => ({ project, tasks: sessions.map((s) => ({
    id: s.id, session: sessionPinned(s) ? null : s, members: (members[s.id] ?? []).filter((m) => !sessionPinned(m.session)),
  })).filter((task) => task.session !== null || task.members.length > 0) })) }
}

/** The project already made from a folder, if any (the same folder is never imported twice). */
/** The project a new task in the folder joins: one that opened it the same way — in place (the default since
 *  schema v19), or attached read-only — never a project that copied it (those stay as they were, with their sessions). */
export function projectForFolder(projects: Project[], path: string, kind: 'direct' | 'attached' = 'direct', target: ExecutionTarget = { kind: 'local' }): Project | undefined {
  const norm = (p: string) => target.kind === 'ssh' ? p.replace(/\/+$/, '') : p.replace(/[\\/]+$/, '')
  return projects.find((p) => target.kind !== 'unknown' && targetKey(resourceTarget(p)) === targetKey(target) && p.source_path && p.kind === kind && norm(p.source_path) === norm(path))
}

/** A path as crumbs: the root, then every folder down to the one in view (the folder dialog's head). */
export function crumbsOf(path: string): { name: string; path: string }[] {
  const parts = path.split('/').filter(Boolean)
  const out = [{ name: '/', path: '/' }]
  let cur = ''
  for (const part of parts) { cur += `/${part}`; out.push({ name: part, path: cur }) }
  return out
}
