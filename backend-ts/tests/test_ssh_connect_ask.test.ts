/** An agent (or a connector) names an SSH host; the person's yes trusts its key, saves it and connects it — over a
 *  real owned loopback sshd, with a known_hosts that does not know it yet (ssh -G, ssh-keygen -F and ssh-keyscan as
 *  the product runs them). No 8399/e2e/pod. */
import { expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { UiInputRecord } from '@oasis-code/contract'
import { LoopbackSshd } from './remote/loopback_sshd.ts'
import { Client, HEADERS, json, makeApp } from './api_harness.ts'
import { setModel, waitDone } from './harness.ts'
import { tempDir } from './helpers.ts'
import { scriptedModel } from '../src/llm/scripted.ts'
import { isRequest, isToolReturn, modelResponse, textPart, toolCallPart, userTexts, type ModelMessage } from '../src/llm/messages.ts'
import { CONNECTOR_HEADER } from '../src/api/auth.ts'
import * as repo from '../src/db/repo.ts'

type Rec = Record<string, unknown>

const historyOf = (app: Awaited<ReturnType<typeof makeApp>>, runId: string): string => (app.state.conn.get('SELECT history_json FROM runs WHERE id=?', [runId]) as { history_json: string }).history_json

/** The last result a tool returned in this conversation, as the model reads it. */
function returned(messages: ModelMessage[], tool: string): Rec | null {
  const parts = messages.flatMap((m) => (isRequest(m) ? m.parts.filter(isToolReturn) : [])).filter((p) => p.tool_name === tool)
  const last = parts.at(-1)
  if (!last) return null
  return (typeof last.content === 'string' ? JSON.parse(last.content) : last.content) as Rec
}

/** Each conversation by its own words: the local one connects the host and opens a session there; the remote one
 *  reads its file. */
function script(f: LoopbackSshd) {
  return scriptedModel((messages: ModelMessage[]) => {
    const words = userTexts(messages).join('\n')
    if (words.includes('REMOTE_READ')) {
      if (!returned(messages, 'read_file')) return modelResponse([toolCallPart('read_file', { path: 'note.txt' }, 'r')])
      return modelResponse([textPart('REMOTE_DONE')])
    }
    const connected = returned(messages, 'ssh_connect')
    if (!connected) return modelResponse([toolCallPart('ssh_connect', { destination: f.alias, identity_file: f.clientKey, name: 'Fixture host' }, 'c')])
    if (connected.status !== 'connected') return modelResponse([textPart(`NOT_CONNECTED ${String(connected.status)}`)])
    const host = connected.host as Rec
    if (!returned(messages, 'open_ssh_session')) return modelResponse([toolCallPart('open_ssh_session', { target_id: host.target_id, path: f.workspace, message: 'REMOTE_READ the note' }, 'o')])
    return modelResponse([textPart('LOCAL_DONE')])
  })
}

async function pendingAsk(app: Awaited<ReturnType<typeof makeApp>>, runId: string): Promise<UiInputRecord> {
  for (let i = 0; i < 300; i++) {
    const row = app.state.conn.get("SELECT id FROM ui_inputs WHERE run_id=? AND status='pending'", [runId]) as { id: string } | null
    if (row) return repo.getUiInput(app.state.conn, row.id)!
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('no question was asked')
}

test("an agent's ssh_connect asks once, with the new host key's fingerprint; the yes trusts it, saves and connects the host; open_ssh_session starts a session there", async () => {
  const f = await LoopbackSshd.start({ parent: tmpdir() })
  const knownHosts = join(tempDir('ssh-ask-known-'), 'known_hosts')
  writeFileSync(knownHosts, '')
  const app = await makeApp(null, { remote_transport: { config_file: f.configFile, known_hosts_file: knownHosts, rpc_timeout_ms: 10_000 } })
  const c = new Client(app)
  try {
    writeFileSync(join(f.workspace, 'note.txt'), 'remote note\n')
    setModel(app.state, 'scripted:a', script(f))
    const project = await json(await c.post('/api/projects', { no_folder: true }))
    const session = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'Local', model: 'scripted:a' }))
    const chat = await json(await c.post(`/api/sessions/${session.id}/chat`, { text: 'connect the host' }))
    const ask = await pendingAsk(app, String(chat.id))
    const request = ask.request as Rec
    expect(request.harness).toBe('ssh_connect')
    expect(request.title).toBe('Connect to Fixture host?')
    expect(String(request.message)).toContain('key ' + f.clientKey)
    expect(String(request.message)).toMatch(/new host key SHA256:\S+/)
    // nothing saved, trusted or dialed before the yes
    expect(await json<unknown[]>(await c.get('/api/ssh/targets'))).toHaveLength(0)
    expect(readFileSync(knownHosts, 'utf8')).toBe('')
    await json(await c.post(`/api/sessions/${session.id}/ui-inputs/${ask.id}/submit`, { values: { connect: 'yes' } }))
    const run = await waitDone(app.state, String(chat.id))
    expect(run.status, run.error ?? '').toBe('done')
    const hosts = await json<Rec[]>(await c.get('/api/ssh/targets'))
    expect(hosts).toHaveLength(1)
    expect(hosts[0]!.state).toBe('ready')
    expect(hosts[0]!.label).toBe('Fixture host')
    expect(readFileSync(knownHosts, 'utf8')).toMatch(/^\[127\.0\.0\.1\]:\d+ ssh-/m)
    // the session opened on the host: a remote project of that folder, its run read the remote file
    const remote = app.state.conn.get("SELECT id FROM projects WHERE target_id=?", [String(hosts[0]!.id)]) as { id: string } | null
    expect(remote).not.toBeNull()
    const remoteRun = app.state.conn.get('SELECT r.id FROM runs r JOIN sessions s ON s.id=r.session_id WHERE s.project_id=?', [remote!.id]) as { id: string }
    const done = await waitDone(app.state, remoteRun.id)
    expect(done.status, done.error ?? '').toBe('done')
    expect(historyOf(app, done.id)).toContain('remote note')
    // the same host named again: no second question, no second host
    expect((await app.state.ssh.plan({ destination: f.alias, identity_file: f.clientKey })).ready).toBe(true)
  } finally {
    await app.close()
    await f.close()
  }
}, 120_000)

test('a no saves nothing and trusts nothing; the agent is told it was declined', async () => {
  const f = await LoopbackSshd.start({ parent: tmpdir() })
  const knownHosts = join(tempDir('ssh-ask-known-'), 'known_hosts')
  writeFileSync(knownHosts, '')
  const app = await makeApp(null, { remote_transport: { config_file: f.configFile, known_hosts_file: knownHosts, rpc_timeout_ms: 10_000 } })
  const c = new Client(app)
  try {
    setModel(app.state, 'scripted:a', script(f))
    const project = await json(await c.post('/api/projects', { no_folder: true }))
    const session = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'Local', model: 'scripted:a' }))
    const chat = await json(await c.post(`/api/sessions/${session.id}/chat`, { text: 'connect the host' }))
    const ask = await pendingAsk(app, String(chat.id))
    await json(await c.post(`/api/sessions/${session.id}/ui-inputs/${ask.id}/dismiss`, {}))
    const run = await waitDone(app.state, String(chat.id))
    expect(run.status).toBe('done')
    expect(historyOf(app, run.id)).toContain('NOT_CONNECTED declined')
    expect(await json<unknown[]>(await c.get('/api/ssh/targets'))).toHaveLength(0)
    expect(readFileSync(knownHosts, 'utf8')).toBe('')
  } finally {
    await app.close()
    await f.close()
  }
}, 120_000)

test("a connector's question waits for the person in the app: pending until answered, the same question for the same host, never answered by a connector, connected on the yes", async () => {
  const f = await LoopbackSshd.start({ parent: tmpdir() })
  const knownHosts = join(tempDir('ssh-ask-known-'), 'known_hosts')
  writeFileSync(knownHosts, '')
  const app = await makeApp(null, { remote_transport: { config_file: f.configFile, known_hosts_file: knownHosts, rpc_timeout_ms: 10_000 } })
  const c = new Client(app)
  const chatgpt = new Client(app, { headers: { ...HEADERS, [CONNECTOR_HEADER]: 'ChatGPT' } })
  try {
    const body = { destination: f.alias, identity_file: f.clientKey, name: 'Fixture host', wait_s: 0.2 }
    const first = await json(await chatgpt.post('/api/ssh/asks', body))
    expect(first.status).toBe('pending')
    expect(first.from).toBe('ChatGPT')
    expect(first.title).toBe('Connect to Fixture host?')
    expect((first.lines as string[]).some((l) => /^new host key SHA256:/.test(l))).toBe(true)
    expect((await json<Rec[]>(await c.get('/api/ssh/asks'))).map((a) => a.id)).toEqual([first.id])
    expect((await json(await chatgpt.post('/api/ssh/asks', body))).id).toBe(first.id)
    expect((await chatgpt.post(`/api/ssh/asks/${first.id}/answer`, { connect: true })).status).toBe(403)
    expect(await json<unknown[]>(await c.get('/api/ssh/targets'))).toHaveLength(0)
    const waiting = chatgpt.get(`/api/ssh/asks/${first.id}`, { wait_s: '20' })
    const answered = await json(await c.post(`/api/ssh/asks/${first.id}/answer`, { connect: true }))
    expect(answered.status).toBe('connected')
    expect(((await json(await waiting)).status)).toBe('connected')
    expect(await json<unknown[]>(await c.get('/api/ssh/asks'))).toHaveLength(0)
    const again = await json(await chatgpt.post('/api/ssh/asks', body))
    expect(again.status).toBe('connected')
    expect((again.target as Rec).state).toBe('ready')
  } finally {
    await app.close()
    await f.close()
  }
}, 120_000)
