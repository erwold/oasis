/** What an interaction tells its director and its steps holds to the facts: in a folder edited in place the plan
 *  ask says there are no copies (and the detail says so for the page); a step that failed and was carried on is
 *  handed on with what its earlier attempt did; a plan naming a step twice in receives is refused whole. */

import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentMentionToken, type InteractionDetail } from '@oasis-code/contract'
import { planProblems } from '../src/agent/interactions.ts'
import * as repo from '../src/db/repo.ts'
import { isRequest, isUserPrompt, modelResponse, textPart, toolCallPart, toolReturns, type ModelMessage } from '../src/llm/messages.ts'
import { ModelHTTPError } from '../src/llm/model.ts'
import type { App } from '../src/main.ts'
import { Client, json, makeApp } from './api_harness.ts'
import { legacyV1Director } from './director_surface_fixtures.ts'
import { buggyRepo, scriptedModel, setModel, sleep, testSettings, waitDone } from './harness.ts'
import { tempDir } from './helpers.ts'

let app: App | null = null
afterEach(async () => {
  if (app) await app.close()
  app = null
})

const MODEL = 'scripted:a'
const DIRECTOR = 'scripted:b'
const A = agentMentionToken('Scripted A', MODEL, 'A')
const B = agentMentionToken('Scripted A', MODEL, 'B')

const userPrompts = (messages: ModelMessage[]) => messages.filter(isRequest).flatMap((m) => m.parts).filter(isUserPrompt).map((p) => (typeof p.content === 'string' ? p.content : p.content.filter((c): c is string => typeof c === 'string').join('\n')))
const whoAmI = (messages: ModelMessage[]): string => /You are ([A-Z])\./.exec(userPrompts(messages).join('\n'))?.[1] ?? '?'

async function session(settings = testSettings(), source: string = buggyRepo(), mode?: 'direct') {
  app = await makeApp(settings)
  const c = new Client(app)
  const project = await json(await c.post('/api/projects', { source_path: source, ...(mode ? { mode } : {}) }))
  const s = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'interaction facts' }))
  return { c, sid: s.id as string, settings }
}

async function waitInteraction(c: Client, id: string, statuses: string[], timeoutMs = 30_000): Promise<InteractionDetail> {
  const end = Date.now() + timeoutMs
  for (;;) {
    const detail = await json<InteractionDetail>(await c.get(`/api/interactions/${id}`))
    if (statuses.includes(detail.status)) {
      for (const n of detail.nodes) if (n.run_id && app!.state.runs.handles.get(n.run_id) && !app!.state.runs.handles.get(n.run_id)!.done) await waitDone(app!.state, n.run_id)
      return json<InteractionDetail>(await c.get(`/api/interactions/${id}`))
    }
    if (Date.now() > end) throw new Error(`interaction ${id} is ${detail.status} (${detail.reason ?? ''}), not ${statuses.join('|')}`)
    await sleep(20)
  }
}

test('in a folder edited in place, the director asked to plan is told there are no copies, and the detail says the interaction is in place', async () => {
  const dir = join(tempDir('oasis-inplace-plan-'), 'folder')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'README.md'), '# x\n')
  const { c, sid } = await session(testSettings(), dir, 'direct')
  setModel(app!.state, MODEL, scriptedModel((m: ModelMessage[]) => modelResponse([textPart(`${whoAmI(m)} ok`)])))
  const seen: { scheduleDescription: string; planInput: string } = { scheduleDescription: '', planInput: '' }
  const director = scriptedModel((m: ModelMessage[]) => {
    const last = userPrompts(m).at(-1) ?? ''
    const planning = /Plan interaction (ix_[0-9a-f]+)/.exec(last)
    if (planning && !toolReturns(m).some((p) => p.tool_name === 'schedule')) {
      seen.planInput = last
      return modelResponse([toolCallPart('schedule', { interaction_id: planning[1], nodes: [{ id: 'a1', participant: 'A', workspace: 'own' }, { id: 'b1', participant: 'B', workspace: 'own' }], then: 'stop' }, '')])
    }
    return modelResponse([textPart('Planned.')])
  }, 'scripted-b')
  setModel(app!.state, DIRECTOR, director)
  const original = director.requestStream.bind(director)
  director.requestStream = (messages, settings, params, ctx) => {
    const tool = params.function_tools.find((t) => t.name === 'schedule')
    if (tool) seen.scheduleDescription = `${tool.description}\n${JSON.stringify(tool.parameters_json_schema)}`
    return original(messages, settings, params, ctx)
  }
  legacyV1Director(app!.state, sid, { transport: 'native', model: DIRECTOR })   // a pre-surface director row (director.v1): this test pins v1's planning texts; v2's are in test_collab_integration
  const created = await json<InteractionDetail>(await c.post(`/api/sessions/${sid}/interactions`, { text: `${A} and ${B}: two independent candidate fixes`, director_model: DIRECTOR }))
  const done = await waitInteraction(c, created.id, ['done', 'waiting', 'error'], 60_000)
  expect(done.status).toBe('done')
  // the fact: both `own` steps ran in the one folder
  const wsIds = done.nodes.map((n) => n.workspace_id)
  expect(wsIds[0]).toBe(wsIds[1]!)
  expect(done.nodes.map((n) => n.workspace)).toEqual(['own', 'own'])             // the API still says own
  expect(seen.planInput).toContain('this session edits its folder in place, so there are no copies here')
  expect(seen.scheduleDescription).toContain('in a session that edits its folder in place')
  expect(done.in_place).toBe(true)
}, 60_000)


test('a step that wrote a file, failed and was carried on: the packet handed on keeps the earlier attempt\'s write and its failure, under the step\'s one heading', async () => {
  const { c, sid } = await session()
  let failA = true
  let packetSeenByB = ''
  setModel(app!.state, MODEL, scriptedModel((messages: ModelMessage[]) => {
    const me = whoAmI(messages)
    const prompts = userPrompts(messages)
    if (me === 'A' || prompts.some((t) => t.includes('Continue step a1 as A.'))) {
      if (!toolReturns(messages).some((p) => p.tool_name === 'write_file')) return modelResponse([toolCallPart('write_file', { path: 'FIX.md', content: 'the fix\n' }, '')])
      if (failA) throw new ModelHTTPError(400, 'scripted-a', { error: { message: 'boom after the write' } })
      return modelResponse([textPart('A: I wrote FIX.md')])
    }
    packetSeenByB = prompts.join('\n')
    return modelResponse([textPart('B read it')])
  }))
  const created = await json<InteractionDetail>(await c.post(`/api/sessions/${sid}/interactions`, { text: `${A} then ${B}`, plan: { nodes: [{ id: 'a1', participant: 'A' }, { id: 'b1', participant: 'B', depends_on: ['a1'], receives: ['a1'], workspace: 'a1' }], then: 'stop' } }))
  const failed = await waitInteraction(c, created.id, ['waiting', 'done', 'error'])
  expect(failed.nodes.map((n) => n.status)).toEqual(['error', 'queued'])
  const first = repo.getRun(app!.state.conn, failed.nodes[0]!.run_id!)!
  expect(first.status).toBe('error')
  failA = false
  await json(await c.post(`/api/interactions/${created.id}/continue`, {}))
  const done = await waitInteraction(c, created.id, ['done', 'waiting', 'error'])
  expect(done.status).toBe('done')
  expect(done.nodes[0]!.run_ids).toHaveLength(2)
  const packet = packetSeenByB.slice(packetSeenByB.indexOf('Step a1'))
  const attempt = packet.slice(packet.indexOf(`Earlier attempt of step a1 (run ${first.id})`))
  expect(attempt).toStartWith(`Earlier attempt of step a1 (run ${first.id}), which the run above carried on:`)
  expect(attempt).toContain('write_file FIX.md')
  expect(attempt).toContain('status error (')
  expect(attempt).toContain('boom after the write')
  expect(packetSeenByB.split('Step a1 (A, run').length - 1).toBe(1)
}, 60_000)


test('a plan naming the same step twice in receives is refused before anything starts', async () => {
  const { c, sid } = await session()
  setModel(app!.state, MODEL, scriptedModel(() => modelResponse([textPart('never')])))
  const res = await c.post(`/api/sessions/${sid}/interactions`, { text: `${A} then ${B}`, plan: { nodes: [{ id: 'a1', participant: 'A' }, { id: 'b1', participant: 'B', depends_on: ['a1'], receives: ['a1', 'a1', 'a1'] }], then: 'stop' } })
  expect(res.status).toBe(400)
  expect(JSON.stringify(await res.json())).toContain('node b1: receives a1 more than once')
  expect(repo.listInteractions(app!.state.conn, sid)).toHaveLength(0)
  const participants = [{ id: 'A', label: 'A', model: MODEL }, { id: 'B', label: 'B', model: MODEL }]
  const plan = [{ id: 'a1', participant: 'A', instruction: null, depends_on: [], receives: [], workspace: 'own' as const }, { id: 'b1', participant: 'B', instruction: null, depends_on: ['a1'], receives: ['a1', 'a1'], workspace: 'own' as const }]
  expect(planProblems(participants, [], plan, 6)).toEqual(['node b1: receives a1 more than once'])
})
