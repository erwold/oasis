// Semantic probes of the desktop remote-access lifecycle, against the BASELINE API (desktop/remote.js createRemote).
// Every assertion states the NEW required behaviour; on baseline f5bd7dc each must fail on behaviour (an assertion),
// never on a missing module. Run: QA_REPO=<clone> node --test baseline_probes_desktop.test.js
// No process is spawned: spawn/run/fetch are fakes (same style as desktop/test/remote.test.js).
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { EventEmitter } = require('node:events')

const REPO = process.env.QA_REPO
if (!REPO) throw new Error('set QA_REPO to the clone under test')
const remotePath = path.join(REPO, 'desktop', 'remote.js')
// an import error is NOT a behaviour failure: report it as such and stop
let createRemote
try { ({ createRemote } = require(remotePath)) } catch (e) { console.error(`IMPORT-ERROR (not a behaviour result): ${e.message}`); process.exit(3) }

function fakeChild(name, say) {
  const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.name = name; c.signals = []
  c.kill = (sig = 'SIGTERM') => { c.signals.push(sig); setImmediate(() => c.emit('exit', null, sig)) }
  if (say) setImmediate(() => c.stderr.emit('data', say))
  return c
}
function machine({ tailscale = { BackendState: 'NeedsLogin' } } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-remote-'))
  const spawned = []
  const spawn = (command, args) => {
    let say = ''
    if (/cloudflared$/.test(command)) say = 'INF |  https://qa-probe.trycloudflare.com  |\n'
    else if (args.includes('director')) { fs.writeFileSync(path.join(dataDir, 'director-token'), 'tok123'); say = 'oasis-code director on http://127.0.0.1:8322/tok123/mcp\n' }
    const c = fakeChild(`${path.basename(command)} ${args.join(' ')}`, say); spawned.push(c); return c
  }
  const exists = (p) => (/[Tt]ailscale/.test(p) ? p.startsWith('/Applications') : /cloudflared$/.test(p) ? p.startsWith('/opt/homebrew') : false)
  const remote = createRemote({ dataDir, backend: { command: 'bun', args: [], cwd: '/repo/backend-ts', bundled: false }, harnessPort: '8321', env: {}, log: () => {},
    spawn, run: async () => JSON.stringify(tailscale), exists, fetchImpl: async () => { throw new Error('nothing') }, waitMs: 2000, restartMs: [10], pid: 4242 })
  return { dataDir, spawned, remote }
}

test('P1 lifecycle: app quit (remote.stop) must NOT kill the tunnel/gateway (only the person turning it off does)', async () => {
  const m = machine()
  await m.remote.set({ enabled: true })
  await m.remote.stop() // what main.js before-quit calls
  const tunnel = m.spawned.find((c) => c.name.startsWith('cloudflared'))
  assert.ok(tunnel, 'precondition: a tunnel was started')
  assert.deepEqual(tunnel.signals, [], `app quit signalled the tunnel: ${tunnel.signals.join(',')}`)
})

test('P2 no silent quick fallback: Tailscale not signed in and no explicit choice -> needs_setup, no trycloudflare URL', async () => {
  const m = machine({ tailscale: { BackendState: 'NeedsLogin' } })
  const s = await m.remote.set({ enabled: true })
  assert.notEqual(s.provider, 'cloudflare', 'fell back to a Cloudflare quick tunnel without being asked')
  assert.ok(!String(s.url || '').includes('trycloudflare.com'), `advertised an ephemeral quick URL: ${s.url}`)
  assert.equal(s.state, 'needs_setup')
  await m.remote.set({ enabled: false })
})

test('P3 advertised URL is the stable current path (/mcp/current), not a pinned old surface', async () => {
  const m = machine()
  const s = await m.remote.set({ enabled: true })
  assert.match(String(s.url), /\/mcp\/current$/, `advertised ${s.url}`)
  await m.remote.set({ enabled: false })
})

test('P4 the advertised secret is not the internal director token file value (gateway secret separate)', async () => {
  const m = machine()
  const s = await m.remote.set({ enabled: true })
  const internal = fs.readFileSync(path.join(m.dataDir, 'director-token'), 'utf8').trim()
  assert.ok(!String(s.url).split('/').includes(internal), 'public URL carries the internal director token')
  await m.remote.set({ enabled: false })
})
