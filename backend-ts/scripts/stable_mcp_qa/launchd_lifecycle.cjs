// Real launchd lifecycle of the gateway agent, isolated: a temporary data dir (so its own label
// dev.oasis-code.gateway.<hash of that dir>), a temporary agentsDir (never ~/Library/LaunchAgents), free loopback
// ports, provider `external` with an .invalid host (no tunnel started, nothing public). Uses the real desktop modules
// (remote.js, gateway_agent.js) with a real command runner. Only this label is ever bootstrapped/booted out; the only
// process killed by PID is the one launchd reports for this label. Writes JSON evidence lines to stdout.
// Usage: QA_REPO=<clone> QA_RUN=<dir> GW_PORT=<free> HARNESS_PORT=<free> node launchd_lifecycle.cjs
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const REPO = process.env.QA_REPO
const RUN = process.env.QA_RUN
const GW_PORT = process.env.GW_PORT
const HARNESS_PORT = process.env.HARNESS_PORT
if (!REPO || !RUN || !GW_PORT || !HARNESS_PORT) throw new Error('QA_REPO, QA_RUN, GW_PORT, HARNESS_PORT')
const { createRemote } = require(path.join(REPO, 'desktop', 'remote.js'))
const { labelFor } = require(path.join(REPO, 'desktop', 'gateway_agent.js'))

const dataDir = path.join(RUN, 'data'); const userData = path.join(RUN, 'user'); const agentsDir = path.join(RUN, 'LaunchAgents')
for (const d of [dataDir, userData, agentsDir]) fs.mkdirSync(d, { recursive: true })
const BK = path.join(REPO, 'backend-ts')
const BUN = process.env.BUN || require('node:child_process').execFileSync('/usr/bin/which', ['bun'], { encoding: 'utf8' }).trim()
const uid = process.getuid()
const label = labelFor(dataDir)
const service = `gui/${uid}/${label}`
const env = { PATH: `${path.dirname(BUN)}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: process.env.HOME, OASIS_CODE_DATA: dataDir, OASIS_CODE_USER_DATA: userData,
  OASIS_CODE_PORT: HARNESS_PORT, OASIS_CODE_GATEWAY_PORT: GW_PORT, OASIS_CODE_DIRECTOR_PORT: process.env.DIRECTOR_PORT, OASIS_CODE_BRIDGE_PORT: process.env.BRIDGE_PORT }
const calls = []

function runCmd(command, args, { cwd, env: e, input = '', timeoutMs = 30_000 } = {}) {
  calls.push([command, ...args].join(' '))
  return new Promise((resolve) => {
    let child
    try { child = spawn(command, args, { cwd, env: e || env, stdio: ['pipe', 'pipe', 'pipe'] }) } catch (error) { resolve({ code: null, stdout: '', stderr: error.message }); return }
    let out = ''; let err = ''; let settled = false
    const done = (code) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ code, stdout: out, stderr: err }) }
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} err += `${command} gave no answer`; done(null) }, timeoutMs)
    child.stdout.on('data', (d) => { out += d }); child.stderr.on('data', (d) => { err += d })
    child.on('error', (error) => { err += error.message; done(null) }); child.on('close', done)
    child.stdin.on('error', () => {}); child.stdin.end(input)
  })
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ev = (step, data) => console.log(JSON.stringify({ at: new Date().toISOString(), step, ...data }))
const lc = (verb) => calls.filter((c) => c.startsWith(`/bin/launchctl ${verb}`)).length
async function launchd() {
  const r = await runCmd('/bin/launchctl', ['print', service], { timeoutMs: 10_000 })
  const pid = /^\s*pid = (\d+)/m.exec(r.stdout); const st = /^\s*state = (.+)$/m.exec(r.stdout); const p = /^\s*path = (.+)$/m.exec(r.stdout)
  return { code: r.code, pid: pid ? Number(pid[1]) : null, state: st ? st[1] : null, path: p ? p[1].trim() : null, notFound: /Could not find service/.test(r.stderr) }
}
async function health() { try { const r = await fetch(`http://127.0.0.1:${GW_PORT}/healthz`, { signal: AbortSignal.timeout(1500) }); return await r.json() } catch (e) { return { error: e.message } } }
async function waitFor(fn, ms = 40_000) { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(500) } return v }
const makeRemote = () => createRemote({ dataDir, backend: { command: BUN, args: ['run', 'src/index.ts'], cwd: BK, bundled: false }, harnessPort: HARNESS_PORT,
  env, log: (l) => ev('log', { line: l }), spawn: (c, a, o) => spawn(c, a, o), run: runCmd, uid, agentsDir, home: process.env.HOME, pid: process.pid })

;(async () => {
  let ok = true
  const check = (name, cond, data = {}) => { if (!cond) ok = false; ev('check', { name, pass: !!cond, ...data }) }
  ev('env', { label, agentsDir: agentsDir.replace(RUN, '$QA_RUN'), gw_port: GW_PORT, harness_port: HARNESS_PORT })
  const pre = await launchd()
  check('label not loaded before (no collision)', pre.notFound, { code: pre.code })
  if (!pre.notFound) { ev('abort', { why: 'label already exists: refusing to touch it' }); process.exit(2) }
  try {
    let remote = makeRemote()
    let s = await remote.configure({ provider: 'external', host: 'qa-b2-launchd.invalid' })
    check('configure external (enabled=false): nothing loaded', (await launchd()).notFound && lc('bootstrap') === 0, { state: s.state })
    s = await remote.set({ enabled: true })
    const j1 = await waitFor(async () => { const l = await launchd(); return l.pid ? l : null })
    const h1 = await waitFor(async () => { const h = await health(); return h.instance ? h : null })
    check('install: loaded from temp plist, running pid, healthz answers', j1 && j1.path === path.join(agentsDir, `${label}.plist`) && h1 && h1.server === 'oasis-code gateway', { pid: j1 && j1.pid, state: s.state, error: s.error, plist_in: (j1 && j1.path || '').replace(RUN, '$QA_RUN') })
    const plist = fs.readFileSync(path.join(agentsDir, `${label}.plist`), 'utf8')
    const secret = fs.readFileSync(path.join(dataDir, 'gateway', 'secret'), 'utf8').trim()
    check('plist holds no secret / no ambient env', !plist.includes(secret) && !/TUNNEL_TOKEN|API_KEY/.test(plist))
    await sleep(3000)
    s = await remote.status(); ev('status_after_install', { state: s.state, error: s.error, url_redacted: s.url && s.url.replace(secret, '<secret>') })
    const gs = JSON.parse(fs.readFileSync(path.join(dataDir, 'gateway', 'status.json'), 'utf8'))
    check('status.json pid == launchd pid', gs.pid === j1.pid, { gw_pid: gs.pid, public: gs.public, backend: gs.backend })

    // resume on a fresh controller (the app opened again): no-op
    const before = { bs: lc('bootstrap'), bo: lc('bootout'), ks: lc('kickstart') }
    remote = makeRemote(); await remote.resume()
    const j2 = await launchd()
    check('resume (app reopened, same code): no bootstrap/bootout/kickstart, same pid', j2.pid === j1.pid && lc('bootstrap') === before.bs && lc('bootout') === before.bo && lc('kickstart') === before.ks, { pid: j2.pid })

    // app quits: remote.stop() — the gateway stays
    await remote.stop()
    await sleep(1500)
    const j3 = await launchd(); const h3 = await health()
    check('app.stop (controller quit): job still running, same pid, healthz same instance', j3.pid === j1.pid && h3.instance === h1.instance, { pid: j3.pid })

    // the gateway process dies (exact launchd pid): KeepAlive brings it back
    process.kill(j1.pid, 'SIGKILL'); ev('killed', { pid: j1.pid, signal: 'SIGKILL' })
    const j4 = await waitFor(async () => { const l = await launchd(); return l.pid && l.pid !== j1.pid ? l : null }, 40_000)
    const h4 = await waitFor(async () => { const h = await health(); return h.instance && h.instance !== h1.instance ? h : null })
    check('KeepAlive: new pid after crash, healthz answers again', j4 && j4.pid && h4 && h4.instance, { new_pid: j4 && j4.pid })
    const secret2 = fs.readFileSync(path.join(dataDir, 'gateway', 'secret'), 'utf8').trim()
    check('secret (URL) unchanged across gateway crash/restart', secret2 === secret)

    // new setup while on: kickstart onto it
    remote = makeRemote()
    s = await remote.configure({ provider: 'external', host: 'qa-b2-launchd2.invalid' })
    const j5 = await waitFor(async () => { const l = await launchd(); return l.pid && l.pid !== (j4 && j4.pid) ? l : null }, 40_000)
    await waitFor(async () => { try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'gateway', 'status.json'), 'utf8')).host === 'qa-b2-launchd2.invalid' } catch { return false } })
    s = await remote.status()
    check('configure while on: kickstart → new pid serving the new host; state not "connected"', j5 && j5.pid && s.state !== 'connected' && lc('kickstart') >= 1, { pid: j5 && j5.pid, state: s.state, error: s.error })

    // off: bootout + plist removed, port free; off again: no-op
    s = await remote.set({ enabled: false })
    const j6 = await launchd(); const h6 = await health()
    check('Off: not loaded, plist gone, port closed, state off', j6.notFound && !fs.existsSync(path.join(agentsDir, `${label}.plist`)) && h6.error && s.state === 'off', { state: s.state, error: s.error })
    s = await remote.set({ enabled: false })
    check('Off again: still off, no error', s.state === 'off', { state: s.state })
    // on again after off
    s = await remote.set({ enabled: true })
    const j7 = await waitFor(async () => { const l = await launchd(); return l.pid ? l : null })
    check('On again after Off: reinstalled', j7 && j7.pid, { pid: j7 && j7.pid, state: s.state })
    s = await remote.set({ enabled: false })
    check('final Off', (await launchd()).notFound && s.state === 'off', { state: s.state })
  } catch (error) {
    ok = false; ev('exception', { message: error.message })
  } finally {
    const l = await launchd()
    if (!l.notFound && l.path === path.join(agentsDir, `${label}.plist`)) {
      const r = await runCmd('/bin/launchctl', ['bootout', service]); ev('cleanup_bootout', { code: r.code })
    }
    const fin = await launchd()
    ev('cleanup_final', { label_loaded: !fin.notFound, healthz: (await health()).error ? 'closed' : 'OPEN' })
    ev('summary', { ok, launchctl_calls: calls.filter((c) => c.startsWith('/bin/launchctl')).map((c) => c.replace(/\/[^ ]*LaunchAgents\//, '$QA_RUN/LaunchAgents/')) })
    process.exit(ok ? 0 : 1)
  }
})()
