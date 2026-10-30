// The desktop shell's pure part (adapted from oasis desktop/main.js, see NOTICE): which port, whether the thing on
// it is the oasis-code backend of this data directory and of a compatible API, where the session token lives, which links leave the app, where
// the backend and the UI come from, where the window was, where Electron keeps its profile, and the mark on what the
// agent's browser sends to this machine.
const fs = require('node:fs')
const crypto = require('node:crypto')
const os = require('node:os')
const path = require('node:path')

const API_VERSION = 'code-v1'
const DEFAULT_PORT = '8321'

function portOf(env = process.env) {
  const port = String(env.OASIS_CODE_PORT || DEFAULT_PORT)
  if (!/^\d{2,5}$/.test(port) || Number(port) > 65535) throw new Error(`OASIS_CODE_PORT is not a port: ${port}`)
  return port
}

function dataDirOf(env = process.env, homeDir = os.homedir()) {
  return env.OASIS_CODE_DATA ? path.resolve(env.OASIS_CODE_DATA.replace(/^~(?=$|\/)/, homeDir)) : path.join(homeDir, '.oasis-code')
}

/** Where Electron keeps the app's profile (its window state, the pages' sign-ins, the single-instance lock): the
 *  folder OASIS_CODE_USER_DATA names; else, for a data directory other than the default, an `electron` folder in it —
 *  a second app on other data never shares the person's profile, nor its lock (which would quit it and bring the
 *  person's window forward); else null, Electron's own default. */
function userDataOf(env = process.env, homeDir = os.homedir()) {
  if (env.OASIS_CODE_USER_DATA) return path.resolve(env.OASIS_CODE_USER_DATA.replace(/^~(?=$|\/)/, homeDir))
  const dataDir = dataDirOf(env, homeDir)
  return dataDir === dataDirOf({}, homeDir) ? null : path.join(dataDir, 'electron')
}

/** What `npm run smoke` adds to its environment: a data directory, an Electron profile and a port of its own in
 *  `scratch` (a fresh temporary folder) and on `freePort`, for each the person did not name — so the self-test never
 *  opens the person's profile (and clears its cache), takes their app's lock, or attaches to their running backend. */
function smokeEnv(env, scratch, freePort) {
  return {
    ...env,
    OASIS_CODE_SMOKE: '1',
    OASIS_CODE_DATA: env.OASIS_CODE_DATA || path.join(scratch, 'data'),
    OASIS_CODE_USER_DATA: env.OASIS_CODE_USER_DATA || path.join(scratch, 'electron'),
    OASIS_CODE_PORT: env.OASIS_CODE_PORT || String(freePort),
  }
}

/** A deliberately isolated, long-lived QA launch. Refuse unsafe defaults before touching the app/profile. */
function backgroundMode(env = process.env, homeDir = os.homedir()) {
  if (env.OASIS_CODE_BACKGROUND !== '1') return false
  if (env.OASIS_CODE_SMOKE === '1') throw new Error('BACKGROUND and SMOKE are mutually exclusive')
  const data = env.OASIS_CODE_DATA, profile = env.OASIS_CODE_USER_DATA
  const ordinary = path.join(homeDir, '.oasis-code')
  const outside = (p) => typeof p === 'string' && path.isAbsolute(p) && path.resolve(p) !== ordinary && !path.resolve(p).startsWith(ordinary + path.sep)
  if (!outside(data) || !outside(profile) || path.resolve(data) === path.resolve(profile)) throw new Error('BACKGROUND requires isolated absolute DATA and USER_DATA directories')
  const ports = ['OASIS_CODE_PORT', 'OASIS_CODE_BRIDGE_PORT', 'OASIS_CODE_DIRECTOR_PORT', 'OASIS_CODE_GATEWAY_PORT'].map((key) => {
    const value = env[key]
    if (!/^\d+$/.test(value || '') || Number(value) < 1024 || Number(value) > 65535 || [8321, 8322, 8323, 8324].includes(Number(value))) throw new Error(`BACKGROUND requires an isolated ${key}`)
    return Number(value)
  })
  if (new Set(ports).size !== ports.length) throw new Error('BACKGROUND ports must be distinct')
  return true
}

/** The header the agent's browser carries to this machine's own addresses; the backend refuses every API request that
 *  has it (backend-ts/src/api/auth.ts AGENT_BROWSER_HEADER). */
const AGENT_BROWSER_HEADER = 'x-oasis-code-agent-browser'

/** Whether a URL names this machine by a loopback address or name (where oasis-code's backend, bridge and director
 *  listen); the hostname as the URL parser leaves it (IPv4 forms like 127.1 or 2130706433 already 127.0.0.1). */
function isLoopbackUrl(url) {
  let parsed
  try { parsed = new URL(url) } catch { return false }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) return false
  // brackets of an IPv6 literal and the root's trailing dot (`localhost.`) are not part of the name
  const host = parsed.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  return host === 'localhost' || host.endsWith('.localhost') || /^127\.\d+\.\d+\.\d+$/.test(host) || host === '0.0.0.0'
    || host === '::1' || host === '::' || /^::ffff:(7f[0-9a-f]{2}:|127\.)/.test(host)
}

/** The headers a request of the agent's browser goes with: marked when it goes to this machine, untouched elsewhere
 *  (the web never sees the mark). */
function agentBrowserHeaders(url, headers) {
  return isLoopbackUrl(url) ? { ...headers, [AGENT_BROWSER_HEADER]: '1' } : headers
}

/** What answers on the port: 'ours' (an oasis-code backend of this API), 'other' (something else — never attached to,
 *  never fed a token), 'incompatible' (oasis-code, another API version), 'none'. */
function classifyBuild(status, body) {
  if (status === null) return 'none'
  if (status !== 200 || !body || typeof body !== 'object') return 'other'
  if (typeof body.source_fingerprint !== 'string' || typeof body.api_version !== 'string') return 'other'
  return body.api_version === API_VERSION ? 'ours' : 'incompatible'
}

/** A fresh challenge for /api/meta/build?challenge=…: random, base64url, of a length the backend accepts. */
function attachChallenge() {
  return crypto.randomBytes(24).toString('base64url')
}

/** The backend's answer to `challenge` when it holds `token` and listens on `port` (backend-ts api/auth.ts attachProof). */
function attachProof(token, port, challenge) {
  return crypto.createHmac('sha256', token).update(`oasis-code attach v1\n${port}\n${challenge}`).digest('base64url')
}

/** classifyBuild, then whether the backend is the one of this data directory: 'ours' only when it answered the
 *  challenge with the proof of `token` (this data directory's session token) on `port`. An oasis-code backend that
 *  cannot — another data directory's, one too old to answer, or something that only looks like one — is 'foreign'
 *  and is never sent the token; so is any backend when there is no token to check with. */
function classifyAttach(status, body, { token, port, challenge }) {
  const found = classifyBuild(status, body)
  if (found !== 'ours') return found
  if (!token || typeof body.attach_proof !== 'string') return 'foreign'
  const given = Buffer.from(body.attach_proof)
  const expected = Buffer.from(attachProof(token, port, challenge))
  return given.length === expected.length && crypto.timingSafeEqual(given, expected) ? 'ours' : 'foreign'
}

/** A link the page opens: http(s) goes to the system browser; the app's own origin stays; nothing else opens. */
function linkTarget(url, baseUrl) {
  let u
  try { u = new URL(url) } catch { return 'deny' }
  if (u.origin === new URL(baseUrl).origin) return 'app'
  return u.protocol === 'http:' || u.protocol === 'https:' ? 'external' : 'deny'
}

/** How many reloads a crashing renderer gets inside a window of time before the shell stops trying. */
function allowReload(history, now, { max = 3, windowMs = 60_000 } = {}) {
  const recent = history.filter((t) => now - t < windowMs)
  return { allowed: recent.length < max, history: [...recent, now] }
}

/** Where the backend and the UI come from. A packaged app carries a compiled backend (`bun build --compile`) and the
 *  built UI under its resources: no Bun, no Node, no source tree on the machine. From the source tree, Bun runs
 *  backend-ts and the backend serves frontend/dist. */
function backendCommand({ packaged, resourcesPath, repoRoot, platform = process.platform, env = process.env }) {
  if (packaged) {
    const dir = path.join(resourcesPath, 'backend')
    return {
      command: path.join(dir, platform === 'win32' ? 'oasis-code.exe' : 'oasis-code'), args: [], cwd: dir, hint: 'the bundled backend',
      frontend_dist: path.join(resourcesPath, 'ui'), bundled: true,
    }
  }
  const frontend_dist = path.join(repoRoot, 'frontend', 'dist')
  return { command: 'bun', args: ['run', 'src/index.ts'], cwd: path.join(repoRoot, 'backend-ts'), hint: 'bun', frontend_dist, bundled: false }
}

/** The window's bounds: the saved ones when they still fall on a display, the default centred ones otherwise. */
function windowBounds(saved, displays, fallback = { width: 1440, height: 900 }) {
  if (!saved || typeof saved !== 'object') return { ...fallback }
  const { x, y, width, height } = saved
  if (![x, y, width, height].every((v) => Number.isFinite(v)) || width < 640 || height < 480) return { ...fallback }
  const visible = displays.some((d) => x + width > d.x + 40 && x < d.x + d.width - 40 && y >= d.y - 8 && y < d.y + d.height - 40)
  return visible ? { x, y, width, height } : { width, height }
}

/** The token files in the data directory whose values a log line must never carry (the session's, the director's). */
// the gateway's external secret and the provider tokens it keeps are credentials too (gateway/…, 0600)
const TOKEN_FILES = ['session-token', 'director-token', 'gateway/secret', 'gateway/cloudflared-token', 'gateway/ngrok-authtoken']

/** The access tokens this app knows: the ones set in the environment and the ones in their files (0600). */
function knownTokens(dataDir, env = process.env, read = (p) => fs.readFileSync(p, 'utf8')) {
  const out = [env.OASIS_CODE_SESSION_TOKEN, env.OASIS_CODE_DIRECTOR_TOKEN]
  for (const name of TOKEN_FILES) { try { out.push(read(path.join(dataDir, name)).trim()) } catch { /* not minted yet */ } }
  return out.filter((t) => typeof t === 'string' && t.length >= 8)
}

/** A log line with its access tokens masked: every known token wherever it stands, and whatever stands in a token's
 *  place in a link (`?token=…`, the director's `/…/mcp`). The log is plain text at rest; a token in it would be a
 *  full-access credential for anyone who reads the file. */
function redactTokens(line, known = []) {
  let out = String(line)
  for (const token of known) out = out.split(token).join('…')
  return out.replace(/([?&]token=)[^&\s#"']+/gi, '$1…').replace(/\/[A-Za-z0-9_-]{16,}(\/mcp\b)/g, '/…$1')
}

/** Whether a backend that ended unasked is started again, and after how long: the first few ends in `windowMs` each
 *  after a longer wait; past them the person is told (a backend that keeps ending is not restarted for ever). `ends`:
 *  the times it ended unasked, this one last. */
function backendRestartDelay(ends, now, { windowMs = 10 * 60_000, delays = [1_000, 5_000, 15_000] } = {}) {
  const recent = ends.filter((t) => now - t < windowMs).length
  return recent >= 1 && recent <= delays.length ? delays[recent - 1] : null
}

module.exports = {
  backgroundMode, backendRestartDelay,
  AGENT_BROWSER_HEADER, API_VERSION, DEFAULT_PORT, agentBrowserHeaders, allowReload, attachChallenge, attachProof, backendCommand, classifyAttach, classifyBuild, dataDirOf,
  isLoopbackUrl, knownTokens, linkTarget, portOf, redactTokens, smokeEnv, userDataOf, windowBounds,
}
