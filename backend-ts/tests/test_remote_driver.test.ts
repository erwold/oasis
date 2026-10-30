import { expect, test } from 'bun:test'
import { RemoteJobController as RemoteExecutionDriver, createRemoteExecutionState, type RemoteJobRpc, type RemoteExecutionState } from '../src/execution/remote_driver.ts'
import { RemoteError, type RemoteJob } from '../src/remote/types.ts'

const identity = { target_id: 'target', root_id: 'root', generation: 'generation', path: '/project', state_path: '/project/.oasis-remote' }
const initial = () => createRemoteExecutionState(identity, { operation_id: 'start-op', command: 'printf hello', cwd: '.', shell: '/bin/sh', lease: { lease_id: 'lease', owner_id: 'owner', fence: 1 } })
const job = (state: RemoteJob['state'] = 'running'): RemoteJob => ({ job_id: 'job', operation_id: 'start-op', state, timeout_s: null, output_cap_bytes: null, ...(state === 'exited' ? { exit_code: 0, ended_at: '2026-10-16T18:00:00Z' } : {}) })
function setup(handler: (m: string, p: any, op?: string) => any, state = initial()) {
  const calls: { method: string; params: any; op?: string }[] = [], saves: RemoteExecutionState[] = []
  const rpc = (async (method, params, op) => { calls.push({ method, params, op }); return handler(method, params, op) }) as RemoteJobRpc
  const persist = async (value: RemoteExecutionState) => { saves.push(structuredClone(value)) }
  return { driver: new RemoteExecutionDriver(rpc, state, persist), rpc, persist, calls, saves }
}

test('intent is durable before RPC; defaults null; concurrent starts execute exactly once', async () => {
  const f = setup((m) => { expect(f.saves[0].start_attempted).toBe(true); return job(m === 'jobs.start' ? 'starting' : 'running') })
  await Promise.all([f.driver.start(), f.driver.start(), f.driver.start()])
  expect(f.calls.map(c => c.method)).toEqual(['jobs.start', 'jobs.status', 'jobs.status'])
  expect(f.calls[0].params.timeout_s).toBeNull(); expect(f.calls[0].params.output_cap_bytes).toBeNull()
  expect(f.calls[0].params.cwd).toBe('.'); expect(f.calls[0].params.shell).toBe('/bin/sh')
  expect(f.calls[0].op).toBe('start-op')
})
test('failed initial persistence prevents remote mutation', async () => {
  const f = setup(() => job())
  const driver = new RemoteExecutionDriver(f.rpc, initial(), async () => { throw new Error('disk full') })
  await expect(driver.start()).rejects.toThrow('disk full'); expect(f.calls).toHaveLength(0)
})
test('lost start ACK and DB restore recover operation, never reexecute', async () => {
  const f = setup(m => { if (m === 'jobs.start') throw new RemoteError('outcome_unknown', 'lost ACK', 'unknown'); return job() })
  const first = await f.driver.start(); expect(first.state.writer_pinned).toBe(true); expect(first.terminal_confirmed).toBe(false)
  const restored = new RemoteExecutionDriver(f.rpc, JSON.parse(JSON.stringify(f.saves.at(-1))), f.persist)
  expect((await restored.start()).state.job_id).toBe('job')
  await restored.reconnect(); expect(f.calls.map(c => c.method)).toEqual(['jobs.start', 'jobs.recover', 'jobs.status'])
})
test('disconnect is not terminal or silence; unknown mapping remains pinned', async () => {
  const f = setup(() => { throw new RemoteError('remote_unavailable', 'offline', 'disconnected') })
  const result = await f.driver.start()
  expect(result.state.connection_state).toBe('disconnected'); expect(result.state.writer_pinned).toBe(true)
  expect(result.terminal_confirmed).toBe(false); expect(result.silence_confirmed).toBe(false)
  expect((await f.driver.output('stdout')).available).toBe(false)
  await f.driver.start(); expect(f.calls.map(c => c.method)).toEqual(['jobs.start', 'jobs.recover'])
})
test('recovery query before start cannot authorize execution after unknown outcome', async () => {
  const f = setup(m => { if (m === 'jobs.recover') throw new RemoteError('outcome_unknown', 'missing mapping', 'unknown'); return job() })
  await f.driver.reconnect(); await f.driver.start()
  expect(f.calls.map(c => c.method)).toEqual(['jobs.recover', 'jobs.recover'])
})
test('byte pages retain gaps, explicit unavailable, and acknowledged cursors survive restart', async () => {
  let offline = false
  const f = setup((m, p) => {
    if (m !== 'jobs.read') return job()
    if (offline) throw new RemoteError('remote_unavailable', 'offline', 'disconnected')
    const data = Buffer.from('你').subarray(p.byte_offset)
    return { data: data.toString('base64'), byte_offset: p.byte_offset, next_offset: 3, total_written: 10, total_retained: 3, gaps: [{ start: 3, end: 10 }], eof: true }
  })
  await f.driver.start()
  const page = await f.driver.output('stdout'); expect(page.available).toBe(true)
  if (!page.available) throw new Error('expected bytes')
  expect(page.page.next_offset).toBe(3); expect(page.page.gaps).toEqual([{ start: 3, end: 10 }])
  expect(f.driver.snapshot().cursors.stdout).toBe(0)
  await f.driver.acknowledgeOutput('stdout', 3)
  const restored = new RemoteExecutionDriver(f.rpc, f.driver.snapshot(), f.persist)
  await restored.output('stdout'); expect(f.calls.at(-1)?.params.byte_offset).toBe(3)
  offline = true
  const missing = await restored.output('stdout'); expect(missing.available).toBe(false); expect('page' in missing).toBe(false)
  expect(restored.snapshot().cursors.stdout).toBe(3)
})
test('ack cannot skip bytes that were never returned', async () => {
  const f = setup(() => job()); await f.driver.start()
  await expect(f.driver.acknowledgeOutput('stdout', 100)).rejects.toThrow()
  expect(f.driver.snapshot().cursors.stdout).toBe(0)
})
test('requested stop pins writer; only confirmed exit releases pin; stale stop cannot regress exit', async () => {
  const f = setup(m => m === 'jobs.stop' ? { job_id: 'job', state: 'requested', job: job() } : job(m === 'jobs.status' ? 'exited' : 'running'))
  await f.driver.start()
  const stopping = await f.driver.stop('stop-op'); expect(stopping.terminal_confirmed).toBe(false); expect(stopping.state.writer_pinned).toBe(true)
  const ended = await f.driver.status(); expect(ended.terminal_confirmed).toBe(true); expect(ended.state.writer_pinned).toBe(false)
  const stale = await f.driver.stop('stop-op'); expect(stale.state.job?.state).toBe('exited'); expect(stale.terminal_confirmed).toBe(false)
  await f.driver.disconnect(); expect(f.calls.filter(c => c.method === 'jobs.stop')).toHaveLength(2)
})
test('foreign job or malformed cursor fails closed, without fabricated EOF', async () => {
  const f = setup(m => m === 'jobs.read' ? { data: 'YQ==', byte_offset: 0, next_offset: 99, gaps: [] } : job())
  await f.driver.start(); expect((await f.driver.output('stdout')).available).toBe(false)
  const other = setup(() => ({ ...job('exited'), operation_id: 'foreign' }))
  expect((await other.driver.start()).state.writer_pinned).toBe(true)
})
test('snapshots do not alias internal state', async () => {
  const f = setup(() => job()); await f.driver.start()
  const snapshot = f.driver.snapshot(); snapshot.spec.command = 'changed'; snapshot.cursors.stdout = 123
  expect(f.driver.snapshot().spec.command).toBe('printf hello'); expect(f.driver.snapshot().cursors.stdout).toBe(0)
})

test('exit without exit code or signal is unknown, not writer release', async () => {
  const f = setup(() => ({ ...job('exited'), exit_code: undefined, signal: undefined }))
  const result = await f.driver.start()
  expect(result.terminal_confirmed).toBe(false); expect(result.state.writer_pinned).toBe(true)
})
test('malformed base64 and invalid gap metadata are not successful empty output', async () => {
  for (const page of [
    { data: '?', byte_offset: 0, next_offset: 0, total_written: 0, total_retained: 0, gaps: [], eof: true },
    { data: '', byte_offset: 0, next_offset: 0, total_written: 1, total_retained: 0, gaps: [{ start: 5, end: 2 }], eof: true },
  ]) {
    const f = setup(m => m === 'jobs.read' ? page : job()); await f.driver.start()
    expect((await f.driver.output('stdout')).available).toBe(false)
  }
})
test('failed cursor persistence retains cursor, retry reuses delivered bytes', async () => {
  const f = setup(m => m === 'jobs.read' ? { data: 'YQ==', byte_offset: 0, next_offset: 1, total_written: 1, total_retained: 1, gaps: [], eof: true } : job())
  let fail = false
  const d = new RemoteExecutionDriver(f.rpc, initial(), async state => { if (fail) throw new Error('disk full'); await f.persist(state) })
  await d.start(); await d.output('stdout'); fail = true
  await expect(d.acknowledgeOutput('stdout', 1)).rejects.toThrow('disk full'); expect(d.snapshot().cursors.stdout).toBe(0)
  fail = false; await d.acknowledgeOutput('stdout', 1); expect(d.snapshot().cursors.stdout).toBe(1)
})
test('explicit read beyond cursor cannot authorize skipping unread bytes', async () => {
  const f = setup(m => m === 'jobs.read' ? { data: 'YQ==', byte_offset: 10, next_offset: 11, total_written: 11, total_retained: 11, gaps: [], eof: true } : job())
  await f.driver.start(); expect((await f.driver.output('stdout', 10)).available).toBe(true)
  await expect(f.driver.acknowledgeOutput('stdout', 11)).rejects.toThrow()
})
