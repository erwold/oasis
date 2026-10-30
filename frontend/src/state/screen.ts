/** Computer use as a person watches it in the thread: the looks a run kept (its screenshots, stepped through once
 *  the run is over), which page the live view follows while it runs, where the agent's pointer stands on the picture
 *  and what it is doing in a few words. Pure, so node --test exercises it. */

import type { SurfaceFrame } from './desktop'

type Rec = Record<string, unknown>
interface Entry { kind: string; tool?: string; args?: Rec | null; result?: Rec; toolCallId?: string; eventId?: number | string }

const COMPUTER_TOOLS = new Set(['computer_observe', 'computer_act'])
const isComputer = (e: Entry): boolean => e.kind === 'activity' && !!e.tool && COMPUTER_TOOLS.has(e.tool)
const text = (v: unknown): string => (typeof v === 'string' ? v : '')

/** A computer-use row: what was done on which page, and where it landed (a stored record has no summary line). */
export function computerLine(a: Rec, r: Rec): string {
  if (typeof r.summary === 'string' && r.summary) return r.summary
  const target = [a.ref, a.url, a.keys].find((v) => typeof v === 'string' && v)
  const what = typeof a.action === 'string' ? `${a.action}${target ? ` ${String(target)}` : ''} on` : a.read_text ? 'read' : 'look at'
  const page = typeof r.title === 'string' && r.title ? r.title : typeof r.url === 'string' ? r.url : ''
  return `${what} ${String(r.surface ?? a.surface ?? 'browser')}${page ? ` · ${page}` : ''}${r.status && r.status !== 'ok' ? ` · ${String(r.status)}` : ''}`
}

/** One look a run kept: the picture (an image of the session), the page it shows and the row's line. */
export interface ScreenStep { key: string; assetId: string; surface: string; url: string; title: string; line: string }

/** The thread's sharp copy of a capture, with the original screenshot as the fallback for older records. */
export function screenshotAssetId(result: Rec): string | null {
  return text(result.screenshot_display_asset_id) || text(result.screenshot_asset_id) || null
}

/** The looks of a run's computer use that kept a picture, in order. */
export function screenSteps(entries: Entry[]): ScreenStep[] {
  return entries.flatMap((e, i) => {
    const r = e.result ?? {}
    const a = e.args ?? {}
    const assetId = screenshotAssetId(r)
    if (!isComputer(e) || !assetId) return []
    return [{ key: String(e.toolCallId ?? e.eventId ?? i), assetId, surface: text(r.surface) || text(a.surface) || 'browser', url: text(r.url), title: text(r.title), line: computerLine(a, r) }]
  })
}

/** The page a run's computer use is on: the surface of its latest call (null: the run used none). */
export function screenSurface(entries: Entry[]): 'browser' | 'chatgpt' | null {
  const last = entries.findLast(isComputer)
  if (!last) return null
  return (text(last.result?.surface) || text(last.args?.surface)) === 'chatgpt' ? 'chatgpt' : 'browser'
}

/** Whether a frame is the live picture of this (running) run's work: the page drew, and the run holds it — or nobody
 *  does and this run held it last: between two actions far apart (a model slow to answer) the run's quiet lease runs
 *  out, and the page is still the one it works on. A page another run (of this session or another) or the bridge
 *  holds, or held last, is not this run's. */
export function watching(frame: SurfaceFrame | null, runId: string): frame is SurfaceFrame & { image: NonNullable<SurfaceFrame['image']> } {
  if (!frame || !frame.image) return false
  return frame.holder === null ? frame.last?.owner === runId : frame.holder === runId
}

/** Where the agent's pointer stands on the picture, in percent of its width and height (the pointer is kept in the
 *  page's own pixels); null when there is none, the page has no size or the point is outside what shows. */
export function pointerPlace(pointer: SurfaceFrame['pointer'], viewport: SurfaceFrame['viewport']): { left: number; top: number } | null {
  if (!pointer || !viewport || viewport.width < 1 || viewport.height < 1) return null
  const left = (pointer.x / viewport.width) * 100
  const top = (pointer.y / viewport.height) * 100
  return left < 0 || left > 100 || top < 0 || top > 100 ? null : { left, top }
}

/** What the agent is doing on the page now, in a few words (between two actions the model is deciding the next). */
export function doingLine(doing: SurfaceFrame['doing']): string {
  if (!doing) return 'the page now · the agent decides its next step'
  return `${doing.action.replace(/_/g, ' ')}${doing.target ? ` ${doing.target}` : ''}`
}

/** The site of an address, for the view's bar (the address itself when it has none). */
export function siteOf(url: string): string {
  try { return new URL(url).host || url } catch { return url }
}
