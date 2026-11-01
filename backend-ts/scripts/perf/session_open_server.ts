/** Read-only measurement server. env -i, a PRE-MIGRATED SQLite backup, private HOME/data, a .benchmark-copy
 * marker, and a non-production port are required. Never calls app.start()/app.close(), task recovery or a model. */
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Database } from 'bun:sqlite'
const required = (name: string) => process.env[name] || (() => { throw Error(`${name} required`) })()
const root = realpathSync(required('BENCH_ROOT')), tree = realpathSync(required('BENCH_TREE'))
const data = realpathSync(join(root, 'data')), port = Number(required('BENCH_PORT'))
if (!existsSync(join(root, '.benchmark-copy')) || !data.startsWith(root + sep)) throw Error('only an explicitly prepared private copy may be measured')
if (!Number.isInteger(port) || port < 1024 || port > 65535 || [8321, 8324, 8399].includes(port)) throw Error('protected/invalid port')
mkdirSync(join(root, 'logs'), { recursive: true })
const version = await import(pathToFileURL(join(tree, 'contract/src/version.ts')).href)
const check = new Database(join(data, 'index.db'), { readonly: true })
const schema = (check.query('PRAGMA user_version').get() as { user_version: number }).user_version
check.close()
if (schema !== version.SCHEMA_VERSION) throw Error('migrate the private copy in a separate process before measurement')
globalThis.fetch = Object.assign(async () => { throw Error('benchmark outbound fetch disabled') },
  { preconnect: () => { throw Error('benchmark outbound preconnect disabled') } })
const { createApp } = await import(pathToFileURL(join(tree, 'backend-ts/src/main.ts')).href)
const { Settings } = await import(pathToFileURL(join(tree, 'backend-ts/src/config.ts')).href)
const app = await createApp(new Settings({ data_dir: data, host: '127.0.0.1', port, session_token: 'bench-only-local-not-a-user-credential' }), null,
  { probe: false, remote_provider: () => { throw Error('benchmark remote disabled') }, director: { fetchImpl: async () => { throw Error('benchmark director disabled') } } })
if (process.env.BENCH_ASSETS) {
  const source = realpathSync(process.env.BENCH_ASSETS)
  app.state.store.read = (relative: string) => {
    const path = realpathSync(resolve(source, relative.replace(/\\/g, '/')))
    if (!path.startsWith(source + sep)) throw Error('asset escape')
    return readFileSync(path)
  }
}
for (const method of ['put', 'save', 'saveFile']) app.state.store[method] = () => { throw Error('benchmark asset writes disabled') }
app.state.conn.run('PRAGMA query_only=ON')
let seq = 0
const pending: unknown[] = []
const flush = () => { if (pending.length) appendFileSync(join(root, 'logs/server-requests.jsonl'), pending.splice(0).map(v => JSON.stringify(v)).join('\n') + '\n') }
const server = Bun.serve({ hostname: '127.0.0.1', port, idleTimeout: 255, async fetch(request, server) {
  const path = new URL(request.url).pathname, begin = performance.now(), id = ++seq
  const denied = request.method !== 'GET' || /^\/api\/(workspaces|fs|accounts|ssh|uploads|share|live-share)(\/|$)/.test(path) || path.includes('/site-icons/by-host/')
  const response = denied ? Response.json({ detail: 'benchmark excludes external/workspace/mutation operations' }, { status: 409 }) : await app.fetch(request, server)
  const ms = performance.now() - begin
  response.headers.set('Server-Timing', `app;dur=${ms.toFixed(3)}`)
  response.headers.set('X-Bench-Request', String(id))
  pending.push({ id, path, method: request.method, status: response.status, ms, at: Date.now(), denied })
  return response
} })
writeFileSync(join(root, 'logs/server.pid'), String(process.pid))
appendFileSync(join(root, 'logs/processes.jsonl'), JSON.stringify({ role: 'backend', pid: process.pid, port, schema, tree, started: new Date().toISOString(), start_called: false }) + '\n')
console.log(JSON.stringify({ ready: true, pid: process.pid, port, schema }))
setInterval(flush, 1000).unref()
function stop() {
  server.stop(true); flush(); app.state.conn.close(); app.state.release_data()
  appendFileSync(join(root, 'logs/processes.jsonl'), JSON.stringify({ role: 'backend', pid: process.pid, stopped: new Date().toISOString() }) + '\n')
  process.exit(0)
}
process.on('SIGTERM', stop); process.on('SIGINT', stop)
