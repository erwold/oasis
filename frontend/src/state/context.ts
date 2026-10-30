/** Pure helpers for the context ring and its card (node --test exercises them). */

import type { ContextReport } from '../api/types'

/** "950", "1.2k", "166.5k", "1.0M" — how the owner reads token counts. */
export function tokensText(n: number | null | undefined): string {
  if (n == null) return '—'
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

export interface ContextRow { key: string; label: string; detail: string; size: string; share: number | null }

/** What the send button's ring and its card show: the keeper's prediction for the next request against the window,
 *  each segment's part of it, the room left before compaction and the room the compaction keeps (the two room rows
 *  need a window; without one the shares are of the request). */
export interface ContextGauge {
  used: number; window: number | null; budget: number
  /** used / window for the ring, 0..1; null when the window is unknown */
  share: number | null
  level: 'ok' | 'warm' | 'high'
  headline: string
  rows: ContextRow[]
}

/** ok below 70 % of the compaction threshold, warm from there, high from 90 %. */
export function gaugeLevel(used: number | null, threshold: number | null): 'ok' | 'warm' | 'high' {
  const toThreshold = used != null && threshold ? used / threshold : 0
  return toThreshold >= 0.9 ? 'high' : toThreshold >= 0.7 ? 'warm' : 'ok'
}

/** "474.0k / 1.0M (47%)" — tokens against the window, or what of the two is unknown. */
export function windowText(used: number | null, window: number | null, estimated = false): string {
  if (used == null) return 'tokens not reported'
  return `${estimated ? '≈' : ''}${tokensText(used)} / ${window ? `${tokensText(window)} (${Math.round(Math.min(1, used / window) * 100)}%)` : 'window unknown'}`
}

export function contextGauge(report: ContextReport): ContextGauge {
  const used = report.tokens_est
  const window = report.context_window
  const budget = report.budget_tokens
  const share = window ? Math.min(1, used / window) : null
  const rows: ContextRow[] = report.segments.map((seg) => {
    const label = seg.label.replace(/\s*\(.*\)\s*$/, '')
    return {
      key: seg.key, label: seg.count != null ? `${label} · ${seg.count}` : label, detail: [seg.label, seg.note].filter(Boolean).join(' — '),
      size: `≈${tokensText(seg.tokens_est)}`, share: window ? seg.tokens_est / window : used ? seg.tokens_est / used : null,
    }
  })
  if (window) {
    const free = Math.max(0, budget - used)
    const buffer = Math.max(0, window - budget)
    rows.push({ key: 'free', label: 'Free space', detail: `Room left before the conversation is compacted at ${tokensText(budget)}`, size: tokensText(free), share: free / window })
    rows.push({ key: 'buffer', label: 'Compaction buffer', detail: report.budget_note, size: tokensText(buffer), share: buffer / window })
  }
  return { used, window, budget, share, level: gaugeLevel(used, budget), headline: windowText(used, window, true), rows }
}
