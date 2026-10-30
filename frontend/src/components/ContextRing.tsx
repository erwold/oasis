import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../api/client'
import type { ContextReport } from '../api/types'
import { useStore } from '../state/store'
import { contextGauge } from '../state/context'

const ROW_COLORS: Record<string, string> = { instructions: 'var(--accent)', tool_schemas: 'var(--orange)', history: 'var(--green)', free: 'transparent', buffer: 'var(--line-strong)' }
const RADIUS = 16.5
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

/** A send button inside a ring of how full its context window is; hovering it (or focusing inside it) shows the card. */
export function RingGauge({ share, level, card, onOpen, children }: {
  share: number | null; level: 'ok' | 'warm' | 'high'; card: ReactNode; onOpen?: () => void; children: ReactNode
}) {
  const [anchor, setAnchor] = useState<{ right: number; bottom: number } | null>(null)
  const ring = useRef<HTMLDivElement>(null)
  const closing = useRef<number | null>(null)
  useEffect(() => () => { if (closing.current !== null) window.clearTimeout(closing.current) }, [])
  const show = () => {
    if (closing.current !== null) { window.clearTimeout(closing.current); closing.current = null }
    const rect = ring.current?.getBoundingClientRect()
    if (!anchor && rect) { setAnchor({ right: window.innerWidth - rect.right, bottom: window.innerHeight - rect.top + 8 }); onOpen?.() }
  }
  // a short grace lets the pointer cross the gap between the button and the card
  const hide = () => { if (closing.current === null) closing.current = window.setTimeout(() => { closing.current = null; setAnchor(null) }, 150) }
  return (
    <div ref={ring} className="context-ring" data-testid="context-ring" data-level={level} data-share={share ?? undefined}
         onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>
      <svg className="context-ring-svg" viewBox="0 0 36 36" aria-hidden="true">
        <circle className="context-ring-track" cx="18" cy="18" r={RADIUS} />
        {share != null && <circle className="context-ring-fill" cx="18" cy="18" r={RADIUS} strokeDasharray={`${Math.max(share * CIRCUMFERENCE, 1)} ${CIRCUMFERENCE}`} />}
      </svg>
      {children}
      {/* the card is portalled: the composer sits under the desk's floating cards */}
      {anchor && createPortal(<div className="context-card-anchor" style={anchor} onMouseEnter={show} onMouseLeave={hide}>{card}</div>, document.body)}
    </div>
  )
}

/** The thread composer's ring: the next request's size against the window; its card shows the segments, the room
 *  left before compaction and the last run's prompt cache. */
export function ContextRing({ children }: { children: ReactNode }) {
  const sessionId = useStore((s) => s.session?.id)
  const model = useStore((s) => s.modelChoice ?? s.session?.model ?? null)
  const liveRunId = useStore((s) => s.liveRunId)
  const [report, setReport] = useState<ContextReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [opened, setOpened] = useState(0)

  useEffect(() => {
    if (!sessionId) return
    let alive = true
    api.context(sessionId, model).then((r) => { if (alive) { setReport(r); setError(null) } }, (e) => { if (alive) setError(String(e)) })
    return () => { alive = false }
  }, [sessionId, model, liveRunId, opened])

  const gauge = report ? contextGauge(report) : null
  const cache = report?.last_run?.cache.hit_rate
  const card = (
    <div className="context-card" data-testid="context-panel" data-loading={report ? undefined : ''} role="tooltip">
      <div className="context-head">
        <strong>Context window</strong>
        <span className="context-meta">{gauge ? gauge.headline : error ?? 'measuring…'}</span>
      </div>
      {gauge && report && (
        <>
          <div className="context-bar" title={report.estimate_basis}>
            {gauge.rows.filter((r) => r.share != null && r.key !== 'free').map((r) => (
              <span key={r.key} className="context-bar-seg" style={{ width: `${Math.max((r.share ?? 0) * 100, 0.5)}%`, background: ROW_COLORS[r.key] ?? 'var(--ink-3)', marginLeft: r.key === 'buffer' ? 'auto' : undefined }} />
            ))}
          </div>
          <div className="context-rows">
            {gauge.rows.map((r) => (
              <div key={r.key} className="context-row" title={r.detail} data-testid={`context-${r.key}`}>
                <span className={`context-swatch${r.key === 'free' ? ' dashed' : ''}`} style={{ background: ROW_COLORS[r.key] ?? 'var(--ink-3)' }} />
                <span className="context-label">{r.label}</span>
                <span className="context-num">{r.size}</span>
                <span className="context-num">{r.share != null ? `${(r.share * 100).toFixed(1)}%` : '—'}</span>
              </div>
            ))}
          </div>
          {cache != null && <p className="context-note" data-testid="context-cache" title={report.last_run?.cache.note}>Prompt cache · {(cache * 100).toFixed(0)}% read on the last run</p>}
        </>
      )}
    </div>
  )
  return <RingGauge share={gauge?.share ?? null} level={gauge?.level ?? 'ok'} card={card} onOpen={() => setOpened((n) => n + 1)}>{children}</RingGauge>
}
