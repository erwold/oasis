/** Per-browser folder disclosure. Keep ids even while projects are not loaded or temporarily absent. */
export const COLLAPSED_PROJECTS_KEY = 'oasis-code.collapsedProjects.v1'
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

export function readCollapsedProjects(storage: StorageLike | null): ReadonlySet<string> {
  try {
    const saved: unknown = JSON.parse(storage?.getItem(COLLAPSED_PROJECTS_KEY) ?? '[]')
    if (Array.isArray(saved)) return new Set(saved.filter((id): id is string => typeof id === 'string' && id.length > 0))
  } catch { /* unavailable or invalid storage: folders start expanded */ }
  return new Set()
}

export function writeCollapsedProjects(storage: StorageLike | null, collapsed: ReadonlySet<string>): void {
  try { storage?.setItem(COLLAPSED_PROJECTS_KEY, JSON.stringify([...collapsed])) } catch { /* keep the in-memory choice */ }
}
