import type { ThreadEntry } from '../state/thread'
import { LayersIcon } from './icons'

/** A summary's one line, outside tool folds. An ended run (even a truncated replay) never keeps a spinner. */
export function CompactionRow({ entry, live }: { entry: ThreadEntry; live: boolean }) {
  const running = live && entry.running === true
  const interrupted = !live && entry.running === true
  return <div className="activity-line compaction-row" data-testid="context-compaction" data-status={interrupted ? 'interrupted' : entry.status}
              role="status" aria-live="polite" aria-atomic="true">
    {running ? <span className="compaction-spinner" aria-hidden="true" /> : <LayersIcon size={12} />}
    <span>{interrupted ? 'Context compaction interrupted' : entry.text}</span>
  </div>
}
