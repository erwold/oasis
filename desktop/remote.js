// Remote access: oasis-code reachable from ChatGPT (its web client: custom MCP servers are a web feature) at one URL
// that stays the same.
//
// The MCP ingress is the backend's standing gateway (`oasis-code gateway run`), a per-user launchd agent
// (gateway_agent.js) installed when the person turns remote access on. Its tunnel is a Cloudflare quick tunnel until
// a stable provider is set up — a Cloudflare named tunnel (its token), ngrok's fixed domain (the account's
// authtoken), or an external fixed HTTPS host some other tunnel brings to the gateway's port (Tailscale Funnel --bg,
// say; nothing of Tailscale is touched here). A quick tunnel's name changes whenever the gateway starts again (a
// reboot, the tunnel's own restart), never because the app restarted; the URL then follows its new name. Its
// URL is `https://<host>/<gateway secret>/mcp/current` (the newest tool surface): the external secret is the gateway's own, not
// the director's or the session's token, so a token inside this Mac changing leaves the URL as it is. Only a revoke
// (a new external secret) changes it.
//
// Quitting the app stops what the app itself started (the keep-awake assertion) and nothing else: the gateway
// and its tunnel keep serving. Turning remote access off removes this data directory's agent (bootout, plist gone).
//
// Setup and revoke go through the backend's own CLI (`gateway setup`, the provider token on its stdin; `gateway
// revoke`), so the checks live in one place; the state is read from the gateway's status file, launchd's answer for
// the agent's label and the gateway's loopback /healthz — a process that was only just started is never called
// connected. Pure over its effects (spawn, run, fetch, the file system): the tests drive it with fakes.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { agentEnv, createGatewayAgent, findBun, gatewayProgram, portsOf } = require('./gateway_agent')

const PREFS_FILE = 'remote-access.json'
const GATEWAY_DIR = 'gateway'
const PROVIDERS = ['cloudflare', 'ngrok', 'external']
/** what the person may choose: the quick tunnel (no setup) or a stable provider */
const CHOICES = ['quick', ...PROVIDERS]
/** a gateway whose status file was not written for this long is not believed (it writes every 15 s) */
const STALE_MS = 60_000
const CLI_MS = 30_000

function readPrefs(dataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, PREFS_FILE), 'utf8'))
    return { enabled: raw.enabled === true, keep_awake: raw.keep_awake !== false }
  } catch {
    return { enabled: false, keep_awake: true }
  }
}

function writePrefs(dataDir, prefs) {
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(path.join(dataDir, PREFS_FILE), JSON.stringify({ enabled: prefs.enabled === true, keep_awake: prefs.keep_awake !== false }, null, 2))
}

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null } }
const readText = (p) => { try { return fs.readFileSync(p, 'utf8').trim() || null } catch { return null } }

/** What the gateway's files say: its config (a stable provider and its host; the quick tunnel when none is set up,
 *  its host the name the running quick gateway last wrote), its secret, its last status; and whether a provider
 *  token is kept (never the token itself). */
function gatewayFiles(dataDir) {
  const dir = path.join(dataDir, GATEWAY_DIR)
  const raw = readJson(path.join(dir, 'config.json'))
  const stable = raw && PROVIDERS.includes(raw.provider) && typeof raw.host === 'string' && /^[a-z0-9.-]+$/.test(raw.host) ? { provider: raw.provider, host: raw.host } : null
  const secret = readText(path.join(dir, 'secret'))
  const status = readJson(path.join(dir, 'status.json'))
  const quickHost = status && status.provider === 'quick' && typeof status.host === 'string' && /^[a-z0-9.-]+$/.test(status.host) ? status.host : null
  return {
    config: stable || { provider: 'quick', host: quickHost },
    secret: secret && /^[A-Za-z0-9_-]{32,128}$/.test(secret) ? secret : null,
    status,
    token_set: stable && stable.provider !== 'external' ? fs.existsSync(path.join(dir, stable.provider === 'cloudflare' ? 'cloudflared-token' : 'ngrok-authtoken')) : null,
  }
}

function publicUrl(host, secret) { return `https://${host}/${secret}/mcp/current` }

/** The one state the card shows, from what is known now (pure: the tests read it directly).
 *  off · starting · connected · backend_offline · tunnel_unavailable · error
 *  Never "off" while launchd still has this data directory's gateway loaded; never "connected" unless the job launchd
 *  runs is this app's program, the gateway answering on the loopback is that job, it serves the provider and host
 *  that are configured (a quick tunnel: whatever name it has now), its public name answered it and the backend is known to be up. */
function deriveState({ enabled, config, agent, gateway, health, error, now }) {
  // launchd could not be asked (print failed for another reason than "not found"): unknown is never off, never connected
  if (agent && agent.error) return { state: 'error', error: error || `launchd could not be asked about the gateway: ${agent.error}` }
  if (agent && agent.identity === 'foreign') return { state: 'error', error: `a launchd job under this app's label was loaded from elsewhere: remove it by hand` }
  if (!enabled) {
    if (agent && agent.loaded) return { state: 'error', error: error || 'remote access is off but the gateway is still loaded: turn it off again' }
    return error ? { state: 'error', error } : { state: 'off', error: null }
  }
  if (error) return { state: 'error', error }
  if (!agent || !agent.loaded) return { state: 'error', error: 'the gateway service is not loaded: turn remote access off and on again' }
  if (agent.identity === 'stale') return { state: 'error', error: 'the gateway launchd runs is not this app\'s current program: turn remote access off and on again' }
  const fresh = gateway && typeof gateway.updated_at === 'string' && now - Date.parse(gateway.updated_at) < STALE_MS
  // the running gateway is the one launchd runs for this label, and it answers on the loopback as itself
  const ours = gateway && health && health.instance === gateway.instance && (!agent.pid || gateway.pid === agent.pid)
  if (!agent.running || !fresh || !ours) return { state: 'starting', error: null }
  if (gateway.provider !== config.provider || (config.provider !== 'quick' && gateway.host !== config.host)) {
    return { state: 'error', error: `the running gateway still serves ${gateway.provider || 'no provider'}${gateway.host ? ` at ${gateway.host}` : ''}; the saved setup (${config.provider}${config.host ? ` at ${config.host}` : ''}) is not live yet` }
  }
  if (gateway.public === 'unavailable') return { state: 'tunnel_unavailable', error: gateway.error || null }
  if (gateway.public !== 'connected') return { state: 'starting', error: null }
  if (gateway.backend === 'down') return { state: 'backend_offline', error: null }
  if (gateway.backend !== 'up') return { state: 'starting', error: null }
  return { state: 'connected', error: null }
}

function createRemote({
  dataDir, backend, harnessPort, env = process.env, log = () => {}, spawn, run, fetchImpl = fetch,
  home = os.homedir(), uid = process.getuid ? process.getuid() : 0, agentsDir, agent: givenAgent = null,
  exists = (p) => fs.existsSync(p), now = Date.now, pid = process.pid,
}) {
  let prefs = readPrefs(dataDir)
  let lastError = null
  let awake = null
  const agent = givenAgent || createGatewayAgent({ dataDir, uid, run, log, ...(agentsDir ? { agentsDir } : {}) })
  const ports = portsOf(env, harnessPort)
  const userData = env.OASIS_CODE_USER_DATA || null

  /** The backend's own CLI (`gateway …`), its answer as JSON; `input` goes to its stdin (a token, never an argument). */
  async function cli(args, input = '') {
    const cmd = backend.bundled
      ? { command: backend.command, args: [...backend.args, 'gateway', ...args] }
      : { command: backend.command, args: ['run', 'src/index.ts', 'gateway', ...args] }
    const r = await run(cmd.command, cmd.args, { cwd: backend.cwd, input, timeoutMs: CLI_MS, env: { ...env, OASIS_CODE_DATA: dataDir, OASIS_CODE_PORT: String(harnessPort) } })
    if (r.code !== 0) throw new Error((r.stderr || r.stdout || `gateway ${args[0]} failed (${r.code})`).trim().replace(/^gateway: /, '').split('\n')[0])
    try { return JSON.parse(String(r.stdout).trim().split('\n').pop()) } catch { throw new Error(`gateway ${args[0]} gave no answer`) }
  }

  /** The program and arguments launchd should run for this data directory (null: none can be named, Bun missing). */
  function expected() {
    try { return gatewayProgram(backend, { bun: backend.bundled ? null : findBun({ env, home, exists }) }) } catch { return null }
  }

  /** What launchd should run for this data directory, for the code on disk now (its build is in the plist, so new
   *  code makes a new plist and the agent is reloaded with it; the same code leaves the running gateway alone). */
  async function spec() {
    const build = (await cli(['version'])).build
    const prog = gatewayProgram(backend, { bun: backend.bundled ? null : findBun({ env, home, exists }) })
    return { ...prog, env: agentEnv({ dataDir, userData, ports, home, build }), logPath: path.join(dataDir, GATEWAY_DIR, 'gateway.log') }
  }

  /** The loopback port already taken by something that is not this data directory's gateway? */
  async function portTakenByOther(myStatus) {
    try {
      const res = await fetchImpl(`http://127.0.0.1:${ports.gateway}/healthz`, { signal: AbortSignal.timeout(1500) })
      const body = await res.json().catch(() => null)
      if (body && body.server === 'oasis-code gateway' && myStatus && body.instance === myStatus.instance) return false
      return true
    } catch { return false }
  }

  async function ensureInstalled({ restart = false } = {}) {
    const s = await spec()
    fs.mkdirSync(path.join(dataDir, GATEWAY_DIR), { recursive: true, mode: 0o700 })
    const current = await agent.status(s)
    if (!current.loaded && await portTakenByOther(gatewayFiles(dataDir).status)) {
      throw new Error(`port ${ports.gateway} already answers (another gateway or program): stop it, or start the app with another OASIS_CODE_GATEWAY_PORT`)
    }
    const { changed } = await agent.install(s)
    if (restart && !changed) await agent.restart(s)
  }

  function keepAwake() {
    if (awake || !prefs.enabled || !prefs.keep_awake) return
    // no sleep while this app runs and remote access is on (the display may sleep; a closed lid on battery still
    // sleeps — macOS decides that); it ends with the app (-w)
    const child = spawn('/usr/bin/caffeinate', ['-is', '-w', String(pid)], { stdio: 'ignore' })
    awake = child
    child.on('error', (error) => { if (awake === child) awake = null; log(`[remote] caffeinate: ${error.message}`) })
    child.on('exit', () => { if (awake === child) awake = null })
  }
  function letSleep() {
    const child = awake
    awake = null
    if (child) { try { child.kill('SIGTERM') } catch { /* gone */ } }
  }

  async function health() {
    try {
      const res = await fetchImpl(`http://127.0.0.1:${ports.gateway}/healthz`, { signal: AbortSignal.timeout(1500) })
      const body = await res.json().catch(() => null)
      return body && body.server === 'oasis-code gateway' ? body : null
    } catch { return null }
  }

  async function status() {
    const files = gatewayFiles(dataDir)
    // asked always: off but still loaded is never shown as off
    let agentStatus
    try { agentStatus = await agent.status(expected()) } catch (error) { agentStatus = { loaded: false, error: error.message } }
    const h = agentStatus && agentStatus.loaded ? await health() : null
    const derived = deriveState({ enabled: prefs.enabled, config: files.config, agent: agentStatus, gateway: files.status, health: h, error: lastError, now: now() })
    return {
      state: derived.state, error: derived.error, enabled: prefs.enabled, keep_awake: prefs.keep_awake,
      provider: files.config.provider, host: files.config.host,
      url: files.config.host && files.secret ? publicUrl(files.config.host, files.secret) : null,
      token_set: files.token_set,
      // where a tunnel must bring HTTPS traffic: the gateway's loopback origin (read-only, for the setup line)
      gateway_origin: `http://127.0.0.1:${ports.gateway}`,
    }
  }

  async function turnOn() {
    lastError = null
    try { await ensureInstalled() } catch (error) { lastError = error.message; log(`[remote] did not start: ${error.message}`) }
    keepAwake()
  }

  /** True once launchd no longer has the gateway; false (and the error kept) when it could not be stopped. */
  async function turnOff() {
    lastError = null
    letSleep()
    try { await agent.uninstall(); return true } catch (error) { lastError = `could not turn remote access off: ${error.message}`; log(`[remote] did not stop: ${error.message}`); return false }
  }

  return {
    /** With the app: the agent as this code wants it (a reload only when the plist differs: a new build, a moved
     *  app), when the person turned remote access on before; never a restart for a plain reopen. */
    resume: async () => { if (prefs.enabled) await turnOn() },
    status,
    async set(change) {
      const next = { ...prefs, ...(typeof change.enabled === 'boolean' ? { enabled: change.enabled } : {}), ...(typeof change.keep_awake === 'boolean' ? { keep_awake: change.keep_awake } : {}) }
      const was = prefs
      prefs = next
      writePrefs(dataDir, prefs)
      if (!prefs.enabled) {
        // stays on (and says why) until launchd really has no gateway: a failed stop is never shown as off
        if (!(await turnOff())) { prefs = { ...prefs, enabled: true }; writePrefs(dataDir, prefs) }
      } else if (prefs.enabled && (!was.enabled || lastError)) await turnOn()
      else if (prefs.enabled) { if (prefs.keep_awake) keepAwake(); else letSleep() }
      return status()
    },
    /** The quick tunnel, or a provider and its fixed host (and its token, when it takes one) saved through the
     *  backend's checks; the running gateway restarted onto it when remote access is on. A refused setup changes
     *  nothing. */
    async configure(change) {
      if (!change || !CHOICES.includes(change.provider)) throw new Error('choose the quick tunnel, Cloudflare, ngrok or an external tunnel')
      const token = typeof change.token === 'string' ? change.token.trim() : ''
      if (change.provider === 'quick') await cli(['setup', '--provider', 'quick'])
      else await cli(['setup', '--provider', change.provider, '--host', String(change.host || '')], token)
      lastError = null
      if (prefs.enabled) {
        // the setup is saved; it is live only once the gateway restarted onto it (the state says so until then)
        try { await ensureInstalled({ restart: true }) } catch (error) { lastError = `the new setup is saved but not live: ${error.message}`; log(`[remote] did not restart: ${error.message}`) }
        keepAwake()
      }
      return status()
    },
    /** Revoke the link: a new external secret; the old URL answers 404 from now on (the gateway reads the secret on
     *  every request: no restart). ChatGPT needs the new URL. */
    async rotate() {
      await cli(['revoke'])
      return status()
    },
    /** The app quits: what it started itself (keeping the Mac awake) stops; the gateway and its tunnel do not. */
    stop: async () => { letSleep() },
  }
}

module.exports = { createRemote, readPrefs, writePrefs, deriveState, gatewayFiles, publicUrl, PREFS_FILE, PROVIDERS }
