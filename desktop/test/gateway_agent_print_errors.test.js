// launchd's `print` failing is not "not loaded". Only launchd's own "Could not find service" says there is no job;
// any other failure (permission denied, a timeout — runCmd's code null —, a launchctl that could not run) is unknown,
// and unknown must never make Off look done: uninstall throws, the plist stays, remote access stays on with an error.
// The job keeps running in these fakes the whole time (as it would: only print failed).

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { EventEmitter } = require('node:events')
const { createGatewayAgent } = require('../gateway_agent')
const { createRemote } = require('../remote')

const dirs = []
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d }
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }) })

const PRINT_FAILURES = {
  permission: { code: 1, stdout: '', stderr: 'Could not print service: 1: Operation not permitted' },
  timeout: { code: null, stdout: '', stderr: '/bin/launchctl gave no answer in 15 s' },
  spawn_error: { code: null, stdout: '', stderr: 'spawn /bin/launchctl EACCES' },
  io_error: { code: 5, stdout: '', stderr: 'Input/output error' },
}

/** launchd with one job loaded from `plistPath`; `print` answers `printFails` while it is set. */
function fakeLaunchd({ label, plistPath, program, args }) {
  const state = { loaded: true, printFails: null, calls: [] }
  const run = async (command, argv) => {
    state.calls.push([command, ...argv].join(' '))
    if (command !== '/bin/launchctl') {
      // the backend CLI's `gateway version`
      if (argv.includes('gateway') && argv.includes('version')) return { code: 0, stdout: '{"build":"b1"}', stderr: '' }
      return { code: 127, stdout: '', stderr: 'unexpected' }
    }
    const [verb, ...rest] = argv
    const target = rest[rest.length - 1]
    if (verb === 'print') {
      if (state.printFails) return state.printFails
      if (!state.loaded) return { code: 113, stdout: '', stderr: `Could not find service "${label}" in domain for user gui: 501` }
      return { code: 0, stdout: `${target} = {\n\tpath = ${plistPath}\n\tstate = running\n\tprogram = ${program}\n\targuments = {\n${args.map((a) => `\t\t${a}`).join('\n')}\n\t}\n\tpid = 4711\n}`, stderr: '' }
    }
    if (verb === 'bootout') { state.loaded = false; return { code: 0, stdout: '', stderr: '' } }
    if (verb === 'bootstrap') { state.loaded = true; return { code: 0, stdout: '', stderr: '' } }
    return { code: 1, stdout: '', stderr: 'unknown verb' }
  }
  return { state, run }
}

function setup() {
  const dataDir = tmp('qa-print-data-')
  const agentsDir = tmp('qa-print-agents-')
  const home = tmp('qa-print-home-')
  const bun = path.join(home, '.bun', 'bin', 'bun')
  fs.mkdirSync(path.dirname(bun), { recursive: true }); fs.writeFileSync(bun, '')
  const probe = createGatewayAgent({ dataDir, uid: 501, agentsDir, run: async () => ({ code: 0, stdout: '', stderr: '' }) })
  const program = bun
  const args = [bun, 'run', '/repo/backend-ts/src/index.ts', 'gateway', 'run']
  const l = fakeLaunchd({ label: probe.label, plistPath: probe.plistPath, program, args })
  fs.mkdirSync(agentsDir, { recursive: true }); fs.writeFileSync(probe.plistPath, '<plist/>')
  const gw = path.join(dataDir, 'gateway'); fs.mkdirSync(gw, { recursive: true })
  fs.writeFileSync(path.join(gw, 'config.json'), JSON.stringify({ version: 1, provider: 'external', host: 'mcp.example.com' }))
  fs.writeFileSync(path.join(gw, 'secret'), 'S'.repeat(43))
  fs.writeFileSync(path.join(dataDir, 'remote-access.json'), JSON.stringify({ enabled: true, keep_awake: false }))
  const agent = createGatewayAgent({ dataDir, uid: 501, agentsDir, run: l.run })
  const spawn = () => { const c = new EventEmitter(); c.kill = () => {}; return c }
  const remote = createRemote({ dataDir, backend: { command: 'bun', args: ['run', 'src/index.ts'], cwd: '/repo/backend-ts', bundled: false }, harnessPort: '8391',
    env: { OASIS_CODE_GATEWAY_PORT: '8394' }, run: l.run, spawn, fetchImpl: async () => { throw new TypeError('fetch failed') }, exists: (p) => p === bun, home, uid: 501, agentsDir, pid: 4242 })
  return { agent, remote, l, plistPath: probe.plistPath, dataDir, agentsDir }
}

for (const [kind, failure] of Object.entries(PRINT_FAILURES)) {
  test(`print fails (${kind}) while the job runs: uninstall throws and keeps the plist; Off keeps remote access on with an error`, async () => {
    const s = setup()
    s.l.state.printFails = failure
    await assert.rejects(() => s.agent.uninstall(), 'uninstall must not pass when launchd could not be asked')
    assert.ok(fs.existsSync(s.plistPath), 'the plist of a job that may still run was removed')
    await assert.rejects(() => s.agent.status(null), 'status must not report "not loaded" on an unknown answer')
    const off = await s.remote.set({ enabled: false })
    assert.equal(s.l.state.loaded, true, 'precondition: the job is still loaded')
    assert.notEqual(off.state, 'off', `Off shown while the job may still run (state ${off.state})`)
    assert.equal(off.state, 'error')
    assert.equal(off.enabled, true, 'a failed Off must stay enabled so it can be retried')
    assert.ok(fs.existsSync(s.plistPath))
    // a later status read with the same failure is still not "off"
    assert.equal((await s.remote.status()).state, 'error')
    // launchd answers again: Off now really stops it
    s.l.state.printFails = null
    const off2 = await s.remote.set({ enabled: false })
    assert.equal(off2.state, 'off')
    assert.equal(s.l.state.loaded, false)
    assert.ok(!fs.existsSync(s.plistPath))
  })
}

test('only launchd\'s own "Could not find service" is "not loaded": uninstall of a job that is not there succeeds', async () => {
  const s = setup()
  s.l.state.loaded = false
  await s.agent.uninstall()
  assert.ok(!fs.existsSync(s.plistPath))
  const st = await s.agent.status(null)
  assert.equal(st.loaded, false)
  assert.equal(st.identity, 'none')
})

test('a bootout whose check afterwards cannot ask launchd is not reported as done (the plist stays)', async () => {
  const s = setup()
  let booted = false
  const run = async (c, a) => {
    if (a[0] === 'bootout') { booted = true; return { code: 0, stdout: '', stderr: '' } }   // launchd said ok, but…
    if (a[0] === 'print' && booted) return PRINT_FAILURES.timeout                            // …the check cannot tell
    return s.l.run(c, a)
  }
  const agent = createGatewayAgent({ dataDir: s.dataDir, uid: 501, agentsDir: s.agentsDir, run })
  await assert.rejects(() => agent.uninstall())
  assert.ok(fs.existsSync(s.plistPath))
})

test('launchd lets the job go a moment after bootout answers: uninstall waits for it; a job that never goes still throws', async () => {
  const lingering = (printsLoaded) => {
    const s = setup()
    let left = null
    const run = async (c, a) => {
      if (a[0] === 'bootout') { left = printsLoaded; return { code: 0, stdout: '', stderr: '' } }
      if (a[0] === 'print' && left !== null) {
        if (left > 0) { left -= 1; return s.l.run(c, a) }
        s.l.state.loaded = false
      }
      return s.l.run(c, a)
    }
    return { s, agent: createGatewayAgent({ dataDir: s.dataDir, uid: 501, agentsDir: s.agentsDir, run, unloadWaitMs: 200, pause: async () => {} }) }
  }
  const brief = lingering(2)
  await brief.agent.uninstall()
  assert.ok(!fs.existsSync(brief.s.plistPath))
  const stuck = lingering(Infinity)
  await assert.rejects(() => stuck.agent.uninstall(), /still has it loaded/)
  assert.ok(fs.existsSync(stuck.s.plistPath))
})
