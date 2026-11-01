/** Offline share sampling happens before its SQLite projection. Reads use the live surface's existing authority;
 * the pure streaming parser is shared with the UI, with no curve columns/history retained. No model or command. */
import { parseUiSurfaceSpec, uiChartSources, uiSurfaceUpdatedBy, type UiTaskExecution } from '@oasis-code/contract'
import { crc32, SourceParser, type TaskProgress } from '@oasis-code/contract/ui-chart-source'
import type { AppState } from '../api/state.ts'
import * as repo from '../db/repo.ts'
import { readChartSourcePage } from '../agent/ui_chart_sources.ts'
import { isAbsolute, join } from 'node:path'
import { UiError } from '../agent/ui_surfaces.ts'
import { copyRelativePath } from './path_alias.ts'
import { sensitivePath } from './sensitive.ts'

export interface ProgressSample {
  session_id: string; run_id: string; writer_id: string; surface_id: string; revision: number
  element_id: string
  execution_id?: string
  title: string; at: string; progress: TaskProgress; execution?: UiTaskExecution
  availability: 'complete' | 'partial' | 'unavailable' | 'not_sampled'
}
export type ProgressSamples = ReadonlyMap<string, readonly ProgressSample[]>
/** Global per-export budget, not per file. An incomplete prefix is labelled partial, never claimed current. */
export async function sampleShareProgress(state: AppState, sessionIds: readonly string[], excluded: readonly string[]): Promise<ProgressSamples> {
  const samples = new Map<string, ProgressSample[]>()
  const skip = new Set(excluded)
  let remaining = 8 * 1024 * 1024, count = 0
  const deadline = Date.now() + 10_000
  for (const sid of sessionIds) for (const surface of repo.listUiSurfaces(state.conn, sid)) {
    const writer = uiSurfaceUpdatedBy(surface)
    if (skip.has(surface.run_id) || skip.has(writer)) continue
    const spec = parseUiSurfaceSpec(surface.spec)
    if (!spec.ok) continue
    for (const { id, source } of uiChartSources(spec.value)) {
      if (!source.progress) continue
      count += 1
      const parser = new SourceParser({ ...source, series: [] }, 'number')
      const sample: ProgressSample = { session_id: sid, run_id: surface.run_id, writer_id: writer, surface_id: surface.surface_id, revision: surface.revision,
        element_id: id, execution_id: source.progress.execution_id, title: spec.value.title, at: new Date().toISOString(), progress: parser.points.progress, availability: count > 20 || remaining <= 0 || Date.now() >= deadline ? 'not_sampled' : 'partial' }
      let offset = 0, file: string | null = null, crc = 0
      try {
        while (count <= 20 && remaining > 0 && Date.now() < deadline) {
          const page = await readChartSourcePage(state, sid, surface.run_id, surface.surface_id, id, { revision: surface.revision, offset, limit: Math.min(1024 * 1024, remaining), verify: '1' }, (path, ws) => {
            const absolute = isAbsolute(path) ? path : join(ws.path, path)
            const relative = ws.kind !== 'direct' && ws.target?.kind !== 'ssh'
              ? copyRelativePath({ cwd: absolute, root: ws.path, id: ws.id, workspacesDir: state.settings.workspaces_dir, dataRoots: [state.settings.data_dir] }) : null
            if (sensitivePath(relative ?? absolute, [state.settings.data_dir])) throw new UiError(403, 'refused', 'share source withheld')
          })
          sample.execution = page.execution
          if (page.status !== 'ok') { sample.availability = 'unavailable'; break }
          if ((file !== null && page.file_id !== file) || page.offset !== offset || page.crc !== crc) {
            sample.progress = { logs: [] }; sample.availability = 'unavailable'; break
          }
          file = page.file_id
          const bytes = Buffer.from(page.data, 'base64')
          parser.feed(bytes); crc = crc32(bytes, crc)
          remaining -= bytes.length; offset = page.next_offset
          if (page.eof) { sample.availability = 'complete'; break }
          if (!bytes.length) break
        }
      } catch { sample.availability = 'unavailable'; sample.progress = { logs: [] } }
      sample.at = new Date().toISOString()
      const list = samples.get(writer) ?? []; list.push(sample); samples.set(writer, list)
    }
  }
  return samples
}
