/** Independent product-chain review on a real owned system loopback sshd.
 * Serial Bun tests, in-process Hono app, fresh keys/config/HOME; no pod/app port/e2e.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LoopbackSshd, inspectPid } from './remote/loopback_sshd.ts'
import { Client, json, makeApp } from './api_harness.ts'
import type { App } from '../src/main.ts'
import type { Project, Session, Workspace } from '@oasis-code/contract'
import { setModel, waitDone } from './harness.ts'
import { scriptedModel, steps } from '../src/llm/scripted.ts'
import { modelResponse, textPart, toolCallPart } from '../src/llm/messages.ts'
import * as repo from '../src/db/repo.ts'
import * as gate from '../src/policy/gate.ts'
import { newId } from '../src/ids.ts'
import { RemoteError } from '../src/remote/types.ts'
import { createHash } from 'node:crypto'
import { externalStatePython } from '../src/remote/external_state.fixture.ts'

let fixture: LoopbackSshd
let app: App
let client: Client
let host: string
let seq = 0
let fixturePython: string
beforeAll(async () => {
  fixture = await LoopbackSshd.start({ parent: '/tmp' })
  // Registry namespace only: the supplied shared-volume path is unused, so filesystem semantics stay real.
  // Do not write the production fixed per-user /tmp registry from concurrent independent test sessions.
  fixturePython = externalStatePython(fixture.root, join(fixture.root, 'unused-shared-volume'))
  app = await makeApp(null, { remote_transport: { config_file: fixture.configFile, known_hosts_file: fixture.knownHostsFile, python: fixturePython, rpc_timeout_ms: 10_000 }, remote_reconnect: { settle_ms: 1500 } })
  client = new Client(app)
  const target = await json(await client.post('/api/ssh/targets', { label: 'Independent review', destination: fixture.alias, identity_file: fixture.clientKey }), 201)
  host = String(target.id)
  await json(await client.post(`/api/ssh/targets/${host}/connect`))
}, 60_000)
afterAll(async () => {
  try { await app?.close() } finally {
    if (fixture) {
      await fixture.close()
      console.log('REVIEW_OWNED_PIDS', JSON.stringify(fixture.ledger.map(p => ({ ...p, ended: inspectPid(p.pid) === null }))))
      expect(existsSync(fixture.root)).toBe(false)
    }
  }
}, 60_000)
async function project(mode: 'auto' | 'approve' | 'plan' = 'auto') {
  const root = join(fixture.workspace, `case-${++seq}`)
  mkdirSync(root)
  writeFileSync(join(root, 'note.txt'), 'original\n')
  const key = `review-project-${seq}`
  const p = await json<Project>(await client.post('/api/projects', { source_path: root, mode: 'direct', target: { kind: 'ssh', target_id: host }, client_request_id: key }))
  const s = await json<Session & { workspace: Workspace }>(await client.post(`/api/projects/${p.id}/sessions`, { title: 'Review', model: 'scripted:a', mode }))
  return { root, key, p, s, ws: s.workspace, base: `/api/workspaces/${s.workspace.id}` }
}
async function attemptEdit(s: Session, path = 'note.txt', replacement = 'changed') {
  setModel(app.state, 'scripted:a', scriptedModel(steps(
    [toolCallPart('read_file', { path }, 'read')],
    [toolCallPart('edit_file', { path, old_string: 'original', new_string: replacement }, 'edit')],
    [textPart('Review finished.')],
  )))
  const run = await json(await client.post(`/api/sessions/${s.id}/chat`, { text: 'Perform the specified review edit.' }))
  return waitDone(app.state, String(run.id))
}
async function edit(s: Session, path = 'note.txt', replacement = 'changed') {
  const done = await attemptEdit(s, path, replacement)
  expect(done.status, done.error ?? '').toBe('done')
  return done
}

test('ssh review product: reverse idempotency reuse cannot return a remote project to a local request', async () => {
  const f = await project()
  const response = await client.post('/api/projects', { source_path: f.root, mode: 'direct', target: { kind: 'local' }, client_request_id: f.key })
  const body = await response.json()
  expect(response.status, JSON.stringify(body)).toBe(409)
  expect(readFileSync(join(f.root, 'note.txt'), 'utf8')).toBe('original\n')
}, 60_000)

test('ssh review product: private remote state cannot be read through filesystem case aliases', async () => {
  const f = await project()
  const alias = join(f.root, '.OASIS-REMOTE', 'root.json')
  if (!existsSync(alias) || statSync(alias).ino !== statSync(join(f.root, '.oasis-remote/root.json')).ino) {
    console.log('REVIEW_CASE_ALIAS_NOT_APPLICABLE: filesystem does not alias .OASIS-REMOTE'); return
  }
  const response = await client.get(`${f.base}/file`, { path: '.OASIS-REMOTE/root.json' })
  const body = await response.json()
  // Evidence deliberately excludes private metadata contents: the status/code alone demonstrates exposure.
  expect(response.status, `private state alias response: status=${response.status}, code=${(body as {code?:string}).code ?? 'none'}`).toBeGreaterThanOrEqual(400)
}, 60_000)

test('ssh review product: protected paths honor remote filesystem case aliases', async () => {
  const f = await project()
  mkdirSync(join(f.root, 'secrets'))
  writeFileSync(join(f.root, 'secrets/note.txt'), 'original\n')
  const alias = join(f.root, 'SECRETS/note.txt')
  if (!existsSync(alias) || statSync(alias).ino !== statSync(join(f.root, 'secrets/note.txt')).ino) {
    console.log('REVIEW_CASE_ALIAS_NOT_APPLICABLE: filesystem does not alias SECRETS'); return
  }
  const run = await attemptEdit(f.s, 'SECRETS/note.txt')
  const content = readFileSync(join(f.root, 'secrets/note.txt'), 'utf8')
  const journal = repo.listJournal(app.state.conn, { workspace_id: f.ws.id })
  console.log('REVIEW_R6_POSTCONDITION', JSON.stringify({ status: run.status, error: run.error, content, journal_count: journal.length }))
  expect(content).toBe('original\n')
  expect(journal).toHaveLength(0)
  // Keep the original product-flow expectation: an uncaught policy error is not quietly counted as new-pass.
  expect(run.status, run.error ?? '').toBe('done')
}, 60_000)

test('ssh review policy identity: absent protected secret.txt cannot be created as SECRET.TXT', async () => {
  const f = await project()
  // Prove this actual fixture volume aliases names; this is not a blanket lowercase Linux test.
  expect(statSync(join(f.root, 'NOTE.TXT')).ino).toBe(statSync(join(f.root, 'note.txt')).ino)
  expect(existsSync(join(f.root, 'secret.txt'))).toBe(false)
  expect(existsSync(join(f.root, 'SECRET.TXT'))).toBe(false)
  await json(await client.put(`/api/projects/${f.p.id}/config`, { protected_paths: ['secret.txt'] }))
  setModel(app.state, 'scripted:a', scriptedModel(steps(
    [toolCallPart('write_file', { path: 'SECRET.TXT', content: 'must not be created\n' }, 'new-file')],
    [textPart('Review finished.')],
  )))
  const row = await json(await client.post(`/api/sessions/${f.s.id}/chat`, { text: 'Attempt the protected new-file spelling.' }))
  const run = await waitDone(app.state, String(row.id))
  expect(run.status, run.error ?? '').toBe('done')
  const result = { lower_exists: existsSync(join(f.root, 'secret.txt')), upper_exists: existsSync(join(f.root, 'SECRET.TXT')),
    journal_count: repo.listJournal(app.state.conn, { run_id: run.id }).length }
  console.log('REVIEW_ABSENT_PROTECTED', JSON.stringify(result))
  expect(result).toEqual({ lower_exists: false, upper_exists: false, journal_count: 0 })
}, 60_000)

for (const requested of ['SECRETS/note.txt', 'Secrets/note.txt']) test(`ssh review policy identity: pattern secrets/** protects actual Secrets via ${requested}`, async () => {
  const f = await project()
  mkdirSync(join(f.root, 'Secrets'))
  writeFileSync(join(f.root, 'Secrets/note.txt'), 'original\n')
  expect(statSync(join(f.root, 'secrets/note.txt')).ino).toBe(statSync(join(f.root, 'Secrets/note.txt')).ino)
  expect(app.state.config.protected_paths).toContain('secrets/**')
  const run = await attemptEdit(f.s, requested)
  const result = { requested, content: readFileSync(join(f.root, 'Secrets/note.txt'), 'utf8'),
    journal_count: repo.listJournal(app.state.conn, { run_id: run.id }).length }
  console.log('REVIEW_PATTERN_CASE_IDENTITY', JSON.stringify({ ...result, status: run.status, error: run.error }))
  expect(result).toEqual({ requested, content: 'original\n', journal_count: 0 })
  expect(run.status, run.error ?? '').toBe('done')
}, 60_000)

test('ssh review product: Ask pins target/root/generation/hash and refuses external drift', async () => {
  const f = await project('approve')
  await edit(f.s)
  expect(readFileSync(join(f.root, 'note.txt'), 'utf8')).toBe('original\n')
  const proposals = gate.listProposals(app.state.conn, f.p.id, f.s.id)
  expect(proposals).toHaveLength(1)
  const id = proposals[0]!.proposal_asset_id
  const payload = gate.loadProposal(app.state.conn, app.state.store, id)
  const prints = payload.base_fingerprints as Record<string, unknown>[]
  expect(prints.find(p => p.kind === 'remote_root')).toMatchObject({ target: f.ws.target, remote: f.ws.remote })
  expect(prints.find(p => p.kind === 'file')?.sha256).toMatch(/^[a-f0-9]{64}$/)
  writeFileSync(join(f.root, 'note.txt'), 'external\n')
  await expect(gate.decideProposal(app.state, id, 'approve')).rejects.toMatchObject({ code: 'proposal_drifted' })
  expect(readFileSync(join(f.root, 'note.txt'), 'utf8')).toBe('external\n')
}, 60_000)

test('ssh review product: approved remote edit and undo operate on remote journal only', async () => {
  const f = await project('approve')
  await edit(f.s)
  const id = gate.listProposals(app.state.conn, f.p.id, f.s.id)[0]!.proposal_asset_id
  const result = await gate.decideProposal(app.state, id, 'approve')
  expect(result.status).toBe('approved')
  expect(readFileSync(join(f.root, 'note.txt'), 'utf8')).toBe('changed\n')
  const entries = repo.listJournal(app.state.conn, { workspace_id: f.ws.id })
  expect(entries).toHaveLength(1)
  expect((await json(await client.get(`${f.base}/diff`))).patch).toContain('+changed')
  const undo = await json(await client.post(`/api/runs/${entries[0]!.run_id}/undo`))
  expect(undo.restored).toEqual(['note.txt'])
  expect(readFileSync(join(f.root, 'note.txt'), 'utf8')).toBe('original\n')
}, 60_000)

test('ssh review product: Plan cannot write or execute and sandbox/copies/additional roots refuse', async () => {
  const f = await project('plan')
  setModel(app.state, 'scripted:a', scriptedModel(steps(
    [toolCallPart('write_file', { path: 'forbidden.txt', content: 'write' }, 'write')],
    [toolCallPart('bash', { command: 'printf command > forbidden-command.txt', wait_s: 1 }, 'exec')],
    [textPart('Finished planning.')],
  )))
  const run = await json(await client.post(`/api/sessions/${f.s.id}/chat`, { text: 'Plan only.' }))
  await waitDone(app.state, String(run.id))
  expect(existsSync(join(f.root, 'forbidden.txt'))).toBe(false)
  expect(existsSync(join(f.root, 'forbidden-command.txt'))).toBe(false)
  expect(repo.listJournal(app.state.conn, { workspace_id: f.ws.id })).toHaveLength(0)
  expect(repo.listExecutions(app.state.conn, { workspace_id: f.ws.id })).toHaveLength(0)
  expect((await client.post(`/api/projects/${f.p.id}/sessions`, { title: 'sandbox', access_mode: 'sandbox' })).status).toBe(409)
  expect((await client.post(`/api/projects/${f.p.id}/sessions`, { title: 'extra roots', roots: [{ path: f.root, access: 'write' }] })).status).toBe(409)
  await expect(app.state.workspaces.createSourceWorkspace(f.p, f.s.id, f.ws)).rejects.toMatchObject({ code: 'capability_unavailable' })
}, 60_000)

test('ssh review product: generation drift refuses approved write and same-path file reads', async () => {
  const f = await project('approve')
  await edit(f.s)
  const id = gate.listProposals(app.state.conn, f.p.id, f.s.id)[0]!.proposal_asset_id
  const metadata = join(f.root, '.oasis-remote/root.json')
  const root = JSON.parse(readFileSync(metadata, 'utf8'))
  root.generation = 'review_changed_generation'
  writeFileSync(metadata, JSON.stringify(root))
  const response = await client.get(`${f.base}/file`, { path: 'note.txt' })
  expect(response.status).toBe(409)
  expect((await response.json() as {code:string}).code).toBe('root_changed')
  await expect(gate.decideProposal(app.state, id, 'approve')).rejects.toMatchObject({ code: 'root_changed' })
  expect(readFileSync(join(f.root, 'note.txt'), 'utf8')).toBe('original\n')
}, 60_000)

test('ssh review product: separately saved host aliases and realpath alias share a remote writer lease', async () => {
  const f = await project()
  const alias = join(fixture.workspace, `alias-${seq}`)
  symlinkSync(f.root, alias)
  const secondHost = await json(await client.post('/api/ssh/targets', { label: 'Second saved alias', destination: fixture.alias, identity_file: fixture.clientKey }), 201)
  await json(await client.post(`/api/ssh/targets/${secondHost.id}/connect`))
  const p = await json<Project>(await client.post('/api/projects', { mode: 'direct', source_path: alias, target: { kind: 'ssh', target_id: secondHost.id } }))
  expect(p.remote!.root_id).toBe(f.p.remote!.root_id)
  expect(p.remote!.path).toBe(f.root)
  const lease = await app.state.remote.request(f.ws.remote!, 'leases.acquire', { owner_id: 'independent_review' }, newId('op'))
  try {
    await expect(app.state.remote.request(p.remote!, 'leases.acquire', { owner_id: 'alias_writer' }, newId('op'))).rejects.toMatchObject({ code: 'lease_conflict' })
  } finally { await app.state.remote.request(f.ws.remote!, 'leases.release', { lease }, newId('op')) }
}, 60_000)

test('ssh review product: same target and canonical root serialize writers across separately imported projects', async () => {
  const f = await project()
  const p2 = await json<Project>(await client.post('/api/projects', { source_path: f.root, mode: 'direct', target: { kind: 'ssh', target_id: host } }))
  const s2 = await json<Session & { workspace: Workspace }>(await client.post(`/api/projects/${p2.id}/sessions`, { title: 'Second project', model: 'scripted:a' }))
  expect(s2.workspace.id).not.toBe(f.ws.id)
  const owner = 'operation:independent-review-writer'
  expect(app.state.locks.tryAcquire(f.ws.id, owner)).toBe(true)
  let calls = 0
  setModel(app.state, 'scripted:a', scriptedModel(() => { calls++; return modelResponse([textPart('Serialized.')]) }))
  let runId: string | undefined
  try {
    const response = await json(await client.post(`/api/sessions/${s2.id}/chat`, { text: 'Read after the earlier writer.' }))
    runId = String(response.id)
    expect(response.status).toBe('queued')
    await Bun.sleep(50)
    expect(calls).toBe(0)
  } finally { app.state.locks.release(f.ws.id, owner) }
  const done = await waitDone(app.state, runId!)
  expect(done.status, done.error ?? '').toBe('done')
  expect(calls).toBeGreaterThan(0)
}, 60_000)

test('ssh review product: lost write reply whose receipt stays unknown stays prepared across restart and undo cannot trust local same-path bytes', async () => {
  const f = await project()
  setModel(app.state, 'scripted:a', scriptedModel(steps([textPart('Record only.')])) )
  const row = await json(await client.post(`/api/sessions/${f.s.id}/chat`, { text: 'Record the review run.' }))
  const run = await waitDone(app.state, String(row.id))
  const remote = app.state.remote, original = remote.request.bind(remote)
  let writes = 0
  remote.request = (async (...args: Parameters<typeof original>) => {
    // while the reply is lost the remote cannot give the receipt either (the write's own settle bound then ends it)
    if (writes && args[1] === 'operations.status') return { operation_id: String((args[2] as { operation_id: string }).operation_id), state: 'unknown' }
    const reply = await original(...args)
    if (args[1] === 'files.write') { writes++; throw new RemoteError('outcome_unknown', 'Independent review lost reply AFTER real remote write', 'unknown') }
    return reply
  }) as typeof remote.request
  const files = app.state.workspaces.requireRemoteFiles()
  try {
    await expect(files.withLease(f.ws, 'review_lost_ack', lease => files.write(f.ws, 'note.txt', Buffer.from('changed\n'),
      createHash('sha256').update('original\n').digest('hex'), { session_id: f.s.id, run_id: run.id, tool_call_id: 'review_write' }, lease))).rejects.toMatchObject({ code: 'outcome_unknown' })
  } finally { remote.request = original }
  expect(writes).toBe(1)
  expect(readFileSync(join(f.root, 'note.txt'), 'utf8')).toBe('changed\n')
  expect(repo.listJournal(app.state.conn, { run_id: run.id })).toHaveLength(0)
  expect(repo.listPreparedJournal(app.state.conn, run.id)).toHaveLength(1)
  const settings = app.state.settings
  await app.close()
  app = await makeApp(settings, { remote_transport: { config_file: fixture.configFile, known_hosts_file: fixture.knownHostsFile, python: fixturePython, rpc_timeout_ms: 10_000 }, remote_reconnect: { settle_ms: 1500 } })
  client = new Client(app)
  // the remote cannot say how the write ended: every receipt asked for stays unknown
  const restarted = app.state.remote, ask = restarted.request.bind(restarted)
  restarted.request = (async (...args: Parameters<typeof ask>) => args[1] === 'operations.status'
    ? { operation_id: String((args[2] as { operation_id: string }).operation_id), state: 'unknown' }
    : ask(...args)) as typeof restarted.request
  expect(repo.listPreparedJournal(app.state.conn, run.id)).toHaveLength(1)
  expect(repo.listJournal(app.state.conn, { run_id: run.id })).toHaveLength(0)
  await json(await client.post(`/api/ssh/targets/${host}/connect`))
  const undo = await json(await client.post(`/api/runs/${run.id}/undo`))
  expect(undo.restored).toEqual([])
  expect(undo.removed).toEqual([])
  expect(undo.conflicts).toHaveLength(1)
  expect(readFileSync(join(f.root, 'note.txt'), 'utf8')).toBe('changed\n')
  const lease = await app.state.remote.request(f.ws.remote!, 'leases.inspect', {})
  expect(lease?.owner_id).toBe('review_lost_ack')
  await expect(app.state.remote.request(f.ws.remote!, 'leases.acquire', { owner_id: 'must_not_steal' }, newId('op'))).rejects.toMatchObject({ code: 'lease_conflict' })
}, 60_000)

test('ssh review product: lost write reply whose receipt the remote can give settles on reconnect: the journal is applied (never replayed), undo restores the original, the lease is released', async () => {
  const f = await project()
  setModel(app.state, 'scripted:a', scriptedModel(steps([textPart('Record only.')])) )
  const row = await json(await client.post(`/api/sessions/${f.s.id}/chat`, { text: 'Record the review run.' }))
  const run = await waitDone(app.state, String(row.id))
  const remote = app.state.remote, original = remote.request.bind(remote)
  let writes = 0
  remote.request = (async (...args: Parameters<typeof original>) => {
    // while the reply is lost the remote cannot give the receipt either (the write's own settle bound then ends it)
    if (writes && args[1] === 'operations.status') return { operation_id: String((args[2] as { operation_id: string }).operation_id), state: 'unknown' }
    const reply = await original(...args)
    if (args[1] === 'files.write') { writes++; throw new RemoteError('outcome_unknown', 'Independent review lost reply AFTER real remote write', 'unknown') }
    return reply
  }) as typeof remote.request
  const files = app.state.workspaces.requireRemoteFiles()
  try {
    await expect(files.withLease(f.ws, 'review_lost_ack', lease => files.write(f.ws, 'note.txt', Buffer.from('changed\n'),
      createHash('sha256').update('original\n').digest('hex'), { session_id: f.s.id, run_id: run.id, tool_call_id: 'review_write' }, lease))).rejects.toMatchObject({ code: 'outcome_unknown' })
  } finally { remote.request = original }
  expect(writes).toBe(1)
  expect(readFileSync(join(f.root, 'note.txt'), 'utf8')).toBe('changed\n')
  expect(repo.listJournal(app.state.conn, { run_id: run.id })).toHaveLength(0)
  expect(repo.listPreparedJournal(app.state.conn, run.id)).toHaveLength(1)
  const settings = app.state.settings
  await app.close()
  app = await makeApp(settings, { remote_transport: { config_file: fixture.configFile, known_hosts_file: fixture.knownHostsFile, python: fixturePython, rpc_timeout_ms: 10_000 }, remote_reconnect: { settle_ms: 1500 } })
  client = new Client(app)
  expect(repo.listPreparedJournal(app.state.conn, run.id)).toHaveLength(1)
  expect(repo.listJournal(app.state.conn, { run_id: run.id })).toHaveLength(0)
  await json(await client.post(`/api/ssh/targets/${host}/connect`))
  expect(repo.listPreparedJournal(app.state.conn, run.id)).toHaveLength(0)
  expect(repo.listJournal(app.state.conn, { run_id: run.id })).toHaveLength(1)
  expect(await app.state.remote.request(f.ws.remote!, 'leases.inspect', {})).toBeNull()
  const undo = await json(await client.post(`/api/runs/${run.id}/undo`))
  expect(undo.conflicts).toEqual([])
  expect(readFileSync(join(f.root, 'note.txt'), 'utf8')).toBe('original\n')
}, 60_000)
