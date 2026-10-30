import { useEffect, useState } from 'react'
import { api } from '../api/client'
import type { WorkspaceDetail } from '../api/types'

/** Read actual workspace metadata before offering Keep. Shared requests avoid duplicate lookups in the same
 * render; nothing caches a permission decision indefinitely, and adoption reads the workspace again. */
const reading = new Map<string, Promise<WorkspaceDetail>>()
function readWorkspace(id: string): Promise<WorkspaceDetail> {
  const pending = reading.get(id)
  if (pending) return pending
  const request = api.workspace(id).finally(() => { if (reading.get(id) === request) reading.delete(id) })
  reading.set(id, request)
  return request
}
export function useInteractionWorkspace(id: string | null | undefined) {
  const [result, setResult] = useState<{ id: string; workspace: WorkspaceDetail | null; error: string | null } | null>(null)
  useEffect(() => {
    if (!id) return
    let alive = true
    void readWorkspace(id).then((workspace) => { if (alive) setResult({ id, workspace, error: null }) },
      (e) => { if (alive) setResult({ id, workspace: null, error: e instanceof Error ? e.message : String(e) }) })
    return () => { alive = false }
  }, [id])
  return result && result.id === id ? result : { workspace: null, error: null }
}
