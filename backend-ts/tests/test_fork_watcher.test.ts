/** The fork watcher's own lifecycle: its kqueue is closed with it (no descriptor left per watcher), its thread is
 *  found where the source and the build put it, and the project's build runs it. macOS only. */

import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ForkWatcher, workerEntry } from '../src/execution/lineage.ts'
import { sleep } from './harness.ts'
import { removeDir, tempDir } from './helpers.ts'
import { newNonce } from './owned_pids.ts'
import { anthropicStream } from './providers_fixtures.ts'

const kqueues = () => Number(spawnSync('/bin/sh', ['-c', `lsof -p ${process.pid} 2>/dev/null | grep -c KQUEUE`], { encoding: 'utf8' }).stdout.trim())

test('the watcher\'s thread is found beside its module in the source', () => {
  expect(workerEntry()).toBe(join(import.meta.dir, '../src/execution/fork_watch_worker.ts'))
})

test.skipIf(process.platform !== 'darwin')('three watchers opened and closed leave no kqueue behind', async () => {
  const before = kqueues()
  for (let i = 0; i < 3; i += 1) {
    const watcher = new ForkWatcher()
    const child = spawn('sleep', ['1'], { stdio: 'ignore' })
    watcher.watch('k', child.pid!, () => {})
    for (let t = 0; t < 100 && watcher.state !== 'ready'; t += 1) await sleep(10)
    expect(watcher.state).toBe('ready')
    await watcher.close()
    child.kill('SIGKILL')                                                             // the test's own child, by its handle
  }
  await sleep(50)
  expect(kqueues()).toBe(before)
})

/** The project's own build (the package's build script, as it stands, into a private folder) run as the backend it
 *  ships: private data dir, a fake key, a local stand-in for the Anthropic API that asks for one bash that starts a
 *  child and waits for it. The binary's own output does not say the watcher failed, and the command's record says
 *  the watcher followed it — written only once the watcher's thread reported ready. No process is left behind to
 *  stop and no signal is sent. */
test.skipIf(process.platform !== 'darwin')('the project build, run as the backend: its fork watcher starts and follows a command', async () => {
  const script = JSON.parse(readFileSync(join(import.meta.dir, '../package.json'), 'utf8')).scripts.build as string
  expect(script).toContain('src/execution/fork_watch_worker.ts')
  const dir = tempDir('oasis-compiled-backend-')
  const binary = join(dir, 'oasis-code')
  const built = spawnSync('/bin/sh', ['-c', script.replaceAll('dist/oasis-code', binary).replace(/^bun /, `'${process.execPath}' `)], { encoding: 'utf8', cwd: join(import.meta.dir, '..') })
  expect(built.status).toBe(0)
  const data = join(dir, 'data')
  mkdirSync(data)
  const command = 'sleep 0.2 & wait; echo followed'
  let requests = 0
  const provider = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch() {
    requests += 1
    const body = requests === 1
      ? anthropicStream({ model: 'fake', stop: 'tool_use', blocks: [{ type: 'tool_use', id: 'toolu_1', name: 'bash', input: { command } }] })
      : anthropicStream({ model: 'fake', stop: 'end_turn', blocks: [{ type: 'text', pieces: ['done'] }] })
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
  } })
  writeFileSync(join(data, 'config.json'), JSON.stringify({ models: [{ id: 'fake:pkg', label: 'fake', provider: 'anthropic', model: 'fake',
    api_key_env: 'OASIS_TEST_FAKE_KEY', base_url: `http://127.0.0.1:${provider.port}`, context_window: 200000 }], default_model: 'fake:pkg',
    command_timeout_s: 20, command_env_passthrough: ['PATH', 'LANG'], checks: [] }))
  const token = newNonce()
  const port = 20000 + Math.floor(Math.random() * 20000)
  const backend = Bun.spawn([binary], { env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME ?? dir, OASIS_CODE_PORT: String(port), OASIS_CODE_DATA: data,
    OASIS_CODE_SESSION_TOKEN: token, OASIS_TEST_FAKE_KEY: 'fake-key' }, stdout: 'pipe', stderr: 'pipe' })
  const output: string[] = []
  const drain = async (stream: ReadableStream<Uint8Array>) => { for await (const chunk of stream) output.push(new TextDecoder().decode(chunk)) }
  const drained = Promise.all([drain(backend.stdout), drain(backend.stderr)])
  const api = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'x-oasis-code-token': token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`)
    return r.json() as Promise<{ id: string; status: string }>
  }
  try {
    for (let i = 0; ; i += 1) { try { await api('GET', '/api/meta/isolation'); break } catch (error) { if (i > 150) throw error; await sleep(100) } }
    const project = await api('POST', '/api/projects', { name: 'compiled' })
    // a sandbox session, as this build ran every command before access modes: the compiled build's real sandbox
    const session = await api('POST', `/api/projects/${project.id}/sessions`, { title: 't', mode: 'auto', access_mode: 'sandbox' })
    const run = await api('POST', `/api/sessions/${session.id}/chat`, { text: 'run it', budget: { requests: 2, tool_calls: 1 } })
    let status = 'running'
    for (let i = 0; i < 300 && status === 'running'; i += 1) { status = (await api('GET', `/api/runs/${run.id}`)).status; await sleep(100) }
    expect(status).toBe('done')
  } finally {
    backend.kill('SIGTERM')                                                            // the backend this test started, by its handle
    await backend.exited
    await drained
    provider.stop(true)
  }
  expect(output.join('')).not.toContain('the fork watcher did not start')
  const db = new Database(join(data, 'index.db'), { readonly: true })
  const executions = db.query('SELECT status, isolation_json FROM executions').all() as { status: string; isolation_json: string }[]
  db.close()
  expect(executions).toHaveLength(1)
  expect(executions[0]!.status).toBe('succeeded')
  expect(JSON.parse(executions[0]!.isolation_json)).toMatchObject({ lineage: 'fork watcher' })
  removeDir(dir)
}, 90_000)
