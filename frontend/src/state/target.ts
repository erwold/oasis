/** Pure persisted execution identity. Never infer a host from a path. */
export type TargetRef = { kind: 'local' } | { kind: 'ssh'; target_id: string }
export type ExecutionTarget = TargetRef | { kind: 'unknown' }
const object = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null
export function parseTarget(x: unknown): ExecutionTarget {
  if (object(x) && x.kind === 'local') return { kind: 'local' }
  if (object(x) && x.kind === 'ssh' && typeof x.target_id === 'string' && x.target_id) return { kind: 'ssh', target_id: x.target_id }
  return { kind: 'unknown' }
}
/** Missing on an old local record is local; an explicit malformed target is never local. */
export function resourceTarget(x: unknown): ExecutionTarget {
  if (!object(x)) return { kind: 'local' }
  if ('target' in x && x.target !== undefined) {
    const target = parseTarget(x.target)
    if (object(x.remote) && targetKey(target) !== targetKey(parseTarget({ kind: 'ssh', target_id: x.remote.target_id }))) return { kind: 'unknown' }
    return target
  }
  if (object(x.remote)) return parseTarget({ kind: 'ssh', target_id: x.remote.target_id })
  return { kind: 'local' }
}
export function targetKey(t: ExecutionTarget): string { return t.kind === 'ssh' ? `ssh:${t.target_id}` : t.kind }
export function sessionTarget(session: unknown, projects: readonly unknown[] = []): ExecutionTarget {
  if (!object(session)) return { kind: 'local' }
  const workspace = object(session.workspace) ? session.workspace : null
  const project = projects.find((p) => object(p) && p.id === session.project_id)
  const explicit = [session, workspace, project].filter((r) => object(r) && (r.target !== undefined || object(r.remote)))
  if (!explicit.length) return { kind: 'local' }
  const targets = explicit.map(resourceTarget)
  return targets.some((t) => targetKey(t) !== targetKey(targets[0]!)) ? { kind: 'unknown' } : targets[0]!
}

/** Resolve a chosen project against the current list, but never replace its captured identity. */
export function taskTarget(chosen: unknown, projects: readonly unknown[] = []): ExecutionTarget {
  if (!object(chosen) || chosen.kind !== 'project') return resourceTarget(chosen)
  const project = projects.find((p) => object(p) && p.id === chosen.projectId)
  if (!project) return resourceTarget(chosen)
  const resolved = resourceTarget(project)
  return chosen.target !== undefined && targetKey(resourceTarget(chosen)) !== targetKey(resolved) ? { kind: 'unknown' } : resolved
}
