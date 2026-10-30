/** Network and channel faults against REAL ssh/sshd/python: a TCP fault proxy in front of the fixture sshd
 * (latency, refused, silent partition, reset) and the streaming session relay (lost or held answers to a
 * named method; every request frame is logged, so "sent exactly once" is observed on the wire).
 * Assertions use only the public API that existed at c738506 plus the new signal option, so the same file
 * runs against the baseline for old/new evidence. Own PIDs only; nothing outside the fixture is touched. */
import { test, expect } from 'bun:test'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { loopbackFixture, type FixtureOptions } from './loopback.fixture.ts'
import { FaultProxy } from '../../tests/remote/fault_proxy.ts'
import type { TransportOptions } from './types.ts'
const op = () => randomUUID(), b64 = (s: string) => Buffer.from(s).toString('base64'), text = (d: string) => Buffer.from(d, 'base64').toString()
const pct = (values: number[], p: number) => { const s = [...values].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]! * 10) / 10 }
type Settled = { ok: true; value: any } | { ok: false; error: any }
const settle = (p: Promise<unknown>): Promise<Settled> => p.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }))
async function waitFor(condition: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (!condition()) { if (Date.now() > end) throw new Error('timed out waiting for condition'); await Bun.sleep(20) }
}
const alive = (pid: number) => spawnSync('/bin/ps', ['-p', String(pid), '-o', 'pid='], { encoding: 'utf8' }).stdout.trim() !== ''
const channelClosed = (t: unknown) => { const stats = (t as { stats?: () => { channel: unknown } }).stats; return !stats || stats.call(t).channel === null }
const fast: TransportOptions = { retry: { attempts: 8, base_delay_ms: 150, max_delay_ms: 400, budget_ms: 15_000 } }
async function proxied(options: FixtureOptions = {}) {
  const f = await loopbackFixture(options)
  const proxy = await FaultProxy.start(f.port)
  f.trustPort(proxy.port)
  return { f, proxy, transport: (extra: TransportOptions = {}) => f.transport('loopback-a', extra, { port: proxy.port }),
    async close() { try { await f.close() } finally { await proxy.close() } } }
}
const requests = (f: { relayLog(): { event: string; method: string; operation_id: string }[] }, filter: { method?: string; operation_id?: string }) =>
  f.relayLog().filter(e => e.event === 'request' && (!filter.method || e.method === filter.method) && (!filter.operation_id || e.operation_id === filter.operation_id))

test('latency injection (+80 ms RTT through a TCP proxy): a warm RPC costs about one round trip, not a new SSH handshake', async () => {
  const x = await proxied()
  try {
    const t = x.transport()
    const root = await t.openRoot({ path: x.f.project })
    x.proxy.delay_ms = 40
    const times: number[] = []
    for (let i = 0; i < 10; i++) { const begin = performance.now(); await t.request(root, 'files.list', { path: '.' }); times.push(performance.now() - begin) }
    console.log('LATENCY_RTT80', JSON.stringify({ p50_ms: pct(times, 0.5), max_ms: Math.round(Math.max(...times)), sessions: x.f.sessions() }))
    expect(pct(times, 0.5)).toBeLessThan(240)
    expect(x.f.sessions().adapter).toBe(1)
  } finally { await x.close() }
}, 120000)

test('lost answers: a read and operations.status are retried on a new channel; a sent mutation is outcome_unknown and never resent', async () => {
  const f = await loopbackFixture({ relay: true })
  try {
    const t = f.transport('loopback-a', fast)
    const r = await t.openRoot({ path: f.project })
    const lease = await t.request(r, 'leases.acquire', { owner_id: 'loss' }, op())
    const writeOp = op()
    writeFileSync(f.dir + '/DROP_ACK', 'files.write')
    const lost = await settle(t.request(r, 'files.write', { path: 'once.txt', expected_hash: null, data: b64('once'), lease }, writeOp))
    expect(lost.ok).toBe(false)
    expect((lost as { error: unknown }).error).toMatchObject({ code: 'outcome_unknown', status: 'unknown', operation_id: writeOp })
    // operations.status is a safe read: its first answer is lost too, and it still settles through reconnect.
    writeFileSync(f.dir + '/DROP_ACK', 'operations.status')
    expect((await t.request(r, 'operations.status', { operation_id: writeOp })).state).toBe('applied')
    writeFileSync(f.dir + '/DROP_ACK', 'files.read')
    expect(text((await t.request(r, 'files.read', { path: 'once.txt' })).data)).toBe('once')
    expect(requests(f, { operation_id: writeOp })).toHaveLength(1)
    expect(requests(f, { method: 'operations.status' })).toHaveLength(2)
    expect(requests(f, { method: 'files.read' })).toHaveLength(2)
    expect(f.relayLog().filter(e => e.event === 'dropped').map(e => e.method)).toEqual(['files.write', 'operations.status', 'files.read'])
    expect(readFileSync(f.project + '/once.txt', 'utf8')).toBe('once')
  } finally { await f.close() }
}, 120000)

test('network down then back: a read retries with backoff through refused connections and succeeds', async () => {
  const x = await proxied()
  try {
    const t = x.transport(fast)
    const r = await t.openRoot({ path: x.f.project })
    x.proxy.mode = 'refuse'; x.proxy.reset()
    await waitFor(() => channelClosed(t))
    const before = x.proxy.accepted, started = performance.now()
    setTimeout(() => { x.proxy.mode = 'pass' }, 1200)
    const listing = await t.request(r, 'files.list', { path: '.' })
    const elapsed = performance.now() - started
    console.log('NETWORK_DOWN_RECOVERED', JSON.stringify({ elapsed_ms: Math.round(elapsed), connection_attempts: x.proxy.accepted - before }))
    expect(Array.isArray(listing.entries)).toBe(true)
    expect(x.proxy.accepted - before).toBeGreaterThanOrEqual(3)
    expect(elapsed).toBeGreaterThanOrEqual(1100)
  } finally { await x.close() }
}, 120000)

test('retry is bounded: a permanently refused link gets exactly `attempts` connection attempts with growing backoff and an accurate exhausted error', async () => {
  const x = await proxied()
  try {
    const t = x.transport({ retry: { attempts: 4, base_delay_ms: 200, max_delay_ms: 800, budget_ms: 20_000 } })
    const r = await t.openRoot({ path: x.f.project })
    x.proxy.mode = 'refuse'; x.proxy.reset()
    await waitFor(() => channelClosed(t))
    const before = x.proxy.accepted, started = performance.now()
    const result = await settle(t.request(r, 'files.read', { path: 'nothing' }))
    const elapsed = performance.now() - started
    console.log('RETRY_EXHAUSTED', JSON.stringify({ elapsed_ms: Math.round(elapsed), connection_attempts: x.proxy.accepted - before, error: result.ok ? null : { code: result.error.code, delivery: result.error.delivery, message: result.error.message } }))
    expect(result.ok).toBe(false)
    expect((result as { error: unknown }).error).toMatchObject({ code: 'remote_unavailable', status: 'disconnected', delivery: 'not_sent' })
    expect((result as { error: { message: string } }).error.message).toContain('after 4 attempts')
    expect(x.proxy.accepted - before).toBe(4)
    expect(elapsed).toBeGreaterThanOrEqual(700) // equal jitter: at least 100 + 200 + 400 ms of backoff
    expect(elapsed).toBeLessThan(20_000)
  } finally { await x.close() }
}, 120000)

test('probe() has its own total bound: a silent partition is a retryable network failure, never "unsupported", and the same transport probes once the link returns', async () => {
  const x = await proxied()
  try {
    const t = x.transport({ rpc_timeout_ms: 1500, retry: { attempts: 10, base_delay_ms: 150, max_delay_ms: 400, budget_ms: 4000 } })
    x.proxy.mode = 'blackhole'
    const started = performance.now()
    const result = await settle(t.probe())
    const elapsed = performance.now() - started
    console.log('PROBE_PARTITION', JSON.stringify({ elapsed_ms: Math.round(elapsed), connection_attempts: x.proxy.accepted, error: result.ok ? null : { code: result.error.code, message: result.error.message } }))
    expect(result.ok).toBe(false)
    expect((result as { error: unknown }).error).toMatchObject({ code: 'remote_unavailable', status: 'disconnected' })
    expect(elapsed).toBeLessThan(4000 + 1500)
    expect(x.proxy.accepted).toBeGreaterThanOrEqual(2)
    x.proxy.mode = 'pass'; x.proxy.reset()
    expect((await t.probe()).exec).toBe(true)
  } finally { await x.close() }
}, 120000)

test('auth and host-key failures are never retried: exactly one connection attempt each', async () => {
  const x = await proxied()
  try {
    execFileSync('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', x.f.dir + '/other_host'])
    execFileSync('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', x.f.dir + '/stranger'])
    writeFileSync(x.f.dir + '/wrong_known_hosts', `[127.0.0.1]:${x.proxy.port} ${readFileSync(x.f.dir + '/other_host.pub', 'utf8')}`, { mode: 0o600 })
    let before = x.proxy.accepted
    await expect(x.f.transport('loopback-a', { ...fast, known_hosts_file: x.f.dir + '/wrong_known_hosts' }, { port: x.proxy.port }).probe()).rejects.toMatchObject({ code: 'host_verification_required' })
    expect(x.proxy.accepted - before).toBe(1)
    before = x.proxy.accepted
    await expect(x.f.transport('loopback-a', fast, { port: x.proxy.port, identity_file: x.f.dir + '/stranger' }).probe()).rejects.toMatchObject({ code: 'auth_required' })
    expect(x.proxy.accepted - before).toBe(1)
  } finally { await x.close() }
}, 120000)

test('a mutation issued while the network is down is provably unsent, retried, and applied exactly once after recovery', async () => {
  const x = await proxied({ relay: true })
  try {
    const t = x.transport(fast)
    const r = await t.openRoot({ path: x.f.project })
    const lease = await t.request(r, 'leases.acquire', { owner_id: 'down' }, op())
    x.proxy.mode = 'refuse'; x.proxy.reset()
    await waitFor(() => channelClosed(t))
    setTimeout(() => { x.proxy.mode = 'pass' }, 1000)
    const writeOp = op()
    const receipt = await t.request(r, 'files.write', { path: 'after-outage.txt', expected_hash: null, data: b64('applied once'), lease }, writeOp)
    expect(receipt.state).toBe('applied')
    expect(requests(x.f, { operation_id: writeOp })).toHaveLength(1)
    expect(readFileSync(x.f.project + '/after-outage.txt', 'utf8')).toBe('applied once')
  } finally { await x.close() }
}, 120000)

test('a silent partition under an idle channel fails the liveness ping, not the mutation; the mutation is sent once after the link returns', async () => {
  const x = await proxied({ relay: true })
  try {
    const t = x.transport({ idle_ping_ms: 300, rpc_timeout_ms: 1500, retry: { attempts: 10, base_delay_ms: 150, max_delay_ms: 400, budget_ms: 20_000 } })
    const r = await t.openRoot({ path: x.f.project })
    const lease = await t.request(r, 'leases.acquire', { owner_id: 'idle' }, op())
    await Bun.sleep(500)
    x.proxy.mode = 'blackhole'
    setTimeout(() => { x.proxy.mode = 'pass' }, 2500)
    const writeOp = op(), started = performance.now()
    const receipt = await t.request(r, 'files.write', { path: 'after-partition.txt', expected_hash: null, data: b64('once'), lease }, writeOp)
    console.log('PARTITION_PING', JSON.stringify({ elapsed_ms: Math.round(performance.now() - started) }))
    expect(receipt.state).toBe('applied')
    expect(performance.now() - started).toBeGreaterThanOrEqual(2400)
    expect(requests(x.f, { operation_id: writeOp })).toHaveLength(1)
  } finally { await x.close() }
}, 120000)

test('link reset while a large mutation upload is still outstanding: no uncaught stream error, outcome_unknown, never replayed', async () => {
  const x = await proxied({ relay: true })
  const uncaught: unknown[] = [], onUncaught = (error: unknown) => { uncaught.push(error) }
  process.on('uncaughtException', onUncaught)
  try {
    const t = x.transport(fast)
    const r = await t.openRoot({ path: x.f.project })
    const lease = await t.request(r, 'leases.acquire', { owner_id: 'upload' }, op())
    x.proxy.stall() // TCP backpressure: ssh's window fills and it stops draining our stdin mid-frame
    const writeOp = op(), data = Buffer.alloc(2 * 1024 * 1024, 'u').toString('base64') // past ssh's 2 MiB channel window
    const upload = settle(t.request(r, 'files.write', { path: 'upload.bin', expected_hash: null, data, lease }, writeOp))
    await Bun.sleep(400)
    x.proxy.reset() // the link dies mid-upload: ssh exits, our stdin gets EPIPE asynchronously
    const result = await upload
    expect(result.ok).toBe(false)
    expect((result as { error: unknown }).error).toMatchObject({ code: 'outcome_unknown', status: 'unknown', operation_id: writeOp, delivery: 'unknown' })
    x.proxy.resume()
    // The truncated frame never reached the adapter; reconciliation is a safe read, the write is not resent.
    expect((await t.request(r, 'operations.status', { operation_id: writeOp })).state).toBe('not_found')
    expect(requests(x.f, { operation_id: writeOp })).toHaveLength(0)
    expect(existsSync(x.f.project + '/upload.bin')).toBe(false)
    expect((await t.request(r, 'files.write', { path: 'after-reset.txt', expected_hash: null, data: b64('ok'), lease }, op())).state).toBe('applied')
    await Bun.sleep(100)
    expect(uncaught).toEqual([])
  } finally { process.off('uncaughtException', onUncaught); await x.close() }
}, 120000)

test('replacing the channel (link reset mid-job) never stops a durable job; status reconnects and reports its true exit and full log', async () => {
  const x = await proxied()
  try {
    const t = x.transport(fast)
    const r = await t.openRoot({ path: x.f.project })
    const lease = await t.request(r, 'leases.acquire', { owner_id: 'durable' }, op())
    const job = await t.request(r, 'jobs.start', { command: "sleep 1.5; printf survived; exit 7", lease }, op())
    const running = `${r.state_path}/jobs/${job.job_id}/running.json`
    await waitFor(() => existsSync(running))
    const supervisor = JSON.parse(readFileSync(running, 'utf8')).supervisor_pid as number
    x.proxy.reset()
    let status = await t.request(r, 'jobs.status', { job_id: job.job_id })
    expect(['running', 'exited']).toContain(status.state)
    for (let i = 0; i < 100 && status.state !== 'exited'; i++) { await Bun.sleep(100); status = await t.request(r, 'jobs.status', { job_id: job.job_id }) }
    expect(status).toMatchObject({ state: 'exited', exit_code: 7 })
    const out = await t.request(r, 'jobs.read', { job_id: job.job_id, stream: 'stdout' })
    expect(text(out.data)).toBe('survived'); expect(out.log_complete).toBe(true)
    expect(JSON.parse(readFileSync(running, 'utf8')).supervisor_pid).toBe(supervisor)
  } finally { await x.close() }
}, 120000)

test('disconnect() ends in-flight requests and pending backoff at once, and nothing reconnects afterwards', async () => {
  const x = await proxied({ relay: true })
  try {
    const t = x.transport({ retry: { attempts: 10, base_delay_ms: 300, max_delay_ms: 1000, budget_ms: 30_000 } })
    const r = await t.openRoot({ path: x.f.project })
    const lease = await t.request(r, 'leases.acquire', { owner_id: 'bye' }, op())
    writeFileSync(x.f.dir + '/HOLD', 'files.write')
    const writeOp = op()
    const write = settle(t.request(r, 'files.write', { path: 'held.txt', expected_hash: null, data: b64('held'), lease }, writeOp))
    await waitFor(() => requests(x.f, { operation_id: writeOp }).length === 1)
    const queued = settle(t.request(r, 'files.list', { path: '.' }))
    await Bun.sleep(100)
    let started = performance.now()
    await t.disconnect()
    const [w, q] = await Promise.all([write, queued])
    expect(performance.now() - started).toBeLessThan(1500)
    expect(w.ok).toBe(false); expect((w as { error: unknown }).error).toMatchObject({ code: 'outcome_unknown', status: 'unknown', operation_id: writeOp })
    expect(q.ok).toBe(false); expect((q as { error: unknown }).error).toMatchObject({ code: 'remote_unavailable', status: 'disconnected' })
    unlinkSync(x.f.dir + '/HOLD')
    // Pending backoff: a second transport is mid-retry against a refused link when it is disconnected.
    const t2 = x.transport({ retry: { attempts: 10, base_delay_ms: 300, max_delay_ms: 1000, budget_ms: 30_000 } })
    const r2 = await t2.openRoot({ path: x.f.project })
    x.proxy.mode = 'refuse'; x.proxy.reset()
    await waitFor(() => channelClosed(t2))
    const pending = settle(t2.request(r2, 'files.list', { path: '.' }))
    await Bun.sleep(500)
    started = performance.now()
    await t2.disconnect()
    const p = await pending
    expect(performance.now() - started).toBeLessThan(1000)
    expect(p.ok).toBe(false); expect((p as { error: unknown }).error).toMatchObject({ code: 'remote_unavailable', message: 'Transport disconnected' })
    const attempts = x.proxy.accepted
    x.proxy.mode = 'pass'
    await Bun.sleep(1500)
    expect(x.proxy.accepted).toBe(attempts)
    await expect(t2.request(r2, 'files.list', { path: '.' })).rejects.toMatchObject({ code: 'remote_unavailable' })
    expect(x.proxy.accepted).toBe(attempts)
    // The adapter processes behind both closed channels exit; the held write was applied remotely.
    await waitFor(() => x.f.adapterPids().every(pid => !alive(pid)), 10_000)
    expect(readFileSync(x.f.project + '/held.txt', 'utf8')).toBe('held')
  } finally { await x.close() }
}, 120000)

test('abort: while joining establishment and while queued behind the mutation barrier a mutation is never sent; an in-flight read is abandoned without closing the channel', async () => {
  const f = await loopbackFixture({ relay: true })
  try {
    const owner = f.transport()
    const r = await owner.openRoot({ path: f.project })
    const lease = await owner.request(r, 'leases.acquire', { owner_id: 'abort' }, op())
    // (a) a fresh transport is still probing/establishing when the caller aborts
    const fresh = f.transport(), a = new AbortController(), opA = op()
    const pa = settle(fresh.request(r, 'files.write', { path: 'abort-a', expected_hash: null, data: b64('a'), lease }, opA, { signal: a.signal }))
    setTimeout(() => a.abort(), 30)
    const ra = await pa
    expect(ra.ok).toBe(false); expect((ra as { error: unknown }).error).toMatchObject({ code: 'cancelled', delivery: 'not_sent', operation_id: opA })
    // The abort cancels only the request: the fresh transport's establishment may go on (the transport is used again
    // below) and, on a loaded machine, open its adapter session late. f.sessions() counts EVERY adapter session (owner
    // and fresh), so let the fresh transport finish establishing here (a probe joins or redoes it) before (c) snapshots
    // the count; otherwise a late fresh session is miscounted as the owner's channel having been replaced.
    await fresh.check()
    // (b) queued behind an in-flight (held) read: the barrier keeps the mutation unsent until the abort
    writeFileSync(f.dir + '/HOLD', 'files.read')
    const held = settle(owner.request(r, 'files.read', { path: 'missing.txt' }))
    await waitFor(() => requests(f, { method: 'files.read' }).length === 1)
    const b = new AbortController(), opB = op()
    const pb = settle(owner.request(r, 'files.write', { path: 'abort-b', expected_hash: null, data: b64('b'), lease }, opB, { signal: b.signal }))
    await Bun.sleep(150); b.abort()
    const rb = await pb
    expect(rb.ok).toBe(false); expect((rb as { error: unknown }).error).toMatchObject({ code: 'cancelled', delivery: 'not_sent', operation_id: opB })
    // (c) a pipelined read already written behind the held one is abandoned; its late answer is discarded
    const sessions = f.sessions().adapter
    const ownerChannel = owner.stats().channel?.pid
    expect(ownerChannel).toBeNumber()
    const c = new AbortController()
    const pc = settle(owner.request(r, 'files.list', { path: '.' }, undefined, { signal: c.signal }))
    await waitFor(() => requests(f, { method: 'files.list' }).length === 1)
    c.abort()
    const rc = await pc
    expect(rc.ok).toBe(false); expect((rc as { error: unknown }).error).toMatchObject({ code: 'cancelled', delivery: 'unknown' })
    unlinkSync(f.dir + '/HOLD')
    expect(((await held) as { error: unknown }).error).toMatchObject({ code: 'not_found' })
    expect((await owner.request(r, 'files.list', { path: '.' })).entries.some(e => e.path.endsWith('abort-b'))).toBe(false)
    expect(f.sessions().adapter).toBe(sessions)
    // and owner-specific: the abandoned read left the owner's own channel (same local ssh PID) open
    expect(owner.stats().channel?.pid).toBe(ownerChannel)
    // neither aborted mutation ever crossed the wire, and the fresh transport still works afterwards
    expect((await fresh.request(r, 'files.list', { path: '.' })).entries.some(e => e.path.endsWith('abort-a'))).toBe(false)
    for (const id of [opA, opB]) expect(requests(f, { operation_id: id })).toHaveLength(0)
    expect(existsSync(f.project + '/abort-a') || existsSync(f.project + '/abort-b')).toBe(false)
  } finally { await f.close() }
}, 120000)

test('every call has a hard wall-clock bound: a stuck answer ends at budget_ms (read: remote_unavailable, mutation: outcome_unknown)', async () => {
  const f = await loopbackFixture({ relay: true })
  try {
    const t = f.transport('loopback-a', { rpc_timeout_ms: 10_000, retry: { budget_ms: 1200 } })
    const r = await t.openRoot({ path: f.project })
    const lease = await t.request(r, 'leases.acquire', { owner_id: 'deadline' }, op())
    writeFileSync(f.dir + '/HOLD', 'files.read')
    let started = performance.now()
    const read = await settle(t.request(r, 'files.read', { path: 'missing.txt' }))
    let elapsed = performance.now() - started
    expect(read.ok).toBe(false); expect((read as { error: unknown }).error).toMatchObject({ code: 'remote_unavailable', delivery: 'unknown' })
    expect(elapsed).toBeGreaterThanOrEqual(1100); expect(elapsed).toBeLessThan(4000)
    unlinkSync(f.dir + '/HOLD')
    writeFileSync(f.dir + '/HOLD', 'files.write')
    const writeOp = op()
    started = performance.now()
    const write = await settle(t.request(r, 'files.write', { path: 'late.txt', expected_hash: null, data: b64('late'), lease }, writeOp))
    elapsed = performance.now() - started
    expect(write.ok).toBe(false); expect((write as { error: unknown }).error).toMatchObject({ code: 'outcome_unknown', status: 'unknown', operation_id: writeOp })
    expect(elapsed).toBeLessThan(4000)
    unlinkSync(f.dir + '/HOLD')
    expect((await t.request(r, 'operations.status', { operation_id: writeOp })).state).toBe('applied')
    expect(requests(f, { operation_id: writeOp })).toHaveLength(1)
  } finally { await f.close() }
}, 120000)

test('backend death: the orphaned channel and its remote adapter exit by themselves, the durable job completes, and a new transport recovers it', async () => {
  const f = await loopbackFixture()
  try {
    const script = f.dir + '/backend-child.ts', out = f.dir + '/backend-child.json'
    writeFileSync(script, `import { writeFileSync } from 'node:fs'
import { SshTransport } from ${JSON.stringify(new URL('./transport.ts', import.meta.url).pathname)}
const [config, known, key, python, project, out] = process.argv.slice(2)
const t = new SshTransport({ destination: 'loopback-a', identity_file: key }, { config_file: config, known_hosts_file: known, python, rpc_timeout_ms: 10000 })
const root = await t.openRoot({ path: project })
const lease = await t.request(root, 'leases.acquire', { owner_id: 'backend_child' }, 'backend_lease_op')
const job = await t.request(root, 'jobs.start', { command: 'sleep 2; printf survived', lease }, 'backend_job_op')
const stats = typeof (t as any).stats === 'function' ? (t as any).stats() : null
writeFileSync(out, JSON.stringify({ job_id: job.job_id, ssh_pid: stats?.channel?.pid ?? null, root }))
setInterval(() => {}, 1000)
`)
    const child = spawn(process.execPath, ['run', script, f.dir + '/ssh_config', f.dir + '/known_hosts', f.dir + '/client', f.python, f.project, out], { stdio: 'ignore' })
    const identity = () => spawnSync('/bin/ps', ['-ww', '-p', String(child.pid), '-o', 'lstart=', '-o', 'command='], { encoding: 'utf8' }).stdout.trim()
    const recorded = identity()
    expect(recorded).toContain(script)
    try { await waitFor(() => existsSync(out), 30_000) }
    catch (error) { if (identity() === recorded) child.kill('SIGTERM'); throw error }
    const info = JSON.parse(readFileSync(out, 'utf8')) as { job_id: string; ssh_pid: number | null; root: { path: string; state_path: string; root_id: string; generation: string } }
    const adapters = f.adapterPids()
    expect(identity()).toBe(recorded) // exact recorded PID + start time + command, then crash it
    child.kill('SIGKILL')
    await new Promise<void>(resolve => child.once('close', () => resolve()))
    if (info.ssh_pid) await waitFor(() => !alive(info.ssh_pid!), 10_000)
    await waitFor(() => adapters.every(pid => !alive(pid)), 10_000)
    const t = f.transport()
    const recovered = await t.request(info.root, 'jobs.recover', { operation_id: 'backend_job_op' })
    expect(recovered.job_id).toBe(info.job_id)
    let status = recovered
    for (let i = 0; i < 100 && status.state !== 'exited'; i++) { await Bun.sleep(100); status = await t.request(info.root, 'jobs.status', { job_id: info.job_id }) }
    expect(status).toMatchObject({ state: 'exited', exit_code: 0 })
    expect(text((await t.request(info.root, 'jobs.read', { job_id: info.job_id, stream: 'stdout' })).data)).toBe('survived')
    console.log('BACKEND_DEATH', JSON.stringify({ child_pid: child.pid, ssh_pid: info.ssh_pid, adapter_pids: adapters, job: status.state, exit_code: status.exit_code }))
  } finally { await f.close() }
}, 120000)
