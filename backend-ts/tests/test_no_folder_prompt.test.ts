/** What a run is told first in a session with no project folder, and what the director is told it is. With no folder
 *  the first message says the conversation's own folder starts empty (for files the request calls for), lists no
 *  guard of the app's own folders (a write there is still refused), and an interaction's steps say nothing of a copy
 *  of files that are not there; a session on a folder keeps every line. The director is the interaction's router: it
 *  plans the order and hands on the user's words, never a position, an angle or content of its own. */

import { afterEach, expect, test } from 'bun:test'
import { agentMentionToken, type InteractionDetail } from '@oasis-code/contract'
import { isRequest, isUserPrompt, modelResponse, textPart, toolCallPart, toolReturns, type ModelMessage } from '../src/llm/messages.ts'
import { NATIVE_INSTRUCTIONS } from '../src/director/manual.ts'
import { PROMPT_TEXT } from '../src/prompt_texts.ts'
import type { App } from '../src/main.ts'
import { Client, json, makeApp } from './api_harness.ts'
import { buggyRepo, scriptedModel, setModel, sleep, waitDone } from './harness.ts'

let app: App | null = null
afterEach(async () => { if (app) await app.close(); app = null })

const MODEL = 'scripted:a'
const prompts = (messages: ModelMessage[]) => messages.filter(isRequest).flatMap((m) => m.parts).filter(isUserPrompt).map((p) => (typeof p.content === 'string' ? p.content : p.content.filter((c): c is string => typeof c === 'string').join('\n'))).join('\n')

async function sessionOn(body: Record<string, unknown>) {
  app = await makeApp()
  const c = new Client(app)
  const project = await json(await c.post('/api/projects', body))
  const s = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'first words', model: MODEL }))
  return { c, sid: s.id as string }
}

test('with no project folder the first message says the folder is the conversation\'s own and empty, and guards nothing of the app\'s', async () => {
  const { c, sid } = await sessionOn({ no_folder: true })
  const seen: ModelMessage[][] = []
  setModel(app!.state, MODEL, scriptedModel((m: ModelMessage[]) => {
    seen.push(m)
    // a write into a guarded folder is still refused, with its reason (the tests' configuration guards secrets/**)
    if (!toolReturns(m).some((p) => p.tool_name === 'write_file')) return modelResponse([toolCallPart('write_file', { path: 'secrets/x.md', content: 'x' }, '')])
    return modelResponse([textPart('done')])
  }))
  const run = await json(await c.post(`/api/sessions/${sid}/chat`, { text: '东京酒店怎么选？' }))
  await waitDone(app!.state, run.id as string)
  const first = prompts(seen[0]!)
  expect(first).toMatch(/^Working folder: \S+\. No project folder was chosen: this folder is the conversation's own, empty at the start, for files the request calls for\. Relative paths start here\.\n/)
  expect(app!.state.config.protected_paths.length).toBeGreaterThan(0)
  expect(first).not.toContain('File restrictions')
  for (const guarded of app!.state.config.protected_paths) expect(first).not.toContain(guarded)
  expect(first).toEndWith('东京酒店怎么选？')
  const refused = toolReturns(seen[1]!).find((p) => p.tool_name === 'write_file')!
  expect(JSON.stringify(refused.content)).toContain('secrets/')
  expect(JSON.stringify(refused.content)).not.toContain('"status":"ok"')
}, 60_000)

test('on a folder the first message keeps the working folder line and the app\'s guarded folders', async () => {
  const { c, sid } = await sessionOn({ source_path: buggyRepo() })
  const seen: ModelMessage[][] = []
  setModel(app!.state, MODEL, scriptedModel((m: ModelMessage[]) => { seen.push(m); return modelResponse([textPart('done')]) }))
  const run = await json(await c.post(`/api/sessions/${sid}/chat`, { text: 'fix the bug' }))
  await waitDone(app!.state, run.id as string)
  const first = prompts(seen[0]!)
  expect(first).toMatch(/^Working folder: \S+\. Relative paths start here\.\n/)
  expect(first).toContain(`File restrictions:\n${app!.state.config.protected_paths.map((p) => `${p}: read-only.`).join('\n')}`)
}, 60_000)

test("an interaction's steps with no project folder say nothing of a copy of files; on a folder they do", async () => {
  for (const body of [{ no_folder: true }, { source_path: buggyRepo() }]) {
    const { c, sid } = await sessionOn(body)
    const seen: string[] = []
    setModel(app!.state, MODEL, scriptedModel((m: ModelMessage[]) => { seen.push(prompts(m)); return modelResponse([textPart('answered')]) }))
    const A = agentMentionToken('Scripted A', MODEL, 'pt_aaaaaa')
    const B = agentMentionToken('Scripted A', MODEL, 'pt_bbbbbb')
    const detail = await json<InteractionDetail>(await c.post(`/api/sessions/${sid}/interactions`, { text: `${A} ${B} 各自回答`, plan: { template: 'independent' } }))
    for (let i = 0; i < 400; i += 1) {
      const now = await json<InteractionDetail>(await c.get(`/api/interactions/${detail.id}`))
      if (now.nodes.every((n) => n.status === 'done')) break
      await sleep(25)
    }
    expect(seen).toHaveLength(2)
    for (const words of seen) {
      expect(words).toContain('Handed the answers of: none (you work without seeing the other participants).')
      if ('no_folder' in body) expect(words).not.toContain('Working copy:')
      else expect(words).toContain('Working copy: your own copy of the files, from the common starting point.')
    }
    await app!.close()
    app = null
  }
}, 120_000)

test('the director is told it routes: the user\'s words to every participant, the order its own, no content of its own', () => {
  const plan = PROMPT_TEXT['director.plan']
  expect(plan).toContain("You are its router: every participant is handed the user's message as written, and you decide only the order")
  expect(plan).toContain('Give no participant a position, an angle, a sub-question, facts or claims of your own')
  expect(PROMPT_TEXT['connector_parameter.schedule.nodes']).toContain('Never a position, an angle, a question or facts of your own')
  expect(NATIVE_INSTRUCTIONS).toContain('You are the router, not a participant and not an author')
  expect(NATIVE_INSTRUCTIONS).toContain("hand over the user's words as written and the material they need (earlier answers, files), quoted as it is rather than summarized")
})
