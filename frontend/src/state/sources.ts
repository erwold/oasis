/** The pages a run used (adapted from oasis state/sources.ts, see NOTICE): fetched through fetch_url (the run's own
 *  activity rows say how each fetch went) or only cited in the agent's words. Pure, so node --test exercises it. */

import type { ThreadEntry } from './thread.ts'

export interface WebSource {
  url: string
  host: string
  label: string
  status: 'stored' | 'quarantined' | 'blocked' | 'http_error' | 'error' | 'cancelled' | 'refused' | 'cited'
  purpose: string | null
  assetId: string | null
}

export const STATUS_WORDS: Record<WebSource['status'], string> = {
  stored: 'fetched', quarantined: 'quarantined', blocked: 'bot check', http_error: 'HTTP error', error: 'unreachable', cancelled: 'stopped', refused: 'refused', cited: 'cited',
}

export function hostOf(url: string): string {
  try { return new URL(url).host } catch { return url }
}

/** A host as a person names the site: no `www.`, no port. */
export function siteOf(host: string): string {
  return host.replace(/:\d+$/, '').replace(/^www\d*\./, '')
}

/** A site's mark: its first letter and a hue drawn from its name — a steady colour per site with no icon fetched. */
export function markOf(host: string): { letter: string; hue: number } {
  const site = siteOf(host)
  let hash = 0
  for (const ch of site) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0
  return { letter: (/[\p{L}\p{N}]/u.exec(site)?.[0] ?? '?').toUpperCase(), hue: hash % 360 }
}

/** A short label for a URL: the last path segment (or the host for a bare site). */
export function pathLabel(url: string): string {
  try {
    const u = new URL(url)
    const segs = u.pathname.split('/').filter(Boolean)
    return segs.length ? decodeURIComponent(segs[segs.length - 1]) : u.host
  } catch { return url }
}

function normalize(url: string): string {
  try { const u = new URL(url); u.hash = ''; return u.toString().replace(/\/$/, '') } catch { return url }
}

const URL_RE = /https?:\/\/[^\s<>()[\]"'`]+[^\s<>()[\]"'`.,;:!?]/g

/** Every http(s) URL the text names, markdown links included, in order, once. */
export function citedUrls(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const m of text.matchAll(URL_RE)) {
    const key = normalize(m[0])
    if (seen.has(key)) continue
    seen.add(key); out.push(m[0])
  }
  return out
}

/** How a fetch went, in fetch_url's words (`ok`, `blocked`, `http_error`, `quarantined`, `unreachable`, `cancelled`, a
 *  refusal; `stored` and `blocked_by_bot_check` from earlier records). A word this page does not know claims no
 *  failure: a response was saved or the fetch is said to have failed only by the words that say so. */
function statusOf(status: string, saved: boolean): WebSource['status'] {
  if (status === 'ok' || status === 'stored') return 'stored'
  if (status === 'quarantined') return 'quarantined'
  if (status === 'blocked_by_bot_check' || status === 'blocked') return 'blocked'
  if (status === 'http_error') return 'http_error'
  if (status === 'cancelled') return 'cancelled'
  if (status.startsWith('refused') || status === 'unavailable') return 'refused'
  if (status === 'unreachable' || status === 'error') return 'error'
  return saved ? 'stored' : 'error'
}

const iconsByThreads = new WeakMap<Record<string, ThreadEntry[]>, Map<string, string>>()

/** The icons the harness kept of the sites the session's runs fetched, by site (`siteOf`): the icon asset each
 *  fetch_url row names. A site the runs only cited has none; its chip keeps its letter. */
export function siteIconsOf(threads: Record<string, ThreadEntry[]>): Map<string, string> {
  const cached = iconsByThreads.get(threads)
  if (cached) return cached
  const icons = new Map<string, string>()
  for (const entries of Object.values(threads)) for (const e of entries) {
    if (e.kind !== 'activity' || e.tool !== 'fetch_url' || e.running) continue
    const r = (e.result ?? {}) as Record<string, unknown>
    const url = String(r.url ?? (e.args as Record<string, unknown> | null)?.url ?? '')
    if (url && typeof r.icon_asset_id === 'string') icons.set(siteOf(hostOf(url)), r.icon_asset_id)
  }
  iconsByThreads.set(threads, icons)
  return icons
}

/** Where the icon of a site a link names is asked for: the harness fetches it from the site itself and keeps it
 *  (the session's own route; a site with none answers 404). */
export function siteIconByHostUrl(sessionId: string, host: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/site-icons/by-host/${encodeURIComponent(host.toLowerCase())}`
}

/** Where a kept site icon is read back from (the session's own route; the page's cookie authorizes it). */
export function siteIconUrl(sessionId: string, assetId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/site-icons/${encodeURIComponent(assetId)}`
}

/** The sources of one run: fetched pages first (from its fetch_url rows), then pages the agent only cited; once each. */
export function sourcesOf(entries: ThreadEntry[], text: string): WebSource[] {
  const byUrl = new Map<string, WebSource>()
  for (const e of entries) {
    if (e.kind !== 'activity' || e.tool !== 'fetch_url' || e.running) continue
    const r = (e.result ?? {}) as Record<string, unknown>
    const a = (e.args ?? {}) as Record<string, unknown>
    const url = String(r.url ?? a.url ?? '')
    if (!url) continue
    byUrl.set(normalize(url), { url, host: hostOf(url), label: pathLabel(url), status: statusOf(String(e.status ?? r.status ?? ''), !!r.asset_id),
      purpose: r.purpose ? String(r.purpose) : a.purpose ? String(a.purpose) : null, assetId: r.asset_id ? String(r.asset_id) : null })
  }
  for (const url of citedUrls(text)) {
    const key = normalize(url)
    if (!byUrl.has(key)) byUrl.set(key, { url, host: hostOf(url), label: pathLabel(url), status: 'cited', purpose: null, assetId: null })
  }
  return [...byUrl.values()]
}
