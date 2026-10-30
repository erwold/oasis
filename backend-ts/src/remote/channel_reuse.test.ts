/** Persistent owned exec channel: real system sshd/ssh/python only (isolated fixture HOME/keys/config).
 * Session counts come from the fixture sshd's ForceCommand log, not from transport internals, so the
 * same file runs unchanged against the per-RPC baseline (c738506) for old/new evidence. */
import { test, expect } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { loopbackFixture } from './loopback.fixture.ts'
import { externalStatePython } from './external_state.fixture.ts'
const op = () => randomUUID(), b64 = (s: string) => Buffer.from(s).toString('base64'), text = (d: string) => Buffer.from(d, 'base64').toString()
const pct = (values: number[], p: number) => { const s = [...values].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]! * 10) / 10 }

test('warm channel: probe, openRoot and 40 mixed RPCs use one challenge and ONE adapter bootstrap (baseline: an SSH session per RPC)', async () => {
  const f = await loopbackFixture()
  try {
    const t = f.transport()
    const started = performance.now(); await t.probe(); const probe_ms = performance.now() - started
    const root = await t.openRoot({ path: f.project })
    const lease = await t.request(root, 'leases.acquire', { owner_id: 'reuse' }, op())
    const write = await t.request(root, 'files.write', { path: 'reuse.txt', expected_hash: null, data: b64('warm channel\n'), lease }, op())
    const job = await t.request(root, 'jobs.start', { command: "printf 'reused'", lease }, op())
    const timings: number[] = []
    for (let i = 0; i < 40; i++) {
      const begin = performance.now()
      if (i % 4 === 0) expect((await t.request(root, 'files.stat', { path: 'reuse.txt' })).sha256).toBe(write.after_sha256!)
      else if (i % 4 === 1) expect(text((await t.request(root, 'files.read', { path: 'reuse.txt' })).data)).toBe('warm channel\n')
      else if (i % 4 === 2) expect((await t.request(root, 'files.list', { path: '.' })).entries.some(e => e.path.endsWith('reuse.txt'))).toBe(true)
      else expect((await t.request(root, 'jobs.status', { job_id: job.job_id })).job_id).toBe(job.job_id)
      timings.push(performance.now() - begin)
    }
    const sessions = f.sessions()
    console.log('CHANNEL_REUSE', JSON.stringify({ probe_ms: Math.round(probe_ms), warm_p50_ms: pct(timings, 0.5), warm_p95_ms: pct(timings, 0.95), warm_total_ms: Math.round(timings.reduce((a, b) => a + b, 0)), sessions }))
    expect(sessions.challenge).toBe(1)
    expect(sessions.adapter).toBe(1)
  } finally { await f.close() }
}, 120000)

test('concurrent batches for two roots share one channel; every answer carries its own request and root identity', async () => {
  const f = await loopbackFixture()
  try {
    const t = f.transport(), other = f.dir + '/project-b'
    mkdirSync(other, { mode: 0o700 })
    const [a, b] = await Promise.all([t.openRoot({ path: f.project }), t.openRoot({ path: other })])
    expect(a.root_id).not.toBe(b.root_id)
    const [la, lb] = await Promise.all([t.request(a, 'leases.acquire', { owner_id: 'root_a' }, op()), t.request(b, 'leases.acquire', { owner_id: 'root_b' }, op())])
    await Promise.all([...Array(6).keys()].flatMap(i => [
      t.request(a, 'files.write', { path: `f${i}.txt`, expected_hash: null, data: b64(`A-${i}`), lease: la }, op()),
      t.request(b, 'files.write', { path: `f${i}.txt`, expected_hash: null, data: b64(`B-${i}`), lease: lb }, op()),
    ]))
    const reads = [...Array(48).keys()].map(n => {
      const root = n % 2 ? b : a, name = n % 2 ? 'B' : 'A', i = n % 6
      return t.request(root, 'files.read', { path: `f${i}.txt` }).then(page => text(page.data) === `${name}-${i}`)
    })
    // A stale pin in the middle of the pipeline is refused alone and leaves no root context behind.
    const stale = t.request({ ...a, generation: 'stale' }, 'files.read', { path: 'f0.txt' }).then(() => 'resolved', (e: { code: string }) => e.code)
    const lists = [a, b].map(root => t.request(root, 'files.list', { path: '.' }).then(page => page.entries.length))
    expect(await Promise.all(reads)).toEqual(Array(48).fill(true))
    expect(await stale).toBe('root_changed')
    expect(await Promise.all(lists)).toEqual([6, 6])
    expect(readFileSync(other + '/f3.txt', 'utf8')).toBe('B-3')
    expect(f.sessions().adapter).toBe(1)
  } finally { await f.close() }
}, 120000)

test('a failed openRoot on a warm channel never runs the method under the previous batch root context', async () => {
  const f = await loopbackFixture()
  try {
    // REMOTE_CHANNEL_ADAPTER may name another adapter source to show what this test guards against.
    const t = f.transport('loopback-a', { python: externalStatePython(f.dir, f.dir + '/unused-shared', process.env.REMOTE_CHANNEL_ADAPTER) })
    const r = await t.openRoot({ path: f.project })
    const lease = await t.request(r, 'leases.acquire', { owner_id: 'context' }, op())
    await t.request(r, 'files.list', { path: '.' }) // the channel now holds a valid context for r
    // Only the persisted supervisor copy is corrupted: openRoot fails although the pinned identity is intact.
    const script = r.state_path + '/' + readdirSync(r.state_path).find(n => n.startsWith('adapter-') && n.endsWith('.py'))!
    const original = readFileSync(script)
    writeFileSync(script, 'raise RuntimeError("corrupted adapter")')
    await expect(t.request(r, 'files.write', { path: 'must-not-exist', expected_hash: null, data: b64('x'), lease }, op())).rejects.toMatchObject({ code: 'protocol_mismatch' })
    expect(existsSync(f.project + '/must-not-exist')).toBe(false)
    writeFileSync(script, original)
    expect((await t.request(r, 'files.write', { path: 'after-repair', expected_hash: null, data: b64('ok'), lease }, op())).state).toBe('applied')
  } finally { await f.close() }
}, 120000)

test('check() is a fresh framed probe on the owned channel; it reconnects only after that channel is gone', async () => {
  const f = await loopbackFixture()
  try {
    const t = f.transport()
    await t.probe()
    const before = f.sessions()
    for (let i = 0; i < 5; i++) expect((await t.check()).exec).toBe(true)
    expect(f.sessions()).toEqual(before)
    // Kill only this transport's own ssh client: exact PID from stats, command identity verified first.
    const pid = t.stats().channel!.pid!
    const command = execFileSync('/bin/ps', ['-ww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim()
    expect(command.startsWith('/usr/bin/ssh -F ' + f.dir + '/ssh_config')).toBe(true)
    process.kill(pid, 'SIGTERM')
    for (let i = 0; i < 100 && t.stats().channel; i++) await Bun.sleep(20)
    expect((await t.check()).exec).toBe(true)
    expect(f.sessions()).toEqual({ ...before, adapter: before.adapter + 1, total: before.total + 1 })
    expect(t.stats()).toMatchObject({ channels_opened: 2, channel_failures: 1, challenges: 1 })
  } finally { await f.close() }
}, 120000)
