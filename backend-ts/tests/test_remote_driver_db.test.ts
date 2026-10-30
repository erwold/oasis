import { expect, test } from 'bun:test'
import { connect } from '../src/db/database.ts'
import * as repo from '../src/db/repo.ts'
import { createTarget } from '../src/db/remote_repo.ts'
import { RemoteExecutionDriver, type RemoteDriverCallbacks } from '../src/execution/remote_driver.ts'
import { RemoteError, type RemoteJob, type BytePage } from '../src/remote/types.ts'
import type { RemoteWorkspaceService } from '../src/workspace/remote.ts'
import type { Workspace } from '@oasis-code/contract'

function fixture(callbacks: RemoteDriverCallbacks = {}) {
  const conn = connect(':memory:')
  const target = createTarget(conn, { label: 'Test', destination: 'fixture.invalid' })
  const binding = { target_id: target.id, root_id: 'root', generation: 'gen', path: '/same/path', state_path: '/tmp/private-state' }
  conn.run("INSERT INTO projects (id,name,source_path,base_repo_path,kind,created_at,updated_at,target_id,remote_binding_json) VALUES ('p','test',?,'','direct','t','t',?,?)", [binding.path, target.id, JSON.stringify(binding)])
  const ws = repo.insertWorkspace(conn, 'w', 'p', null, binding.path, '', '', 'direct', null, binding)
  const calls: { method: string; params: any; operation?: string; target: string }[] = []
  let paused = false, lostAck = false, offline = false, code = 0, state: RemoteJob['state'] = 'running', reason: string | undefined
  let operation = '', pageSize = 2, storage = false
  let output: Buffer = Buffer.from('你hello'), errorOutput: Buffer = Buffer.from('ERR')
  const remote = {
    isPaused: () => paused,
    request: async (root: any, method: string, params: any, op?: string): Promise<any> => {
      calls.push({ method, params, operation: op, target: root.target_id })
      if (offline) throw new RemoteError('remote_unavailable', 'offline', 'disconnected')
      const job = (): RemoteJob => ({ job_id: 'job', operation_id: operation, state, timeout_s: null, output_cap_bytes: null,
        ...(state === 'exited' ? { exit_code: code, ended_at: '2026-10-16T18:00:00Z', stdout_bytes: output.length, stderr_bytes: errorOutput.length } : {}),
        reason, ...(storage ? { log_complete: false } : {}) })
      if (method === 'leases.acquire') {
        expect(conn.all('SELECT * FROM remote_jobs')).toHaveLength(1)
        return { lease_id: 'lease', owner_id: params.owner_id, fence: 1 }
      }
      if (method === 'leases.release') return { released: true }
      if (method === 'jobs.start') { operation = op!; if (lostAck) throw new RemoteError('outcome_unknown', 'lost ACK', 'unknown'); return job() }
      if (method === 'jobs.recover' || method === 'jobs.status') return job()
      if (method === 'jobs.stop') return { job_id: 'job', state: 'requested', job: job() }
      if (method === 'jobs.read') {
        const data = params.stream === 'stdout' ? output : errorOutput
        const chunk = data.subarray(params.byte_offset, params.byte_offset + Math.min(params.limit, pageSize))
        return { data: chunk.toString('base64'), byte_offset: params.byte_offset, next_offset: params.byte_offset + chunk.length,
          total_written: data.length, total_retained: data.length, gaps: [], eof: state === 'exited' && params.byte_offset + chunk.length >= data.length,
          ...(storage ? { storage_failed: true, log_complete: false } : {}) } satisfies BytePage
      }
      throw new Error('Unexpected RPC ' + method)
    },
  } as unknown as RemoteWorkspaceService
  let driver = new RemoteExecutionDriver({ conn, remote, callbacks, poll_ms: 10000 })
  return { conn, remote, ws, calls, get driver() { return driver },
    set(opts: { paused?: boolean; lostAck?: boolean; offline?: boolean; state?: RemoteJob['state']; code?: number; reason?: string; storage?: boolean; pageSize?: number; output?: Buffer; errorOutput?: Buffer }) {
      if (opts.paused !== undefined) paused = opts.paused
      if (opts.lostAck !== undefined) lostAck = opts.lostAck
      if (opts.offline !== undefined) offline = opts.offline
      if (opts.state !== undefined) state = opts.state
      if (opts.code !== undefined) code = opts.code
      if (opts.reason !== undefined) reason = opts.reason
      if (opts.storage !== undefined) storage = opts.storage
      if (opts.pageSize !== undefined) pageSize = opts.pageSize
      if (opts.output !== undefined) output = opts.output
      if (opts.errorOutput !== undefined) errorOutput = opts.errorOutput
    },
    start: () => driver.start({ project_id: 'p', workspace_id: ws.id, command: 'echo test', cwd: ws.path, access: 'full', env_passthrough: ['HOME'] }, ws),
    async restore() { await driver.close(); driver = new RemoteExecutionDriver({ conn, remote, callbacks }); driver.rehydrate() },
    async close() { await driver.close(); conn.close() },
  }
}

test('DB intent before RPC, full null defaults and no local env passthrough', async () => {
  const f = fixture()
  try {
    const e = await f.start(), start = f.calls.find(c => c.method === 'jobs.start')!
    expect(start.params.timeout_s).toBeNull(); expect(start.params.output_cap_bytes).toBeNull(); expect(start.params.env).toEqual({})
    expect(start.params.cwd).toBe('.'); expect(start.params.shell).toBe('/bin/sh')
    expect(e.isolation.root_pid).toBeUndefined(); expect(f.driver.has(e.id)).toBe(true); expect(f.driver.pending(e.id)).toBe(true)
  } finally { await f.close() }
})
test('lost ACK/restart rehydrates synchronously and only queries same operation', async () => {
  const f = fixture(); f.set({ lostAck: true })
  try {
    const e = await f.start(); const before = f.calls.length
    await f.restore(); expect(f.calls.length).toBe(before); expect(f.driver.pending(e.id)).toBe(true)
    await f.driver.poll(e.id); expect(f.calls.filter(c => c.method === 'jobs.start')).toHaveLength(1)
    expect(f.calls.find(c => c.method === 'jobs.recover')?.params.operation_id).toBe(f.calls.find(c => c.method === 'jobs.start')?.operation)
  } finally { await f.close() }
})
test('paused poll/stop never contacts service; unknown wait never resolves or emits end', async () => {
  let ended = 0
  const f = fixture({ onEnd() { ended++ } })
  try {
    const e = await f.start(); f.set({ paused: true }); const count = f.calls.length
    await f.driver.poll(e.id); await f.driver.stop(e.id)
    expect(f.calls.length).toBe(count); expect(f.driver.connected(e.id)).toBe(false)
    expect(await f.driver.wait(e.id, 0.01)).toBeNull(); expect(f.driver.pending(e.id)).toBe(true); expect(ended).toBe(0)
    let resolved = false; void f.driver.wait(e.id, null).then(() => { resolved = true })
    await f.driver.close(); await new Promise(r => setTimeout(r, 15)); expect(resolved).toBe(false)
    f.set({ paused: false }); await f.restore(); await f.driver.poll(e.id); expect(f.driver.connected(e.id)).toBe(true)
  } finally { await f.close() }
})
test('raw UTF8 byte callbacks and final logs before end, cursor and callback share transaction', async () => {
  const output: Buffer[] = [], order: string[] = []
  const f = fixture({ onOutput(e) { output.push(e.bytes); order.push(e.stream); f.conn.run('INSERT INTO callback_events (kind) VALUES (?)', [e.stream]) }, onEnd() { order.push('end'); f.conn.run("INSERT INTO callback_events(kind) VALUES ('end')") } })
  f.conn.exec('CREATE TABLE callback_events(kind TEXT)')
  try {
    const e = await f.start(); f.set({ state: 'exited' }); await f.driver.poll(e.id)
    expect(f.driver.pending(e.id)).toBe(false); expect(order.at(-1)).toBe('end')
    expect(Buffer.concat(output).toString()).toBe('你helloERR')
    expect(f.conn.get('SELECT stdout_offset,stderr_offset FROM remote_jobs')).toEqual({ stdout_offset: 8, stderr_offset: 3 })
    expect(repo.getExecution(f.conn, e.id)?.status).toBe('succeeded')
    const summary = await f.driver.summary(e.id); expect(summary.output_complete).toBe(true)
    await f.driver.poll(e.id); expect(order.filter(x => x === 'end')).toHaveLength(1)
  } finally { await f.close() }
})
test('output callback throw rolls back DB callback writes and cursor; retry replays same bytes', async () => {
  let fail = true
  const f = fixture({ onOutput() { f.conn.run("INSERT INTO callback_events(kind) VALUES ('output')"); if (fail) throw new Error('callback failed') } })
  f.conn.exec('CREATE TABLE callback_events(kind TEXT)')
  try {
    const e = await f.start(); f.set({ state: 'exited' })
    await expect(f.driver.poll(e.id)).rejects.toThrow('callback failed')
    expect(f.conn.get('SELECT stdout_offset FROM remote_jobs')?.stdout_offset).toBe(0)
    expect(f.conn.all('SELECT * FROM callback_events')).toHaveLength(0); expect(f.driver.pending(e.id)).toBe(true)
    fail = false; await f.driver.poll(e.id); expect(f.driver.pending(e.id)).toBe(false)
  } finally { await f.close() }
})
test('end callback throw rolls back terminal marker and execution status', async () => {
  let fail = true, ended = 0
  const f = fixture({ onEnd() { if (fail) throw new Error('end failed'); ended++ } })
  try {
    const e = await f.start(); f.set({ state: 'exited' })
    await expect(f.driver.poll(e.id)).rejects.toThrow('end failed')
    expect(repo.getExecution(f.conn, e.id)?.status).toBe('running'); expect(f.driver.pending(e.id)).toBe(true)
    fail = false; await f.driver.poll(e.id); expect(ended).toBe(1); expect(f.driver.pending(e.id)).toBe(false)
  } finally { await f.close() }
})
test('storage_failed / incomplete logs never turn exit 0 into success', async () => {
  const f = fixture()
  try {
    const e = await f.start(); f.set({ state: 'exited', reason: 'storage_failed', storage: true })
    await f.driver.poll(e.id)
    expect(repo.getExecution(f.conn, e.id)?.status).toBe('failed'); expect((await f.driver.summary(e.id)).output_complete).toBe(false)
    expect(f.driver.pending(e.id)).toBe(false)
  } finally { await f.close() }
})
test('remote unknown and poll disconnect keep execution pending and never issue end', async () => {
  let ended = 0
  const f = fixture({ onEnd() { ended++ } })
  try {
    const e = await f.start(); f.set({ state: 'unknown', reason: 'storage_failed' }); await f.driver.poll(e.id)
    expect(f.driver.pending(e.id)).toBe(true); expect((await f.driver.summary(e.id)).status).toBe('unknown')
    f.set({ offline: true }); await f.driver.poll(e.id)
    const page = await f.driver.readOutput(e.id, 'stdout', 0, 100)
    expect(page.available).toBe(false); expect(page.eof).toBe(false); expect(ended).toBe(0)
  } finally { await f.close() }
})
test('requested stop is not terminal; repeated stop reuses durable operation', async () => {
  const f = fixture()
  try {
    const e = await f.start(); expect((await f.driver.stop(e.id)).state).toBe('requested')
    await f.driver.stop(e.id); expect(f.driver.pending(e.id)).toBe(true)
    const calls = f.calls.filter(c => c.method === 'jobs.stop'); expect(calls[0].operation).toBe(calls[1].operation)
  } finally { await f.close() }
})
test('unsupported restrictions and identity mismatch refuse before mutation', async () => {
  const f = fixture()
  try {
    for (const patch of [{ access: 'sandbox' as const }, { host_restrictions: { network: false, write_deny: [] } }, { workspace_id: 'other' }]) {
      await expect(f.driver.start({ command: 'x', cwd: f.ws.path, project_id: 'p', ...patch }, f.ws)).rejects.toThrow()
    }
    expect(f.calls).toHaveLength(0); expect(f.conn.all('SELECT * FROM executions')).toHaveLength(0)
  } finally { await f.close() }
})
test('output is bounded per tick and preview is bounded, pending until both EOF', async () => {
  const f = fixture()
  try {
    const e = await f.start(); f.set({ state: 'exited', output: Buffer.alloc(256 * 1024 * 5, 65), pageSize: 256 * 1024 })
    await f.driver.poll(e.id); expect(f.driver.pending(e.id)).toBe(true)
    expect(f.conn.get('SELECT stdout_offset FROM remote_jobs')?.stdout_offset).toBe(256 * 1024 * 4)
    await f.driver.poll(e.id); expect(f.driver.pending(e.id)).toBe(false)
    expect(String((await f.driver.summary(e.id)).stdout).length).toBe(2000)
  } finally { await f.close() }
})

test('missing access is not implicit Full; same default as ProcessSpec', async () => {
  const f = fixture()
  try {
    await expect(f.driver.start({ command: 'x', cwd: f.ws.path, project_id: 'p' }, f.ws)).rejects.toThrow('sandbox')
    expect(f.calls).toHaveLength(0)
  } finally { await f.close() }
})
test('readOutput text joins across one-byte UTF8 pages without replacement characters', async () => {
  const f = fixture()
  try {
    const e = await f.start(); f.set({ state: 'exited', pageSize: 1 })
    let offset = 0, text = ''
    for (let i = 0; i < 20; i++) {
      const out = await f.driver.readOutput(e.id, 'stdout', offset, 1)
      expect(out.available).toBe(true); text += out.text; offset = Number(out.next_offset)
      if (out.eof) break
    }
    expect(text).toBe('你hello')
    expect(f.conn.get('SELECT stdout_offset FROM remote_jobs')?.stdout_offset).toBe(0)
  } finally { await f.close() }
})

test('two targets with identical paths retain separate execution identity', async () => {
  const a = fixture(), b = fixture()
  try {
    const ea = await a.start(), eb = await b.start()
    expect(a.ws.path).toBe(b.ws.path); expect(a.ws.remote!.target_id).not.toBe(b.ws.remote!.target_id)
    expect((await a.driver.summary(ea.id)).target_id).toBe(a.ws.remote!.target_id)
    expect((await b.driver.summary(eb.id)).target_id).toBe(b.ws.remote!.target_id)
    expect(a.calls.every(c => c.target === a.ws.remote!.target_id)).toBe(true)
    expect(b.calls.every(c => c.target === b.ws.remote!.target_id)).toBe(true)
  } finally { await a.close(); await b.close() }
})
test('explicit terminal log gap drains retained bytes and reports failure rather than polling forever', async () => {
  const f = fixture()
  const original = f.remote.request.bind(f.remote)
  f.remote.request = async (root, method, params, operation) => {
    const result = await original(root, method, params, operation)
    if (method === 'jobs.read') {
      const page = result as BytePage
      page.total_written += 100; page.gaps = [{ start: page.total_retained, end: page.total_written }]; page.log_complete = false
    }
    return result
  }
  try {
    const e = await f.start(); f.set({ state: 'exited' }); await f.driver.poll(e.id)
    expect(f.driver.pending(e.id)).toBe(false)
    expect(repo.getExecution(f.conn, e.id)?.status).toBe('failed')
    expect((await f.driver.summary(e.id)).gaps).toEqual({ stdout: [{ start: 8, end: 108 }], stderr: [{ start: 3, end: 103 }] })
  } finally { await f.close() }
})
test('concurrent polls and manual output serialize; historical reads never rewind callback cursor', async () => {
  const offsets: number[] = []
  const f = fixture({ onOutput(e) { if (e.stream === 'stdout') offsets.push(e.offset) } })
  let active = 0, peak = 0
  const original = f.remote.request.bind(f.remote)
  f.remote.request = async (root, method, params, operation) => {
    active++; peak = Math.max(peak, active)
    try { await new Promise(r => setTimeout(r, 1)); return await original(root, method, params, operation) } finally { active-- }
  }
  try {
    const e = await f.start(); f.set({ state: 'exited' })
    await Promise.all([f.driver.poll(e.id), f.driver.readOutput(e.id, 'stdout', 0, 2), f.driver.poll(e.id)])
    expect(peak).toBe(1); expect(offsets).toEqual([0, 2, 4, 6])
    expect(f.conn.get('SELECT stdout_offset FROM remote_jobs')?.stdout_offset).toBe(8)
  } finally { await f.close() }
})

test('service-persisted disconnect survives reconnect until a fresh job observation', async () => {
  const f = fixture()
  try {
    const e = await f.start(); expect(f.driver.connected(e.id)).toBe(true)
    // RemoteWorkspaceService.disconnect updates this column even if no driver poll ran while paused.
    f.conn.run("UPDATE remote_jobs SET connection_state='disconnected' WHERE execution_id=?", [e.id])
    expect(f.driver.connected(e.id)).toBe(false)
    await f.driver.poll(e.id); expect(f.driver.connected(e.id)).toBe(true)
  } finally { await f.close() }
})
