/** Continue carries failed steps on through the scheduler: the interaction's concurrency, its run budget and one run
 *  at a time per participant hold for the steps run again as for any other start. */

import { afterEach, expect, test } from 'bun:test'
import { agentMentionToken, type InteractionDetail } from '@oasis-code/contract'
import { modelResponse, textPart, type ModelMessage } from '../src/llm/messages.ts'
import { ModelHTTPError } from '../src/llm/model.ts'
import type { App } from '../src/main.ts'
import { Client, json, makeApp } from './api_harness.ts'
import { buggyRepo, scriptedModel, setModel, sleep, waitDone } from './harness.ts'

let app: App | null = null
afterEach(async () => { if (app) await app.close(); app = null })

const MODEL = 'scripted:a'
const [A, B, C] = ['A', 'B', 'C'].map((letter) => agentMentionToken('Scripted A', MODEL, letter))

async function waitSettled(c: Client, id: string): Promise<InteractionDetail> {
  const end = Date.now() + 60_000
  for (;;) {
    const detail = await json<InteractionDetail>(await c.get(`/api/interactions/${id}`))
    if (['waiting', 'done', 'error'].includes(detail.status)) {
      for (const n of detail.nodes) if (n.run_id && app!.state.runs.handles.get(n.run_id) && !app!.state.runs.handles.get(n.run_id)!.done) await waitDone(app!.state, n.run_id)
      return json<InteractionDetail>(await c.get(`/api/interactions/${id}`))
    }
    if (Date.now() > end) throw new Error(`interaction ${id} is still ${detail.status}`)
    await sleep(20)
  }
}

/** Three independent steps whose first runs fail; continue then runs them again with a model that answers slowly. */
async function failedThenContinued(maxRuns: number) {
  app = await makeApp()
  const c = new Client(app)
  const project = await json(await c.post('/api/projects', { source_path: buggyRepo() }))
  const session = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'continue limits' }))
  let fail = true
  let live = 0
  let peak = 0
  setModel(app.state, MODEL, scriptedModel(async () => {
    if (fail) throw new ModelHTTPError(400, 'scripted-a', { error: { message: 'boom' } })
    live += 1
    peak = Math.max(peak, live)
    await sleep(100)
    live -= 1
    return modelResponse([textPart('fine')])
  }))
  const created = await json<InteractionDetail>(await c.post(`/api/sessions/${session.id}/interactions`, { text: `${A} ${B} ${C} each alone`, plan: { template: 'independent' }, max_runs: maxRuns, concurrency: 1 }))
  const failed = await waitSettled(c, created.id)
  expect(failed.nodes.map((n) => n.status)).toEqual(['error', 'error', 'error'])
  expect(failed.runs_started).toBe(3)
  fail = false
  const res = await c.post(`/api/interactions/${created.id}/continue`, {})
  return { status: res.status, after: await waitSettled(c, created.id), peak: () => peak }
}

test('continue runs failed steps again one at a time within the concurrency', async () => {
  const { status, after, peak } = await failedThenContinued(6)
  expect(status).toBe(200)
  expect(peak()).toBe(1)
  expect(after.status).toBe('done')
  expect(after.nodes.map((n) => n.status)).toEqual(['done', 'done', 'done'])
  expect(after.runs_started).toBe(6)
  expect(after.nodes.every((n) => n.run_ids.length === 2)).toBe(true)                  // each carried its own run on
}, 90_000)

test("the person's continue grows a spent budget to cover the steps it runs again", async () => {
  const { status, after, peak } = await failedThenContinued(3)
  expect(status).toBe(200)
  expect(peak()).toBe(1)
  expect(after.status).toBe('done')
  expect(after.runs_started).toBe(6)
  expect(after.budget.max_runs).toBe(6)
  expect(after.events.find((e) => e.kind === 'budget_grown')?.payload).toEqual({ from: 3, to: 6 })
}, 90_000)

test("steps the person asks for go on a finished interaction, its budget grown to fit; the director's plan stays within it; never past the ceiling", async () => {
  app = await makeApp()
  const c = new Client(app)
  const project = await json(await c.post('/api/projects', { source_path: buggyRepo() }))
  const session = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'another round' }))
  const seen: string[] = []
  setModel(app.state, MODEL, scriptedModel(async (messages: ModelMessage[]) => {
    seen.push(JSON.stringify(messages.at(-1)))
    return modelResponse([textPart('fine')])
  }))
  const created = await json<InteractionDetail>(await c.post(`/api/sessions/${session.id}/interactions`, { text: `${A} ${B} ${C} each alone`, plan: { template: 'independent' }, max_runs: 3 }))
  const done = await waitSettled(c, created.id)
  expect(done.status).toBe('done')
  const ids = done.nodes.map((n) => n.id)
  const round = done.participants.map((p, i) => ({ id: `cross-1-${i + 1}`, participant: p.id, depends_on: ids, receives: done.nodes.filter((n) => n.participant !== p.id).map((n) => n.id), workspace: 'own' as const }))
  expect((await json(await c.post(`/api/interactions/${created.id}/schedule`, { nodes: round, then: 'stop' }), 400)).detail).toContain('the budget allows 3 runs')
  await c.post(`/api/interactions/${created.id}/notes`, { to: 'everyone', text: 'ONE MORE ROUND PLEASE' })
  const grown = await json<InteractionDetail>(await c.post(`/api/interactions/${created.id}/steps`, { nodes: round, then: 'stop' }))
  expect(grown.budget.max_runs).toBe(6)
  const after = await waitSettled(c, created.id)
  expect(after.status).toBe('done')
  expect(after.nodes.filter((n) => n.id.startsWith('cross-1-')).map((n) => n.status)).toEqual(['done', 'done', 'done'])
  expect(seen.filter((m) => m.includes('ONE MORE ROUND PLEASE'))).toHaveLength(3)                  // each of the round took the note
  const more = (from: number, count: number) => Array.from({ length: count }, (_, i) => ({ id: `more-${from + i}`, participant: 'A', depends_on: [], receives: [], workspace: 'own' as const }))
  expect((await json<InteractionDetail>(await c.post(`/api/interactions/${created.id}/steps`, { nodes: more(0, 12), then: 'stop' }))).budget.max_runs).toBe(18)
  expect((await json<InteractionDetail>(await c.post(`/api/interactions/${created.id}/steps`, { nodes: more(12, 12), then: 'stop' }))).budget.max_runs).toBe(30)
  expect((await json(await c.post(`/api/interactions/${created.id}/steps`, { nodes: more(24, 1), then: 'stop' }), 409)).detail).toContain('would need 31 runs in all; at most 30')
  await waitSettled(c, created.id)
}, 90_000)
