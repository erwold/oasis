// Remote access over the standing gateway: no stable provider → needs_setup and nothing started (no quick tunnel,
// no Tailscale call); a provider set up and turned on → this data directory's launchd agent installed with a plist
// of absolute paths and named values only; quitting the app leaves the agent alone; turning off removes it; the URL
// is the gateway's own (`/<secret>/mcp/current`) and a token inside this Mac changing does not move it; revoke does;
// a reopen with the same code restarts nothing, new code reloads the agent; a failed install puts back what was
// there; and "connected" only once the gateway launchd runs answers as itself and the public name answered it.
// launchd, the backend CLI, the loopback and child processes are fakes; files live in temporary folders.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { EventEmitter } = require('node:events')
const { createRemote, readPrefs, deriveState } = require('../remote')

const dirs = []
function tmp(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(d); return d }
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }) })

const SECRET = 'A'.repeat(43)

/** A Mac: launchd (by label), the backend's `gateway` CLI (writing the files as the real one does), the gateway's
 *  loopback /healthz, and whatever is spawned. */
function machine({ build = 'b1', env = {}, bootstrapFails = false, bootoutFails = false, kickstartFails = false } = {}) {
  const dataDir = tmp('remote-data-')
  const agentsDir = tmp('remote-agents-')
  const home = tmp('remote-home-')
  const gw = path.join(dataDir, 'gateway')
  const calls = []
  const spawned = []
  const launchd = new Map()   // label -> { pid, program, args }
  let nextPid = 500
  let instance = null
  const state = { build, bootstrapFails, bootoutFails, kickstartFails, health: true }
  const writeStatus = (patch) => {
    fs.mkdirSync(gw, { recursive: true })
    fs.writeFileSync(path.join(gw, 'status.json'), JSON.stringify({ updated_at: new Date().toISOString(), ...patch }))
  }
  const run = async (command, args, opts = {}) => {
    calls.push([command, ...args].join(' '))
    if (command === '/bin/launchctl') {
      const [verb, ...rest] = args
      const target = rest[rest.length - 1]
      if (verb === 'print') {
        const label = target.split('/').pop()
        const job = launchd.get(label)
        if (!job) return { code: 113, stdout: '', stderr: `Could not find service "${label}"` }
        return { code: 0, stdout: `${target} = {\n\tpath = ${job.path}\n\tstate = running\n\tprogram = ${job.program}\n\targuments = {\n${job.args.map((a) => `\t\t${a}`).join('\n')}\n\t}\n\tpid = ${job.pid}\n}`, stderr: '' }
      }
      if (verb === 'bootstrap') {
        if (state.bootstrapFails) { state.bootstrapFails = false; return { code: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' } }
        const text = fs.readFileSync(target, 'utf8')
        const label = /<key>Label<\/key>\s*<string>([^<]+)<\/string>/.exec(text)[1]
        const args2 = [...text.matchAll(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/g)][0][1].match(/<string>([^<]*)<\/string>/g).map((s) => s.replace(/<\/?string>/g, ''))
        const program = /<key>Program<\/key>\s*<string>([^<]+)<\/string>/.exec(text)[1]
        const pid = nextPid++
        launchd.set(label, { pid, program, args: args2, path: target })
        instance = `inst-${pid}`
        return { code: 0, stdout: '', stderr: '' }
      }
      if (verb === 'bootout') {
        if (state.bootoutFails) return { code: 5, stdout: '', stderr: 'Boot-out failed: 5: Input/output error' }
        const label = target.split('/').pop(); launchd.delete(label); return { code: 0, stdout: '', stderr: '' }
      }
      if (verb === 'kickstart') { if (state.kickstartFails) return { code: 1, stdout: '', stderr: 'kickstart failed' }; const label = target.split('/').pop(); const job = launchd.get(label); if (!job) return { code: 113, stdout: '', stderr: 'not found' }; job.pid = nextPid++; instance = `inst-${job.pid}`; return { code: 0, stdout: '', stderr: '' } }
      return { code: 1, stdout: '', stderr: 'unknown verb' }
    }
    // the backend CLI: `bun run src/index.ts gateway <sub> …` (source tree)
    const at = args.indexOf('gateway')
    if (at >= 0) {
      const [sub, ...rest] = args.slice(at + 1)
      const flag = (n) => rest[rest.indexOf(n) + 1]
      if (sub === 'version') return { code: 0, stdout: JSON.stringify({ build: state.build }), stderr: '' }
      if (sub === 'setup') {
        if (flag('--provider') === 'quick') {
          fs.rmSync(path.join(gw, 'config.json'), { force: true })
          if (!fs.existsSync(path.join(gw, 'secret'))) { fs.mkdirSync(gw, { recursive: true }); fs.writeFileSync(path.join(gw, 'secret'), SECRET) }
          return { code: 0, stdout: JSON.stringify({ provider: 'quick', host: null, token_set: null }), stderr: '' }
        }
        const host = flag('--host')
        if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return { code: 2, stdout: '', stderr: 'gateway: give the hostname only, without a path' }
        if (flag('--provider') !== 'external' && !opts.input) return { code: 2, stdout: '', stderr: 'gateway: a token is needed (on stdin)' }
        fs.mkdirSync(gw, { recursive: true })
        if (opts.input) fs.writeFileSync(path.join(gw, flag('--provider') === 'cloudflare' ? 'cloudflared-token' : 'ngrok-authtoken'), opts.input)
        fs.writeFileSync(path.join(gw, 'config.json'), JSON.stringify({ version: 1, provider: flag('--provider'), host }))
        if (!fs.existsSync(path.join(gw, 'secret'))) fs.writeFileSync(path.join(gw, 'secret'), SECRET)
        return { code: 0, stdout: JSON.stringify({ provider: flag('--provider'), host, token_set: true }), stderr: '' }
      }
      if (sub === 'revoke') { fs.writeFileSync(path.join(gw, 'secret'), 'B'.repeat(43)); return { code: 0, stdout: '{"url":null}', stderr: '' } }
    }
    return { code: 127, stdout: '', stderr: `unexpected ${command}` }
  }
  const spawn = (command, args) => {
    const child = new EventEmitter()
    child.name = `${path.basename(command)} ${args.join(' ')}`
    child.killed = false
    child.kill = () => { child.killed = true; setImmediate(() => child.emit('exit', null, 'SIGTERM')) }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    spawned.push(child)
    return child
  }
  const fetchImpl = async (url) => {
    if (!state.health || !instance) throw new TypeError('fetch failed')
    if (/\/healthz$/.test(String(url))) return new Response(JSON.stringify({ ok: true, server: 'oasis-code gateway', instance }), { headers: { 'content-type': 'application/json' } })
    throw new TypeError('unexpected fetch')
  }
  const bun = path.join(home, '.bun', 'bin', 'bun')
  fs.mkdirSync(path.dirname(bun), { recursive: true })
  fs.writeFileSync(bun, '')
  // the old module's options too (tailscale, cloudflared present), so the same test speaks to the baseline
  const exists = (p) => p === bun || /cloudflared$/.test(p) || /[Tt]ailscale/.test(p)
  const logs = []
  const remote = createRemote({
    dataDir, backend: { command: 'bun', args: ['run', 'src/index.ts'], cwd: '/repo/backend-ts', bundled: false }, harnessPort: '8391',
    env: { OASIS_CODE_GATEWAY_PORT: '8394', OASIS_CODE_DIRECTOR_PORT: '8392', OASIS_CODE_BRIDGE_PORT: '8393', ...env },
    log: (l) => logs.push(l), spawn, run, fetchImpl, exists, home, uid: 501, agentsDir, pid: 4242,
    waitMs: 300, restartMs: [10],
  })
  return { dataDir, agentsDir, home, gw, calls, spawned, launchd, remote, logs, state, writeStatus, instance: () => instance, bun, run }
}

const launchctl = (m, verb) => m.calls.filter((c) => c.startsWith(`/bin/launchctl ${verb}`))

test('turned on with nothing set up: the gateway runs a quick tunnel; its URL follows the name the gateway has now; quick can be chosen again after a stable provider', async () => {
  const m = machine()
  let s = await m.remote.set({ enabled: true })
  // the app starts no tunnel itself: launchd runs the gateway, which runs cloudflared
  assert.deepEqual(m.spawned.map((c) => c.name).filter((n) => !n.startsWith('caffeinate')), [])
  assert.equal(launchctl(m, 'bootstrap').length, 1)
  assert.equal(s.provider, 'quick')
  assert.equal(s.state, 'starting')
  assert.equal(s.url, null, 'no address before the quick tunnel has a name')
  const job = [...m.launchd.values()][0]
  fs.writeFileSync(path.join(m.gw, 'secret'), SECRET)
  m.writeStatus({ provider: 'quick', host: 'aa-bb.trycloudflare.com', pid: job.pid, instance: m.instance(), public: 'connected', backend: 'up' })
  s = await m.remote.status()
  assert.equal(s.state, 'connected')
  assert.equal(s.host, 'aa-bb.trycloudflare.com')
  assert.equal(s.url, `https://aa-bb.trycloudflare.com/${SECRET}/mcp/current`)
  // the gateway started again under a new quick name: the URL follows it, the state does not call it a pending setup
  m.writeStatus({ provider: 'quick', host: 'cc-dd.trycloudflare.com', pid: job.pid, instance: m.instance(), public: 'connected', backend: 'up' })
  s = await m.remote.status()
  assert.equal(s.state, 'connected')
  assert.equal(s.url, `https://cc-dd.trycloudflare.com/${SECRET}/mcp/current`)
  // a stable provider, then the quick tunnel again: the config goes, the gateway is restarted onto quick
  await m.remote.configure({ provider: 'external', host: 'mcp.example.com' })
  assert.equal((await m.remote.status()).provider, 'external')
  s = await m.remote.configure({ provider: 'quick' })
  assert.equal(s.provider, 'quick')
  assert.ok(!fs.existsSync(path.join(m.gw, 'config.json')))
  assert.equal(launchctl(m, 'kickstart').length, 2)
})

test('set up and turned on: this data directory\'s agent is installed — absolute program, named environment only (no API key, no secret), and the URL is /<gateway secret>/mcp/current', async () => {
  const m = machine({ env: { ANTHROPIC_API_KEY: 'sk-ant-should-never-leave', OPENAI_API_KEY: 'sk-should-never-leave', TUNNEL_TOKEN: 'ambient-tunnel-token', OASIS_CODE_USER_DATA: '/tmp/profile-x' } })
  await m.remote.configure({ provider: 'cloudflare', host: 'mcp.example.com', token: 'eyJhIjoiY2YiLCJ0IjoidHVubmVsIn0=' })
  const s = await m.remote.set({ enabled: true })
  assert.equal(s.url, `https://mcp.example.com/${SECRET}/mcp/current`)
  assert.equal(s.provider, 'cloudflare')
  assert.equal(s.host, 'mcp.example.com')
  assert.equal(s.token_set, true)
  assert.equal(s.gateway_origin, 'http://127.0.0.1:8394')
  const plists = fs.readdirSync(m.agentsDir)
  assert.equal(plists.length, 1)
  assert.match(plists[0], /^dev\.oasis-code\.gateway\.[0-9a-f]{12}\.plist$/)
  const plist = fs.readFileSync(path.join(m.agentsDir, plists[0]), 'utf8')
  assert.ok(plist.includes(`<string>${m.bun}</string>`), 'the program is Bun\'s absolute path')
  assert.ok(plist.includes('<string>/repo/backend-ts/src/index.ts</string>'))
  for (const forbidden of ['sk-ant-should-never-leave', 'sk-should-never-leave', 'ambient-tunnel-token', SECRET, 'eyJhIjoiY2YiLCJ0IjoidHVubmVsIn0=', 'ANTHROPIC', 'TUNNEL_TOKEN']) assert.ok(!plist.includes(forbidden), forbidden)
  const keys = [...plist.matchAll(/<key>(OASIS_CODE_[A-Z_]+|HOME|PATH)<\/key>/g)].map((x) => x[1]).sort()
  assert.deepEqual(keys, ['HOME', 'OASIS_CODE_BRIDGE_PORT', 'OASIS_CODE_DATA', 'OASIS_CODE_DIRECTOR_PORT', 'OASIS_CODE_GATEWAY_BUILD', 'OASIS_CODE_GATEWAY_PORT', 'OASIS_CODE_PORT', 'OASIS_CODE_USER_DATA', 'PATH'])
  assert.ok(plist.includes(`<string>${path.resolve(m.dataDir)}</string>`))
  assert.ok(plist.includes('<key>KeepAlive</key>') && plist.includes('<key>RunAtLoad</key>'))
  assert.equal(launchctl(m, 'bootstrap').length, 1)
  assert.match(launchctl(m, 'bootstrap')[0], /^\/bin\/launchctl bootstrap gui\/501 /)
  // the setup token went on stdin, never on a command line
  assert.ok(!m.calls.some((c) => c.includes('eyJhIjoiY2YiLCJ0IjoidHVubmVsIn0=')))
})

test('quitting the app leaves the gateway and its tunnel alone (no bootout, no kill); turning remote access off removes this agent', async () => {
  const m = machine()
  await m.remote.configure({ provider: 'external', host: 'mac.tail1234.ts.net' })
  await m.remote.set({ enabled: true })
  assert.equal(m.launchd.size, 1)
  await m.remote.stop()
  assert.equal(launchctl(m, 'bootout').length, 0)
  assert.equal(m.launchd.size, 1)
  assert.ok(m.spawned.every((c) => c.name.startsWith('caffeinate')), 'only the keep-awake child was ever the app\'s')
  const off = await m.remote.set({ enabled: false })
  assert.equal(off.state, 'off')
  assert.equal(launchctl(m, 'bootout').length, 1)
  assert.match(launchctl(m, 'bootout')[0], /^\/bin\/launchctl bootout gui\/501\/dev\.oasis-code\.gateway\.[0-9a-f]{12}$/)
  assert.equal(m.launchd.size, 0)
  assert.deepEqual(fs.readdirSync(m.agentsDir), [])
})

test('a token inside this Mac changing leaves the URL as it is; revoking the link changes it', async () => {
  const m = machine()
  await m.remote.configure({ provider: 'external', host: 'mcp.example.com' })
  const before = (await m.remote.set({ enabled: true })).url
  fs.writeFileSync(path.join(m.dataDir, 'director-token'), 'new-director-token-xxxxxxxxxxxxxxxx')
  fs.writeFileSync(path.join(m.dataDir, 'session-token'), 'new-session-token-yyyyyyyyyyyyyyyyy')
  assert.equal((await m.remote.status()).url, before)
  const after = await m.remote.rotate()
  assert.notEqual(after.url, before)
  assert.equal(after.url, `https://mcp.example.com/${'B'.repeat(43)}/mcp/current`)
  // a revoke needs no restart: the gateway reads its secret on every request
  assert.equal(m.calls.filter((c) => c.includes('kickstart')).length, 0)
})

test('the app reopened on the same code restarts nothing; new code (a new build) reloads the agent; a new setup restarts it', async () => {
  const m = machine()
  await m.remote.configure({ provider: 'external', host: 'mcp.example.com' })
  await m.remote.set({ enabled: true })
  const pid = [...m.launchd.values()][0].pid
  // the app quits and opens again: same plist, nothing done to the job
  await m.remote.stop()
  const again = createRemote({ dataDir: m.dataDir, backend: { command: 'bun', args: ['run', 'src/index.ts'], cwd: '/repo/backend-ts', bundled: false }, harnessPort: '8391',
    env: { OASIS_CODE_GATEWAY_PORT: '8394', OASIS_CODE_DIRECTOR_PORT: '8392', OASIS_CODE_BRIDGE_PORT: '8393' }, spawn: () => Object.assign(new EventEmitter(), { kill() {} }), run: m.run,
    fetchImpl: async () => { throw new TypeError('x') }, exists: (p) => p === m.bun, home: m.home, uid: 501, agentsDir: m.agentsDir, pid: 4243 })
  await again.resume()
  assert.equal([...m.launchd.values()][0].pid, pid)
  assert.equal(launchctl(m, 'bootout').length, 0)
  assert.equal(launchctl(m, 'kickstart').length, 0)
  // the code on disk changed: the plist names the new build, the job is reloaded once
  m.state.build = 'b2'
  await again.resume()
  assert.equal(launchctl(m, 'bootout').length, 1)
  assert.notEqual([...m.launchd.values()][0].pid, pid)
  const plist = fs.readFileSync(path.join(m.agentsDir, fs.readdirSync(m.agentsDir)[0]), 'utf8')
  assert.ok(plist.includes('<string>b2</string>'))
  // a new provider setup: the running gateway is restarted onto it (kickstart -k on this label only)
  await again.configure({ provider: 'external', host: 'other.example.com' })
  assert.equal(launchctl(m, 'kickstart').length, 1)
  assert.match(launchctl(m, 'kickstart')[0], /kickstart -k gui\/501\/dev\.oasis-code\.gateway\./)
})

test('a refused setup changes nothing and installs nothing; a failed install puts back what was there and says so', async () => {
  const m = machine()
  await m.remote.set({ enabled: true })
  await assert.rejects(m.remote.configure({ provider: 'cloudflare', host: 'https://evil.example.com/path', token: 'x'.repeat(30) }), /hostname only/)
  assert.equal((await m.remote.status()).provider, 'quick')
  assert.equal(launchctl(m, 'bootstrap').length, 1, 'only the quick gateway turning on installed anything')
  assert.equal(launchctl(m, 'kickstart').length, 0)
  const f = machine({ bootstrapFails: true })
  await f.remote.configure({ provider: 'external', host: 'mcp.example.com' })
  const s = await f.remote.set({ enabled: true })
  assert.equal(s.state, 'error')
  assert.match(s.error, /bootstrap .* failed/)
  assert.equal(f.launchd.size, 0)
  assert.deepEqual(fs.readdirSync(f.agentsDir), [], 'the plist of a failed first install is not left behind')
  // tried again: it comes up
  const ok = await f.remote.set({ enabled: true })
  assert.notEqual(ok.state, 'error')
  assert.equal(f.launchd.size, 1)
})

test('connected only when the gateway launchd runs answers as itself and its public name answered; just started is "starting"', async () => {
  const m = machine()
  await m.remote.configure({ provider: 'external', host: 'mcp.example.com' })
  let s = await m.remote.set({ enabled: true })
  // loaded and answering, but no status written yet: starting, never connected
  assert.equal(s.state, 'starting')
  const job = [...m.launchd.values()][0]
  const at = { provider: 'external', host: 'mcp.example.com' }
  m.writeStatus({ ...at, pid: job.pid, instance: m.instance(), public: 'starting', backend: 'up' })
  assert.equal((await m.remote.status()).state, 'starting')
  m.writeStatus({ ...at, pid: job.pid, instance: m.instance(), public: 'connected', backend: 'up' })
  assert.equal((await m.remote.status()).state, 'connected')
  m.writeStatus({ ...at, pid: job.pid, instance: m.instance(), public: 'connected', backend: 'down' })
  assert.equal((await m.remote.status()).state, 'backend_offline')
  // the backend not checked yet: not connected
  m.writeStatus({ ...at, pid: job.pid, instance: m.instance(), public: 'connected', backend: 'unknown' })
  assert.equal((await m.remote.status()).state, 'starting')
  m.writeStatus({ ...at, pid: job.pid, instance: m.instance(), public: 'unavailable', backend: 'up', error: 'the tunnel exited' })
  s = await m.remote.status()
  assert.equal(s.state, 'tunnel_unavailable')
  assert.equal(s.error, 'the tunnel exited')
  // a status file from another process (a stale one): not believed
  m.writeStatus({ ...at, pid: 1, instance: 'someone-else', public: 'connected', backend: 'up' })
  assert.equal((await m.remote.status()).state, 'starting')
})

test('deriveState: stale status files and a gateway that is not loaded are never "connected"', () => {
  const now = Date.parse('2026-10-16T10:00:00Z')
  const base = { enabled: true, config: { provider: 'external', host: 'h.example.com' }, agent: { loaded: true, running: true, pid: 7, identity: 'match' }, health: { instance: 'i' }, error: null, now }
  const gw = { pid: 7, instance: 'i', provider: 'external', host: 'h.example.com', public: 'connected', backend: 'up', updated_at: '2026-10-16T09:59:50Z' }
  assert.equal(deriveState({ ...base, gateway: gw }).state, 'connected')
  assert.equal(deriveState({ ...base, gateway: { ...gw, updated_at: '2026-10-16T09:58:00Z' } }).state, 'starting')
  assert.equal(deriveState({ ...base, gateway: gw, agent: { loaded: false } }).state, 'error')
  assert.equal(deriveState({ ...base, gateway: gw, health: null }).state, 'starting')
  assert.equal(deriveState({ ...base, gateway: gw, enabled: false, agent: { loaded: false, identity: 'none' } }).state, 'off')
  // a quick tunnel's name is whatever the gateway has now: a new one is not a setup waiting to go live
  assert.equal(deriveState({ ...base, config: { provider: 'quick', host: 'b.trycloudflare.com' }, gateway: { ...gw, provider: 'quick', host: 'b.trycloudflare.com' } }).state, 'connected')
  assert.equal(deriveState({ ...base, config: { provider: 'quick', host: null }, gateway: { ...gw, provider: 'external' } }).state, 'error')
  // off is only off when launchd has nothing: still loaded is an error, never "off"
  assert.equal(deriveState({ ...base, gateway: gw, enabled: false, agent: { loaded: true, running: true, pid: 7, identity: 'match' } }).state, 'error')
  // a job that is not this app's program, or loaded from elsewhere: never connected
  assert.equal(deriveState({ ...base, gateway: gw, agent: { ...base.agent, identity: 'stale' } }).state, 'error')
  assert.equal(deriveState({ ...base, gateway: gw, agent: { ...base.agent, identity: 'foreign' } }).state, 'error')
  // the gateway serves another provider or host than the one saved: the saved one is not live
  const pending = deriveState({ ...base, gateway: { ...gw, host: 'old.example.com' } })
  assert.equal(pending.state, 'error')
  assert.match(pending.error, /not live yet/)
  assert.equal(deriveState({ ...base, gateway: { ...gw, backend: 'unknown' } }).state, 'starting')
})

test('a stop that fails is never shown as off: remote access stays on with the error, and turning it off again retries', async () => {
  const m = machine()
  await m.remote.configure({ provider: 'external', host: 'mcp.example.com' })
  await m.remote.set({ enabled: true })
  m.state.bootoutFails = true
  const s = await m.remote.set({ enabled: false })
  assert.equal(s.state, 'error')
  assert.equal(s.enabled, true)
  assert.match(s.error, /could not turn remote access off/)
  assert.equal(readPrefs(m.dataDir).enabled, true)
  assert.equal(m.launchd.size, 1)
  assert.equal(fs.readdirSync(m.agentsDir).length, 1, 'the plist stays while the job is loaded')
  m.state.bootoutFails = false
  const off = await m.remote.set({ enabled: false })
  assert.equal(off.state, 'off')
  assert.equal(off.enabled, false)
  assert.equal(m.launchd.size, 0)
})

test('a job under this label that launchd loaded from elsewhere is never touched (no bootout, no bootstrap, no kickstart); one running another program from our plist is reloaded', async () => {
  const m = machine()
  await m.remote.configure({ provider: 'external', host: 'mcp.example.com' })
  const label = require('../gateway_agent').labelFor(m.dataDir)
  m.launchd.set(label, { pid: 77, program: '/usr/bin/somebody-else', args: ['/usr/bin/somebody-else'], path: '/Library/LaunchAgents/elsewhere.plist' })
  const s = await m.remote.set({ enabled: true })
  assert.equal(s.state, 'error')
  assert.match(s.error, /not this app's to change|loaded from elsewhere/)
  assert.equal(launchctl(m, 'bootout').length + launchctl(m, 'bootstrap').length + launchctl(m, 'kickstart').length, 0)
  const off = await m.remote.set({ enabled: false })
  assert.equal(off.state, 'error')
  assert.equal(launchctl(m, 'bootout').length, 0)
  assert.equal(m.launchd.get(label).pid, 77)
  // our own plist path, an older program: ours, reloaded onto the current one
  const n = machine()
  await n.remote.configure({ provider: 'external', host: 'mcp.example.com' })
  await n.remote.set({ enabled: true })
  const job = [...n.launchd.values()][0]
  job.program = '/old/place/bun'
  assert.equal((await n.remote.status()).state, 'error')
  await n.remote.resume()
  assert.equal(launchctl(n, 'bootout').length, 1)
  assert.equal([...n.launchd.values()][0].program, n.bun)
})

test('a new setup whose restart fails is saved but said to be not live; the old gateway is never shown as serving it', async () => {
  const m = machine()
  await m.remote.configure({ provider: 'external', host: 'mcp.example.com' })
  await m.remote.set({ enabled: true })
  const job = [...m.launchd.values()][0]
  m.writeStatus({ provider: 'external', host: 'mcp.example.com', pid: job.pid, instance: m.instance(), public: 'connected', backend: 'up' })
  assert.equal((await m.remote.status()).state, 'connected')
  m.state.kickstartFails = true
  const s = await m.remote.configure({ provider: 'external', host: 'new.example.com' })
  assert.equal(s.state, 'error')
  assert.match(s.error, /saved but not live/)
  assert.equal(s.host, 'new.example.com')
  // the error cleared (another app run), the old gateway still answers for the old host: still not "connected"
  const again = createRemote({ dataDir: m.dataDir, backend: { command: 'bun', args: ['run', 'src/index.ts'], cwd: '/repo/backend-ts', bundled: false }, harnessPort: '8391',
    env: { OASIS_CODE_GATEWAY_PORT: '8394', OASIS_CODE_DIRECTOR_PORT: '8392', OASIS_CODE_BRIDGE_PORT: '8393' }, spawn: () => Object.assign(new EventEmitter(), { kill() {} }), run: m.run,
    fetchImpl: async () => new Response(JSON.stringify({ ok: true, server: 'oasis-code gateway', instance: m.instance() })), exists: (p) => p === m.bun, home: m.home, uid: 501, agentsDir: m.agentsDir, pid: 4243 })
  const later = await again.status()
  assert.equal(later.state, 'error')
  assert.match(later.error, /still serves external at mcp\.example\.com/)
})
