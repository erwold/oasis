import type { Run } from '../api/types'
import type { ThreadEntry } from './thread'

/** A scheduling hint, never a content limit. Small prose/simple ended-work transcripts need no empty-shell/deferred round.
 * A single enormous turn, complex tools, images, math and boards still take the interruptible route. Bound the inspection
 * too: do not stringify tool results or walk a large transcript just to choose how to render it. */
export function inexpensiveTranscript(runs: Run[], threads: Record<string, ThreadEntry[]>, plain: boolean): boolean {
  if (!plain || runs.length > 4) return false
  let chars = 0, entries = 0
  for (const run of runs) {
    chars += run.user_text.length + (run.error?.length ?? 0)
    if (chars > 8000 || run.attachments?.length || /[!$]|\|.*\|/.test(run.user_text)) return false
    const rows = threads[run.id] ?? []
    entries += rows.length
    if (entries > 16) return false
    for (const row of rows) {
      if (row.kind === 'input') {
        const input = row.input
        const harness = (input?.request as { harness?: unknown } | undefined)?.harness
        // Answered harness access asks render as two plain spans, not NativeNode/forms. Do not generalize this
        // to arbitrary closed forms: those retain every field, table and image. Bound even validation work.
        if (!input || input.status === 'pending' || (harness !== 'full_access' && harness !== 'remote_full_access')) return false
        const size = smallRecordSize(input)
        if (size === null || (chars += size) > 8000) return false
        continue
      }
      if (!['agent', 'user', 'note', 'error', 'system', 'thinking', 'activity'].includes(row.kind) || row.running) return false
      if (row.kind === 'activity') {
        // A few scalar fields only. Reject arrays/nested records (pictures, surfaces, rich results) without walking
        // them; check string length before any scan. This is a scheduling estimate, not a rendering restriction.
        let fields = 0
        for (const record of [row.args, row.result]) if (record) {
          for (const key in record) {
            if (++fields > 16) return false
            const value = record[key]
            if (value !== null && typeof value === 'object') return false
            if (typeof value === 'string') chars += value.length
            if (chars > 8000) return false
          }
        }
        chars += (row.summary?.length ?? 0)
      }
      const text = row.text ?? ''
      chars += text.length
      if (chars > 8000 || /[!$]|\|.*\|/.test(text)) return false
    }
    if (chars > 8000) return false
  }
  return true
}

/** Inspect at most 64 values, 8 levels and 2Ki characters; no stringify of an unbounded record. */
function smallRecordSize(value: unknown): number | null {
  let nodes = 0, chars = 0
  const visit = (value: unknown, depth: number): boolean => {
    if (++nodes > 64 || depth > 8) return false
    if (typeof value === 'string') { chars += value.length; return chars <= 2048 }
    if (value && typeof value === 'object') {
      for (const key in value) {
        chars += key.length
        if (chars > 2048 || !visit((value as Record<string, unknown>)[key], depth + 1)) return false
      }
    }
    return true
  }
  return visit(value, 0) ? chars : null
}
