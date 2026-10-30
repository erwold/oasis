/** The live link side of the share dialog (components/ShareDialog.tsx) and the sharing card in Settings
 *  (components/LiveShareSettings.tsx), pure: the expiry choices and their bounds, the create request, what a link's
 *  options and state say in a line, what the listener's status says, and which runs the dialog offers to leave out.
 *  Every bound and shape is the contract's (contract/src/live_share.ts). */

import {
  LIVE_SHARE_LIMITS, SHARE_LIMITS,
  type LiveShareSettings, type LiveShareStatus, type ShareLink, type ShareLinkCreateRequest,
} from '@oasis-code/contract'
import type { Run } from '../api/types'

export interface ExpiryChoice { value: string; label: string; seconds: number | null }

/** The dialog's expiries: the convenient ones (one day the default, as the backend's), or a custom one. */
export const EXPIRY_CHOICES: readonly ExpiryChoice[] = [
  { value: '300', label: '5 minutes', seconds: 300 },
  { value: '3600', label: '1 hour', seconds: 3600 },
  { value: '86400', label: '1 day', seconds: 86400 },
  { value: '604800', label: '7 days', seconds: 604800 },
  { value: '2592000', label: '30 days', seconds: 2592000 },
  { value: 'custom', label: 'Custom…', seconds: null },
]
export const DEFAULT_EXPIRY = String(LIVE_SHARE_LIMITS.default_expiry_s)

export const EXPIRY_UNITS = { minutes: 60, hours: 3600, days: 86400 } as const
export type ExpiryUnit = keyof typeof EXPIRY_UNITS

/** A custom expiry in seconds, or null when it is no whole number inside the contract's bounds (5 minutes … 30 days). */
export function customExpiry(amount: number, unit: ExpiryUnit): number | null {
  if (!Number.isFinite(amount) || amount <= 0) return null
  const seconds = Math.round(amount * EXPIRY_UNITS[unit])
  return seconds >= LIVE_SHARE_LIMITS.min_expiry_s && seconds <= LIVE_SHARE_LIMITS.max_expiry_s ? seconds : null
}

/** The expiry chosen, in seconds, or null (a custom one out of bounds). */
export function expirySeconds(choice: string, amount: number, unit: ExpiryUnit): number | null {
  if (choice === 'custom') return customExpiry(amount, unit)
  const c = EXPIRY_CHOICES.find((e) => e.value === choice)
  return c?.seconds ?? null
}

export interface LiveLinkOptions { tools: boolean; images: boolean; excluded: readonly string[] }

/** The create request, canonical as the backend keeps it (ids sorted, without repeats). */
export function linkRequest(o: LiveLinkOptions, expiresInS: number, label = ''): ShareLinkCreateRequest {
  return {
    label: label.slice(0, LIVE_SHARE_LIMITS.max_label_chars),
    expires_in_s: expiresInS,
    include_tool_details: o.tools,
    include_images: o.images,
    exclude_run_ids: [...new Set(o.excluded)].sort().slice(0, SHARE_LIMITS.max_excluded_runs),
  }
}

/** A link's options in a few words (a task's link first says so, with how many of its sessions are there now). */
export function linkOptionsLine(link: ShareLink & { scope?: 'session' | 'task'; members?: number }): string {
  const parts: string[] = []
  if (link.scope === 'task') parts.push(`all sessions${link.members ? ` (${link.members})` : ''}`)
  if (link.options.include_tool_details) parts.push('tool details')
  if (link.options.include_images) parts.push('images')
  const n = link.options.exclude_run_ids.length
  if (n) parts.push(`${n} run${n > 1 ? 's' : ''} left out`)
  return parts.length ? parts.join(' · ') : 'text only'
}

/** How long a link has left (or that it ended), from `now`. */
export function linkTimeLine(link: ShareLink, now: number): string {
  if (link.state === 'revoked') return link.revoked_reason === 'session_deleted' ? 'session deleted' : 'revoked'
  const left = Date.parse(link.expires_at) - now
  if (link.state === 'expired' || !(left > 0)) return 'expired'
  const m = Math.round(left / 60_000)
  if (m < 60) return `${Math.max(1, m)} min left`
  const h = Math.round(m / 60)
  if (h < 48) return `${h} h left`
  return `${Math.round(h / 24)} days left`
}

export type ServiceKind = 'off' | 'listening' | 'error' | 'unbuilt' | 'starting'

/** What the listener is doing, in a word and a short line. */
export function serviceState(settings: LiveShareSettings, status: LiveShareStatus): { kind: ServiceKind; line: string } {
  if (!settings.enabled) return { kind: 'off', line: 'Off' }
  if (status.error) return { kind: 'error', line: status.error }
  if (!status.viewer_built) return { kind: 'unbuilt', line: 'Viewer page not built' }
  if (status.listening) return { kind: 'listening', line: `On · ${status.address ?? `port ${settings.port}`}${status.viewers ? ` · ${status.viewers} viewing` : ''}` }
  return { kind: 'starting', line: 'Starting…' }
}

/** A public base URL as the backend takes it: an http(s) origin, no path, query, fragment or user info — or null when
 *  empty. Returns undefined when the text is no such origin (the card says so before saving). */
export function publicBaseUrl(text: string): string | null | undefined {
  const t = text.trim()
  if (!t) return null
  let u: URL
  try { u = new URL(t) } catch { return undefined }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) return undefined
  if (/[?#]/.test(t.replace(/\/$/, '').slice(u.origin.length))) return undefined
  return u.origin
}

export interface LiveRunChoice { run_id: string; label: string; status: Run['status'] }

/** The runs the dialog offers to leave out of a live link: the session's own (never an action's run), labelled by
 *  their label, else their words' first line. */
export function liveRunChoices(runs: readonly Run[], sessionId: string): LiveRunChoice[] {
  return runs.filter((r) => r.session_id === sessionId && r.spawned_by !== 'human_action').map((r) => ({
    run_id: r.id,
    label: r.label?.trim() || r.user_text.split('\n').find((l) => l.trim())?.trim().slice(0, 80) || r.model,
    status: r.status,
  }))
}

/** A link's URL can be copied: the backend named one (an origin is known). */
export function copyableUrl(url: string | null): url is string {
  return typeof url === 'string' && url.length > 0
}

/** A refused request of the live share's owner routes, in the person's words: the harness's own code when it names
 *  one, its status otherwise — never a generic failure when the reason is known. */
export function liveShareError(e: unknown, notFound = 'This session no longer exists.'): string {
  const status = typeof (e as { status?: unknown })?.status === 'number' ? (e as { status: number }).status : null
  const body = (e as { body?: Record<string, unknown> | null })?.body ?? null
  const code = typeof body?.code === 'string' ? body.code : typeof body?.error === 'string' ? body.error : null
  if (code === 'share_link_limit') return `This session already has ${LIVE_SHARE_LIMITS.max_active_links_per_session} active links. Revoke one first.`
  if (code === 'share_link_inactive') return 'This link is no longer active.'
  if (code === 'share_owner_only') return 'Links can only be managed from the app itself.'
  if (status === 404) return notFound
  if (status === 422) return typeof (e as { detail?: unknown }).detail === 'string' && (e as { detail: string }).detail ? `Not accepted: ${(e as { detail: string }).detail}` : 'Not accepted by the app.'
  if (status !== null) return `The app refused (${status}).`
  if (e instanceof Error && e.name === 'ZodError') return 'The app answered in an unexpected form. Reload the page.'
  return e instanceof Error ? e.message : String(e)
}
