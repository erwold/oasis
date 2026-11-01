/** CPU-only worker: no DB, AppState, filesystem history reads or runner initialization. Set the handler before
 * announcing ready; only one job is posted at a time by the bounded client. Never return raw error/history text. */
import { computeContextReport, type ContextReportInput } from './context_report_compute.ts'

declare const self: Worker

self.onmessage = (event: MessageEvent<{ id: number; input: ContextReportInput }>) => {
  const { id, input } = event.data
  try {
    self.postMessage({ type: 'reply', id, ok: true, result: computeContextReport(input) })
  } catch {
    self.postMessage({ type: 'reply', id, ok: false })
  }
}
self.postMessage({ type: 'ready' })
