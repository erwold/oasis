/** The offline session share (v2: the app's own thread), end to end, in real headless Chrome against the scripted e2e
 *  backend (backend-ts/scripts/e2e_server.ts, route `scripted:share` and its siblings): a session made of real runs —
 *  tools that write and read a dotenv file and an opaque auth file, dump a cleared environment, print a bearer header /
 *  an e-mail / a home path and a long output; an answer with math; an answer with links that must stay inert; an
 *  uploaded PNG that carries a metadata canary; a generated image; a computer screenshot; a resumed run; a run the
 *  person leaves out — is exported through the app itself: the header's icon, the dialog, its options, the preview and
 *  Download (the browser's real download, saved).
 *
 *  Before exporting, the SAME session's live thread is captured in the app (light, then dark through the app's own
 *  theme setting) with every round folded; after the backend is stopped, the exported file (made with images on and
 *  tools off, the same runs) is captured over file:// at the same thread width, theme and folds. Run by run, the pair
 *  is put side by side; the DOM classes, the computed CSS (fonts, colours, widths, spacing) and the vertical geometry
 *  are compared and kept in the results.
 *
 *  Every value is synthetic. Canaries must be absent from the saved files (raw bytes, the text without invisible
 *  characters, the decoded picture bytes) and from the live DOM; the evidence (the downloads, screenshots, a JSON scan
 *  with measured bytes and SHA-256 and the size of each part) goes to OASIS_CODE_SHARE_OUT (default: a new folder
 *  under the OS temp folder).
 *
 *  The task share (snapshot V3, page v3; backend-ts/scripts/live_share_fixture.ts TASK_*): a task of four sessions across two
 *  projects — its first session, a member of the same project, a member of another project (joined through the first
 *  member), a member deleted later — and a task of its own beside it; each session with its own mark and its own
 *  picture (every session's first picture is `img1`, each of its own size), the first session's Agent Teams card with a
 *  work order continued once (a row of two runs) and a relay of two participants, the member's director with the
 *  worker it hands work to. The dialog's "All sessions in this task" is off by default; on, the one file holds every
 *  session not deleted, the rail's list and bots, each session's card, each session's pictures under its own key. The
 *  file is opened over file:// with the backend stopped: switching sessions, the card read-only, its rows jumping to
 *  their turns, the bots the app draws. The older pages (a V2 snapshot of the frozen route, the V1 golden snapshot) are
 *  read by the new viewer too.
 *
 *  Run alone, after `npm run build`: node --test --test-concurrency=1 e2e/session-share.e2e.ts — port 8399 (or
 *  OASIS_CODE_E2E_PORT) is waited for while another process holds it, never taken or killed. The UI built elsewhere:
 *  OASIS_CODE_E2E_DIST=<its frontend/dist>. The backend is started with the shell's app variables (data, auth, config,
 *  token, provider URLs and keys) removed: nothing of the person's own app is read. */

import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, type WriteStream } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'
import { after, before, test } from 'node:test'
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from 'playwright-core'

// a synthetic user's name, put into its home path at run time: the committed source holds no literal home path for the
// repository's privacy scan to find (scripts/oss/lib/scan.mjs)
const HOME_USER = 'synthuser'


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

/** The work order of the task's first session (the Agent Teams card's row with two runs once it is continued). */
const TASK_ORDER = { label: 'Team order · Carol', follow_up: 'Team order · Carol, once more' } as const

/** The words of the director's member session (scripted:dir hands them to Scripted Worker). */
const TASK_DIRECTOR_WORDS = 'have someone do the work for the task (synthetic)'


const PORT = Number(process.env.OASIS_CODE_E2E_PORT ?? 8399)
const BASE = `http://127.0.0.1:${PORT}`
const OUT = resolve(process.env.OASIS_CODE_SHARE_OUT || mkdtempSync(join(tmpdir(), 'oasis-share-e2e-')))
// the UI under test: OASIS_CODE_E2E_DIST (the director's integration build), else this worktree's own build. The shell's
// OASIS_CODE_FRONTEND_DIST is never read: it may name the person's own app
const DIST = resolve(process.env.OASIS_CODE_E2E_DIST || fileURLToPath(new URL('../dist', import.meta.url)))
/** the shell's variables of the person's own app and of model providers: never handed to the test's backend */
const SCRUBBED_ENV = ['OASIS_CODE_DATA', 'OASIS_CODE_PORT', 'OASIS_CODE_FRONTEND_DIST', 'OASIS_CODE_EXECUTION_ID', 'OASIS_CODE_AUTH_DIR', 'OASIS_CODE_CONFIG',
  'OASIS_CODE_SESSION_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CLAUDE_CODE_MESSAGING_TOKEN']
function backendEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const k of SCRUBBED_ENV) delete env[k]
  // every other variable of the app too (the e2e's own OASIS_CODE_E2E_* switches stay: a sandboxed runner's temp root,
  // the passthrough runtime)
  for (const k of Object.keys(env)) if (k.startsWith('OASIS_CODE_') && !k.startsWith('OASIS_CODE_E2E_')) delete env[k]
  env.OASIS_CODE_FRONTEND_DIST = DIST
  return env
}

// ---- the synthetic canaries (the same strings as SHARE_FIXTURE in backend-ts/scripts/e2e_server.ts) -----------------
const F = {
  dotenv: 'DOTENVCANARY_7c1f', auth: 'OPAQUEAUTHCANARY_9f8e', env: 'ENVOUTCANARY_51d3', bearer: 'BEARERCANARY0123456789abcdef',
  needle: 'FOLDEDNEEDLE', answer_mark: 'MAIN_ANSWER_ONCE_4b2',
}
/** the actions taken beside the agents (SHARE_FIXTURE.action): through the real connector command route as ChatGPT, a
 *  checkpoint by hand */
const A = {
  mark: 'ACTION_MULTI_MARK_3e9a', bearer: 'ACTIONBEARERCANARY0123456789abcd', dotenv: 'ACTIONDOTENVCANARY_5b7c', auth: 'ACTIONAUTHCANARY_2d4f',
  env: 'ACTIONENVCANARY_8a61', checkpoint_note: 'before the share (synthetic)',
}
/** what an opened withheld action says instead of its command: fixed, generic, the same for every such action */
const WITHHELD_WHY = 'Content withheld: a sensitive source (an environment, a credential file); nothing of this command or its output is in this export.'
/** a benign command of several lines: a bearer header the sanitizer redacts (in its text and its output preview), its mark */
const ACTION_BENIGN = `printf 'step %s\\n' 1 2 3\necho "Authorization: Bearer ${A.bearer}"\necho ${A.mark}`
/** sensitive sources of its own (never the machine's): a dotenv and an auth file it writes under the worktree, then reads */
const ACTION_FILES = `mkdir -p .action-synthetic && printf 'SYNTH_ACTION_SECRET=${A.dotenv}\\n' > .action-synthetic/.env && printf '{"token":"${A.auth}"}' > .action-synthetic/auth.json && cat .action-synthetic/.env .action-synthetic/auth.json`
/** an environment dump of a cleared environment: only the synthetic variable is in it */
const ACTION_ENV = `env -i SYNTH_ACTION_ENV=${A.env} printenv`
const KEY_TAIL = 'KEYCANARYabcdefghij0123'
const PNG_META = 'PNGMETACANARY_e6a1'
const EXCLUDED = 'EXCLUDEDRUNCANARY_8d1e'
const SESSION_TOKEN = 'e2e-token' // the e2e server's session token: exact redaction everywhere
const ZW = '\u200b'
/** the title: an invisible character inside, markup, a path, the token split by a zero-width space */
const TITLE = `分享 QA${ZW} <b>demo</b> ../../etc /Users/${HOME_USER} e2e-${ZW}token`
const PERSON = [
  '请检查配置并修复 calc.py。内部备注：这是一段中文的内部说明。',
  `The app token is ${SESSION_TOKEN}; my key is sk-ant-api03-${ZW}${KEY_TAIL}.`,
  `Write to alice.synthetic@example.com about /Users/${HOME_USER}/private/plan.md.`,
  '<script>window.__xss="person"</script> <img src=x onerror="window.__xss=\'pimg\'">',
].join('\n')

/** must be absent from every exported byte and from the DOM, whatever the options */
const SECRETS: Record<string, string> = {
  dotenv_file_content: F.dotenv, opaque_auth_file_content: F.auth, env_dump_output: F.env, bearer_value: F.bearer,
  session_token: SESSION_TOKEN, api_key_tail: KEY_TAIL, query_secret: 'QUERYCANARY_33aa', email: 'alice.synthetic@example.com',
  home_username: 'synthuser', png_metadata: PNG_META,
  action_bearer: A.bearer, action_dotenv: A.dotenv, action_auth: A.auth, action_env: A.env,
}
/** NOT a secret: the words of a legitimate run — present in the files made with every run in, absent from the file
 *  built after the person left that run out */
const EXCLUDED_RUN_WORDS = EXCLUDED

/** the files this test saves (all made by the app's dialog) */
const FILES = {
  dflt: 'example-session-share.default.html', // tools off, images off, every run — the app dark
  images: 'example-session-share.images.html', // tools off, images ON, every run (the same selection) — the app dark
  full: 'example-session-share.html', // tools + images, one run left out — the app light
}
/** the widths the thread is compared at, and the mobile one */
const APP_VIEWPORT = { width: 1600, height: 1000 }
const CAPTURE_HEIGHT = 2600

let server: ChildProcess | null = null
let serverExit: Promise<number | null> | null = null
let serverLog: WriteStream | null = null
let info: { token: string; repo: string; repo_b: string; data: string }
let browser: Browser
const results: Record<string, unknown> = { out: OUT }
const ids: { project: string; session: string; other: string; main: string; excluded: string; math: string; links: string; runs: string[]; assets: string[]; actions: string[] } = { project: '', session: '', other: '', main: '', excluded: '', math: '', links: '', runs: [], assets: [], actions: [] }

function portFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const probe = createServer()
    probe.once('error', () => done(false))
    probe.listen(port, '127.0.0.1', () => probe.close(() => done(true)))
  })
}

before(async () => {
  mkdirSync(OUT, { recursive: true })
  for (let i = 0; !(await portFree(PORT)); i += 1) {
    if (i % 15 === 0) console.log(`[session-share] port ${PORT} is in use; waiting (never taken)`)
    await new Promise((r) => setTimeout(r, 2000))
  }
  assert.ok(existsSync(join(DIST, 'index.html')), `no built UI at ${DIST}: run npm run build first`)
  results.dist = DIST
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
    await new Promise((r) => setTimeout(r, 100))
  }
  const executablePath = process.env.OASIS_CODE_E2E_BROWSER
  browser = await chromium.launch(executablePath ? { executablePath, headless: true, args: ['--no-sandbox'] } : { channel: 'chrome', headless: true })
})

after(async () => {
  writeFileSync(join(OUT, 'session-share-e2e-results.json'), JSON.stringify(results, null, 2))
  await browser?.close().catch(() => undefined)
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

async function call<T = Record<string, unknown>>(path: string, body?: unknown, init: { raw?: Uint8Array; type?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; body: T; text: string }> {
  const res = await fetch(`${BASE}${path}`, {
    method: body === undefined && !init.raw ? 'GET' : 'POST',
    headers: { 'x-oasis-code-token': info.token, origin: BASE, ...(init.headers ?? {}), ...(init.raw ? { 'content-type': init.type ?? 'application/octet-stream' } : body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: init.raw ? (init.raw as unknown as BodyInit) : body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let parsed: unknown = null
  try { parsed = JSON.parse(text) } catch { parsed = null }
  return { status: res.status, body: parsed as T, text }
}
async function api<T = Record<string, unknown>>(path: string, body?: unknown, init?: { raw?: Uint8Array; type?: string; headers?: Record<string, string> }): Promise<T> {
  const r = await call<T>(path, body, init)
  assert.ok(r.status >= 200 && r.status < 300, `${path}: ${r.status} ${r.text.slice(0, 300)}`)
  return r.body
}
async function runEnds(runId: string): Promise<string> {
  for (let i = 0; i < 600; i += 1) {
    const { status } = await api<{ status: string }>(`/api/runs/${runId}`)
    if (!['queued', 'running'].includes(status)) return status
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`run ${runId} did not end`)
}
async function chat(text: string, model: string, extra: Record<string, unknown> = {}): Promise<string> {
  const run = await api<{ id: string }>(`/api/sessions/${ids.session}/chat`, { text, model, ...extra })
  ids.runs.push(run.id)
  return run.id
}
async function release(gate: string): Promise<void> {
  for (let i = 0; i < 300; i += 1) {
    const r = await fetch(`${BASE}/e2e/ui-release?gate=${gate}`, { method: 'POST', headers: { authorization: `Bearer ${info.token}` } })
    if (((await r.json()) as { released: boolean }).released) return
    await new Promise((res) => setTimeout(res, 100))
  }
  throw new Error('the held run never reached its gate')
}
async function idle(): Promise<void> {
  for (let i = 0; i < 300; i += 1) {
    const s = await api<{ active_runs?: unknown[] }>(`/api/sessions/${ids.session}`)
    if (!(s.active_runs ?? []).length) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('the session never became idle')
}

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
  const raw = Buffer.alloc((1 + w * 3) * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set([20 + x * 9, 120, 200 - y * 8], y * (1 + w * 3) + 1 + x * 3)
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('tEXt', Buffer.from(`Comment\0${PNG_META} GPS 1.2345,103.8 owner synthuser`, 'latin1')),
    chunk('iTXt', Buffer.from(`XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta>${PNG_META}</x:xmpmeta>`, 'utf8')),
    chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]))
}

const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex')
const sha64 = (s: string) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('base64')
const stripInvisible = (s: string) => s.normalize('NFKC').replace(/[\p{Cf}\u034f\u115f\u1160\u3164\uffa0\u17b4\u17b5]/gu, '')

/** The parts of a saved file: its markup (script/style bodies taken out), the one stylesheet, the viewer script and
 *  the JSON data block. */
function partsOf(html: string): { markup: string; css: string; js: string; data: string; csp: string | null; styleTags: number; scriptTags: number } {
  const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)]
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
  const data = scripts.find((m) => /type="application\/json"/.test(m[1]!) && /id="share-data"/.test(m[1]!))?.[2] ?? ''
  const js = scripts.find((m) => m[1]!.trim() === '')?.[2] ?? ''
  const markup = html.replace(/<style>[\s\S]*?<\/style>/g, '<style></style>').replace(/(<script\b[^>]*>)[\s\S]*?<\/script>/g, '$1</script>')
  return { markup, css: styles[0]?.[1] ?? '', js, data, csp: /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html)?.[1] ?? null, styleTags: styles.length, scriptTags: scripts.length }
}

type Doc = { theme: string; snapshot: { items: { kind: string; key: string; details?: { preview?: string | null } | null }[]; images: { data_base64?: string }[]; options: Record<string, unknown> }; pictures: Record<string, { src: string; width: number; height: number }>; bots: Record<string, string>; faces: Record<string, unknown> }

/** The page document the dialog writes now: page v3 holding a snapshot V3 (one session, or every session of a task) —
 *  the frontend's share/document.ts ShareTaskDocument. */
const PAGE_VERSION_NOW = 3
type Picture = { src: string; width: number; height: number }
type TeamRowV3 = { key: string; parent: string | null; depends_on: string[]; kind: string; name: string; bot: string | null; model_label: string | null; status: string; glyph: string | null; participant_index: number | null; participant_label: string | null; runs: number; started_at: string; finished_at: string | null; turn: string | null }
type SessionV3 = {
  key: string; title: string; member: boolean; current: boolean; bots: string[]
  runs: { key: string; request: string; bot: string | null; enclosed: boolean; status: string }[]
  items: { kind: string; key: string; run: string | null; text?: string | null; image?: string | null }[]
  images: { key: string; media_type: string; width?: number; height?: number; bytes?: number; data_base64: string }[]
  team: { rows: TeamRowV3[]; agents: number; live: number; truncated: boolean }
  stats: Record<string, unknown>
}
type SnapshotV3 = { format: string; version: number; title: string; scope: 'session' | 'task'; current: string; options: Record<string, boolean>; sessions: SessionV3[]; stats: Record<string, unknown>; limits: Record<string, number> }
type TaskDoc = { format: string; version: number; theme: string; snapshot: SnapshotV3; pictures: Record<string, Record<string, Picture>>; page: Record<string, number>; bots: Record<string, string> }

/** Any page document read as the single-session view the legacy assertions were written for: a page v2 as it is; a
 *  page v3 by its current session (its items, runs, images; its pictures under their own keys; the faces its runs
 *  wear, as the v2 page's `faces` held them; the two v2 options). The assertions themselves are the legacy ones. */
function legacyView(raw: unknown): Doc {
  const doc = raw as Doc & Partial<TaskDoc> & { version: number }
  if (doc.version !== 3) return doc
  const snap = doc.snapshot as unknown as SnapshotV3
  const s = snap.sessions.find((x) => x.key === snap.current) ?? snap.sessions[0]!
  return {
    theme: doc.theme,
    snapshot: { ...s, version: snap.version, title: s.title, options: { include_tool_details: snap.options.include_tool_details, include_images: snap.options.include_images } } as unknown as Doc['snapshot'],
    pictures: (doc.pictures as TaskDoc['pictures'] | undefined)?.[s.key] ?? {},
    bots: doc.bots,
    faces: Object.fromEntries(s.runs.filter((r) => r.bot !== null || r.enclosed).map((r) => [r.key, { bot: r.bot, enclosed: r.enclosed }])),
  }
}

/** Every string path of a JSON value that holds `needle`. */
function pathsHolding(value: unknown, needle: string, path = '$'): string[] {
  if (typeof value === 'string') return value.includes(needle) ? [path] : []
  if (Array.isArray(value)) return value.flatMap((v, i) => pathsHolding(v, needle, `${path}[${i}]`))
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => pathsHolding(v, needle, `${path}.${k}`))
  return []
}

/** The machine-readable scan of one saved file. */
function scan(name: string, bytes: Buffer, sourceImageSha: string[]): Record<string, unknown> {
  const html = bytes.toString('utf8')
  const visible = stripInvisible(html)
  const p = partsOf(html)
  const rawDoc = JSON.parse(p.data) as { version: number; snapshot: { version: number; scope?: string } }
  const doc = legacyView(rawDoc)
  const pictures = Object.entries(doc.pictures).map(([key, pic]) => {
    const m = /^data:(image\/[a-z]+);base64,(.+)$/.exec(pic.src)!
    return { key, type: m[1]!, bytes: Buffer.from(m[2]!, 'base64'), width: pic.width, height: pic.height, urlChars: pic.src.length }
  })
  const bots = Object.entries(doc.bots).map(([name, src]) => ({ name, chars: src.length, bytes: Buffer.from(src.split(',')[1] ?? '', 'base64').length }))
  const imageText = pictures.map((i) => i.bytes.toString('latin1')).join('\n')
  const secrets = Object.fromEntries(Object.entries(SECRETS).map(([k, v]) => [k, {
    raw: html.split(v).length - 1, without_invisible: visible.split(v).length - 1, in_picture_bytes: imageText.split(v).length - 1,
    case_insensitive: (visible.toLowerCase().split(v.toLowerCase()).length - 1),
  }]))
  const attrUrls = [...p.markup.matchAll(/\s(src|href|action|srcset|poster|data|formaction|xlink:href|background)\s*=\s*"([^"]*)"/gi)].map((m) => [m[1]!.toLowerCase(), m[2]!] as const)
  const cssUrls = [...p.css.matchAll(/url\(([^)]{0,40})/g)].map((m) => m[1]!)
  const fontBytes = [...p.css.matchAll(/url\(data:font\/woff2;base64,([A-Za-z0-9+/=]+)\)/g)].reduce((n, m) => n + m[1]!.length, 0)
  const pictureChars = pictures.reduce((n, i) => n + i.urlChars, 0)
  const botChars = bots.reduce((n, b) => n + b.chars, 0)
  return {
    file: name, bytes: bytes.length, sha256: sha(bytes), theme: doc.theme, options: doc.snapshot.options,
    page_version: rawDoc.version, snapshot_version: rawDoc.snapshot.version, scope: rawDoc.snapshot.scope ?? null,
    run_keys: (doc.snapshot as unknown as { runs: { key: string }[] }).runs.map((r) => r.key),
    item_keys: doc.snapshot.items.map((i) => `${i.kind}:${i.key}`),
    sizes: {
      total: bytes.length, script: Buffer.byteLength(p.js), stylesheet: Buffer.byteLength(p.css), stylesheet_embedded_woff2_chars: fontBytes,
      stylesheet_without_fonts: Buffer.byteLength(p.css) - fontBytes, data_block: Buffer.byteLength(p.data), data_block_pictures_chars: pictureChars,
      data_block_bots_chars: botChars, data_block_snapshot_and_rest: Buffer.byteLength(p.data) - pictureChars - botChars,
      markup_and_csp: bytes.length - Buffer.byteLength(p.js) - Buffer.byteLength(p.css) - Buffer.byteLength(p.data),
    },
    secrets,
    secrets_found_total: Object.values(secrets).reduce((n, s) => n + s.raw + s.without_invisible + s.in_picture_bytes + s.case_insensitive, 0),
    harness_ids: {
      run_ids: (html.match(/\brun_[0-9a-f]{6,}/g) ?? []).length, session_id: html.split(ids.session).length - 1,
      asset_ids: ids.assets.filter((a) => html.includes(a)).length, data_dir: html.split(info.data).length - 1, repo_path: html.split(info.repo).length - 1,
      tmp_root: (html.match(/oasis-code-e2e-/g) ?? []).length,
    },
    script_elements: p.scriptTags, style_elements: p.styleTags,
    executable_scripts: [...p.markup.matchAll(/<script\b([^>]*)>/g)].filter((m) => !/type="application\/json"/.test(m[1]!)).length,
    external_script_src: (p.markup.match(/<script\b[^>]*\ssrc\s*=/gi) ?? []).length,
    link_tags: (p.markup.match(/<link\b/gi) ?? []).length,
    iframe_object_embed_tags: (p.markup.match(/<(iframe|object|embed|frame|base|form)\b/gi) ?? []).length,
    event_handler_attrs: (p.markup.match(/<[a-z][^>]*\son[a-z]+\s*=/gi) ?? []).length,
    url_attributes_in_markup: attrUrls.length,
    css_urls_not_woff2_data: cssUrls.filter((u) => !u.startsWith('data:font/woff2;base64,')).length,
    css_import: (p.css.match(/@import/gi) ?? []).length,
    css_font_formats: [...new Set([...p.css.matchAll(/format\(["']?([a-z0-9-]+)/g)].map((m) => m[1]!))],
    script_end_or_comment_in_js: /<\/script|<!--/i.test(p.js), style_end_in_css: /<\/style/i.test(p.css),
    data_block_raw_lt_gt_amp: /[<>&]/.test(p.data),
    // source image BYTES carried (a page v3 keeps each image's key, type and size with its bytes emptied)
    snapshot_images_carried: doc.snapshot.images.filter((i) => (i.data_base64 ?? '') !== '').length,
    csp: p.csp,
    csp_expected: [
      "default-src 'none'", `script-src 'sha256-${sha64(p.js)}'`, `style-src 'sha256-${sha64(p.css)}'`, 'img-src data:', 'font-src data:', "connect-src 'none'",
      "object-src 'none'", "frame-src 'none'", "child-src 'none'", "worker-src 'none'", "media-src 'none'", "manifest-src 'none'", "form-action 'none'", "base-uri 'none'",
    ].join('; '),
    pictures: pictures.map((i) => ({
      key: i.key, type: i.type, bytes: i.bytes.length, width: i.width, height: i.height, sha256: sha(i.bytes),
      signature_ok: i.type === 'image/webp' ? i.bytes.subarray(0, 4).toString('latin1') === 'RIFF' && i.bytes.subarray(8, 12).toString('latin1') === 'WEBP' : i.type === 'image/png' ? i.bytes[0] === 0x89 && i.bytes.subarray(1, 4).toString('latin1') === 'PNG' : i.type === 'image/jpeg' ? i.bytes[0] === 0xff && i.bytes[1] === 0xd8 : false,
      equals_a_source_image: sourceImageSha.includes(sha(i.bytes)),
      metadata_chunks: /tEXt|iTXt|zTXt|eXIf|EXIF|XMP |<x:xmpmeta/.test(i.bytes.toString('latin1')),
    })),
    bots: bots.map((b) => ({ name: b.name, bytes: b.bytes })),
    faces: Object.keys(doc.faces).length,
    present: {
      chinese_prose: html.split('内部说明').length - 1, main_answer_mark: html.split(F.answer_mark).length - 1,
      resumed_answer: html.split('RESUMED_ANSWER_MARK').length - 1, calc_py: html.split('calc.py').length - 1,
      needle_anywhere: html.split(F.needle).length - 1,
      needle_paths: pathsHolding(doc, F.needle),
      excluded_run_words: html.split(EXCLUDED_RUN_WORDS).length - 1,
    },
  }
}

/** Every image of the document brought into view one at a time and decoded for real (HTMLImageElement.decode());
 *  only then are their sizes read. */
async function decodeAll(target: Page | Frame): Promise<{ n: number; decoded: boolean; w: number; h: number; data: boolean; cls: string }[]> {
  return target.evaluate(async () => {
    const out: { n: number; decoded: boolean; w: number; h: number; data: boolean; cls: string }[] = []
    const imgs = Array.from(document.images)
    for (let n = 0; n < imgs.length; n++) {
      const img = imgs[n]!
      img.scrollIntoView({ block: 'center' })
      const decoded = await Promise.race([img.decode().then(() => true, () => false), new Promise<boolean>((r) => setTimeout(() => r(false), 10_000))])
      out.push({ n, decoded, w: img.naturalWidth, h: img.naturalHeight, data: img.currentSrc.startsWith('data:image/'), cls: img.className })
    }
    document.querySelector('[data-testid="thread"]')?.scrollTo(0, 0)
    return out
  })
}

/** The preview iframe's frame (the srcdoc document). */
async function previewFrame(page: Page): Promise<Frame> {
  const el = await page.waitForSelector('[data-testid="share-preview"]')
  const frame = await el.contentFrame()
  assert.ok(frame, 'the preview has a frame')
  await frame.waitForSelector('[data-testid="share-thread"]')
  return frame
}

async function ready(page: Page): Promise<{ bytes: number; sha256: string; srcdoc: string }> {
  await page.waitForSelector('[data-testid="share-dialog"][data-phase="ready"]', { timeout: 60_000 })
  const size = page.locator('[data-testid="share-size"]')
  const srcdoc = (await page.locator('[data-testid="share-preview"]').getAttribute('srcdoc')) ?? ''
  return { bytes: Number(await size.getAttribute('data-bytes')), sha256: (await size.getAttribute('data-sha256')) ?? '', srcdoc }
}

async function download(page: Page, file: string): Promise<{ bytes: Buffer; suggested: string }> {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-testid="share-download"]')])
  const path = join(OUT, file)
  await dl.saveAs(path)
  assert.equal(await dl.failure(), null)
  return { bytes: readFileSync(path), suggested: dl.suggestedFilename() }
}

/** The preview = the download: srcdoc bytes, the dialog's bytes/SHA, the saved file. */
async function saveReady(page: Page, file: string): Promise<{ bytes: number; sha256: string; srcdoc: string; suggested: string }> {
  const r = await ready(page)
  assert.equal(Buffer.byteLength(r.srcdoc, 'utf8'), r.bytes)
  assert.equal(sha(Buffer.from(r.srcdoc, 'utf8')), r.sha256)
  const d = await download(page, file)
  assert.equal(d.bytes.length, r.bytes)
  assert.equal(sha(d.bytes), r.sha256)
  assert.equal(d.bytes.toString('utf8'), r.srcdoc)
  return { ...r, suggested: d.suggested }
}

// ---- the same-session comparison --------------------------------------------------------------------------------------

/** Fold every round and close every opened record: the same fold state in the app and in the file. */
async function foldAll(target: Page): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const open = target.locator('[data-testid="thread"] .work.open > .work-head')
    if (!(await open.count())) break
    await open.first().click()
  }
  await target.evaluate(() => document.querySelector('[data-testid="thread"]')?.scrollTo(0, 0))
}

/** Two frames after a viewport change, so a picture shows the page as laid out at its new size. */
const settle = (target: Page) => target.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))

/** The page at rest: its faces ready, every running CSS animation/transition finished (bounded), the pointer moved off
 *  every control, two frames drawn — so a picture or a colour read never catches a palette change half done. */
async function stable(target: Page): Promise<void> {
  await target.mouse.move(1, target.viewportSize()!.height - 1)
  await target.evaluate(async () => {
    await document.fonts.ready
    await Promise.race([Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))), new Promise((r) => setTimeout(r, 2000))])
  })
  await settle(target)
}

type PaletteButton = { choice: string; active: boolean; hovered: boolean; fg: number[]; bg: number[]; contrast: number; left: number; right: number }

/** Every palette choice in turn: each of the four buttons at rest, then the chosen one under the pointer — its ink and
 *  background as the canvas draws them (sRGB from the computed oklch), their WCAG contrast, and where it sits. */
async function paletteStates(target: Page, out: string): Promise<{ states: PaletteButton[]; innerWidth: number; scrollWidth: number }> {
  const read = (choice: string, hovered: boolean) => target.evaluate(({ choice, hovered }) => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!
    const rgb = (css: string) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = '#000'; ctx.fillStyle = css; ctx.fillRect(0, 0, 1, 1); return Array.from(ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)) }
    const lum = (c: number[]) => { const [r, g, b] = c.map((v) => { const x = v / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4 }); return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! }
    return Array.from(document.querySelectorAll('[data-testid^="share-theme-"]')).filter((b) => !hovered || b.classList.contains('active')).map((b) => {
      const cs = getComputedStyle(b)
      const fg = rgb(cs.color), bg = rgb(cs.backgroundColor)
      const [hi, lo] = [lum(fg), lum(bg)].sort((x, y) => y - x)
      const r = b.getBoundingClientRect()
      return { choice: `${choice}:${b.getAttribute('data-testid')!.slice('share-theme-'.length)}`, active: b.classList.contains('active'), hovered, fg, bg, contrast: Math.round(((hi! + 0.05) / (lo! + 0.05)) * 100) / 100, left: r.left, right: r.right }
    })
  }, { choice, hovered })
  const states: PaletteButton[] = []
  for (const choice of ['light', 'dark', 'claude', 'system']) {
    await target.click(`[data-testid="share-theme-${choice}"]`)
    await stable(target)
    states.push(...await read(choice, false))
    await target.screenshot({ path: `${out}-${choice}.png` })
    await target.hover(`[data-testid="share-theme-${choice}"]`)
    await target.evaluate(() => Promise.race([Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))), new Promise((r) => setTimeout(r, 2000))]))
    await settle(target)
    states.push(...await read(choice, true))
    await target.locator('header.thread-header').screenshot({ path: `${out}-${choice}-hover-active.png` })
  }
  await stable(target)
  return { states, ...await target.evaluate(() => ({ innerWidth: window.innerWidth, scrollWidth: document.documentElement.scrollWidth })) }
}

/** Open every round (one at a time: each opened one leaves the folded set). */
async function openAll(target: Page): Promise<void> {
  const folded = target.locator('[data-testid="thread"] .work:not(.open) > .work-head')
  for (let i = 0; i < 60 && await folded.count(); i++) await folded.first().click()
  assert.equal(await folded.count(), 0)
}

/** What both sides are measured by: the computed CSS of the same product elements. */
const CSS_PROBES: Record<string, { sel: string; props: string[] }> = {
  root: { sel: 'html', props: ['color-scheme'] },
  body: { sel: 'body', props: ['font-family', 'font-size', 'color', 'background-color', 'line-height'] },
  thread: { sel: 'main.thread', props: ['background-color'] },
  scroll: { sel: '[data-testid="thread"]', props: ['padding-left', 'padding-right', 'padding-top', 'row-gap', 'font-family'] },
  group: { sel: '[data-testid="thread"] > section.turn-group', props: ['width', 'row-gap', 'font-family', 'font-size'] },
  user_text: { sel: '[data-testid="thread"] .turn-user .turn-text', props: ['background-color', 'color', 'font-family', 'font-size', 'line-height', 'border-top-left-radius', 'border-bottom-right-radius', 'padding-top', 'padding-left'] },
  agent_who: { sel: '[data-testid="thread"] .turn-agent .turn-who', props: ['color', 'font-family', 'font-size', 'letter-spacing', 'text-transform', 'font-weight'] },
  prose: { sel: '[data-testid="thread"] .turn-agent .prose', props: ['color', 'font-family', 'font-size', 'line-height'] },
  prose_h2: { sel: '[data-testid="thread"] .turn-agent .prose h2', props: ['font-family', 'font-size', 'font-weight', 'margin-top', 'margin-bottom', 'color'] },
  code_block: { sel: '[data-testid="thread"] .code-block', props: ['background-color', 'border-top-color', 'border-top-left-radius', 'margin-top'] },
  code_head: { sel: '[data-testid="thread"] .code-head', props: ['height', 'padding-top', 'font-family', 'color'] },
  code_lang: { sel: '[data-testid="thread"] .code-head .code-lang', props: ['width'] },
  code_body: { sel: '[data-testid="thread"] .code-body', props: ['font-family', 'font-size', 'line-height', 'color'] },
  table: { sel: '[data-testid="thread"] .prose table', props: ['font-size', 'border-collapse', 'color'] },
  table_th: { sel: '[data-testid="thread"] .prose th', props: ['font-weight', 'color', 'padding-top', 'padding-left', 'background-color'] },
  katex: { sel: '[data-testid="thread"] .katex', props: ['font-family', 'font-size'] },
  katex_display: { sel: '[data-testid="thread"] .katex-display', props: ['margin-top', 'margin-bottom', 'text-align'] },
  work_head: { sel: '[data-testid="thread"] .work-head', props: ['font-size', 'color', 'font-family', 'height', 'padding-top'] },
  work_last: { sel: '[data-testid="thread"] .work-last', props: ['font-size', 'color', 'font-family'] },
  bot: { sel: '[data-testid="thread"] .turn-agent .turn-bot', props: ['width', 'height'] },
}

async function cssOf(target: Page): Promise<Record<string, Record<string, string> | null>> {
  return target.evaluate((probes) => Object.fromEntries(Object.entries(probes).map(([k, { sel, props }]) => {
    const el = document.querySelector(sel)
    if (!el) return [k, null]
    const cs = getComputedStyle(el)
    return [k, Object.fromEntries(props.map((p) => [p, cs.getPropertyValue(p)]))]
  })), CSS_PROBES)
}

type RunCapture = { testid: string; status: string | null; width: number; height: number; classes: string[]; layout: { cls: string; top: number; height: number }[]; answers: string[]; user: string; who: string[]; png: Buffer }

/** Every run's turn of the thread, in order: its picture, its classes, the vertical place of its parts. */
async function captureRuns(page: Page, prefix: string): Promise<RunCapture[]> {
  await page.setViewportSize({ width: page.viewportSize()!.width, height: CAPTURE_HEIGHT })
  await foldAll(page)
  await page.mouse.move(0, 0)
  const sections = page.locator('[data-testid="thread"] > section[data-testid^="run-"]')
  const n = await sections.count()
  const out: RunCapture[] = []
  for (let i = 0; i < n; i++) {
    const s = sections.nth(i)
    // at the top of the scroller, far from the app's composer dock (which floats over the thread's foot)
    await s.evaluate((el) => el.scrollIntoView({ block: 'start' }))
    // measured once its pictures are decoded and the page's faces are ready (a lazy picture would change the height)
    await s.evaluate(async (el) => {
      await Promise.all(Array.from(el.querySelectorAll('img')).map((i) => (i as HTMLImageElement).decode().catch(() => undefined)))
      await document.fonts.ready
    })
    const facts = await s.evaluate((el) => {
      const top = el.getBoundingClientRect().top
      const classes = new Set<string>()
      for (const e of [el, ...Array.from(el.querySelectorAll('*'))]) for (const c of Array.from(e.classList)) classes.add(c)
      const parts = Array.from(el.querySelectorAll(':scope > *, :scope > .agent-span > *, :scope > div > *')).filter((e) => (e as HTMLElement).offsetParent !== null)
      return {
        testid: el.getAttribute('data-testid')!, status: el.getAttribute('data-status'),
        width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height,
        classes: [...classes].sort(),
        layout: parts.map((e) => ({ cls: `${e.tagName.toLowerCase()}.${Array.from(e.classList).join('.')}`, top: Math.round(e.getBoundingClientRect().top - top), height: Math.round(e.getBoundingClientRect().height) })),
        answers: Array.from(el.querySelectorAll('.turn-agent .prose')).map((p) => (p as HTMLElement).innerText.trim()),
        user: (el.querySelector('.turn-user .turn-text') as HTMLElement | null)?.innerText.trim() ?? '',
        who: Array.from(el.querySelectorAll('.turn-agent .turn-who')).map((w) => (w as HTMLElement).innerText.trim()),
      }
    })
    await settle(page)
    const png = await s.screenshot({ path: join(OUT, 'compare', `${prefix}-run${String(i + 1).padStart(2, '0')}.png`), animations: 'disabled' })
    out.push({ ...facts, png })
  }
  return out
}

/** The computed CSS of an action line's parts, folded and opened: the app's and the file's must be the same. */
const ACTION_CSS: Record<string, string[]> = {
  '.action-line-wrap': ['margin-top', 'margin-bottom'],
  'button.action-line': ['font-family', 'font-size', 'color', 'padding-top', 'padding-left', 'height', 'background-color', 'column-gap'],
  '.action-who': ['font-family', 'font-size', 'color', 'column-gap'],
  '.action-who img': ['width', 'height'],
  '.action-head': ['font-family', 'font-size', 'font-weight', 'color'],
  '.action-outcome': ['font-family', 'font-size', 'color'],
  '.action-full': ['font-family', 'font-size', 'background-color', 'padding-top', 'padding-left', 'margin-left', 'white-space', 'border-top-left-radius'],
}

type ActionCapture = {
  testid: string; place: number; who: string; head: string; outcome: string | null; missing: string | null; full: string | null; why: string | null
  text: string; details: boolean; classes: string[]; css: Record<string, Record<string, string> | null>; height: number; openHeight: number; width: number; png: Buffer; openPng: Buffer
}

/** Every action line of the thread (a direct child of its column), in order: where it stands among the turns, its
 *  words, its classes and CSS, folded and opened (then folded again) — a picture of each. */
async function captureActions(page: Page, prefix: string): Promise<ActionCapture[]> {
  await page.setViewportSize({ width: page.viewportSize()!.width, height: CAPTURE_HEIGHT })
  await page.mouse.move(0, 0)
  const lines = page.locator('[data-testid="thread"] > [data-testid^="action-"]')
  const n = await lines.count()
  const out: ActionCapture[] = []
  const read = (el: Element, probes: Record<string, string[]>) => {
    const css: Record<string, Record<string, string> | null> = {}
    for (const [sel, props] of Object.entries(probes)) {
      const e = el.matches(sel) ? el : el.querySelector(sel)
      css[sel] = e ? Object.fromEntries(props.map((p) => [p, getComputedStyle(e).getPropertyValue(p)])) : null
    }
    const classes = new Set<string>()
    for (const e of [el, ...Array.from(el.querySelectorAll('*'))]) for (const c of Array.from(e.classList)) classes.add(c)
    // its place among the thread's turns and lines (runs and actions), as the app orders them by time
    const place = Array.from(el.parentElement!.children).filter((c) => c.matches('section[data-testid^="run-"], [data-testid^="action-"]')).indexOf(el)
    const text = (s: string) => (el.querySelector(s) as HTMLElement | null)?.innerText ?? null
    return {
      testid: el.getAttribute('data-testid')!, place, who: text('.action-who') ?? '', head: text('.action-head') ?? '', outcome: text('.action-outcome'),
      // the command's own text (pre.action-full) apart from the fixed words said instead of a withheld one (.action-missing,
      // which shares the .action-full class for its fold); and the line's whole text, for absence checks
      missing: el.getAttribute('data-missing'), full: text('[data-testid="action-full"]'), why: text('[data-testid="action-missing"]'),
      text: (el as HTMLElement).innerText, details: !!el.querySelector('[data-testid="action-details"]'),
      classes: [...classes].sort(), css, height: el.getBoundingClientRect().height, width: el.getBoundingClientRect().width,
    }
  }
  for (let i = 0; i < n; i++) {
    const line = lines.nth(i)
    await line.evaluate((el) => el.scrollIntoView({ block: 'start' }))
    await line.evaluate(async (el) => { await Promise.all(Array.from(el.querySelectorAll('img')).map((i) => (i as HTMLImageElement).decode().catch(() => undefined))); await document.fonts.ready })
    const folded = await line.evaluate(read, ACTION_CSS)
    await settle(page)
    const png = await line.screenshot({ path: join(OUT, 'compare', `${prefix}-action${String(i + 1).padStart(2, '0')}.png`), animations: 'disabled' })
    await line.locator('button.action-line').click()
    await page.mouse.move(0, 0)
    const opened = await line.evaluate(read, ACTION_CSS)
    await settle(page)
    const openPng = await line.screenshot({ path: join(OUT, 'compare', `${prefix}-action${String(i + 1).padStart(2, '0')}-open.png`), animations: 'disabled' })
    await line.locator('button.action-line').click()
    out.push({ ...opened, css: { ...folded.css, '.action-full': opened.css['.action-full'] ?? null }, classes: [...new Set([...folded.classes, ...opened.classes])].sort(), height: folded.height, openHeight: opened.height, png, openPng })
  }
  await page.setViewportSize({ width: page.viewportSize()!.width, height: APP_VIEWPORT.height })
  return out
}

/** One picture of every action line's pair, folded and opened: the app's on the left, the file's on the right. */
async function sideBySideActions(app: ActionCapture[], file: ActionCapture[], title: string, out: string, dark: boolean): Promise<void> {
  const page = await browser.newPage({ viewport: { width: 1800, height: 800 } })
  const img = (b: Buffer | undefined, w: number | undefined) => (b ? `<img src="data:image/png;base64,${b.toString('base64')}" width="${Math.round(w ?? 600)}">` : '<i>none</i>')
  const rows = app.map((a, i) => {
    const f = file[i]
    return `<tr><td colspan="2" class="n">action ${i + 1} · app ${a.testid.replace(/run_[0-9a-f]+/, 'run_…')} · file ${f?.testid ?? '—'} · ${f?.missing ?? 'carried'}</td></tr>`
      + `<tr><td>${img(a.png, a.width)}</td><td>${img(f?.png, f?.width)}</td></tr><tr><td>${img(a.openPng, a.width)}</td><td>${img(f?.openPng, f?.width)}</td></tr>`
  }).join('')
  await page.setContent(`<!doctype html><html><body style="margin:12px;font:13px system-ui;background:${dark ? '#333' : '#ddd'};color:${dark ? '#eee' : '#222'}">
    <h3 style="margin:0 0 8px">${title}</h3><table style="border-spacing:12px 4px"><tr><th>live app thread (same session)</th><th>exported file (file://, backend stopped)</th></tr>${rows}</table></body></html>`)
  await page.screenshot({ path: out, fullPage: true })
  await page.close()
}

/** The app's action lines and the file's, compared line by line: the same place among the turns, who (the person
 *  "you" in the app, "Person" in the file), head and outcome, classes and CSS; the whole text the app shows, in the
 *  file redacted (a bearer header), masked (a checkpoint's id) or withheld (a sensitive source) — said, never dropped. */
function compareActions(app: ActionCapture[], file: ActionCapture[]): Record<string, unknown> {
  assert.equal(file.length, app.length, 'as many action lines')
  const pairs = app.map((a, i) => {
    const f = file[i]!
    const cssDiff = Object.keys(ACTION_CSS).flatMap((k): unknown[] => {
      const x = a.css[k], y = f.css[k]
      if (!x || !y) return x === y || (k === '.action-full' && f.missing) || k === '.action-who img' ? [] : [{ probe: k, app: x, file: y }]
      return Object.keys(x).filter((p) => x[p] !== y[p]).map((p) => ({ probe: k, prop: p, app: x[p], file: y[p] }))
    })
    return {
      line: i + 1, app_testid: a.testid.replace(/run_[0-9a-f]+/, 'run_…'), file_testid: f.testid, place: [a.place, f.place], who: [a.who, f.who], head: [a.head, f.head],
      outcome: [a.outcome, f.outcome], missing: f.missing, details: f.details, full_equal: a.full === f.full, height: [a.height, f.height], open_height: [a.openHeight, f.openHeight],
      classes_only_app: a.classes.filter((c) => !f.classes.includes(c)), classes_only_file: f.classes.filter((c) => !a.classes.includes(c)), css_differences: cssDiff,
    }
  })
  return { lines: [app.length, file.length], pairs }
}

/** One picture: every run's pair, the app's on the left, the file's on the right. */
async function sideBySide(app: RunCapture[], file: RunCapture[], title: string, out: string, dark: boolean): Promise<void> {
  const page = await browser.newPage({ viewport: { width: 1800, height: 800 } })
  const rows = app.map((a, i) => {
    const f = file[i]
    const img = (c: RunCapture | undefined) => (c ? `<img src="data:image/png;base64,${c.png.toString('base64')}" width="${Math.round(c.width)}">` : '<i>none</i>')
    return `<tr><td colspan="2" class="n">run ${i + 1} · app ${a.testid.replace(/run_[0-9a-f]+/, 'run_…')} · file ${f?.testid ?? '—'} · heights ${Math.round(a.height)} / ${Math.round(f?.height ?? 0)} px</td></tr><tr><td>${img(a)}</td><td>${img(f)}</td></tr>`
  }).join('')
  await page.setContent(`<!doctype html><html><body style="margin:12px;font:13px system-ui;background:${dark ? '#333' : '#ddd'};color:${dark ? '#eee' : '#222'}">
    <h3 style="margin:0 0 8px">${title}</h3><table style="border-spacing:12px 4px"><tr><th>live app thread (same session)</th><th>exported file (file://, backend stopped)</th></tr>${rows}</table></body></html>`)
  await page.screenshot({ path: out, fullPage: true })
  await page.close()
}

/** The app's thread and the file's, compared: same order and count, same content width, classes, CSS, geometry. */
function compare(app: RunCapture[], file: RunCapture[], appCss: Record<string, unknown>, fileCss: Record<string, unknown>): Record<string, unknown> {
  const pairs = app.map((a, i) => {
    const f = file[i]!
    const onlyApp = a.classes.filter((c) => !f.classes.includes(c))
    const onlyFile = f.classes.filter((c) => !a.classes.includes(c))
    return {
      run: i + 1, app_testid: a.testid.replace(/run_[0-9a-f]+/, 'run_…'), file_testid: f.testid, status: [a.status, f.status],
      width: [a.width, f.width], height: [a.height, f.height], height_delta: Math.round(f.height - a.height),
      answers_equal: JSON.stringify(a.answers) === JSON.stringify(f.answers), answers_app: a.answers.map((t) => t.slice(0, 160)), answers_file: f.answers.map((t) => t.slice(0, 160)),
      user_equal: a.user === f.user, who: [a.who, f.who],
      classes_shared: a.classes.filter((c) => f.classes.includes(c)).length, classes_only_app: onlyApp, classes_only_file: onlyFile,
      layout_app: a.layout, layout_file: f.layout,
    }
  })
  const cssDiff = Object.keys(CSS_PROBES).flatMap((k): unknown[] => {
    const a = appCss[k] as Record<string, string> | null, f = fileCss[k] as Record<string, string> | null
    if (!a || !f) return [{ probe: k, app: a, file: f }]
    return Object.keys(a).filter((p) => a[p] !== f[p]).map((p) => ({ probe: k, prop: p, app: a[p], file: f[p] }))
  })
  return { runs: [app.length, file.length], pairs, css_app: appCss, css_file: fileCss, css_differences: cssDiff }
}

// ----------------------------------------------------------------------------------------------------------------------

test('the fixture: a session of real runs with synthetic canaries', async () => {
  mkdirSync(join(OUT, 'compare'), { recursive: true })
  const project = await api<{ id: string }>('/api/projects', { source_path: info.repo, name: 'share-fixture' })
  ids.project = project.id
  const session = await api<{ id: string }>(`/api/projects/${project.id}/sessions`, { title: TITLE, model: 'scripted:share' })
  ids.session = session.id
  ids.other = (await api<{ id: string }>(`/api/projects/${project.id}/sessions`, { title: 'Another session', model: 'scripted:share' })).id
  ids.main = await chat(PERSON, 'scripted:share')
  assert.equal(await runEnds(ids.main), 'done')
  // an answer with math (KaTeX, display and inline) and one with links the renderer refuses and a web link
  ids.math = await chat('explain the coverage bound', 'scripted:m')
  assert.equal(await runEnds(ids.math), 'done')
  ids.links = await chat('show me some links', 'scripted:l')
  assert.equal(await runEnds(ids.links), 'done')
  // an uploaded picture with a metadata canary, handed to a model that takes images
  const png = canaryPng()
  const att = await api<{ asset_id?: string; id?: string }>(`/api/sessions/${ids.session}/attachments?name=canary.png`, undefined, { raw: png, type: 'image/png' })
  const asset = att.asset_id ?? att.id ?? ''
  assert.match(asset, /^[A-Za-z0-9_-]+$/)
  ids.assets.push(asset)
  assert.equal(await runEnds(await chat('看这张图。', 'scripted:e', { attachments: [asset] })), 'done')
  assert.equal(await runEnds(await chat('a red square', 'scripted:img')), 'done')
  assert.equal(await runEnds(await chat('press the button', 'scripted:screen')), 'done')
  // a resumed run: the same conversation continued (its inherited history must not repeat)
  assert.equal(await runEnds(await chat('SHARE_RESUME 继续', 'scripted:share', { resumes_run_id: ids.main })), 'done')
  ids.excluded = await chat(`please answer ${EXCLUDED}`, 'scripted:share')
  assert.equal(await runEnds(ids.excluded), 'done')
  // ---- actions taken beside the agents, through the real routes: ChatGPT's commands on the connector's command route
  // (its client header), a checkpoint by hand — each a line of the thread, never a turn
  const ws = (await api<{ workspace: { id: string } | null }>(`/api/sessions/${ids.session}`)).workspace!.id
  const connector = { headers: { 'x-oasis-code-connector': 'ChatGPT' } }
  const commands: Record<string, unknown>[] = []
  for (const command of [ACTION_BENIGN, ACTION_FILES, ACTION_ENV]) {
    const r = await api<{ status?: string; exit_code?: number }>(`/api/workspaces/${ws}/commands`, { command, wait_s: 30 }, connector)
    assert.equal(r.exit_code, 0, `the synthetic command ran: ${JSON.stringify(r).slice(0, 300)}`)
    commands.push({ status: r.status, exit_code: r.exit_code })
  }
  const cp = await call(`/api/workspaces/${ws}/checkpoint`, { note: A.checkpoint_note })
  assert.equal(cp.status, 200, `the checkpoint by hand: ${cp.text.slice(0, 300)}`)
  const tree = await api<{ runs: { id: string; spawned_by?: string; label?: string | null; user_text?: string }[] }>(`/api/sessions/${ids.session}/runs/tree`)
  const actionRows = tree.runs.filter((r) => r.spawned_by === 'human_action')
  ids.actions = actionRows.map((r) => r.id)
  assert.deepEqual(actionRows.map((r) => r.label), ['command (ChatGPT)', 'command (ChatGPT)', 'command (ChatGPT)', 'checkpoint (by hand)'])
  // the action canaries are really in the action rows (the app shows them; the export must not)
  const actionText = actionRows.map((r) => r.user_text ?? '').join('\n')
  results.action_fixture = { commands, labels: actionRows.map((r) => r.label), canaries_in_rows: Object.fromEntries(Object.entries({ bearer: A.bearer, dotenv: A.dotenv, auth: A.auth, env: A.env, mark: A.mark }).map(([k, v]) => [k, actionText.includes(v)])) }
  for (const v of [A.bearer, A.dotenv, A.auth, A.env, A.mark]) assert.ok(actionText.includes(v), `the action rows hold ${v.slice(0, 12)}…`)
  // the canaries really are in the session's own records (counted, never printed): the export's absence checks below
  // are not vacuous. Sources: the session's replay (events) and the main run's stored transcript.
  const replay = (await call(`/api/sessions/${ids.session}/replay`)).text
  const transcript = (await call(`/api/runs/${ids.main}/transcript`)).text
  const expected = { dotenv: F.dotenv, auth: F.auth, env: F.env, bearer: F.bearer, needle: F.needle, email: 'alice.synthetic@example.com', home_username: 'synthuser', session_token: SESSION_TOKEN, api_key_tail: KEY_TAIL, query_secret: 'QUERYCANARY_33aa', excluded: EXCLUDED }
  const inRecords = Object.fromEntries(Object.entries(expected).map(([k, v]) => [k, { replay: replay.includes(v), main_transcript: transcript.includes(v) }]))
  results.canaries_in_source_records = inRecords
  const missing = Object.entries(inRecords).filter(([, w]) => !w.replay && !w.main_transcript).map(([k]) => k)
  assert.deepEqual(missing, [], 'every canary is really in the session records before its absence is checked')
  // the snapshot's source image bytes (as the harness hands them to the page): the uploaded one still has its canary
  const snap = await api<{ snapshot: { images: { key: string; media_type: string; data_base64: string }[]; items: unknown[] } }>(`/api/sessions/${ids.session}/share-snapshot`, { include_images: true, include_tool_details: true })
  const sources = snap.snapshot.images.map((i) => Buffer.from(i.data_base64, 'base64'))
  results.source_images = snap.snapshot.images.map((i, n) => ({ key: i.key, media_type: i.media_type, bytes: sources[n]!.length, sha256: sha(sources[n]!), has_metadata_canary: sources[n]!.includes(PNG_META) }))
  results.source_image_sha256 = sources.map((b) => sha(b))
  assert.ok(sources.some((b) => b.includes(PNG_META)), 'the uploaded source image keeps its metadata canary until the page re-encodes it')
  assert.ok(sources.length >= 3, `three images in the snapshot (upload, generated, screenshot): ${sources.length}`)
  for (const [k, v] of Object.entries(SECRETS)) if (k !== 'png_metadata') assert.ok(!JSON.stringify(snap.snapshot).includes(v), `snapshot JSON carries ${k}`)
  console.log(`[session-share] fixture: ${ids.runs.length} runs; canaries in records ${JSON.stringify(inRecords)}`)
})

// ======================================================================================================================
// the task share (snapshot V3, page v3): every session of a task, each with its Agent Teams card
// ======================================================================================================================

/** the task fixture's sessions by role (real ids: never in a share), its projects, its runs and pictures */
const T = {
  project: '', projectB: '', root: '', a: '', b: '', c: '', side: '',
  order: '', orderFollow: '', relay: [] as string[], assets: {} as Partial<Record<TaskRole, string>>,
  /** the director-controlled interaction, its participants' ids, the director sessions (real ids: never in a share) */
  interaction: '', participants: [] as string[], directors: [] as string[],
}
/** the task fixtures' planning director (live_share_fixture.ts TASK_PLANNER) */
const TASK_PLANNER = 'scripted:task-planner'
/** the director-controlled interaction's participants, as the fixture names them (each label its own: no two alike) */
const PLAN_PARTICIPANTS = ['Dave (synthetic)', 'Erin (synthetic)'] as const
/** The app's outline row as the share is to draw it: where the app's row names a participant by the id the harness
 *  gave it (a decision's "keep pt_…" — the app's own page shows its ids), the share names it by its label. Only the ids
 *  recorded from the API are replaced, each by the label the fixture gave that participant; nothing else of a row. */
const sharedName = (name: string): string => T.participants.reduce((n, id, i) => n.split(id).join(PLAN_PARTICIPANTS[i] ?? id), name)
const TASK_ROLES: TaskRole[] = ['root', 'a', 'b', 'c', 'side']
const roleOfTitle = (title: string): TaskRole | null => (Object.entries(TASK_TITLES).find(([, t]) => title.includes(t))?.[0] as TaskRole | undefined) ?? null
const idOf = (role: TaskRole): string => (T as unknown as Record<string, string>)[role]!
/** the files of the task share */
const TASK_FILES = { task: 'example-task-share.html', legacyV2: 'legacy-v2-in-new-viewer.html', legacyV1: 'legacy-v1-in-new-viewer.html' }
/** what the app drew of the task (its rail's bots, its Agent Teams outline, its turns' bots), for the share to equal */
type OutlineRead = { name: string; bot: string | null; runs: number; ind: string; status: string | null; kind: string | null }
/** turns: by session, the bots of each turn of the app's thread by its real run id */
const appSeen: { rail: Record<string, string[] | null>; outline: Record<string, OutlineRead[]>; turns: Record<string, Record<string, string[]>> } = { rail: {}, outline: {}, turns: {} }
/** the task file's run keys, by session key, as the real runs they are (the dialog's own selection: never in a file) */
const taskRunIds: Record<string, Record<string, string>> = {}

/** The product's bots and the main agent's pick (contract/src/bots.ts BOTS, hashOf, mainBot), restated: a drift fails
 *  here, loudly. */
const BOTS = ['01-keycap', '02-terminal', '03-cursor', '04-braces', '05-bubble', '07-pixel', '08-prompt', '09-spark', '10-hex', '13-puzzle', '15-rocket', '16-lens', '17-shield',
  '18-robot', '19-chip', '20-at', '21-megaphone', '22-whistle', '23-signpost', '24-badge', '25-compass', '26-crownblob', '27-crown', '28-flag', '29-lighthouse', '30-telescope', '31-pin', '32-helm', '33-bell']
const SHARE_BOT_NAMES = [...BOTS, 'director', 'chatgpt']
function hashOf(text: string): number { let h = 2166136261; for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619) } return h >>> 0 }
const mainBot = (sessionId: string): string => BOTS[hashOf(`session:${sessionId}`) % BOTS.length]!

/** A PNG of a session of the task: its own size and colour, its own metadata canary in a tEXt chunk (synthetic). */
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
  const raw = Buffer.alloc((1 + w * 3) * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set([rgb[0], (rgb[1] + x * 3) % 256, rgb[2]], y * (1 + w * 3) + 1 + x * 3)
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('tEXt', Buffer.from(`Comment\0${spec.meta} owner ${TASK_HOME_USER}`, 'latin1')),
    chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]))
}

/** must be absent from a task share, whatever the options: the legacy canaries, the task's, every picture's metadata */
const TASK_SECRET_VALUES: Record<string, string> = {
  ...SECRETS, task_mail: TASK_SECRETS.mail, task_home_user: TASK_SECRETS.home_user, task_bearer: TASK_SECRETS.bearer,
  ...Object.fromEntries(TASK_ROLES.map((r) => [`png_meta_${r}`, TASK_IMAGES[r].meta])),
}
/** must be absent from a task share of the task: the deleted member and the task beside it */
const NOT_OF_THE_TASK: Record<string, string> = { deleted_mark: TASK_MARKS.c, deleted_title: TASK_TITLES.c, side_mark: TASK_MARKS.side, side_title: TASK_TITLES.side }

async function chatIn(session: string, text: string, model: string, extra: Record<string, unknown> = {}): Promise<string> {
  return (await api<{ id: string }>(`/api/sessions/${session}/chat`, { text, model, ...extra })).id
}
async function idleOf(session: string, ms = 60_000): Promise<void> {
  for (const t0 = Date.now(); Date.now() - t0 < ms;) {
    const s = await api<{ active_runs?: unknown[]; active_run?: unknown }>(`/api/sessions/${session}`)
    if (!(s.active_runs ?? []).length && !s.active_run) return
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error(`session ${session} never became idle`)
}
async function del(path: string): Promise<{ status: number; text: string }> {
  const r = await fetch(`${BASE}${path}`, { method: 'DELETE', headers: { 'x-oasis-code-token': info.token, origin: BASE } })
  return { status: r.status, text: await r.text() }
}
async function uploadTo(session: string, role: TaskRole): Promise<string> {
  const att = await api<{ asset_id?: string; id?: string }>(`/api/sessions/${session}/attachments?name=${role}-picture.png`, undefined, { raw: taskPng(role), type: 'image/png' })
  const asset = att.asset_id ?? att.id ?? ''
  assert.match(asset, /^[A-Za-z0-9_-]+$/)
  return asset
}
/** POST …/share-snapshot/v3, retried while a session of it settles (a run's end is recorded a moment after it ends) */
async function v3(session: string, body: Record<string, unknown>, settle = true): Promise<{ status: number; body: { snapshot: SnapshotV3; selection: { runs: { run_id: string; session: string; key: string }[] }; code?: string; reasons?: string[] }; text: string }> {
  for (let i = 0; ; i++) {
    const r = await call<{ snapshot: SnapshotV3; selection: { runs: { run_id: string; session: string; key: string }[] }; code?: string; reasons?: string[] }>(`/api/sessions/${session}/share-snapshot/v3`, body)
    if (!(settle && r.status === 409 && i < 40)) return r
    await new Promise((res) => setTimeout(res, 250))
  }
}
/** the page document of a file (its JSON data block) */
const docOf = (html: string): TaskDoc => JSON.parse(partsOf(html).data) as TaskDoc
const sessionByRole = (snap: SnapshotV3, role: TaskRole) => snap.sessions.find((s) => roleOfTitle(s.title) === role)

/** What the app draws for one session, read from its own page: its rail's bots for each session of the task, its Agent
 *  Teams outline's rows, the bots of its thread's turns. */
async function readApp(page: Page, sid: string): Promise<void> {
  await page.click(`[data-testid="session-${sid}"]`)
  await page.locator('[data-testid="share-open"]').waitFor()
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="thread"] > section[data-testid^="run-"]').length > 0, undefined, { timeout: 30_000 })
  await page.waitForTimeout(800)
  for (const id of [T.root, T.a, T.b]) {
    const entry = page.locator(`[data-testid="session-${id}"] [data-testid="rail-bots"]`)
    appSeen.rail[id] = (await entry.count()) ? await entry.first().locator('img[data-bot]').evaluateAll((els) => els.map((e) => e.getAttribute('data-bot')!)) : null
  }
  if (!(await page.locator('[data-testid="graph-dock"]').count())) {
    await page.click('[data-testid="desk-shelf"]')
    await page.click('.desk-tail-list .desk-chip:has-text("Agent Teams")')
    await page.waitForSelector('[data-testid="graph-dock"]')
  }
  await page.waitForTimeout(500)
  appSeen.outline[sid] = await readOutline(page)
  appSeen.turns[sid] = Object.fromEntries((await readTurnBots(page)).map((t) => [t.id, t.bots]))
}
/** the rows of the Agent Teams outline on a page (the app's or a share's: the same OutlineView) */
function readOutline(page: Page): Promise<OutlineRead[]> {
  return page.locator('[data-testid="graph-dock"] .ol-node:not(.folder)').evaluateAll((els) => els.map((e) => ({
    name: (e.querySelector('.ol-nm') as HTMLElement | null)?.innerText.trim() ?? '',
    bot: e.querySelector('.ol-ico img[data-bot]')?.getAttribute('data-bot') ?? null,
    runs: Number(/· (\d+) runs/.exec(e.getAttribute('title') ?? '')?.[1] ?? 1),
    ind: (e as HTMLElement).style.getPropertyValue('--ind'),
    status: e.getAttribute('data-status'), kind: e.getAttribute('data-kind'),
  })))
}
/** the bots each turn of the thread wears, turn by turn, with the turn's run (the app's: its real id; a share's: its key) */
function readTurnBots(page: Page): Promise<{ id: string; bots: string[] }[]> {
  return page.locator('[data-testid="thread"] > section[data-testid^="run-"]').evaluateAll((els) => els.map((e) => ({
    id: e.getAttribute('data-testid')!.slice('run-'.length),
    bots: Array.from(e.querySelectorAll('.turn-agent img[data-bot]')).map((i) => i.getAttribute('data-bot')!),
  })))
}

test('the frozen route still answers V2 (its twelve limits): kept as the older page\'s sample', async () => {
  const legacy = await api<{ snapshot: { version: number; limits: Record<string, number>; images: unknown[]; runs: { request: string }[] } }>(`/api/sessions/${ids.session}/share-snapshot`, {})
  assert.equal(legacy.snapshot.version, 2, 'the frozen route answers V2')
  assert.equal(Object.keys(legacy.snapshot.limits).length, 12, 'V2 keeps its twelve limits')
  assert.deepEqual(legacy.snapshot.images, [])
  writeFileSync(join(OUT, 'legacy-v2-snapshot.json'), JSON.stringify(legacy.snapshot))
})

test('task fixture: a task across two projects — its first session, a member, a member of another project, a member deleted — and a task of its own', async () => {
  T.project = ids.project
  assert.ok(T.project, 'the legacy fixture made the first project')
  T.projectB = (await api<{ id: string }>('/api/projects', { source_path: info.repo_b, name: 'share-fixture-b' })).id
  const make = async (role: TaskRole, project: string, join?: string) =>
    (await api<{ id: string }>(`/api/projects/${project}/sessions`, { title: TASK_TITLES[role], model: TASK_ROUTE, ...(join ? { task_session_id: join } : {}) })).id
  T.root = await make('root', T.project)
  T.a = await make('a', T.project, T.root)
  // joined through the member: the task is its first session's
  T.b = await make('b', T.projectB, T.a)
  T.c = await make('c', T.project, T.root)
  T.side = await make('side', T.project)
  // each session's own words first; the relay and the director's worker below take no image (the product refuses a
  // conversation that holds a picture to a route that cannot take it), so the pictures come after them
  for (const role of TASK_ROLES) assert.equal(await runEnds(await chatIn(idOf(role), `${TASK_CASES.mark} ${TASK_MARKS[role]}`, TASK_ROUTE)), 'done')
  // the member's words name the other project's folder (an absolute path outside any home: the share must not carry it)
  assert.equal(await runEnds(await chatIn(T.a, `${TASK_CASES.tool} ${TASK_MARKS.a} — compare with ${info.repo_b}/calc.py`, TASK_ROUTE)), 'done')
  // the first session's card: a work order continued once (one row, two runs), a relay of two participants
  const order = await call<{ id: string }>(`/api/sessions/${T.root}/work-orders`, { work_order: { label: TASK_ORDER.label, prompt: `${TASK_ORDER.label}: list the repository files and report how many there are.`, model: 'scripted:c' } })
  assert.equal(order.status, 200, order.text.slice(0, 300))
  T.order = order.body.id
  assert.equal(await runEnds(T.order), 'done')
  const follow = await call<{ id: string }>(`/api/sessions/${T.root}/work-orders`, { work_order: { prompt: TASK_ORDER.follow_up, resumes_run_id: T.order } })
  assert.equal(follow.status, 200, follow.text.slice(0, 300))
  T.orderFollow = follow.body.id
  assert.equal(await runEnds(T.orderFollow), 'done')
  const relay = await call<{ id: string; relay_id: string | null }>(`/api/sessions/${T.root}/chat`, { text: 'Carol asks two reviewers to read calc.py', agents: [{ model: 'scripted:relay-a' }, { model: 'scripted:relay-b' }] })
  assert.equal(relay.status, 200, relay.text.slice(0, 300))
  await idleOf(T.root, 90_000)
  T.relay = (await api<{ runs: { id: string; relay_id: string | null; model: string; created_at: string }[] }>(`/api/sessions/${T.root}`)).runs
    .filter((r) => r.relay_id !== null && r.relay_id === relay.body.relay_id).sort((x, y) => x.created_at.localeCompare(y.created_at)).map((r) => r.id)
  assert.equal(T.relay.length, 2, 'the relay ran its two participants')
  // the member's director hands work to Scripted Worker: the director takes part in the session (its bot on the rail),
  // and the worker it starts is a turn of the session's thread, its words the director's (a native director's
  // start_run continues the thread: no plan row of its own — api/tree.ts planRows makes one for a director's
  // interaction only, below)
  const opened = await call(`/api/sessions/${T.a}/director`, { transport: 'native', model: 'scripted:dir' })
  assert.equal(opened.status, 200, `the director opened: ${opened.text.slice(0, 300)}`)
  const said = await call(`/api/sessions/${T.a}/director/messages`, { text: TASK_DIRECTOR_WORDS })
  assert.equal(said.status, 200, `the director was told: ${said.text.slice(0, 300)}`)
  for (const t0 = Date.now(); !(await call(`/api/sessions/${T.a}/director`)).text.includes('DIRECTOR_JUDGED');) {
    assert.ok(Date.now() - t0 < 90_000, 'the director judged the worker')
    await new Promise((r) => setTimeout(r, 250))
  }
  await idleOf(T.a, 60_000)
  T.directors.push(...[(await api<{ director: { id: string } | null }>(`/api/sessions/${T.a}/director`)).director?.id].filter((x): x is string => !!x))
  const closed = await del(`/api/sessions/${T.a}/director`)
  assert.ok(closed.status < 300, `the director closed: ${closed.status} ${closed.text.slice(0, 200)}`)
  // a director's interaction in the member: the product's own route (POST /api/sessions/:id/interactions, no plan, a
  // director_model) makes it controller `director` (agent/interactions.ts: no template, the director plans), opens a
  // native director on the test's scripted planner (live_share_fixture.ts scripted:task-planner) and asks it for the
  // plan; the planner schedules one step per participant, then stops. api/tree.ts planRows then draws the plan row (the
  // director's bot), the steps it scheduled under it (scheduled_by), the person's decision after them. (The natural
  // director's interactions are templates — controller `fixed` — with no plan row.) Two participants named by the
  // client, so the harness gives them ids of its own (pt_…): recorded, and never in a share. The interaction ends
  // `done` (not active: the share is not refused)
  const started = await call<{ id: string; controller: string; participants: { id: string }[] }>(`/api/sessions/${T.a}/interactions`, {
    text: `${TASK_CASES.mark} ${TASK_MARKS.a}: Dave and Erin, one candidate each (synthetic)`,
    participants: PLAN_PARTICIPANTS.map((label) => ({ model: TASK_ROUTE, label })),
    director_model: TASK_PLANNER,
  })
  assert.equal(started.status, 200, `the interaction started: ${started.text.slice(0, 300)}`)
  assert.equal(started.body.controller, 'director', 'the director plans it')
  T.interaction = started.body.id
  T.participants = started.body.participants.map((p) => p.id)
  assert.equal(T.participants.length, 2)
  for (const t0 = Date.now(); ;) {
    const ix = await api<{ status: string; controller: string; nodes: { status: string }[] }>(`/api/interactions/${T.interaction}`)
    assert.ok(!['cancelled', 'error', 'interrupted'].includes(ix.status), `the interaction runs to its end: ${ix.status} ${JSON.stringify(ix.nodes.map((n) => n.status))}`)
    if (ix.status === 'done') { assert.equal(ix.nodes.length, 2, 'the planner scheduled one step per participant'); break }
    assert.ok(Date.now() - t0 < 120_000, `the interaction ends: ${ix.status} ${JSON.stringify(ix.nodes.map((n) => n.status))}`)
    await new Promise((r) => setTimeout(r, 250))
  }
  T.directors.push(...[(await api<{ director: { id: string } | null }>(`/api/sessions/${T.a}/director`)).director?.id].filter((x): x is string => !!x))
  // the director's side of the end, as the product records it (no words of the scripted director are waited for: its
  // NATURAL_RESULT_INDEX answers director.v1's line only, and a director opened here holds the current surface):
  // director/controller.ts interactionFinished enqueues one `interaction_finished` event for the director when the
  // interaction names its source turn (and the director is open); director/outbox.ts writes it into the next turn's
  // input — director.v1 as "interaction execution index", every later surface as "interaction <id> ended (execution
  // index". So: that turn there and ended `done` (when the interaction has a source turn); then the director idle —
  // no turn queued or under way, no event left to deliver — and the session without an active run
  type DirectorDetail = { director: { state: string; config?: { tool_surface?: string } } | null; turns: { id: string; kind: string; status: string; input: string }[]; pending_events: { kind: string; status: string }[] }
  const finished = (await api<{ interactions: { id: string; status: string; source_turn_id: string | null }[] }>(`/api/sessions/${T.a}`)).interactions[0]!
  const surfaceOf = (await api<DirectorDetail>(`/api/sessions/${T.a}/director`)).director?.config?.tool_surface ?? null
  const endLine = surfaceOf === 'director.v1' ? 'interaction execution index' : `interaction ${finished.id} ended (execution index`
  if (finished.source_turn_id !== null) {
    for (const t0 = Date.now(); ;) {
      const d = await api<DirectorDetail>(`/api/sessions/${T.a}/director`)
      const told = d.turns.find((t) => t.input.includes(endLine))
      if (told && ['done', 'error', 'cancelled'].includes(told.status)) { assert.equal(told.status, 'done', `the director's turn on the interaction's end: ${told.status}`); break }
      assert.ok(Date.now() - t0 < 60_000, `the director is told the interaction ended (${surfaceOf}): ${JSON.stringify(d.turns.map((t) => [t.kind, t.status]))}`)
      await new Promise((r) => setTimeout(r, 250))
    }
  }
  for (const t0 = Date.now(); ;) {
    const d = await api<DirectorDetail>(`/api/sessions/${T.a}/director`)
    assert.deepEqual(d.pending_events.filter((e) => e.status === 'failed'), [], 'no event failed to reach the director')
    if (!d.turns.some((t) => ['queued', 'generating', 'awaiting_answer'].includes(t.status)) && d.pending_events.length === 0) break
    assert.ok(Date.now() - t0 < 60_000, `the planning director idle: ${JSON.stringify({ turns: d.turns.map((t) => [t.kind, t.status]), events: d.pending_events.map((e) => [e.kind, e.status]) })}`)
    await new Promise((r) => setTimeout(r, 250))
  }
  results.task_interaction = { id_known: true, source_turn: finished.source_turn_id !== null, surface: surfaceOf }
  await idleOf(T.a, 60_000)
  const closedPlanner = await del(`/api/sessions/${T.a}/director`)
  assert.ok(closedPlanner.status < 300, `the planning director closed: ${closedPlanner.status} ${closedPlanner.text.slice(0, 200)}`)
  // now each session's picture (every first picture `img1`), shown to a model that takes images
  for (const role of TASK_ROLES) {
    const sid = idOf(role)
    T.assets[role] = await uploadTo(sid, role)
    assert.equal(await runEnds(await chatIn(sid, `${TASK_MARKS[role]}: look at this picture`, 'scripted:e', { attachments: [T.assets[role]] })), 'done')
  }
  // the member deleted: never in a share of the task again
  const gone = await del(`/api/sessions/${T.c}`)
  assert.ok(gone.status < 300, `deleted: ${gone.status} ${gone.text.slice(0, 200)}`)
  for (const role of ['root', 'a', 'b', 'side'] as const) await idleOf(idOf(role))
  // the app's own reading of the task: across both projects, by the task alone, the deleted member out
  type Detail = { task_root_id: string | null; task_sessions: { id: string; project_id: string; status: string }[] }
  const fromB = await api<Detail>(`/api/sessions/${T.b}`)
  const fromRoot = await api<Detail>(`/api/sessions/${T.root}`)
  assert.equal(fromB.task_root_id, T.root, 'joined through a member: the task is its first session\'s')
  assert.deepEqual(fromB.task_sessions.map((s) => s.id).sort(), [T.root, T.a, T.b].sort())
  assert.deepEqual(fromRoot.task_sessions.map((s) => s.id).sort(), [T.root, T.a, T.b].sort())
  assert.deepEqual([...new Set(fromB.task_sessions.map((s) => s.project_id))].sort(), [T.project, T.projectB].sort(), 'the task spans two projects')
  assert.deepEqual((await api<Detail>(`/api/sessions/${T.side}`)).task_sessions.map((s) => s.id), [T.side], 'the task of its own')
  results.task_fixture = { sessions: TASK_ROLES.map((r) => ({ role: r, title: TASK_TITLES[r] })), relay_runs: T.relay.length, order_runs: 2 }
})

test('task share in the app: off by default (this session only); on, every session of the task in the rail\'s order — the same from its first session; busy while one works; the bots the app draws', async () => {
  const context = await browser.newContext({ viewport: APP_VIEWPORT, acceptDownloads: true })
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  try {
    await page.goto(`${BASE}/?token=${info.token}`)
    // what the app draws, session by session: read before anything is shared
    await readApp(page, T.root)
    await readApp(page, T.a)
    results.task_app_seen = appSeen
    assert.ok(appSeen.rail[T.root]?.length && appSeen.rail[T.a]?.length, `the rail draws the task's sessions: ${JSON.stringify(appSeen.rail)}`)
    assert.ok(appSeen.outline[T.root]!.length >= 3, `the first session's outline: ${JSON.stringify(appSeen.outline[T.root])}`)
    await page.waitForFunction(() => document.querySelector('[data-testid="share-open"]')?.getAttribute('data-busy') === 'false', undefined, { timeout: 30_000 })

    // ---- off by default: this session alone (V3, one session); its runs may be left out
    await page.click('[data-testid="share-open"]')
    const r1 = await ready(page)
    assert.equal(await page.isChecked('[data-testid="share-task"]'), false, 'every session of the task: off by default')
    const one = docOf(r1.srcdoc)
    assert.deepEqual([one.version, one.snapshot.version, one.snapshot.scope, one.snapshot.sessions.length, one.snapshot.options.include_task_sessions], [PAGE_VERSION_NOW, 3, 'session', 1, false])
    assert.equal(roleOfTitle(one.snapshot.sessions[0]!.title), 'a', 'the session it was opened from')
    assert.equal(await page.locator('[data-testid="share-runs"]').count(), 1, 'one session: its runs may be left out')
    for (const role of ['root', 'b', 'c', 'side'] as const) assert.ok(!r1.srcdoc.includes(TASK_MARKS[role]), `this session only: nothing of ${role}`)

    // ---- on: every session of the task, not deleted, across projects; the task beside it out; no run list
    await page.check('[data-testid="share-task"]')
    await page.waitForFunction(() => {
      if (document.querySelector('[data-testid="share-dialog"]')?.getAttribute('data-phase') !== 'ready') return false
      const m = /<script type="application\/json" id="share-data">([\s\S]*?)<\/script>/.exec(document.querySelector('[data-testid="share-preview"]')?.getAttribute('srcdoc') ?? '')
      try { return JSON.parse(m?.[1] ?? 'null')?.snapshot?.scope === 'task' } catch { return false }
    }, undefined, { timeout: 60_000 })
    assert.equal(await page.locator('[data-testid="share-runs"]').count(), 0, 'the task: no run list')
    await page.check('[data-testid="share-images"]')
    await page.waitForFunction(() => {
      if (document.querySelector('[data-testid="share-dialog"]')?.getAttribute('data-phase') !== 'ready') return false
      const m = /<script type="application\/json" id="share-data">([\s\S]*?)<\/script>/.exec(document.querySelector('[data-testid="share-preview"]')?.getAttribute('srcdoc') ?? '')
      try { const o = JSON.parse(m?.[1] ?? 'null')?.snapshot?.options; return o?.include_task_sessions === true && o?.include_images === true } catch { return false }
    }, undefined, { timeout: 60_000 })
    const saved = await saveReady(page, TASK_FILES.task)
    const doc = docOf(saved.srcdoc)
    const snap = doc.snapshot
    // the rail's order: the task's first session, then the others by their latest activity
    type Listed = { id: string; title: string; last_activity_at: string }
    const listed = (await api<{ task_sessions: Listed[] }>(`/api/sessions/${T.a}`)).task_sessions
    const others = listed.filter((s) => s.id !== T.root).sort((x, y) => Date.parse(y.last_activity_at) - Date.parse(x.last_activity_at))
    const expectOrder = [T.root, ...others.map((s) => s.id)].map((id) => TASK_TITLES[(['root', 'a', 'b'] as const).find((r) => idOf(r) === id)!])
    assert.deepEqual(snap.sessions.map((s) => s.title), expectOrder, 'every session of the task, in the rail\'s order')
    assert.deepEqual(snap.sessions.map((s) => s.member), [false, true, true], 'the first session, then its members')
    assert.equal(new Set(snap.sessions.map((s) => s.key)).size, 3, 'a key of its own each')
    assert.equal(snap.current, sessionByRole(snap, 'a')!.key, 'the share opens on the session it was made from')
    assert.deepEqual(snap.sessions.filter((s) => s.current).map((s) => s.key), [snap.current])
    for (const [k, v] of Object.entries(NOT_OF_THE_TASK)) assert.ok(!saved.srcdoc.includes(v), `not of the task: ${k}`)
    assert.ok(!/[\u200b/\\]|\.\.|e2e-token|<|>/.test(saved.suggested) && saved.suggested.endsWith('.html'), `file name ${JSON.stringify(saved.suggested)}`)
    // the file's run keys as the real runs they are: the same projection asked again (the same options), its selection
    const same = await v3(T.a, { include_task_sessions: true, include_images: true })
    assert.equal(same.status, 200, same.text.slice(0, 300))
    assert.deepEqual(same.body.snapshot.sessions.map((s) => [s.key, s.title, s.runs.map((r) => r.key)]), snap.sessions.map((s) => [s.key, s.title, s.runs.map((r) => r.key)]), 'the same projection')
    for (const r of same.body.selection.runs) (taskRunIds[r.session] ??= {})[r.key] = r.run_id
    results.task_download = { file: TASK_FILES.task, bytes: saved.bytes, sha256: saved.sha256, suggested: saved.suggested, order: snap.sessions.map((s) => [s.key, roleOfTitle(s.title)]) }

    // the bots: the rail's (sessions[].bots, the app's first three), the main agent's pick by the real session id
    for (const s of snap.sessions) {
      const id = idOf(roleOfTitle(s.title)!)
      for (const b of [...s.bots, ...s.runs.map((r) => r.bot), ...s.team.rows.map((r) => r.bot)]) if (b !== null) assert.ok(SHARE_BOT_NAMES.includes(b), `a bot of the product: ${b}`)
      if (appSeen.rail[id]) assert.deepEqual(s.bots.slice(0, 3), appSeen.rail[id], `${s.title}: the rail's bots, as the app draws them`)
      const markRun = s.items.find((i) => (i.text ?? '').includes(TASK_MARKS[roleOfTitle(s.title)!]) && i.kind === 'message')?.run
      const run = s.runs.find((r) => r.key === markRun)
      assert.ok(run, `${s.title}: the run that answered its mark`)
      assert.equal(run!.bot, mainBot(id), `${s.title}: the main agent's bot is picked by the session (as the app picks it)`)
      assert.equal(s.bots[0], mainBot(id), `${s.title}: the main agent first in the rail's bots`)
    }
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('[data-testid="share-dialog"]'))

    // ---- busy: one session of the task works (the member of the other project) — refused whole, said by its title
    const held = await chatIn(T.b, `${TASK_CASES.hold} ${TASK_MARKS.b}`, TASK_ROUTE)
    for (const t0 = Date.now(); ;) {
      const g = await fetch(`${BASE}/e2e/ui-gate?gate=${TASK_GATES.hold(TASK_MARKS.b)}`, { headers: { authorization: `Bearer ${info.token}` } })
      if (((await g.json()) as { held: boolean }).held) break
      assert.ok(Date.now() - t0 < 20_000, 'the member\'s run is held')
      await new Promise((r) => setTimeout(r, 100))
    }
    const refused = await v3(T.a, { include_task_sessions: true }, false)
    assert.equal(refused.status, 409)
    assert.equal(refused.body.code, 'session_active')
    const reasons = refused.body.reasons ?? []
    assert.ok(reasons.some((r) => r.includes(TASK_TITLES.b)), `the reason names the session that works: ${JSON.stringify(reasons)}`)
    assert.ok(!/\b(s|run|ws|pj|p)_[0-9a-f]{6,}/.test(JSON.stringify(reasons)), 'no id in the reasons')
    // this session alone is not refused (the member that works is not in it)
    assert.equal((await v3(T.a, {})).status, 200)
    await page.click('[data-testid="share-open"]')
    await ready(page)
    await page.check('[data-testid="share-task"]')
    await page.waitForSelector('[data-testid="share-dialog"][data-phase="busy"] [data-testid="share-retry"]', { timeout: 30_000 })
    assert.equal(await page.locator('[data-testid="share-download"]').isDisabled(), true)
    await page.locator('[data-testid="share-dialog"]').screenshot({ path: join(OUT, 'task-dialog-busy.png') })
    await release(TASK_GATES.hold(TASK_MARKS.b))
    assert.equal(await runEnds(held), 'done')
    await idleOf(T.b)
    await page.click('[data-testid="share-retry"]')
    const retried = docOf((await ready(page)).srcdoc)
    assert.equal(retried.snapshot.scope, 'task', 'Retry builds the task once it is still')
    await page.locator('[data-testid="share-dialog"]').screenshot({ path: join(OUT, 'task-dialog-ready.png') })
    await page.keyboard.press('Escape')
  } finally { await context.close() }
  assert.deepEqual(errors, [])

  // ---- from the task's first session: the same sessions, the same titles and keys' order; it opens on its own
  const fromRoot = await v3(T.root, { include_task_sessions: true })
  assert.equal(fromRoot.status, 200, fromRoot.text.slice(0, 300))
  const fromA = await v3(T.a, { include_task_sessions: true })
  assert.deepEqual(fromRoot.body.snapshot.sessions.map((s) => s.title), fromA.body.snapshot.sessions.map((s) => s.title), 'the same task from its first session and from a member')
  assert.equal(roleOfTitle(fromRoot.body.snapshot.sessions.find((s) => s.key === fromRoot.body.snapshot.current)!.title), 'root')
  // a run of any session of the task may be left out; the selection names its session's key
  assert.deepEqual([...new Set(fromA.body.selection.runs.map((r) => r.session))].sort(), fromA.body.snapshot.sessions.map((s) => s.key).sort(), 'the run choice covers every session')

  // ---- leaving out the earliest participant (relay A's run) changes no later bot (B3): the relay's second participant
  // wears the bot it wore with every run in — on its turn and on its card's row
  const whole = (await v3(T.root, {})).body.snapshot.sessions[0]!
  const less = (await v3(T.root, { exclude_run_ids: [T.relay[0]!] })).body.snapshot.sessions[0]!
  const reviewerBot = (s: SessionV3) => {
    const run = s.items.find((i) => i.kind === 'message' && /REVIEW_CONTEXT_(OK|MISSING)/.test(i.text ?? ''))?.run
    return { turn: s.runs.find((r) => r.key === run)?.bot ?? null, row: s.team.rows.find((r) => r.turn === run)?.bot ?? null }
  }
  assert.ok(reviewerBot(whole).turn, 'the second participant wears a bot')
  assert.equal(less.runs.length, whole.runs.length - 1, 'one run fewer')
  assert.deepEqual(reviewerBot(less), reviewerBot(whole), 'the earliest participant left out: the later one keeps its bot')
  // a run of no turn of the thread (the work order's, a card's run): its row's bot is the outline's (botOf), the same with
  // that run in or out of the thread
  const orderRow = whole.team.rows.find((r) => r.name.includes(TASK_ORDER.label))
  assert.ok(orderRow && orderRow.runs === 2, `the work order continued once: one row, two runs ${JSON.stringify(orderRow)}`)
  results.task_bots = { reviewer: reviewerBot(whole), order_row: orderRow, root_rail: whole.bots }

})

test('the app: entry, live thread captured light/dark, dialog, preview = download bytes, options, excluded run, busy 409 + Retry, session switch', async () => {
  // no serviceWorkers:'block' here: Playwright enforces it with a script of its own in every frame, which throws a
  // SecurityError in the preview's sandboxed (opaque-origin) frame — the harness's error, not the page's. The file://
  // contexts below block service workers.
  const context = await browser.newContext({ viewport: APP_VIEWPORT, acceptDownloads: true })
  const page = await context.newPage()
  const errors: string[] = []
  const consoleErrors: { text: string; url: string }[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push({ text: m.text().slice(0, 240), url: m.location().url.slice(0, 80) }) })
  // what the preview frame asks for (it must ask for nothing)
  const previewRequests: string[] = []
  page.on('request', (r) => { const f = r.frame(); if (f !== page.mainFrame()) previewRequests.push(r.url().slice(0, 80)) })
  const openSession = async () => {
    await page.goto(`${BASE}/?token=${info.token}`)
    await page.click(`[data-testid="session-${ids.session}"]`)
    await page.locator('[data-testid="share-open"]').waitFor()
    await page.waitForSelector(`[data-testid="run-${ids.links}"][data-status="done"]`)
    await page.waitForFunction(() => document.querySelector('[data-testid="share-open"]')?.getAttribute('data-busy') === 'false', undefined, { timeout: 30_000 })
  }
  await openSession()
  const open = page.locator('[data-testid="share-open"]')
  assert.equal(await open.getAttribute('aria-label'), 'Share')
  // the entry sits right after Replay
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid="share-open"]')?.previousElementSibling?.getAttribute('data-testid')), 'replay')
  await page.locator('header.thread-header').screenshot({ path: join(OUT, 'app-entry-header.png') })

  // while work is under way (a held run) the icon stays usable and opens on a live link; the HTML side says the file
  // waits for an idle session (the server answers 409 session_active), with Retry — never a disabled icon
  const held = await chat('STEER_CASE_TEXT share busy one', 'scripted:steer')
  await page.waitForFunction(() => document.querySelector('[data-testid="share-open"]')?.getAttribute('data-busy') === 'true', undefined, { timeout: 15_000 })
  assert.equal(await open.isDisabled(), false, 'the share icon is usable while the session works')
  const busyTitle = await open.getAttribute('title')
  const refused = await call<{ code?: string }>(`/api/sessions/${ids.session}/share-snapshot`, {})
  assert.equal(refused.status, 409)
  assert.equal(refused.body.code, 'session_active')
  await open.click()
  await page.waitForSelector('[data-testid="share-dialog"][data-mode="live"] [data-testid="live-share-dialog"]', { timeout: 15_000 })
  assert.equal(await page.getAttribute('[data-testid="share-mode-live"]', 'aria-pressed'), 'true')
  await page.click('[data-testid="share-mode-html"]')
  await page.waitForSelector('[data-testid="share-dialog"][data-mode="html"][data-phase="busy"] [data-testid="share-retry"]', { timeout: 30_000 })
  assert.equal(await page.locator('[data-testid="share-download"]').isDisabled(), true)
  await page.locator('[data-testid="share-dialog"]').screenshot({ path: join(OUT, 'app-dialog-opened-busy.png') })
  await page.click('[data-testid="share-close"]')
  await page.waitForFunction(() => !document.querySelector('[data-testid="share-dialog"]'))
  await release('steer')
  await runEnds(held)
  await idle()
  await page.waitForFunction(() => document.querySelector('[data-testid="share-open"]')?.getAttribute('data-busy') === 'false', undefined, { timeout: 30_000 })
  results.busy_while_active = { title: busyTitle, api_status: refused.status, api_code: refused.body.code, opened_on: 'live', html_side: 'busy' }

  // ---- the live thread of THIS session, captured before anything is exported: light (the app's default), then dark
  // through the app's own theme choice (its storage key in this test's own browser context, then a reload). Both
  // from a fresh load of the session (the thread as it reads its records, as the export does — not the streamed
  // state of a run that just ended)
  await openSession()
  await page.waitForSelector(`[data-testid="run-${held}"][data-status="done"]`)
  const appTheme = async () => page.evaluate(() => document.documentElement.dataset.theme ?? null)
  assert.equal(await appTheme(), 'light')
  const appWidth = await page.evaluate(() => ({ thread: document.querySelector('[data-testid="thread"]')!.clientWidth, group: document.querySelector('[data-testid="thread"] > section.turn-group')!.getBoundingClientRect().width }))
  results.app_thread_width = appWidth
  await foldAll(page)
  await settle(page)
  await page.screenshot({ path: join(OUT, 'compare', 'context-app-light.png') })
  const appLight = await captureRuns(page, 'app-light')
  const appCssLight = await cssOf(page)
  const appActionsLight = await captureActions(page, 'app-light')
  await page.setViewportSize(APP_VIEWPORT)
  await page.evaluate(() => localStorage.setItem('oasis-code.theme', 'dark'))
  await openSession()
  assert.equal(await appTheme(), 'dark')
  await foldAll(page)
  await settle(page)
  await page.screenshot({ path: join(OUT, 'compare', 'context-app-dark.png') })
  const appDark = await captureRuns(page, 'app-dark')
  const appCssDark = await cssOf(page)
  const appActionsDark = await captureActions(page, 'app-dark')
  await page.setViewportSize(APP_VIEWPORT)
  // the app draws each action as its line (a direct child of the thread's column), never as a turn
  assert.equal(appActionsLight.length, 4, 'the four actions are lines of the app\'s thread')
  ;(globalThis as { __appCaptures?: unknown }).__appCaptures = { appLight, appDark, appCssLight, appCssDark, appWidth, appActionsLight, appActionsDark }

  // ---- the default file (the app dark): preview srcdoc, data-bytes / data-sha256 and the downloaded bytes are the same
  await open.click()
  await page.locator('[data-testid="share-task"]').waitFor()
  assert.equal(await page.isChecked('[data-testid="share-task"]'), false, 'every session of the task: off by default')
  const dflt = await saveReady(page, FILES.dflt)
  results.default_download = { file: FILES.dflt, suggested_filename: dflt.suggested, dialog_bytes: dflt.bytes, dialog_sha256: dflt.sha256 }
  assert.match(dflt.srcdoc, /<html lang="en" data-theme="dark">/, 'the file opens in the palette the app shows')
  // the filename: from the cleaned title — no invisible character, no path, no token
  assert.match(dflt.suggested, /\.html$/)
  assert.ok(!/[\u200b/\\]|\.\.|e2e-token|synthuser|<|>/.test(dflt.suggested), `file name ${JSON.stringify(dflt.suggested)}`)
  // the preview runs its viewer in an opaque origin (sandbox allow-scripts only), sees no hostile markup run, fetched
  // nothing, and holds no control that would act
  assert.equal(await page.locator('[data-testid="share-preview"]').getAttribute('sandbox'), 'allow-scripts')
  let frame = await previewFrame(page)
  const pv = await frame.evaluate(() => ({
    origin: self.origin, xss: (window as unknown as { __xss?: unknown }).__xss ?? null, theme: document.documentElement.dataset.theme,
    executable: Array.from(document.scripts).filter((s) => s.type !== 'application/json').length, iframes: document.querySelectorAll('iframe,object,embed').length,
    fields: document.querySelectorAll('input,textarea,select,form,[contenteditable]').length, anchors: document.querySelectorAll('a[href]').length,
    runs: document.querySelectorAll('[data-testid="thread"] > section[data-testid^="run-"]').length,
    actions: document.querySelectorAll('[data-testid="thread"] > [data-testid^="action-"]').length,
  }))
  assert.deepEqual(pv, { origin: 'null', xss: null, theme: 'dark', executable: 1, iframes: 0, fields: 0, anchors: 0, runs: appLight.length, actions: 4 })
  await page.locator('[data-testid="share-dialog"]').screenshot({ path: join(OUT, 'app-dialog-default.png') })

  // ---- images on, tools still off, the same runs: the second size figure isolates the images option
  await page.click('[data-testid="share-images"]')
  assert.equal(await page.isChecked('[data-testid="share-tools"]'), false)
  // the file of THESE options: its own data block says images on, tools off (a bot still alone would be a data: image too)
  await page.waitForFunction(() => {
    if (document.querySelector('[data-testid="share-dialog"]')?.getAttribute('data-phase') !== 'ready') return false
    const src = document.querySelector('[data-testid="share-preview"]')?.getAttribute('srcdoc') ?? ''
    const m = /<script type="application\/json" id="share-data">([\s\S]*?)<\/script>/.exec(src)
    try { const o = JSON.parse(m?.[1] ?? 'null')?.snapshot?.options; return o?.include_images === true && o?.include_tool_details === false } catch { return false }
  }, undefined, { timeout: 60_000 })
  const imgs = await saveReady(page, FILES.images)
  assert.ok(imgs.srcdoc.includes(EXCLUDED), 'the same runs as the default file')
  assert.ok(!imgs.srcdoc.includes(F.needle), 'tools still off')
  results.images_download = { file: FILES.images, options: { tools: false, images: true, excluded_runs: 0 }, suggested_filename: imgs.suggested, dialog_bytes: imgs.bytes, dialog_sha256: imgs.sha256 }
  frame = await previewFrame(page)
  const previewImages = await decodeAll(frame)
  results.preview_images = previewImages
  assert.ok(previewImages.length >= 3 && previewImages.every((i) => i.decoded && i.w > 0 && i.h > 0 && i.data), JSON.stringify(previewImages))
  await page.locator('[data-testid="share-dialog"]').screenshot({ path: join(OUT, 'app-dialog-images.png') })
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => !document.querySelector('[data-testid="share-dialog"]'))

  // ---- back to light through the app's own choice; the next file opens light
  await page.evaluate(() => localStorage.setItem('oasis-code.theme', 'light'))
  await openSession()
  assert.equal(await appTheme(), 'light')
  await open.click()
  await ready(page)
  // rapid option changes: only the last generation lands (tools + images on)
  for (let i = 0; i < 3; i++) { await page.click('[data-testid="share-tools"]'); await page.click('[data-testid="share-images"]') }
  assert.equal(await page.locator('[data-testid="share-download"]').isDisabled(), true, 'download waits for the new file')
  assert.equal(await page.isChecked('[data-testid="share-tools"]'), true)
  assert.equal(await page.isChecked('[data-testid="share-images"]'), true)
  let full = await ready(page)
  assert.ok(full.srcdoc.includes(F.needle), 'the details of the final options are in the preview')
  assert.ok(/data:image\/(webp|png|jpeg);base64,/.test(full.srcdoc), 'the images of the final options are in the preview')
  assert.ok(full.srcdoc.includes(EXCLUDED), 'every run is in until one is left out')
  assert.equal(await page.locator('[data-testid="share-images-cue"]').count(), 1)

  // leave a run out: the preview is rebuilt without it
  const sel = await api<{ selection: { runs: { run_id: string }[] } }>(`/api/sessions/${ids.session}/share-snapshot`, {})
  const at = sel.selection.runs.findIndex((r) => r.run_id === ids.excluded)
  assert.ok(at >= 0)
  await page.click('[data-testid="share-runs"] summary')
  await page.locator('[data-testid="share-run"]').nth(at).click()
  await page.waitForFunction((x) => !(document.querySelector('[data-testid="share-preview"]')?.getAttribute('srcdoc') ?? x).includes(x) && document.querySelector('[data-testid="share-dialog"]')?.getAttribute('data-phase') === 'ready', EXCLUDED, { timeout: 60_000 })
  full = await ready(page)
  assert.ok(!full.srcdoc.includes(EXCLUDED))
  assert.ok(full.srcdoc.includes('RESUMED_ANSWER_MARK'))
  assert.equal(full.srcdoc.split(F.answer_mark).length - 1, 1, 'the main answer once (the resumed run does not repeat it)')
  assert.match(full.srcdoc, /<html lang="en" data-theme="light">/)
  const countsEl = page.locator('[data-testid="share-counts"]')
  results.dialog_counts = { redacted: Number(await countsEl.getAttribute('data-redacted')), omitted: Number(await countsEl.getAttribute('data-omitted')), text: await countsEl.innerText(), lines: await countsEl.getAttribute('title') }
  await page.click('[data-testid="share-runs"] summary')
  frame = await previewFrame(page)
  assert.equal(await frame.locator('[data-testid="thread"] > section[data-testid^="run-"]').count(), appLight.length - 1, 'one run fewer')
  await page.locator('[data-testid="share-dialog"]').screenshot({ path: join(OUT, 'app-dialog-details-images.png') })
  const d2 = await saveReady(page, FILES.full)
  results.full_download = { file: FILES.full, options: { tools: true, images: true, excluded_runs: 1 }, suggested_filename: d2.suggested, dialog_bytes: d2.bytes, dialog_sha256: d2.sha256 }

  // busy while the dialog is open: a held run starts, an option change answers 409 → busy with Retry; idle → Retry builds
  const held2 = await chat('STEER_CASE_TEXT share busy two', 'scripted:steer')
  await page.waitForFunction(() => document.querySelector('[data-testid="share-open"]')?.getAttribute('data-busy') === 'true', undefined, { timeout: 15_000 })
  await page.click('[data-testid="share-tools"]')
  await page.waitForSelector('[data-testid="share-dialog"][data-phase="busy"] [data-testid="share-retry"]', { timeout: 30_000 })
  assert.equal(await page.locator('[data-testid="share-download"]').isDisabled(), true)
  await page.locator('[data-testid="share-dialog"]').screenshot({ path: join(OUT, 'app-dialog-busy.png') })
  await release('steer')
  await runEnds(held2)
  await idle()
  await page.click('[data-testid="share-retry"]')
  const retried = await ready(page)
  assert.ok(!retried.srcdoc.includes(F.needle), 'the retried file has the current options (tools off)')

  // another session while the dialog is open (a programmatic switch: the modal makes the rail inert to the pointer)
  await page.evaluate((id) => (document.querySelector(`[data-testid="session-${id}"]`) as HTMLElement).click(), ids.other)
  await page.waitForFunction(() => !document.querySelector('[data-testid="share-dialog"]'), undefined, { timeout: 10_000 })
  await page.click(`[data-testid="session-${ids.session}"]`)
  await page.locator('[data-testid="share-open"]').waitFor()
  await page.waitForTimeout(800)
  assert.equal(await page.locator('[data-testid="share-dialog"]').count(), 0, 'coming back does not reopen the old dialog')
  // close: gone, and a new opening starts again from the defaults
  await page.click('[data-testid="share-open"]')
  await ready(page)
  await page.click('[data-testid="share-close"]')
  await page.waitForFunction(() => !document.querySelector('[data-testid="share-dialog"]'))
  await page.click('[data-testid="share-open"]')
  await ready(page)
  assert.equal(await page.isChecked('[data-testid="share-tools"]'), false)
  assert.equal(await page.isChecked('[data-testid="share-images"]'), false)
  assert.equal(await page.isChecked('[data-testid="share-task"]'), false)
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => !document.querySelector('[data-testid="share-dialog"]'))

  results.app = { page_errors: errors, console_errors: consoleErrors, preview_frame_requests: previewRequests }
  // the app's context closed, then ONLY this test's backend stopped (awaited) — before the assertions, so the file://
  // test runs on a stopped backend whatever they say
  await context.close()
  results.backend_exit_code = await stopServer()
  results.backend_port_free_after_stop = await portFree(PORT)
  assert.deepEqual(errors, [])
  assert.deepEqual(consoleErrors.filter((c) => /Content Security Policy|Refused to/i.test(c.text) || c.url.startsWith('about:srcdoc')), [], 'no CSP violation or error in the preview')
  assert.deepEqual(previewRequests, [], 'the preview asked for nothing')
  assert.equal(results.backend_port_free_after_stop, true)
})

test('the saved files: canaries absent, pictures re-encoded, exact hash CSP, no external reference, sizes', () => {
  const sources = (results.source_image_sha256 as string[] | undefined) ?? []
  const scans = [FILES.dflt, FILES.images, FILES.full].map((f) => scan(f, readFileSync(join(OUT, f)), sources))
  results.scan = scans
  writeFileSync(join(OUT, 'session-share-scan.json'), JSON.stringify(scans, null, 2))
  for (const s of scans) {
    assert.equal(s.secrets_found_total, 0, `${s.file}: a canary is in the file ${JSON.stringify(s.secrets)}`)
    const h = s.harness_ids as Record<string, number>
    assert.deepEqual(h, { run_ids: 0, session_id: 0, asset_ids: 0, data_dir: 0, repo_path: 0, tmp_root: 0 }, `${s.file}`)
    assert.equal(s.script_elements, 2, 'the data block and the viewer'); assert.equal(s.executable_scripts, 1); assert.equal(s.style_elements, 1)
    assert.equal(s.external_script_src, 0); assert.equal(s.link_tags, 0); assert.equal(s.iframe_object_embed_tags, 0); assert.equal(s.event_handler_attrs, 0)
    assert.equal(s.url_attributes_in_markup, 0); assert.equal(s.css_urls_not_woff2_data, 0); assert.equal(s.css_import, 0)
    assert.deepEqual(s.css_font_formats, ['woff2'], 'only woff2 faces are embedded')
    assert.equal(s.script_end_or_comment_in_js, false); assert.equal(s.style_end_in_css, false); assert.equal(s.data_block_raw_lt_gt_amp, false)
    assert.equal(s.snapshot_images_carried, 0, 'no source image bytes')
    assert.equal(s.csp, s.csp_expected, 'the CSP is exactly the hash-only policy of this script and stylesheet')
    assert.doesNotMatch(String(s.csp), /unsafe-inline|unsafe-eval|https?:|\*/)
    const p = s.present as Record<string, number>
    assert.ok(p.chinese_prose >= 1 && p.calc_py >= 1 && p.resumed_answer === 1)
    assert.equal(p.main_answer_mark, 1)
  }
  const [dflt, images, full] = scans as { pictures: { equals_a_source_image: boolean; metadata_chunks: boolean; signature_ok: boolean }[]; present: Record<string, number> & { needle_paths: string[] }; theme: string; sizes: Record<string, number> }[]
  // the default file: every run in, no pictures, no tool details
  assert.equal(dflt!.theme, 'dark'); assert.equal(images!.theme, 'dark'); assert.equal(full!.theme, 'light')
  assert.equal(dflt!.pictures.length, 0, 'images are off by default')
  assert.equal(dflt!.present.needle_anywhere, 0, 'the needle exists only in a tool output preview (never in a command target)')
  assert.ok(dflt!.present.excluded_run_words >= 1, 'the default file carries every run, the one left out later included')
  // images on, tools off: the same runs and items as the default file (only the images option differs)
  const sel = scans as unknown as { options: Record<string, boolean>; run_keys: string[]; item_keys: string[] }[]
  assert.deepEqual(sel[0]!.options, { include_tool_details: false, include_images: false })
  assert.deepEqual(sel[1]!.options, { include_tool_details: false, include_images: true })
  assert.deepEqual(sel[2]!.options, { include_tool_details: true, include_images: true })
  assert.deepEqual(sel[1]!.run_keys, sel[0]!.run_keys, 'the same runs')
  assert.deepEqual(sel[1]!.item_keys, sel[0]!.item_keys, 'the same items, in the same order')
  assert.equal(sel[2]!.run_keys.length, sel[0]!.run_keys.length - 1, 'the third file: one run left out')
  assert.ok(images!.pictures.length >= 3)
  assert.equal(images!.present.needle_anywhere, 0)
  assert.ok(images!.present.excluded_run_words >= 1)
  // the final file: images + details, that run left out; the needle only in a tool's preview
  assert.ok(full!.pictures.length >= 3, 'the three session images are carried')
  for (const i of [...images!.pictures, ...full!.pictures]) { assert.ok(i.signature_ok); assert.equal(i.equals_a_source_image, false); assert.equal(i.metadata_chunks, false) }
  assert.ok(full!.present.needle_paths.length >= 1, 'the needle is in a tool output preview')
  assert.deepEqual(full!.present.needle_paths.filter((p) => !/^\$\.snapshot\.items\[\d+\]\.details\.preview$/.test(p)), [], 'and nowhere else')
  assert.equal(full!.present.excluded_run_words, 0, 'the run left out is absent')
  results.sizes = { default: dflt!.sizes, images_on_tools_off_same_runs: images!.sizes, tools_images_one_run_out: full!.sizes, images_option_adds: images!.sizes.total - dflt!.sizes.total }
})

test('the saved files: each action an item of its own — its whole command by default, its output preview with details only, a sensitive source nothing', () => {
  type ActionItem = { kind: 'action'; key: string; run: string; action: string; actor: string; what: string; by: string | null; head: string | null; outcome: string | null; text: string | null; details: { fields: { name: string; value: unknown }[]; preview: string | null } | null; withheld: string | null }
  type Snap = { version: number; runs: { key: string; request: string }[]; items: ({ kind: string; key: string; run: string | null; code?: string } & Partial<Omit<ActionItem, 'kind' | 'key' | 'run'>>)[] }
  const out: Record<string, unknown> = {}
  for (const file of [FILES.dflt, FILES.images, FILES.full]) {
    const html = readFileSync(join(OUT, file), 'utf8')
    const rawDoc = JSON.parse(partsOf(html).data) as { version: number; snapshot: { version: number; scope: string; sessions: unknown[] } }
    const doc = legacyView(rawDoc) as unknown as { snapshot: Snap; faces: Record<string, unknown>; bots: Record<string, string> }
    const s = doc.snapshot
    // the dialog writes the latest page (v3) of the latest snapshot (V3), one session: the legacy reading below is of it
    assert.deepEqual([rawDoc.version, rawDoc.snapshot.version, rawDoc.snapshot.scope, rawDoc.snapshot.sessions.length], [PAGE_VERSION_NOW, 3, 'session', 1], `${file}: the latest page and snapshot, one session`)
    const actionRuns = new Set(s.runs.filter((r) => r.request === 'action').map((r) => r.key))
    const actions = s.items.filter((i) => i.kind === 'action') as unknown as ActionItem[]
    assert.equal(actions.length, 4, `${file}: four actions`)
    assert.deepEqual(actions.map((a) => actionRuns.has(a.run)), [true, true, true, true], 'each of its own action run')
    // nothing else of an action's run: no turn, no "recorded action" notice, no face
    assert.deepEqual(s.items.filter((i) => i.kind !== 'action' && i.run !== null && actionRuns.has(i.run)).map((i) => i.key), [], `${file}: no other item of an action run`)
    assert.equal(s.items.filter((i) => i.kind === 'notice' && i.code === 'recorded_action').length, 0)
    assert.deepEqual(Object.keys(doc.faces).filter((k) => actionRuns.has(k)), [], `${file}: an action run wears no face`)
    assert.ok(doc.bots.chatgpt, `${file}: ChatGPT's mark is carried for its actions`)
    const [benign, dotfiles, envDump, checkpoint] = actions
    const tools = file === FILES.full
    assert.deepEqual([benign!.action, benign!.actor, benign!.what, benign!.by, benign!.outcome, benign!.withheld], ['command', 'connector', 'command', 'ChatGPT', '→ exit 0', null])
    assert.equal(benign!.head, "$ printf 'step %s\\n' 1 2 3 …")
    assert.ok(benign!.text!.includes(A.mark) && benign!.text!.startsWith('$ printf') && benign!.text!.endsWith('→ exit 0'), `${file}: the whole command by default`)
    assert.ok(!benign!.text!.includes(A.bearer), `${file}: the bearer header redacted`)
    if (tools) {
      assert.ok(benign!.details && benign!.details.preview!.includes('step 1') && benign!.details.preview!.includes(A.mark), `${file}: the output preview with details`)
      assert.ok(!benign!.details!.preview!.includes(A.bearer))
      assert.ok(benign!.details!.preview!.length <= 2000 + 200)
      assert.ok(benign!.details!.fields.some((f) => f.name === 'exit_code' && f.value === 0))
    } else assert.equal(benign!.details, null, `${file}: no output without tool details`)
    for (const a of [dotfiles!, envDump!]) assert.deepEqual([a.by, a.head, a.text, a.details, a.withheld, a.outcome], ['ChatGPT', null, null, null, 'sensitive_source', '→ exit 0'], `${file}: a sensitive source withheld whole`)
    assert.deepEqual([checkpoint!.action, checkpoint!.actor, checkpoint!.by, checkpoint!.what, checkpoint!.details], ['checkpoint', 'person', null, 'checkpoint', null])
    assert.ok(checkpoint!.text!.includes(A.checkpoint_note) && !/\bcp_[A-Za-z0-9]/.test(checkpoint!.text!), `${file}: the checkpoint's id masked`)
    for (const v of [A.bearer, A.dotenv, A.auth, A.env]) assert.ok(!html.includes(v), `${file}: no action canary`)
    // nothing of the executions' own ids
    assert.ok(!/\bx_[0-9a-f]{8,}/.test(partsOf(html).data), `${file}: no execution id`)
    out[file] = actions.map((a) => ({ key: a.key, action: a.action, by: a.by, head: a.head, outcome: a.outcome, withheld: a.withheld, text_chars: a.text?.length ?? null, details: a.details ? { fields: a.details.fields.map((f) => f.name), preview_chars: a.details.preview?.length ?? 0 } : null }))
  }
  results.action_items = out
})

/** Open a saved file over file:// in a fresh context: every non-file request recorded and refused, CSP violations
 *  recorded from the first script on. */
async function openFile(file: string, opts: { offline: boolean; viewport: { width: number; height: number }; keepTeams?: boolean }): Promise<{ context: BrowserContext; page: Page; attempted: string[]; errors: string[]; consoleMsgs: string[] }> {
  const context = await browser.newContext({ offline: opts.offline, serviceWorkers: 'block', viewport: opts.viewport, javaScriptEnabled: true })
  await context.addInitScript(() => {
    const w = window as unknown as { __cspv: string[] }
    w.__cspv = []
    document.addEventListener('securitypolicyviolation', (e) => w.__cspv.push(`${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}`))
  })
  const attempted: string[] = []
  await context.route((url) => url.protocol !== 'file:', async (route) => { attempted.push(route.request().url().slice(0, 100)); await route.abort('blockedbyclient') })
  context.on('request', (r) => { if (!r.url().startsWith('file:') && !attempted.includes(r.url().slice(0, 100))) attempted.push(r.url().slice(0, 100)) })
  const page = await context.newPage()
  const errors: string[] = []
  const consoleMsgs: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => consoleMsgs.push(`${m.type()}: ${m.text().slice(0, 200)}`))
  await page.goto(pathToFileURL(join(OUT, file)).href)
  await page.waitForSelector('[data-testid="share-thread"]')
  // the Agent Teams card (a page v3) stands over the thread's corner: folded to its title bar, so the legacy captures
  // and clicks of the thread are of the thread alone (its own scenarios keep it open)
  if (!opts.keepTeams) {
    const dock = page.locator('[data-testid="graph-dock"]:not(.collapsed)')
    if (await dock.count()) await dock.locator('[data-testid="card-shelve"]').click()
  }
  return { context, page, attempted, errors, consoleMsgs }
}

/** The file's DOM, read: what could act, what could load, what ran. */
async function domFacts(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate((secrets) => {
    const html = document.documentElement.outerHTML
    const text = document.body.innerText
    const named = (b: Element) => { const t = b.getAttribute('data-testid') ?? ''; return t.startsWith('share-theme-') || t === 'card-shelve' || t === 'card-expand' || t.startsWith('share-session-') }
    const buttons = Array.from(document.querySelectorAll('button')).map((b) => (named(b) ? `testid:${b.getAttribute('data-testid')!.replace(/^share-session-s\d+$/, 'share-session-*')}` : b.className.split(' ').filter((c) => c && c !== 'open').sort().join('.') || 'unnamed'))
    return {
      xss: (window as unknown as { __xss?: unknown }).__xss ?? null, cspv: (window as unknown as { __cspv?: string[] }).__cspv ?? null,
      executable: Array.from(document.scripts).filter((s) => s.type !== 'application/json').length, frames: document.querySelectorAll('iframe,object,embed,frame').length,
      handlers: Array.from(document.querySelectorAll('*')).filter((e) => Array.from(e.attributes).some((a) => /^on/i.test(a.name))).length,
      fields: document.querySelectorAll('input,textarea,select,form,[contenteditable]').length, draggable: document.querySelectorAll('[draggable="true"]').length,
      anchors: document.querySelectorAll('a[href]').length, imgs_not_data: Array.from(document.images).filter((i) => !i.getAttribute('src')?.startsWith('data:image/')).length,
      button_kinds: [...new Set(buttons)].sort(),
      mutation_testids: ['composer', 'send', 'stop', 'replay', 'share-open', 'undo-run', 'steer-put-back', 'failure-accounts', 'failure-chatgpt', 'copy-text', 'code-copy', 'interaction-continue', 'review-approvals', 'opened-session', 'relay-continue', 'node-adopt']
        .filter((t) => document.querySelector(`[data-testid="${t}"]`)).concat(document.querySelectorAll('[data-testid^="records-"]').length ? ['records-*'] : []),
      // the rail of the app (a task's share draws its own list of sessions: share-sessions) and the desk's cards other
      // than the share's one read-only Agent Teams card (the page's layout wears the desk's class: it is no card)
      rail: document.querySelectorAll('.sidebar:not([data-testid="share-sessions"]),.rail,[data-testid^="session-"]').length,
      desk: document.querySelectorAll('.desk-card,[data-testid="desk"],.desk-win:not([data-testid="graph-dock"])').length,
      teams_cards: document.querySelectorAll('[data-testid="graph-dock"]').length,
      share_sessions: document.querySelectorAll('[data-testid="share-sessions"] button.rail-session').length,
      resize_handles: document.querySelectorAll('[data-testid="graph-dock"] [class*="resize"]').length,
      hostileShownAsText: text.includes('window.__xss'),
      secretsInDom: Object.entries(secrets).filter(([, v]) => html.includes(v) || text.includes(v)).map(([k]) => k),
      inert_links: document.querySelectorAll('[data-testid="link-inert"]').length, prose_img_inert: document.querySelectorAll('[data-testid="prose-img-inert"]').length,
      fonts: Array.from(document.fonts).map((f) => `${f.family}:${f.status}`).filter((s) => s.includes('KaTeX')),
    }
  }, { ...SECRETS })
}

test('file:// with the backend stopped: the same thread as the app (light/dark), folds, details, images, nothing fetched', async () => {
  assert.equal(server, null, 'the backend is stopped')
  const caps = (globalThis as { __appCaptures?: { appLight: RunCapture[]; appDark: RunCapture[]; appCssLight: Record<string, unknown>; appCssDark: Record<string, unknown>; appWidth: { thread: number; group: number }; appActionsLight: ActionCapture[]; appActionsDark: ActionCapture[] } }).__appCaptures
  assert.ok(caps, 'the app was captured')
  // ---- the comparison: the file made with images on (tools off, every run — the same runs as the app showed), at the
  // app's thread width (the file's thread fills the page: the viewport is set so its scroller is as wide as the app's)
  const cmp = await openFile(FILES.images, { offline: true, viewport: APP_VIEWPORT })
  const { page } = cmp
  const chrome = await page.evaluate(() => window.innerWidth - document.querySelector('[data-testid="thread"]')!.clientWidth)
  await page.setViewportSize({ width: caps.appWidth.thread + chrome, height: APP_VIEWPORT.height })
  const fileWidth = await page.evaluate(() => ({ thread: document.querySelector('[data-testid="thread"]')!.clientWidth, group: document.querySelector('[data-testid="thread"] > section.turn-group')!.getBoundingClientRect().width }))
  assert.deepEqual(fileWidth, caps.appWidth, 'the same effective thread content width')
  const viewportWidth = caps.appWidth.thread + chrome
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark', 'the file opens in the palette the app showed')
  // dark first (as it opened), then light by the page's own palette choice
  await foldAll(page)
  await page.setViewportSize({ width: viewportWidth, height: APP_VIEWPORT.height })
  await stable(page)
  await page.screenshot({ path: join(OUT, 'compare', 'context-file-dark.png') })
  const fileDark = await captureRuns(page, 'file-dark')
  const fileCssDark = await cssOf(page)
  const fileActionsDark = await captureActions(page, 'file-dark')
  await page.click('[data-testid="share-theme-light"]')
  await stable(page)
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light')
  await page.setViewportSize({ width: viewportWidth, height: APP_VIEWPORT.height })
  await foldAll(page)
  await stable(page)
  await page.screenshot({ path: join(OUT, 'compare', 'context-file-light.png') })
  const fileLight = await captureRuns(page, 'file-light')
  const fileCssLight = await cssOf(page)
  const fileActionsLight = await captureActions(page, 'file-light')
  await sideBySideActions(caps.appActionsLight, fileActionsLight, 'Light — the same actions: live app thread (left) vs exported file (right), folded then opened', join(OUT, 'compare', 'side-by-side-actions-light.png'), false)
  await sideBySideActions(caps.appActionsDark, fileActionsDark, 'Dark — the same actions: live app thread (left) vs exported file (right), folded then opened', join(OUT, 'compare', 'side-by-side-actions-dark.png'), true)
  const actionsCompared = { light: compareActions(caps.appActionsLight, fileActionsLight), dark: compareActions(caps.appActionsDark, fileActionsDark) }
  results.action_comparison = actionsCompared
  writeFileSync(join(OUT, 'compare', 'actions-comparison.json'), JSON.stringify(actionsCompared, null, 2))
  for (const [theme, app, file] of [['light', caps.appActionsLight, fileActionsLight], ['dark', caps.appActionsDark, fileActionsDark]] as const) {
    const pairs = (actionsCompared[theme].pairs as { line: number; place: number[]; height: number[]; outcome: (string | null)[]; classes_only_app: string[]; classes_only_file: string[]; css_differences: unknown[] }[])
    for (const p of pairs) {
      assert.equal(p.place[0], p.place[1], `${theme} action ${p.line}: where the app puts it among the turns`)
      assert.ok(Math.abs(p.height[0]! - p.height[1]!) < 0.5, `${theme} action ${p.line}: the folded line as tall as the app's (${p.height.join(' / ')})`)
      assert.equal(p.outcome[0], p.outcome[1], `${theme} action ${p.line}: the same outcome`)
      assert.deepEqual(p.css_differences, [], `${theme} action ${p.line}: the same computed CSS`)
      assert.deepEqual(p.classes_only_app, [], `${theme} action ${p.line}: no class of the app's line missing`)
    }
    const [benign, dotfiles, envDump, checkpoint] = [0, 1, 2, 3].map((i) => [app[i]!, file[i]!] as const)
    // ChatGPT's benign command: the same line; opened, its whole text — in the file with the bearer header redacted
    assert.deepEqual([benign[1].who, benign[1].head, benign[1].missing], [benign[0].who, benign[0].head, null])
    assert.equal(benign[1].who, 'ChatGPT')
    assert.match(benign[1].head, /^\$ printf 'step %s\\n' 1 2 3 …$/)
    assert.ok(benign[0].full!.includes(A.bearer) && !benign[1].full!.includes(A.bearer), `${theme}: the bearer header redacted in the file's text only`)
    assert.ok(benign[1].full!.includes(A.mark) && benign[1].full!.split('\n').length === benign[0].full!.split('\n').length, `${theme}: the whole command, line for line`)
    assert.deepEqual(file.map((f) => f.details), [false, false, false, false], 'the comparison file has no tool details')
    // the sensitive sources: who and the exit kept; the command withheld, said so
    for (const [a, f] of [dotfiles, envDump]) {
      assert.deepEqual([f.who, f.head, f.missing, f.outcome], [a.who, 'withheld (sensitive source)', 'withheld', a.outcome])
      // the app's line opens to its command; the file's to no command text at all, only the fixed generic explanation
      assert.ok(a.full !== null && a.why === null, `${theme}: the app's line opens to its command`)
      assert.equal(f.full, null, `${theme}: no command text in the file's opened line`)
      assert.equal(f.why, WITHHELD_WHY, `${theme}: the file says why, in the fixed words`)
      assert.equal(f.details, false, `${theme}: no measures or output preview for a withheld action`)
      for (const v of [A.dotenv, A.auth, A.env, 'SYNTH_ACTION', '.action-synthetic', 'printenv']) assert.ok(!f.text.includes(v), `${theme}: the file's opened line holds nothing of the command or its output (${v.slice(0, 12)}…)`)
      for (const l of a.full!.split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('→'))) assert.ok(!f.text.includes(l), `${theme}: no line of the app's command in the file's opened line`)
      assert.deepEqual(f.classes.filter((c) => !a.classes.includes(c)), ['dim'], 'the withheld line says why in the app\'s own fold')
    }
    // the person's checkpoint: "you" in the app, "Person" in the file; its id masked in the file
    assert.deepEqual([checkpoint[0].who, checkpoint[1].who], ['you', 'Person'])
    assert.equal(checkpoint[1].head, checkpoint[0].head.replace(/\bcp_[A-Za-z0-9_-]+/g, '[id]'))
    assert.ok(checkpoint[1].head.includes(A.checkpoint_note))
  }
  await sideBySide(caps.appLight, fileLight, 'Light — same session: live app thread (left) vs exported file (right), every round folded', join(OUT, 'compare', 'side-by-side-light.png'), false)
  await sideBySide(caps.appDark, fileDark, 'Dark — same session: live app thread (left) vs exported file (right), every round folded', join(OUT, 'compare', 'side-by-side-dark.png'), true)
  const light = compare(caps.appLight, fileLight, caps.appCssLight, fileCssLight)
  const dark = compare(caps.appDark, fileDark, caps.appCssDark, fileCssDark)
  results.comparison = { width: { app: caps.appWidth, file: fileWidth, file_viewport: viewportWidth }, light, dark }
  writeFileSync(join(OUT, 'compare', 'comparison.json'), JSON.stringify(results.comparison, null, 2))
  // the same turns in the same order, none twice; the same words where nothing was redacted
  for (const c of [light, dark]) {
    const pairs = c.pairs as { run: number; width: number[]; answers_equal: boolean; answers_app: string[]; answers_file: string[]; status: (string | null)[] }[]
    assert.deepEqual((c.runs as number[])[0], (c.runs as number[])[1], 'as many run turns')
    for (const p of pairs) {
      assert.equal(p.width[0], p.width[1], `run ${p.run}: the same width`)
      assert.equal(p.status[0], p.status[1], `run ${p.run}: the same status`)
    }
    // the main run's answer carries an e-mail and a home path (redacted); every other answer is the same text
    const unequal = pairs.filter((p) => !p.answers_equal).map((p) => p.run)
    assert.deepEqual(unequal, [1], `answers that differ: ${JSON.stringify(pairs.filter((p) => !p.answers_equal).map((p) => [p.answers_app, p.answers_file]))}`)
    const css = c.css_differences as { probe: string; prop?: string }[]
    assert.deepEqual(css, [], `computed CSS differs: ${JSON.stringify(css)}`)
  }
  // the vertical geometry of every ordinary turn is the app's, part by part: the words, their (empty) action strip,
  // the folded rounds, the answers, the footer — only the controls inside the strip and the footer differ. Two turns
  // differ for a stated reason, recorded: the main run (its words and answer redacted; the answer's web image is inert
  // text in the file, a picture the app tries to load) and the computer-use run (the app's live screen window is not
  // drawn: the snapshot keeps no page address or title, its pictures stand under the rows).
  const CONTROLS = /^(button\.turn-action|span\.turn-action\.share-action-space|span\.ref-buttons|span\.turn-tokens)$/
  const geometry = (l: { cls: string; top: number; height: number }[]) => l.filter((x) => !CONTROLS.test(x.cls))
  const reasons: Record<string, string> = {}
  for (const [theme, c] of [['light', light], ['dark', dark]] as const) {
    const pairs = c.pairs as { run: number; file_testid: string; height: number[]; answers_app: string[]; layout_app: { cls: string; top: number; height: number }[]; layout_file: { cls: string; top: number; height: number }[] }[]
    for (const p of pairs) {
      const words = p.answers_app.join(' ')
      if (words.includes(F.answer_mark)) { reasons[`${theme} ${p.file_testid}`] = `main run: redacted words, inert web image (height ${p.height.join(' / ')})`; continue }
      if (words.includes('SCREEN_DONE')) { reasons[`${theme} ${p.file_testid}`] = `computer use: the app's screen window not drawn (height ${p.height.join(' / ')})`; continue }
      assert.ok(Math.abs(p.height[0]! - p.height[1]!) < 0.5, `${theme} ${p.file_testid}: the turn is as tall as the app's (${p.height.join(' / ')})`)
      assert.deepEqual(geometry(p.layout_file), geometry(p.layout_app), `${theme} ${p.file_testid}: every part where the app puts it`)
    }
  }
  assert.equal(Object.keys(reasons).length, 4, JSON.stringify(reasons))
  ;(results.comparison as Record<string, unknown>).different_for_a_reason = reasons
  // math typeset by the same KaTeX in the file (the app's own test: two displays, four formulas, no error)
  const mathRun = page.locator('[data-testid="thread"] > section[data-testid^="run-"]').nth(1)
  assert.equal(await mathRun.locator('.turn-agent .prose .katex-display').count(), 2)
  assert.equal(await mathRun.locator('.turn-agent .prose .katex').count(), 4)
  assert.equal(await mathRun.locator('.katex-error').count(), 0)
  // the links run: the refused links are words in both; the web link is a chip that opens nothing in the file
  const linksRun = page.locator('[data-testid="thread"] > section[data-testid^="run-"]').nth(2)
  const inert = await linksRun.locator('[data-testid="link-inert"]').allInnerTexts()
  assert.deepEqual(inert.slice(0, 4), ['JS sentinel', 'Data sentinel', 'File sentinel', 'relative'])
  assert.match(inert[4] ?? '', /example\.com/, 'the web link: its chip (letter mark and host), opening nothing')
  assert.equal(await linksRun.locator('a[href]').count(), 0)
  // KaTeX's embedded faces load (data: woff2) once the math is shown
  await page.evaluate(() => document.fonts.ready)
  // folds work locally: open the first round, its rows show, fold it again
  const head = page.locator('[data-testid="thread"] .work > .work-head').first()
  await head.click()
  assert.equal(await page.locator('[data-testid="thread"] .work.open .activity.row').count() > 0, true)
  await head.click()
  assert.equal(await page.locator('[data-testid="thread"] .work.open').count(), 0)
  // every round and every row opened: tools were off, so a call says so (or that its content was withheld)
  await openAll(page)
  const rowLines = page.locator('[data-testid="thread"] .activity.row .activity-line.expandable')
  for (let i = 0; i < await rowLines.count(); i++) await rowLines.nth(i).click()
  const calls = await page.evaluate(() => ({ detail: document.querySelectorAll('[data-testid="call-detail"]').length, none: document.querySelectorAll('[data-testid="call-no-details"]').length, withheld: document.querySelectorAll('[data-testid="call-withheld"]').length, previews: document.querySelectorAll('[data-testid="call-preview"]').length }))
  assert.ok(calls.detail >= 9 && calls.none >= 1 && calls.previews === 0 && calls.detail === calls.none + calls.withheld, JSON.stringify(calls))
  await page.screenshot({ path: join(OUT, 'file-images-light-rows-open.png') })
  // the session's own pictures — the upload, the generated image, the screenshot — each by its image key, where the
  // app draws it, decoded from the page's re-encoded data (the bot stills are not counted here)
  const sessionPictures = await page.evaluate(async () => {
    type Items = { items: { kind: string; key: string; origin?: string; image?: string | null }[] }
    const raw = JSON.parse(document.getElementById('share-data')!.textContent!) as { version: number; pictures: Record<string, unknown>; snapshot: Items & { current?: string; sessions?: (Items & { key: string })[] } }
    // a page v3: the current session's items and its own pictures; a page v2: the snapshot's
    const shown = raw.version === 3 ? raw.snapshot.sessions!.find((x) => x.key === raw.snapshot.current)! : null
    const doc = { pictures: (shown ? raw.pictures[shown.key] ?? {} : raw.pictures) as Record<string, { src: string }>, snapshot: shown ?? raw.snapshot }
    const out: { key: string; origin: string; shown: number; decoded: boolean; w: number; h: number; where: string[] }[] = []
    for (const item of doc.snapshot.items) {
      if (item.kind !== 'image' || !item.image || !doc.pictures[item.image]) continue
      const imgs = Array.from(document.images).filter((i) => i.getAttribute('src') === doc.pictures[item.image!]!.src && !i.classList.contains('bot-img'))
      let decoded = imgs.length > 0
      for (const i of imgs) { i.scrollIntoView({ block: 'center' }); decoded = decoded && await i.decode().then(() => true, () => false) }
      out.push({ key: item.image, origin: item.origin ?? '', shown: imgs.length, decoded, w: imgs[0]?.naturalWidth ?? 0, h: imgs[0]?.naturalHeight ?? 0,
        where: imgs.map((i) => (i.closest('.turn-images') ? 'turn-images' : i.closest('.generated-image') ? 'generated-image' : i.closest('[data-testid="activity-shot"]') ? 'activity-shot' : i.closest('.shown-images') ? 'shown-images' : 'elsewhere')) })
    }
    return out
  })
  const want: Record<string, string> = { attachment: 'turn-images', generated: 'generated-image', screenshot: 'activity-shot' }
  for (const origin of Object.keys(want)) {
    const of = sessionPictures.filter((p) => p.origin === origin)
    assert.ok(of.length >= 1, `a ${origin} picture is carried: ${JSON.stringify(sessionPictures)}`)
    for (const p of of) assert.ok(p.shown >= 1 && p.decoded && p.w > 0 && p.h > 0 && p.where.includes(want[origin]!), `${origin} ${JSON.stringify(p)}`)
  }
  // a generated picture opens whole in place (the app's own viewer), with no download, and closes
  await page.locator('[data-testid="generated-image"] .generated-image-open').first().click()
  const viewer = page.locator('[data-testid="media-viewer"]')
  await viewer.waitFor()
  assert.equal(await viewer.locator('[data-testid="media-viewer-download"]').count(), 0)
  assert.match((await viewer.locator('img').getAttribute('src')) ?? '', /^data:image\/(webp|png|jpeg);base64,/)
  assert.equal(await viewer.locator('img').evaluate((i) => (i as HTMLImageElement).decode().then(() => (i as HTMLImageElement).naturalWidth > 0, () => false)), true)
  await page.screenshot({ path: join(OUT, 'file-images-generated-open.png') })
  await viewer.locator('button.media-viewer-close').click()
  assert.equal(await viewer.count(), 0)
  // every picture of the page decodes from data: (session pictures, bot stills, icons)
  const images = await decodeAll(page)
  assert.ok(images.length >= 3 && images.every((i) => i.decoded && i.w > 0 && i.h > 0 && i.data), JSON.stringify(images))
  const facts = await domFacts(page)
  results.file_images_offline = { attempted_requests: cmp.attempted, page_errors: cmp.errors, console: cmp.consoleMsgs, dom: facts, calls, session_pictures: sessionPictures, images }
  // the Claude palette, kept nowhere
  await page.click('[data-testid="share-theme-claude"]')
  await stable(page)
  await page.screenshot({ path: join(OUT, 'file-images-claude.png') })
  await cmp.context.close()

  // ---- the tools + images file (one run left out), offline: details as previews, no control that acts
  const offline = await openFile(FILES.full, { offline: true, viewport: { width: 1280, height: 860 } })
  const fp = offline.page
  assert.equal(await fp.evaluate(() => document.documentElement.dataset.theme), 'light')
  // the needle is only in a tool's preview: not in the page's text until its row is opened
  assert.equal(await fp.evaluate((n) => document.body.innerText.includes(n), F.needle), false)
  await openAll(fp)
  const rows = fp.locator('[data-testid="thread"] .activity.row .activity-line.expandable')
  for (let i = 0; i < await rows.count(); i++) await rows.nth(i).click()
  const details = await fp.evaluate((n) => ({
    detail: document.querySelectorAll('[data-testid="call-detail"]').length,
    previews: document.querySelectorAll('[data-testid="call-preview"]').length,
    needle_in_preview: Array.from(document.querySelectorAll('[data-testid="call-preview"]')).filter((p) => p.textContent!.includes(n)).length,
    needle_in_text: document.body.innerText.split(n).length - 1,
    cut_notes: Array.from(document.querySelectorAll('[data-testid="call-preview-note"]')).map((x) => x.textContent),
    withheld: document.querySelectorAll('[data-testid="call-withheld"]').length,
  }), F.needle)
  assert.ok(details.detail >= 7 && details.previews >= 1, JSON.stringify(details))
  assert.ok(details.needle_in_preview >= 1 && details.needle_in_text === details.needle_in_preview, JSON.stringify(details))
  assert.ok(details.withheld >= 1, 'the sensitive sources are withheld')
  assert.ok(details.cut_notes.some((t) => /cut here/.test(t ?? '')), 'a cut preview says so')
  // the action lines opened: with tool details, the benign command's measures and a cut preview of its output under
  // its whole text (the bearer header redacted in both); the sensitive ones nothing but why
  const actionLines = fp.locator('[data-testid="thread"] > [data-testid^="action-"] button.action-line')
  assert.equal(await actionLines.count(), 4)
  for (let i = 0; i < 4; i++) await actionLines.nth(i).click()
  const opened = await fp.evaluate(() => Array.from(document.querySelectorAll('[data-testid="thread"] > [data-testid^="action-"]')).map((el) => ({
    missing: el.getAttribute('data-missing'), full: (el.querySelector('[data-testid="action-full"]') as HTMLElement | null)?.innerText ?? null,
    why: (el.querySelector('[data-testid="action-missing"]') as HTMLElement | null)?.innerText ?? null,
    preview: (el.querySelector('[data-testid="action-details"] [data-testid="call-preview"]') as HTMLElement | null)?.innerText ?? null,
    fields: (el.querySelector('[data-testid="action-details"] [data-testid="call-fields"]') as HTMLElement | null)?.innerText ?? null,
    below: (() => { const f = el.querySelector('[data-testid="action-full"]'), d = el.querySelector('[data-testid="action-details"]'); return !!f && !!d && !!(f.compareDocumentPosition(d) & Node.DOCUMENT_POSITION_FOLLOWING) })(),
  })))
  results.file_full_actions_opened = opened
  assert.ok(opened[0]!.full!.includes(A.mark) && opened[0]!.preview!.includes('step 1') && opened[0]!.preview!.includes(A.mark) && opened[0]!.below, JSON.stringify(opened[0]))
  assert.match(opened[0]!.fields ?? '', /exit_code 0/)
  for (const o of opened) assert.ok(!JSON.stringify(o).includes(A.bearer))
  for (const o of [opened[1]!, opened[2]!]) assert.ok(o.missing === 'withheld' && o.full === null && o.preview === null && /^Content withheld/.test(o.why ?? ''), JSON.stringify(o))
  assert.equal(opened[3]!.preview, null)
  await fp.screenshot({ path: join(OUT, 'file-full-details-open.png'), fullPage: false })
  const fullImages = await decodeAll(fp)
  assert.ok(fullImages.length >= 3 && fullImages.every((i) => i.decoded && i.w > 0 && i.h > 0 && i.data), JSON.stringify(fullImages))
  const fullFacts = await domFacts(fp)
  // each answer is named by the model that ran its run — never by the session's current model (Scripted Steer, last)
  const authors = await fp.evaluate((marks) => marks.map((m) => Array.from(document.querySelectorAll('[data-testid="thread"] .turn-agent')).find((s) => s.textContent!.includes(m))?.querySelector('.turn-who')?.textContent?.trim() ?? null), [F.answer_mark, 'RESUMED_ANSWER_MARK', 'IMG_DONE', 'SCREEN_DONE', 'I was handed'])
  assert.deepEqual(authors, ['Scripted Share', 'Scripted Share', 'Scripted Image', 'Scripted Screen', 'Scripted Eye'])
  results.file_full_offline = { attempted_requests: offline.attempted, page_errors: offline.errors, console: offline.consoleMsgs, details, dom: fullFacts, images: fullImages, answer_authors: authors }
  await offline.context.close()

  // ---- online contexts (not offline): any attempted HTTP(S) would be recorded (and refused); mobile light and dark
  const online = await openFile(FILES.full, { offline: false, viewport: { width: 375, height: 812 } })
  const mobileImages = await decodeAll(online.page)
  assert.ok(mobileImages.length >= 3 && mobileImages.every((i) => i.decoded && i.w > 0), JSON.stringify(mobileImages))
  const overflow = await online.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  // every palette: the four buttons inside the page and readable at rest; the chosen one readable under the pointer
  // too, in the product's active colours (the same as at rest)
  const palette = await paletteStates(online.page, join(OUT, 'file-mobile-palette'))
  results.mobile_palette = palette
  writeFileSync(join(OUT, 'mobile-palette-states.json'), JSON.stringify(palette, null, 2))
  assert.equal(palette.scrollWidth, palette.innerWidth, 'the mobile page does not scroll sideways')
  for (const b of palette.states) {
    assert.ok(b.left >= 0 && b.right <= palette.innerWidth, `${b.choice}: inside the page (${b.left}–${b.right})`)
    assert.ok(b.contrast >= 4.5, `${b.choice}${b.hovered ? ' (hovered)' : ''}: readable, contrast ${b.contrast} fg ${b.fg} bg ${b.bg}`)
  }
  for (const choice of ['light', 'dark', 'claude', 'system']) {
    const rest = palette.states.find((b) => !b.hovered && b.active && b.choice === `${choice}:${choice}`)
    const hover = palette.states.find((b) => b.hovered && b.choice === `${choice}:${choice}`)
    assert.ok(rest && hover, `${choice}: the chosen button is the active one`)
    assert.deepEqual([hover!.fg, hover!.bg], [rest!.fg, rest!.bg], `${choice}: the chosen button keeps its active colours under the pointer`)
  }
  await online.page.click('[data-testid="share-theme-light"]')
  await stable(online.page)
  await online.page.screenshot({ path: join(OUT, 'file-mobile-light.png') })
  await online.page.click('[data-testid="share-theme-dark"]')
  await stable(online.page)
  await online.page.screenshot({ path: join(OUT, 'file-mobile-dark.png') })
  const mobileFacts = await domFacts(online.page)
  const dflt = await openFile(FILES.dflt, { offline: false, viewport: { width: 1280, height: 860 } })
  assert.equal(await dflt.page.evaluate(() => document.documentElement.dataset.theme), 'dark')
  await stable(dflt.page)
  await dflt.page.screenshot({ path: join(OUT, 'file-default-dark.png') })
  // the default file (no tool details): every action line opened shows its whole text (or why not), and nothing loads
  // through the palettes either
  const dfltLines = dflt.page.locator('[data-testid="thread"] > [data-testid^="action-"] button.action-line')
  for (let i = 0; i < await dfltLines.count(); i++) await dfltLines.nth(i).click()
  assert.equal(await dflt.page.locator('[data-testid="action-details"]').count(), 0, 'no details in the default file')
  assert.equal(await dflt.page.locator('[data-testid="action-full"]').count() + await dflt.page.locator('[data-testid="action-missing"]').count(), 4)
  for (const theme of ['light', 'claude', 'dark']) { await dflt.page.click(`[data-testid="share-theme-${theme}"]`); await stable(dflt.page) }
  await dflt.page.locator('[data-testid="thread"] > [data-testid^="action-"]').first().scrollIntoViewIfNeeded()
  await dflt.page.screenshot({ path: join(OUT, 'file-default-dark-actions-open.png') })
  const dfltFacts = await domFacts(dflt.page)
  results.file_online_mobile = { attempted_requests: online.attempted, page_errors: online.errors, console: online.consoleMsgs, horizontal_overflow: overflow, dom: mobileFacts }
  results.file_online_default = { attempted_requests: dflt.attempted, page_errors: dflt.errors, console: dflt.consoleMsgs, dom: dfltFacts }
  // a fold, a row's record, a picture opened in place, the palette — nothing else is a button
  const allowedButtons = ['action-line.activity-line', 'activity-line.expandable', 'fold.work-head', 'note-fold', 'generated-image-open', 'shown-image', 'sources-toggle',
    'testid:share-theme-light', 'testid:share-theme-dark', 'testid:share-theme-claude', 'testid:share-theme-system',
    // the Agent Teams card's own window buttons: they fold or fill the card on this page alone
    'testid:card-shelve', 'testid:card-expand']
  for (const [name, r, f] of [['images', cmp, facts], ['full', offline, fullFacts], ['mobile', online, mobileFacts], ['default', dflt, dfltFacts]] as const) {
    assert.deepEqual(r.attempted, [], `${name}: no request other than the file itself was attempted`)
    assert.deepEqual(r.errors, [], `${name}: no page error`)
    assert.deepEqual(r.consoleMsgs.filter((m) => /^(error|warning)/.test(m)), [], `${name}: no console error or warning (a CSP violation would be one)`)
    assert.deepEqual(f.cspv, [], `${name}: no CSP violation`)
    assert.equal(f.xss, null); assert.equal(f.executable, 1); assert.equal(f.frames, 0); assert.equal(f.handlers, 0)
    assert.equal(f.fields, 0, `${name}: no field or form`); assert.equal(f.draggable, 0); assert.equal(f.anchors, 0, `${name}: no link that opens`)
    assert.equal(f.imgs_not_data, 0); assert.deepEqual(f.mutation_testids, [], `${name}: no control that acts`)
    assert.equal(f.rail, 0); assert.equal(f.desk, 0)
    // a one-session share: no list of sessions; its one Agent Teams card, read-only (no resize edge)
    assert.equal(f.share_sessions, 0, `${name}: one session, no list`); assert.equal(f.teams_cards, 1, `${name}: the Agent Teams card`); assert.equal(f.resize_handles, 0)
    assert.deepEqual((f.button_kinds as string[]).filter((b) => !allowedButtons.includes(b)), [], `${name}: only folds and the palette are buttons: ${JSON.stringify(f.button_kinds)}`)
    assert.equal(f.hostileShownAsText, true)
    assert.deepEqual(f.secretsInDom, [])
    assert.deepEqual((f.fonts as string[]).filter((s) => s.endsWith(':error')), [], `${name}: no KaTeX face failed`)
  }
  assert.ok((facts.fonts as string[]).some((s) => s.endsWith(':loaded')), 'KaTeX faces loaded from the embedded woff2')
  assert.ok(overflow <= 0, `the mobile page does not scroll sideways: ${overflow}`)
  await online.context.close()
  await dflt.context.close()
})

// ---- the task share's file, the backend stopped ----------------------------------------------------------------------

test('the task file: nothing of the deleted member or the task beside it, no canary, no id, exact CSP; each session\'s pictures its own (bytes gone, ownership kept)', () => {
  const bytes = readFileSync(join(OUT, TASK_FILES.task))
  const html = bytes.toString('utf8')
  const visible = stripInvisible(html)
  const p = partsOf(html)
  const doc = docOf(html)
  const snap = doc.snapshot
  assert.deepEqual([doc.format, doc.version, snap.version, snap.scope, snap.sessions.length], ['oasis-code.session-share.page', PAGE_VERSION_NOW, 3, 'task', 3])
  assert.deepEqual(snap.options, { include_tool_details: false, include_images: true, include_task_sessions: true })
  // no canary (raw, without invisible characters, case-insensitive, in the pictures' bytes); nothing of the deleted
  // member or the task beside it
  const pictureBytes = Object.values(doc.pictures).flatMap((m) => Object.values(m)).map((pic) => Buffer.from(pic.src.split(',')[1] ?? '', 'base64').toString('latin1')).join('\n')
  const found = Object.entries({ ...TASK_SECRET_VALUES, ...NOT_OF_THE_TASK }).filter(([, v]) => html.includes(v) || visible.includes(v) || visible.toLowerCase().includes(v.toLowerCase()) || pictureBytes.includes(v)).map(([k]) => k)
  assert.deepEqual(found, [], 'nothing that must not be shared')
  // no id of the harness, no folder of either project (the other project's absolute path named in a member's words
  // included), no temp root
  const harness = {
    run_ids: (html.match(/\brun_[0-9a-f]{6,}/g) ?? []).length,
    session_ids: [T.root, T.a, T.b, T.c, T.side].filter((id) => html.includes(id)).length,
    project_ids: [T.project, T.projectB].filter((id) => html.includes(id)).length,
    asset_ids: Object.values(T.assets).filter((id) => id && html.includes(id)).length,
    repo_paths: [info.repo, info.repo_b, info.data].filter((x) => html.includes(x)).length, tmp_root: (html.match(/oasis-code-e2e-/g) ?? []).length,
    // the director-controlled interaction's, its participants' (the harness's pt_…) and the directors' own ids, exactly
    // and by their shapes, in the raw bytes and in the text without invisible characters
    interaction_ids: [T.interaction].filter((id) => id && (html.includes(id) || visible.includes(id))).length,
    participant_ids: T.participants.filter((id) => id.length >= 4 && (html.includes(id) || visible.includes(id))).length,
    director_ids: T.directors.filter((id) => html.includes(id) || visible.includes(id)).length,
    // by their shapes (db/repo.ts ix_ + 12 hex, director/store.ts dir_ + 12 hex, a participant's pt_ + 6 hex), in the
    // snapshot's data as written and without invisible characters (the viewer's own minified script is not scanned)
    id_shapes: [...new Set([...`${p.data}\n${stripInvisible(p.data)}`.matchAll(/\b(?:ix_[0-9a-f]{12}|dir_[0-9a-f]{12}|pt_[0-9a-f]{6})\b/g)].map((m) => m[0].split('_')[0]!))],
  }
  assert.deepEqual(harness, { run_ids: 0, session_ids: 0, project_ids: 0, asset_ids: 0, repo_paths: 0, tmp_root: 0, interaction_ids: 0, participant_ids: 0, director_ids: 0, id_shapes: [] }, 'no id of the harness')
  // the page as the legacy files: one viewer script, one stylesheet, the hash-only CSP, nothing external
  assert.equal(p.scriptTags, 2); assert.equal(p.styleTags, 1)
  const csp = ["default-src 'none'", `script-src 'sha256-${sha64(p.js)}'`, `style-src 'sha256-${sha64(p.css)}'`, 'img-src data:', 'font-src data:', "connect-src 'none'",
    "object-src 'none'", "frame-src 'none'", "child-src 'none'", "worker-src 'none'", "media-src 'none'", "manifest-src 'none'", "form-action 'none'", "base-uri 'none'"].join('; ')
  assert.equal(p.csp, csp)
  assert.equal((p.markup.match(/<(iframe|object|embed|frame|base|form|link)\b/gi) ?? []).length, 0)
  assert.equal([...p.markup.matchAll(/\s(src|href|action|srcset|poster|data|formaction|xlink:href|background)\s*=\s*"([^"]*)"/gi)].length, 0)
  assert.equal(/[<>&]/.test(p.data), false)
  // each session: its own mark only; its pictures under its own keys, the source bytes gone but each image still its
  // session's (its key named by an item of that session, its type and size kept); the same key in several sessions
  const keysWithImg1: string[] = []
  const perSession: Record<string, unknown> = {}
  for (const s of snap.sessions) {
    const role = roleOfTitle(s.title)!
    const own = JSON.stringify(s)
    assert.ok(own.includes(TASK_MARKS[role]), `${role}: its own mark`)
    for (const other of TASK_ROLES.filter((r) => r !== role)) assert.ok(!own.includes(TASK_MARKS[other]), `${role}: no mark of ${other}`)
    assert.ok(s.images.length >= 1, `${role}: its picture`)
    for (const i of s.images) { assert.equal(i.data_base64, '', `${role}/${i.key}: no source byte`); assert.match(i.media_type, /^image\//) }
    const named = new Set(s.items.flatMap((i) => (i.kind === 'image' && i.image ? [i.image] : [])))
    const imageKeys = new Set(s.images.map((i) => i.key))
    for (const k of named) assert.ok(imageKeys.has(k), `${role}: item image ${k} is an image of its own session`)
    const pics = doc.pictures[s.key] ?? {}
    for (const [k, pic] of Object.entries(pics)) {
      assert.ok(named.has(k), `${role}: picture ${k} is named by an item of its own session`)
      assert.deepEqual([pic.width, pic.height], [TASK_IMAGES[role].w, TASK_IMAGES[role].h], `${role}/${k}: its own picture (by its size)`)
      assert.match(pic.src, /^data:image\/(webp|png|jpeg);base64,/)
    }
    assert.ok(Object.keys(pics).length >= 1, `${role}: a picture re-encoded`)
    if (imageKeys.has('img1')) keysWithImg1.push(s.key)
    // its card: rows that name runs of its own session only; bots of the product
    const runKeys = new Set(s.runs.map((r) => r.key))
    for (const r of s.team.rows) if (r.turn !== null) assert.ok(runKeys.has(r.turn), `${role}: row ${r.key} names a turn of its own session`)
    perSession[s.key] = { role, images: s.images.map((i) => i.key), pictures: Object.keys(pics), rows: s.team.rows.length, runs: s.runs.length }
  }
  assert.ok(Object.keys(doc.pictures).every((k) => snap.sessions.some((s) => s.key === k)), 'pictures only of the sessions shared')
  assert.ok(keysWithImg1.length >= 2, `the same image key in several sessions, each its own picture: ${keysWithImg1.join(', ')}`)
  // the cards: the work order's row of two runs, the relay's two participants with their badges; the member's director:
  // its bot on the member's rail, the turn it started (its words the director's) in the member's thread, wearing the
  // main agent's bot; the member's director's interaction: its plan row (the paper plane), the steps under it (each a
  // participant's bot, badged), the person's decision after them (no bot) — the app's outline row by row on the
  // file:// page
  const root = sessionByRole(snap, 'root')!, a = sessionByRole(snap, 'a')!
  assert.ok(root.team.rows.some((r) => r.name.includes(TASK_ORDER.label) && r.runs === 2), 'a row of two runs')
  assert.deepEqual(root.team.rows.filter((r) => r.participant_index !== null).map((r) => r.participant_index).sort(), [0, 1], 'the relay\'s two participants, badged 1 and 2')
  assert.ok(a.bots.includes('director'), `the director took part in the member's session: ${JSON.stringify(a.bots)}`)
  const handed = a.items.find((i) => i.kind === 'message' && (i as { author?: string }).author === 'director')
  assert.ok(handed && handed.run !== null, `the director's words open the worker's turn: ${JSON.stringify(a.items.map((i) => [i.kind, (i as { author?: string }).author ?? null]))}`)
  assert.equal(a.runs.find((r) => r.key === handed!.run)?.bot, a.bots[0], 'the worker\'s turn wears the main agent\'s bot (a turn of the thread)')
  assert.ok(a.team.rows.some((r) => r.runs >= 2 && r.turn !== null), 'the member\'s thread runs folded into one lineage, its latest turn named')
  const plan = a.team.rows.find((r) => r.kind === 'plan')
  assert.ok(plan && plan.bot === 'director', `the director's plan row wears the director's bot: ${JSON.stringify(a.team.rows.map((r) => [r.kind, r.bot, r.name]))}`)
  const steps = a.team.rows.filter((r) => r.parent === plan!.key && r.kind === 'run')
  // the planner schedules one step per participant the fixture names (two): exactly those, one each, badged 1 and 2
  assert.equal(steps.length, PLAN_PARTICIPANTS.length, `the steps the plan schedules hang under it: ${JSON.stringify(a.team.rows.map((r) => [r.key, r.kind, r.parent]))}`)
  assert.deepEqual(steps.map((st) => st.participant_index).sort(), PLAN_PARTICIPANTS.map((_, i) => i), 'one step for each participant')
  for (const st of steps) assert.ok(st.bot !== null && st.bot !== 'director' && st.participant_index !== null, `${st.key}: a participant's step, its bot and badge`)
  const decision = a.team.rows.find((r) => r.kind === 'decision')
  assert.ok(decision && decision.bot === null && decision.parent === plan!.key, `the person's decision after the steps, under the plan, no bot: ${JSON.stringify(decision)}`)
  assert.ok([...root.team.rows, ...a.team.rows].some((r) => r.parent !== null), 'a row under another')
  for (const s of snap.sessions) for (const r of s.team.rows) {
    if (r.parent !== null) assert.ok(s.team.rows.some((x) => x.key === r.parent), `${s.key}/${r.key}: its parent is a row of the card`)
    // a turn's face and its row's bot are one: the card and the thread draw the same agent the same way
    const run = s.runs.find((x) => x.key === r.turn)
    if (run) assert.equal(run.bot, r.bot, `${s.key}/${r.key}: the row's bot is its turn's`)
  }
  results.task_file = { bytes: bytes.length, sha256: sha(bytes), sessions: perSession, img1_in: keysWithImg1, stats: snap.stats }
})

test('the task file over file://: the sessions as the rail lists them, each its own thread, pictures and card; the card read-only, its rows jump to their turns; the bots the app drew; nothing fetched', async () => {
  assert.equal(server, null, 'the backend is stopped')
  const doc = docOf(readFileSync(join(OUT, TASK_FILES.task), 'utf8'))
  const snap = doc.snapshot
  const f = await openFile(TASK_FILES.task, { offline: true, viewport: { width: 1500, height: 950 }, keepTeams: true })
  const { page } = f
  try {
    // ---- the list: every session, in order, its title and bots, the members indented, the one it was made from shown
    const list = page.locator('[data-testid="share-sessions"] button.rail-session')
    assert.equal(await list.count(), snap.sessions.length)
    const entries = await page.locator('[data-testid="share-sessions"] .rail-session-row').evaluateAll((rows) => rows.map((row) => ({
      testid: row.querySelector('button')?.getAttribute('data-testid') ?? '', member: row.classList.contains('rail-member'),
      title: (row.querySelector('.nav-label') as HTMLElement | null)?.innerText.trim() ?? '',
      bots: Array.from(row.querySelectorAll('[data-testid="rail-bots"] img[data-bot]')).map((i) => i.getAttribute('data-bot')!),
      on: row.querySelector('button')?.getAttribute('aria-current') === 'page',
    })))
    assert.deepEqual(entries.map((e) => e.testid), snap.sessions.map((s) => `share-session-${s.key}`))
    assert.deepEqual(entries.map((e) => e.member), snap.sessions.map((s) => s.member))
    assert.deepEqual(entries.map((e) => e.bots), snap.sessions.map((s) => s.bots.slice(0, 3)), 'the rail\'s bots, stacked (at most three)')
    for (const e of entries) assert.ok(e.title.length > 0, 'every entry its title')
    assert.deepEqual(entries.map((e) => e.on), entries.map((e) => e.testid === `share-session-${snap.current}`))
    assert.deepEqual(entries.filter((e) => e.on).map((e) => e.testid), [`share-session-${snap.current}`], 'it opens on the session it was made from')
    for (const s of snap.sessions) {
      const id = idOf(roleOfTitle(s.title)!)
      if (appSeen.rail[id]) assert.deepEqual(entries.find((e) => e.testid === `share-session-${s.key}`)!.bots, appSeen.rail[id], `${s.title}: the bots the app's rail drew`)
    }
    await page.screenshot({ path: join(OUT, 'task-file-opened.png') })

    // ---- each session in turn: its own thread, marks, pictures, card
    const seen: Record<string, unknown> = {}
    for (const s of [...snap.sessions].reverse()) {
      const role = roleOfTitle(s.title)!
      await page.click(`[data-testid="share-session-${s.key}"]`)
      await page.waitForSelector(`[data-testid="share-thread"][data-session="${s.key}"]`)
      await page.waitForFunction((k) => document.querySelector(`[data-testid="share-session-${k}"]`)?.getAttribute('aria-current') === 'page', s.key)
      const text = await page.locator('[data-testid="thread"]').innerText()
      assert.ok(text.includes(TASK_MARKS[role]), `${role}: its own words`)
      for (const other of TASK_ROLES.filter((r) => r !== role)) assert.ok(!text.includes(TASK_MARKS[other]), `${role}: nothing of ${other}`)
      const pics = await page.evaluate(async () => {
        const out: { w: number; h: number; ok: boolean }[] = []
        for (const i of Array.from(document.querySelectorAll('[data-testid="thread"] img:not(.bot-img)')) as HTMLImageElement[]) {
          i.scrollIntoView({ block: 'center' })
          out.push({ ok: await i.decode().then(() => true, () => false), w: i.naturalWidth, h: i.naturalHeight })
        }
        return out
      })
      assert.ok(pics.length >= 1 && pics.every((x) => x.ok && x.w === TASK_IMAGES[role].w && x.h === TASK_IMAGES[role].h), `${role}: its own pictures only ${JSON.stringify(pics)}`)
      // its card: one row per team row, its bot, its runs, its tree
      const rows = await readOutline(page)
      assert.equal(rows.length, s.team.rows.length, `${role}: the card's rows`)
      // the page draws the tree (a parent, then what hangs under it), the snapshot's rows are in no tree order: each
      // drawn row is found by its key — every key once, the very set of the snapshot's rows — and is that row: its bot,
      // its runs, below its parent and indented under it (the order itself is the app's: compared row by row below)
      const byKey = await page.locator('[data-testid="graph-dock"] .ol-node:not(.folder)').evaluateAll((els) => els.map((e) => ({ id: e.getAttribute('data-id') ?? '', ind: parseFloat((e as HTMLElement).style.getPropertyValue('--ind')) })))
      const teamRows = new Map(s.team.rows.map((r) => [r.key, r]))
      assert.equal(teamRows.size, s.team.rows.length, `${role}: every row of the snapshot its own key`)
      assert.equal(new Set(byKey.map((x) => x.id)).size, byKey.length, `${role}: every drawn row once`)
      assert.deepEqual(byKey.map((x) => x.id).sort(), [...teamRows.keys()].sort(), `${role}: the drawn rows are the snapshot's rows`)
      for (const [i, drawn] of byKey.entries()) {
        const r = teamRows.get(drawn.id)!
        assert.equal(rows[i]!.bot, r.bot, `${role}/${r.key}: its bot`)
        assert.equal(rows[i]!.runs, r.runs, `${role}/${r.key}: its runs`)
        if (r.parent !== null) {
          const at = byKey.findIndex((x) => x.id === r.parent)
          assert.ok(at >= 0 && at < i, `${role}/${r.key}: drawn after its parent ${r.parent}`)
          assert.ok(drawn.ind > byKey[at]!.ind, `${role}/${r.key}: under its parent`)
        }
      }
      // the app's own outline and turns of this session, where it was read: the same rows (name, bot, runs, depth) and
      // the same bots on the same turns
      const id = idOf(role)
      // (a participant the app's row names by its generated id, the share names by its label: sharedName, those ids only)
      if (appSeen.outline[id]) assert.deepEqual(rows.map(({ name, bot, runs, ind }) => ({ name, bot, runs, ind })), appSeen.outline[id]!.map(({ name, bot, runs, ind }) => ({ name: sharedName(name), bot, runs, ind })), `${role}: the outline the app drew`)
      if (appSeen.turns[id]) {
        // turn by turn, by the run it is: a turn of the app's thread wears the bots the app drew on it; the share draws
        // every run of the session as a turn (as the frozen V2 did), so a run the app reads on its card (an order's) is
        // a turn here — its face is its card row's (asserted on the file) — and no turn of the app's thread is missing
        const appTurns = appSeen.turns[id]!
        const shared = (await readTurnBots(page)).map((t) => ({ ...t, run: taskRunIds[s.key]?.[t.id] }))
        assert.ok(shared.every((t) => t.run), `${role}: every turn is a run of the selection ${JSON.stringify(shared.filter((t) => !t.run).map((t) => t.id))}`)
        for (const t of shared) if (appTurns[t.run!]) assert.deepEqual(t.bots, appTurns[t.run!], `${role}/${t.id}: the bots the app drew on that turn`)
        assert.deepEqual(Object.keys(appTurns).filter((run) => !shared.some((t) => t.run === run)), [], `${role}: every turn of the app's thread is in the share`)
        ;(results.task_turns ??= {} as Record<string, unknown>)
        ;(results.task_turns as Record<string, unknown>)[role] = { shared: shared.length, of_the_app_thread: shared.filter((t) => appTurns[t.run!]).length }
      }
      seen[s.key] = { role, pictures: pics.length, rows: rows.length }
      await page.screenshot({ path: join(OUT, `task-file-${s.key}.png`) })
    }
    results.task_file_sessions = seen

    // ---- each session keeps its place: scrolled down in one, away and back
    const first = snap.sessions[0]!, second = snap.sessions[1]!
    await page.click(`[data-testid="share-session-${first.key}"]`)
    await page.waitForSelector(`[data-testid="share-thread"][data-session="${first.key}"]`)
    const at = await page.evaluate(() => { const t = document.querySelector('[data-testid="thread"]')!; t.scrollTop = Math.floor((t.scrollHeight - t.clientHeight) / 2); return t.scrollTop })
    await page.waitForTimeout(200)
    await page.click(`[data-testid="share-session-${second.key}"]`)
    await page.waitForSelector(`[data-testid="share-thread"][data-session="${second.key}"]`)
    await page.click(`[data-testid="share-session-${first.key}"]`)
    await page.waitForSelector(`[data-testid="share-thread"][data-session="${first.key}"]`)
    const back = await page.evaluate(() => document.querySelector('[data-testid="thread"]')!.scrollTop)
    assert.ok(at > 0 && Math.abs(back - at) <= 2, `the place kept: ${at} → ${back}`)

    // ---- the card is read-only: its title dragged, it stays; no edge to resize, nothing draggable
    const dock = page.locator('[data-testid="graph-dock"]')
    const box = (await dock.boundingBox())!
    const title = (await dock.locator('.desk-title').boundingBox())!
    await page.mouse.move(title.x + 30, title.y + title.height / 2)
    await page.mouse.down()
    await page.mouse.move(title.x - 220, title.y - 160, { steps: 8 })
    await page.mouse.up()
    assert.deepEqual(await dock.boundingBox(), box, 'the card does not move')
    assert.equal(await dock.locator('[draggable="true"], [class*="resize"]').count(), 0, 'nothing to drag or resize')
    // a row with its turn in the share: the thread glides to it and lights it; a row without one: nothing moves
    const target = first.team.rows.find((r) => r.turn !== null && first.runs.findIndex((x) => x.key === r.turn) === 0) ?? first.team.rows.find((r) => r.turn !== null)!
    await page.evaluate(() => { const t = document.querySelector('[data-testid="thread"]')!; t.scrollTop = t.scrollHeight })
    await page.click(`[data-testid="ol-${target.key}"]`)
    await page.waitForFunction((turn) => {
      const section = document.querySelector(`[data-testid="run-${turn}"]`)
      const scroller = document.querySelector('[data-testid="thread"]')
      if (!section || !scroller) return false
      const r = section.getBoundingClientRect(), b = scroller.getBoundingClientRect()
      return r.top >= b.top - 2 && r.top < b.bottom && !!(section.querySelector('.agent-span.flash') ?? (section.classList.contains('flash') ? section : null))
    }, target.turn, { timeout: 5000 })
    const none = first.team.rows.find((r) => r.turn === null)
    if (none) {
      const before = await page.evaluate(() => document.querySelector('[data-testid="thread"]')!.scrollTop)
      await page.click(`[data-testid="ol-${none.key}"]`)
      await page.waitForTimeout(700)
      assert.equal(await page.evaluate(() => document.querySelector('[data-testid="thread"]')!.scrollTop), before, 'a row of no turn moves nothing')
    }
    // its window buttons: this page alone
    await dock.locator('[data-testid="card-shelve"]').click()
    assert.match((await dock.getAttribute('class')) ?? '', /\bcollapsed\b/)
    await dock.locator('[data-testid="card-expand"]').click()
    assert.match((await dock.getAttribute('class')) ?? '', /\bexpanded\b/)
    await page.screenshot({ path: join(OUT, 'task-file-card-expanded.png') })
    await dock.locator('[data-testid="card-expand"]').click()

    // ---- nothing fetched, nothing that acts, no secret
    const facts = await domFacts(page)
    const harnessIds = Object.fromEntries([T.interaction, ...T.participants, ...T.directors].filter((id) => id.length >= 4).map((id, i) => [`harness_id_${i}`, id]))
    const hidden = await page.evaluate((secrets) => Object.entries(secrets).filter(([, v]) => document.documentElement.outerHTML.includes(v) || document.body.innerText.includes(v)).map(([k]) => k), { ...TASK_SECRET_VALUES, ...NOT_OF_THE_TASK, ...harnessIds })
    results.task_file_offline = { attempted: f.attempted, errors: f.errors, console: f.consoleMsgs, dom: facts }
    assert.deepEqual(f.attempted, [], 'no request but the file')
    assert.deepEqual(f.errors, [])
    assert.deepEqual(f.consoleMsgs.filter((m) => /^(error|warning)/.test(m)), [])
    assert.deepEqual(facts.cspv, [])
    assert.deepEqual(facts.mutation_testids, [])
    assert.equal(facts.fields, 0); assert.equal(facts.anchors, 0); assert.equal(facts.imgs_not_data, 0); assert.equal(facts.executable, 1); assert.equal(facts.frames, 0)
    assert.equal(facts.desk, 0, 'no desk card but Agent Teams'); assert.equal(facts.teams_cards, 1); assert.equal(facts.share_sessions, snap.sessions.length); assert.equal(facts.resize_handles, 0)
    assert.deepEqual(hidden, [])
  } finally { await f.context.close() }
})

test('the older pages read by the new viewer: a V2 snapshot of the frozen route, the V1 golden snapshot', async () => {
  const shell = readFileSync(join(OUT, TASK_FILES.task), 'utf8')
  const v2 = JSON.parse(readFileSync(join(OUT, 'legacy-v2-snapshot.json'), 'utf8')) as { version: number; runs: { request?: string }[]; images: unknown[] }
  const v1 = JSON.parse(readFileSync(fileURLToPath(new URL('../../backend-ts/tests/fixtures/share_snapshot_v1.json', import.meta.url)), 'utf8')) as { version: number; runs: { request?: string }[]; images: unknown[] }
  const out: Record<string, unknown> = {}
  for (const [file, snapshot] of [[TASK_FILES.legacyV2, v2], [TASK_FILES.legacyV1, v1]] as const) {
    // the page v2 (share/document.ts ShareDocument) around the old snapshot: no picture, no face, no bot still; written
    // into the new viewer's file in place of its data (the CSP hashes the script and the stylesheet only)
    const page2 = { format: 'oasis-code.session-share.page', version: 2, theme: 'light', snapshot: { ...snapshot, images: [] }, pictures: {}, page: { images_rejected: 0, images_over_page_budget: 0 }, faces: {}, bots: {} }
    const data = JSON.stringify(page2).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
    const html = shell.replace(/(<script type="application\/json" id="share-data">)[\s\S]*?(<\/script>)/, (_m, open: string, close: string) => `${open}${data}${close}`)
    assert.notEqual(html, shell)
    assert.equal(partsOf(html).csp, partsOf(shell).csp, 'the same viewer, the same policy')
    writeFileSync(join(OUT, file), html)
    const f = await openFile(file, { offline: true, viewport: { width: 1280, height: 860 } })
    try {
      const sections = await f.page.locator('[data-testid="thread"] > section[data-testid^="run-"]').count()
      const facts = await domFacts(f.page)
      out[file] = { version: snapshot.version, runs: snapshot.runs.length, sections, attempted: f.attempted, errors: f.errors, dom: facts }
      assert.equal(sections, snapshot.runs.filter((r) => r.request !== 'action').length, `${file}: every run's turn`)
      assert.equal(facts.share_sessions, 0); assert.equal(facts.teams_cards, 0, `${file}: no card in an older page`)
      assert.deepEqual(f.attempted, []); assert.deepEqual(f.errors, []); assert.deepEqual(facts.cspv, [])
      assert.deepEqual(f.consoleMsgs.filter((m) => /^(error|warning)/.test(m)), [])
      await f.page.screenshot({ path: join(OUT, file.replace(/\.html$/, '.png')) })
    } finally { await f.context.close() }
  }
  results.older_pages = out
})
