/** A session's title: named from the first words (auto), by the director with its first plan, or by the person.
 *  Pinned here: the planning turn of a session still named from its first words asks for a title and the plan's
 *  title names the session (recorded as the director's, an event on the interaction); a later plan does not rename
 *  it again; a session the person named is never renamed, and its planning turn does not ask. */

import { afterEach, expect, test } from 'bun:test'
import { agentMentionToken, type InteractionDetail } from '@oasis-code/contract'
import * as repo from '../src/db/repo.ts'
import { isRequest, isUserPrompt, lastToolReturn, modelResponse, textPart, toolCallPart, type ModelMessage } from '../src/llm/messages.ts'
import type { App } from '../src/main.ts'
import { Client, json, makeApp } from './api_harness.ts'
import { legacyV1Director } from './director_surface_fixtures.ts'
import { buggyRepo, scriptedModel, setModel, sleep } from './harness.ts'

let app: App | null = null
afterEach(async () => {
  if (app) await app.close()
  app = null
})

const A = agentMentionToken('Scripted A', 'scripted:a', 'pt_aaaaaa')
const B = agentMentionToken('Scripted A', 'scripted:a', 'pt_bbbbbb')
const prompts = (messages: ModelMessage[]) => messages.filter(isRequest).flatMap((m) => m.parts).filter(isUserPrompt)
  .map((p) => (typeof p.content === 'string' ? p.content : p.content.filter((c): c is string => typeof c === 'string').join('\n')))

/** A director that plans each interaction it is asked about (both participants alone), with the title it is given. */
function planner(title: string | null, seen: string[]) {
  return scriptedModel((messages: ModelMessage[]) => {
    const last = prompts(messages).at(-1)!
    const planning = /Plan interaction (ix_[0-9a-f]+)/.exec(last)
    if (planning && !lastToolReturn(messages.slice(messages.findLastIndex((m) => isRequest(m) && m.parts.some(isUserPrompt))), 'schedule')) {
      seen.push(last)
      return modelResponse([toolCallPart('schedule', {
        interaction_id: planning[1], ...(title ? { title } : {}), then: 'stop',
        nodes: [{ id: 'a1', participant: 'pt_aaaaaa', depends_on: [], receives: [], workspace: 'own' }, { id: 'b1', participant: 'pt_bbbbbb', depends_on: [], receives: [], workspace: 'own' }],
      }, '')])
    }
    return modelResponse([textPart('Planned.')])
  }, 'scripted-b')
}

async function interaction(c: Client, sid: string, text: string): Promise<InteractionDetail> {
  legacyV1Director(app!.state, sid, { transport: 'native', model: 'scripted:b' })   // a pre-surface director row (director.v1): this test pins v1's planning texts; v2's are in test_collab_integration
  const detail = await json<InteractionDetail>(await c.post(`/api/sessions/${sid}/interactions`, { text, director_model: 'scripted:b' }))
  const end = Date.now() + 30_000
  for (;;) {
    const now = await json<InteractionDetail>(await c.get(`/api/interactions/${detail.id}`))
    if (['done', 'error', 'waiting', 'cancelled'].includes(now.status)) return now
    if (Date.now() > end) throw new Error(`interaction ${detail.id} is ${now.status}`)
    await sleep(20)
  }
}

async function session(title: string) {
  app = await makeApp()
  const c = new Client(app)
  setModel(app.state, 'scripted:a', scriptedModel(() => modelResponse([textPart('answered')])))
  const project = await json(await c.post('/api/projects', { source_path: buggyRepo() }))
  const s = await json(await c.post(`/api/projects/${project.id}/sessions`, { title }))
  return { c, sid: s.id as string }
}

test("the first plan's title names a session still named from its first words; a later plan leaves it", async () => {
  const { c, sid } = await session('用详细的数学推导「ODE 采样没有 log-prob」这个说法是否成立，然后请另一位检查并质疑')
  expect((await json(await c.get(`/api/sessions/${sid}`))).title_source).toBe('auto')
  const seen: string[] = []
  setModel(app!.state, 'scripted:b', planner('ODE 采样与 log-prob', seen))
  const first = await interaction(c, sid, `${A} 推导，${B} 质疑`)
  expect(first.status).toBe('done')
  expect(seen[0]).toContain("Session title: none yet. Give the plan a title — a few words saying what the user asked, in the user's language; the app names the session with it.")
  const titled = await json(await c.get(`/api/sessions/${sid}`))
  expect([titled.title, titled.title_source]).toEqual(['ODE 采样与 log-prob', 'director'])
  expect(first.events.filter((e) => e.kind === 'titled').map((e) => e.payload)).toEqual([{ title: 'ODE 采样与 log-prob' }])
  // the next plan in the session: not asked, and a title given anyway does not rename it
  setModel(app!.state, 'scripted:b', planner('another title', seen))
  await interaction(c, sid, `${A} 再推导一次，${B} 再看`)
  expect(seen[1]).not.toContain('Session title')
  expect((await json(await c.get(`/api/sessions/${sid}`))).title).toBe('ODE 采样与 log-prob')
})

test('a session the person named keeps its name, and its planning turn does not ask for one', async () => {
  const { c, sid } = await session('a long first message')
  const renamed = await json(await c.put(`/api/sessions/${sid}`, { title: 'My name for it' }))
  expect([renamed.title, renamed.title_source]).toEqual(['My name for it', 'person'])
  const seen: string[] = []
  setModel(app!.state, 'scripted:b', planner('The director would call it this', seen))
  expect((await interaction(c, sid, `${A} and ${B}: look`)).status).toBe('done')
  expect(seen[0]).not.toContain('Session title')
  expect(repo.getSession(app!.state.conn, sid)!.title).toBe('My name for it')
  // a title longer than a line is refused as the body's own error (the connector's schema says so too)
  const detail = await json<InteractionDetail>(await c.post(`/api/sessions/${sid}/interactions`, { text: `${A} and ${B}`, plan: { template: 'independent' } }))
  const refused = await c.post(`/api/interactions/${detail.id}/schedule`, { title: 'x'.repeat(61), nodes: [{ id: 'c1', participant: 'pt_aaaaaa', depends_on: [], receives: [], workspace: 'own' }] })
  expect(refused.status).toBe(422)
})
