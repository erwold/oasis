/** What a run's measured changes may claim as its own, kept on the run's manifest (`background_attribution`) from the
 *  moment it is let into its folder — before any model request or tool — and only ever widened afterwards:
 *
 *  - overlapped: the run was let in beside commands an earlier run of its conversation left running (their ids). No
 *    baseline the run's changes could be measured against exists then: in a snapshot workspace nothing is claimed as
 *    the run's (attribution unavailable, no automatic checkpoint); in a folder edited in place its tool journal is
 *    shown as partial and its whole-run Undo is refused — even after those commands exit (a write of identical bytes,
 *    or one undone before it was seen, cannot be detected afterwards).
 *  - base_tree_sha: a snapshot workspace, let in alone: the tree it started from, taken then (never the workspace's
 *    integration base or an older checkpoint), and the workspace checkpoint (run_id null) that pinned what was already
 *    there when it differed from the latest checkpoint — so a later checkpoint of the run shows only the run's change.
 *  - unavailable_reason: the run ended leaving its own writers running (its final tree is not settled), or its
 *    baseline could not be taken.
 *
 *  The marker survives the commands' exits, a restart and a lost run's receipt; it never narrows. */

import type { Conn } from '../db/database.ts'
import * as repo from '../db/repo.ts'

export const ATTRIBUTION_KEY = 'background_attribution'

export interface AttributionMarker {
  version: 1
  overlapped: boolean
  background_execution_ids: string[]
  inherited_from_run_ids: string[]
  base_tree_sha: string | null
  baseline_checkpoint_id: string | null
  unavailable_reason: string | null
}

export function emptyMarker(): AttributionMarker {
  return { version: 1, overlapped: false, background_execution_ids: [], inherited_from_run_ids: [], base_tree_sha: null, baseline_checkpoint_id: null, unavailable_reason: null }
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

/** The marker a manifest holds, or null (a run from before it was kept, or one never let into a folder). */
export function markerOf(manifest: Record<string, unknown> | null | undefined): AttributionMarker | null {
  const raw = manifest?.[ATTRIBUTION_KEY]
  if (!raw || typeof raw !== 'object') return null
  const m = raw as Record<string, unknown>
  return {
    version: 1, overlapped: m.overlapped === true, background_execution_ids: strings(m.background_execution_ids), inherited_from_run_ids: strings(m.inherited_from_run_ids),
    base_tree_sha: typeof m.base_tree_sha === 'string' ? m.base_tree_sha : null, baseline_checkpoint_id: typeof m.baseline_checkpoint_id === 'string' ? m.baseline_checkpoint_id : null,
    unavailable_reason: typeof m.unavailable_reason === 'string' ? m.unavailable_reason : null,
  }
}

/** `a` widened by `b`: overlap and unavailability stay once set, ids are joined, a baseline is kept once taken and
 *  dropped for good once the run overlapped. */
export function widen(a: AttributionMarker, b: Partial<AttributionMarker>): AttributionMarker {
  const overlapped = a.overlapped || b.overlapped === true
  const union = (x: string[], y: string[] | undefined) => [...new Set([...x, ...(y ?? [])])]
  return {
    version: 1, overlapped,
    background_execution_ids: union(a.background_execution_ids, b.background_execution_ids),
    inherited_from_run_ids: union(a.inherited_from_run_ids, b.inherited_from_run_ids),
    base_tree_sha: overlapped ? null : (a.base_tree_sha ?? b.base_tree_sha ?? null),
    baseline_checkpoint_id: a.baseline_checkpoint_id ?? b.baseline_checkpoint_id ?? null,
    unavailable_reason: a.unavailable_reason ?? b.unavailable_reason ?? (overlapped ? 'overlapped_background_writers' : null),
  }
}

/** Widen the run's stored marker (read from its row, written back) and answer it. */
export function recordMarker(conn: Conn, runId: string, patch: Partial<AttributionMarker>): AttributionMarker {
  const row = repo.getRun(conn, runId)
  const manifest = row?.manifest ?? {}
  const next = widen(markerOf(manifest) ?? emptyMarker(), patch)
  repo.setRunManifest(conn, runId, { ...manifest, [ATTRIBUTION_KEY]: next })
  return next
}

/** A snapshot workspace's run has no attribution of its own: it overlapped, or its end (or start) was not settled. */
export function snapshotUnavailable(m: AttributionMarker | null): boolean {
  return m !== null && (m.overlapped || m.unavailable_reason !== null)
}
