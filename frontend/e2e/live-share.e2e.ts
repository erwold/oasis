/** Live read-only session sharing, end to end, in real headless Chrome against the scripted e2e backend
 *  (backend-ts/scripts/e2e_server.ts; its route `scripted:live`, backend-ts/scripts/live_share_fixture.ts) and the
 *  product's own share listener on a real TCP port. Nothing reaches a network: the models are scripted, the share
 *  listener is loopback-only, and the "public origin" the copied links name is a tunnel of this test's own — a TCP
 *  relay on another loopback port that forwards bytes unchanged, records every byte the viewer received, and can cut
 *  every connection or refuse new ones (a viewer's network going away).
 *
 *  What it proves (contract/src/live_share.ts, handoff/live-share-api.md of the backend worktree):
 *  - the listener is off by default (loopback, 8325), refuses bad settings, says when its port is taken, and maps
 *    loopback / LAN / a public base URL into the link's origin;
 *  - a link is made from the app while a run is active (options: tool details, images; a run left out), copied, and
 *    copied again after its dialog was closed — closing never revokes;
 *  - a viewer sees the run work: the run running, its words, its tools (a sensitive one withheld whole, a harmless one
 *    with its bearer redacted), the answer while it is written, a second update, a picture with its metadata stripped;
 *  - the viewer has no control that would change anything: no composer, send, stop, cancel, approve;
 *  - every byte a viewer received (the browser's own traffic, decoded from the tunnel's HTTP/1.1 frames, and the
 *    stream as a node client read it) holds no secret of the session — split secrets included: each secret of the
 *    answer is cut between two streamed pieces, and the stream is checked after every piece;
 *  - the option boundaries: tools off carries no tool details, images off no picture, an excluded run (the run being
 *    written included) is nowhere; a picture of another projection is 404;
 *  - a cut connection, new work while it is away, a reconnection: one whole state, no duplicate;
 *  - revoking ends an open viewer at once (the `ended` frame, the connection closed, no reconnection), and work after
 *    it never reaches any viewer; expiry does the same to a connected viewer (the link's stored expiry brought near by
 *    the e2e server's own test route — the product's five-minute minimum untouched); a 30-day link stays open;
 *  - the listener answers its exact GETs only: every other path, method, query, upgrade or body is refused, and nothing
 *    of the app, its token, the gateway's routes or this test server's own routes is reachable through it.
 *
 *  Every value is synthetic (backend-ts/scripts/live_share_canaries.ts): Alice and Bob, keys and paths put together at
 *  run time. The evidence (screenshots, the decoded traffic's scan, the frames' summary, the server log) goes to
 *  OASIS_CODE_LIVE_SHARE_OUT (default: handoff/live-share-e2e/ at the repository's root — never committed).
 *
 *  Protocol 2 (contract/src/live_share.ts v2; backend-ts/scripts/live_share_fixture.ts TASK_*): the app makes its links as v2
 *  now (the main link here: one session, frames of version 2, read through the same assertions as v1's), while the
 *  links made through the frozen v1 route keep answering v1 frames. A task's link (made with "All sessions in this task",
 *  off by default) shows every session of the task not deleted, across projects: one link, its sessions joining and
 *  leaving, their state (a session working), the session shown deleted (the page falls back), the task's first session
 *  deleted with members left (the link goes on), every session deleted (session_deleted); each session's pictures its
 *  own; revoked or expired, the whole view ends and its pictures are refused at once; the listener's projection budget
 *  (eight parts) never shows a task with sessions missing (`busy`) and takes the viewers back once there is room.
 *
 *  Run alone, after `npm run build`: node --test --test-concurrency=1 e2e/live-share.e2e.ts — port 8399 (or
 *  OASIS_CODE_E2E_PORT) is waited for while another process holds it, never taken or killed. The UI built elsewhere:
 *  OASIS_CODE_E2E_DIST=<its frontend/dist>. The backend is started with the shell's app variables removed. */

import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { crc32, deflateSync } from 'node:zlib'
import { createWriteStream, existsSync, mkdirSync, writeFileSync, type WriteStream } from 'node:fs'
import { connect as tcpConnect, createServer, type Server, type Socket } from 'node:net'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
import {
  LIVE_CASES, LIVE_GATES, LIVE_HOME_USER, LIVE_MARKS, LIVE_SECRETS, LIVE_SESSION_TITLE, LIVE_WHOLE, liveAnswerPieces,
} from '../../backend-ts/scripts/live_share_canaries.ts'


// ---- the task share's synthetic values: the same as backend-ts/scripts/live_share_fixture.ts TASK_* (its route reads them;
// change them in all three places). Shapes of a credential, a home path or a mailbox are put together at run time.
const joinTask = (...pieces: string[]): string => pieces.join('')

/** The route the task fixtures run (live_share_fixture.ts). */
const TASK_ROUTE = 'scripted:task'

/** The words that pick a case of `scripted:task` (each a marker in the person's message, followed by its mark):
 *  - MARK <mark>: one answer naming the mark, the session's mailbox and home path (both redacted in any share);
 *  - TOOL <mark>: one harmless command that prints a bearer header (redacted) and the mark, then the answer;
 *  - HOLD <mark>: held before its answer (gate TASK_GATES.hold(mark)), so a session of the task is active. */
const TASK_CASES = { mark: 'TASK_CASE_MARK', tool: 'TASK_CASE_TOOL', hold: 'TASK_CASE_HOLD' } as const

/** The gates of `scripted:task` (released by the test: POST /e2e/ui-release?gate=<name> on the APP's port). */
const TASK_GATES = {
  hold: (mark: string): string => `task-hold-${mark.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
} as const

/** The sessions of the fixtures, by role. `root` is the task's first session; `a` joins it from the same project; `b`
 *  joins it (through `a`) from ANOTHER project; `c` joins it and is deleted; `side` is a task of its own; `late` joins
 *  the live task after its link was made; `k*` are the capacity task's. */
type TaskRole = 'root' | 'a' | 'b' | 'c' | 'side' | 'late'

const TASK_TITLES: Record<TaskRole, string> = {
  root: 'Task root · Carol plans (synthetic)',
  a: 'Member A · Dave builds (synthetic)',
  b: 'Member B · Erin reviews elsewhere (synthetic)',
  c: 'Member C · deleted later (synthetic)',
  side: 'Side task · Frank alone (synthetic)',
  late: 'Member D · joined later (synthetic)',
}

/** Each session's own mark: present in its own session's share, never in another's. A deleted session's and the side
 *  task's marks must never be in a task share. */
const TASK_MARKS: Record<TaskRole, string> = {
  root: 'TASKROOTMARK_1c4e',
  a: 'TASKMEMBERAMARK_7b2d',
  b: 'TASKMEMBERBMARK_3f9a',
  c: 'TASKDELETEDMARK_5e0c',
  side: 'TASKSIDEMARK_8d1b',
  late: 'TASKLATEMARK_2a6f',
}

/** Each session's picture: its own size (the share's re-encoded picture keeps it), so a picture shown is known to be
 *  the session's by its natural size alone, whatever its key (every session's first picture is `img1`); its own colour;
 *  its own metadata canary in a tEXt chunk (stripped by any share). */
const TASK_IMAGES: Record<TaskRole, { w: number; h: number; rgb: [number, number, number]; meta: string }> = {
  root: { w: 30, h: 18, rgb: [210, 40, 40], meta: 'TASKPNGMETAROOT_9a1f' },
  a: { w: 18, h: 30, rgb: [40, 170, 60], meta: 'TASKPNGMETAA_4c7e' },
  b: { w: 26, h: 26, rgb: [40, 70, 210], meta: 'TASKPNGMETAB_6d2b' },
  c: { w: 22, h: 14, rgb: [200, 160, 30], meta: 'TASKPNGMETAC_1e8a' },
  side: { w: 20, h: 20, rgb: [150, 40, 170], meta: 'TASKPNGMETASIDE_3b5c' },
  late: { w: 14, h: 22, rgb: [30, 160, 170], meta: 'TASKPNGMETALATE_7f0d' },
}

/** a synthetic account name (only ever written into a path at run time) */
const TASK_HOME_USER = joinTask('tasksyn', 'thusr')

/** Values that must never reach a share (offline file or live viewer), whole: built at run time. */
const TASK_SECRETS = {
  mail_local: joinTask('carol', '.synthetic'),
  mail: joinTask('carol', '.synthetic', '@', 'example', '.org'),
  home: joinTask('/', 'Users', '/', TASK_HOME_USER, '/plans/task-notes.md'),
  home_user: TASK_HOME_USER,
  bearer: joinTask('TASKBEARER', 'abcdef0123456789'),
} as const




const PORT = Number(process.env.OASIS_CODE_E2E_PORT ?? 8399)
const BASE = `http://127.0.0.1:${PORT}`
// the UI under test: OASIS_CODE_E2E_DIST (the director's integration build), else this worktree's own build (the shell's
// OASIS_CODE_FRONTEND_DIST is never read: it may name the person's own app)
const DIST = resolve(process.env.OASIS_CODE_E2E_DIST || fileURLToPath(new URL('../dist', import.meta.url)))
/** the test's backend gets none of the shell's variables of the person's own app or of a model provider (only the e2e's
 *  own OASIS_CODE_E2E_* switches stay), and the UI under test */
function backendEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const k of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CLAUDE_CODE_MESSAGING_TOKEN']) delete env[k]
  for (const k of Object.keys(env)) if (k.startsWith('OASIS_CODE_') && !k.startsWith('OASIS_CODE_E2E_')) delete env[k]
  env.OASIS_CODE_FRONTEND_DIST = DIST
  return env
}
const OUT = resolve(process.env.OASIS_CODE_LIVE_SHARE_OUT || fileURLToPath(new URL('../../handoff/live-share-e2e', import.meta.url)))
const SESSION_TOKEN = 'e2e-token' // the e2e server's session token: never in anything a viewer receives
const LIVE_ROUTE = 'scripted:live'

// ---- the contract's values (contract/src/live_share.ts), restated: a drift fails here, loudly ----------------------
const DEFAULT_SETTINGS = { enabled: false, bind: 'loopback', port: 8325, public_base_url: null }
const CAPABILITY = /^[A-Za-z0-9_-]{43}$/
const LINK_ID = /^sl_[A-Za-z0-9_-]{22}$/
const IMAGE_RESOURCE = /^m[0-9a-f]{24}$/
const LIVE_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; font-src data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'"
const PATHS = { page: '/live/', script: '/live/assets/live-share.js', style: '/live/assets/live-share.css', stream: '/live/api/stream', image: '/live/api/image/' }

/** The pages' test ids, as the UI worktree has them (its handoff/live-share-ui-testids.md). The header keeps its one
 *  share icon (`share-open`): idle it opens the dialog on HTML, busy on Live link; `share-mode-live` picks Live. The
 *  dialog is `share-dialog` (data-mode html|live); the Live panel inside it is `live-share-dialog`, and its close button
 *  (`live-share-close`) is the dialog's own, outside the panel. */
const SEL = {
  session: (id: string) => `[data-testid="session-${id}"]`,
  open: '[data-testid="share-open"]',
  shareDialog: '[data-testid="share-dialog"]',
  modeLive: '[data-testid="share-mode-live"]',
  dialog: '[data-testid="live-share-dialog"]',
  service: '[data-testid="live-share-service"]',
  tools: '[data-testid="live-share-tools"]',
  images: '[data-testid="live-share-images"]',
  expiry: '[data-testid="live-share-expiry"]',
  create: '[data-testid="live-share-create"]',
  url: '[data-testid="live-share-url"]',
  copy: '[data-testid="live-share-copy"]',
  close: '[data-testid="live-share-close"]',
  link: (id: string) => `[data-testid="live-share-link"][data-link-id="${id}"]`,
  linkCopy: '[data-testid="live-share-link-copy"]',
  linkRevoke: '[data-testid="live-share-link-revoke"]',
  revokeConfirm: '[data-testid="live-share-revoke-confirm"]',
  // Settings › Connections › Live sharing (from `/`: the rail's settings launcher, then the Connections tab)
  settingsLauncher: '[data-testid="settings"]',
  settingsTab: '[data-testid="settings-tab-connections"]',
  settings: '[data-testid="live-share-settings"]',
  settingsEnabled: '[data-testid="live-share-enabled"]',
  settingsBind: '[data-testid="live-share-bind"]',
  settingsPort: '[data-testid="live-share-port"]',
  settingsBase: '[data-testid="live-share-base-url"]',
  settingsSave: '[data-testid="live-share-save"]',
  settingsStatus: '[data-testid="live-share-status"]',
  // the viewer page: its root carries data-phase (connecting | connected | reconnecting | ended) and, once ended,
  // data-ended-reason; the thread is the share viewer's own
  viewer: '[data-testid="live-viewer"]',
  viewerThread: '[data-testid="live-viewer"] [data-testid="thread"]',
  viewerEnded: '[data-testid="live-ended"]',
  // protocol 2: every session of the task (off by default) in the Live panel
  task: '[data-testid="live-share-task"]',
  // the v2 viewer (the share page's own SessionList and TeamCard, as the offline page draws them): the list of the
  // task's sessions, an entry, its dot while the session works, the entry of the session shown (aria-current; the live
  // thread itself names no session), the card
  viewerSessions: '[data-testid="live-viewer"] [data-testid="share-sessions"]',
  viewerEntries: '[data-testid="live-viewer"] [data-testid="share-sessions"] button.rail-session',
  viewerSession: (key: string) => `[data-testid="live-viewer"] [data-testid="share-session-${key}"]`,
  viewerDot: (key: string) => `[data-testid="live-viewer"] [data-testid="share-session-dot-${key}"]`,
  viewerShown: '[data-testid="live-viewer"] [data-testid="share-sessions"] button.rail-session[aria-current="page"]',
  viewerCard: '[data-testid="live-viewer"] [data-testid="graph-dock"]',
  // a v2 viewer paused while the listener cannot hold its whole task: its note (live-paused), its reason on the status
  // (live-status[data-reason]) and on the page's root (live-viewer[data-ended-reason]); cleared, it tries again
  viewerPaused: '[data-testid="live-paused"]',
  viewerStatus: '[data-testid="live-viewer"] [data-testid="live-status"]',
}

/** callers the owner's routes refuse: a connector, a director tool surface, a director session, the agent's browser */
const NOT_OWNER: Record<string, string>[] = [{ 'x-oasis-code-connector': 'ChatGPT' }, { 'x-oasis-tool-surface': 'v5' }, { 'x-oasis-director-session-id': 'ds_synthetic' }, { 'x-oasis-code-agent-browser': '1' }]

/** testids of every control that would act on a session: none may exist on the viewer page */
const MUTATION_TESTIDS = ['composer', 'send', 'stop', 'replay', 'share-open', 'live-share-open', 'undo-run', 'steer-put-back', 'waiting-stop-command', 'waiting-cancel',
  'approvals', 'approve-proposal', 'approval', 'review-approvals', 'interaction-continue', 'relay-continue', 'node-adopt', 'failure-accounts', 'failure-chatgpt', 'opened-session']

// ---- every value a viewer must never receive -------------------------------------------------------------------------
const S = LIVE_SECRETS
const SECRETS: Record<string, string> = {
  dotenv: S.dotenv, env: S.env, auth: S.auth, tool_bearer: S.tool_bearer,
  key_head: S.key_head, key_tail: S.key_tail, key_whole: LIVE_WHOLE.key,
  mail_local: S.mail_local, bearer_head: S.bearer_head, bearer_tail: S.bearer_tail,
  home_user: LIVE_HOME_USER, home_head: `/${S.home_head}`,
  pem_line_1: S.pem_line_1, pem_line_2: S.pem_line_2, yaml_line_1: S.yaml_line_1, yaml_line_2: S.yaml_line_2,
  png_meta: S.png_meta, session_token: SESSION_TOKEN,
  // the task's (live_share_fixture.ts TASK_*): its mailbox, home path and bearer, every picture's metadata
  task_mail: TASK_SECRETS.mail, task_home_user: TASK_HOME_USER, task_bearer: TASK_SECRETS.bearer,
  ...Object.fromEntries((Object.keys(TASK_IMAGES) as TaskRole[]).map((r) => [`task_png_meta_${r}`, TASK_IMAGES[r].meta])),
}

let server: ChildProcess | null = null
let serverExit: Promise<number | null> | null = null
let serverLog: WriteStream | null = null
let info: { token: string; repo: string; repo_b: string; data: string }
let browser: Browser
let tunnel: Tunnel
let LIVE_PORT = 0
const results: Record<string, unknown> = { out: OUT }
const ids = { project: '', session: '', pre: '', eye: '', progress: '', approval: '', second: '', reconnect: '', asset: '' }
/** the protocol 2 fixtures' ids (real: never in anything a viewer receives) */
const L = { projectB: '', root: '', a: '', b: '', side: '', late: '', k: [] as string[], pair: [] as string[], assets: {} as Partial<Record<TaskRole, string>> }
/** the links: main (made in the app: tools + images), plain (defaults: tools and images off), excl (tools + images, the
 *  run before the link and the progress run left out) */
const links: Record<string, { id: string; cap: string; url: string | null }> = {}
const clients: Record<string, StreamClient> = {}
/** every viewer page's context this file opened (closed before the listener's budget is counted) */
const viewerContexts: BrowserContext[] = []

// ======================================================================================================================
// the tunnel: the links' public origin, a TCP relay that records what passes
// ======================================================================================================================

interface Conn { id: number; openedAt: number; closedAt: number | null; up: Buffer[]; down: { at: number; bytes: Buffer }[]; client: Socket; upstream: Socket }

class Tunnel {
  readonly target: number
  server: Server | null = null
  port = 0
  refusing = false
  readonly conns: Conn[] = []
  constructor(target: number) { this.target = target }
  get origin(): string { return `http://127.0.0.1:${this.port}` }

  async start(): Promise<void> {
    this.server = createServer((client) => {
      if (this.refusing) { client.destroy(); return }
      const upstream = tcpConnect(this.target, '127.0.0.1')
      const conn: Conn = { id: this.conns.length + 1, openedAt: Date.now(), closedAt: null, up: [], down: [], client, upstream }
      this.conns.push(conn)
      const close = () => { if (conn.closedAt === null) conn.closedAt = Date.now(); client.destroy(); upstream.destroy() }
      client.on('data', (d: Buffer) => { conn.up.push(Buffer.from(d)); upstream.write(d) })
      upstream.on('data', (d: Buffer) => { conn.down.push({ at: Date.now(), bytes: Buffer.from(d) }); client.write(d) })
      client.on('close', close); upstream.on('close', close)
      client.on('error', close); upstream.on('error', close)
    })
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', () => r()))
    this.port = (this.server.address() as { port: number }).port
  }
  /** every open connection cut at once (a network gone) */
  sever(): void { for (const c of this.conns) if (c.closedAt === null) { c.client.destroy(); c.upstream.destroy(); c.closedAt = Date.now() } }
  async stop(): Promise<void> { this.sever(); await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r())) }

  /** The HTTP exchanges of every connection: each request with its decoded response. */
  exchanges(): Exchange[] {
    return this.conns.flatMap((c) => {
      const reqs = decodeRequests(Buffer.concat(c.up))
      const resps = decodeResponses(Buffer.concat(c.down.map((d) => d.bytes)), c.closedAt !== null)
      return reqs.map((r, i) => ({ conn: c.id, openedAt: c.openedAt, closedAt: c.closedAt, request: r, response: resps[i] ?? null, downTimes: c.down.map((d) => d.at) }))
    })
  }
  /** every byte the share listener sent through the tunnel, as received (HTTP framing included) */
  rawDown(): Buffer { return Buffer.concat(this.conns.flatMap((c) => c.down.map((d) => d.bytes))) }
}

interface HttpRequest { method: string; target: string; headers: Record<string, string> }
interface HttpResponse { status: number; headers: Record<string, string>; body: Buffer; complete: boolean }
interface Exchange { conn: number; openedAt: number; closedAt: number | null; request: HttpRequest; response: HttpResponse | null; downTimes: number[] }

function parseHead(text: string): { first: string; headers: Record<string, string> } {
  const [first, ...lines] = text.split('\r\n')
  const headers: Record<string, string> = {}
  for (const l of lines) { const i = l.indexOf(':'); if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim() }
  return { first: first ?? '', headers }
}

/** a response that is over: its body finished by its framing, or its connection closed (a pooled keep-alive connection
 *  may outlive the response it carried) */
const streamEnded = (x: Exchange): boolean => x.closedAt !== null || x.response?.complete === true

/** HTTP/1.1 requests of one connection (GET-only traffic; a body by its content-length is skipped). */
function decodeRequests(buf: Buffer): HttpRequest[] {
  const out: HttpRequest[] = []
  let at = 0
  while (at < buf.length) {
    const end = buf.indexOf('\r\n\r\n', at)
    if (end < 0) break
    const { first, headers } = parseHead(buf.subarray(at, end).toString('latin1'))
    const [method = '', target = ''] = first.split(' ')
    out.push({ method, target, headers })
    at = end + 4 + Number(headers['content-length'] ?? 0)
  }
  return out
}

/** HTTP/1.1 responses of one connection, bodies decoded from their framing (content-length, chunked, or to the close). */
function decodeResponses(buf: Buffer, closed: boolean): HttpResponse[] {
  const out: HttpResponse[] = []
  let at = 0
  while (at < buf.length) {
    const end = buf.indexOf('\r\n\r\n', at)
    if (end < 0) break
    const { first, headers } = parseHead(buf.subarray(at, end).toString('latin1'))
    const status = Number(first.split(' ')[1])
    at = end + 4
    if ((headers['transfer-encoding'] ?? '').toLowerCase().includes('chunked')) {
      const parts: Buffer[] = []
      let complete = false
      for (;;) {
        const lineEnd = buf.indexOf('\r\n', at)
        if (lineEnd < 0) break
        const size = parseInt(buf.subarray(at, lineEnd).toString('latin1').split(';')[0]!, 16)
        if (!Number.isFinite(size)) break
        if (size === 0) { at = buf.indexOf('\r\n\r\n', lineEnd) >= 0 ? buf.indexOf('\r\n\r\n', lineEnd) + 4 : buf.length; complete = true; break }
        if (lineEnd + 2 + size > buf.length) { parts.push(buf.subarray(lineEnd + 2)); at = buf.length; break }
        parts.push(buf.subarray(lineEnd + 2, lineEnd + 2 + size))
        at = lineEnd + 2 + size + 2
      }
      out.push({ status, headers, body: Buffer.concat(parts), complete })
      if (!complete) break
    } else if (headers['content-length'] !== undefined) {
      const n = Number(headers['content-length'])
      out.push({ status, headers, body: buf.subarray(at, at + n), complete: at + n <= buf.length })
      at += n
    } else {
      out.push({ status, headers, body: buf.subarray(at), complete: closed })
      at = buf.length
    }
  }
  return out
}

// ======================================================================================================================
// the stream, read as a viewer would (node's fetch): every frame kept
// ======================================================================================================================

interface Frame { event: string; data: string; id: string | null; at: number; json: unknown }
/** A state frame as the legacy assertions read it: a v1 frame as it is; a v2 frame by the session it shows (its `start`,
 *  else the snapshot's `current`) in v1's shape (contract liveSessionAsV1, restated), the frame itself kept as `v2`. */
interface StateFrame { epoch: string; revision: number; expires_at: string; snapshot: Snapshot; v2?: StateFrameV2 }
interface TeamRow { key: string; parent: string | null; depends_on: string[]; kind: string; name: string; bot: string | null; model_label: string | null; status: string; glyph: string | null; participant_index: number | null; participant_label: string | null; runs: number; started_at: string; finished_at: string | null; turn: string | null }
interface LiveSessionV2 {
  key: string; title: string; member: boolean; active: boolean; bots: string[]; session: { created_at: string; last_activity_at: string; model_label: string }
  participants: unknown[]; runs: { key: string; status: string; bot: string | null; enclosed: boolean }[]; items: Item[]
  images: { resource: string; media_type: string; width: number; height: number; bytes: number }[]
  team: { rows: TeamRow[]; agents: number; live: number; truncated: boolean }; stats: Record<string, unknown>
}
interface SnapshotV2 { format: string; version: 2; generated_at: string; title: string; scope: 'session' | 'task'; current: string; options: { include_tool_details: boolean; include_images: boolean; include_task_sessions: boolean }; sessions: LiveSessionV2[]; limits: Record<string, number> }
interface StateFrameV2 { epoch: string; revision: number; expires_at: string; start: string | null; snapshot: SnapshotV2 }
function asState(json: unknown): StateFrame {
  const f = json as StateFrame | StateFrameV2
  if (f.snapshot.version !== 2) return f as StateFrame
  const v2 = f as StateFrameV2
  const s = v2.snapshot.sessions.find((x) => x.key === (v2.start ?? v2.snapshot.current)) ?? v2.snapshot.sessions[0]!
  const snapshot = {
    format: v2.snapshot.format, version: 2, title: s.title, session: { active: s.active },
    options: { include_tool_details: v2.snapshot.options.include_tool_details, include_images: v2.snapshot.options.include_images },
    runs: s.runs, items: s.items, images: s.images,
  } as unknown as Snapshot
  return { epoch: v2.epoch, revision: v2.revision, expires_at: v2.expires_at, snapshot, v2 }
}
interface Snapshot {
  format: string; version: number; title: string; session: { active: boolean }; options: { include_tool_details: boolean; include_images: boolean }
  runs: { key: string; status: string }[]; items: Item[]; images: { resource: string; media_type: string; width: number; height: number; bytes: number }[]
}
interface Item { kind: string; key: string; run: string | null; text?: string; name?: string; status?: string; target?: string | null; details?: { preview: string | null; fields?: { name: string; value: string | number | boolean }[] } | null; withheld?: string | null; withheld_tail?: boolean; image?: string | null; omitted?: string | null }

function parseSse(text: string, at = 0): Frame[] {
  const frames: Frame[] = []
  for (const block of text.replace(/\r\n?/g, '\n').split('\n\n')) {
    let event = 'message'; const data: string[] = []; let id: string | null = null
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue
      const i = line.indexOf(':')
      const field = i < 0 ? line : line.slice(0, i)
      const value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '')
      if (field === 'event') event = value
      else if (field === 'data') data.push(value)
      else if (field === 'id') id = value
    }
    if (!data.length) continue
    let json: unknown = null
    try { json = JSON.parse(data.join('\n')) } catch { json = null }
    frames.push({ event, data: data.join('\n'), id, at, json })
  }
  return frames
}

class StreamClient {
  readonly name: string
  status = 0
  headers: Record<string, string> = {}
  raw = ''
  frames: Frame[] = []
  closedAt: number | null = null
  private abort = new AbortController()
  private pending = ''
  done: Promise<void> = Promise.resolve()
  constructor(name: string) { this.name = name }

  static async open(name: string, origin: string, cap: string, extra: Record<string, string> = {}): Promise<StreamClient> {
    const c = new StreamClient(name)
    const res = await fetch(`${origin}${PATHS.stream}`, { headers: { authorization: `Bearer ${cap}`, accept: 'text/event-stream', ...extra }, signal: c.abort.signal })
    c.status = res.status
    res.headers.forEach((v, k) => { c.headers[k] = v })
    if (!res.ok || !res.body) { c.raw = await res.text().catch(() => ''); c.closedAt = Date.now(); return c }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
    c.done = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          c.raw += value
          c.pending += value
          const cut = c.pending.replace(/\r\n?/g, '\n').lastIndexOf('\n\n')
          if (cut >= 0) {
            const norm = c.pending.replace(/\r\n?/g, '\n')
            c.frames.push(...parseSse(norm.slice(0, cut), Date.now()))
            c.pending = norm.slice(cut + 2)
          }
        }
      } catch { /* aborted or cut */ }
      c.closedAt = Date.now()
    })()
    return c
  }
  close(): void { this.abort.abort() }
  states(): StateFrame[] { return this.frames.filter((f) => f.event === 'state').map((f) => asState(f.json)) }
  /** the v2 frames as sent (a v1 link sends none) */
  v2(): StateFrameV2[] { return this.frames.filter((f) => f.event === 'state' && (f.json as StateFrameV2 | null)?.snapshot?.version === 2).map((f) => f.json as StateFrameV2) }
  lastV2(): StateFrameV2 | null { return this.v2().at(-1) ?? null }
  last(): StateFrame | null { return this.states().at(-1) ?? null }
  ended(): string | null { const f = this.frames.find((x) => x.event === 'ended'); return f ? String((f.json as { reason?: string } | null)?.reason) : null }
  async waitFor(what: string, pred: (c: StreamClient) => boolean, ms = 30_000): Promise<void> {
    const t0 = Date.now()
    while (!pred(this)) {
      if (Date.now() - t0 > ms) throw new Error(`${this.name}: timed out waiting for ${what} (frames ${this.frames.length}, closed ${this.closedAt !== null})`)
      await sleep(50)
    }
  }
  /** the next state frame after the n-th, or null after `ms` (a coalesced stream may send none) */
  async nextState(n: number, ms: number): Promise<StateFrame | null> {
    const t0 = Date.now()
    while (this.states().length <= n) { if (Date.now() - t0 > ms) return null; await sleep(50) }
    return this.states()[n]!
  }
}

// ======================================================================================================================
// helpers
// ======================================================================================================================

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const count = (hay: string, needle: string) => (needle ? hay.split(needle).length - 1 : 0)

function portFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const probe = createServer()
    probe.once('error', () => done(false))
    probe.listen(port, '127.0.0.1', () => probe.close(() => done(true)))
  })
}
/** a loopback port free now (the OS's pick) */
function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer()
    probe.once('error', fail)
    probe.listen(0, '127.0.0.1', () => { const p = (probe.address() as { port: number }).port; probe.close(() => done(p)) })
  })
}

async function req<T = Record<string, unknown>>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, base = BASE): Promise<{ status: number; body: T; text: string; headers: Headers }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'x-oasis-code-token': info.token, origin: base, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let parsed: unknown = null
  try { parsed = JSON.parse(text) } catch { parsed = null }
  return { status: res.status, body: parsed as T, text, headers: res.headers }
}
async function api<T = Record<string, unknown>>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
  const r = await req<T>(method, path, body, headers)
  assert.ok(r.status >= 200 && r.status < 300, `${method} ${path}: ${r.status} ${r.text.slice(0, 300)}`)
  return r.body
}
async function runEnds(runId: string): Promise<string> {
  for (let i = 0; i < 600; i += 1) {
    const { status } = await api<{ status: string }>('GET', `/api/runs/${runId}`)
    if (!['queued', 'running'].includes(status)) return status
    await sleep(100)
  }
  throw new Error(`run ${runId} did not end`)
}
async function chat(text: string, model = LIVE_ROUTE, extra: Record<string, unknown> = {}): Promise<string> {
  return (await api<{ id: string }>('POST', `/api/sessions/${ids.session}/chat`, { text, model, ...extra })).id
}
/** release a held gate of the e2e server (its own route, the app's port only), waiting until the run reached it */
async function release(gate: string): Promise<void> {
  for (let i = 0; i < 300; i += 1) {
    const r = await fetch(`${BASE}/e2e/ui-release?gate=${encodeURIComponent(gate)}`, { method: 'POST', headers: { authorization: `Bearer ${info.token}` } })
    const b = await body(r)
    assert.equal(b.status, 200, `ui-release: ${b.status} ${b.text.slice(0, 200)}`)
    if ((b.json as { released: boolean }).released) return
    await sleep(100)
  }
  throw new Error(`the held run never reached gate ${gate}`)
}
/** A response's body read ONCE (a body is a stream: a second read throws): its text, and its JSON or null. */
async function body(res: Response): Promise<{ status: number; text: string; json: unknown }> {
  const text = await res.text()
  let json: unknown = null
  try { json = JSON.parse(text) } catch { json = null }
  return { status: res.status, text, json }
}

/** the link's stored expiry brought to now + ms (the e2e server's own test route; never the share listener) */
async function expireIn(linkId: string, ms: number): Promise<string> {
  const r = await fetch(`${BASE}/e2e/live-share/expires-at?link=${linkId}&in_ms=${ms}`, { method: 'POST', headers: { authorization: `Bearer ${info.token}` } })
  const b = await body(r)
  assert.equal(b.status, 200, `expires-at: ${b.status} ${b.text.slice(0, 200)}`)
  return (b.json as { expires_at: string }).expires_at
}
async function settingsPut(s: Record<string, unknown>): Promise<{ status: number; body: { settings: Record<string, unknown>; status: { listening: boolean; address: string | null; error: string | null; viewers: number; viewer_built: boolean } } }> {
  const r = await req<{ settings: Record<string, unknown>; status: { listening: boolean; address: string | null; error: string | null; viewers: number; viewer_built: boolean } }>('PUT', '/api/settings/live-share', s)
  return { status: r.status, body: r.body }
}
/** the listener on, on this test's port, its links naming the tunnel (idempotent: later tests stand on their own) */
async function ensureListening(): Promise<void> {
  const want = { enabled: true, bind: 'loopback', port: LIVE_PORT, public_base_url: tunnel.origin }
  const now = await api<{ settings: Record<string, unknown>; status: { listening: boolean } }>('GET', '/api/settings/live-share')
  if (now.status.listening && Object.entries(want).every(([k, v]) => now.settings[k] === v)) return
  const r = await settingsPut(want)
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.status.listening, true, `the listener: ${JSON.stringify(r.body.status)}`)
}
async function createLink(body: Record<string, unknown>): Promise<{ id: string; cap: string; url: string | null; link: Record<string, unknown> }> {
  const r = await api<{ link: { id: string } & Record<string, unknown>; capability: string; url: string | null }>('POST', `/api/sessions/${ids.session}/share-links`, body)
  assert.match(r.link.id, LINK_ID)
  assert.match(r.capability, CAPABILITY)
  return { id: r.link.id, cap: r.capability, url: r.url, link: r.link }
}
type ListedLink = { id: string; state: string; revoked_at: string | null; revoked_reason?: string | null; viewers: number; options: Record<string, unknown>; expires_at: string; protocol: 1 | 2; scope: 'session' | 'task'; members: number }
/** the session's links as the app's panel lists them now (GET …/share-links/v2: its v1 and v2 links, and its task's) */
async function listLinks(session = ids.session): Promise<ListedLink[]> {
  return (await api<{ links: ListedLink[] }>('GET', `/api/sessions/${session}/share-links/v2`)).links
}

/** A raw HTTP/1.1 request to a loopback port, bytes as given (no client normalizes its path): the response decoded. */
/** what the share listener answered to the raw probes (responses only: the probes' requests carry the token and a
 *  capability on purpose) */
const probeResponses: Buffer[] = []

function raw(port: number, text: string, ms = 5000): Promise<HttpResponse & { raw: Buffer }> {
  return new Promise((done) => {
    const sock = tcpConnect(port, '127.0.0.1')
    const chunks: Buffer[] = []
    const finish = () => {
      const all = Buffer.concat(chunks)
      if (port === LIVE_PORT) probeResponses.push(all)
      const r = decodeResponses(all, true)[0] ?? { status: 0, headers: {}, body: Buffer.alloc(0), complete: false }
      done({ ...r, raw: all })
    }
    const timer = setTimeout(() => { sock.destroy(); finish() }, ms)
    sock.on('data', (d: Buffer) => chunks.push(Buffer.from(d)))
    sock.on('close', () => { clearTimeout(timer); finish() })
    sock.on('error', () => undefined)
    sock.write(text)
  })
}
const rawGet = (port: number, target: string, headers: Record<string, string> = {}, method = 'GET', body = '') =>
  raw(port, `${method} ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('')}${body ? `Content-Length: ${Buffer.byteLength(body)}\r\n` : ''}\r\n${body}`)

/** A 24×16 PNG carrying the metadata canary in tEXt and iTXt chunks (synthetic). */
function canaryPng(): Uint8Array {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0)
    return Buffer.concat([len, td, crc])
  }
  const w = 24, h = 16
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 2, 0, 0, 0], 8)
  const rows = Buffer.alloc((1 + w * 3) * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rows.set([200 - x * 6, 60 + y * 9, 140], y * (1 + w * 3) + 1 + x * 3)
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('tEXt', Buffer.from(`Comment\0${S.png_meta} GPS 1.2345,103.8 owner ${LIVE_HOME_USER}`, 'latin1')),
    chunk('iTXt', Buffer.from(`XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta>${S.png_meta}</x:xmpmeta>`, 'utf8')),
    chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0)),
  ]))
}

/** Every RESPONSE the share listener gave — through the tunnel (decoded from its HTTP framing, and as raw bytes), to
 *  the node readers, to the raw probes — and the given page texts: no secret, no id of the harness, no capability.
 *  Requests are never scanned (the probes send the token and capabilities on purpose). Asserts, and keeps the scan. */
function scanResponses(label: string, pages: Record<string, string> = {}): void {
  const exchanges = tunnel.exchanges()
  const bodies = exchanges.map((x) => x.response?.body.toString('utf8') ?? '').join('\n')
  const headersText = exchanges.map((x) => JSON.stringify(x.response?.headers ?? {})).join('\n')
  const rawDown = tunnel.rawDown().toString('latin1')
  const nodeRaw = Object.values(clients).map((c) => c.raw + JSON.stringify(c.headers)).join('\n')
  const probes = probeResponses.map((b) => b.toString('latin1')).join('\n')
  const texts: Record<string, string> = { decoded_bodies: bodies, raw_bytes: rawDown, headers: headersText, node_streams: nodeRaw, probe_responses: probes, ...pages }
  const scan = {
    label, exchanges: exchanges.length, body_bytes: Buffer.byteLength(bodies), probes: probeResponses.length,
    secrets: Object.fromEntries(Object.entries(texts).map(([k, t]) => [k, secretsIn(t)])),
    harness_ids: Object.fromEntries(Object.entries(texts).map(([k, t]) => [k, harnessIds(t)])),
    capabilities: Object.fromEntries(Object.entries(texts).map(([k, t]) => [k, Object.values(links).reduce((n, l) => n + count(t, l.cap), 0)])),
  }
  results[`secret_scan_${label}`] = scan
  writeFileSync(join(OUT, `live-share-scan-${label}.json`), JSON.stringify(scan, null, 2))
  for (const [where, found] of Object.entries(scan.secrets)) assert.deepEqual(found, [], `${label} ${where}: no secret`)
  for (const [where, found] of Object.entries(scan.harness_ids)) assert.deepEqual(Object.entries(found).filter(([, n]) => n > 0), [], `${label} ${where}: no harness id`)
  for (const [where, n] of Object.entries(scan.capabilities)) assert.equal(n, 0, `${label} ${where}: no capability in a response`)
  // no response ever sets a cookie (the tunnel's, the probes')
  assert.ok(!/^set-cookie:/im.test(rawDown) && !/^set-cookie:/im.test(probes), `${label}: no Set-Cookie`)
}

/** the ids of the harness that must never reach a viewer (counted in a text) */
function harnessIds(text: string): Record<string, number> {
  return {
    run_ids: (text.match(/\brun_[0-9a-f]{6,}/g) ?? []).length, session_id: count(text, ids.session), project_id: count(text, ids.project),
    task_ids: [L.root, L.a, L.b, L.side, L.late, L.projectB, ...L.k, ...L.pair, ...Object.values(L.assets)].filter((x) => x && text.includes(x)).length,
    repo_b_path: info.repo_b ? count(text, info.repo_b) : 0,
    asset_id: count(text, ids.asset), link_ids: Object.values(links).reduce((n, l) => n + count(text, l.id), 0),
    data_dir: count(text, info.data), repo_path: count(text, info.repo), tmp_root: count(text, 'oasis-code-e2e-'),
  }
}
/** the secrets found in a text, by name: case-insensitive too */
function secretsIn(text: string): string[] {
  const lower = text.toLowerCase()
  return Object.entries(SECRETS).filter(([, v]) => text.includes(v) || lower.includes(v.toLowerCase())).map(([k]) => k)
}

/** A viewer page of its own context (no cookie, no token of the app), its requests and console kept. */
async function openViewer(url: string, name: string): Promise<{ page: Page; context: BrowserContext; requests: { url: string; method: string; authorization: string | null; at: number }[]; errors: string[] }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  const requests: { url: string; method: string; authorization: string | null; at: number }[] = []
  const errors: string[] = []
  page.on('request', (r) => requests.push({ url: r.url(), method: r.method(), authorization: r.headers().authorization ?? null, at: Date.now() }))
  page.on('pageerror', (e) => errors.push(`pageerror ${String(e).slice(0, 200)}`))
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()} ${m.text().slice(0, 200)}`) })
  await page.goto(url)
  await page.waitForSelector(SEL.viewer, { timeout: 30_000 })
  results[`viewer_${name}_opened`] = true
  viewerContexts.push(context)
  return { page, context, requests, errors }
}
const threadText = (page: Page) => page.evaluate((sel) => (document.querySelector(sel) as HTMLElement | null)?.innerText ?? '', SEL.viewerThread)
async function waitText(page: Page, text: string, ms = 30_000): Promise<void> {
  await page.waitForFunction(({ sel, text }) => ((document.querySelector(sel) as HTMLElement | null)?.innerText ?? '').includes(text), { sel: SEL.viewerThread, text }, { timeout: ms })
}
/** The share dialog on its Live link panel, the listener's status loaded (Create waits for it). */
async function openLivePanel(page: Page): Promise<void> {
  await page.locator(SEL.open).waitFor()
  await page.click(SEL.open)
  const dialog = page.locator(SEL.shareDialog)
  await dialog.waitFor()
  if ((await dialog.getAttribute('data-mode')) !== 'live') await page.click(SEL.modeLive)
  await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute('data-mode') === 'live', SEL.shareDialog)
  await page.locator(SEL.dialog).waitFor()
  await page.waitForFunction((sel) => !['loading', 'starting'].includes(document.querySelector(sel)?.getAttribute('data-state') ?? 'loading'), SEL.service, { timeout: 15_000 })
}
/** the share dialog gone (closing unmounts it) */
const dialogClosed = (page: Page) => page.waitForSelector(SEL.shareDialog, { state: 'hidden', timeout: 10_000 })
/** Settings › Connections, from the app's root */
async function openLiveSettings(page: Page): Promise<void> {
  await page.click(SEL.settingsLauncher)
  await page.click(SEL.settingsTab)
  await page.locator(SEL.settings).waitFor()
  await page.locator(SEL.settingsStatus).waitFor()
}
/** a response's status, its body read (and so released) */
const statusOf = async (res: Promise<Response>): Promise<number> => (await body(await res)).status

/** the viewer page holds no control that acts: the testids, editable fields, and the names of its buttons */
async function controlsOf(page: Page): Promise<{ mutation_testids: string[]; editable: number; buttons: string[] }> {
  return page.evaluate((testids) => ({
    mutation_testids: testids.filter((t) => document.querySelector(`[data-testid="${t}"]`)),
    editable: document.querySelectorAll('textarea, input:not([type=hidden]):not([type=checkbox]):not([type=radio]), select, [contenteditable=""], [contenteditable=true]').length,
    buttons: Array.from(document.querySelectorAll('button, [role=button], a[href]')).map((b) => (b.getAttribute('data-testid') ?? '') + '|' + (b.getAttribute('aria-label') ?? '') + '|' + ((b as HTMLElement).innerText ?? '').trim().slice(0, 40)),
  }), MUTATION_TESTIDS)
}
const ACTING = /\b(stop|cancel|approve|deny|reject|send|undo|retry|continue|delete|revoke|steer|put back|run again|replay)\b/i

/** The evidence in frame before a picture: the innermost visible element of the viewer's thread whose text holds `text`
 *  (case-sensitive; the first or the last of them), scrolled into view by Playwright's own scrollIntoViewIfNeeded.
 *  Framing only: nothing is asserted (where it could not frame is kept in the results), the page's content is not
 *  touched, the picture is not edited. */
async function reveal(page: Page, file: string, text: string, which: 'first' | 'last' = 'first'): Promise<void> {
  const shown = page.locator(SEL.viewerThread).getByText(new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).filter({ visible: true })
  const target = which === 'last' ? shown.last() : shown.first()
  const framed = await target.scrollIntoViewIfNeeded({ timeout: 5000 }).then(() => true, () => false)
  ;(results.framing ??= {} as Record<string, unknown>)
  ;(results.framing as Record<string, unknown>)[file] = { text, which, framed }
}

async function shot(page: Page, file: string, sel?: string): Promise<void> {
  if (sel) await page.locator(sel).first().screenshot({ path: join(OUT, file) })
  else await page.screenshot({ path: join(OUT, file), fullPage: false })
}

// ======================================================================================================================

before(async () => {
  mkdirSync(OUT, { recursive: true })
  for (let i = 0; !(await portFree(PORT)); i += 1) {
    if (i % 15 === 0) console.log(`[live-share] port ${PORT} is in use; waiting (never taken)`)
    await sleep(2000)
  }
  assert.ok(existsSync(join(DIST, 'index.html')), `no built UI at ${DIST}: run npm run build first`)
  results.dist = DIST
  assert.ok(existsSync(join(DIST, 'live-share', 'live-share.js')) && existsSync(join(DIST, 'live-share', 'live-share.css')), `no built live viewer at ${join(DIST, 'live-share')}: run npm run build first`)
  serverLog = createWriteStream(join(OUT, 'e2e-server.log'))
  server = spawn('bun', ['run', 'scripts/e2e_server.ts', String(PORT)], {
    cwd: fileURLToPath(new URL('../../backend-ts', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'],
    env: backendEnv(),
  })
  serverExit = new Promise((r) => server!.once('exit', (code) => r(code)))
  server.stderr!.pipe(serverLog)
  info = await new Promise((done, fail) => {
    let buf = ''
    let first = true
    server!.stdout!.on('data', (d) => {
      serverLog!.write(d)
      if (!first) return
      buf += String(d)
      const line = buf.split('\n')[0]!
      if (line.trim().startsWith('{')) { first = false; done(JSON.parse(line)) }
    })
    server!.once('exit', (code) => fail(new Error(`e2e server exited ${code}`)))
  })
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`${BASE}/api/meta/build`); if (r.ok) break } catch { /* not yet */ }
    await sleep(100)
  }
  LIVE_PORT = await freePort()
  tunnel = new Tunnel(LIVE_PORT)
  await tunnel.start()
  results.ports = { app: PORT, live: LIVE_PORT, tunnel: tunnel.port }
  const executablePath = process.env.OASIS_CODE_E2E_BROWSER
  browser = await chromium.launch(executablePath ? { executablePath, headless: true, args: ['--no-sandbox'] } : { channel: 'chrome', headless: true })
})

after(async () => {
  for (const c of Object.values(clients)) c.close()
  try { writeFileSync(join(OUT, 'live-share-traffic.json'), JSON.stringify(trafficSummary(), null, 2)) } catch (e) { results.traffic_summary_error = String(e) }
  writeFileSync(join(OUT, 'live-share-e2e-results.json'), JSON.stringify(results, null, 2))
  await browser?.close().catch(() => undefined)
  await tunnel?.stop().catch(() => undefined)
  await stopServer()
  serverLog?.end()
})

/** Stop the backend THIS test started (its own child process only) and wait for it to exit. */
async function stopServer(): Promise<number | null> {
  if (!server) return null
  const s = server
  server = null
  if (s.exitCode === null && s.signalCode === null) s.kill('SIGTERM')
  const code = await Promise.race([serverExit!, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 20_000))])
  assert.notEqual(code, 'timeout', 'the e2e backend did not exit')
  return code as number | null
}

/** The tunnel's exchanges, summarized (no body: sizes, statuses, the stream's frames by event and revision). */
function trafficSummary(): unknown {
  return tunnel.exchanges().map((x) => ({
    conn: x.conn, method: x.request.method, path: x.request.target.replace(/#.*/, ''), auth: x.request.headers.authorization ? 'bearer' : null,
    status: x.response?.status ?? null, type: x.response?.headers['content-type'] ?? null, bytes: x.response?.body.length ?? 0,
    frames: x.request.target === PATHS.stream && x.response ? parseSse(x.response.body.toString('utf8')).map((f) => `${f.event}${f.id ? `@${f.id}` : ''}`) : undefined,
    opened_ms: x.openedAt, closed_ms: x.closedAt,
  }))
}

// ======================================================================================================================
// the tests (in order: each stands on the session the ones before it built)
// ======================================================================================================================

test('settings: off by default (loopback, 8325), owner-only, bad values refused, a taken port said, the listener on', async () => {
  const first = await api<{ settings: Record<string, unknown>; status: { listening: boolean; address: string | null; error: string | null; viewers: number; viewer_built: boolean } }>('GET', '/api/settings/live-share')
  assert.deepEqual(first.settings, DEFAULT_SETTINGS)
  assert.equal(first.status.listening, false)
  assert.equal(first.status.address, null)
  assert.equal(first.status.viewers, 0)
  results.settings_default = first
  // (the default port itself is never probed: it may be another program's, or the person's own app)

  // owner-only: no token, a connector, a director surface, an agent run, the agent's browser
  assert.equal(await statusOf(fetch(`${BASE}/api/settings/live-share`)), 401)
  for (const h of NOT_OWNER) {
    const r = await req<{ code?: string }>('GET', '/api/settings/live-share', undefined, h)
    assert.ok(r.status === 403 || r.status === 401, `${JSON.stringify(h)}: ${r.status} ${r.text.slice(0, 200)}`)
    const put = await req('PUT', '/api/settings/live-share', { ...DEFAULT_SETTINGS, enabled: true }, h)
    assert.ok(put.status === 403 || put.status === 401, `PUT ${JSON.stringify(h)}: ${put.status}`)
  }

  // refused: a port under 1024 or past 65535, a base URL with a path / query / fragment / user info / no http(s), a
  // field of no name, a partial object
  const bad: Record<string, unknown>[] = [
    { ...DEFAULT_SETTINGS, port: 80 }, { ...DEFAULT_SETTINGS, port: 70000 }, { ...DEFAULT_SETTINGS, port: 8325.5 },
    { ...DEFAULT_SETTINGS, bind: 'all' }, { ...DEFAULT_SETTINGS, bind: '0.0.0.0' },
    { ...DEFAULT_SETTINGS, public_base_url: 'https://share.example.com/live' }, { ...DEFAULT_SETTINGS, public_base_url: 'https://share.example.com/?a=1' },
    { ...DEFAULT_SETTINGS, public_base_url: 'https://share.example.com/#x' }, { ...DEFAULT_SETTINGS, public_base_url: ['https://', 'u:p', '@share.example.com'].join('') },
    { ...DEFAULT_SETTINGS, public_base_url: 'javascript:alert(1)' }, { ...DEFAULT_SETTINGS, public_base_url: 'ftp://share.example.com' },
    { ...DEFAULT_SETTINGS, extra: true }, { enabled: true },
  ]
  for (const b of bad) {
    const r = await settingsPut(b)
    assert.equal(r.status, 422, `refused: ${JSON.stringify(b)} → ${r.status}`)
  }
  assert.deepEqual((await api<{ settings: unknown }>('GET', '/api/settings/live-share')).settings, DEFAULT_SETTINGS, 'nothing refused was saved')

  // a base URL is stored normalized (no trailing slash)
  const norm = await settingsPut({ ...DEFAULT_SETTINGS, public_base_url: 'https://share.example.com/' })
  assert.equal(norm.status, 200)
  assert.equal(norm.body.settings.public_base_url, 'https://share.example.com')
  assert.equal(norm.body.status.listening, false, 'still off')

  // a taken port: saved as set, not listening, the error said, nothing retried
  const holder = createServer()
  const taken = await new Promise<number>((r) => holder.listen(0, '127.0.0.1', () => r((holder.address() as { port: number }).port)))
  try {
    const t = await settingsPut({ enabled: true, bind: 'loopback', port: taken, public_base_url: null })
    assert.equal(t.status, 200)
    assert.equal(t.body.settings.enabled, true)
    assert.equal(t.body.status.listening, false)
    assert.ok(t.body.status.error, 'the bind error is said')
    results.port_taken_status = t.body.status
  } finally { await new Promise((r) => holder.close(r)) }

  // back to the defaults: the app's Settings turns it on next
  const off = await settingsPut({ ...DEFAULT_SETTINGS })
  assert.equal(off.status, 200)
  assert.equal(off.body.status.listening, false)
})

test('settings in the app: off by default, turned on from Settings › Connections (screenshots)', async () => {
  const context = await browser.newContext({ viewport: { width: 1400, height: 950 } })
  const page = await context.newPage()
  try {
    await page.goto(`${BASE}/?token=${info.token}`)
    await openLiveSettings(page)
    assert.equal(await page.locator(SEL.settingsStatus).getAttribute('data-state'), 'off')
    assert.equal(await page.isChecked(SEL.settingsEnabled), false)
    assert.equal(await page.inputValue(SEL.settingsBind), 'loopback')
    assert.equal(await page.inputValue(SEL.settingsPort), String(DEFAULT_SETTINGS.port))
    assert.equal(await page.inputValue(SEL.settingsBase), '')
    await shot(page, 'owner-settings-off.png', SEL.settings)
    await page.check(SEL.settingsEnabled)
    await page.fill(SEL.settingsPort, String(LIVE_PORT))
    await page.fill(SEL.settingsBase, tunnel.origin)
    await page.click(SEL.settingsSave)
    await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute('data-state') === 'listening', SEL.settingsStatus, { timeout: 15_000 })
    assert.match(await page.locator(SEL.settingsStatus).innerText(), new RegExp(`127\\.0\\.0\\.1:${LIVE_PORT}`))
    await shot(page, 'owner-settings-on.png', SEL.settings)
  } finally { await context.close() }
})

test('the listener on: loopback, this test\'s port, its links naming the tunnel; the app port never serves the stream', async () => {
  await ensureListening() // (when the Settings test above could not turn it on, the rest still runs)
  const on = await api<{ settings: Record<string, unknown>; status: { listening: boolean; address: string | null; viewer_built: boolean } }>('GET', '/api/settings/live-share')
  assert.deepEqual(on.settings, { enabled: true, bind: 'loopback', port: LIVE_PORT, public_base_url: tunnel.origin })
  assert.equal(on.status.listening, true, JSON.stringify(on.status))
  assert.equal(on.status.address, `127.0.0.1:${LIVE_PORT}`)
  assert.equal(on.status.viewer_built, true, 'the viewer is built where the listener reads it')
  results.settings_on = on
  assert.equal((await rawGet(LIVE_PORT, PATHS.page)).status, 200)
  const onApp = await fetch(`${BASE}${PATHS.stream}`, { headers: { 'x-oasis-code-token': info.token, authorization: 'Bearer x' } })
  assert.ok(!(onApp.headers.get('content-type') ?? '').startsWith('text/event-stream'), 'the app port serves no share stream')
  await onApp.body?.cancel()
})

test('fixture: a session with a run before any link and an uploaded picture carrying a metadata canary', async () => {
  ids.project = (await api<{ id: string }>('POST', '/api/projects', { source_path: info.repo, name: 'live-share-fixture' })).id
  ids.session = (await api<{ id: string }>('POST', `/api/projects/${ids.project}/sessions`, { title: LIVE_SESSION_TITLE, model: LIVE_ROUTE })).id
  ids.pre = await chat(`${LIVE_CASES.plain} ${LIVE_MARKS.pre_link}`)
  assert.equal(await runEnds(ids.pre), 'done')
  const res = await fetch(`${BASE}/api/sessions/${ids.session}/attachments?name=alice-diagram.png`, {
    method: 'POST', headers: { 'x-oasis-code-token': info.token, origin: BASE, 'content-type': 'image/png' }, body: canaryPng() as unknown as BodyInit,
  })
  const up = await body(res)
  assert.ok(res.ok, `upload: ${up.status} ${up.text.slice(0, 200)}`)
  const att = up.json as { asset_id?: string; id?: string }
  ids.asset = att.asset_id ?? att.id ?? ''
  assert.match(ids.asset, /^[A-Za-z0-9_-]+$/)
  ids.eye = await chat('Bob, look at this diagram.', 'scripted:e', { attachments: [ids.asset] })
  assert.equal(await runEnds(ids.eye), 'done')
})

test('a link made in the app while a run is active: options, the URL copied; closed and opened again, the same link copied, nothing revoked', async () => {
  await ensureListening()
  // the progress run, held before its first words: active, nothing shown yet
  ids.progress = await chat(`${LIVE_CASES.progress} — Alice, fix calc.py for Bob and tell him what changed.`)
  const run = await api<{ status: string }>('GET', `/api/runs/${ids.progress}`)
  assert.ok(['queued', 'running'].includes(run.status), `the run is active: ${run.status}`)

  const context = await browser.newContext({ viewport: { width: 1400, height: 950 } })
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE })
  const page = await context.newPage()
  const clipboard = () => page.evaluate(() => navigator.clipboard.readText())
  try {
    await page.goto(`${BASE}/?token=${info.token}`)
    await page.click(SEL.session(ids.session))
    await page.locator(SEL.open).waitFor()
    assert.equal(await page.locator(SEL.open).isDisabled(), false, 'a live link can be made while the session works')
    // busy: the one share icon opens on Live link by itself
    await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute('data-busy') === 'true', SEL.open, { timeout: 15_000 })
    await page.click(SEL.open)
    await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute('data-mode') === 'live', SEL.shareDialog, { timeout: 10_000 })
    await page.click(SEL.close)
    await dialogClosed(page)
    await openLivePanel(page)
    assert.equal(await page.locator(SEL.service).getAttribute('data-state'), 'listening')
    // the defaults: tools off, images off, one day
    assert.equal(await page.isChecked(SEL.tools), false)
    assert.equal(await page.isChecked(SEL.images), false)
    assert.equal(await page.isChecked(SEL.task), false, 'every session of the task: off by default')
    assert.equal(await page.inputValue(SEL.expiry), '86400', 'one day by default')
    await page.check(SEL.tools)
    await page.check(SEL.images)
    await shot(page, 'owner-create-options.png', SEL.shareDialog)
    const before = (await listLinks()).length
    await page.click(SEL.create)
    await page.waitForFunction((sel) => {
      const el = document.querySelector(sel)
      return !!el && (el instanceof HTMLInputElement ? el.value : el.textContent ?? '').includes('/live/#')
    }, SEL.url, { timeout: 30_000 })
    const url = await page.locator(SEL.url).evaluate((el) => (el instanceof HTMLInputElement ? el.value : el.textContent ?? '').trim())
    const m = new RegExp(`^${tunnel.origin.replace(/[.]/g, '\\.')}/live/#([A-Za-z0-9_-]{43})$`).exec(url)
    assert.ok(m, `the URL names the public origin and the capability in its fragment: ${url.replace(/#.*/, '#…')}`)
    const cap = m[1]!
    assert.notEqual(cap, SESSION_TOKEN)
    await page.click(SEL.copy)
    assert.equal(await clipboard(), url, 'the URL copied')
    await shot(page, 'owner-link-ready.png', SEL.shareDialog)
    const listed = await listLinks()
    assert.equal(listed.length, before + 1, 'one link made')
    const made = listed[0]!
    assert.deepEqual(made.options, { include_tool_details: true, include_images: true, exclude_run_ids: [] })
    assert.equal(made.state, 'active')
    // the app makes v2 links now: this one shows this session alone
    assert.deepEqual([made.protocol, made.scope, made.members], [2, 'session', 1], 'a v2 link of one session')
    links.main = { id: made.id, cap, url }

    // closed (the button, then Escape after reopening): nothing revoked, no link made
    await page.click(SEL.close)
    await dialogClosed(page)
    await page.evaluate(() => navigator.clipboard.writeText('cleared'))
    let after = await listLinks()
    assert.equal(after.length, before + 1)
    assert.equal(after.find((l) => l.id === made.id)?.state, 'active', 'closing the dialog does not revoke')
    assert.equal(after.find((l) => l.id === made.id)?.revoked_at, null)

    await openLivePanel(page)
    const row = page.locator(SEL.link(made.id))
    await row.waitFor()
    assert.equal(await row.getAttribute('data-state'), 'active')
    await row.locator(SEL.linkCopy).click()
    await page.waitForFunction(async (u) => (await navigator.clipboard.readText()) === u, url, { timeout: 10_000 }).catch(() => undefined)
    assert.equal(await clipboard(), url, 'the same link copied again after the dialog was closed')
    assert.equal(await page.inputValue(SEL.url), url, 'the panel shows that link\'s URL again')
    await shot(page, 'owner-link-list.png', SEL.shareDialog)
    await page.keyboard.press('Escape')
    await dialogClosed(page)
    after = await listLinks()
    assert.equal(after.length, before + 1, 'opening the dialog again made no link')
    assert.equal(after.find((l) => l.id === made.id)?.state, 'active')

    // reveal (the API the copy uses): the same capability every time
    const again = await api<{ capability: string; url: string | null; link: { id: string } }>('POST', `/api/share-links/${made.id}/reveal`, {})
    assert.equal(again.capability, cap)
    assert.equal(again.url, url)
  } finally { await context.close() }

  // the other links of this session, by API: the defaults (tools off, images off); and one that leaves out the run
  // before the link and the progress run — the run being written now
  const plain = await createLink({ label: 'plain (synthetic)' })
  assert.deepEqual(plain.link.options, { include_tool_details: false, include_images: false, exclude_run_ids: [] })
  assert.equal(plain.url, `${tunnel.origin}/live/#${plain.cap}`)
  links.plain = { id: plain.id, cap: plain.cap, url: plain.url }
  const excl = await createLink({ label: 'without two runs', include_tool_details: true, include_images: true, exclude_run_ids: [ids.progress, ids.pre, ids.pre] })
  assert.deepEqual((excl.link.options as { exclude_run_ids: string[] }).exclude_run_ids, [ids.progress, ids.pre].sort(), 'canonical: sorted, no repeat')
  links.excl = { id: excl.id, cap: excl.cap, url: excl.url }
  assert.equal(new Set(Object.values(links).map((l) => l.cap)).size, 3, 'each link its own capability')
  // the shortest life is five minutes: 299 s refused (the product's bound untouched by this test)
  const short = await req('POST', `/api/sessions/${ids.session}/share-links`, { expires_in_s: 299 })
  assert.equal(short.status, 422)
  const long = await req('POST', `/api/sessions/${ids.session}/share-links`, { expires_in_s: 30 * 24 * 3600 + 1 })
  assert.equal(long.status, 422)
})

let viewer: Awaited<ReturnType<typeof openViewer>>

test('the viewer watches the run work: running, words, tools (a sensitive one withheld whole), the answer while it is written — and no control', async () => {
  // node readers of all three links, connected before the run says anything
  clients.main = await StreamClient.open('main', tunnel.origin, links.main!.cap)
  clients.plain = await StreamClient.open('plain', tunnel.origin, links.plain!.cap)
  clients.excl = await StreamClient.open('excl', tunnel.origin, links.excl!.cap)
  for (const c of Object.values(clients)) {
    assert.equal(c.status, 200, `${c.name}: ${c.status} ${c.raw.slice(0, 200)}`)
    assert.match(c.headers['content-type'] ?? '', /^text\/event-stream/)
    assert.equal(c.headers['cache-control'], 'no-store')
    await c.waitFor('a first state', (x) => x.states().length > 0)
  }
  const first = clients.main.last()!
  assert.equal(first.snapshot.format, 'oasis-code.session-live')
  assert.equal(first.snapshot.version, 2, 'the app\'s link: protocol 2')
  assert.deepEqual([first.v2!.snapshot.scope, first.v2!.snapshot.sessions.length, first.v2!.start], ['session', 1, first.v2!.snapshot.current])
  // the links of the frozen v1 route keep answering v1 frames: an old link reads as it always did
  for (const c of [clients.plain, clients.excl]) {
    const f = c.last()!
    assert.equal(f.snapshot.version, 1, `${c.name}: a v1 link, a v1 frame`)
    assert.equal('start' in (c.frames.find((x) => x.event === 'state')!.json as Record<string, unknown>), false, `${c.name}: v1's frame shape`)
  }
  assert.equal(first.snapshot.session.active, true, 'the session works')
  assert.ok(first.snapshot.runs.some((r) => r.status === 'running' || r.status === 'queued'), 'its run is active')
  assert.ok(!JSON.stringify(first).includes(LIVE_MARKS.intro), 'nothing of the run said yet')
  assert.match(first.epoch, /^[A-Za-z0-9_-]{8,32}$/)

  viewer = await openViewer(links.main!.url!, 'main')
  await viewer.page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute('data-phase') === 'connected', SEL.viewer, { timeout: 30_000 })
  await waitText(viewer.page, LIVE_MARKS.pre_link)
  await shot(viewer.page, 'viewer-run-active.png')

  // its first words and its tools
  await release(LIVE_GATES.start)
  await waitText(viewer.page, LIVE_MARKS.intro)
  // the commands run two seconds each: a running tool is seen (a sensitive one by its name only)
  await clients.main.waitFor('a tool running', (c) => c.states().some((s) => s.snapshot.items.some((i) => i.kind === 'tool' && i.status === 'running')), 30_000)
  await waitText(viewer.page, LIVE_MARKS.sensitive_intro)
  // every tool returned; the run is held before its answer (gate live-answer). While a run works its tools are read
  // from their result events, which carry a command's outcome (exit code, duration, bytes) and never its output: the
  // harmless command is seen done — not withheld, exit 0 — and its output preview comes once the run has finished
  const harmlessDone = (i: Item) => i.kind === 'tool' && i.name === 'bash' && i.withheld === null && i.status !== 'running'
    && (i.details?.fields ?? []).some((f) => f.name === 'exit_code' && f.value === 0)
  await clients.main.waitFor('the harmless tool done', (c) => (c.last()?.snapshot.items ?? []).some(harmlessDone), 30_000)
  assert.deepEqual(secretsIn(clients.main.raw), [], 'while the tools ran: the stream holds no secret')
  await shot(viewer.page, 'viewer-run-tool-live.png')
  const running = clients.main.states().flatMap((s) => s.snapshot.items.filter((i) => i.kind === 'tool' && i.status === 'running'))
  results.running_tools_seen = running.map((t) => ({ name: t.name, withheld: t.withheld, target: t.target ?? null, details: t.details === null ? null : 'present' }))
  for (const t of running.filter((x) => x.withheld)) assert.ok(t.details === null && (t.target ?? null) === null, 'a running sensitive tool withheld whole too')

  const tools = clients.main.last()!.snapshot.items.filter((i) => i.kind === 'tool')
  const withheld = tools.filter((t) => t.withheld === 'sensitive_source')
  assert.ok(withheld.length >= 2, `the sensitive command and the auth file read are withheld whole: ${JSON.stringify(tools.map((t) => [t.name, t.withheld]))}`)
  for (const t of withheld) assert.ok(t.details === null && (t.target ?? null) === null, `withheld whole: ${JSON.stringify(t)}`)
  const harmless = tools.find(harmlessDone)
  assert.ok(harmless, `the harmless command is shown done: ${JSON.stringify(tools.map((t) => [t.name, t.withheld, t.status]))}`)
  assert.ok(!JSON.stringify(harmless).includes(S.tool_bearer), 'the harmless tool\'s bearer redacted')

  // the answer, piece by piece: after each piece, the stream and the page hold no secret, whole or in part
  await release(LIVE_GATES.answer)
  await waitText(viewer.page, LIVE_MARKS.answer)
  // held after the first piece: the answer's heading line is complete, the next line is half written (it ends inside
  // a key) — shown up to its last completed line only, the line being written withheld
  await clients.main.waitFor('the open answer', (c) => (c.last()?.snapshot.items ?? []).some((i) => i.kind === 'message_open' && (i.text ?? '').includes(LIVE_MARKS.answer)))
  const held = clients.main.last()!.snapshot.items.find((i) => i.kind === 'message_open')!
  assert.equal(held.withheld_tail, true, 'the line being written is withheld')
  assert.ok(!(held.text ?? '').includes('calc.py is fixed'), 'nothing of the unfinished line in the state')
  assert.ok(!(await threadText(viewer.page)).includes('calc.py is fixed'), 'nothing of the unfinished line on the page')
  await reveal(viewer.page, 'viewer-answer-line-held.png', LIVE_MARKS.answer)
  await shot(viewer.page, 'viewer-answer-line-held.png')
  const pieces = liveAnswerPieces()
  const perPiece: Record<string, unknown>[] = []
  for (let k = 0; k < pieces.length - 1; k++) {
    const n = clients.main.states().length
    await release(LIVE_GATES.piece(k))
    await clients.main.nextState(n, 2000)
    await sleep(250)
    const open = clients.main.last()!.snapshot.items.find((i) => i.kind === 'message_open')
    const text = await threadText(viewer.page)
    perPiece.push({ piece: k + 1, open_withheld_tail: open?.withheld_tail ?? null, open_chars: open?.text?.length ?? null, secrets_stream: secretsIn(clients.main.raw), secrets_page: secretsIn(text) })
    assert.deepEqual(secretsIn(clients.main.raw), [], `after piece ${k + 1}: the stream holds no secret`)
    assert.deepEqual(secretsIn(text), [], `after piece ${k + 1}: the page shows no secret`)
    if (k === 0) {
      // that line completed (its key redacted whole); the next one (a mailbox cut before its domain) is withheld
      await waitText(viewer.page, 'calc.py is fixed')
      assert.ok(!(await threadText(viewer.page)).includes('Write to'), 'the next unfinished line is withheld')
      await reveal(viewer.page, 'viewer-answer-streaming.png', 'calc.py is fixed')
      await shot(viewer.page, 'viewer-answer-streaming.png')
    }
  }
  results.answer_pieces = perPiece
  assert.equal(await runEnds(ids.progress), 'done')
  await waitText(viewer.page, LIVE_MARKS.answer_end)
  // the run finished: its record is read, and the harmless command's output preview is there — its bearer redacted;
  // the sensitive command and the auth file read stay withheld whole
  await clients.main.waitFor('the harmless tool\'s preview', (c) => (c.last()?.snapshot.items ?? []).some((i) => i.kind === 'tool' && (i.details?.preview ?? '').includes(LIVE_MARKS.tool_mark)), 30_000)
  const finalTools = clients.main.last()!.snapshot.items.filter((i) => i.kind === 'tool')
  const previewed = finalTools.find((t) => (t.details?.preview ?? '').includes(LIVE_MARKS.tool_mark))!
  assert.ok(!JSON.stringify(previewed).includes(S.tool_bearer), 'the harmless tool\'s preview: its bearer redacted')
  const finalWithheld = finalTools.filter((t) => t.withheld === 'sensitive_source')
  assert.ok(finalWithheld.length >= 2, `still withheld whole once done: ${JSON.stringify(finalTools.map((t) => [t.name, t.withheld]))}`)
  for (const t of finalWithheld) assert.ok(t.details === null && (t.target ?? null) === null, `withheld whole once done: ${JSON.stringify(t)}`)
  assert.deepEqual(secretsIn(clients.main.raw), [], 'once done: the stream holds no secret')
  await waitText(viewer.page, LIVE_MARKS.tool_mark, 3000).catch(() => undefined) // shown if the page opens tool details by default
  const done = clients.main.last()!
  assert.equal(done.snapshot.items.filter((i) => i.kind === 'message_open').length, 0, 'the answer is an ordinary message once complete')
  assert.ok(done.snapshot.runs.every((r) => !['running', 'queued'].includes(r.status)))
  await reveal(viewer.page, 'viewer-answer-done.png', LIVE_MARKS.answer_end)
  await shot(viewer.page, 'viewer-answer-done.png')

  // revisions grow within an epoch; ids are `<epoch>.<revision>`
  const states = clients.main.states()
  for (let i = 1; i < states.length; i++) if (states[i]!.epoch === states[i - 1]!.epoch) assert.ok(states[i]!.revision > states[i - 1]!.revision, 'revisions grow')
  for (const f of clients.main.frames.filter((x) => x.event === 'state')) assert.equal(f.id, `${(f.json as StateFrame).epoch}.${(f.json as StateFrame).revision}`)

  // no control that acts on the session
  const controls = await controlsOf(viewer.page)
  results.viewer_controls = controls
  assert.deepEqual(controls.mutation_testids, [])
  assert.equal(controls.editable, 0, 'no field to write in')
  assert.deepEqual(controls.buttons.filter((b) => ACTING.test(b)), [], 'no button that acts')
})

test('a run waiting for an approval: the viewer sees it, with no approval control', async () => {
  type Proposals = { proposals: { status: string; proposal_asset_id: string }[] }
  await api('PUT', `/api/sessions/${ids.session}/mode`, { mode: 'approve' })
  try {
    ids.approval = await chat('write a note for Bob', 'scripted:g')
    assert.equal(await runEnds(ids.approval), 'done')
    // the change really waits for the person: one pending proposal
    const pending = (await api<Proposals>('GET', `/api/sessions/${ids.session}/action-proposals`)).proposals.filter((p) => p.status === 'pending')
    assert.equal(pending.length, 1, `one pending proposal: ${JSON.stringify(pending)}`)
    // the viewer shows that run (its answer says it waits) — in the page and in the stream
    await waitText(viewer.page, 'waits for your approval')
    await clients.main.waitFor('the waiting run', (c) => JSON.stringify(c.last()?.snapshot ?? '').includes('waits for your approval'))
    // and nothing that would decide it
    const controls = await controlsOf(viewer.page)
    results.viewer_controls_approval = controls
    assert.deepEqual(controls.mutation_testids, [], 'no approval control on the viewer')
    assert.equal(controls.editable, 0)
    assert.deepEqual(controls.buttons.filter((b) => ACTING.test(b)), [])
    await shot(viewer.page, 'viewer-approval-waiting.png')
    // the person decides in the app (rejected): nothing pending after
    await api('POST', `/api/action-proposals/${pending[0]!.proposal_asset_id}/decide`, { decision: 'reject', reason: 'synthetic' })
    const after = (await api<Proposals>('GET', `/api/sessions/${ids.session}/action-proposals`)).proposals.filter((p) => p.status === 'pending')
    assert.deepEqual(after, [], 'the proposal decided')
  } finally {
    await api('PUT', `/api/sessions/${ids.session}/mode`, { mode: 'auto' })
  }
})

/** marks of runs made before the cut, and how often the page showed each then */
const SHOWN_MARKS = [LIVE_MARKS.pre_link, LIVE_MARKS.intro, LIVE_MARKS.answer, LIVE_MARKS.answer_end, LIVE_MARKS.second]
const shownBefore: Record<string, number> = {}

test('a second update reaches the open viewer', async () => {
  ids.second = await chat(`${LIVE_CASES.quick} ${LIVE_MARKS.second}`)
  assert.equal(await runEnds(ids.second), 'done')
  await waitText(viewer.page, LIVE_MARKS.second)
  await clients.main.waitFor('the second update', (c) => JSON.stringify(c.last()).includes(LIVE_MARKS.second))
  // the person's words and the answer each name the mark: shown as often as the run holds it, kept to compare after
  // the reconnection
  const text = await threadText(viewer.page)
  for (const mark of SHOWN_MARKS) shownBefore[mark] = count(text, mark)
  assert.ok(Object.values(shownBefore).every((n) => n >= 1), JSON.stringify(shownBefore))
  results.shown_before_cut = shownBefore
  await shot(viewer.page, 'viewer-second-update.png')
})

test('cut away, new work meanwhile, back again: one whole state, nothing twice', async () => {
  const before = { main: clients.main.states().length }
  tunnel.refusing = true
  const awayAt = Date.now()
  tunnel.sever()
  await viewer.page.waitForFunction((sel) => ['reconnecting', 'connecting'].includes(document.querySelector(sel)?.getAttribute('data-phase') ?? ''), SEL.viewer, { timeout: 60_000 })
  await shot(viewer.page, 'viewer-reconnecting.png')
  ids.reconnect = await chat(`${LIVE_CASES.quick} ${LIVE_MARKS.reconnect}`)
  assert.equal(await runEnds(ids.reconnect), 'done')
  await sleep(500)
  assert.ok(!(await threadText(viewer.page)).includes(LIVE_MARKS.reconnect), 'nothing arrives while away')
  const cutAt = Date.now()
  tunnel.refusing = false
  // the page comes back on its own (its backoff); `online` nudges it as a page coming back online would be
  await viewer.page.evaluate(() => window.dispatchEvent(new Event('online')))
  await waitText(viewer.page, LIVE_MARKS.reconnect, 60_000)
  await viewer.page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute('data-phase') === 'connected', SEL.viewer, { timeout: 30_000 })
  const text = await threadText(viewer.page)
  for (const mark of SHOWN_MARKS) assert.equal(count(text, mark), shownBefore[mark], `${mark}: shown as often as before the cut`)
  assert.equal(count(text, LIVE_MARKS.reconnect), shownBefore[LIVE_MARKS.second], 'the run made while away: shown as a run of its shape is')
  await reveal(viewer.page, 'viewer-reconnected.png', LIVE_MARKS.reconnect, 'last')
  await shot(viewer.page, 'viewer-reconnected.png')

  // the reconnected stream opens with a WHOLE safe state (every run so far), never a patch. A projection retained
  // through a short absence may first give its cached state, then the rebuilt one catches up on the same stream: the
  // first state holds everything from before the cut, and a later state of THAT stream holds the work made while away
  const reconnectStreams = () => tunnel.exchanges().filter((x) => x.request.target === PATHS.stream && x.openedAt >= cutAt && x.request.headers.authorization === `Bearer ${links.main!.cap}`)
  const statesOf = (x: Exchange) => parseSse(x.response?.body.toString('utf8') ?? '').filter((f) => f.event === 'state' && f.json !== null).map((f) => asState(f.json))
  const streams = reconnectStreams()
  assert.ok(streams.length >= 1, 'the viewer opened its stream again')
  const firstAgain = parseSse(streams[0]!.response!.body.toString('utf8'))[0]!
  assert.equal(firstAgain.event, 'state')
  const snap = asState(firstAgain.json).snapshot
  const keys = snap.items.map((i) => i.key)
  assert.equal(new Set(keys).size, keys.length, 'item keys unique')
  // a node reader that says the last event id it saw: still a whole state first (Last-Event-ID is not replayed after),
  // read after the work made while away — the reference whole state
  const lastId = clients.main.frames.filter((f) => f.event === 'state').at(-1)?.id ?? '0.1'
  const resumed = await StreamClient.open('resumed', LIVE_ORIGIN(), links.main!.cap, { 'last-event-id': lastId })
  clients.resumed = resumed
  await resumed.waitFor('a whole state with the work made while away', (c) => JSON.stringify(c.states()[0]?.snapshot ?? '').includes(LIVE_MARKS.reconnect), 15_000)
  const fresh = JSON.stringify(resumed.states()[0]!.snapshot)
  resumed.close()
  for (const mark of [...SHOWN_MARKS, LIVE_MARKS.reconnect]) assert.ok(count(fresh, mark) >= 1, `a whole state holds ${mark}`)
  // the first state again: everything from before the cut, as often as a whole state holds it
  for (const mark of SHOWN_MARKS) assert.equal(count(JSON.stringify(snap), mark), count(fresh, mark), `the browser's first state again holds ${mark} as a whole state does`)
  // and on that same stream, within a bound, the state that caught up: every mark, the new run's included, as often as
  // in the whole state (nothing missing, nothing twice)
  let caught: StateFrame | null = null
  for (let i = 0; i < 150 && caught === null; i++) {
    const same = reconnectStreams()[0]
    caught = (same ? statesOf(same) : []).find((st) => JSON.stringify(st.snapshot).includes(LIVE_MARKS.reconnect)) ?? null
    if (caught === null) await sleep(100)
  }
  assert.ok(caught !== null, 'the reconnected stream caught up with the work made while away')
  for (const mark of [...SHOWN_MARKS, LIVE_MARKS.reconnect]) assert.equal(count(JSON.stringify(caught!.snapshot), mark), count(fresh, mark), `the caught-up state holds ${mark} as a whole state does`)
  const caughtKeys = caught!.snapshot.items.map((i) => i.key)
  assert.equal(new Set(caughtKeys).size, caughtKeys.length, 'item keys unique (caught up)')
  assert.equal(caught!.epoch, (firstAgain.json as StateFrame).epoch, 'the same epoch on the same stream')
  assert.equal(count(fresh, LIVE_MARKS.reconnect), count(fresh, LIVE_MARKS.second), 'the run made while away is whole, once')
  // away for less than the service's idle time (5 s) the projection is kept, marked dirty while nobody watched: the
  // reconnection must still bring the work made meanwhile (the retained-and-dirty case); longer, it is made anew
  results.reconnect = { main_states_before_cut: before.main, reconnect_streams: streams.length, away_ms: streams[0]!.openedAt - awayAt, retained_projection_likely: streams[0]!.openedAt - awayAt < 5000,
    first_state_had_work_made_away: count(JSON.stringify(snap), LIVE_MARKS.reconnect) > 0, caught_up_revision: caught!.revision, first_revision: (firstAgain.json as StateFrame).revision }
  // the node readers were cut too: they read again
  for (const name of ['main', 'plain', 'excl'] as const) {
    clients[`${name}_cut`] = clients[name]!
    clients[name] = await StreamClient.open(name, tunnel.origin, links[name]!.cap)
    await clients[name]!.waitFor('a state', (c) => JSON.stringify(c.last() ?? '').includes(LIVE_MARKS.reconnect))
  }
})
const LIVE_ORIGIN = () => `http://127.0.0.1:${LIVE_PORT}`

test('the option boundaries: tools off, images off, runs left out (the run being written included); pictures of another projection 404', async () => {
  const main = clients.main!.last()!.snapshot
  const plain = clients.plain!.last()!.snapshot
  const excl = clients.excl!.last()!.snapshot
  assert.deepEqual(main.options, { include_tool_details: true, include_images: true })
  assert.deepEqual(plain.options, { include_tool_details: false, include_images: false })
  // tools off: no detail of any tool; the withheld ones withheld in every projection
  assert.deepEqual(plain.items.filter((i) => i.kind === 'tool' && i.details !== null).map((i) => i.key), [])
  assert.ok(main.items.some((i) => i.kind === 'tool' && i.details !== null))
  // images: the picture carried with images on (an opaque resource), omitted with images off
  assert.ok(main.images.length >= 1, 'the uploaded picture is carried')
  for (const im of main.images) assert.match(im.resource, IMAGE_RESOURCE)
  assert.deepEqual(plain.images, [])
  assert.ok(plain.items.filter((i) => i.kind === 'image').every((i) => i.image === null && i.omitted === 'images_off'))
  // the runs left out: nothing of them, in any frame this link ever sent (the run being written included)
  const exclAll = clients.excl_cut!.raw + clients.excl!.raw
  for (const mark of [LIVE_MARKS.pre_link, LIVE_MARKS.intro, LIVE_MARKS.sensitive_intro, LIVE_MARKS.answer, LIVE_MARKS.answer_end, LIVE_MARKS.tool_mark]) assert.equal(count(exclAll, mark), 0, `excluded: ${mark}`)
  assert.ok(exclAll.includes(LIVE_MARKS.second), 'later runs are in')
  assert.ok(excl.runs.length === main.runs.length - 2, `two runs fewer: ${excl.runs.length} vs ${main.runs.length}`)
  results.option_boundaries = { main_runs: main.runs.length, excl_runs: excl.runs.length, main_images: main.images.length }

  // the picture: the stripped bytes, its type and size as the state says; refused without the capability, 404 under
  // another projection's capability, 404 for a resource of no projection
  const ref = main.images[0]!
  const get = (cap: string | null, resource = ref.resource) => fetch(`${tunnel.origin}${PATHS.image}${resource}`, { headers: cap ? { authorization: `Bearer ${cap}` } : {} })
  const ok = await get(links.main!.cap)
  assert.equal(ok.status, 200)
  assert.equal(ok.headers.get('content-type')?.split(';')[0], ref.media_type)
  const bytes = Buffer.from(await ok.arrayBuffer())
  assert.equal(bytes.length, ref.bytes)
  assert.equal(bytes.subarray(1, 4).toString('latin1'), 'PNG')
  assert.ok(!bytes.toString('latin1').includes(S.png_meta), 'no metadata canary in the picture')
  assert.ok(!/tEXt|iTXt|zTXt|eXIf/.test(bytes.toString('latin1')), 'no text or EXIF chunk left')
  assert.equal(await statusOf(get(null)), 401)
  assert.equal(await statusOf(get(links.plain!.cap)), 404, 'images off: not served')
  assert.equal(await statusOf(get(links.main!.cap, `m${'0'.repeat(24)}`)), 404)
  // the viewer shows it, as a blob: picture decoded for real
  const pics = await viewer.page.evaluate(async () => Promise.all(Array.from(document.images).map(async (i) => ({ src: i.currentSrc.slice(0, 5), ok: await i.decode().then(() => true, () => false), w: i.naturalWidth, h: i.naturalHeight }))))
  results.viewer_pictures = pics
  assert.ok(pics.some((p) => p.ok && p.w === 24 && p.h === 16), `the picture shown: ${JSON.stringify(pics)}`)
})

test('every byte a viewer received holds no secret, no id of the harness, no capability in a URL', async () => {
  // the canaries are really in the session's records: their absence below is not vacuous
  const replay = (await req('GET', `/api/sessions/${ids.session}/replay`)).text
  const transcript = (await req('GET', `/api/runs/${ids.progress}/transcript`)).text
  const source = replay + transcript
  const inRecords = Object.fromEntries(Object.entries(SECRETS).filter(([k]) => !['png_meta', 'session_token', 'key_whole'].includes(k) && !k.startsWith('task_')).map(([k, v]) => [k, source.includes(v)]))
  results.canaries_in_records = inRecords
  assert.deepEqual(Object.entries(inRecords).filter(([, v]) => !v).map(([k]) => k), [], 'every canary is in the session records')

  const page = await viewer.page.content() + (await threadText(viewer.page))
  scanResponses('viewer', { viewer_dom: page })
  // the viewer asked for its page, its two assets, its stream and its pictures — nothing else, nowhere else; the
  // capability only ever in the Authorization header of the stream and the pictures
  for (const r of viewer.requests) {
    if (r.url.startsWith('blob:') || r.url.startsWith('data:')) continue
    const u = new URL(r.url)
    assert.equal(u.origin, tunnel.origin, `same origin: ${r.url.slice(0, 80)}`)
    assert.equal(r.method, 'GET')
    assert.ok([PATHS.page, PATHS.script, PATHS.style, PATHS.stream].includes(u.pathname) || (u.pathname.startsWith(PATHS.image) && IMAGE_RESOURCE.test(u.pathname.slice(PATHS.image.length))), `an exact path: ${u.pathname}`)
    assert.equal(u.search, '', 'no query')
    assert.ok(!`${u.origin}${u.pathname}${u.search}`.includes(links.main!.cap), 'the capability never in a requested URL (only the fragment)')
    if (u.pathname === PATHS.stream || u.pathname.startsWith(PATHS.image)) assert.equal(r.authorization, `Bearer ${links.main!.cap}`)
    else assert.equal(r.authorization, null)
  }
  for (const x of tunnel.exchanges()) {
    assert.ok(!x.request.target.includes(links.main!.cap), 'no capability in a request target')
    assert.equal(x.request.headers.referer, undefined, 'no referrer sent')
    assert.equal(x.request.headers.cookie, undefined, 'no cookie sent')
    if (x.response) assert.equal(x.response.headers['set-cookie'], undefined, 'no cookie set')
  }
  assert.deepEqual(viewer.errors.filter((e) => /Content Security Policy|Refused to/i.test(e)), [], 'no CSP violation')
  results.viewer_errors = viewer.errors
})

test('revoked from the app: the open viewer ends at once, nothing after reaches anyone, the capability is gone', async () => {
  const context = await browser.newContext({ viewport: { width: 1400, height: 950 } })
  const page = await context.newPage()
  const streamsBefore = tunnel.exchanges().filter((x) => x.request.target === PATHS.stream && x.request.headers.authorization === `Bearer ${links.main!.cap}`).length
  let revokedAt = 0
  try {
    await page.goto(`${BASE}/?token=${info.token}`)
    await page.click(SEL.session(ids.session))
    await openLivePanel(page)
    const row = page.locator(SEL.link(links.main!.id))
    await row.waitFor()
    await row.locator(SEL.linkRevoke).click()
    // a first click only asks; Keep would leave it working
    assert.equal(await row.getAttribute('data-state'), 'active', 'nothing revoked before the confirmation')
    await row.locator(SEL.revokeConfirm).click()
    revokedAt = Date.now()
    await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute('data-state') === 'revoked', SEL.link(links.main!.id), { timeout: 10_000 })
    await shot(page, 'owner-link-revoked.png', SEL.shareDialog)
  } finally { await context.close() }
  // the open stream ends within seconds, not at the next request: `ended {revoked}` when nothing was queued, else cut
  // (the service aborts a stream with a frame still queued, so nothing queued before the revoke is delivered)
  await clients.main!.waitFor('the stream closed', (c) => c.closedAt !== null, 5000)
  assert.ok(clients.main!.closedAt! - revokedAt < 5000, `closed ${clients.main!.closedAt! - revokedAt} ms after the revoke`)
  assert.ok([null, 'revoked'].includes(clients.main!.ended()), `ended: ${clients.main!.ended()}`)
  results.revoke_node_end = clients.main!.ended() ?? 'cut'
  await viewer.page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute('data-phase') === 'ended', SEL.viewer, { timeout: 5000 })
  assert.equal(await viewer.page.locator(SEL.viewer).getAttribute('data-ended-reason'), 'revoked')
  await shot(viewer.page, 'viewer-revoked.png')
  const shownAtRevoke = await threadText(viewer.page)

  // work after the revoke: nowhere
  const afterRun = await chat(`${LIVE_CASES.quick} ${LIVE_MARKS.after_revoke}`)
  assert.equal(await runEnds(afterRun), 'done')
  await sleep(3000)
  const mainStreams = tunnel.exchanges().filter((x) => x.request.target === PATHS.stream && x.request.headers.authorization === `Bearer ${links.main!.cap}`)
  assert.equal(mainStreams.length, streamsBefore, 'the viewer did not ask again (a permanent end)')
  for (const x of mainStreams) {
    assert.ok(streamEnded(x), 'every stream of the link ended (its response finished, or its connection closed)')
    const frames = parseSse(x.response?.body.toString('utf8') ?? '')
    const end = frames.findIndex((f) => f.event === 'ended')
    if (end >= 0) assert.equal(end, frames.length - 1, 'nothing after `ended`')
  }
  // scoped to the revoked link (the plain and excl links stay active and DO get it, below): its streams' decoded
  // bodies, its node reader, its page
  const mainBodies = mainStreams.map((x) => x.response?.body.toString('utf8') ?? '').join('\n')
  assert.equal(count(mainBodies + clients.main!.raw, LIVE_MARKS.after_revoke), 0)
  const shownAfter = await threadText(viewer.page)
  assert.ok(!shownAfter.includes(LIVE_MARKS.after_revoke))
  results.viewer_after_revoke = { chars_at_revoke: shownAtRevoke.length, chars_after: shownAfter.length, cleared: shownAfter.length === 0 }
  // the capability: gone (410 revoked) on the stream, refused on a picture, reveal refused
  const again = await fetch(`${tunnel.origin}${PATHS.stream}`, { headers: { authorization: `Bearer ${links.main!.cap}` } })
  assert.equal(again.status, 410)
  assert.deepEqual((await body(again)).json, { error: 'gone', reason: 'revoked' })
  const pic = clients.plain!.last()!.snapshot.images[0]?.resource ?? `m${'1'.repeat(24)}`
  assert.ok([401, 404, 410].includes(await statusOf(fetch(`${tunnel.origin}${PATHS.image}${pic}`, { headers: { authorization: `Bearer ${links.main!.cap}` } }))))
  const reveal = await req<{ code?: string }>('POST', `/api/share-links/${links.main!.id}/reveal`, {})
  assert.equal(reveal.status, 410)
  assert.equal(reveal.body.code, 'share_link_inactive')
  // the other links of the session see the new work (only the revoked one stopped)
  await clients.plain!.waitFor('the work after the revoke', (c) => JSON.stringify(c.last()).includes(LIVE_MARKS.after_revoke), 15_000)
  // revoking twice is no error
  assert.equal((await api<{ link: { state: string } }>('POST', `/api/share-links/${links.main!.id}/revoke`, {})).link.state, 'revoked')
})

test('expired: a connected viewer ends when its link expires, nothing after; an expired link is gone; a 30-day link stays open', async () => {
  const exp = await createLink({ label: 'expires (synthetic)', include_tool_details: true })
  links.exp = { id: exp.id, cap: exp.cap, url: exp.url }
  const at = await expireIn(exp.id, 8000)
  const client = await StreamClient.open('exp', tunnel.origin, exp.cap)
  clients.exp = client
  await client.waitFor('a first state', (c) => c.states().length > 0)
  assert.equal(new Date(client.last()!.expires_at).getTime(), new Date(at).getTime(), 'the stream says the stored expiry')
  const page = await openViewer(exp.url!, 'exp')
  await page.page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute('data-phase') === 'connected', SEL.viewer, { timeout: 15_000 })
  await client.waitFor('the stream closed', (c) => c.closedAt !== null, 20_000)
  assert.ok([null, 'expired'].includes(client.ended()), `ended: ${client.ended()}`)
  results.expiry_node_end = client.ended() ?? 'cut'
  assert.ok(client.closedAt! - new Date(at).getTime() < 3000, `ended ${client.closedAt! - new Date(at).getTime()} ms after the expiry`)
  await page.page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute('data-ended-reason') === 'expired', SEL.viewer, { timeout: 5000 })
  await shot(page.page, 'viewer-expired.png')
  const afterRun = await chat(`${LIVE_CASES.quick} ${LIVE_MARKS.after_expiry}`)
  assert.equal(await runEnds(afterRun), 'done')
  await sleep(2000)
  const expBodies = tunnel.exchanges().filter((x) => x.request.headers.authorization === `Bearer ${exp.cap}`).map((x) => x.response?.body.toString('utf8') ?? '').join('\n')
  assert.equal(count(expBodies + client.raw, LIVE_MARKS.after_expiry), 0, 'nothing after the expiry on its streams')
  assert.ok(tunnel.exchanges().filter((x) => x.request.headers.authorization === `Bearer ${exp.cap}` && x.request.target === PATHS.stream).every(streamEnded), 'its streams ended')
  assert.ok(!(await threadText(page.page)).includes(LIVE_MARKS.after_expiry))
  const gone = await fetch(`${tunnel.origin}${PATHS.stream}`, { headers: { authorization: `Bearer ${exp.cap}` } })
  assert.equal(gone.status, 410)
  assert.deepEqual((await body(gone)).json, { error: 'gone', reason: 'expired' })
  assert.equal((await listLinks()).find((l) => l.id === exp.id)?.state, 'expired')
  await page.context.close()

  // a link already expired when it is asked: 410 expired, no state
  const late = await createLink({ label: 'already expired' })
  await expireIn(late.id, -1000)
  const lateRes = await fetch(`${tunnel.origin}${PATHS.stream}`, { headers: { authorization: `Bearer ${late.cap}` } })
  assert.equal(lateRes.status, 410)
  assert.deepEqual((await body(lateRes)).json, { error: 'gone', reason: 'expired' })

  // the longest life (30 days, past a 32-bit timer's reach): open, and still open seconds later
  const month = await createLink({ label: 'a month', expires_in_s: 30 * 24 * 3600 })
  const monthClient = await StreamClient.open('month', tunnel.origin, month.cap)
  clients.month = monthClient
  await monthClient.waitFor('a first state', (c) => c.states().length > 0)
  await sleep(3000)
  assert.equal(monthClient.ended(), null, 'a 30-day link is not ended at once')
  assert.equal(monthClient.closedAt, null)
  monthClient.close()
})

test('the share listener answers its exact GETs only: nothing of the app, its token, the gateway or this test server', async () => {
  const cap = links.plain!.cap
  const P = LIVE_PORT
  // the five paths, and their headers
  const page = await rawGet(P, PATHS.page)
  assert.equal(page.status, 200)
  assert.match(page.headers['content-type'] ?? '', /^text\/html/)
  for (const [path, type] of [[PATHS.script, /javascript/], [PATHS.style, /^text\/css/]] as const) {
    const r = await rawGet(P, path)
    assert.equal(r.status, 200, path)
    assert.match(r.headers['content-type'] ?? '', type)
  }
  const headerChecks: Record<string, unknown> = {}
  for (const path of [PATHS.page, PATHS.script, PATHS.style, '/nope']) {
    const r = await rawGet(P, path)
    headerChecks[path] = { status: r.status, csp: r.headers['content-security-policy'] }
    assert.equal(r.headers['cache-control'], 'no-store', `${path}: no-store`)
    assert.equal(r.headers['x-content-type-options'], 'nosniff')
    assert.equal(r.headers['referrer-policy'], 'no-referrer')
    assert.equal(r.headers['cross-origin-resource-policy'], 'same-origin')
    assert.equal(r.headers['x-frame-options'], 'DENY')
    assert.equal(r.headers['content-security-policy'], LIVE_CSP)
    assert.equal(r.headers['access-control-allow-origin'], undefined, 'no CORS')
    assert.equal(r.headers['set-cookie'], undefined)
  }
  results.listener_headers = headerChecks
  // the stream needs its capability; a wrong one, the session token, a query, an upgrade, a body are refused
  assert.equal((await rawGet(P, PATHS.stream)).status, 401)
  assert.equal((await rawGet(P, PATHS.stream, { authorization: `Bearer ${'A'.repeat(43)}` })).status, 401)
  assert.equal((await rawGet(P, PATHS.stream, { authorization: `Bearer ${SESSION_TOKEN}` })).status, 401)
  assert.equal((await rawGet(P, PATHS.stream, { 'x-oasis-code-token': SESSION_TOKEN })).status, 401)
  for (const [what, r] of [
    ['query capability', await rawGet(P, `${PATHS.stream}?capability=${cap}`)],
    ['query token', await rawGet(P, `${PATHS.page}?token=${SESSION_TOKEN}`)],
    ['upgrade', await rawGet(P, PATHS.stream, { authorization: `Bearer ${cap}`, upgrade: 'websocket', connection: 'Upgrade' })],
    ['body', await rawGet(P, PATHS.stream, { authorization: `Bearer ${cap}` }, 'GET', '{}')],
    ['agent browser', await rawGet(P, PATHS.page, { 'x-oasis-code-agent-browser': '1' })],
  ] as const) assert.ok(r.status >= 400 && r.status < 500, `${what}: refused (${r.status})`)
  // every other method on each path: 405
  for (const path of [PATHS.page, PATHS.script, PATHS.style, PATHS.stream, `${PATHS.image}m${'0'.repeat(24)}`]) {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE']) {
      const r = await rawGet(P, path, { authorization: `Bearer ${cap}` }, method)
      assert.equal(r.status, 405, `${method} ${path}: ${r.status}`)
    }
  }
  // nothing else: the app's pages and API (with its token too), the owner's share routes, the gateway's, this test
  // server's own routes, traversals and near-misses
  const sid = ids.session
  const others = [
    '/', '/index.html', '/assets/index.js', '/favicon.ico', '/live', '/live/index.html', '/live/assets/', '/live/assets/index.js', '/live/assets/live-share.js.map',
    '/live/api/', '/live/api/stream/', '/live/api/streamx', '/LIVE/', '/live//api/stream',
    '/live/%2e%2e/api/sessions', '/live/assets/%2e%2e/%2e%2e/index.html', '/live/assets/..%2f..%2findex.html', '/live/api/../../api/sessions',
    '/api/meta/build', '/api/sessions', `/api/sessions/${sid}`, `/api/sessions/${sid}/replay`, `/api/sessions/${sid}/share-links`, `/api/share-links/${links.plain!.id}/reveal`,
    '/api/settings/live-share', `/api/runs/${ids.progress}`, `/api/runs/${ids.progress}/transcript`, `/api/sessions/${sid}/share-snapshot`,
    '/healthz', '/mcp', '/sse', '/.well-known/oauth-authorization-server', '/oauth/authorize', '/e2e/ui-release', '/e2e/live-share/expires-at', '/api/__e2e/image-requests',
  ]
  const leaks: string[] = []
  const answers: Record<string, number> = {}
  for (const path of others) {
    for (const headers of [{}, { 'x-oasis-code-token': SESSION_TOKEN, authorization: `Bearer ${cap}` }] as Record<string, string>[]) {
      const r = await rawGet(P, path, headers)
      answers[`${path}${Object.keys(headers).length ? ' +auth' : ''}`] = r.status
      assert.ok(r.status === 404 || r.status === 400, `${path}: ${r.status}`)
      const body = r.body.toString('utf8')
      if (r.status === 404 && body) assert.deepEqual(JSON.parse(body), { error: 'not_found' }, `${path}: the listener's own 404`)
      if (body.includes(sid) || /\brun_[0-9a-f]{6,}/.test(body) || body.includes(SESSION_TOKEN) || body.includes(info.repo)) leaks.push(path)
    }
  }
  for (const method of ['POST', 'PUT', 'DELETE']) {
    for (const path of [`/api/sessions/${sid}/share-links`, `/api/share-links/${links.plain!.id}/revoke`, '/api/settings/live-share', `/api/sessions/${sid}/chat`, '/e2e/ui-release']) {
      const r = await rawGet(P, path, { 'x-oasis-code-token': SESSION_TOKEN, 'content-type': 'application/json' }, method, '{}')
      answers[`${method} ${path}`] = r.status
      assert.ok([400, 404, 405].includes(r.status), `${method} ${path}: ${r.status}`)
    }
  }
  // a picture by no valid resource: 404 with the capability, refused without it
  for (const bad of ['img1', '', `m${'0'.repeat(23)}`, `M${'0'.repeat(24)}`, `m${'0'.repeat(24)}.png`, `m${'0'.repeat(24)}/x`]) {
    const withCap = await rawGet(P, `${PATHS.image}${bad}`, { authorization: `Bearer ${cap}` })
    answers[`image ${bad || '(empty)'}`] = withCap.status
    assert.equal(withCap.status, 404, `image ${bad}: ${withCap.status}`)
    const without = await rawGet(P, `${PATHS.image}${bad}`)
    assert.ok([401, 404].includes(without.status), `image ${bad} without capability: ${without.status}`)
  }
  // an absolute-form target naming the app's port: the listener's own answer, never the app's
  const absolute = await raw(P, `GET http://127.0.0.1:${PORT}/api/sessions HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nx-oasis-code-token: ${SESSION_TOKEN}\r\nConnection: close\r\n\r\n`)
  answers.absolute_form = absolute.status
  assert.ok(absolute.status >= 400 && !absolute.body.toString('utf8').includes(sid))
  results.listener_answers = answers
  assert.deepEqual(leaks, [], 'no answer of the listener holds anything of the app')
  // nothing the owner can do is reachable through the tunnel either (the same listener): revoke stays the owner's
  assert.equal((await listLinks()).find((l) => l.id === links.plain!.id)?.state, 'active', 'no request above revoked anything')
})

test('the owner API is the owner\'s: refused to a connector, a director, an agent browser; a deleted session ends its viewers', async () => {
  for (const h of NOT_OWNER) {
    for (const [method, path] of [['POST', `/api/sessions/${ids.session}/share-links`], ['GET', `/api/sessions/${ids.session}/share-links`], ['POST', `/api/share-links/${links.plain!.id}/reveal`], ['POST', `/api/share-links/${links.plain!.id}/revoke`]] as const) {
      const r = await req<{ code?: string; detail?: string }>(method, path, method === 'POST' ? {} : undefined, h)
      assert.ok(r.status === 403 || r.status === 401, `${method} ${path} ${JSON.stringify(h)}: ${r.status}`)
      // the agent's browser is refused by the app's own auth before any route (every API route, sign-in included), with
      // that refusal's words; every other caller reaches the share routes and is refused by their owner guard
      if (r.status === 403 && 'x-oasis-code-agent-browser' in h) assert.match(r.body?.detail ?? '', /agent's browser/, `${method} ${path}: ${r.text.slice(0, 200)}`)
      else if (r.status === 403) assert.equal(r.body?.code, 'share_owner_only', `${method} ${path} ${JSON.stringify(h)}: ${r.text.slice(0, 200)}`)
    }
  }
  assert.equal((await listLinks()).find((l) => l.id === links.plain!.id)?.state, 'active', 'nothing revoked by a refused caller')
  // the LAN mapping (never bound here: enabled stays as it is, the link's URL follows the settings)
  const now = await api<{ settings: Record<string, unknown> }>('GET', '/api/settings/live-share')
  const lan = await settingsPut({ enabled: false, bind: 'lan', port: LIVE_PORT, public_base_url: null })
  assert.equal(lan.status, 200)
  assert.equal((await api<{ url: string | null }>('POST', `/api/share-links/${links.plain!.id}/reveal`, {})).url, null, 'lan without a base URL: no URL to copy')
  const lanBase = await settingsPut({ enabled: false, bind: 'lan', port: LIVE_PORT, public_base_url: 'http://192.0.2.20:8325' })
  assert.equal(lanBase.status, 200)
  assert.equal((await api<{ url: string | null }>('POST', `/api/share-links/${links.plain!.id}/reveal`, {})).url, `http://192.0.2.20:8325/live/#${links.plain!.cap}`)
  const loop = await settingsPut({ enabled: false, bind: 'loopback', port: LIVE_PORT, public_base_url: null })
  assert.equal(loop.status, 200)
  assert.equal((await api<{ url: string | null }>('POST', `/api/share-links/${links.plain!.id}/reveal`, {})).url, `http://127.0.0.1:${LIVE_PORT}/live/#${links.plain!.cap}`)
  // turned off: open viewers are told (disabled: retry later), nothing listens
  await clients.plain!.waitFor('the stream closed', (c) => c.closedAt !== null, 10_000)
  assert.ok([null, 'disabled'].includes(clients.plain!.ended()), `ended: ${clients.plain!.ended()}`)
  results.disabled_node_end = clients.plain!.ended() ?? 'cut'
  results.disabled_probe = await rawGet(LIVE_PORT, PATHS.page).then((r) => r.status).catch(() => 'refused')
  assert.ok(results.disabled_probe === 'refused' || results.disabled_probe === 0, `nothing listens once off: ${String(results.disabled_probe)}`)
  const restore = await settingsPut({ ...(now.settings as Record<string, unknown>) })
  assert.equal(restore.status, 200)
  await ensureListening()

  // a deleted session: its viewers end (session_deleted), its links are gone
  const other = (await api<{ id: string }>('POST', `/api/projects/${ids.project}/sessions`, { title: 'Bob scratch (synthetic)', model: LIVE_ROUTE })).id
  const made = await api<{ link: { id: string }; capability: string }>('POST', `/api/sessions/${other}/share-links`, {})
  const c = await StreamClient.open('deleted', tunnel.origin, made.capability)
  clients.deleted = c
  await c.waitFor('a first state', (x) => x.states().length > 0)
  const del = await req('DELETE', `/api/sessions/${other}`)
  assert.ok(del.status >= 200 && del.status < 300, `delete: ${del.status} ${del.text.slice(0, 200)}`)
  await c.waitFor('the stream closed', (x) => x.closedAt !== null, 10_000)
  assert.ok([null, 'session_deleted'].includes(c.ended()), `ended: ${c.ended()}`)
  results.deleted_node_end = c.ended() ?? 'cut'
  const gone = await statusOf(fetch(`${tunnel.origin}${PATHS.stream}`, { headers: { authorization: `Bearer ${made.capability}` } }))
  assert.ok([401, 410].includes(gone), `the deleted session's link: ${gone}`)
})

// ======================================================================================================================
// protocol 2: one link, every session of a task (live_share_fixture.ts TASK_*)
// ======================================================================================================================

const roleOfTitle = (title: string): TaskRole | null => (Object.entries(TASK_TITLES).find(([, t]) => title.includes(t))?.[0] as TaskRole | undefined) ?? null
const byRole = (snap: SnapshotV2, role: TaskRole) => snap.sessions.find((s) => roleOfTitle(s.title) === role)
/** The product's bots and the main agent's pick (contract/src/bots.ts), restated: a drift fails here, loudly. */
const BOTS = ['01-keycap', '02-terminal', '03-cursor', '04-braces', '05-bubble', '07-pixel', '08-prompt', '09-spark', '10-hex', '13-puzzle', '15-rocket', '16-lens', '17-shield',
  '18-robot', '19-chip', '20-at', '21-megaphone', '22-whistle', '23-signpost', '24-badge', '25-compass', '26-crownblob', '27-crown', '28-flag', '29-lighthouse', '30-telescope', '31-pin', '32-helm', '33-bell']
const SHARE_BOT_NAMES = [...BOTS, 'director', 'chatgpt']
function hashOf(text: string): number { let h = 2166136261; for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619) } return h >>> 0 }
const mainBot = (sessionId: string): string => BOTS[hashOf(`session:${sessionId}`) % BOTS.length]!
/** the mark of the run held in the member of the other project (its gate: TASK_GATES.hold) */
const HOLD_MARK = 'TASKHOLDMARK_4e1a'
const AFTER_REVOKE_TASK = 'TASKAFTERREVOKE_6c2d'

/** A PNG of a session of the task: its own size and colour, its own metadata canary (synthetic). */
function taskPng(role: TaskRole): Uint8Array {
  const spec = TASK_IMAGES[role]
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0)
    return Buffer.concat([len, td, crc])
  }
  const { w, h, rgb } = spec
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 2, 0, 0, 0], 8)
  const rows = Buffer.alloc((1 + w * 3) * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rows.set([rgb[0], (rgb[1] + y * 3) % 256, rgb[2]], y * (1 + w * 3) + 1 + x * 3)
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('tEXt', Buffer.from(`Comment\0${spec.meta} owner ${TASK_HOME_USER}`, 'latin1')),
    chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0)),
  ]))
}
async function chatIn(session: string, text: string, model = TASK_ROUTE, extra: Record<string, unknown> = {}): Promise<string> {
  return (await api<{ id: string }>('POST', `/api/sessions/${session}/chat`, { text, model, ...extra })).id
}
async function makeSession(title: string, project: string, join?: string): Promise<string> {
  return (await api<{ id: string }>('POST', `/api/projects/${project}/sessions`, { title, model: TASK_ROUTE, ...(join ? { task_session_id: join } : {}) })).id
}
/** a session of the task: its mark, its picture shown to a model that takes images */
async function furnish(session: string, role: TaskRole): Promise<void> {
  assert.equal(await runEnds(await chatIn(session, `${TASK_CASES.mark} ${TASK_MARKS[role]}`)), 'done')
  const res = await fetch(`${BASE}/api/sessions/${session}/attachments?name=${role}-picture.png`, { method: 'POST', headers: { 'x-oasis-code-token': info.token, origin: BASE, 'content-type': 'image/png' }, body: taskPng(role) as unknown as BodyInit })
  const up = await body(res)
  assert.ok(res.ok, `upload: ${up.status} ${up.text.slice(0, 200)}`)
  const asset = (up.json as { asset_id?: string; id?: string }).asset_id ?? (up.json as { id?: string }).id ?? ''
  L.assets[role] = asset
  assert.equal(await runEnds(await chatIn(session, `${TASK_MARKS[role]}: look at this picture`, 'scripted:e', { attachments: [asset] })), 'done')
}
/** POST …/share-links/v2 (its capability kept with the links, so every scan looks for it) */
async function createLinkV2(name: string, session: string, b: Record<string, unknown>): Promise<{ id: string; cap: string; url: string | null; link: ListedLink }> {
  const r = await api<{ link: ListedLink; capability: string; url: string | null }>('POST', `/api/sessions/${session}/share-links/v2`, b)
  assert.match(r.link.id, LINK_ID)
  assert.match(r.capability, CAPABILITY)
  links[name] = { id: r.link.id, cap: r.capability, url: r.url }
  return { id: r.link.id, cap: r.capability, url: r.url, link: r.link }
}
/** a node reader of a link, its first state read */
async function reader(name: string, cap: string): Promise<StreamClient> {
  const c = await StreamClient.open(name, tunnel.origin, cap)
  clients[name] = c
  assert.equal(c.status, 200, `${name}: ${c.status} ${c.raw.slice(0, 200)}`)
  await c.waitFor(`${name}: a first state`, (x) => x.v2().length > 0)
  return c
}
const imageGet = (cap: string | null, resource: string) => fetch(`${tunnel.origin}${PATHS.image}${resource}`, { headers: cap ? { authorization: `Bearer ${cap}` } : {} })
/** the session the viewer shows now (the element that names it) */
const shownKey = (page: Page) => page.evaluate((sel) => document.querySelector(sel)?.getAttribute('data-testid')?.replace(/^share-session-/, '') ?? null, SEL.viewerShown)
/** wait until the page shows the session `pred` accepts (its key, or null when no list is drawn) */
const shownBecomes = (page: Page, pred: string, key: string) => page.waitForFunction(({ sel, pred, key }) => {
  const k = document.querySelector(sel)?.getAttribute('data-testid')?.replace(/^share-session-/, '') ?? null
  return pred === 'is' ? k === key : k !== null && k !== key
}, { sel: SEL.viewerShown, pred, key }, { timeout: 10_000 })
/** the pictures the viewer's thread shows (no bot), decoded for real */
const shownPictures = (page: Page) => page.evaluate(async (sel) => {
  const out: { ok: boolean; w: number; h: number }[] = []
  for (const i of Array.from(document.querySelectorAll(`${sel} img:not(.bot-img)`)) as HTMLImageElement[]) {
    i.scrollIntoView({ block: 'center' })
    out.push({ ok: await i.decode().then(() => true, () => false), w: i.naturalWidth, h: i.naturalHeight })
  }
  return out
}, SEL.viewerThread)
/** the session shown is `key`, twice over: its list entry is the active one, and the thread holds its own mark and no
 *  other session's of the task */
async function assertShown(page: Page, snap: SnapshotV2, key: string): Promise<void> {
  await shownBecomes(page, 'is', key)
  const role = roleOfTitle(snap.sessions.find((s) => s.key === key)!.title)!
  await waitText(page, TASK_MARKS[role])
  const text = await threadText(page)
  for (const other of (['root', 'a', 'b', 'side', 'late'] as const).filter((r) => r !== role)) assert.ok(!text.includes(TASK_MARKS[other]), `${role} shown: nothing of ${other}`)
}
/** The pictures of the session shown, once they are there: a session chosen drops the pictures of the one before and
 *  only then fetches its own (share/live/liveState.ts apply → pump; a picture loading draws no img), so the page is
 *  waited for — bounded — until it draws at least as many pictures as the session's image items name, every one loaded
 *  with its natural size; then each is decoded and measured (the caller checks they are the session's own). */
async function ownPictures(page: Page, session: LiveSessionV2): Promise<{ ok: boolean; w: number; h: number }[]> {
  const own = new Set(session.images.map((i) => i.resource))
  const wanted = new Set(session.items.flatMap((i) => (i.kind === 'image' && i.image && own.has(i.image) ? [i.image] : []))).size
  assert.ok(wanted >= 1, `${session.title}: an image item of its own`)
  await page.waitForFunction(({ sel, n }) => {
    const imgs = Array.from(document.querySelectorAll(`${sel} img:not(.bot-img)`)) as HTMLImageElement[]
    return imgs.length >= n && imgs.every((i) => i.complete && i.naturalWidth > 0 && i.naturalHeight > 0)
  }, { sel: SEL.viewerThread, n: wanted }, { timeout: 15_000 })
  return shownPictures(page)
}
async function showSession(page: Page, key: string): Promise<void> {
  await page.click(SEL.viewerSession(key))
  await shownBecomes(page, 'is', key)
}
async function deleteSession(id: string): Promise<number> {
  const r = await req('DELETE', `/api/sessions/${id}`)
  assert.ok(r.status >= 200 && r.status < 300, `delete: ${r.status} ${r.text.slice(0, 200)}`)
  return Date.now()
}

let taskViewer: Awaited<ReturnType<typeof openViewer>> | null = null
let rootViewer: Awaited<ReturnType<typeof openViewer>> | null = null

test('v2 fixture: a task across two projects (its first session, a member, a member of another project) and a task of its own, each with its mark and picture', async () => {
  await ensureListening()
  L.projectB = (await api<{ id: string }>('POST', '/api/projects', { source_path: info.repo_b, name: 'live-share-fixture-b' })).id
  L.root = await makeSession(TASK_TITLES.root, ids.project)
  L.a = await makeSession(TASK_TITLES.a, ids.project, L.root)
  L.b = await makeSession(TASK_TITLES.b, L.projectB, L.a)
  L.side = await makeSession(TASK_TITLES.side, ids.project)
  for (const [role, id] of [['root', L.root], ['a', L.a], ['b', L.b], ['side', L.side]] as const) await furnish(id, role)
  // a harmless command of the member of the other project prints a bearer header (redacted in every share)
  assert.equal(await runEnds(await chatIn(L.b, `${TASK_CASES.tool} ${TASK_MARKS.b}`)), 'done')
  // the task's canaries are really in its sessions' records (their absence from every byte a viewer gets is not vacuous);
  // each picture's metadata canary is in the bytes uploaded (taskPng writes it)
  const records = (await Promise.all([L.root, L.a, L.b, L.side].map((id) => req('GET', `/api/sessions/${id}/replay`)))).map((r) => r.text).join('\n')
  const inRecords = { task_mail: records.includes(TASK_SECRETS.mail), task_home_user: records.includes(TASK_HOME_USER), task_bearer: records.includes(TASK_SECRETS.bearer) }
  results.task_canaries_in_records = inRecords
  assert.deepEqual(Object.entries(inRecords).filter(([, v]) => !v).map(([k]) => k), [], 'every task canary is in the task sessions\' records')
  for (const r of Object.keys(TASK_IMAGES) as TaskRole[]) assert.ok(Buffer.from(taskPng(r)).toString('latin1').includes(TASK_IMAGES[r].meta))
  const detail = await api<{ task_root_id: string | null; task_sessions: { id: string }[] }>('GET', `/api/sessions/${L.b}`)
  assert.equal(detail.task_root_id, L.root)
  assert.deepEqual(detail.task_sessions.map((s) => s.id).sort(), [L.root, L.a, L.b].sort())
})

test('v2: a task link made in the app (off by default) — one link for every session, listed by each; a second link of the task shares its sessions, its own start', async () => {
  await ensureListening()
  const context = await browser.newContext({ viewport: { width: 1400, height: 950 } })
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE })
  const page = await context.newPage()
  try {
    await page.goto(`${BASE}/?token=${info.token}`)
    await page.click(SEL.session(L.a))
    await openLivePanel(page)
    assert.equal(await page.isChecked(SEL.task), false, 'every session of the task: off by default')
    await page.check(SEL.images)
    await page.check(SEL.task)
    assert.equal(await page.locator('[data-testid="live-share-runs"]').count(), 0, 'a task link: no run list')
    await shot(page, 'owner-task-link-options.png', SEL.shareDialog)
    await page.click(SEL.create)
    await page.waitForFunction((sel) => { const el = document.querySelector(sel); return !!el && (el instanceof HTMLInputElement ? el.value : el.textContent ?? '').includes('/live/#') }, SEL.url, { timeout: 30_000 })
    const url = await page.locator(SEL.url).evaluate((el) => (el instanceof HTMLInputElement ? el.value : el.textContent ?? '').trim())
    const cap = /\/live\/#([A-Za-z0-9_-]{43})$/.exec(url)?.[1]
    assert.ok(cap, 'the URL carries the capability in its fragment')
    const made = (await listLinks(L.a)).find((l) => l.scope === 'task')
    assert.ok(made, 'the task link is listed')
    assert.deepEqual([made!.protocol, made!.scope, made!.members, made!.state], [2, 'task', 3, 'active'])
    assert.deepEqual(made!.options, { include_tool_details: false, include_images: true, exclude_run_ids: [] })
    links.task1 = { id: made!.id, cap: cap!, url }
    // the panel's row says it is the task's, with how many sessions it holds now
    const row = page.locator(SEL.link(made!.id))
    await row.waitFor()
    assert.match(await row.innerText(), /all sessions \(3\)/)
    await shot(page, 'owner-task-link-ready.png', SEL.shareDialog)
    await page.keyboard.press('Escape')
  } finally { await context.close() }
  // every session of the task lists it (its own links, and its task's); the task beside it does not
  for (const id of [L.root, L.b]) assert.ok((await listLinks(id)).some((l) => l.id === links.task1!.id), 'listed by every session of the task')
  assert.ok(!(await listLinks(L.side)).some((l) => l.id === links.task1!.id), 'not by the task beside it')
  // the same task from its first session, the same options; and a link of the task beside it (one session, v2)
  await createLinkV2('task2', L.root, { label: 'task from its first session', include_images: true, include_task_sessions: true })
  await createLinkV2('side', L.side, { label: 'the task beside it', include_images: true })
  const t1 = await reader('task1', links.task1!.cap)
  const t2 = await reader('task2', links.task2!.cap)
  const sd = await reader('side', links.side!.cap)
  const [f1, f2, fs] = [t1.lastV2()!, t2.lastV2()!, sd.lastV2()!]
  for (const f of [f1, f2]) {
    assert.deepEqual([f.snapshot.format, f.snapshot.version, f.snapshot.scope, f.snapshot.sessions.length], ['oasis-code.session-live', 2, 'task', 3])
    assert.deepEqual(f.snapshot.options, { include_tool_details: false, include_images: true, include_task_sessions: true })
    assert.deepEqual(f.snapshot.sessions.map((s) => roleOfTitle(s.title)), ['root', ...f.snapshot.sessions.slice(1).map((s) => roleOfTitle(s.title))], 'the first session first')
    assert.deepEqual(f.snapshot.sessions.map((s) => s.member), [false, true, true])
  }
  // one projection for the task: the same keys, titles, order and shown session; each link its own start
  assert.deepEqual(f1.snapshot.sessions.map((s) => [s.key, s.title]), f2.snapshot.sessions.map((s) => [s.key, s.title]))
  assert.equal(f1.snapshot.current, f2.snapshot.current)
  assert.equal(f1.snapshot.current, byRole(f1.snapshot, 'root')!.key, 'the task\'s first session is the one shown first')
  assert.equal(f1.start, byRole(f1.snapshot, 'a')!.key, 'the link made from the member starts there')
  assert.equal(f2.start, byRole(f2.snapshot, 'root')!.key, 'the link made from the first session starts there')
  assert.deepEqual([fs.snapshot.scope, fs.snapshot.sessions.length, fs.start], ['session', 1, fs.snapshot.current])
  // the bots: of the product; the main agent's picked by the real session id (as the app picks it), first in the rail's
  for (const f of [f1, fs]) for (const s of f.snapshot.sessions) {
    const role = roleOfTitle(s.title)!
    const id = { root: L.root, a: L.a, b: L.b, side: L.side, c: '', late: L.late }[role]
    for (const b of [...s.bots, ...s.runs.map((r) => r.bot), ...s.team.rows.map((r) => r.bot)]) if (b !== null) assert.ok(SHARE_BOT_NAMES.includes(b), `a bot of the product: ${b}`)
    assert.equal(s.bots[0], mainBot(id), `${role}: the main agent's bot first`)
    const run = s.items.find((i) => i.kind === 'message' && (i.text ?? '').includes(`noted ${TASK_MARKS[role]}`))?.run
    assert.equal(s.runs.find((r) => r.key === run)?.bot, mainBot(id), `${role}: its answer wears the main agent's bot`)
    for (const r of s.team.rows) if (r.turn !== null) assert.ok(s.runs.some((x) => x.key === r.turn), `${role}/${r.key}: a turn of its own session`)
  }
  // each session's pictures its own: resources never shared between sessions, between links of other tasks
  const res = (f: StateFrameV2) => f.snapshot.sessions.flatMap((s) => s.images.map((i) => i.resource))
  assert.equal(new Set(res(f1)).size, res(f1).length, 'a resource of one session only')
  for (const s of f1.snapshot.sessions) assert.ok(s.images.length >= 1 && s.images.every((i) => i.width === TASK_IMAGES[roleOfTitle(s.title)!].w && i.height === TASK_IMAGES[roleOfTitle(s.title)!].h), `${s.title}: its own picture`)
  results.v2_task_frames = { sessions: f1.snapshot.sessions.map((s) => ({ key: s.key, role: roleOfTitle(s.title), bots: s.bots, images: s.images.length, rows: s.team.rows.length })), start: [f1.start, f2.start], current: f1.snapshot.current }
})

test('v2 viewer: the task\'s sessions as the rail lists them, opened where the link was made; each session its own thread and pictures; a picture of another link refused', async () => {
  const f = clients.task1!.lastV2()!
  taskViewer = await openViewer(links.task1!.url!, 'task1')
  const page = taskViewer.page
  await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute('data-phase') === 'connected', SEL.viewer, { timeout: 30_000 })
  await page.locator(SEL.viewerSessions).waitFor({ timeout: 15_000 })
  assert.equal(await page.locator(SEL.viewerEntries).count(), 3)
  assert.equal(await shownKey(page), f.start, 'it opens on the session the link was made from')
  await assertShown(page, f.snapshot, f.start!)
  const listBots = await page.locator(`${SEL.viewerSessions} .rail-session-row`).evaluateAll((rows) => rows.map((r) => Array.from(r.querySelectorAll('[data-testid="rail-bots"] img[data-bot]')).map((i) => i.getAttribute('data-bot'))))
  assert.deepEqual(listBots, f.snapshot.sessions.map((s) => s.bots.slice(0, 3)), 'the rail\'s bots, stacked')
  assert.equal(await page.locator(SEL.viewerCard).count(), 1, 'the Agent Teams card')
  for (const s of f.snapshot.sessions) {
    const role = roleOfTitle(s.title)!
    await showSession(page, s.key)
    await waitText(page, TASK_MARKS[role])
    const text = await threadText(page)
    for (const other of (['root', 'a', 'b', 'side'] as const).filter((r) => r !== role)) assert.ok(!text.includes(TASK_MARKS[other]), `${role}: nothing of ${other}`)
    const pics = await ownPictures(page, s)
    assert.ok(pics.length >= 1 && pics.every((p) => p.ok && p.w === TASK_IMAGES[role].w && p.h === TASK_IMAGES[role].h), `${role}: its own pictures ${JSON.stringify(pics)}`)
    await shot(page, `viewer-task-${role}.png`)
  }
  // the pictures: each served under the task link, its metadata stripped; refused under another link's capability
  const sideRes = clients.side!.lastV2()!.snapshot.sessions[0]!.images[0]!.resource
  for (const s of f.snapshot.sessions) {
    const ref = s.images[0]!
    const ok = await imageGet(links.task1!.cap, ref.resource)
    assert.equal(ok.status, 200)
    const bytes = Buffer.from(await ok.arrayBuffer())
    assert.equal(bytes.length, ref.bytes)
    assert.ok(!/tEXt|iTXt|zTXt|eXIf/.test(bytes.toString('latin1')) && !bytes.toString('latin1').includes(TASK_IMAGES[roleOfTitle(s.title)!].meta), 'no metadata left')
    assert.equal(await statusOf(imageGet(links.side!.cap, ref.resource)), 404, 'not under another task\'s link')
  }
  assert.equal(await statusOf(imageGet(links.task1!.cap, sideRes)), 404, 'the other task\'s picture: not under this link')
  // the viewer asks for nothing but the page, its assets, its stream and its pictures (the bots are in its bundle)
  for (const r of taskViewer.requests) {
    if (r.url.startsWith('blob:') || r.url.startsWith('data:')) continue
    const u = new URL(r.url)
    assert.ok([PATHS.page, PATHS.script, PATHS.style, PATHS.stream].includes(u.pathname) || (u.pathname.startsWith(PATHS.image) && IMAGE_RESOURCE.test(u.pathname.slice(PATHS.image.length))), `an exact path: ${u.pathname}`)
  }
  const controls = await controlsOf(page)
  assert.deepEqual(controls.mutation_testids, [])
  assert.equal(controls.editable, 0)
  assert.deepEqual(controls.buttons.filter((b) => ACTING.test(b)), [])
})

test('v2: a session joining the task appears; a session working shows it, its dot, then its answer', async () => {
  const page = taskViewer!.page
  // a session joins after the link was made (the task fixed at the link, its sessions read anew)
  L.late = await makeSession(TASK_TITLES.late, ids.project, L.root)
  assert.equal(await runEnds(await chatIn(L.late, `${TASK_CASES.mark} ${TASK_MARKS.late}`)), 'done')
  await clients.task1!.waitFor('the session that joined', (c) => !!c.lastV2() && byRole(c.lastV2()!.snapshot, 'late') !== undefined && JSON.stringify(c.lastV2()).includes(TASK_MARKS.late), 20_000)
  await page.waitForFunction((sel) => document.querySelectorAll(sel).length === 4, SEL.viewerEntries, { timeout: 15_000 })
  assert.equal((await listLinks(L.a)).find((l) => l.id === links.task1!.id)?.members, 4)
  // the member of the other project works (held): active in the state, its dot in the list; then done, its answer
  const bKey = byRole(clients.task1!.lastV2()!.snapshot, 'b')!.key
  const held = await chatIn(L.b, `${TASK_CASES.hold} ${HOLD_MARK}`)
  await clients.task1!.waitFor('the member working', (c) => byRole(c.lastV2()!.snapshot, 'b')?.active === true, 20_000)
  await page.locator(SEL.viewerDot(bKey)).waitFor({ timeout: 10_000 })
  await shot(page, 'viewer-task-member-working.png')
  await release(TASK_GATES.hold(HOLD_MARK))
  assert.equal(await runEnds(held), 'done')
  await clients.task1!.waitFor('the member done', (c) => { const b = byRole(c.lastV2()!.snapshot, 'b'); return b?.active === false && JSON.stringify(b).includes(`noted ${HOLD_MARK}`) }, 20_000)
  await page.locator(SEL.viewerDot(bKey)).waitFor({ state: 'detached', timeout: 10_000 })
  await showSession(page, bKey)
  await waitText(page, `noted ${HOLD_MARK}`)
  // the keys stay as they were: a session's key is its own for the projection's life
  const keys = clients.task1!.v2().map((x) => Object.fromEntries(x.snapshot.sessions.map((s) => [s.title, s.key])))
  for (const k of keys) for (const [t, key] of Object.entries(k)) assert.equal(keys.at(-1)![t], key, `${t}: one key`)
})

test('v2: the session shown deleted — gone from the state at once, the page falls back, its picture refused, the link goes on', async () => {
  const page = taskViewer!.page
  const before = clients.task1!.lastV2()!.snapshot
  const a = byRole(before, 'a')!
  await showSession(page, a.key)
  await waitText(page, TASK_MARKS.a)
  const pic = a.images[0]!.resource
  assert.equal(await statusOf(imageGet(links.task1!.cap, pic)), 200)
  const at = await deleteSession(L.a)
  await clients.task1!.waitFor('the deleted session gone', (c) => byRole(c.lastV2()!.snapshot, 'a') === undefined, 10_000)
  const took = Date.now() - at
  results.v2_member_deleted_ms = took
  assert.ok(took < 5000, `gone from the state in ${took} ms (not at the next poll of the sessions)`)
  await shownBecomes(page, 'not', a.key)
  assert.ok(!(await threadText(page)).includes(TASK_MARKS.a), 'nothing of it on the page')
  await assertShown(page, clients.task1!.lastV2()!.snapshot, (await shownKey(page))!)
  assert.equal(await page.locator(SEL.viewerSession(a.key)).count(), 0, 'not listed')
  assert.equal(await statusOf(imageGet(links.task1!.cap, pic)), 404, 'its picture: not served')
  for (const f of clients.task1!.v2().filter((x) => x.revision > 0 && Date.parse(x.snapshot.generated_at) > at + 100)) assert.equal(byRole(f.snapshot, 'a'), undefined, 'no state after the deletion holds it')
  const listed = (await listLinks(L.b)).find((l) => l.id === links.task1!.id)
  assert.deepEqual([listed?.state, listed?.members], ['active', 3], 'the link goes on')
  await shot(page, 'viewer-task-shown-deleted.png')
})

test('v2: the task\'s first session deleted with members left — the link goes on, its start gone, the first member shown; still the owner\'s to reveal and revoke', async () => {
  rootViewer = await openViewer(links.task2!.url!, 'task2')
  const page = rootViewer.page
  await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute('data-phase') === 'connected', SEL.viewer, { timeout: 30_000 })
  const root = byRole(clients.task2!.lastV2()!.snapshot, 'root')!
  assert.equal(await shownKey(page), root.key)
  await assertShown(page, clients.task2!.lastV2()!.snapshot, root.key)
  await deleteSession(L.root)
  await clients.task2!.waitFor('the first session gone', (c) => byRole(c.lastV2()!.snapshot, 'root') === undefined, 10_000)
  const f = clients.task2!.lastV2()!
  assert.equal(f.start, null, 'the session the link was made from is gone')
  assert.equal(f.snapshot.current, f.snapshot.sessions[0]!.key, 'the first session left is shown first')
  assert.ok(f.snapshot.sessions.length >= 2 && f.snapshot.sessions.every((s) => s.member), 'its members, still there')
  await assertShown(page, f.snapshot, f.snapshot.current)
  assert.equal(clients.task2!.ended(), null)
  assert.equal(clients.task1!.ended(), null, 'the other link of the task goes on too')
  // made from a session deleted: still listed by the task's sessions, revealed with the same capability
  const listed = await listLinks(L.b)
  assert.deepEqual(['task1', 'task2'].map((n) => listed.find((l) => l.id === links[n]!.id)?.state), ['active', 'active'])
  const again = await api<{ capability: string }>('POST', `/api/share-links/${links.task2!.id}/v2/reveal`, {})
  assert.equal(again.capability, links.task2!.cap)
  await shot(page, 'viewer-task-root-deleted.png')
})

test('v2: revoked in the app, the whole view ends — every session, the card, the pictures at once; expired, the same', async () => {
  const f = clients.task1!.lastV2()!
  const pics = f.snapshot.sessions.map((s) => s.images[0]?.resource).filter((x): x is string => !!x)
  for (const r of pics) assert.equal(await statusOf(imageGet(links.task1!.cap, r)), 200)
  const context = await browser.newContext({ viewport: { width: 1400, height: 950 } })
  const page = await context.newPage()
  let revokedAt = 0
  try {
    await page.goto(`${BASE}/?token=${info.token}`)
    await page.click(SEL.session(L.b))
    await openLivePanel(page)
    const row = page.locator(SEL.link(links.task1!.id))
    await row.waitFor()
    await row.locator(SEL.linkRevoke).click()
    await row.locator(SEL.revokeConfirm).click()
    revokedAt = Date.now()
    await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute('data-state') === 'revoked', SEL.link(links.task1!.id), { timeout: 10_000 })
  } finally { await context.close() }
  await clients.task1!.waitFor('the stream closed', (c) => c.closedAt !== null, 5000)
  assert.ok([null, 'revoked'].includes(clients.task1!.ended()))
  for (const r of pics) assert.ok([401, 404, 410].includes(await statusOf(imageGet(links.task1!.cap, r))), 'every picture of the view refused at once')
  const vp = taskViewer!.page
  await vp.waitForFunction((sel) => document.querySelector(sel)?.getAttribute('data-ended-reason') === 'revoked', SEL.viewer, { timeout: 5000 })
  const cleared = { sessions: await vp.locator(SEL.viewerSessions).count(), card: await vp.locator(SEL.viewerCard).count(), text: await threadText(vp), pictures: (await shownPictures(vp)).length }
  results.v2_revoked_view = { ...cleared, text: cleared.text.length, ended_ms: clients.task1!.closedAt! - revokedAt }
  assert.deepEqual([cleared.sessions, cleared.card, cleared.pictures], [0, 0, 0], 'the list, the card, the pictures: gone')
  for (const m of Object.values(TASK_MARKS)) assert.ok(!cleared.text.includes(m), 'no session\'s words left')
  await shot(vp, 'viewer-task-revoked.png')
  // work after: never sent under the revoked link; the other link of the task gets it
  assert.equal(await runEnds(await chatIn(L.b, `${TASK_CASES.mark} ${AFTER_REVOKE_TASK}`)), 'done')
  await clients.task2!.waitFor('the work after', (c) => JSON.stringify(c.lastV2()).includes(AFTER_REVOKE_TASK), 15_000)
  assert.equal(count(clients.task1!.raw, AFTER_REVOKE_TASK), 0)
  // expired: the same, whole
  // the stored expiry is read when a stream connects (the legacy expiry test's way: the e2e route moves the stored
  // expiry, the product's own bounds untouched): the link's node reader and its page connect again after it is moved
  const pics2 = clients.task2!.lastV2()!.snapshot.sessions.map((s) => s.images[0]?.resource).filter((x): x is string => !!x)
  for (const r of pics2) assert.equal(await statusOf(imageGet(links.task2!.cap, r)), 200)
  const at = await expireIn(links.task2!.id, 6000)
  clients.task2!.close()
  const exp2 = await reader('task2_expiring', links.task2!.cap)
  assert.equal(new Date(exp2.lastV2()!.expires_at).getTime(), new Date(at).getTime(), 'the stream says the stored expiry')
  const rp = rootViewer!.page
  await rp.reload()
  await rp.waitForFunction((sel) => document.querySelector(sel)?.getAttribute('data-phase') === 'connected', SEL.viewer, { timeout: 15_000 })
  await rp.locator(SEL.viewerSessions).waitFor({ timeout: 10_000 })
  // the member of the other project shown (a session with a picture of its own), its pictures there until the expiry
  const shownNow = byRole(exp2.lastV2()!.snapshot, 'b')!
  await showSession(rp, shownNow.key)
  const before = await ownPictures(rp, shownNow)
  assert.ok(before.length >= 1 && before.every((p) => p.ok && p.w === TASK_IMAGES.b.w && p.h === TASK_IMAGES.b.h), `the page shows its own pictures until the expiry ${JSON.stringify(before)}`)
  await exp2.waitFor('the stream closed', (c) => c.closedAt !== null, 20_000)
  assert.ok([null, 'expired'].includes(exp2.ended()), `ended: ${exp2.ended()}`)
  assert.ok(exp2.closedAt! - Date.parse(at) < 3000, `ended ${exp2.closedAt! - Date.parse(at)} ms after the expiry`)
  for (const r of pics2) assert.ok([401, 404, 410].includes(await statusOf(imageGet(links.task2!.cap, r))))
  await rp.waitForFunction((sel) => document.querySelector(sel)?.getAttribute('data-ended-reason') === 'expired', SEL.viewer, { timeout: 5000 })
  assert.deepEqual([await rp.locator(SEL.viewerSessions).count(), await rp.locator(SEL.viewerCard).count(), (await shownPictures(rp)).length], [0, 0, 0])
  await shot(rp, 'viewer-task-expired.png')
  const gone = await fetch(`${tunnel.origin}${PATHS.stream}`, { headers: { authorization: `Bearer ${links.task2!.cap}` } })
  assert.equal(gone.status, 410)
  assert.deepEqual((await body(gone)).json, { error: 'gone', reason: 'expired' })
  await taskViewer!.context.close(); await rootViewer!.context.close()
  clients.side!.close()
})

test('v2: every session of a task deleted — the link ends, session_deleted', async () => {
  const first = await makeSession('Pair task · first (synthetic)', ids.project)
  const second = await makeSession('Pair task · second (synthetic)', L.projectB, first)
  L.pair.push(first, second)
  const link = await createLinkV2('pair', second, { include_task_sessions: true })
  const c = await reader('pair', link.cap)
  await deleteSession(first)
  await c.waitFor('the first gone', (x) => x.lastV2()!.snapshot.sessions.length === 1, 10_000)
  assert.equal(c.ended(), null, 'one session left: the link goes on')
  await deleteSession(second)
  await c.waitFor('the stream closed', (x) => x.closedAt !== null, 10_000)
  assert.ok([null, 'session_deleted'].includes(c.ended()), `ended: ${c.ended()}`)
  const again = await statusOf(fetch(`${tunnel.origin}${PATHS.stream}`, { headers: { authorization: `Bearer ${link.cap}` } }))
  assert.ok([401, 410].includes(again), `the link: ${again}`)
})

test('v2: the listener\'s budget (8 parts: a v1 link\'s projection, and each session × options once) — a part too many is busy; a task outgrowing it is never shown with a session missing; room again, its viewers come back', async () => {
  // nothing else open: every earlier stream ended or closed, every viewer page closed, their projections let go after
  // the service's idle time
  for (const c of Object.values(clients)) c.close()
  for (const ctx of viewerContexts.splice(0)) await ctx.close().catch(() => undefined)
  await sleep(7000)
  const k1 = await makeSession('Budget task · K1 (synthetic)', ids.project)
  const k2 = await makeSession('Budget task · K2 (synthetic)', ids.project, k1)
  const k3 = await makeSession('Budget task · K3 (synthetic)', L.projectB, k1)
  L.k.push(k1, k2, k3)
  const OPTS = { plain: {}, tools: { include_tool_details: true }, images: { include_images: true }, both: { include_tool_details: true, include_images: true } }
  // the parts each stream needs: (session × canonical options); a v1 link: one projection of its own
  const t1 = await createLinkV2('budget_t1', k1, { ...OPTS.plain, include_task_sessions: true })
  const t2 = await createLinkV2('budget_t2', k1, { ...OPTS.tools, include_task_sessions: true })
  const v1k = await api<{ link: { id: string }; capability: string }>('POST', `/api/sessions/${k1}/share-links`, { label: 'budget v1 of K1' })
  links.budget_v1k = { id: v1k.link.id, cap: v1k.capability, url: null }
  const s1 = await createLinkV2('budget_s1', k1, { ...OPTS.plain })
  const s2 = await createLinkV2('budget_s2', k2, { ...OPTS.images })
  const s3 = await createLinkV2('budget_s3', k3, { ...OPTS.both })
  const c1 = await reader('budget_t1', t1.cap)       // 3 parts
  const c2 = await reader('budget_t2', t2.cap)       // 6
  const cv = await StreamClient.open('budget_v1k', tunnel.origin, v1k.capability)   // 7 (a v1 projection)
  clients.budget_v1k = cv
  assert.equal(cv.status, 200)
  await cv.waitFor('a v1 state', (x) => x.states().length > 0)
  const cs1 = await reader('budget_s1', s1.cap)      // K1 × plain: the task link's part, shared — still 7
  const cs2 = await reader('budget_s2', s2.cap)      // 8
  // a ninth part: refused, nothing made; every stream open goes on
  const over = await StreamClient.open('budget_s3', tunnel.origin, s3.cap)
  clients.budget_s3 = over
  assert.equal(over.status, 503, `a part too many: ${over.status} ${over.raw.slice(0, 200)}`)
  assert.deepEqual(JSON.parse(over.raw || 'null'), { error: 'busy' })
  await sleep(1000)
  for (const c of [c1, c2, cv, cs1, cs2]) assert.equal(c.closedAt, null, `${c.name}: still open`)
  results.v2_budget_full = { t1: c1.lastV2()!.snapshot.sessions.length, t2: c2.lastV2()!.snapshot.sessions.length, refused: over.status }

  // a viewer page of the first task link, to see what it shows if it is the one that cannot stay
  const page = await openViewer(t1.url!, 'budget_t1')
  await page.page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute('data-phase') === 'connected', SEL.viewer, { timeout: 30_000 })
  // the task grows past the budget: a fourth session joins
  const joinedAt = Date.now()
  const k4 = await makeSession('Budget task · K4 (synthetic)', ids.project, k1)
  L.k.push(k4)
  const K4 = 'Budget task · K4'
  const hasK4 = (f: StateFrameV2) => f.snapshot.sessions.some((s) => s.title.includes(K4))
  await sleep(8000)
  const tasks = [c1, c2]
  // a task link that could not hold the whole task ended busy (for now: not permanent); one that goes on shows it whole
  const busy = tasks.filter((c) => c.ended() === 'busy')
  assert.ok(busy.length >= 1, `at least one task link could not hold the whole task: ${tasks.map((c) => `${c.name}:${c.ended() ?? (c.closedAt ? 'cut' : 'open')}`).join(' ')}`)
  for (const c of tasks) {
    for (const f of c.v2().filter(hasK4)) assert.equal(f.snapshot.sessions.length, 4, `${c.name}: a state of the grown task holds all four`)
    // after the join was surely seen (its poll, a build): every state it sent is the whole task
    for (const fr of c.frames.filter((x) => x.event === 'state' && x.at > joinedAt + 6000)) assert.ok(hasK4(fr.json as StateFrameV2), `${c.name}: no state with a session missing`)
    if (c.ended() === null) { assert.equal(c.closedAt, null); assert.ok(hasK4(c.lastV2()!), `${c.name}: goes on, whole`) }
  }
  // the parts the streams still open hold: never more than eight
  const open = (c: StreamClient) => c.closedAt === null && c.ended() === null
  const parts = new Set<string>()
  if (open(c1)) for (const s of c1.lastV2()!.snapshot.sessions) parts.add(`${s.title}|plain`)
  if (open(c2)) for (const s of c2.lastV2()!.snapshot.sessions) parts.add(`${s.title}|tools`)
  if (open(cs1)) parts.add(`${cs1.lastV2()!.snapshot.sessions[0]!.title}|plain`)
  if (open(cs2)) parts.add(`${cs2.lastV2()!.snapshot.sessions[0]!.title}|images`)
  const cost = parts.size + (open(cv) ? 1 : 0)
  results.v2_budget_grown = { ended: tasks.map((c) => [c.name, c.ended()]), cost }
  assert.ok(cost <= 8, `the parts in use: ${cost}`)
  // the page of a link that ended busy: nothing of a task missing a session left on it (cleared, or the whole task)
  if (c1.ended() === 'busy') {
    // paused, not ended: everything it showed cleared, said so, tried again later by itself
    await page.page.locator(SEL.viewerPaused).waitFor({ timeout: 10_000 })
    assert.equal(await page.page.locator(SEL.viewer).getAttribute('data-phase'), 'paused')
    assert.equal(await page.page.locator(SEL.viewer).getAttribute('data-ended-reason'), 'busy', 'paused for the budget')
    assert.equal(await page.page.locator(SEL.viewerStatus).getAttribute('data-reason'), 'busy')
    assert.equal(await page.page.locator(SEL.viewerCard).count(), 0, 'no card of a partial task')
    assert.equal(await page.page.locator(SEL.viewerEntries).count(), 0, 'the busy page shows no partial task')
    assert.equal((await shownPictures(page.page)).length, 0)
    assert.equal(await page.page.locator(SEL.viewerEnded).count(), 0, 'not a permanent end')
    await shot(page.page, 'viewer-task-busy.png')
  }
  await page.context.close()

  // room again (the others closed, their projections let go): both task links come back, each the whole task
  for (const c of Object.values(clients)) c.close()
  for (const ctx of viewerContexts.splice(0)) await ctx.close().catch(() => undefined)
  await sleep(7000)
  const back1 = await reader('budget_t1_back', t1.cap)
  const back2 = await reader('budget_t2_back', t2.cap)
  for (const c of [back1, back2]) {
    await c.waitFor(`${c.name}: the whole task`, (x) => hasK4(x.lastV2()!), 15_000)
    assert.equal(c.lastV2()!.snapshot.sessions.length, 4)
  }
  // eight parts in use: one more is busy again
  const again = await StreamClient.open('budget_s2_again', tunnel.origin, s2.cap)
  clients.budget_s2_again = again
  assert.equal(again.status, 503, 'the budget holds')
  back1.close(); back2.close()
})

test('after every scenario (revoke, expiry, the surface probes, off, a deleted session): every response scanned again', async () => {
  // the viewer pages are closed by now: the responses alone (the tunnel's, the node readers', the probes')
  await sleep(500)
  scanResponses('final')
  assert.ok(probeResponses.length > 100, `the probes' answers are in the scan: ${probeResponses.length}`)
})
