import { useEffect, useState } from 'react'
import { attachmentUrl } from '../state/attachments'
import { surfaceFrames, type SurfaceFrame } from '../state/desktop'
import { doingLine, pointerPlace, screenSteps, screenSurface, siteOf, watching } from '../state/screen'
import type { ThreadEntry } from '../state/thread'
import { ChevronLeftIcon, ChevronRightIcon, GlobeIcon } from './icons'

/** How long after one live picture the next is asked for (the capture's own time comes on top: a few a second). */
const FRAME_EVERY_MS = 120
const CLICKS = new Set(['click', 'double_click', 'right_click', 'drag'])

/** The live picture of a page of computer use, asked of the desktop app over and over while `surface` is named and
 *  the window shows; null in a plain browser, and before the first one comes. On the agent's browser the picture
 *  asked for is this run's own tab (`owner`), whatever tab the person shows on the Browser card; a picture asked for
 *  before the run (or the page) changed is dropped, never shown as the new one's. */
export function useSurfaceFrame(surface: 'browser' | 'chatgpt' | null, owner: string): SurfaceFrame | null {
  const [got, setGot] = useState<{ key: string; frame: SurfaceFrame | null } | null>(null)
  const key = `${surface ?? ''} ${owner}`
  useEffect(() => {
    const read = surfaceFrames(window as { oasisCodeDesktop?: unknown })
    if (!surface || !read) { setGot(null); return }
    let alive = true
    let timer = 0
    const tick = async () => {
      if (document.visibilityState === 'visible') {
        try {
          const next = await (surface === 'browser' ? read(surface, owner) : read(surface))
          if (alive) setGot({ key, frame: next })
        } catch { /* the shell is restarting: the next one */ }
      }
      if (alive) timer = window.setTimeout(() => void tick(), FRAME_EVERY_MS)
    }
    void tick()
    return () => { alive = false; window.clearTimeout(timer) }
  }, [surface, owner, key])
  return got && got.key === key ? got.frame : null
}

/** A run's computer use as a window in the thread. While the run works on the page (in the desktop app) it shows the
 *  page as it is now — a few pictures a second — with the agent's pointer where it went and what it is doing; else
 *  the looks the run kept, the latest first, stepped through with the arrows. */
export function ComputerScreen({ runId, sessionId, entries, live }: { runId: string; sessionId: string; entries: ThreadEntry[]; live: boolean }) {
  const surface = screenSurface(entries)
  const steps = screenSteps(entries)
  const frame = useSurfaceFrame(live ? surface : null, runId)
  const [chosen, setChosen] = useState<number | null>(null)
  if (!surface) return null
  if (watching(frame, runId)) {
    const at = pointerPlace(frame.pointer, frame.viewport)
    return (
      <figure className="screen is-live" data-testid="computer-screen" data-live="yes">
        <ScreenBar url={frame.url ?? ''} title={frame.title ?? ''}><span className="screen-live" data-testid="screen-live"><i />Live</span></ScreenBar>
        <div className="screen-view">
          <img src={`data:${frame.image.media_type};base64,${frame.image.data_base64}`} width={frame.image.width} height={frame.image.height} alt="the page the agent is working on, as it is now" draggable={false} />
          {at && frame.pointer && (
            <span className="screen-pointer" style={{ left: `${at.left}%`, top: `${at.top}%` }} data-testid="screen-pointer">
              {CLICKS.has(frame.pointer.action) && <i key={frame.pointer.at} className="screen-ripple" />}
              <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden><path d="M2 1.5v11l3-2.6 1.9 4.4 2.3-1-1.9-4.3h4z" /></svg>
            </span>
          )}
        </div>
        <figcaption className="screen-caption" data-testid="screen-caption">{doingLine(frame.doing)}</figcaption>
      </figure>
    )
  }
  if (!steps.length) return null
  const index = Math.min(chosen ?? steps.length - 1, steps.length - 1)
  const step = steps[index]!
  const url = attachmentUrl(sessionId, step.assetId)
  return (
    <figure className="screen" data-testid="computer-screen" data-live="no">
      <ScreenBar url={step.url} title={step.title}>
        {steps.length > 1 && (
          <span className="screen-steps" data-testid="screen-steps">
            <button type="button" className="icon-btn" aria-label="The look before" title="The look before" disabled={index === 0} onClick={() => setChosen(index - 1)}><ChevronLeftIcon size={12} /></button>
            <span>{index + 1} / {steps.length}</span>
            {/* the latest look is followed again (a run still working adds to them) */}
            <button type="button" className="icon-btn" aria-label="The look after" title="The look after" disabled={index === steps.length - 1} onClick={() => setChosen(index + 1 === steps.length - 1 ? null : index + 1)}><ChevronRightIcon size={12} /></button>
          </span>
        )}
      </ScreenBar>
      <a className="screen-view" href={url} target="_blank" rel="noreferrer" title="Open the picture whole">
        <img src={url} alt="the page as the agent saw it" loading="lazy" draggable={false} />
      </a>
      <figcaption className="screen-caption" data-testid="screen-caption">{step.line}</figcaption>
    </figure>
  )
}

/** The window's bar: the page's site and title, and what the caller puts at its end (Live, or the steps). */
function ScreenBar({ url, title, children }: { url: string; title: string; children?: React.ReactNode }) {
  return (
    <div className="screen-bar" title={url}>
      <GlobeIcon size={12} />
      <span className="screen-site">{url ? siteOf(url) : 'page'}</span>
      {title && <span className="screen-title">{title}</span>}
      <span className="screen-end">{children}</span>
    </div>
  )
}
