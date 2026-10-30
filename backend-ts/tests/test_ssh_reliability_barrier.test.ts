/** A remote mutation whose reply is lost is never sent again and never passed off as done. Real system OpenSSH on
 *  loopback (own HOME, generated keys, own config); faults are injected at the provider boundary, below the
 *  service: the remote really applies the write (or starts the job) and only the reply is dropped, or a read finds
 *  the link gone. What is checked is what the agent and the person see: the tool's answer, which model requests
 *  happen, which later calls of the same response run, and what later runs (also after a restart) may do. */
import { expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client, json, makeApp } from './api_harness.ts'
import { LoopbackSshd, inspectPid } from './remote/loopback_sshd.ts'
import { scriptedModel, setModel, sleep, waitDone } from './harness.ts'
import { modelResponse, textPart, toolCallPart, toolReturns, type ModelMessage } from '../src/llm/messages.ts'
import * as repo from '../src/db/repo.ts'
import { createSshRemoteProvider } from '../src/workspace/ssh_provider.ts'
import { RemoteError } from '../src/remote/types.ts'
import type { App } from '../src/main.ts'
import type { SshTarget } from '@oasis-code/contract'
import type { RemoteHostProvider } from '../src/workspace/remote.ts'

interface Faults {
  /** methods whose next reply is dropped after the remote applied them (once each) */
  lose: Set<string>
  /** operations.status answers 'unknown' (the receipt cannot be read) */
  receiptsUnreadable: boolean
  /** jobs.recover fails as the remote does when it cannot say (no mapping readable) */
  recoverUnreadable: boolean
  /** methods whose next call finds the link gone before anything is sent (once each) */
  drop: Set<string>
}
interface Wire { method: string; params: Record<string, unknown>; operation_id?: string }

function options(f: LoopbackSshd, faults: Faults, wire: Wire[]) {
  const transport = { config_file: f.configFile, known_hosts_file: f.knownHostsFile, rpc_timeout_ms: 10000 }
  const factory = createSshRemoteProvider(transport)
  return {
    remote_transport: transport,
    remote_reconnect: { steps_ms: [0, 200], grace_ms: 60_000, request_wait_ms: 5000, settle_ms: 1500 },
    remote_provider: (target: SshTarget): RemoteHostProvider => {
      const provider = factory(target)
      return {
        ...provider,
        request: (async (binding, method, params, operationId) => {
          wire.push({ method, params: params as Record<string, unknown>, operation_id: operationId })
          if (faults.drop.has(method)) { faults.drop.delete(method); throw new RemoteError('remote_unavailable', 'injected: the link was gone before the request was sent', 'disconnected', true) }
          if (faults.receiptsUnreadable && method === 'operations.status') return { operation_id: (params as { operation_id: string }).operation_id, state: 'unknown' }
          if (faults.recoverUnreadable && method === 'jobs.recover') throw new RemoteError('outcome_unknown', 'injected: no durable job mapping readable', 'unknown', true, operationId)
          const result = await provider.request!(binding, method, params, operationId)
          if (faults.lose.has(method)) { faults.lose.delete(method); throw new RemoteError('outcome_unknown', 'injected: the reply was lost after the remote applied it', 'unknown', true, operationId) }
          return result
        }) as RemoteHostProvider['request'],
      }
    },
  }
}

async function life(f: LoopbackSshd, faults: Faults, wire: Wire[], settings?: App['state']['settings']) {
  const app = await makeApp(settings ?? null, options(f, faults, wire))
  await app.start()
  return { app, c: new Client(app) }
}

async function remoteSession(app: App, c: Client, f: LoopbackSshd) {
  const target = await json(await c.post('/api/ssh/targets', { label: 'Barrier', destination: f.alias, identity_file: f.clientKey }), 201)
  await json(await c.post(`/api/ssh/targets/${target.id}/connect`))
  const project = await json(await c.post('/api/projects', { source_path: f.workspace, mode: 'direct', target: { kind: 'ssh', target_id: target.id } }))
  const session = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'Barrier', model: 'scripted:a', access_mode: 'full' }))
  const ws = repo.getWorkspace(app.state.conn, String((session.workspace as { id: string }).id))!
  return { target, session: String(session.id), ws }
}

const historyOf = (app: App, runId: string): ModelMessage[] => JSON.parse(String(app.state.conn.get('SELECT history_json FROM runs WHERE id=?', [runId])?.history_json ?? '[]')) as ModelMessage[]
const returnsOf = (messages: ModelMessage[]) => toolReturns(messages).map(p => ({ tool: p.tool_name, id: p.tool_call_id, content: p.content as Record<string, unknown> }))

async function cleanup(f: LoopbackSshd, apps: (App | null)[], label: string) {
  for (const app of apps) if (app) await app.close().catch(() => {})
  await f.close()
  const alive = f.ledger.filter(p => inspectPid(p.pid) !== null)
  console.log(label, JSON.stringify({ utc: new Date().toISOString(), owned: f.ledger.length, alive: alive.map(p => p.pid) }))
  expect(alive).toEqual([])
}

test('lost write reply: the original receipt settles it before the model\'s next step — an applied write is answered as done, once', async () => {
  const f = await LoopbackSshd.start({ parent: process.env.TMPDIR })
  const faults: Faults = { lose: new Set(['files.write']), receiptsUnreadable: false, recoverUnreadable: false, drop: new Set() }, wire: Wire[] = []
  let app: App | null = null
  try {
    writeFileSync(join(f.workspace, 'note.txt'), 'before\n')
    const opened = await life(f, faults, wire); app = opened.app
    const { session } = await remoteSession(opened.app, opened.c, f)
    let calls = 0, seen: ReturnType<typeof returnsOf> = []
    setModel(opened.app.state, 'scripted:a', scriptedModel(async messages => {
      calls++
      seen = returnsOf(messages)
      if (calls === 1) return modelResponse([toolCallPart('read_file', { path: 'note.txt' }, 'read')])
      if (calls === 2) return modelResponse([toolCallPart('write_file', { path: 'note.txt', content: 'after\n' }, 'write')])
      return modelResponse([textPart('done')])
    }))
    const run = await json(await opened.c.post(`/api/sessions/${session}/chat`, { text: 'Rewrite note.txt.' }))
    const done = await waitDone(opened.app.state, String(run.id), 60_000)
    const write = seen.find(r => r.id === 'write')!.content
    console.log('BARRIER_LOST_REPLY', JSON.stringify({ status: done.status, write, methods: wire.map(w => w.method) }))
    expect(done.status).toBe('done')
    expect(write.status).toBe('ok') // what the model read next: the write happened (from its receipt), not "unknown"
    expect(String(write.diff)).toContain('after')
    expect(calls).toBe(3)
    const sent = wire.filter(w => w.method === 'files.write')
    expect(sent).toHaveLength(1) // sent once, never again
    const asked = wire.filter(w => w.method === 'operations.status').map(w => w.params.operation_id)
    expect(asked).toContain(sent[0]!.operation_id) // the original operation's receipt, by its own id
    expect(repo.listPreparedJournal(opened.app.state.conn, String(run.id))).toHaveLength(0)
    expect(repo.listJournal(opened.app.state.conn, { run_id: String(run.id) })).toHaveLength(1)
    expect(readFileSync(join(f.workspace, 'note.txt'), 'utf8')).toBe('after\n')
  } finally { await cleanup(f, [app], 'BARRIER_LOST_REPLY_CLEANUP') }
}, 120_000)

test('unresolved write: no later call of the same response, no next model request; later runs, the commands API and a restart stay fenced until the receipt is read', async () => {
  const f = await LoopbackSshd.start({ parent: process.env.TMPDIR })
  const faults: Faults = { lose: new Set(['files.write']), receiptsUnreadable: true, recoverUnreadable: false, drop: new Set() }, wire: Wire[] = []
  let app: App | null = null
  try {
    writeFileSync(join(f.workspace, 'note.txt'), 'before\n')
    writeFileSync(join(f.workspace, 'other.txt'), 'other\n')
    const opened = await life(f, faults, wire); app = opened.app
    const { session, ws } = await remoteSession(opened.app, opened.c, f)
    let calls = 0, seen: ReturnType<typeof returnsOf> = []
    setModel(opened.app.state, 'scripted:a', scriptedModel(async messages => {
      calls++
      seen = returnsOf(messages)
      if (calls === 1) return modelResponse([toolCallPart('read_file', { path: 'note.txt' }, 'read')])
      // one response: the write, then a read and a command that must never run once the write is unknown
      if (calls === 2) return modelResponse([
        toolCallPart('write_file', { path: 'note.txt', content: 'after\n' }, 'write'),
        toolCallPart('read_file', { path: 'other.txt' }, 'later-read'),
        toolCallPart('bash', { command: 'printf BYPASS > bypass.txt', wait_s: 5 }, 'later-bash'),
      ])
      return modelResponse([textPart('this request must never be made')])
    }))
    const run = await json(await opened.c.post(`/api/sessions/${session}/chat`, { text: 'Rewrite note.txt, then read other.txt and run a command.' }))
    const runId = String(run.id)
    const done = await waitDone(opened.app.state, runId, 60_000)
    const returns = returnsOf(historyOf(opened.app, runId))
    console.log('BARRIER_UNRESOLVED', JSON.stringify({ status: done.status, error: done.error, calls, returns, methods: wire.map(w => w.method) }))
    expect(calls).toBe(2) // no request after the response whose write is unknown
    expect(done.status).toBe('error')
    expect(String(done.error)).toContain('remote_outcome_unknown')
    const writeAt = wire.findIndex(w => w.method === 'files.write')
    expect(wire.filter(w => w.method === 'files.write')).toHaveLength(1)
    // after the write only the original receipt was asked for: nothing of the later read, no command start
    expect(wire.slice(writeAt + 1).map(w => w.method).filter(m => m !== 'operations.status' && m !== 'leases.inspect')).toEqual([])
    expect(wire.some(w => w.method === 'jobs.start')).toBe(false)
    const byId = Object.fromEntries(returns.map(r => [r.id, r.content]))
    expect(byId.write).toMatchObject({ status: 'unknown', code: 'outcome_unknown', sent_again: false, operation_id: wire[writeAt]!.operation_id })
    expect(byId['later-read']).toMatchObject({ status: 'cancelled' })
    expect(byId['later-bash']).toMatchObject({ status: 'cancelled' })
    expect(existsSync(join(f.workspace, 'bypass.txt'))).toBe(false)
    expect(repo.listPreparedJournal(opened.app.state.conn, runId)).toHaveLength(1)
    const lease = await opened.app.state.remote.request(ws.remote!, 'leases.inspect', {})
    expect(lease?.owner_id).toBe(runId) // the writer fence stays with the unknown write

    // a later run of the session cannot get past it: it waits for the writer, and nothing starts
    setModel(opened.app.state, 'scripted:a', scriptedModel(async () => modelResponse([toolCallPart('bash', { command: 'printf BYPASS > bypass2.txt', wait_s: 5 }, 'bash2')])))
    const next = await json(await opened.c.post(`/api/sessions/${session}/chat`, { text: 'Run a command.' }))
    await sleep(2500)
    expect(repo.getRun(opened.app.state.conn, String(next.id))!.status).toBe('queued')
    await json(await opened.c.post(`/api/runs/${next.id}/cancel`))
    await waitDone(opened.app.state, String(next.id), 30_000)
    // the direct commands API refuses too
    const api = await opened.c.post(`/api/workspaces/${ws.id}/commands`, { command: 'printf BYPASS > bypass3.txt', access: 'session', session_id: session, wait_s: 2 })
    expect(api.status).toBe(503)
    expect(wire.some(w => w.method === 'jobs.start')).toBe(false)
    const settings = opened.app.state.settings
    await opened.app.close(); app = null

    // a restart keeps it: the receipt is still unreadable, the API still refuses, nothing was sent again
    const second = await life(f, faults, wire, settings); app = second.app
    const again = await second.c.post(`/api/workspaces/${ws.id}/commands`, { command: 'printf BYPASS > bypass4.txt', access: 'session', session_id: session, wait_s: 2 })
    expect(again.status).toBe(503)
    expect(repo.listPreparedJournal(second.app.state.conn, runId)).toHaveLength(1)
    await second.app.close(); app = null

    // once the receipt can be read (the remote applied it), the next life settles it by itself on reconnection:
    // applied from the receipt, the lease released — still without sending the write again
    faults.receiptsUnreadable = false
    const third = await life(f, faults, wire, settings); app = third.app
    for (let i = 0; i < 300 && repo.listPreparedJournal(third.app.state.conn, runId).length; i++) await sleep(50)
    expect(repo.listPreparedJournal(third.app.state.conn, runId)).toHaveLength(0)
    let released = false
    for (let i = 0; i < 300 && !released; i++) { released = (await third.app.state.remote.request(ws.remote!, 'leases.inspect', {})) === null; if (!released) await sleep(50) }
    expect(released).toBe(true)
    expect(wire.filter(w => w.method === 'files.write')).toHaveLength(1)
    expect(['bypass.txt', 'bypass2.txt', 'bypass3.txt', 'bypass4.txt'].filter(n => existsSync(join(f.workspace, n)))).toEqual([])
    expect(readFileSync(join(f.workspace, 'note.txt'), 'utf8')).toBe('after\n')
  } finally { await cleanup(f, [app], 'BARRIER_UNRESOLVED_CLEANUP') }
}, 180_000)

test('a read that found the link gone is sent again from the product path; the agent sees the file, not an error', async () => {
  const f = await LoopbackSshd.start({ parent: process.env.TMPDIR })
  const faults: Faults = { lose: new Set(), receiptsUnreadable: false, recoverUnreadable: false, drop: new Set() }, wire: Wire[] = []
  let app: App | null = null
  try {
    writeFileSync(join(f.workspace, 'note.txt'), 'remote text\n')
    const opened = await life(f, faults, wire); app = opened.app
    const { session } = await remoteSession(opened.app, opened.c, f)
    let read: Record<string, unknown> | null = null
    setModel(opened.app.state, 'scripted:a', scriptedModel(async messages => {
      const returns = returnsOf(messages)
      if (!returns.length) { faults.drop.add('files.read'); return modelResponse([toolCallPart('read_file', { path: 'note.txt' }, 'read')]) }
      read = returns[0]!.content
      return modelResponse([textPart('read')])
    }))
    const run = await json(await opened.c.post(`/api/sessions/${session}/chat`, { text: 'Read note.txt.' }))
    await waitDone(opened.app.state, String(run.id), 60_000)
    console.log('BARRIER_SAFE_RETRY', JSON.stringify({ read, methods: wire.map(w => w.method) }))
    expect(read).toMatchObject({ status: 'ok' })
    expect(String((read as unknown as Record<string, unknown>).content)).toContain('remote text')
    expect(wire.filter(w => w.method === 'files.read').length).toBeGreaterThanOrEqual(2) // really sent again
  } finally { await cleanup(f, [app], 'BARRIER_SAFE_RETRY_CLEANUP') }
}, 120_000)

test('lost start reply: the job\'s own record settles it before the agent reads the result; unresolved, the run stops with no second start', async () => {
  const f = await LoopbackSshd.start({ parent: process.env.TMPDIR })
  const faults: Faults = { lose: new Set(['jobs.start']), receiptsUnreadable: false, recoverUnreadable: false, drop: new Set() }, wire: Wire[] = []
  let app: App | null = null
  try {
    const opened = await life(f, faults, wire); app = opened.app
    const { session } = await remoteSession(opened.app, opened.c, f)
    let calls = 0, bash: Record<string, unknown> | null = null
    setModel(opened.app.state, 'scripted:a', scriptedModel(async messages => {
      calls++
      const returns = returnsOf(messages)
      if (!returns.some(r => r.tool === 'bash')) return modelResponse([toolCallPart('bash', { command: 'printf once >> started.txt; sleep 1', wait_s: 0 }, 'start')])
      bash = returns.find(r => r.tool === 'bash')!.content
      return modelResponse([textPart('started')])
    }))
    const run = await json(await opened.c.post(`/api/sessions/${session}/chat`, { text: 'Start it.' }))
    await waitDone(opened.app.state, String(run.id), 60_000)
    console.log('BARRIER_LOST_START', JSON.stringify({ bash, methods: wire.map(w => w.method) }))
    // the job's identity was recovered from its own record (old: job_id null, status unknown); its state may still read
    // 'unknown' for the instant before the remote supervisor records itself running (adapter window, transport-owned)
    expect(typeof (bash as unknown as Record<string, unknown>)?.job_id).toBe('string')
    expect((bash as unknown as Record<string, unknown>).execution_id).toBeDefined()
    expect(wire.filter(w => w.method === 'jobs.start')).toHaveLength(1)
    expect(wire.some(w => w.method === 'jobs.recover')).toBe(true)
    await sleep(1500)
    expect(readFileSync(join(f.workspace, 'started.txt'), 'utf8')).toBe('once')

    // unresolved: the start's record cannot be read within the bound; the run stops, nothing is started again
    faults.lose.add('jobs.start'); faults.recoverUnreadable = true
    calls = 0
    setModel(opened.app.state, 'scripted:a', scriptedModel(async () => { calls++; return modelResponse([toolCallPart('bash', { command: 'printf twice >> started2.txt', wait_s: 0 }, 'start2'), toolCallPart('read_file', { path: 'started.txt' }, 'after')]) }))
    const second = await json(await opened.c.post(`/api/sessions/${session}/chat`, { text: 'Start another.' }))
    const ended = await waitDone(opened.app.state, String(second.id), 60_000)
    const returns = returnsOf(historyOf(opened.app, String(second.id)))
    console.log('BARRIER_UNRESOLVED_START', JSON.stringify({ status: ended.status, error: ended.error, calls, returns }))
    expect(calls).toBe(1)
    expect(ended.status).toBe('error')
    expect(String(ended.error)).toContain('remote_outcome_unknown')
    expect(returns.find(r => r.id === 'start2')!.content).toMatchObject({ status: 'unknown', code: 'outcome_unknown', sent_again: false })
    expect(returns.find(r => r.id === 'after')!.content).toMatchObject({ status: 'cancelled' })
    expect(wire.filter(w => w.method === 'jobs.start')).toHaveLength(2) // one per command, never resent
    faults.recoverUnreadable = false
  } finally { await sleep(1500); await cleanup(f, [app], 'BARRIER_LOST_START_CLEANUP') }
}, 180_000)
