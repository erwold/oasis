// The standing MCP gateway as a per-user launchd agent (~/Library/LaunchAgents/<label>.plist, gui/<uid> domain):
// installed only when the person turns remote access on with a provider set up, removed when they turn it off. It
// starts at login and is kept alive by launchd — it does not end with the app (quitting the app never stops it).
//
// One label per data directory (`dev.oasis-code.gateway.<hash>`): a test's data directory never touches the
// person's job. The plist holds absolute paths only (no shell, no PATH lookup) and an environment made here from
// named values — the data directory, the profile, the ports, a fixed PATH, HOME, the build it was installed for —
// never a copy of the app's own environment (which may carry API keys) and never a secret: the gateway reads its
// secret and the provider's token from 0600 files in <data>/gateway/.
//
// Every launchctl call names this label only (bootstrap, bootout, kickstart, print); what is running is judged by
// launchd's answer for the label (its pid, its program and arguments) against the plist this module wrote, never by
// a PID remembered from before. Pure over its effects (run, the file system, the clock): the tests drive it with fakes.

const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const LABEL_PREFIX = 'dev.oasis-code.gateway.'
const DEFAULT_GATEWAY_PORT = '8324'
const DEFAULT_DIRECTOR_PORT = '8322'
const DEFAULT_BRIDGE_PORT = '8323'
const AGENT_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
/** launchd's own words for a label it has no job under (`launchctl print`, exit 113) */
const NOT_LOADED = /Could not find service/i
const BUN_CANDIDATES = (env, home) => [env.BUN_INSTALL && path.join(env.BUN_INSTALL, 'bin', 'bun'), path.join(home, '.bun', 'bin', 'bun'), '/opt/homebrew/bin/bun', '/usr/local/bin/bun']

function labelFor(dataDir) {
  return LABEL_PREFIX + crypto.createHash('sha256').update(path.resolve(dataDir)).digest('hex').slice(0, 12)
}

/** Bun's absolute path for a gateway run from the source tree (launchd has no shell PATH to find it on). */
function findBun({ env = process.env, home = os.homedir(), exists = (p) => fs.existsSync(p) } = {}) {
  const fromPath = String(env.PATH || '').split(':').filter((d) => path.isAbsolute(d)).map((d) => path.join(d, 'bun'))
  return [...BUN_CANDIDATES(env, home), ...fromPath].find((p) => p && path.isAbsolute(p) && exists(p)) || null
}

/** The command launchd runs: the compiled backend's `gateway run`, or Bun on the source tree's entry. */
function gatewayProgram(backend, { bun }) {
  if (backend.bundled) {
    if (!path.isAbsolute(backend.command)) throw new Error(`the bundled backend path is not absolute: ${backend.command}`)
    return { program: backend.command, args: [backend.command, 'gateway', 'run'], cwd: backend.cwd }
  }
  if (!bun) throw new Error('Bun was not found (looked in ~/.bun/bin, /opt/homebrew/bin, /usr/local/bin and PATH): install it, or use the packaged app')
  const entry = path.join(backend.cwd, 'src', 'index.ts')
  return { program: bun, args: [bun, 'run', entry, 'gateway', 'run'], cwd: backend.cwd }
}

/** The gateway's environment, from named values only. */
function agentEnv({ dataDir, userData, ports, home, build }) {
  const out = {
    OASIS_CODE_DATA: path.resolve(dataDir),
    OASIS_CODE_PORT: String(ports.harness),
    OASIS_CODE_DIRECTOR_PORT: String(ports.director),
    OASIS_CODE_BRIDGE_PORT: String(ports.bridge),
    OASIS_CODE_GATEWAY_PORT: String(ports.gateway),
    HOME: home,
    PATH: AGENT_PATH,
  }
  if (userData) out.OASIS_CODE_USER_DATA = path.resolve(userData)
  if (build) out.OASIS_CODE_GATEWAY_BUILD = String(build)
  return out
}

/** The ports of this app instance, as its environment names them (the defaults otherwise). */
function portsOf(env, harnessPort) {
  const pick = (name, def) => {
    const v = String(env[name] || def)
    if (!/^\d{1,5}$/.test(v) || Number(v) < 1 || Number(v) > 65535) throw new Error(`${name} is not a port: ${v}`)
    return v
  }
  return { harness: String(harnessPort), director: pick('OASIS_CODE_DIRECTOR_PORT', DEFAULT_DIRECTOR_PORT), bridge: pick('OASIS_CODE_BRIDGE_PORT', DEFAULT_BRIDGE_PORT), gateway: pick('OASIS_CODE_GATEWAY_PORT', DEFAULT_GATEWAY_PORT) }
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function plistXml({ label, program, args, cwd, env, logPath }) {
  const strings = (list) => list.map((a) => `\t\t<string>${xml(a)}</string>`).join('\n')
  const dict = Object.keys(env).sort().map((k) => `\t\t<key>${xml(k)}</key>\n\t\t<string>${xml(env[k])}</string>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${xml(label)}</string>
\t<key>Program</key>
\t<string>${xml(program)}</string>
\t<key>ProgramArguments</key>
\t<array>
${strings(args)}
\t</array>
\t<key>WorkingDirectory</key>
\t<string>${xml(cwd)}</string>
\t<key>EnvironmentVariables</key>
\t<dict>
${dict}
\t</dict>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<true/>
\t<key>ThrottleInterval</key>
\t<integer>10</integer>
\t<key>ProcessType</key>
\t<string>Standard</string>
\t<key>StandardOutPath</key>
\t<string>${xml(logPath)}</string>
\t<key>StandardErrorPath</key>
\t<string>${xml(logPath)}</string>
</dict>
</plist>
`
}

/** launchd's answer for one service (`launchctl print gui/<uid>/<label>`): loaded or not, its state, pid, program
 *  and arguments. */
function parsePrint(text) {
  const out = { state: null, pid: null, program: null, args: [], path: null }
  const s = String(text)
  const where = /^\s*path = (.+)$/m.exec(s)
  if (where) out.path = where[1].trim()
  const state = /^\s*state = (.+)$/m.exec(s)
  if (state) out.state = state[1]
  const pid = /^\s*pid = (\d+)/m.exec(s)
  if (pid) out.pid = Number(pid[1])
  const program = /^\s*program = (.+)$/m.exec(s)
  if (program) out.program = program[1].trim()
  const args = /^\s*arguments = \{\n([\s\S]*?)\n\s*\}/m.exec(s)
  if (args) out.args = args[1].split('\n').map((l) => l.trim()).filter(Boolean)
  return out
}

/** `unloadWaitMs`: how long launchd may take to finish a bootout before the job counts as still loaded (bootout
 *  answers before launchd has let the job go: a print right after it still finds the job). */
function createGatewayAgent({ dataDir, uid = process.getuid ? process.getuid() : 0, agentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents'), run, log = () => {}, fsImpl = fs, unloadWaitMs = 5000, pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const label = labelFor(dataDir)
  const plistPath = path.join(agentsDir, `${label}.plist`)
  const domain = `gui/${uid}`
  const service = `${domain}/${label}`

  const readPlist = () => { try { return fsImpl.readFileSync(plistPath, 'utf8') } catch { return null } }
  const writePlist = (text) => {
    fsImpl.mkdirSync(agentsDir, { recursive: true })
    const tmp = `${plistPath}.${process.pid}.tmp`
    fsImpl.writeFileSync(tmp, text, { mode: 0o644 })
    fsImpl.renameSync(tmp, plistPath)
  }
  const removePlist = () => { try { fsImpl.unlinkSync(plistPath) } catch { /* none */ } }

  /** launchd's answer for the label. Only its own "Could not find service" means not loaded; any other failure
   *  (permission denied, a timeout — code null —, a launchctl that did not run, an I/O error) is unknown and throws,
   *  so nothing downstream (uninstall, Off, the card) takes "could not ask" for "not there". */
  async function print() {
    const r = await run('/bin/launchctl', ['print', service])
    if (r.code === 0) return { loaded: true, ...parsePrint(r.stdout) }
    const said = `${r.stderr || ''} ${r.stdout || ''}`
    if (NOT_LOADED.test(said)) return { loaded: false, state: null, pid: null, program: null, args: [], path: null }
    throw new Error(`launchctl print ${label} failed (${r.code === null || r.code === undefined ? 'no exit code' : r.code}): ${said.trim() || 'no output'}`)
  }

  /** Who the job under this label is, as launchd says: `none` (not loaded); `match` (loaded from this module's plist
   *  path, running `expected`'s program and arguments); `stale` (this plist path, another program: an older install,
   *  a moved app — ours to reload or remove); `foreign` (loaded from anywhere else: never touched). */
  function identityOf(p, expected) {
    if (!p.loaded) return 'none'
    if (p.path !== plistPath) return 'foreign'
    return expected && p.program === expected.program && JSON.stringify(p.args) === JSON.stringify(expected.args) ? 'match' : 'stale'
  }
  const refuse = (p) => new Error(`the launchd job ${label} was not loaded from ${plistPath} (launchd names ${p.path || 'no plist'}): it is not this app's to change; remove it by hand`)

  async function bootout() {
    const r = await run('/bin/launchctl', ['bootout', service])
    // not loaded is not a failure here (3: no such process; 113: could not find service)
    if (r.code !== 0 && r.code !== 3 && r.code !== 113 && !/No such process|Could not find service/i.test(`${r.stderr} ${r.stdout}`)) {
      throw new Error(`launchctl bootout ${label} failed (${r.code}): ${(r.stderr || r.stdout).trim()}`)
    }
    const deadline = Date.now() + unloadWaitMs
    while ((await print()).loaded) {
      if (Date.now() >= deadline) throw new Error(`launchctl bootout ${label}: launchd still has it loaded after ${unloadWaitMs / 1000} s`)
      await pause(100)
    }
  }

  async function bootstrap() {
    const r = await run('/bin/launchctl', ['bootstrap', domain, plistPath])
    if (r.code !== 0) throw new Error(`launchctl bootstrap ${label} failed (${r.code}): ${(r.stderr || r.stdout).trim()}`)
  }

  /** The plist for `spec` written and loaded; nothing done when that exact plist is loaded and launchd runs its
   *  program. A plist that differs (a new path, port, build), or a loaded job running something else from this plist
   *  path, is replaced; a job loaded from elsewhere under this label is refused untouched. A failure puts the plist
   *  before back as it was. */
  async function install(spec) {
    const text = plistXml({ label, ...spec })
    const before = readPlist()
    const was = await print()
    const who = identityOf(was, spec)
    if (who === 'foreign') throw refuse(was)
    if (who === 'match' && before === text) return { changed: false }
    writePlist(text)
    try {
      if (was.loaded) await bootout()
      await bootstrap()
      const now = await print()
      if (identityOf(now, spec) !== 'match') throw new Error(`launchd did not load ${label} as written`)
      log(`[remote] gateway agent ${label} ${was.loaded ? 'reloaded' : 'installed'}`)
      return { changed: true }
    } catch (error) {
      log(`[remote] gateway agent ${label} not installed: ${error.message}; putting back what was there`)
      try {
        if (identityOf(await print(), spec) !== 'foreign' && (await print()).loaded) await bootout()
        if (before !== null) { writePlist(before); if (was.loaded) await bootstrap() } else removePlist()
      } catch (rollback) { log(`[remote] gateway agent rollback: ${rollback.message}`) }
      throw error
    }
  }

  /** This job only, killed and started again by launchd (a new configuration or new code) — when it is this app's. */
  async function restart(expected) {
    const p = await print()
    const who = identityOf(p, expected)
    if (who === 'foreign') throw refuse(p)
    if (who !== 'match') throw new Error(`the gateway job ${label} is ${who === 'none' ? 'not loaded' : 'not running this app\'s program'}: turn remote access off and on again`)
    const r = await run('/bin/launchctl', ['kickstart', '-k', service])
    if (r.code !== 0) throw new Error(`launchctl kickstart ${label} failed (${r.code}): ${(r.stderr || r.stdout).trim()}`)
  }

  /** This job unloaded and its plist removed; nothing else touched (a job loaded from elsewhere is refused). Throws
   *  when launchd still has it: the caller never says it stopped when it did not. */
  async function uninstall() {
    const p = await print()
    if (identityOf(p, null) === 'foreign') throw refuse(p)
    if (p.loaded) await bootout()
    removePlist()
    log(`[remote] gateway agent ${label} removed`)
  }

  /** What launchd says of this label: loaded, running, its pid, and who it is against `expected` (match / stale /
   *  foreign / none). */
  async function status(expected) {
    const p = await print()
    const plist = readPlist()
    const identity = identityOf(p, expected)
    return { label, plist_path: plistPath, installed: plist !== null, loaded: p.loaded, running: p.loaded && p.state === 'running' && Number.isInteger(p.pid) && p.pid > 0, pid: p.pid, identity, identity_ok: identity === 'match' }
  }

  return { label, plistPath, install, restart, uninstall, status, print }
}

module.exports = { createGatewayAgent, labelFor, findBun, gatewayProgram, agentEnv, portsOf, plistXml, parsePrint, LABEL_PREFIX, AGENT_PATH, DEFAULT_GATEWAY_PORT, DEFAULT_DIRECTOR_PORT }
