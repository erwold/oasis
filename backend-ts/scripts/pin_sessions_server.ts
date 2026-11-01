/** Dedicated pin e2e fixture: a real app/database that survives this owned process's restart. No real providers,
 *  desktop bridge, user data or user listener. The parent owns the temporary root and records/stops our exact PID. */
import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Settings } from '../src/config.ts'
import { createApp } from '../src/main.ts'
import { modelResponse, textPart } from '../src/llm/messages.ts'
import { buggyRepo, scriptedModel, testConfig } from '../tests/harness.ts'

const port = Number(process.argv[2])
const root = resolve(process.argv[3] ?? '')
if (!process.argv[3] || !Number.isInteger(port) || port < 1024 || [8321, 8324].includes(port)) throw new Error('explicit temporary root and non-user port required')
mkdirSync(root, { recursive: true })
const folder = join(root, 'userrepo')
if (!existsSync(folder)) buggyRepo(root)
const token = 'pin-e2e-token'
process.env.OASIS_TEST_KEY_A = 'fake-pin-test-only'
const config = testConfig()
let gate: Promise<void> | null = null
let release: (() => void) | null = null
const app = await createApp(new Settings({ data_dir: join(root, 'data'), host: '127.0.0.1', port, session_token: token }), config, {
  probe: false, model_overrides: { 'scripted:a': scriptedModel(async () => {
    await gate
    return modelResponse([textPart('Pin fixture complete.')])
  }) },
})
const server = Bun.serve({ hostname: '127.0.0.1', port, idleTimeout: 255, fetch(req, server) {
  // No archive UI exists. Exercise the real DB status trigger and the clients' projection via a fixture-only route.
  const url = new URL(req.url)
  // Hold a real runner/model request through multiple normal client polls, without provider/network calls.
  if (url.pathname === '/e2e/pins/gate') {
    if (req.method !== 'POST' || req.headers.get('authorization') !== `Bearer ${token}`) return new Response('no', { status: 403 })
    if (url.searchParams.get('mode') === 'hold') {
      if (gate) return new Response('already held', { status: 409 })
      gate = new Promise<void>((resolve) => { release = resolve })
    } else if (url.searchParams.get('mode') === 'release') {
      release?.(); gate = null; release = null
    } else return new Response('bad mode', { status: 400 })
    return Response.json({ held: gate !== null })
  }
  if (url.pathname === '/e2e/pins/status') {
    if (req.method !== 'POST' || req.headers.get('authorization') !== `Bearer ${token}`) return new Response('no', { status: 403 })
    const id = url.searchParams.get('id'), status = url.searchParams.get('status')
    if (!id || !['open', 'archived'].includes(status ?? '')) return new Response('bad status', { status: 400 })
    app.state.conn.run('UPDATE sessions SET status=? WHERE id=?', [status!, id])
    return Response.json({ changed: true })
  }
  return app.app.fetch(req, { server })
} })
console.log(JSON.stringify({ ready: true, pid: process.pid, port: server.port, folder, data: join(root, 'data'), token }))
let stopping = false
const stop = async () => {
  if (stopping) return
  stopping = true
  server.stop(true)
  await app.close()
  console.log(JSON.stringify({ stopped: process.pid }))
  process.exit(0)
}
process.on('SIGTERM', () => { void stop() })
process.on('SIGINT', () => { void stop() })
