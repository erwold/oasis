/** The SSH connection service on its own: injected providers, a real isolated SQLite, no network, no SSH, no
 *  listener. What it must hold whatever the transport does: a Disconnect wins over any attempt under way, a poller
 *  never waits or dials, a request waits only its own bound, refusals only the person can lift are never retried,
 *  a read is sent again after the connection returns and a mutation never is. */
import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { connect } from '../src/db/database.ts'
import { createTarget, setIntent, updateTarget, getTarget } from '../src/db/remote_repo.ts'
import { RemoteWorkspaceService, type RemoteHostProvider } from '../src/workspace/remote.ts'
import { RemoteError } from '../src/remote/types.ts'
import type { RemoteWorkspaceBinding } from '@oasis-code/contract'
import { tempDir } from './helpers.ts'

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

interface Calls { factories: number; probes: number; checks: number; requests: string[]; disconnects: number }

function fakeProvider(calls: Calls, behaviour: { probe?: () => Promise<{ capabilities: Record<string, boolean> }>; request?: (method: string) => Promise<unknown> }): RemoteHostProvider {
  return {
    probe: async () => { calls.probes++; return behaviour.probe ? behaviour.probe() : { capabilities: { durable_jobs: true } } },
    check: async () => { calls.checks++ },
    async listDirs(path) { return { path, name: 'x', parent: null, entries: [], truncated: false, favorites: [] } },
    async openRoot() { throw new Error('unused') },
    request: (async (_root: RemoteWorkspaceBinding, method: string) => { calls.requests.push(method); return behaviour.request ? behaviour.request(method) : { ok: true } }) as RemoteHostProvider['request'],
    async openForward() { throw new Error('unused') },
    async closeForward() { return false },
    async disconnect() { calls.disconnects++ },
  }
}

/** A target the person connected in an earlier life of the app (intent connect; the transport state left as a crash
 *  or a shutdown left it). */
function previousLife(state: 'ready' | 'disconnected' | 'error' = 'ready') {
  const conn = connect(join(tempDir('oasis-ssh-service-'), 'state.db'))
  const target = createTarget(conn, { label: 'Fake', destination: 'user@fixture.invalid' })
  setIntent(conn, target.id, 'connect')
  updateTarget(conn, target.id, { ...getTarget(conn, target.id)!, state })
  const root: RemoteWorkspaceBinding = { target_id: target.id, root_id: 'root', generation: 'gen', path: '/remote/p', state_path: '/remote/p/.oasis-remote' }
  return { conn, target, root }
}

const newCalls = (): Calls => ({ factories: 0, probes: 0, checks: 0, requests: [], disconnects: 0 })

test('a Disconnect while the startup attempt is under way wins: the late probe changes nothing, nothing dials again, and the next life does not dial', async () => {
  const { conn, target, root } = previousLife('ready')
  const calls = newCalls(), gate = deferred<{ capabilities: Record<string, boolean> }>()
  const service = new RemoteWorkspaceService(conn, () => { calls.factories++; return fakeProvider(calls, { probe: () => gate.promise }) }, { steps_ms: [0, 50], grace_ms: 10_000 })
  try {
    expect(service.resume()).toEqual([target.id])
    for (let i = 0; i < 50 && calls.probes === 0; i++) await sleep(10)
    expect(calls.probes).toBe(1)
    expect(service.target(target.id).state).toBe('connecting')
    const disconnected = await service.disconnect(target.id)
    expect(disconnected.state).toBe('disconnected')
    expect(disconnected.connect_intent).toBe('disconnect')
    gate.resolve({ capabilities: { durable_jobs: true } }) // the late answer of the attempt the Disconnect overtook
    await sleep(200)
    expect(service.target(target.id).state).toBe('disconnected')
    expect(service.isReady(target.id)).toBe(false)
    await expect(service.request(root, 'files.read', { path: 'x' })).rejects.toMatchObject({ code: 'remote_disconnected' })
    expect(calls).toMatchObject({ factories: 1, probes: 1, requests: [] })
  } finally { await service.close() }
  const next = new RemoteWorkspaceService(conn, () => { calls.factories++; return fakeProvider(calls, {}) }, { steps_ms: [0], grace_ms: 10_000 })
  try {
    expect(next.resume()).toEqual([])
    await sleep(100)
    expect(calls).toMatchObject({ factories: 1, probes: 1 })
    expect(next.isPaused(target.id)).toBe(true)
  } finally { await next.close(); conn.close() }
})

test('while the connection is being restored a poller (wait 0) is answered at once and never dials; a request waits only its own bound', async () => {
  const { conn, target, root } = previousLife('disconnected')
  const calls = newCalls(), gate = deferred<{ capabilities: Record<string, boolean> }>()
  const service = new RemoteWorkspaceService(conn, () => { calls.factories++; return fakeProvider(calls, { probe: () => gate.promise }) }, { steps_ms: [0], grace_ms: 10_000, request_wait_ms: 5000 })
  try {
    service.resume()
    for (let i = 0; i < 50 && calls.probes === 0; i++) await sleep(10)
    let started = Date.now()
    await expect(service.request(root, 'jobs.read', { job_id: 'j', stream: 'stdout' }, undefined, { wait_ms: 0 })).rejects.toMatchObject({ code: 'remote_unavailable', status: 'disconnected' })
    expect(Date.now() - started).toBeLessThan(100)
    started = Date.now()
    await expect(service.request(root, 'files.read', { path: 'x' }, undefined, { wait_ms: 250 })).rejects.toMatchObject({ code: 'remote_unavailable' })
    const waited = Date.now() - started
    expect(waited).toBeGreaterThanOrEqual(200)
    expect(waited).toBeLessThan(1000)
    expect(calls.probes).toBe(1) // neither request dialed past the one attempt under way
    expect(calls.requests).toEqual([])
    const pending = service.request(root, 'files.read', { path: 'x' })
    gate.resolve({ capabilities: {} })
    expect(await pending as unknown).toEqual({ ok: true })
    expect(service.target(target.id).state).toBe('ready')
    expect(calls.requests).toEqual(['files.read'])
  } finally { await service.close(); conn.close() }
})

test('refusals only the person can lift, and failures that would repeat, end the schedule; a transient failure walks the steps within the grace period', async () => {
  for (const [error, state] of [
    [new RemoteError('auth_required', 'SSH authentication required', 'refused', false), 'auth_required'],
    [new RemoteError('host_verification_required', 'SSH host verification required', 'refused', false), 'host_verification_required'],
    [new RemoteError('protocol_mismatch', 'Invalid response', 'unknown', false), 'error'],
    [new RemoteError('invalid_argument', 'Invalid SSH destination', 'refused', false), 'error'],
  ] as const) {
    const { conn, target, root } = previousLife('ready')
    const calls = newCalls()
    const service = new RemoteWorkspaceService(conn, () => { calls.factories++; return fakeProvider(calls, { probe: async () => { throw error } }) }, { steps_ms: [0, 20], grace_ms: 10_000 })
    try {
      service.resume()
      await sleep(300)
      expect(calls.probes).toBe(1) // tried once; no loop on a refusal or a failure that would repeat
      expect(service.target(target.id).state).toBe(state)
      await expect(service.request(root, 'files.read', { path: 'x' }, undefined, { wait_ms: 100 })).rejects.toBeDefined()
      expect(calls.probes).toBe(1)
    } finally { await service.close(); conn.close() }
  }
  const { conn, target } = previousLife('ready')
  const calls = newCalls()
  const service = new RemoteWorkspaceService(conn, () => { calls.factories++; return fakeProvider(calls, { probe: async () => { throw new RemoteError('remote_unavailable', 'SSH exec connection failed', 'disconnected', true) } }) }, { steps_ms: [0, 40, 80], grace_ms: 600 })
  try {
    service.resume()
    await sleep(1200)
    // steps 0, 40, 80, 80, ... until the grace period ends: bounded, then the person's Connect
    expect(calls.probes).toBeGreaterThanOrEqual(4)
    expect(calls.probes).toBeLessThan(15)
    const after = calls.probes
    await sleep(300)
    expect(calls.probes).toBe(after)
    expect(service.target(target.id)).toMatchObject({ state: 'error', last_error: 'reconnect_gave_up', connect_intent: 'connect' })
  } finally { await service.close(); conn.close() }
})

test('a read that found the connection gone is sent again once it is back; a mutation is sent once and its failure returned', async () => {
  const { conn, target, root } = previousLife('ready')
  const calls = newCalls()
  let reads = 0, writes = 0
  const service = new RemoteWorkspaceService(conn, () => { calls.factories++; return fakeProvider(calls, { request: async method => {
    if (method === 'files.read' && ++reads === 1) throw new RemoteError('remote_unavailable', 'SSH exec connection failed', 'disconnected', true)
    if (method === 'files.write') { writes++; throw new RemoteError('remote_unavailable', 'SSH exec connection failed', 'disconnected', true) }
    return { ok: method }
  } }) }, { steps_ms: [0, 20], grace_ms: 10_000, request_wait_ms: 3000 })
  try {
    await service.connect(target.id)
    expect(await service.request(root, 'files.read', { path: 'x' }) as unknown).toEqual({ ok: 'files.read' })
    expect(reads).toBe(2)
    expect(calls.checks).toBe(1) // the link was really checked before the read went again
    await expect(service.request(root, 'files.write', { path: 'x', expected_hash: null, data: '', lease: { lease_id: 'l', owner_id: 'o', fence: 1 } }, 'op_once')).rejects.toMatchObject({ code: 'remote_unavailable' })
    await sleep(200)
    expect(writes).toBe(1)
    expect(calls.requests.filter(m => m === 'files.write')).toHaveLength(1)
  } finally { await service.close(); conn.close() }
})

test('a graceful close is not a Disconnect: the intent stays, the next life dials the target again', async () => {
  const { conn, target } = previousLife('disconnected')
  const calls = newCalls()
  const first = new RemoteWorkspaceService(conn, () => { calls.factories++; return fakeProvider(calls, {}) }, { steps_ms: [0], grace_ms: 10_000 })
  await first.connect(target.id)
  expect(first.target(target.id).state).toBe('ready')
  await first.close()
  expect(getTarget(conn, target.id)).toMatchObject({ state: 'disconnected', connect_intent: 'connect' })
  expect(calls.disconnects).toBe(1)
  const second = new RemoteWorkspaceService(conn, () => { calls.factories++; return fakeProvider(calls, {}) }, { steps_ms: [0], grace_ms: 10_000 })
  try {
    expect(second.resume()).toEqual([target.id])
    for (let i = 0; i < 50 && second.target(target.id).state !== 'ready'; i++) await sleep(10)
    expect(second.target(target.id).state).toBe('ready')
    expect(calls.factories).toBe(2)
  } finally { await second.close(); conn.close() }
})
