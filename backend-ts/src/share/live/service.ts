/** Live read-only session sharing (contract/src/live_share.ts; docs/live-session-share.md): the service behind the
 *  person's link management and the share-only listener.
 *
 *  Shape of the work:
 *  - One PRODUCER per (session × canonical options), however many links and viewers share it. It is dirtied by the
 *    run hub (a mark only, never a projection on the runner's emit) and by a cheap fingerprint of the session's other
 *    records polled while it is watched (director turns and notes, relays, interactions, titles); a dirty producer
 *    rebuilds after a short debounce, never more often than its minimum interval (which grows with what a build costs),
 *    one build at a time, in the projector WORKER (off this event loop). A build whose content hash (generated_at
 *    excluded) did not change is no new revision and is sent to nobody.
 *  - The latest state is serialized ONCE (by the worker); each viewer gets a tiny per-link prefix (epoch, revision,
 *    expiry) and suffix around the SAME snapshot bytes. A viewer holds at most one queued frame and one pending (the
 *    latest replaces an older pending one); one that has not drained for STALL_MS is closed (its client reconnects).
 *  - A producer whose last viewer left is disposed after IDLE_MS (timers off, hub watch off, state dropped); with no
 *    producer left the worker is stopped.
 *  - Revocation, expiry, session deletion, the listener turned off: the link is invalid FIRST (row and memory), then
 *    each stream is ended (`ended` when its queue is empty, else aborted so nothing queued earlier is delivered), and
 *    every send and every image answer checks the link again right before it goes. */

import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  LIVE_CAPABILITY, LIVE_IMAGE_RESOURCE, LIVE_PATHS, LIVE_SHARE_DEFAULT_SETTINGS, LIVE_SHARE_FORMAT, LIVE_SHARE_LIMITS, LIVE_SHARE_LIMITS_V2, LIVE_SHARE_VERSION_V2,
  LiveShareSettingsSchema, SHARE_LIMITS,
  type LiveShareSettings, type LiveShareStatus, type ShareLink, type ShareLinkCreateRequest, type ShareLinkCreateV2Request, type ShareLinkOptions, type ShareLinkSecretResponse,
  type ShareLinkV2, type ShareLinkV2SecretResponse,
} from '@oasis-code/contract'
import { createHash } from 'node:crypto'
import type { AppState } from '../../api/state.ts'
import { HttpError } from '../../api/state.ts'
import { AGENT_BROWSER_HEADER } from '../../api/auth.ts'
import * as repo from '../../db/repo.ts'
import { redactSecrets } from '../../llm/redact.ts'
import { atomicWrite } from '../../store.ts'
import { FRONTEND_DIST } from '../../version.ts'
import { appShareSource, taskContextKey, type LiveRunInput } from '../snapshot.ts'
import { anyActiveLink, capabilityMatches, capabilityOf, canonicalOptions, getLink, insertLink, keyForNewLink, linkByHash, linksOfSession, linksOfTask, newLinkId, publicLink,
  publicLinkV2, revokeLink, revokeSessionLinks, revokeTaskLinks, sha256Hex, shareKey, stateOf, type LinkRow } from './links.ts'
import { keyedPart } from './part.ts'
import { taskSessions } from '../task.ts'
import { ProjectorCore } from './projector_core.ts'
import { InlineProjector, WorkerProjector, type Projector } from './projector.ts'

export const SETTINGS_FILE = 'live-share.json'
/** `busy` (live v2 only, LIVE_ENDED_REASONS_V2): the task cannot be held whole now; a v1 stream never ends with it */
type EndReason = 'revoked' | 'expired' | 'session_deleted' | 'disabled' | 'server_closing' | 'busy'

export interface LiveShareServiceOptions {
  /** 'inline' runs the projection in process (tests only); default: the worker */
  projector?: 'worker' | 'inline' | Projector
  /** the port actually bound, whatever the settings say (tests: 0 for an ephemeral port). Constructor-only. */
  test_port?: number
  debounce_ms?: number
  min_interval_ms?: number
  poll_ms?: number
  idle_ms?: number
  heartbeat_ms?: number
  stall_ms?: number
  /** live v2: a part's bound (default LIVE_SHARE_LIMITS_V2.max_part_bytes; tests: a small one) */
  max_part_bytes?: number
  /** the built viewer's folder (default `<FRONTEND_DIST>/live-share`) */
  viewer_dir?: string
  now?: () => number
}

const SECURITY_HEADERS: Record<string, string> = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; font-src data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'",
}
const HIGH_WATER = 256 * 1024
const encoder = new TextEncoder()

const PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
  + '<meta name="referrer" content="no-referrer"><title>oasis-code · live session</title>'
  + `<link rel="stylesheet" href="${LIVE_PATHS.style}"></head><body><div id="root"><noscript>This page shows a live session with its own script; turn scripts on to see it.</noscript></div>`
  + `<script src="${LIVE_PATHS.script}"></script></body></html>`

function errorResponse(status: number, error: string, reason?: EndReason, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(reason ? { error, reason } : { error }), { status, headers: { ...SECURITY_HEADERS, 'content-type': 'application/json', ...extra } })
}

/** A request failed in a way no check foresaw: the listener's fixed answer (its own headers, one fixed word) — never the
 *  error, its message, its stack or a path. What failed goes to this machine's log only, under a reference. */
function internalError(where: string, error: unknown): Response {
  logInternal(where, error)
  return errorResponse(503, 'unavailable')
}

/** What failed, in this machine's log only (redacted, under a reference) — never in anything a viewer receives. */
function logInternal(where: string, error: unknown): void {
  const reference = `err_${randomBytes(4).toString('hex')}`
  const described = error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error)
  console.error(`live share: internal error ${reference} on ${where}: ${redactSecrets(described)}`)
}

/** The request's path as the log may name it: one of the listener's own paths, or `other`. */
function publicPath(req: Request): string {
  let path = 'other'
  try { path = new URL(req.url).pathname } catch { /* other */ }
  if (path === LIVE_PATHS.page || path === LIVE_PATHS.script || path === LIVE_PATHS.style || path === LIVE_PATHS.stream) return path
  return path.startsWith(LIVE_PATHS.image_prefix) ? `${LIVE_PATHS.image_prefix}…` : 'other'
}

class Viewer {
  closed = false
  /** the latest frame not yet queued (a newer one replaces it) */
  pending: Uint8Array[] | null = null
  /** live v2: the projection's member version the pending frame was made under (an older one is never released) */
  pendingVersion = 0
  lastDrain: number
  controller!: ReadableStreamDefaultController<Uint8Array>
  constructor(readonly link: LinkRow, readonly producer: Producer | ProducerV2, now: number) { this.lastDrain = now }

  /** queue empty: everything given has been taken by the connection */
  get idle(): boolean { return (this.controller.desiredSize ?? 0) >= HIGH_WATER }

  offer(chunks: Uint8Array[], now: number, version = 0): void {
    if (this.closed) return
    if ((this.controller.desiredSize ?? 0) > 0) { for (const c of chunks) this.controller.enqueue(c); this.lastDrain = now }
    else { this.pending = chunks; this.pendingVersion = version }
  }

  /** The connection took what was queued: the pending frame goes now — after `valid` said the link still works. */
  pull(now: number, valid: () => boolean): void {
    this.lastDrain = now
    if (this.closed || this.pending === null) return
    if (!valid()) return
    const chunks = this.pending
    this.pending = null
    for (const c of chunks) this.controller.enqueue(c)
  }
}

class Producer {
  readonly salt = randomBytes(32).toString('hex')
  readonly epoch = randomBytes(12).toString('base64url')
  revision = 0
  frame: { bytes: Uint8Array; hash: string; images: Map<string, string> } | null = null
  readonly viewers = new Set<Viewer>()
  disposed = false
  building = false
  dirty = true
  timer: ReturnType<typeof setTimeout> | null = null
  lastBuildAt = 0
  lastBuildMs = 0
  failures = 0
  fingerprint: string | null = null
  poll: ReturnType<typeof setInterval> | null = null
  unwatch: (() => void) | null = null
  idle: ReturnType<typeof setTimeout> | null = null
  constructor(readonly key: string, readonly session_id: string, readonly options: ShareLinkOptions) {}
}

/** Live state v2: one session's part — (session × canonical options), shared by every v2 projection that shows the
 *  session (a link of the session alone, a link of its task: the same bytes, part.ts). Built in the worker, one part per
 *  request; dirtied by the run hub and the session's fingerprint, coalesced as a v1 producer is. */
class Part {
  readonly salt = randomBytes(32).toString('hex')
  /** `context`: the task folders' key (snapshot.ts taskContextKey) the part was sanitized under */
  frame: { bytes: Uint8Array; hash: string; images: Map<string, string>; title: string; context: string } | null = null
  /** the card's row keys (a row's root id → `t<n>`), kept across builds so a row keeps its key */
  rowKeys = new Map<string, string>()
  readonly producers = new Set<ProducerV2>()
  disposed = false
  building = false
  dirty = true
  timer: ReturnType<typeof setTimeout> | null = null
  lastBuildAt = 0
  lastBuildMs = 0
  failures = 0
  fingerprint: string | null = null
  poll: ReturnType<typeof setInterval> | null = null
  unwatch: (() => void) | null = null
  constructor(readonly key: string, readonly session_id: string, readonly options: ShareLinkOptions) {}
  get watched(): boolean { for (const p of this.producers) if (p.viewers.size > 0) return true; return false }
}

/** Live state v2: what one or more v2 links show — a session, or a task — assembled from its sessions' parts. */
class ProducerV2 {
  readonly epoch = randomBytes(12).toString('base64url')
  revision = 0
  frame: { chunks: Uint8Array[]; hash: string; images: Map<string, { session_id: string; asset_id: string }>; members: string[] } | null = null
  readonly viewers = new Set<Viewer>()
  /** its sessions' parts, by session id */
  readonly parts = new Map<string, Part>()
  /** each session's key in this projection (`s1`, …): kept for its life, never given again */
  readonly sessionKeys = new Map<string, string>()
  nextKey = 1
  members: string[] = []
  /** grows each time the set of sessions changes: a frame (sent, pending or cached) of an older set is never used */
  memberVersion = 0
  memberPrint: string | null = null
  disposed = false
  poll: ReturnType<typeof setInterval> | null = null
  idle: ReturnType<typeof setTimeout> | null = null
  constructor(readonly key: string, readonly session_id: string | null, readonly task_root_id: string | null, readonly options: ShareLinkOptions) {}
  keyOf(sessionId: string): string {
    let k = this.sessionKeys.get(sessionId)
    if (k === undefined) { k = `s${this.nextKey++}`; this.sessionKeys.set(sessionId, k) }
    return k
  }
}

/** The fingerprint of what the run hub does not carry: titles, director turns and notes, groups and their notes. */
const FINGERPRINT_SQL = `SELECT
 (SELECT title||'|'||status||'|'||updated_at||'|'||COALESCE(last_activity_at,'') FROM sessions WHERE id=?1) AS s,
 (SELECT COALESCE(MAX(cursor),0) FROM run_events WHERE session_id=?1) AS e,
 (SELECT COUNT(*)||'|'||COALESCE(MAX(finished_at),'')||'|'||COALESCE(SUM(status IN ('queued','running')),0) FROM runs WHERE session_id=?1) AS r,
 (SELECT COUNT(*)||'|'||COALESCE(MAX(started_at),'')||'|'||COALESCE(MAX(finished_at),'')||'|'||COALESCE(SUM(length(COALESCE(output,''))),0)||'|'||COALESCE(group_concat(status),'') FROM director_turns WHERE session_id=?1) AS t,
 (SELECT COUNT(*) FROM director_notes WHERE session_id=?1) AS n,
 (SELECT COUNT(*)||'|'||COALESCE(MAX(updated_at),'') FROM relays WHERE session_id=?1) AS g,
 (SELECT COUNT(*)||'|'||COALESCE(MAX(updated_at),'') FROM interactions WHERE session_id=?1) AS i,
 (SELECT COUNT(*)||'|'||COALESCE(MAX(n.updated_at),'') FROM interaction_notes n JOIN interactions x ON x.id=n.interaction_id WHERE x.session_id=?1) AS m,
 (SELECT COUNT(*)||'|'||COALESCE(MAX(updated_at),'') FROM participants WHERE session_id=?1) AS p`

/** The words of the answer a run is writing now, from its handle's events: the text deltas after its last completed
 *  block (from the last one that started a new answer). null: none open. */
export function openTextOf(events: readonly { event: string; data: Record<string, unknown> }[], cap = 260_000): string | null {
  const pieces: string[] = []
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!
    if (e.event === 'text_block') break
    if (e.event !== 'text_delta') continue
    pieces.push(typeof e.data.text === 'string' ? e.data.text : '')
    if (e.data.start === true) break
  }
  if (!pieces.length) return null
  let text = ''
  for (let i = pieces.length - 1; i >= 0 && text.length < cap; i--) text += pieces[i]
  return text.length > cap ? text.slice(0, cap) : text
}

export class LiveShareService {
  private settings: LiveShareSettings = { ...LIVE_SHARE_DEFAULT_SETTINGS }
  private settingsError: string | null = null
  private server: ReturnType<typeof Bun.serve> | null = null
  private listenError: string | null = null
  private readonly producers = new Map<string, Producer>()
  /** live state v2: its projections (by scope × options) and the sessions' parts they share (by session × options) */
  private readonly producersV2 = new Map<string, ProducerV2>()
  private readonly parts = new Map<string, Part>()
  private readonly viewersByLink = new Map<string, Set<Viewer>>()
  private viewerCount = 0
  private imagesInFlight = 0
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private expiryTimer: ReturnType<typeof setTimeout> | null = null
  private readonly projector: Projector
  private readonly unEnd: () => void
  private closed = false
  private readonly o: Required<Omit<LiveShareServiceOptions, 'projector' | 'test_port' | 'viewer_dir' | 'now' | 'max_part_bytes'>>
  private readonly maxPartBytes: number
  /** live v2: parts found too large to send (part key → the session's fingerprint then): refused (busy) without a new
   *  build while that fingerprint holds; a change of the session lets the next viewer try again */
  private readonly tooLarge = new Map<string, string | null>()
  private readonly now: () => number
  private readonly viewerDir: string

  constructor(private readonly state: AppState, private readonly opts: LiveShareServiceOptions = {}) {
    this.now = opts.now ?? Date.now
    this.o = {
      debounce_ms: opts.debounce_ms ?? 400, min_interval_ms: opts.min_interval_ms ?? 1000, poll_ms: opts.poll_ms ?? 2000, idle_ms: opts.idle_ms ?? 5000,
      heartbeat_ms: opts.heartbeat_ms ?? LIVE_SHARE_LIMITS.heartbeat_ms, stall_ms: opts.stall_ms ?? 60_000,
    }
    this.viewerDir = opts.viewer_dir ?? join(FRONTEND_DIST, 'live-share')
    this.maxPartBytes = Math.min(opts.max_part_bytes ?? LIVE_SHARE_LIMITS_V2.max_part_bytes, LIVE_SHARE_LIMITS_V2.max_part_bytes)
    const p = opts.projector ?? 'worker'
    this.projector = typeof p === 'object' ? p
      : p === 'inline' ? new InlineProjector(() => new ProjectorCore(appShareSource(state)))
      : new WorkerProjector(() => ({
        db_path: state.settings.db_path, assets_dir: state.settings.assets_dir, data_dir: state.settings.data_dir, workspaces_dir: state.settings.workspaces_dir,
        session_token: state.session_token, models: state.config.models.map((m) => m.dump()), default_model: state.config.default_model,
      }))
    this.settings = this.readSettings()
    this.unEnd = state.runs.sessions.onEnd((sessionId) => this.sessionGone(sessionId))
  }

  /** how many projections the projector made (a test's question) */
  get builds(): number { return this.projector.builds }
  get projectorKind(): 'worker' | 'inline' { return this.projector.kind }

  // ---- settings -------------------------------------------------------------------------------------------------------

  private get settingsPath(): string { return join(this.state.settings.data_dir, SETTINGS_FILE) }

  private readSettings(): LiveShareSettings {
    try {
      if (!existsSync(this.settingsPath)) return { ...LIVE_SHARE_DEFAULT_SETTINGS }
      const parsed = LiveShareSettingsSchema.parse(JSON.parse(readFileSync(this.settingsPath, 'utf8')))
      this.settingsError = null
      return { ...parsed, public_base_url: normalizeBaseUrl(parsed.public_base_url) }
    } catch {
      // unreadable settings never turn the listener on
      this.settingsError = 'the live share settings could not be read; save them again in Settings'
      return { ...LIVE_SHARE_DEFAULT_SETTINGS }
    }
  }

  getSettings(): LiveShareSettings { return { ...this.settings } }

  status(): LiveShareStatus {
    const address = this.server ? `${this.settings.bind === 'lan' ? '0.0.0.0' : '127.0.0.1'}:${this.server.port}` : null
    return {
      listening: this.server !== null, address,
      error: this.server ? null : (this.listenError ?? (this.settings.enabled ? this.settingsError : null)),
      viewers: this.viewerCount, viewer_built: this.viewerFile('live-share.js') !== null && this.viewerFile('live-share.css') !== null,
    }
  }

  /** The listener's lifecycle — applying settings, the start, the close — one step at a time, in the order asked: two
   *  applies never interleave (the last one asked is what holds), and after the close nothing opens it again. */
  private lifecycle: Promise<unknown> = Promise.resolve()
  private serial<T>(step: () => Promise<T>): Promise<T> {
    const run = this.lifecycle.then(step, step)
    this.lifecycle = run.catch(() => {})
    return run
  }

  /** Save the person's settings and apply them now: off ends every stream and closes the listener at once. */
  applySettings(next: LiveShareSettings): Promise<{ settings: LiveShareSettings; status: LiveShareStatus }> {
    // checked before it waits its turn: a bad body is refused at once and changes nothing
    const checked = LiveShareSettingsSchema.parse(next)
    const settings: LiveShareSettings = { ...checked, public_base_url: normalizeBaseUrl(checked.public_base_url) }
    return this.serial(async () => {
      if (this.closed) throw new HttpError(503, 'oasis-code is stopping; change the live share settings once it runs again')
      atomicWrite(this.settingsPath, JSON.stringify(settings) + '\n', { mode: 0o600 })
      this.settings = settings
      this.settingsError = null
      await this.stopListener('disabled')
      if (!this.closed && settings.enabled) this.listen(settings)
      return { settings: this.getSettings(), status: this.status() }
    })
  }

  /** The app started: listen when the person turned it on. */
  start(): Promise<void> {
    return this.serial(async () => {
      if (!this.closed && this.settings.enabled && this.server === null) this.listen(this.settings)
    })
  }

  private listen(settings: LiveShareSettings): void {
    if (this.server !== null || this.closed) return
    const hostname = settings.bind === 'lan' ? '0.0.0.0' : '127.0.0.1'
    const port = this.opts.test_port ?? settings.port
    try {
      this.server = Bun.serve({
        hostname, port, idleTimeout: 255, maxRequestBodySize: 1024,
        // never Bun's development error page (it prints the error, its stack and the source's paths to the client)
        development: false,
        fetch: (req) => this.respond(req),
        // the last boundary: whatever escapes `respond` still gets the fixed answer
        error: (error) => internalError('the listener', error),
      })
      this.listenError = null
      this.heartbeat ??= setInterval(() => this.sweep(), Math.min(this.o.heartbeat_ms, 15_000))
    } catch (error) {
      this.server = null
      const code = (error as { code?: unknown }).code
      this.listenError = code === 'EADDRINUSE' ? `port ${port} on ${hostname} is already in use; choose another port` : `the share listener could not start on ${hostname}:${port}`
    }
  }

  private async stopListener(reason: EndReason): Promise<void> {
    // the listener is off for every check from here on; each stream is ended, its `ended` given a moment to go out,
    // then whatever is left is cut
    const server = this.server
    this.server = null
    for (const v of [...this.allViewers()]) this.end(v, reason)
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null }
    if (server) {
      await Promise.race([server.stop(false), Bun.sleep(1000)])
      server.stop(true)
    }
  }

  close(): Promise<void> {
    // closed at once (no step queued after this opens anything), then taken down in its turn
    if (this.closed) return this.lifecycle.then(() => {})
    this.closed = true
    this.unEnd()
    return this.serial(async () => {
      await this.stopListener('server_closing')
      for (const p of [...this.producers.values()]) this.dispose(p)
      for (const p of [...this.producersV2.values()]) this.disposeV2(p)
      if (this.expiryTimer) clearTimeout(this.expiryTimer)
      await this.projector.close()
    })
  }

  // ---- links (the person's) ---------------------------------------------------------------------------------------------

  private viewersOf(id: string): number { return this.viewersByLink.get(id)?.size ?? 0 }

  private origin(): string | null {
    if (this.settings.public_base_url) return this.settings.public_base_url
    return this.settings.bind === 'loopback' ? `http://127.0.0.1:${this.settings.port}` : null
  }

  private secretOf(row: LinkRow, key: Buffer): ShareLinkSecretResponse {
    const capability = capabilityOf(key, row.id, row.protocol)
    const origin = this.origin()
    return { link: publicLink(row, this.now(), this.viewersOf(row.id)), capability, url: origin === null ? null : `${origin}${LIVE_PATHS.page}#${capability}` }
  }

  createLink(sessionId: string, req: ShareLinkCreateRequest): ShareLinkSecretResponse {
    const session = repo.getSession(this.state.conn, sessionId)
    if (session === null || session.status === repo.DELETED_SESSION) throw new HttpError(404, `session not found: ${sessionId}`)
    const now = this.now()
    const active = linksOfSession(this.state.conn, sessionId).filter((l) => stateOf(l, now) === 'active').length
    if (active >= LIVE_SHARE_LIMITS.max_active_links_per_session) throw new HttpError(409, `the session has ${active} live links; revoke one first`, 'share_link_limit')
    const key = keyForNewLink(this.state.settings.data_dir, () => anyActiveLink(this.state.conn, new Date(now).toISOString()))
    if (key === null) {
      throw new HttpError(409, 'the live share key file is missing or damaged while links are still active; those links no longer work — revoke them, then make a new link', 'share_key_unavailable')
    }
    const id = newLinkId()
    const row: LinkRow = {
      id, session_id: sessionId, label: req.label.replace(/\s+/g, ' ').trim(), capability_hash: sha256Hex(capabilityOf(key, id)),
      options: canonicalOptions({ include_tool_details: req.include_tool_details, include_images: req.include_images, exclude_run_ids: req.exclude_run_ids }),
      created_at: new Date(now).toISOString(), expires_at: new Date(now + req.expires_in_s * 1000).toISOString(), revoked_at: null, revoked_reason: null,
      protocol: 1, task_root_id: null,
    }
    insertLink(this.state.conn, row)
    return this.secretOf(row, key)
  }

  // ---- links of protocol 2 (the person's) -----------------------------------------------------------------------------

  /** How many sessions a link shows now that are not deleted. */
  private membersCount(row: LinkRow): number {
    if (row.task_root_id !== null) return repo.sessionsOfTask(this.state.conn, row.task_root_id).length
    const s = repo.getSession(this.state.conn, row.session_id)
    return s !== null && s.status !== repo.DELETED_SESSION ? 1 : 0
  }

  private publicV2(row: LinkRow): ShareLinkV2 { return publicLinkV2(row, this.now(), this.viewersOf(row.id), this.membersCount(row)) }

  private secretOfV2(row: LinkRow, key: Buffer): ShareLinkV2SecretResponse {
    const secret = this.secretOf(row, key)
    return { ...secret, link: this.publicV2(row) }
  }

  /** A protocol 2 link: of this session alone, or — include_task_sessions — of its task (fixed now: the task's first
   *  session's id, the same from any session of it). */
  createLinkV2(sessionId: string, req: ShareLinkCreateV2Request): ShareLinkV2SecretResponse {
    const session = repo.getSession(this.state.conn, sessionId)
    if (session === null || session.status === repo.DELETED_SESSION) throw new HttpError(404, `session not found: ${sessionId}`)
    const now = this.now()
    const active = linksOfSession(this.state.conn, sessionId).filter((l) => stateOf(l, now) === 'active').length
    if (active >= LIVE_SHARE_LIMITS.max_active_links_per_session) throw new HttpError(409, `the session has ${active} live links; revoke one first`, 'share_link_limit')
    const key = keyForNewLink(this.state.settings.data_dir, () => anyActiveLink(this.state.conn, new Date(now).toISOString()))
    if (key === null) {
      throw new HttpError(409, 'the live share key file is missing or damaged while links are still active; those links no longer work — revoke them, then make a new link', 'share_key_unavailable')
    }
    const id = newLinkId()
    const row: LinkRow = {
      id, session_id: sessionId, label: req.label.replace(/\s+/g, ' ').trim(), capability_hash: sha256Hex(capabilityOf(key, id, 2)),
      options: canonicalOptions({ include_tool_details: req.include_tool_details, include_images: req.include_images, exclude_run_ids: req.exclude_run_ids }),
      created_at: new Date(now).toISOString(), expires_at: new Date(now + req.expires_in_s * 1000).toISOString(), revoked_at: null, revoked_reason: null,
      protocol: 2, task_root_id: req.include_task_sessions ? (session.task_root_id ?? session.id) : null,
    }
    insertLink(this.state.conn, row)
    return this.secretOfV2(row, key)
  }

  /** The session's own links (v1 and v2) and every task link of its task (made from any session of it, the one it was
   *  made from deleted or not), newest first. */
  listLinksV2(sessionId: string): ShareLinkV2[] {
    const session = repo.getSession(this.state.conn, sessionId)
    if (session === null || session.status === repo.DELETED_SESSION) throw new HttpError(404, `session not found: ${sessionId}`)
    const byId = new Map<string, LinkRow>()
    for (const r of [...linksOfSession(this.state.conn, sessionId), ...linksOfTask(this.state.conn, session.task_root_id ?? session.id)]) byId.set(r.id, r)
    return [...byId.values()].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0)).map((r) => this.publicV2(r))
  }

  revealV2(id: string): ShareLinkV2SecretResponse {
    const row = this.ownedLink(id)
    if (stateOf(row, this.now()) !== 'active' || this.membersCount(row) === 0) throw new HttpError(410, 'this link was revoked or has expired; make a new one', 'share_link_inactive')
    const key = shareKey(this.state.settings.data_dir)
    if (key === null || sha256Hex(capabilityOf(key, row.id, row.protocol)) !== row.capability_hash) throw new HttpError(410, 'this link can no longer be derived (its key is gone); make a new one', 'share_link_inactive')
    return this.secretOfV2(row, key)
  }

  revokeV2(id: string): ShareLinkV2 {
    this.revoke(id)
    return this.publicV2(getLink(this.state.conn, id)!)
  }

  listLinks(sessionId: string): ShareLink[] {
    const session = repo.getSession(this.state.conn, sessionId)
    if (session === null || session.status === repo.DELETED_SESSION) throw new HttpError(404, `session not found: ${sessionId}`)
    const now = this.now()
    return linksOfSession(this.state.conn, sessionId).map((r) => publicLink(r, now, this.viewersOf(r.id)))
  }

  reveal(id: string): ShareLinkSecretResponse {
    const row = this.ownedLink(id)
    if (stateOf(row, this.now()) !== 'active' || this.membersCount(row) === 0) throw new HttpError(410, 'this link was revoked or has expired; make a new one', 'share_link_inactive')
    const key = shareKey(this.state.settings.data_dir)
    if (key === null || sha256Hex(capabilityOf(key, row.id, row.protocol)) !== row.capability_hash) throw new HttpError(410, 'this link can no longer be derived (its key is gone); make a new one', 'share_link_inactive')
    return this.secretOf(row, key)
  }

  revoke(id: string): ShareLink {
    const row = this.ownedLink(id)
    revokeLink(this.state.conn, id, 'revoked', new Date(this.now()).toISOString())
    this.endLink(id, 'revoked')
    const after = getLink(this.state.conn, id) ?? row
    return publicLink(after, this.now(), this.viewersOf(id))
  }

  /** A link the person can reveal or revoke: a link of one session while that session is not deleted (as v1); a task
   *  link whatever became of the session it was made from (it shows the task). */
  private ownedLink(id: string): LinkRow {
    const row = /^sl_[A-Za-z0-9_-]{22}$/.test(id) ? getLink(this.state.conn, id) : null
    if (row !== null && row.task_root_id !== null) return row
    const session = row ? repo.getSession(this.state.conn, row.session_id) : null
    if (row === null || session === null || session.status === repo.DELETED_SESSION) throw new HttpError(404, `no live link ${id}`)
    return row
  }

  /** The session was deleted: its links are revoked (first), then their streams end, then its producers go. */
  private sessionGone(sessionId: string): void {
    const at = new Date(this.now()).toISOString()
    revokeSessionLinks(this.state.conn, sessionId, 'session_deleted', at)
    for (const v of [...this.allViewers()]) if (v.link.session_id === sessionId && v.link.task_root_id === null) this.end(v, 'session_deleted')
    for (const p of [...this.producers.values()]) if (p.session_id === sessionId) this.dispose(p)
    // v2: every projection showing it drops it now (its part goes, the rest is sent again without it); a task with no
    // session left ends its links
    for (const p of [...this.producersV2.values()]) if (p.parts.has(sessionId)) this.refreshMembers(p)
    const row = repo.getSession(this.state.conn, sessionId)
    const root = row?.task_root_id ?? sessionId
    if (repo.sessionsOfTask(this.state.conn, root).length === 0) {
      revokeTaskLinks(this.state.conn, root, 'session_deleted', at)
      for (const v of [...this.allViewers()]) if (v.link.task_root_id === root) this.end(v, 'session_deleted')
    }
  }

  // ---- the share listener -----------------------------------------------------------------------------------------------

  private viewerFile(name: string): string | null {
    const path = join(this.viewerDir, name)
    try { return existsSync(path) ? path : null } catch { return null }
  }

  /** The listener's exception boundary: a request that throws anywhere below (a database read, a file, the projector)
   *  is answered `503 {"error":"unavailable"}` with the listener's headers, and nothing of the error leaves. */
  private async respond(req: Request): Promise<Response> {
    try {
      return await this.handle(req)
    } catch (error) {
      return internalError(`${req.method} ${publicPath(req)}`, error)
    }
  }

  /** The listener's one handler: exactly five paths, GET only, nothing of the app's router, no cookie read or set. */
  async handle(req: Request): Promise<Response> {
    if (this.closed) return errorResponse(503, 'unavailable')
    if (req.method !== 'GET') return errorResponse(405, 'method_not_allowed', undefined, { allow: 'GET' })
    if (req.headers.has(AGENT_BROWSER_HEADER)) return errorResponse(403, 'forbidden')
    if (req.headers.has('upgrade')) return errorResponse(403, 'forbidden')
    if ((req.headers.get('content-length') ?? '0') !== '0' || req.headers.has('transfer-encoding')) return errorResponse(403, 'forbidden')
    let url: URL
    try { url = new URL(req.url) } catch { return errorResponse(404, 'not_found') }
    if (url.search !== '') return errorResponse(404, 'not_found')
    const path = url.pathname
    if (path === LIVE_PATHS.page) return new Response(PAGE, { headers: { ...SECURITY_HEADERS, 'content-type': 'text/html; charset=utf-8' } })
    if (path === LIVE_PATHS.script || path === LIVE_PATHS.style) {
      const file = this.viewerFile(path === LIVE_PATHS.script ? 'live-share.js' : 'live-share.css')
      if (file === null) return errorResponse(503, 'unavailable')
      return new Response(Bun.file(file), { headers: { ...SECURITY_HEADERS, 'content-type': path === LIVE_PATHS.script ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8' } })
    }
    if (path === LIVE_PATHS.stream) return this.stream(req)
    if (path.startsWith(LIVE_PATHS.image_prefix)) {
      const resource = path.slice(LIVE_PATHS.image_prefix.length)
      if (!LIVE_IMAGE_RESOURCE.test(resource)) return errorResponse(404, 'not_found')
      return this.image(req, resource)
    }
    return errorResponse(404, 'not_found')
  }

  /** The link a request's capability names, checked; or the answer that refuses it. Cheap checks first: the header's
   *  shape before any hash, the hash's row before the constant-time comparison. */
  private authenticate(req: Request): { link: LinkRow } | { refused: Response } {
    const header = req.headers.get('authorization') ?? ''
    if (header.length > 64 || !header.startsWith('Bearer ')) return { refused: errorResponse(401, 'unauthorized') }
    const capability = header.slice(7)
    if (!LIVE_CAPABILITY.test(capability)) return { refused: errorResponse(401, 'unauthorized') }
    const key = shareKey(this.state.settings.data_dir)
    if (key === null) return { refused: errorResponse(401, 'unauthorized') }
    const row = linkByHash(this.state.conn, sha256Hex(capability))
    if (row === null || !capabilityMatches(key, row.id, capability, row.protocol)) return { refused: errorResponse(401, 'unauthorized') }
    const gone = this.goneReason(row)
    if (gone !== null) return { refused: errorResponse(410, 'gone', gone) }
    return { link: row }
  }

  /** Why the link no longer works (null: it does), read again from its row and its session. */
  private goneReason(row: LinkRow): EndReason | null {
    const fresh = getLink(this.state.conn, row.id)
    if (fresh === null) return 'revoked'
    if (fresh.task_root_id !== null) {
      // a task link: the task, not the session it was made from — gone once no session of it is left
      if (fresh.revoked_at !== null) return fresh.revoked_reason === 'session_deleted' ? 'session_deleted' : 'revoked'
      if (repo.sessionsOfTask(this.state.conn, fresh.task_root_id).length === 0) return 'session_deleted'
      if (Date.parse(fresh.expires_at) <= this.now()) return 'expired'
      if (this.server === null) return 'disabled'
      return null
    }
    const session = repo.getSession(this.state.conn, fresh.session_id)
    if (session === null || session.status === repo.DELETED_SESSION) return 'session_deleted'
    if (fresh.revoked_at !== null) return fresh.revoked_reason === 'session_deleted' ? 'session_deleted' : 'revoked'
    if (Date.parse(fresh.expires_at) <= this.now()) return 'expired'
    if (this.server === null) return 'disabled'
    return null
  }

  private producerFor(link: LinkRow): Producer | null {
    const key = `${link.session_id}\0${JSON.stringify(link.options)}`
    const existing = this.producers.get(key)
    if (existing !== undefined && !existing.disposed) return existing
    if (this.cost() + 1 > LIVE_SHARE_LIMITS.max_projections) return null
    const p = new Producer(key, link.session_id, link.options)
    this.producers.set(key, p)
    p.unwatch = this.state.runs.sessions.watch(link.session_id, () => this.mark(p))
    p.poll = setInterval(() => this.pollFingerprint(p), this.o.poll_ms)
    return p
  }

  private stream(req: Request): Response {
    const auth = this.authenticate(req)
    if ('refused' in auth) return auth.refused
    const link = auth.link
    if (link.protocol === 2) return this.streamV2(req, link)
    if (this.viewerCount >= LIVE_SHARE_LIMITS.max_viewers_total || this.viewersOf(link.id) >= LIVE_SHARE_LIMITS.max_viewers_per_link) return errorResponse(429, 'busy')
    const producer = this.producerFor(link)
    if (producer === null) return errorResponse(503, 'busy')
    const viewer = new Viewer(link, producer, this.now())
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => { viewer.controller = controller },
      pull: (controller) => {
        // after the answer's head went out: a failure ends this stream (nothing more is written), never a message
        try { viewer.pull(this.now(), () => this.stillValid(viewer)) } catch (error) { this.fail(viewer, controller, 'GET /live/api/stream (stream)', error) }
      },
      cancel: () => { this.detach(viewer) },
    }, new ByteLengthQueuingStrategy({ highWaterMark: HIGH_WATER }))
    this.attach(viewer)
    req.signal.addEventListener('abort', () => this.detach(viewer), { once: true })
    // the latest state at once when there is one; and a refresh whenever the producer may be behind (it was marked while
    // nobody watched — a transient delta changes no record the fingerprint reads). A failure here leaves no viewer
    // attached behind the boundary's answer.
    try {
      if (producer.frame !== null) this.send(viewer)
      if (producer.frame === null || producer.dirty) this.schedule(producer, producer.frame === null)
    } catch (error) {
      this.detach(viewer)
      throw error
    }
    return new Response(body, { headers: { ...SECURITY_HEADERS, 'content-type': 'text/event-stream; charset=utf-8', 'x-accel-buffering': 'no' } })
  }

  private async image(req: Request, resource: string): Promise<Response> {
    const auth = this.authenticate(req)
    if ('refused' in auth) return auth.refused
    const link = auth.link
    if (link.protocol === 2) return this.imageV2(link, resource)
    // only a projection that is being watched now answers; a guess never starts one
    const producer = this.producers.get(`${link.session_id}\0${JSON.stringify(link.options)}`)
    const assetId = producer?.frame?.images.get(resource)
    if (producer === undefined || producer.disposed || assetId === undefined) return errorResponse(404, 'not_found')
    if (this.imagesInFlight >= 8) return errorResponse(429, 'busy')
    this.imagesInFlight++
    let reply: Awaited<ReturnType<Projector['image']>>
    try { reply = await this.projector.image({ session_id: link.session_id, asset_id: assetId, resource, salt: producer.salt }) } catch { reply = { ok: false } } finally { this.imagesInFlight-- }
    // checked again after the wait: revoked, expired, deleted or turned off meanwhile answers nothing of it
    const gone = this.goneReason(link)
    if (gone !== null) return errorResponse(410, 'gone', gone)
    if (producer.disposed || producer.frame?.images.get(resource) !== assetId) return errorResponse(404, 'not_found')
    if (!reply.ok) return errorResponse(404, 'not_found')
    return new Response(reply.bytes, { headers: { ...SECURITY_HEADERS, 'content-type': reply.media_type, 'content-length': String(reply.bytes.length) } })
  }

  private *allViewers(): Iterable<Viewer> {
    for (const set of this.viewersByLink.values()) yield* set
  }

  private attach(v: Viewer): void {
    let set = this.viewersByLink.get(v.link.id)
    if (!set) this.viewersByLink.set(v.link.id, set = new Set())
    set.add(v)
    v.producer.viewers.add(v)
    this.viewerCount++
    if (v.producer.idle) { clearTimeout(v.producer.idle); v.producer.idle = null }
    this.armExpiry()
  }

  private detach(v: Viewer): void {
    if (v.closed) return
    v.closed = true
    v.pending = null
    const set = this.viewersByLink.get(v.link.id)
    if (set?.delete(v)) this.viewerCount--
    if (set && !set.size) this.viewersByLink.delete(v.link.id)
    const p = v.producer
    p.viewers.delete(v)
    if (p.viewers.size === 0 && !p.disposed && p.idle === null) p.idle = setTimeout(() => { p.idle = null; if (p.viewers.size === 0) this.dispose(p) }, this.o.idle_ms)
    this.armExpiry()
  }

  /** End one stream: `ended` when nothing is queued before it, else abort (what was queued is not delivered). */
  private end(v: Viewer, reason: EndReason): void {
    if (v.closed) return
    const empty = v.idle
    this.detach(v)
    try {
      if (empty) {
        v.controller.enqueue(encoder.encode(`event: ended\ndata: ${JSON.stringify({ reason })}\n\n`))
        v.controller.close()
      } else v.controller.error(new Error('ended'))
    } catch { /* already closed */ }
  }

  /** One viewer's failure (a read of its link, a write to its stream) ends that viewer alone: counted out, its stream cut
   *  (nothing more written, no message), the error logged here only. The others go on. */
  private fail(v: Viewer, controller: ReadableStreamDefaultController<Uint8Array>, where: string, error: unknown): void {
    this.detach(v)
    try { controller.error(new Error('unavailable')) } catch { /* already ended */ }
    logInternal(where, error)
  }

  /** `send` for a broadcast (a timer's work, outside any request's boundary): one viewer's failure never stops the rest. */
  private sendIsolated(v: Viewer): void {
    try { this.send(v) } catch (error) { this.fail(v, v.controller, 'GET /live/api/stream (broadcast)', error) }
  }

  private endLink(id: string, reason: EndReason): void {
    for (const v of [...(this.viewersByLink.get(id) ?? [])]) this.end(v, reason)
  }

  private dispose(p: Producer | ProducerV2): void {
    if (p instanceof ProducerV2) { this.disposeV2(p); return }
    if (p.disposed) return
    p.disposed = true
    if (p.timer) clearTimeout(p.timer)
    if (p.poll) clearInterval(p.poll)
    if (p.idle) clearTimeout(p.idle)
    p.unwatch?.()
    p.frame = null
    for (const v of [...p.viewers]) this.end(v, 'server_closing')
    if (this.producers.get(p.key) === p) this.producers.delete(p.key)
    this.closeProjectorWhenIdle()
  }

  /** With nothing left to project, the worker is stopped (its memory released). */
  private closeProjectorWhenIdle(): void {
    if (this.producers.size === 0 && this.producersV2.size === 0 && this.parts.size === 0) void this.projector.close()
  }

  /** The link still works for this viewer (checked right before anything is written); a viewer whose link no longer
   *  works is ended here. */
  private stillValid(v: Viewer): boolean {
    if (v.closed) return false
    const gone = this.goneReason(v.link)
    if (gone !== null) { this.end(v, gone); return false }
    return true
  }

  /** The send of the latest state to one viewer, its link checked right before. */
  private send(v: Viewer): void {
    const p = v.producer
    if (p instanceof ProducerV2) { this.sendV2(v, p); return }
    if (v.closed || p.frame === null) return
    if (!this.stillValid(v)) return
    const head = `event: state\nid: ${p.epoch}.${p.revision}\ndata: {"epoch":"${p.epoch}","revision":${p.revision},"expires_at":${JSON.stringify(v.link.expires_at)},"snapshot":`
    v.offer([encoder.encode(head), p.frame.bytes, encoder.encode('}\n\n')], this.now())
  }

  // ---- building -----------------------------------------------------------------------------------------------------

  private mark(p: Producer): void {
    if (p.disposed) return
    p.dirty = true
    this.schedule(p, false)
  }

  private schedule(p: Producer, urgent: boolean): void {
    if (p.disposed || p.viewers.size === 0) return
    if (p.building) { p.dirty = true; return }
    if (p.timer !== null) return
    const gap = Math.max(this.o.min_interval_ms, Math.min(30_000, 5 * p.lastBuildMs), p.failures ? Math.min(30_000, 1000 * 2 ** p.failures) : 0)
    const wait = Math.max(urgent && p.frame === null && !p.failures ? 0 : this.o.debounce_ms, p.lastBuildAt + gap - this.now())
    // a build runs on a timer, outside any request: whatever it throws is logged here and the build is asked again later
    // (backed off), never an unhandled rejection
    p.timer = setTimeout(() => {
      p.timer = null
      this.build(p).catch((error) => {
        logInternal('the live share projection', error)
        if (p.disposed) return
        p.failures = Math.min(p.failures + 1, 5)
        p.dirty = true
        this.schedule(p, false)
      })
    }, Math.max(0, wait))
  }

  private captureRuns(sessionId: string): LiveRunInput[] {
    const out: LiveRunInput[] = []
    for (const h of this.state.runs.handles.values()) {
      if (h.session_id !== sessionId || h.done) continue
      const last = h.events[h.events.length - 1]
      out.push({ run_id: h.run_id, status: h.status === 'queued' ? 'queued' : 'running', bound_seq: last ? last.seq : null, open_text: openTextOf(h.events) })
    }
    return out
  }

  private readFingerprint(p: Producer): string | null {
    try { return JSON.stringify(this.state.conn.get(FINGERPRINT_SQL, [p.session_id])) } catch { return null }
  }

  private async build(p: Producer): Promise<void> {
    if (p.disposed || p.viewers.size === 0 || p.building) return
    p.building = true
    p.dirty = false
    // the records' fingerprint as they stand before this build reads them: a change after it is seen by the next poll
    p.fingerprint = this.readFingerprint(p)
    const started = this.now()
    let reply: Awaited<ReturnType<Projector['project']>>
    try {
      reply = await this.projector.project({
        session_id: p.session_id, options: p.options, salt: p.salt, runs: this.captureRuns(p.session_id), max_bytes: LIVE_SHARE_LIMITS.max_state_bytes,
      })
    } catch {
      reply = { ok: false, code: 'error' }
    } finally {
      p.building = false
    }
    p.lastBuildAt = this.now()
    p.lastBuildMs = reply.ok ? reply.build_ms : this.now() - started
    if (p.disposed) return
    if (!reply.ok) {
      if (reply.code === 'gone') { this.sessionGone(p.session_id); return }
      p.failures = Math.min(p.failures + 1, 5)
      p.dirty = true
    } else {
      p.failures = 0
      if (reply.hash !== p.frame?.hash) {
        p.revision++
        p.frame = { bytes: reply.snapshot, hash: reply.hash, images: new Map(reply.images) }
        for (const v of [...p.viewers]) this.sendIsolated(v)
      }
    }
    if (p.dirty) this.schedule(p, false)
  }

  private pollFingerprint(p: Producer): void {
    if (p.disposed || p.viewers.size === 0) return
    if (p.building) return
    const print = this.readFingerprint(p)
    if (print === null) return
    if (print !== p.fingerprint) { p.fingerprint = print; this.mark(p) }
  }

  // ---- live state v2 ----------------------------------------------------------------------------------------------------
  /* Shape: a v2 PROJECTION (ProducerV2) per (scope × canonical options) — scope `session:<id>` or `task:<task root>` —
   * however many links and viewers share it; it holds one PART per session it shows, and a part (session × options) is
   * shared by every projection that shows that session. A part is built in the worker (one per request), coalesced as a
   * v1 producer is; a projection's frame is its parts' bytes put together in the rail's order, each under its key, with
   * the state's own fields around them, sent only once EVERY session it shows has its part (never a state with a
   * session missing). Cost (LIVE_SHARE_LIMITS.max_projections, 8): one per v1 producer plus one per distinct part. */

  /** What the listener projects now: v1 producers and v2 parts (a part shared by several projections counts once). */
  private cost(): number { return this.producers.size + this.parts.size }

  private v2Key(link: LinkRow): string {
    return `v2\0${link.task_root_id !== null ? `task:${link.task_root_id}` : `session:${link.session_id}`}\0${JSON.stringify(link.options)}`
  }
  private partKey(sessionId: string, options: ShareLinkOptions): string { return `${sessionId}\0${JSON.stringify(options)}` }

  /** The sessions a projection shows now, in the rail's order: its session while not deleted; its task's not deleted. */
  private membersOf(p: Pick<ProducerV2, 'session_id' | 'task_root_id'>): string[] {
    if (p.task_root_id !== null) return taskSessions(this.state.conn, p.task_root_id).map((s) => s.id)
    const s = repo.getSession(this.state.conn, p.session_id!)
    return s !== null && s.status !== repo.DELETED_SESSION ? [s.id] : []
  }

  /** The projection a v2 link shows (made now when none is), or why not: `gone` (no session left), `busy` (the
   *  listener cannot hold its parts: nothing is made). */
  private producerV2For(link: LinkRow): ProducerV2 | 'gone' | 'busy' {
    const key = this.v2Key(link)
    const existing = this.producersV2.get(key)
    if (existing !== undefined && !existing.disposed) return existing
    const shape = { session_id: link.task_root_id === null ? link.session_id : null, task_root_id: link.task_root_id }
    const members = this.membersOf(shape)
    if (members.length === 0) return 'gone'
    if (members.some((id) => this.knownTooLarge(this.partKey(id, link.options), id))) return 'busy'
    const fresh = members.filter((id) => !this.parts.has(this.partKey(id, link.options))).length
    if (this.cost() + fresh > LIVE_SHARE_LIMITS.max_projections) return 'busy'
    const p = new ProducerV2(key, shape.session_id, shape.task_root_id, link.options)
    this.producersV2.set(key, p)
    p.members = members
    for (const id of members) { p.keyOf(id); this.acquirePart(p, id) }
    if (p.task_root_id !== null) {
      p.memberPrint = this.readMemberPrint(p)
      p.poll = setInterval(() => this.pollMembers(p), this.o.poll_ms)
    }
    return p
  }

  /** The task folders' key a session's part must be sanitized under now (null: the session is gone). */
  private contextOf(sessionId: string): string | null {
    const s = repo.getSession(this.state.conn, sessionId)
    return s === null ? null : taskContextKey(this.state.conn, s)
  }

  /** Whether every part a projection's frame is made of was sanitized under its session's task folders as they are. */
  private contextsCurrent(p: ProducerV2): boolean {
    for (const id of p.frame?.members ?? []) {
      const part = p.parts.get(id)
      if (part?.frame && part.frame.context !== this.contextOf(id)) { this.invalidatePart(part); return false }
    }
    return true
  }

  /** A part made under stale task folders: dropped with every frame made of it — no pending frame of it released, a
   *  viewer with it still queued cut (it reconnects) — and built again; the frames are put together once it is. */
  private invalidatePart(part: Part): void {
    part.frame = null
    for (const p of part.producers) {
      if (p.frame === null || !p.frame.members.includes(part.session_id)) continue
      p.frame = null
      p.memberVersion++
      for (const v of [...p.viewers]) { v.pending = null; if (!v.idle) this.abortViewer(v) }
    }
    part.dirty = true
    this.schedulePart(part, true)
  }

  /** A session whose part was too large to send, and has not changed since. */
  private knownTooLarge(key: string, sessionId: string): boolean {
    if (!this.tooLarge.has(key)) return false
    if (this.tooLarge.get(key) === this.readFingerprintOf(sessionId)) return true
    this.tooLarge.delete(key)
    return false
  }

  private acquirePart(p: ProducerV2, sessionId: string): Part {
    const key = this.partKey(sessionId, p.options)
    let part = this.parts.get(key)
    if (part === undefined || part.disposed) {
      part = new Part(key, sessionId, p.options)
      this.parts.set(key, part)
      const made = part
      made.unwatch = this.state.runs.sessions.watch(sessionId, () => this.markPart(made))
      made.poll = setInterval(() => this.pollPart(made), this.o.poll_ms)
    }
    part.producers.add(p)
    p.parts.set(sessionId, part)
    return part
  }

  private releasePart(p: ProducerV2, sessionId: string): void {
    const part = p.parts.get(sessionId)
    p.parts.delete(sessionId)
    if (part === undefined) return
    part.producers.delete(p)
    if (part.producers.size === 0) this.disposePart(part)
  }

  private disposePart(part: Part): void {
    if (part.disposed) return
    part.disposed = true
    if (part.timer) clearTimeout(part.timer)
    if (part.poll) clearInterval(part.poll)
    part.unwatch?.()
    part.frame = null
    if (this.parts.get(part.key) === part) this.parts.delete(part.key)
  }

  private disposeV2(p: ProducerV2): void {
    if (p.disposed) return
    p.disposed = true
    if (p.poll) clearInterval(p.poll)
    if (p.idle) clearTimeout(p.idle)
    p.frame = null
    for (const v of [...p.viewers]) this.end(v, 'server_closing')
    for (const id of [...p.parts.keys()]) this.releasePart(p, id)
    if (this.producersV2.get(p.key) === p) this.producersV2.delete(p.key)
    this.closeProjectorWhenIdle()
  }

  private readMemberPrint(p: ProducerV2): string | null {
    if (p.task_root_id === null) return null
    try {
      return JSON.stringify(this.state.conn.all('SELECT id, status FROM sessions WHERE id=? OR task_root_id=? ORDER BY id', [p.task_root_id, p.task_root_id]))
    } catch { return null }
  }

  private pollMembers(p: ProducerV2): void {
    if (p.disposed || p.viewers.size === 0) return
    const print = this.readMemberPrint(p)
    if (print === null || print === p.memberPrint) return
    p.memberPrint = print
    this.refreshMembers(p)
  }

  /** The projection's sessions read again: a deleted one's part goes at once (the rest is put together again and sent
   *  without it), a new one's part is made; no session left ends its links (`session_deleted`); more parts than the
   *  listener can hold ends its streams `busy` (never a state with a session missing) and lets it go. */
  private refreshMembers(p: ProducerV2): void {
    if (p.disposed) return
    const next = this.membersOf(p)
    if (next.length === 0) { this.projectionGone(p); return }
    const removed = [...p.parts.keys()].filter((id) => !next.includes(id))
    const added = next.filter((id) => !p.parts.has(id))
    if (removed.length || added.length) {
      // the set changed: the cached frame is no state of it any more (a new viewer waits for the new one), no pending
      // frame of the old set is released, and a viewer with bytes of a session that left still queued is cut (it
      // reconnects to the new state) — nothing of a deleted session is delivered from here on
      p.memberVersion++
      p.frame = null
      for (const v of [...p.viewers]) {
        v.pending = null
        if (removed.length && !v.idle) this.abortViewer(v)
      }
    }
    for (const id of removed) this.releasePart(p, id)
    const fresh = added.filter((id) => !this.parts.has(this.partKey(id, p.options))).length
    if ((fresh > 0 && this.cost() + fresh > LIVE_SHARE_LIMITS.max_projections) || added.some((id) => this.knownTooLarge(this.partKey(id, p.options), id))) { this.overCapacity(p); return }
    for (const id of added) { p.keyOf(id); const part = this.acquirePart(p, id); this.schedulePart(part, true) }
    p.members = next
    this.assemble(p)
  }

  /** No session of the projection is left: its links end for good (a task's revoked as session_deleted). */
  private projectionGone(p: ProducerV2): void {
    const at = new Date(this.now()).toISOString()
    if (p.task_root_id !== null) revokeTaskLinks(this.state.conn, p.task_root_id, 'session_deleted', at)
    else if (p.session_id !== null) revokeSessionLinks(this.state.conn, p.session_id, 'session_deleted', at)
    for (const v of [...p.viewers]) this.end(v, 'session_deleted')
    this.disposeV2(p)
  }

  /** The task grew past what the listener can hold: its streams end `busy` (the viewer tries again later), its
   *  projection and the parts only it used are let go. */
  private overCapacity(p: ProducerV2): void {
    for (const v of [...p.viewers]) this.end(v, 'busy')
    this.disposeV2(p)
  }

  /** The projection's frame from its parts — only when every session it shows has one — sent when it changed. */
  private assemble(p: ProducerV2): void {
    if (p.disposed) return
    const members = p.members
    const parts = members.map((id) => p.parts.get(id)?.frame ?? null)
    if (parts.some((f) => f === null)) return
    // a part sanitized under folders that are no longer its task's (a session of another project joined, a root
    // changed) is never sent: it and every frame made of it are dropped, and it is built again
    for (const id of members) {
      const part = p.parts.get(id)!
      if (part.frame!.context !== this.contextOf(id)) { this.invalidatePart(part); return }
    }
    // a session deleted since its part was made is never sent
    const alive = new Set(this.state.conn.all(`SELECT id FROM sessions WHERE status<>? AND id IN (${members.map(() => '?').join(',')})`, [repo.DELETED_SESSION, ...members]).map((r) => String(r.id)))
    if (members.some((id) => !alive.has(id))) { this.refreshMembers(p); return }
    const current = p.task_root_id !== null ? (members.includes(p.task_root_id) ? p.task_root_id : members[0]!) : members[0]!
    const options = { include_tool_details: p.options.include_tool_details, include_images: p.options.include_images, include_task_sessions: p.task_root_id !== null }
    const limits = { ...SHARE_LIMITS, ...LIVE_SHARE_LIMITS_V2 }
    const title = parts[members.indexOf(current)]!.title
    const fixed = { title, scope: p.task_root_id !== null ? 'task' : 'session', current: p.keyOf(current), options }
    const head = `{"format":${JSON.stringify(LIVE_SHARE_FORMAT)},"version":${LIVE_SHARE_VERSION_V2},"generated_at":${JSON.stringify(new Date(this.now()).toISOString())},`
      + `"title":${JSON.stringify(fixed.title)},"scope":${JSON.stringify(fixed.scope)},"current":${JSON.stringify(fixed.current)},"options":${JSON.stringify(options)},"sessions":[`
    const tail = `],"limits":${JSON.stringify(limits)}}`
    const chunks: Uint8Array[] = [encoder.encode(head)]
    let envelope = head.length + tail.length
    const images = new Map<string, { session_id: string; asset_id: string }>()
    const hash = createHash('sha256').update(JSON.stringify({ fixed, limits }))
    members.forEach((id, i) => {
      const f = parts[i]!
      const key = p.keyOf(id)
      const [prefix, body] = keyedPart(f.bytes, key)
      if (i > 0) { chunks.push(encoder.encode(',')); envelope += 1 }
      chunks.push(prefix!, body!)
      envelope += prefix!.length
      hash.update(`\0${key}\0${f.hash}`)
      for (const [resource, asset] of f.images) images.set(resource, { session_id: id, asset_id: asset })
    })
    chunks.push(encoder.encode(tail))
    const digest = hash.digest('hex')
    const total = chunks.reduce((n, c) => n + c.length, 0)
    if (envelope > LIVE_SHARE_LIMITS_V2.max_envelope_bytes || total > LIVE_SHARE_LIMITS.max_state_bytes - 1024) {
      logInternal('the live share v2 frame', new Error(`a frame past its bound (${total} bytes, envelope ${envelope})`))
      return
    }
    if (digest === p.frame?.hash) return
    p.revision++
    p.frame = { chunks, hash: digest, images, members: [...members] }
    for (const v of [...p.viewers]) this.sendIsolated(v)
  }

  /** The sessions the projection's frame holds are still exactly its sessions (read again now, not on the poll). */
  private membersCurrent(p: ProducerV2): boolean {
    const scope = p.task_root_id !== null
      ? this.state.conn.all('SELECT id FROM sessions WHERE status<>? AND (id=? OR task_root_id=?)', [repo.DELETED_SESSION, p.task_root_id, p.task_root_id])
      : this.state.conn.all('SELECT id FROM sessions WHERE status<>? AND id=?', [repo.DELETED_SESSION, p.session_id])
    const now = new Set(scope.map((r) => String(r.id)))
    const held = p.frame?.members ?? p.members
    return now.size === held.length && held.every((id) => now.has(id)) && p.members.length === held.length
  }

  /** A v2 viewer's link still works AND its projection still shows exactly the sessions it did (else the projection
   *  reads its sessions again — dropping, cutting or re-sending as refreshMembers says — and nothing goes now). */
  private stillValidV2(v: Viewer, p: ProducerV2): boolean {
    if (!this.stillValid(v)) return false
    if (!this.membersCurrent(p)) { this.refreshMembers(p); return false }
    return !v.closed
  }

  /** Cut one viewer's stream at once (nothing queued for it is delivered); its client reconnects. */
  private abortViewer(v: Viewer): void {
    if (v.closed) return
    this.detach(v)
    try { v.controller.error(new Error('the shared sessions changed')) } catch { /* already ended */ }
  }

  private sendV2(v: Viewer, p: ProducerV2): void {
    if (v.closed || p.frame === null) return
    if (!this.stillValidV2(v, p)) return
    if (p.frame === null) return
    const start = p.frame.members.includes(v.link.session_id) ? p.keyOf(v.link.session_id) : null
    const head = `event: state\nid: ${p.epoch}.${p.revision}\ndata: {"epoch":"${p.epoch}","revision":${p.revision},"expires_at":${JSON.stringify(v.link.expires_at)},"start":${JSON.stringify(start)},"snapshot":`
    v.offer([encoder.encode(head), ...p.frame.chunks, encoder.encode('}\n\n')], this.now(), p.memberVersion)
  }

  private streamV2(req: Request, link: LinkRow): Response {
    if (this.viewerCount >= LIVE_SHARE_LIMITS.max_viewers_total || this.viewersOf(link.id) >= LIVE_SHARE_LIMITS.max_viewers_per_link) return errorResponse(429, 'busy')
    const producer = this.producerV2For(link)
    if (producer === 'gone') return errorResponse(410, 'gone', 'session_deleted')
    if (producer === 'busy') return errorResponse(503, 'busy')
    const viewer = new Viewer(link, producer, this.now())
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => { viewer.controller = controller },
      pull: (controller) => {
        // a pending frame goes only while the link works, the projection's sessions are what they were, and the frame
        // was made under the current set
        try { viewer.pull(this.now(), () => this.stillValidV2(viewer, producer) && viewer.pendingVersion === producer.memberVersion && this.contextsCurrent(producer) && !viewer.closed && viewer.pendingVersion === producer.memberVersion) } catch (error) { this.fail(viewer, controller, 'GET /live/api/stream (stream)', error) }
      },
      cancel: () => { this.detach(viewer) },
    }, new ByteLengthQueuingStrategy({ highWaterMark: HIGH_WATER }))
    this.attach(viewer)
    req.signal.addEventListener('abort', () => this.detach(viewer), { once: true })
    try {
      // the sessions read again first (one joined or left while nobody watched), then the latest state, then whatever
      // part may be behind
      if (producer.task_root_id !== null) this.pollMembers(producer)
      // a new projection whose parts other projections already built has its state at once
      if (producer.frame === null) this.assemble(producer)
      if (producer.frame !== null && !viewer.closed && this.contextsCurrent(producer)) this.send(viewer)
      for (const part of producer.parts.values()) if (part.frame === null || part.dirty) this.schedulePart(part, part.frame === null)
    } catch (error) {
      this.detach(viewer)
      throw error
    }
    return new Response(body, { headers: { ...SECURITY_HEADERS, 'content-type': 'text/event-stream; charset=utf-8', 'x-accel-buffering': 'no' } })
  }

  /** A v2 picture: only a resource of the projection's CURRENT frame, of a session it still shows and that is not
   *  deleted — checked before and after the bytes are read. */
  private async imageV2(link: LinkRow, resource: string): Promise<Response> {
    const producer = this.producersV2.get(this.v2Key(link))
    const entry = producer?.frame?.images.get(resource)
    if (producer === undefined || producer.disposed || entry === undefined) return errorResponse(404, 'not_found')
    const part = producer.parts.get(entry.session_id)
    const alive = () => { const s = repo.getSession(this.state.conn, entry.session_id); return s !== null && s.status !== repo.DELETED_SESSION }
    if (part === undefined || !alive()) return errorResponse(404, 'not_found')
    if (this.imagesInFlight >= 8) return errorResponse(429, 'busy')
    this.imagesInFlight++
    let reply: Awaited<ReturnType<Projector['image']>>
    try { reply = await this.projector.image({ session_id: entry.session_id, asset_id: entry.asset_id, resource, salt: part.salt, protocol: 2 }) } catch { reply = { ok: false } } finally { this.imagesInFlight-- }
    const gone = this.goneReason(link)
    if (gone !== null) return errorResponse(410, 'gone', gone)
    const now = producer.frame?.images.get(resource)
    if (producer.disposed || now === undefined || now.session_id !== entry.session_id || now.asset_id !== entry.asset_id || !producer.parts.has(entry.session_id) || !alive()) return errorResponse(404, 'not_found')
    if (!reply.ok) return errorResponse(404, 'not_found')
    return new Response(reply.bytes, { headers: { ...SECURITY_HEADERS, 'content-type': reply.media_type, 'content-length': String(reply.bytes.length) } })
  }

  private markPart(part: Part): void {
    if (part.disposed) return
    part.dirty = true
    this.schedulePart(part, false)
  }

  /** The v1 producer's coalescing, per part: ~debounce after a change, never sooner than max(min interval, 5 × the last
   *  build's cost, the failure back-off) after the last build, one build at a time, only while someone watches. */
  private schedulePart(part: Part, urgent: boolean): void {
    if (part.disposed || !part.watched) return
    if (part.building) { part.dirty = true; return }
    if (part.timer !== null) return
    const gap = Math.max(this.o.min_interval_ms, Math.min(30_000, 5 * part.lastBuildMs), part.failures ? Math.min(30_000, 1000 * 2 ** part.failures) : 0)
    const wait = Math.max(urgent && part.frame === null && !part.failures ? 0 : this.o.debounce_ms, part.lastBuildAt + gap - this.now())
    part.timer = setTimeout(() => {
      part.timer = null
      this.buildPart(part).catch((error) => {
        logInternal('the live share v2 projection', error)
        if (part.disposed) return
        part.failures = Math.min(part.failures + 1, 5)
        part.dirty = true
        this.schedulePart(part, false)
      })
    }, Math.max(0, wait))
  }

  private async buildPart(part: Part): Promise<void> {
    if (part.disposed || !part.watched || part.building) return
    part.building = true
    part.dirty = false
    part.fingerprint = this.readFingerprintOf(part.session_id)
    const context = this.contextOf(part.session_id)
    const started = this.now()
    let reply: Awaited<ReturnType<NonNullable<Projector['part']>>>
    try {
      reply = this.projector.part
        ? await this.projector.part({ session_id: part.session_id, options: part.options, salt: part.salt, runs: this.captureRuns(part.session_id),
          max_bytes: this.maxPartBytes, row_keys: [...part.rowKeys] })
        : { ok: false, code: 'error' }
    } catch {
      reply = { ok: false, code: 'error' }
    } finally {
      part.building = false
    }
    part.lastBuildAt = this.now()
    part.lastBuildMs = reply.ok ? reply.build_ms : this.now() - started
    if (part.disposed) return
    if (!reply.ok) {
      if (reply.code === 'gone') { this.memberGone(part.session_id); return }
      if (reply.code === 'too_large') {
        // never sent cut further, never rebuilt in a loop: every projection showing it ends busy, and the session is
        // refused (busy) without a build until it changes
        if (this.tooLarge.size >= 256) this.tooLarge.delete(this.tooLarge.keys().next().value!)
        this.tooLarge.set(part.key, part.fingerprint)
        for (const p of [...part.producers]) this.overCapacity(p)
        return
      }
      part.failures = Math.min(part.failures + 1, 5)
      part.dirty = true
    } else {
      part.failures = 0
      this.tooLarge.delete(part.key)
      part.rowKeys = new Map(reply.row_keys)
      if (context === null || this.contextOf(part.session_id) !== context) {
        // the task's folders changed while it was built: it may be sanitized under the old ones — never used; again
        part.dirty = true
      } else if (reply.hash !== part.frame?.hash || part.frame.context !== context) {
        part.frame = { bytes: reply.part, hash: reply.hash, images: new Map(reply.images), title: reply.title, context }
        for (const p of [...part.producers]) this.assemble(p)
      }
    }
    if (part.dirty) this.schedulePart(part, false)
  }

  /** A part's session is gone (its build found it deleted): every projection showing it reads its sessions again. */
  private memberGone(sessionId: string): void {
    for (const p of [...this.producersV2.values()]) if (p.parts.has(sessionId)) this.refreshMembers(p)
  }

  private readFingerprintOf(sessionId: string): string | null {
    try { return JSON.stringify(this.state.conn.get(FINGERPRINT_SQL, [sessionId])) } catch { return null }
  }

  private pollPart(part: Part): void {
    if (part.disposed || !part.watched || part.building) return
    // the task's folders first: a part sanitized under old ones is dropped at once, its frames with it
    if (part.frame !== null && part.frame.context !== this.contextOf(part.session_id)) { this.invalidatePart(part); return }
    const print = this.readFingerprintOf(part.session_id)
    if (print === null) return
    if (print !== part.fingerprint) { part.fingerprint = print; this.markPart(part) }
  }

  /** test hooks: how many v2 projections and parts live */
  get producerV2Count(): number { return this.producersV2.size }
  get partCount(): number { return this.parts.size }

  // ---- time -----------------------------------------------------------------------------------------------------------

  /** One timer at the nearest expiry of a link someone watches: an expiry ends its streams on time, by itself. */
  private armExpiry(): void {
    if (this.expiryTimer) { clearTimeout(this.expiryTimer); this.expiryTimer = null }
    let soonest = Infinity
    for (const v of this.allViewers()) soonest = Math.min(soonest, Date.parse(v.link.expires_at))
    if (soonest === Infinity) return
    const wait = Math.min(Math.max(0, soonest - this.now()), 2_147_000_000)
    this.expiryTimer = setTimeout(() => { this.expiryTimer = null; this.sweepExpired(); this.armExpiry() }, wait + 5)
  }

  private sweepExpired(): void {
    const now = this.now()
    for (const v of [...this.allViewers()]) if (Date.parse(v.link.expires_at) <= now) this.end(v, 'expired')
  }

  /** The heartbeat: a comment to each quiet stream; expiry checked; a stream that has not drained for stall_ms closed. */
  private sweep(): void {
    const now = this.now()
    this.sweepExpired()
    for (const v of [...this.allViewers()]) {
      if (v.pending !== null && now - v.lastDrain > this.o.stall_ms) { this.end(v, 'server_closing'); continue }
      if (v.idle) { try { v.controller.enqueue(encoder.encode(': keep-alive\n\n')) } catch { this.detach(v) } }
    }
  }

  /** test hooks: run the sweep now; how many producers live */
  sweepNow(): void { this.sweep() }
  get producerCount(): number { return this.producers.size }
  get listeningPort(): number | null { return this.server?.port ?? null }
}

/** An origin as the copied link names it: http(s)://host[:port], no path, query, fragment or user info. */
export function normalizeBaseUrl(raw: string | null): string | null {
  if (raw === null) return null
  const text = raw.trim()
  if (text === '') return null
  let url: URL
  try { url = new URL(text) } catch { throw new HttpError(422, 'public_base_url: an http(s) origin like https://share.example.com') }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new HttpError(422, 'public_base_url: an http(s) origin only (no path, query, fragment or user name)')
  }
  return url.origin
}
