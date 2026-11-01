/** Loopback-only diagnostic: actual opening request(s) beside a lightweight API, optionally with writes on an
 * independent SQLite connection to an explicitly marked EXTRA copy. Not a browser timing or real user write. */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { Database } from 'bun:sqlite'
const root = resolve(process.env.BENCH_ROOT || (() => { throw Error('BENCH_ROOT required') })())
const base = process.env.BASE || 'http://127.0.0.1:18431'
const url = new URL(base)
if (url.hostname !== '127.0.0.1' || [8321, 8324, 8399].includes(Number(url.port))) throw Error('protected/non-loopback server')
const sample = JSON.parse(readFileSync(join(root, 'logs/selected.json'), 'utf8')).find((s: { label: string }) => s.label === (process.env.LABEL || 'history'))
if (!sample) throw Error('unknown sample alias')
let noise: Database | null = null
if (process.env.BENCH_NOISE_DB) {
  const path = resolve(process.env.BENCH_NOISE_DB)
  if (!existsSync(join(dirname(path), '.benchmark-noise'))) throw Error('noise writes require an explicitly prepared EXTRA copy')
  noise = new Database(path)
  noise.exec('CREATE TABLE IF NOT EXISTS benchmark_neighbor_noise (id INTEGER PRIMARY KEY, n INTEGER NOT NULL)')
  noise.run('INSERT OR IGNORE INTO benchmark_neighbor_noise VALUES(1,0)')
}
const headers = { 'x-oasis-code-token': 'bench-only-local-not-a-user-credential' }
const get = async (path: string) => {
  const res = await fetch(base + path, { headers })
  if (!res.ok) throw Error(`benchmark request failed: ${res.status}`)
  return res.json() as Promise<any>
}
async function opening() {
  const detail = await get(`/api/sessions/${sample.id}${process.env.BENCH_MODE === 'bundled' ? '?transcripts=1' : ''}`)
  let requests = 1
  if (process.env.BENCH_MODE !== 'bundled') {
    const targets = detail.runs.filter((r: any) => !['running', 'queued'].includes(r.status) && r.id !== detail.active_run?.id)
    let next = 0
    await Promise.all(Array.from({ length: Math.min(8, targets.length) }, async () => {
      while (next < targets.length) { const run = targets[next++]; await get(`/api/runs/${run.id}/transcript`); requests++ }
    }))
  }
  return requests
}
const rows = []
for (const mode of ['process_cold', 'same_process_warm', ...(noise ? ['neighbor_writes'] : [])]) {
  const pings: { start: number; duration: number }[] = []
  let active = true, writes = 0
  const writer = mode === 'neighbor_writes' ? setInterval(() => { noise!.run('UPDATE benchmark_neighbor_noise SET n=n+1 WHERE id=1'); writes++ }, 10) : null
  const start = performance.now()
  const probing = (async () => {
    await Bun.sleep(5)
    while (active) { const t = performance.now(); await get('/api/meta/build'); pings.push({ start: t - start, duration: performance.now() - t }); await Bun.sleep(5) }
  })()
  let requests = 0
  try { requests = await opening() } finally { active = false; if (writer) clearInterval(writer) }
  const duration = performance.now() - start
  await probing
  rows.push({ label: sample.label, mode, opening_ms: duration, requests, writes, pings })
}
noise?.close()
writeFileSync(join(root, 'logs', `${process.env.PREFIX || 'concurrency'}-concurrency.json`), JSON.stringify(rows, null, 2))
console.log(JSON.stringify(rows))
