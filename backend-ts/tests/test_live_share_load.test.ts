/** Evidence, not a gate of the regular suite (LIVE_SHARE_LOAD=1 runs it): a session near the projection's parse budget
 *  (about 90 MB of stored conversation records, synthetic) projected for a live viewer — in the worker, and in process
 *  for comparison — while the app's event loop is sampled every 5 ms. What it prints is the longest the loop was held
 *  and how long the first state took; the worker's loop delay must stay small whatever the projection costs. */

import { afterEach, expect, test } from 'bun:test'
import * as repo from '../src/db/repo.ts'
import type { App } from '../src/main.ts'
import { enable, liveApp, makeLink, openSession, Viewer } from './live_share_helpers.ts'

const RUN = process.env.LIVE_SHARE_LOAD === '1'
const apps: App[] = []
afterEach(async () => { for (const a of apps.splice(0)) await a.close() })

function seed(a: App, session: { id: string; project_id: string; workspace_id: string | null }, runs: number, perRunBytes: number): number {
  let total = 0
  const piece = 'lorem ipsum dolor sit amet '.repeat(5_000).slice(0, 120_000)
  for (let r = 0; r < runs; r++) {
    const messages: unknown[] = [{ kind: 'request', parts: [{ part_kind: 'user-prompt', content: `question ${r}`, origin: 'person' }] }]
    let size = 0
    while (size < perRunBytes) {
      messages.push({ kind: 'response', parts: [{ part_kind: 'text', content: piece }], timestamp: new Date().toISOString() })
      messages.push({ kind: 'request', parts: [{ part_kind: 'user-prompt', content: 'go on', origin: 'app' }] })
      size += piece.length + 120
    }
    const json = JSON.stringify(messages)
    total += json.length
    const run = repo.insertRun(a.state.conn, { session_id: session.id, project_id: session.project_id, workspace_id: session.workspace_id, model: 'scripted:a', model_config: {}, user_text: `question ${r}`, status: 'running', budget: {}, resumes_run_id: null, attachments: [] as never, spawned_by: 'human', relay_id: null, relay_step: null })
    repo.finishRun(a.state.conn, run.id, 'done', { history_json: json, usage: {}, error: null, receipt: {}, saved_seq: 0 })
  }
  return total
}

async function measure(kind: 'worker' | 'inline'): Promise<{ maxLagMs: number; firstStateMs: number; rebuildMaxLagMs: number; historyMB: number }> {
  const a = await liveApp({ projector: kind, min_interval_ms: 50 })
  apps.push(a)
  const port = await enable(a)
  const session = await openSession(a)
  const bytes = seed(a, session, 30, 3_000_000)
  const link = await makeLink(a, session.id)
  let maxLag = 0
  let last = performance.now()
  const timer = setInterval(() => { const now = performance.now(); maxLag = Math.max(maxLag, now - last - 5); last = now }, 5)
  const started = performance.now()
  const v = await Viewer.open(port, link.capability)
  await v.until((x) => x.states().length >= 1, 120_000)
  const firstStateMs = performance.now() - started
  const firstLag = maxLag
  maxLag = 0
  for (let k = 0; k < 3; k++) {
    a.state.conn.run('UPDATE sessions SET title=?, updated_at=? WHERE id=?', [`Load ${k}`, new Date().toISOString(), session.id])
    await v.until((x) => x.last()!.snapshot.title === `Load ${k}`, 120_000)
  }
  clearInterval(timer)
  v.close()
  return { maxLagMs: Math.round(firstLag), firstStateMs: Math.round(firstStateMs), rebuildMaxLagMs: Math.round(maxLag), historyMB: Math.round(bytes / 1e6) }
}

test.skipIf(!RUN)('near the parse budget: the worker keeps the app\'s event loop free; in process it does not', async () => {
  const worker = await measure('worker')
  const inline = await measure('inline')
  console.log(`live-share load: worker ${JSON.stringify(worker)} inline ${JSON.stringify(inline)}`)
  // the worker holds the main loop only for the frame's fan-out (no parse, no projection, no serialization on it)
  expect(worker.maxLagMs).toBeLessThan(150)
  expect(worker.rebuildMaxLagMs).toBeLessThan(150)
}, 600_000)
