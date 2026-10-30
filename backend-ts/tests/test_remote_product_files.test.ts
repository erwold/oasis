/** Product API over a real owned loopback sshd, not the transport's standalone smoke. No 8399/e2e/pod. */
import { expect, test } from 'bun:test'
import { writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { LoopbackSshd, inspectPid } from './remote/loopback_sshd.ts'
import { Client, json, makeApp } from './api_harness.ts'
import { setModel, waitDone } from './harness.ts'
import { scriptedModel, steps } from '../src/llm/scripted.ts'
import { textPart, toolCallPart } from '../src/llm/messages.ts'
import * as repo from '../src/db/repo.ts'

test('real SSH product path: host probe without state, remote direct/session/files, identity-bound forward, explicit disconnect', async () => {
  const f = await LoopbackSshd.start({ parent: tmpdir() })
  const app = await makeApp(null, { remote_transport: { config_file: f.configFile, known_hosts_file: f.knownHostsFile, rpc_timeout_ms: 10_000 } })
  const c = new Client(app)
  const server = createServer((_req, res) => res.end('REMOTE_PRODUCT_PREVIEW'))
  try {
    writeFileSync(join(f.workspace, 'note.txt'), 'remote content\n第二行\n')
    const host = await json(await c.post('/api/ssh/targets', { label: 'Own fixture', destination: f.alias, identity_file: f.clientKey }), 201)
    const hostPath = `/api/ssh/targets/${host.id}`
    expect((await json(await c.post(`${hostPath}/connect`))).state).toBe('ready')
    expect(existsSync(join(f.home, '.oasis-remote'))).toBe(false)
    const dirs = await json(await c.get(`${hostPath}/dirs`, { path: f.root }))
    expect((dirs.entries as {path:string}[]).some(e => e.path === f.workspace)).toBe(true)
    expect(existsSync(join(f.workspace, '.oasis-remote'))).toBe(false)
    const p = await json(await c.post('/api/projects', { mode: 'direct', source_path: f.workspace, target: { kind: 'ssh', target_id: host.id } }))
    expect(p.target).toEqual({ kind: 'ssh', target_id: host.id })
    expect(existsSync(join(f.workspace, '.oasis-remote'))).toBe(true)
    const session = await json(await c.post(`/api/projects/${p.id}/sessions`, { title: 'Remote', model: 'scripted:a' }))
    const ws = session.workspace as { id: string }
    const base = `/api/workspaces/${ws.id}`
    const list = await json(await c.get(`${base}/files`))
    expect((list.entries as {path:string}[]).some(e => e.path === 'note.txt')).toBe(true)
    expect(JSON.stringify(list)).not.toContain('.oasis-remote')
    const file = await json(await c.get(`${base}/file`, { path: 'note.txt' }))
    expect(file.content).toBe('1\tremote content\n2\t第二行')
    expect(readFileSync(join(f.workspace, 'note.txt'), 'utf8')).toBe('remote content\n第二行\n')
    expect((await c.get(`${base}/file`, { path: '.oasis-remote/root.json' })).status).toBe(409)
    expect((await c.post(`/api/projects/${p.id}/sessions`, { title: 'Sandbox', model: 'scripted:a', access_mode: 'sandbox' })).status).toBe(409)
    setModel(app.state, 'scripted:a', scriptedModel(steps(
      [toolCallPart('read_file', { path: 'note.txt' }, 'read')],
      [toolCallPart('edit_file', { path: 'note.txt', old_string: 'remote content', new_string: 'edited remotely' }, 'edit')],
      [textPart('Done.')],
    )))
    const chat = await json(await c.post(`/api/sessions/${session.id}/chat`, { text: 'Edit the remote file.' }))
    const run = await waitDone(app.state, String(chat.id))
    expect(run.status, run.error ?? '').toBe('done')
    expect(readFileSync(join(f.workspace, 'note.txt'), 'utf8')).toBe('edited remotely\n第二行\n')
    const journal = repo.listJournal(app.state.conn, { run_id: run.id })
    expect(journal).toHaveLength(1)
    expect(Buffer.from(repo.journalBytes(app.state.conn, journal[0]!.id, 'before')!).toString()).toBe('remote content\n第二行\n')
    expect((await json(await c.get(`${base}/diff`))).patch).toContain('+edited remotely')
    writeFileSync(join(f.workspace, 'note.txt'), 'external edit\n')
    const conflict = await json(await c.post(`/api/runs/${run.id}/undo`))
    expect((conflict.conflicts as unknown[]).length).toBe(1)
    expect(readFileSync(join(f.workspace, 'note.txt'), 'utf8')).toBe('external edit\n')
    writeFileSync(join(f.workspace, 'note.txt'), 'edited remotely\n第二行\n')
    const undo = await json(await c.post(`/api/runs/${run.id}/undo`))
    expect(undo.restored).toEqual(['note.txt'])
    expect(readFileSync(join(f.workspace, 'note.txt'), 'utf8')).toBe('remote content\n第二行\n')
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    const forward = await json(await c.post(`${hostPath}/forwards`, { workspace_id: ws.id, remote_port: port }), 201)
    const result = await fetch(String(forward.local_url))
    expect(await result.text()).toBe('REMOTE_PRODUCT_PREVIEW')
    const closed = await json<{ closed: boolean }>(await c.delete(`${hostPath}/forwards/${forward.id}`))
    expect(closed.closed).toBe(true)
    await c.post(`${hostPath}/disconnect`)
    expect((await c.get(`${base}/file`, { path: 'note.txt' })).status).toBe(503)
    expect((await json<Record<string, unknown>[]>(await c.get('/api/ssh/targets')))[0]!.state).toBe('disconnected')
    expect(app.state.conn.all('SELECT * FROM projects')).toHaveLength(1)
  } finally {
    await app.close()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await f.close()
    console.log('REMOTE_PRODUCT_OWNED_PIDS', JSON.stringify(f.ledger.map(p => ({ pid: p.pid, label: p.label, ended: inspectPid(p.pid) === null }))))
  }
  expect(existsSync(f.root)).toBe(false)
}, 60_000)
