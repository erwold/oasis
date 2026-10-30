/** v24 source_mount belongs to Workspace only. Never infer a live mount from `isolated` or a missing checkpoint:
 * isolated snapshot workspaces are still copies. Unknown metadata blocks Keep until the actual workspace is read. */
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
export function isolatedWorkspace(value: unknown): boolean { return record(value)?.workspace_policy === 'isolated' }
export function sourceMount(workspace: unknown): { root: string | null; name: string | null } | null {
  const mount = record(workspace)?.source_mount
  if (mount == null) return null
  const obj = record(mount)
  // A malformed non-null mount is not permission to adopt. Show only the actual contract's fields.
  return { root: typeof obj?.root === 'string' ? obj.root : null, name: typeof obj?.name === 'string' ? obj.name : null }
}
export function protectsSource(workspace: unknown): boolean { return sourceMount(workspace) !== null }
export function adoptionBoundaryKnown(workspace: unknown): boolean { return record(workspace)?.source_mount === null }
export function isolationLine(interaction: unknown, workspace?: unknown): string | null {
  if (protectsSource(workspace ?? interaction)) return null
  if (!isolatedWorkspace(interaction)) return null
  if (adoptionBoundaryKnown(workspace)) return 'Separate copy from the starting checkpoint. Outputs remain separate until you choose a result.'
  return 'Each participant has a separate workspace. Read/write boundaries and output paths are shown in its stage details.'
}

/** A session's further folders (schema v29 roots): an absolute path each, read or write — the same for its file tools
 *  and its commands, carried to its child workspaces. Registering one never grants more than the access chosen. */
export type RootAccess = 'read' | 'write'
export interface SessionRoot { path: string; access: RootAccess }
const ROOT_ACCESS: readonly RootAccess[] = ['read', 'write']
const absolute = (path: string) => path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)

/** The roots an answer of the harness names: the list itself, `{roots}` (the session, GET/PUT …/roots) or
 *  `{session: {roots}}`; null when it names none. An entry that is no absolute path with read or write is left out. */
export function rootsOf(value: unknown): SessionRoot[] | null {
  const list = Array.isArray(value) ? value : Array.isArray(record(value)?.roots) ? record(value)!.roots : Array.isArray(record(record(value)?.session)?.roots) ? record(record(value)!.session)!.roots : null
  if (!Array.isArray(list)) return null
  return list.flatMap((x) => {
    const r = record(x)
    return r && typeof r.path === 'string' && absolute(r.path) && (ROOT_ACCESS as readonly unknown[]).includes(r.access) ? [{ path: r.path, access: r.access as RootAccess }] : []
  })
}

/** Whether the session's folders or its task as the harness answers them differ from what the page holds (another
 *  window, the director or the person elsewhere changed them): the page takes the harness's word. */
export function taskFieldsChanged(known: unknown, fresh: unknown): boolean {
  const key = (s: unknown) => JSON.stringify([rootsOf(s), record(s)?.task_root_id ?? null])
  return key(known) !== key(fresh)
}

