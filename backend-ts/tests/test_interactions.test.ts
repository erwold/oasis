/** The interaction: one message to several agents run as a graph of nodes. Pinned here: two participants on one
 *  model are two (their aliases from the message's tokens), the independent template runs them side by side on two
 *  copies of one starting point, each sees only its own conversation and files, the session's folder and
 *  conversation stay untouched until the person adopts a result (the integration's honesty: composed, checked, written
 *  only at the base); the director plans the graph with schedule (a DAG: two alone, a third handed both answers) and
 *  is asked again only where the plan says so — never per run; a plan that is not sound is refused; a director that
 *  plans nothing leaves the interaction to the person; Stop, the idempotency key, a restart, the budget, a node that
 *  waits for the person's decision, a node that fails. */

import { afterEach, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentMentionToken, type DirectorTurn, type InteractionDetail } from '@oasis-code/contract'
import * as repo from '../src/db/repo.ts'
import * as dstore from '../src/director/store.ts'
import { isRequest, isUserPrompt, lastToolReturn, loadValue, modelResponse, textPart, toolCallPart, toolReturns, type ModelMessage } from '../src/llm/messages.ts'
import { ModelHTTPError } from '../src/llm/model.ts'
import type { App } from '../src/main.ts'
import { applySessionMode } from '../src/policy/modes.ts'
import { planProblems } from '../src/agent/interactions.ts'
import { Client, json, makeApp } from './api_harness.ts'
import { legacyV1Director } from './director_surface_fixtures.ts'
import { buggyRepo, scriptedModel, setModel, sleep, testSettings, waitDone } from './harness.ts'
import { rec } from './tree_helpers.ts'

let app: App | null = null
let release: () => void = () => {}
afterEach(async () => {
  release()
  if (app) await app.close()
  app = null
})

const MODEL = 'scripted:a'
const DIRECTOR = 'scripted:b'
const A = agentMentionToken('Scripted A', MODEL, 'A')
const B = agentMentionToken('Scripted A', MODEL, 'B')
const C = agentMentionToken('Scripted A', MODEL, 'C')

const userPrompts = (messages: ModelMessage[]) => messages.filter(isRequest).flatMap((m) => m.parts).filter(isUserPrompt).map((p) => (typeof p.content === 'string' ? p.content : p.content.filter((c): c is string => typeof c === 'string').join('\n')))
/** Who a participant's run is, read off its roster line. */
const whoAmI = (messages: ModelMessage[]): string => /You are ([A-Z])\./.exec(userPrompts(messages).join('\n'))?.[1] ?? '?'

async function session() {
  app = await makeApp()
  const c = new Client(app)
  const project = await json(await c.post('/api/projects', { source_path: buggyRepo() }))
  const s = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'interaction' }))
  return { c, sid: s.id as string, project: project.id as string, ws: rec(s.workspace).id as string }
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

async function waitTurn(c: Client, turnId: string, ok: (t: DirectorTurn) => boolean, timeoutMs = 30_000): Promise<DirectorTurn> {
  const end = Date.now() + timeoutMs
  for (;;) {
    const turn = await json<DirectorTurn>(await c.get(`/api/director-turns/${turnId}`))
    if (ok(turn)) return turn
    if (Date.now() > end) throw new Error(`turn ${turnId} is ${turn.status}`)
    await sleep(20)
  }
}

// ---- the independent template: two alone, the person adopts -----------------------------------------------------

test('independent: two participants on one model run side by side on two copies of one starting point, each alone; the person adopts one', async () => {
  const { c, sid, ws } = await session()
  setModel(app!.state, MODEL, scriptedModel(() => modelResponse([textPart('hello back')])))
  const before = await json(await c.post(`/api/sessions/${sid}/chat`, { text: 'hello first' }))
  await waitDone(app!.state, before.id as string)
  const seen: Record<string, ModelMessage[]> = {}
  let started = 0
  const both = new Promise<void>((r) => { release = r })
  setModel(app!.state, MODEL, scriptedModel(async (messages: ModelMessage[]) => {
    const me = whoAmI(messages)
    if (!toolReturns(messages).some((p) => p.tool_name === 'write_file')) {
      started += 1
      if (started === 2) release()
      await both                                                                        // neither ends before both have begun
      return modelResponse([toolCallPart('write_file', { path: `NOTES-${me}.md`, content: `written by ${me}\n` }, '')])
    }
    seen[me] = messages
    return modelResponse([textPart(`${me}_DONE: I wrote NOTES-${me}.md`)])
  }))
  const text = `${A} and ${B}: fix the bug independently, each on your own copy. I will choose.`
  const detail = await json<InteractionDetail>(await c.post(`/api/sessions/${sid}/interactions`, { text, plan: { template: 'independent' }, client_request_id: 'ix-0001-independent' }))
  expect(detail.status).toBe('running')
  expect(detail.controller).toBe('fixed')
  expect(detail.template).toBe('independent')
  expect(detail.participants).toEqual([{ id: 'A', label: 'Scripted A', model: MODEL }, { id: 'B', label: 'Scripted A', model: MODEL }])
  expect(detail.nodes.map((n) => [n.id, n.participant, n.workspace, n.status, n.depends_on, n.receives])).toEqual([['a1', 'A', 'own', 'running', [], []], ['b1', 'B', 'own', 'running', [], []]])
  expect(detail.base_checkpoint_id).toStartWith('cp_')
  expect(detail.budget).toEqual({ max_runs: 6, concurrency: 2 })
  expect(detail.runs_started).toBe(2)
  expect(detail.attachments).toEqual([])
  // the same key again is the same interaction; a message to the agents meanwhile is refused
  expect((await json(await c.post(`/api/sessions/${sid}/interactions`, { text, plan: { template: 'independent' }, client_request_id: 'ix-0001-independent' }))).id).toBe(detail.id)
  expect((await json(await c.post(`/api/sessions/${sid}/chat`, { text: 'another thing' }), 409)).detail).toContain('an interaction is under way')
  const done = await waitInteraction(c, detail.id, ['done', 'error', 'waiting', 'cancelled'])
  expect(done.status).toBe('done')
  expect(done.nodes.map((n) => n.status)).toEqual(['done', 'done'])
  expect(done.live).toBe(false)
  const [a1, b1] = done.nodes
  const runA = repo.getRun(app!.state.conn, a1!.run_id!)!
  const runB = repo.getRun(app!.state.conn, b1!.run_id!)!
  // two copies, of one starting point, neither the session's folder
  expect(runA.workspace_id).not.toBe(ws)
  expect(runB.workspace_id).not.toBe(ws)
  expect(runA.workspace_id).not.toBe(runB.workspace_id)
  const base = repo.getCheckpoint(app!.state.conn, done.base_checkpoint_id!)!
  expect(repo.getWorkspace(app!.state.conn, runA.workspace_id!)!.base_commit).toBe(base.commit_sha)
  expect(repo.getWorkspace(app!.state.conn, runB.workspace_id!)!.base_commit).toBe(base.commit_sha)
  expect(repo.getWorkspace(app!.state.conn, runA.workspace_id!)!.kind).toBe('child')
  // fresh conversations, each its own: the roster names the speaker, the request reads by the letters, nothing of the other
  expect(runA.resumes_run_id).toBeNull()
  expect(runB.resumes_run_id).toBeNull()
  expect(runA.model).toBe(MODEL)
  expect(runB.model).toBe(MODEL)
  expect(runA.interaction_id).toBe(detail.id)
  expect(runA.interaction_node).toBe('a1')
  const openingA = userPrompts(seen.A!).join('\n')
  const openingB = userPrompts(seen.B!).join('\n')
  expect(openingA).toContain('Participants:\nA: Scripted A (scripted:a)\nB: Scripted A (scripted:a)\nYou are A.')
  expect(openingB).toContain('You are B.')
  expect(openingA).toContain('Step a1 of the plan (0 of 2 steps ended). Speaker: A.\nAfter: nothing (this step starts at once).\nHanded the answers of: none (you work without seeing the other participants).\nWorking copy: your own copy of the files, from the common starting point.')
  expect(openingA).toEndWith('@A and @B: fix the bug independently, each on your own copy. I will choose.')
  expect(openingA).not.toContain('B_DONE')
  expect(openingB).not.toContain('A_DONE')
  expect(openingA).not.toContain('Step b1')
  expect(seen.A!).toHaveLength(seen.B!.length)
  // the files: each copy holds its own note, the session's folder neither
  const wsA = repo.getWorkspace(app!.state.conn, runA.workspace_id!)!
  const wsB = repo.getWorkspace(app!.state.conn, runB.workspace_id!)!
  expect(readFileSync(join(wsA.path, 'NOTES-A.md'), 'utf8')).toBe('written by A\n')
  expect(existsSync(join(wsA.path, 'NOTES-B.md'))).toBe(false)
  expect(readFileSync(join(wsB.path, 'NOTES-B.md'), 'utf8')).toBe('written by B\n')
  const sessionWs = repo.getWorkspace(app!.state.conn, ws)!
  expect(existsSync(join(sessionWs.path, 'NOTES-A.md'))).toBe(false)
  expect(existsSync(join(sessionWs.path, 'NOTES-B.md'))).toBe(false)
  // the session detail carries the interaction; its steps are on its board, not in the thread (schema v25: the thread
  // lists the runs placed in it — the main agent's and a relay's turns; the steps are the members' — see
  // docs/multi-agent-unification-design.md §5.3; before v25 the thread listed them too)
  const s = await json(await c.get(`/api/sessions/${sid}`))
  expect((s.interactions as InteractionDetail[]).map((ix) => ix.id)).toEqual([detail.id])
  expect((s.runs as Record<string, unknown>[]).map((r) => r.interaction_node)).toEqual([null])
  expect(s.active_run).toBeNull()
  const events = done.events.map((e) => e.kind)
  expect(events.slice(0, 2)).toEqual(['created', 'planned'])
  expect(events.filter((k) => k === 'node_started')).toHaveLength(2)
  expect(events.filter((k) => k === 'node_finished')).toHaveLength(2)
  // the session's conversation stands where the person left it: a plain message continues the run before the interaction
  setModel(app!.state, MODEL, scriptedModel(() => modelResponse([textPart('plain')])))
  const after = await json(await c.post(`/api/sessions/${sid}/chat`, { text: 'and now?' }))
  expect(after.resumes_run_id).toBe(before.id as string)
  await waitDone(app!.state, after.id as string)
  // adopting A: its final state composed into the session's folder; adopting B then finds the folder moved on — said so
  const adoptedA = await json(await c.post(`/api/interactions/${detail.id}/adopt`, { node_id: 'a1' }))
  expect(adoptedA.status).toBe('integrated')
  expect(adoptedA.applied_to_workspace).toBe(true)
  expect(readFileSync(join(sessionWs.path, 'NOTES-A.md'), 'utf8')).toBe('written by A\n')
  const adoptedB = await json(await c.post(`/api/interactions/${detail.id}/adopt`, { node_id: 'b1' }))
  expect(adoptedB.status).toBe('integrated')
  expect(adoptedB.applied_to_workspace).toBe(false)
  expect(adoptedB.reason).toContain('base drift')
  expect(existsSync(join(sessionWs.path, 'NOTES-B.md'))).toBe(false)
  expect((await json(await c.post(`/api/interactions/${detail.id}/adopt`, { node_id: 'zz' }), 404)).detail).toContain('no step zz')
  const adopted = (await json<InteractionDetail>(await c.get(`/api/interactions/${detail.id}`))).events.filter((e) => e.kind === 'adopted')
  expect(adopted.map((e) => [e.payload.node, e.payload.applied_to_workspace])).toEqual([['a1', true], ['b1', false]])
}, 60_000)

// ---- the director plans --------------------------------------------------------------------------------------------

test('the director plans a graph with schedule: two alone, a third handed both answers; it is asked again only at the end, once', async () => {
  const { c, sid } = await session()
  const seen: Record<string, ModelMessage[]> = {}
  setModel(app!.state, MODEL, scriptedModel((messages: ModelMessage[]) => {
    const me = whoAmI(messages)
    seen[me] = messages
    const prompts = userPrompts(messages).join('\n')
    if (me === 'C') {
      const a = prompts.includes('A_MARK') && /Step a1 \(A, run run_[0-9a-f]+\):/.test(prompts)
      const b = prompts.includes('B_MARK') && /Step b1 \(B, run run_[0-9a-f]+\):/.test(prompts)
      return modelResponse([textPart(a && b ? 'C_COMPARED: both answers read' : `C_MISSING: a ${a} b ${b}`)])
    }
    return modelResponse([textPart(`${me}_MARK: my answer`)])
  }))
  const directorSeen: ModelMessage[][] = []
  let interactionId = ''
  setModel(app!.state, DIRECTOR, scriptedModel((messages: ModelMessage[]) => {
    directorSeen.push(messages)
    const prompts = userPrompts(messages)
    const last = prompts.at(-1)!
    const planning = /Plan interaction (ix_[0-9a-f]+)/.exec(last)
    const scheduled = lastToolReturn(messages, 'schedule')
    if (planning && !scheduled) {
      interactionId = planning[1]!
      return modelResponse([toolCallPart('schedule', {
        interaction_id: interactionId, then: 'director',
        nodes: [
          { id: 'a1', participant: 'A', depends_on: [], receives: [], workspace: 'own' },
          { id: 'b1', participant: 'B', depends_on: [], receives: [], workspace: 'own', instruction: 'Take the other approach.' },
          { id: 'c1', participant: 'C', depends_on: ['a1', 'b1'], receives: ['a1', 'b1'], workspace: 'shared' },
        ],
      }, '')])
    }
    if (scheduled && !prompts.some((t) => t.includes('every step of the plan ended'))) return modelResponse([textPart(`Planned: A and B work alone, C compares. ${JSON.stringify(rec(scheduled).nodes)}`)])
    return modelResponse([textPart('DECIDED: nothing more is needed; the person chooses.')])
  }, 'scripted-b'))
  const text = `${A} and ${B} propose a fix independently. ${C} then compares both and recommends one; do not apply it.`
  legacyV1Director(app!.state, sid, { transport: 'native', model: DIRECTOR })   // a pre-surface director row (director.v1): this test pins v1's planning texts; v2's are in test_collab_integration
  const detail = await json<InteractionDetail>(await c.post(`/api/sessions/${sid}/interactions`, { text, director_model: DIRECTOR }))
  expect(detail.status).toBe('planning')
  expect(detail.controller).toBe('director')
  expect(detail.nodes).toEqual([])
  expect(detail.director_session_id).toStartWith('dir_')
  expect(detail.director_turn_id).toStartWith('turn_')
  // a native director was opened on the route named
  const ds = await json(await c.get(`/api/sessions/${sid}/director`))
  expect(rec(ds.director).transport).toBe('native')
  expect(rec(ds.director).model).toBe(DIRECTOR)
  const planned = await waitInteraction(c, detail.id, ['running', 'deciding', 'done', 'waiting', 'error'])
  expect(['running', 'deciding', 'done']).toContain(planned.status)
  const done = await waitInteraction(c, detail.id, ['done', 'error', 'waiting', 'cancelled'], 60_000)
  expect(done.status).toBe('done')
  expect(done.revision).toBe(1)
  expect(done.then).toBe('director')
  expect(done.nodes.map((n) => [n.id, n.participant, n.workspace, n.status, n.depends_on, n.receives, n.instruction])).toEqual([
    ['a1', 'A', 'own', 'done', [], [], null], ['b1', 'B', 'own', 'done', [], [], 'Take the other approach.'], ['c1', 'C', 'shared', 'done', ['a1', 'b1'], ['a1', 'b1'], null],
  ])
  expect(done.nodes.map((n) => n.wave)).toEqual([1, 1, 2])                                          // a1 and b1 start together; c1 after them
  expect(done.runs_started).toBe(3)
  // the planning turn: the request by the letters, the roster, the rules; its input named the interaction
  const planningTurn = userPrompts(directorSeen[0]!).at(-1)!
  expect(planningTurn).toContain(`App note: Plan interaction ${detail.id}.`)
  expect(planningTurn).toContain('You are running an interaction:')                                  // the job, before the facts
  expect(planningTurn).toContain(`Interaction: ${detail.id}\nParticipants (3):\n- A: Scripted A (scripted:a)\n- B: Scripted A (scripted:a)\n- C: Scripted A (scripted:a)`)
  expect(planningTurn).toContain('Attachments the user attached: none')
  expect(planningTurn).toContain('Tools: schedule (the plan; its description gives the format)')
  expect(planningTurn).not.toContain('depends_on names the steps')                                   // the plan's format is the tool's description, not the turn's
  expect(planningTurn).toContain("The user's request:\n@A and @B propose a fix independently. @C then compares both and recommends one; do not apply it.")
  expect(planningTurn).toContain('Budget: at most 9 runs in all, 2 at once.')
  // C was handed both packets — as the harness's message, with the request (its first run) — and B its instruction; A and B nothing of each other
  const openingC = userPrompts(seen.C!).join('\n')
  expect(openingC).toContain('Step c1 of the plan (2 of 3 steps ended). Speaker: C.\nAfter: a1, b1.\nHanded the answers of: a1, b1.\nWorking copy: the session\'s working folder.')
  expect(openingC).toContain('A_MARK')
  expect(openingC).toContain('B_MARK')
  expect(openingC).toContain("The user's request:\n@A and @B propose")
  expect(repo.getRun(app!.state.conn, done.nodes[2]!.run_id!)!.receipt.final_text).toBe('C_COMPARED: both answers read')
  expect(userPrompts(seen.A!).join('\n')).not.toContain('B_MARK')
  expect(userPrompts(seen.B!).join('\n')).not.toContain('A_MARK')
  expect(userPrompts(seen.B!).join('\n')).toContain("The director's note for this step: Take the other approach.")
  expect(userPrompts(seen.A!).join('\n')).not.toContain("The director's note")
  // C worked on the session's folder, on a fresh conversation (the session had none); A and B on copies
  const s = await json(await c.get(`/api/sessions/${sid}`))
  const runC = repo.getRun(app!.state.conn, done.nodes[2]!.run_id!)!
  expect(runC.workspace_id).toBe(rec(s.workspace).id as string)
  expect(repo.getRun(app!.state.conn, done.nodes[0]!.run_id!)!.workspace_id).not.toBe(runC.workspace_id)
  // the director spoke twice — the plan, then the decision — never once per run; no task event about the runs reached it
  const director = await json(await c.get(`/api/sessions/${sid}/director`))
  const turns = director.turns as DirectorTurn[]
  expect(turns.map((t) => t.kind)).toEqual(['interaction', 'interaction'])
  expect(turns[0]!.tool_calls.map((t) => [t.name, t.status])).toEqual([['schedule', 'ok']])
  // the call as the person reads it under the director's answer: its steps in a line, the plan it passed, what came back
  const planCall = turns[0]!.tool_calls[0]!
  expect(planCall.summary).toBe('3 steps: a1(A) b1(B) c1(C) · then director')
  expect((planCall.args!.nodes as { id: string }[]).map((n) => n.id)).toEqual(['a1', 'b1', 'c1'])
  expect(planCall.outcome).toContain(detail.id)
  expect(turns[0]!.output).toStartWith('Planned:')
  expect(turns[1]!.input).toContain(`Interaction ${detail.id}: every step of the plan ended.`)
  expect(turns[1]!.input).toContain('- step c1 (C, run ')
  expect(turns[1]!.input).toContain('answer (head): C_COMPARED')
  expect(turns[1]!.input).toContain('Runs left in the budget: 6')
  expect(turns[1]!.output).toStartWith('DECIDED')
  expect(director.pending_events).toEqual([])
  expect(dstore.listEvents(app!.state.conn, detail.director_session_id!)).toEqual([])
  const notes = repo.listDirectorNotes(app!.state.conn, sid)
  expect(notes.map((n) => n.question)).toEqual([`App note: Plan interaction ${detail.id}.`, `App note: Interaction ${detail.id}: every step of the plan ended.`])
  const kinds = done.events.map((e) => e.kind)
  expect(kinds).toEqual(['created', 'plan_asked', 'planned', 'node_started', 'node_started', 'node_finished', 'node_finished', 'node_started', 'node_finished', 'decision_asked', 'decided'])
  expect(done.events.find((e) => e.kind === 'planned')!.actor).toBe('director')
  // the outline's rows: the director's plan row, done, on its model; the three steps under it, each with its letter,
  // the third waiting for the first two; no decision row — the plan ended on the director, not on the person
  const tree = ((await json(await c.get(`/api/sessions/${sid}/runs/tree`))).runs as Record<string, unknown>[]).filter((r) => r.interaction_id === detail.id)
  const plan = tree.find((r) => r.kind === 'plan')!
  expect([plan.id, plan.status, plan.model, plan.label, plan.depth, plan.spawned_by, plan.live]).toEqual([detail.id, 'done', DIRECTOR, 'Plan · 3 steps', 0, 'plan', false])
  const steps = tree.filter((r) => r.kind === 'run').sort((x, y) => String(x.participant_alias).localeCompare(String(y.participant_alias)))
  expect(steps.map((r) => [r.participant_alias, r.participant_id, r.plan_node_id, r.status, r.scheduled_by, r.depth])).toEqual([
    ['A', `${detail.id}:A`, `${detail.id}:a1`, 'done', detail.id, 1], ['B', `${detail.id}:B`, `${detail.id}:b1`, 'done', detail.id, 1], ['C', `${detail.id}:C`, `${detail.id}:c1`, 'done', detail.id, 1]])
  expect([...(steps[2]!.depends_on as string[])].sort()).toEqual([String(steps[0]!.id), String(steps[1]!.id)].sort())
  expect(tree.some((r) => r.kind === 'decision')).toBe(false)
}, 60_000)

test('a plan that is not sound is refused with every problem named; a director that plans nothing leaves the interaction to the person, who asks again', async () => {
  const { c, sid } = await session()
  setModel(app!.state, MODEL, scriptedModel((messages: ModelMessage[]) => modelResponse([textPart(`${whoAmI(messages)} done`)])))
  const participants = [{ id: 'A', label: 'a', model: MODEL }, { id: 'B', label: 'b', model: MODEL }]
  expect(planProblems(participants, [], [
    { id: 'x1', participant: 'Z', depends_on: ['nope'], receives: ['x2'], workspace: 'own', instruction: null },
    { id: 'x2', participant: 'B', depends_on: [], receives: [], workspace: 'x3', instruction: null },
    { id: 'x3', participant: 'A', depends_on: [], receives: [], workspace: 'shared', instruction: null },
    { id: 'x4', participant: 'A', depends_on: [], receives: [], workspace: 'own', instruction: null },
  ], 2).sort()).toEqual([
    'node x1: participant Z is not one of A, B', 'node x1: depends_on names no node: nope', 'node x1: receives x2, a step it does not come after',
    "node x2: works on node x3's copy but does not come after it", 'participant A cannot move between copies: its nodes name shared, own',
    'the plan has 4 nodes; the budget allows 2 runs in all',
  ].sort())
  expect(planProblems(participants, [], [
    { id: 'y1', participant: 'A', depends_on: ['y2'], receives: [], workspace: 'own', instruction: null },
    { id: 'y2', participant: 'B', depends_on: ['y1'], receives: [], workspace: 'own', instruction: null },
  ], 5)).toEqual(['a cycle: y1 → y2 → y1'])
  // what the director meant in the Tokyo plan is sound now: final comes after a1 and b1 through a2 and b2, and A's later
  // steps naming A's own a1 work on A's own copy
  expect(planProblems(participants, [], [
    { id: 'a1', participant: 'A', depends_on: [], receives: [], workspace: 'own', instruction: null },
    { id: 'b1', participant: 'B', depends_on: [], receives: [], workspace: 'own', instruction: null },
    { id: 'a2', participant: 'A', depends_on: ['a1', 'b1'], receives: ['a1', 'b1'], workspace: 'a1', instruction: null },
    { id: 'b2', participant: 'B', depends_on: ['a1', 'b1'], receives: ['a1', 'b1'], workspace: 'b1', instruction: null },
    { id: 'final', participant: 'A', depends_on: ['a2', 'b2'], receives: ['a1', 'b1', 'a2', 'b2'], workspace: 'a1', instruction: null },
  ], 6)).toEqual([])
  expect(planProblems(participants, [], [{ id: 'a1', participant: 'A', depends_on: [], receives: [], workspace: 'own', instruction: null }, { id: 'a1', participant: 'B', depends_on: [], receives: [], workspace: 'own', instruction: null }], 5)).toEqual(['node a1: the id is taken'])
  // a template over the budget is refused before anything starts
  expect((await json(await c.post(`/api/sessions/${sid}/interactions`, { text: `${A} ${B} ${C} go`, plan: { template: 'independent' }, max_runs: 2 }), 400)).detail).toContain('the budget allows 2 runs')
  expect(repo.listInteractions(app!.state.conn, sid)).toHaveLength(0)
  // the director answers without a plan: the interaction waits for the person; continue asks again, and this time it plans
  let asked = 0
  setModel(app!.state, DIRECTOR, scriptedModel((messages: ModelMessage[]) => {
    const last = userPrompts(messages).at(-1)!
    const planning = /Plan interaction (ix_[0-9a-f]+)/.exec(last)
    if (planning && !lastToolReturn(messages, 'schedule')) {
      asked += 1
      if (asked === 1) return modelResponse([textPart('I would rather ask the person a question first.')])
      if (asked === 2) return modelResponse([toolCallPart('schedule', { interaction_id: planning[1], nodes: [{ id: 'a1', participant: 'A', depends_on: [], receives: [], workspace: 'own' }, { id: 'b1', participant: 'B', depends_on: ['a1'], receives: ['a1'], workspace: 'a1' }], then: 'stop' }, '')])
    }
    if (lastToolReturn(messages, 'schedule')) return modelResponse([textPart('Planned.')])
    return modelResponse([textPart('hm')])
  }, 'scripted-b'))
  legacyV1Director(app!.state, sid, { transport: 'native', model: DIRECTOR })   // a pre-surface director row (director.v1): this test pins v1's planning texts; v2's are in test_collab_integration
  const detail = await json<InteractionDetail>(await c.post(`/api/sessions/${sid}/interactions`, { text: `${A} then ${B}`, director_model: DIRECTOR }))
  const waiting = await waitInteraction(c, detail.id, ['waiting', 'running', 'done', 'error'])
  expect(waiting.status).toBe('waiting')
  expect(waiting.reason).toBe('the director planned nothing; continue asks it again')
  expect(waiting.events.map((e) => e.kind)).toEqual(['created', 'plan_asked', 'plan_missing'])
  // a plan at a revision that is not the one it stands at is refused
  const continued = await json<InteractionDetail>(await c.post(`/api/interactions/${detail.id}/continue`, {}))
  expect(continued.status).toBe('planning')
  expect((await json(await c.post(`/api/interactions/${detail.id}/schedule`, { nodes: [{ id: 'a1', participant: 'A' }], expected_revision: 3 }), 409)).detail).toContain('the plan is at revision 0, not 3')
  const done = await waitInteraction(c, detail.id, ['done', 'error', 'waiting'], 60_000)
  expect(done.status).toBe('done')
  expect(done.nodes.map((n) => [n.id, n.status, n.workspace])).toEqual([['a1', 'done', 'own'], ['b1', 'done', 'a1']])
  // b1 worked on a1's copy, after it
  const runA = repo.getRun(app!.state.conn, done.nodes[0]!.run_id!)!
  const runB = repo.getRun(app!.state.conn, done.nodes[1]!.run_id!)!
  expect(runB.workspace_id).toBe(runA.workspace_id)
  expect(runB.created_at >= runA.finished_at!).toBe(true)
  expect(asked).toBe(2)
  // a plan grows after the end: a synthesis by A handed both earlier answers (the person's own "ask A to synthesize")
  const grown = await json<InteractionDetail>(await c.post(`/api/interactions/${detail.id}/schedule`, { nodes: [{ id: 'synth', participant: 'A', depends_on: ['a1', 'b1'], receives: ['a1', 'b1'], workspace: 'own' }], then: 'stop' }))
  expect(grown.status).toBe('running')
  expect(grown.revision).toBe(2)
  expect(grown.nodes.map((n) => [n.id, n.wave])).toEqual([['a1', 1], ['b1', 2], ['synth', 3]])                   // the waves read off the graph
  const grownDone = await waitInteraction(c, detail.id, ['done', 'error', 'waiting'])
  expect(grownDone.status).toBe('done')
  expect(grownDone.nodes.map((n) => n.status)).toEqual(['done', 'done', 'done'])
  // the synthesis continues A's own conversation, which holds a1's answer already: only b1's is handed
  const synthRun = repo.getRun(app!.state.conn, grownDone.nodes.find((n) => n.id === 'synth')!.run_id!)!
  expect(synthRun.user_text).toContain('Handed the answers of: b1 (a1 is already in this conversation).')
  expect(synthRun.user_text).toContain('Step b1 (B, run ')
  expect(synthRun.user_text).not.toContain('Step a1 (A, run ')
  expect(repo.getRun(app!.state.conn, grownDone.nodes[2]!.run_id!)!.resumes_run_id).toBe(grownDone.nodes[0]!.run_id)
  // a stopped interaction takes no more of a plan
  const stopped = await json<InteractionDetail>(await c.post(`/api/sessions/${sid}/interactions`, { text: `${A} ${B}`, plan: { template: 'independent' } }))
  await json(await c.post(`/api/interactions/${stopped.id}/cancel`))
  for (const n of stopped.nodes) if (n.run_id) await waitDone(app!.state, n.run_id)
  expect((await json(await c.post(`/api/interactions/${stopped.id}/schedule`, { nodes: [{ id: 'c1', participant: 'A' }] }), 409)).detail).toContain('a cancelled interaction takes no plan')
}, 60_000)

// ---- the person's controls ----------------------------------------------------------------------------------------------

test('Stop stops the whole interaction: the live runs are cancelled, nothing starts after; a resend never revives it', async () => {
  const { c, sid } = await session()
  const held = new Promise<void>((resolve) => { release = resolve })
  const calls = { n: 0 }
  setModel(app!.state, MODEL, scriptedModel(async () => { calls.n += 1; await held; return modelResponse([textPart('never')]) }))
  const text = `${A} and ${B} go`
  const detail = await json<InteractionDetail>(await c.post(`/api/sessions/${sid}/interactions`, { text, plan: { nodes: [{ id: 'a1', participant: 'A' }, { id: 'b1', participant: 'B' }, { id: 'c1', participant: 'A', depends_on: ['a1', 'b1'], receives: ['a1', 'b1'] }], then: 'stop' }, client_request_id: 'ix-0002-stop' }))
  expect(detail.nodes.map((n) => n.status)).toEqual(['running', 'running', 'queued'])
  expect(detail.live).toBe(true)
  const stopped = await json(await c.post(`/api/interactions/${detail.id}/cancel`))
  expect(stopped.cancelled).toBe(true)
  for (const n of detail.nodes) if (n.run_id) await waitDone(app!.state, n.run_id)
  const after = await waitInteraction(c, detail.id, ['cancelled'])
  expect(after.reason).toContain('stopped by the person during step a1 (A), b1 (B)')
  expect(after.nodes.map((n) => n.status)).toEqual(['cancelled', 'cancelled', 'queued'])
  expect(repo.listRunsOfInteraction(app!.state.conn, detail.id).map((r) => r.status)).toEqual(['cancelled', 'cancelled'])
  const callsAtStop = calls.n
  await sleep(100)
  expect(calls.n).toBe(callsAtStop)                                                              // nothing asked its model after the stop
  expect(repo.listRunsOfInteraction(app!.state.conn, detail.id)).toHaveLength(2)                // c1 never started
  expect((await json(await c.post(`/api/interactions/${detail.id}/continue`, {}), 409)).detail).toContain('a cancelled interaction cannot be continued')
  expect((await json(await c.post(`/api/interactions/${detail.id}/cancel`))).cancelled).toBe(false)
  expect((await json(await c.post(`/api/sessions/${sid}/interactions`, { text, plan: { template: 'independent' }, client_request_id: 'ix-0002-stop' }), 409)).detail).toContain('was stopped')
  // the session is free again
  release()
  setModel(app!.state, MODEL, scriptedModel(() => modelResponse([textPart('free')])))
  const plain = await json(await c.post(`/api/sessions/${sid}/chat`, { text: 'free again' }))
  await waitDone(app!.state, plain.id as string)
}, 60_000)

test('a restart interrupts a running interaction; the person continues it: the cut-off step carries on, the rest follows the plan', async () => {
  const settings = testSettings()
  app = await makeApp(settings)
  let started!: () => void
  const startedPromise = new Promise<void>((r) => { started = r })
  setModel(app.state, MODEL, scriptedModel(async (messages: ModelMessage[]) => { if (whoAmI(messages) === 'A') { started(); await sleep(3_600_000) } return modelResponse([textPart(`${whoAmI(messages)} first`)]) }))
  const c = new Client(app)
  const project = await json(await c.post('/api/projects', { source_path: buggyRepo() }))
  const s = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'restart' }))
  const sid = s.id as string
  const detail = await json<InteractionDetail>(await c.post(`/api/sessions/${sid}/interactions`, { text: `${A} and ${B} go, then ${A} again`, plan: { nodes: [{ id: 'a1', participant: 'A' }, { id: 'b1', participant: 'B' }, { id: 'a2', participant: 'A', depends_on: ['a1', 'b1'], receives: ['b1'] }], then: 'stop' } }))
  await startedPromise
  await waitDone(app.state, detail.nodes[1]!.run_id!)
  // the process dies during A's run, after B's ended
  const dead = app
  app = null
  dead.state.runs.handles.get(detail.nodes[0]!.run_id!)!.done = true
  dead.state.conn.close()
  app = await makeApp(settings)
  setModel(app.state, MODEL, scriptedModel((messages: ModelMessage[]) => {
    const prompts = userPrompts(messages)
    if (prompts.at(-1)!.includes('Continue step a1 as A.')) return modelResponse([textPart('A carried on after the restart')])
    return modelResponse([textPart(`${whoAmI(messages)} later: ${prompts.some((t) => t.includes('B first')) ? 'saw B' : 'saw nothing'}`)])
  }))
  await app.state.runs.reconcile()
  expect(app.state.interactions.reconcile().interrupted).toEqual([detail.id])
  const c2 = new Client(app)
  const interrupted = await json<InteractionDetail>(await c2.get(`/api/interactions/${detail.id}`))
  expect(interrupted.status).toBe('interrupted')
  expect(interrupted.reason).toContain('step a1 (A) was cut off by a restart')
  expect(interrupted.nodes.map((n) => n.status)).toEqual(['error', 'done', 'queued'])
  expect(repo.listRunsOfInteraction(app.state.conn, detail.id)).toHaveLength(2)                 // nothing started on its own
  const continued = await json<InteractionDetail>(await c2.post(`/api/interactions/${detail.id}/continue`, {}))
  expect(continued.status).toBe('running')
  expect(continued.nodes[0]!.run_ids).toHaveLength(2)
  const done = await waitInteraction(c2, detail.id, ['done', 'error', 'waiting'], 60_000)
  expect(done.status).toBe('done')
  expect(done.nodes.map((n) => n.status)).toEqual(['done', 'done', 'done'])
  const runs = repo.listRunsOfInteraction(app.state.conn, detail.id)
  expect(runs.map((r) => String(r.receipt.final_text ?? ''))).toEqual(['', 'B first', 'A carried on after the restart', 'A later: saw B'])
  expect(runs[2]!.resumes_run_id).toBe(detail.nodes[0]!.run_id)                               // the same step, on its own record
  expect(runs[3]!.resumes_run_id).toBe(runs[2]!.id)                                             // A's second step continues A's conversation
  expect(runs[3]!.workspace_id).toBe(runs[0]!.workspace_id)                                     // on A's own copy
  dead.state.runs.handles.get(detail.nodes[0]!.run_id!)!.token.cancel()
}, 60_000)

test('the budget: a run past the line never starts, and the interaction says so', async () => {
  const { c, sid } = await session()
  setModel(app!.state, MODEL, scriptedModel((messages: ModelMessage[]) => modelResponse([textPart(`${whoAmI(messages)} ok`)])))
  // three nodes, a budget of three runs: fine; then the plan is at its line
  const detail = await json<InteractionDetail>(await c.post(`/api/sessions/${sid}/interactions`, { text: `${A} ${B}`, plan: { nodes: [{ id: 'a1', participant: 'A' }, { id: 'b1', participant: 'B' }, { id: 'a2', participant: 'A', depends_on: ['a1'] }], then: 'stop' }, max_runs: 3, concurrency: 1 }))
  expect(detail.budget).toEqual({ max_runs: 3, concurrency: 1 })
  expect(detail.nodes.filter((n) => n.status === 'running')).toHaveLength(1)                    // one at a time
  const done = await waitInteraction(c, detail.id, ['done', 'error', 'waiting'])
  expect(done.status).toBe('done')
  expect(done.runs_started).toBe(3)
  expect((await json(await c.post(`/api/interactions/${detail.id}/schedule`, { nodes: [{ id: 'b2', participant: 'B' }] }), 400)).detail).toContain('the budget allows 3 runs')
  // the same over the API before anything starts: four nodes against three runs
  expect((await json(await c.post(`/api/sessions/${sid}/interactions`, { text: `${A} ${B}`, plan: { nodes: [{ id: 'a1', participant: 'A' }, { id: 'b1', participant: 'B' }, { id: 'a2', participant: 'A' }, { id: 'b2', participant: 'B' }], then: 'stop' }, max_runs: 3 }), 400)).detail).toContain('the budget allows 3 runs')
}, 60_000)

test("a node that ends waiting for the person's decision holds the interaction; decided, it carries on; a node that fails waits for the person too", async () => {
  const { c, sid, project } = await session()
  setModel(app!.state, MODEL, scriptedModel((messages: ModelMessage[]) => {
    const me = whoAmI(messages)
    const prompts = userPrompts(messages)
    if (me === 'A') {
      if (prompts.some((t) => t.includes('Continue step a1 as A.'))) return modelResponse([textPart('A_DONE_AFTER_APPROVAL')])
      if (!toolReturns(messages).some((p) => p.tool_name === 'write_file')) return modelResponse([toolCallPart('write_file', { path: 'NOTES.md', content: 'reviewed before written\n' }, '')])
      return modelResponse([textPart('The note waits for your approval.')])
    }
    return modelResponse([textPart(`${me} saw ${prompts.some((t) => t.includes('A_DONE_AFTER_APPROVAL')) ? 'A done' : 'nothing'}`)])
  }))
  applySessionMode(app!.state.conn, repo.getSession(app!.state.conn, sid)!, 'approve')
  const detail = await json<InteractionDetail>(await c.post(`/api/sessions/${sid}/interactions`, { text: `${A} then ${B}`, plan: { nodes: [{ id: 'a1', participant: 'A', workspace: 'shared' }, { id: 'b1', participant: 'B', depends_on: ['a1'], receives: ['a1'], workspace: 'shared' }], then: 'stop' } }))
  const waiting = await waitInteraction(c, detail.id, ['waiting', 'done', 'error'])
  expect(waiting.status).toBe('waiting')
  expect(waiting.reason).toContain('step a1 (A) ended waiting for your decision')
  expect(waiting.nodes.map((n) => n.status)).toEqual(['waiting', 'queued'])
  expect((await json(await c.post(`/api/interactions/${detail.id}/continue`, {}), 409)).detail).toContain('still waits for your decision')
  const proposals = await json(await c.get(`/api/sessions/${sid}/action-proposals`))
  const pending = (proposals.proposals as Record<string, unknown>[]).find((p) => p.status === 'pending')!
  await json(await c.post(`/api/action-proposals/${pending.proposal_asset_id}/decide`, { decision: 'approve', reason: 'fine' }))
  expect(repo.getProject(app!.state.conn, project)).not.toBeNull()
  const continued = await json<InteractionDetail>(await c.post(`/api/interactions/${detail.id}/continue`, {}))
  expect(continued.status).toBe('running')
  const done = await waitInteraction(c, detail.id, ['done', 'error', 'waiting'])
  expect(done.status).toBe('done')
  expect(done.nodes[0]!.run_ids).toHaveLength(2)
  const rerun = repo.getRun(app!.state.conn, done.nodes[0]!.run_id!)!
  expect(rerun.resumes_run_id).toBe(done.nodes[0]!.run_ids[0]!)
  expect(rerun.user_text).toBe('App note: Continue step a1 as A.')
  expect(rerun.receipt.final_text).toBe('A_DONE_AFTER_APPROVAL')
  expect(repo.getRun(app!.state.conn, done.nodes[1]!.run_id!)!.receipt.final_text).toBe('B saw A done')
  // a node that fails: the interaction waits; the other, independent node ends on its own; continue runs the failed one again
  let fail = true
  setModel(app!.state, MODEL, scriptedModel((messages: ModelMessage[]) => {
    if (whoAmI(messages) === 'A' && fail) throw new ModelHTTPError(400, 'scripted-a', { error: { message: 'boom' } })
    return modelResponse([textPart(`${whoAmI(messages)} fine`)])
  }))
  applySessionMode(app!.state.conn, repo.getSession(app!.state.conn, sid)!, 'auto')
  const second = await json<InteractionDetail>(await c.post(`/api/sessions/${sid}/interactions`, { text: `${A} ${B}`, plan: { template: 'independent' } }))
  const failed = await waitInteraction(c, second.id, ['waiting', 'done', 'error'], 60_000)
  expect(failed.status).toBe('waiting')
  expect(failed.reason).toContain('step a1 (A) did not end well')
  expect(failed.nodes.map((n) => n.status)).toEqual(['error', 'done'])
  fail = false
  const again = await json<InteractionDetail>(await c.post(`/api/interactions/${second.id}/continue`, {}))
  expect(again.status).toBe('running')
  const fine = await waitInteraction(c, second.id, ['done', 'error', 'waiting'], 60_000)
  expect(fine.status).toBe('done')
  expect(fine.nodes.map((n) => [n.status, n.run_ids.length])).toEqual([['done', 2], ['done', 1]])
}, 90_000)

test('the participants are checked before anything starts; the person is who the message names them for', async () => {
  const { c, sid } = await session()
  setModel(app!.state, MODEL, scriptedModel((messages: ModelMessage[]) => modelResponse([textPart(`${whoAmI(messages)} ok`)])))
  expect((await json(await c.post(`/api/sessions/${sid}/interactions`, { text: `${A} alone`, plan: { template: 'independent' } }), 400)).detail).toContain('at least two participants')
  expect((await json(await c.post(`/api/sessions/${sid}/interactions`, { text: `${A} ${agentMentionToken('X', 'nope:x', 'B')}`, plan: { template: 'independent' } }), 400)).detail).toContain('unknown model: nope:x')
  expect((await json(await c.post(`/api/sessions/${sid}/interactions`, { text: `${A} ${agentMentionToken('Scripted B', DIRECTOR, 'B')}`, plan: { template: 'independent' } }), 400)).detail).toContain('Scripted B has no credential here')
  expect((await json(await c.post(`/api/sessions/${sid}/interactions`, { text: 'no tokens', participants: [{ model: MODEL }, { model: MODEL }], plan: { template: 'independent' }, director_model: 'nope:d' }), 400)).detail).toContain('unknown model: nope:d')
  expect((await json(await c.post(`/api/sessions/${sid}/interactions`, { text: '   ', participants: [{ model: MODEL }, { model: MODEL }], plan: { template: 'independent' } }), 400)).detail).toContain('text is required')
  expect(repo.listInteractions(app!.state.conn, sid)).toHaveLength(0)
  // a client without tokens names the participants itself: each gets an id of its own, like the harness's other ids
  const detail = await json<InteractionDetail>(await c.post(`/api/sessions/${sid}/interactions`, { text: 'both of you, go', participants: [{ model: MODEL, label: 'One' }, { model: MODEL }], plan: { template: 'independent' } }))
  expect(detail.participants.map((p) => [p.label, p.model])).toEqual([['One', MODEL], ['Scripted A', MODEL]])
  expect(detail.participants.every((p) => /^pt_[0-9a-f]{6}$/.test(p.id))).toBe(true)
  expect(new Set(detail.participants.map((p) => p.id)).size).toBe(2)
  expect(detail.nodes.map((n) => n.id)).toEqual(['solo-1', 'solo-2'])                        // the template's steps, by place
  await waitInteraction(c, detail.id, ['done', 'error', 'waiting'])
}, 60_000)

test("the person's words while the steps run reach a step in flight at its next request (in-run steering) and a step still to come at its start; a pause lets the running steps end and starts nothing new", async () => {
  const { c, sid } = await session()
  const seen: Record<string, string[]> = {}
  let releaseA!: () => void
  const heldA = new Promise<void>((r) => { releaseA = r })
  setModel(app!.state, MODEL, scriptedModel(async (messages: ModelMessage[]) => {
    const me = whoAmI(messages)
    if (me === 'A' && !(seen.A ?? []).length) await heldA                                  // A's first run is in flight when the note comes
    seen[me] = [...(seen[me] ?? []), userPrompts(messages).join('\n')]
    return modelResponse([textPart(`${me} ok`)])
  }))
  // a1 and b1 alone (b1 ends at once), then a2 and b2 after both
  const detail = await json<InteractionDetail>(await c.post(`/api/sessions/${sid}/interactions`, { text: `${A} ${B}`, plan: { nodes: [
    { id: 'a1', participant: 'A' }, { id: 'b1', participant: 'B' }, { id: 'a2', participant: 'A', depends_on: ['a1', 'b1'] }, { id: 'b2', participant: 'B', depends_on: ['a1', 'b1'] },
  ], then: 'stop' } }))
  await waitDone(app!.state, detail.nodes[1]!.run_id!)
  // to everyone: A's run is in flight (a1 takes the note at its next request), B's next run is b2
  const noted = await json<InteractionDetail>(await c.post(`/api/interactions/${detail.id}/notes`, { to: 'everyone', text: 'NOTE_EVERYONE_7c1: keep it short' }))
  expect(noted.notes.map((n) => [n.to, n.status, n.delivered])).toEqual([['everyone', 'partly', { A: detail.nodes[0]!.run_id! }]])
  const toB = await json<InteractionDetail>(await c.post(`/api/interactions/${detail.id}/notes`, { to: 'B', text: 'NOTE_B_ONLY_9d2' }))
  expect(toB.notes).toHaveLength(2)
  expect((await json(await c.post(`/api/interactions/${detail.id}/notes`, { to: 'Z', text: 'nobody' }), 400)).detail).toContain('no participant Z')
  expect((await json(await c.post(`/api/interactions/${detail.id}/notes`, { to: 'everyone', text: '  ' }), 400)).detail).toBe('text is required')
  // paused while A's first run is in flight: A ends, nothing new starts
  const paused = await json<InteractionDetail>(await c.post(`/api/interactions/${detail.id}/pause`))
  expect(paused.status).toBe('waiting')
  expect(paused.reason).toContain('paused by you')
  releaseA()
  await waitDone(app!.state, detail.nodes[0]!.run_id!)
  await sleep(100)
  const still = await json<InteractionDetail>(await c.get(`/api/interactions/${detail.id}`))
  expect(still.status).toBe('waiting')
  expect(still.nodes.map((n) => n.status)).toEqual(['done', 'done', 'queued', 'queued'])
  expect((await json(await c.post(`/api/interactions/${detail.id}/pause`), 409)).detail).toContain('cannot be paused')
  // the request in flight was not touched; a1 went on with one more request carrying the note
  expect(seen.A![0]).not.toContain('NOTE_EVERYONE_7c1')
  expect(seen.A![1]).toContain('App note: The user wrote while the steps ran, to everyone:\nNOTE_EVERYONE_7c1: keep it short')
  expect(app!.state.runs.steersOf(detail.nodes[0]!.run_id!).map((x) => x.status)).toEqual(['delivered'])
  // continue starts a2 and b2, each handed the notes it has not had
  await json(await c.post(`/api/interactions/${detail.id}/continue`, {}))
  const done = await waitInteraction(c, detail.id, ['done', 'error', 'waiting'])
  expect(done.status).toBe('done')
  expect(seen.A![2]!.split('NOTE_EVERYONE_7c1')).toHaveLength(2)                              // handed once, in a1
  expect(seen.B![1]!.split('NOTE_EVERYONE_7c1')).toHaveLength(2)
  expect(seen.A!.join('\n')).not.toContain('NOTE_B_ONLY_9d2')
  expect(seen.B![1]).toContain('NOTE_EVERYONE_7c1')
  expect(seen.B![1]).toContain('App note: The user wrote while the steps ran, to B:\nNOTE_B_ONLY_9d2')
  expect(done.notes.map((n) => [n.to, n.status, Object.keys(n.delivered).sort()])).toEqual([['everyone', 'delivered', ['A', 'B']], ['B', 'delivered', ['B']]])
  expect(done.events.filter((e) => e.kind === 'note_delivered')).toHaveLength(3)
  // a note nobody was handed before a stop says so
  setModel(app!.state, MODEL, scriptedModel(async () => { await sleep(3_600_000); return modelResponse([textPart('never')]) }))
  const second = await json<InteractionDetail>(await c.post(`/api/sessions/${sid}/interactions`, { text: `${A} ${B}`, plan: { template: 'independent' } }))
  await json(await c.post(`/api/interactions/${second.id}/notes`, { to: 'A', text: 'too late' }))
  await json(await c.post(`/api/interactions/${second.id}/cancel`))
  for (const n of second.nodes) if (n.run_id) await waitDone(app!.state, n.run_id)
  const cancelled = await json<InteractionDetail>(await c.get(`/api/interactions/${second.id}`))
  expect(cancelled.notes.map((n) => n.status)).toEqual(['undelivered'])
  expect((await json(await c.post(`/api/interactions/${second.id}/notes`, { to: 'A', text: 'still?' }), 409)).detail).toContain('takes no note')
}, 90_000)

test("the person's words to a member none of whose steps is still to come go on in its conversation now, as its follow-up; a member still at work takes them at its next request", async () => {
  const { c, sid } = await session()
  const seen: Record<string, string[]> = {}
  let releaseB!: () => void
  const heldB = new Promise<void>((r) => { releaseB = r })
  setModel(app!.state, MODEL, scriptedModel(async (messages: ModelMessage[]) => {
    const me = whoAmI(messages)
    if (me === 'B' && !(seen.B ?? []).length) await heldB                                  // B is still at work
    seen[me] = [...(seen[me] ?? []), userPrompts(messages).join('\n')]
    return modelResponse([textPart(`${me} ok`)])
  }))
  const detail = await json<InteractionDetail>(await c.post(`/api/sessions/${sid}/interactions`, { text: `${A} ${B}`, plan: { nodes: [
    { id: 'a1', participant: 'A' }, { id: 'b1', participant: 'B' }, { id: 'b2', participant: 'B', depends_on: ['b1'] },
  ], then: 'stop' } }))
  await waitDone(app!.state, detail.nodes[0]!.run_id!)
  const noted = await json<InteractionDetail>(await c.post(`/api/interactions/${detail.id}/notes`, { to: 'everyone', text: 'NOTE_NOW_4e1: go on' }))
  // A's steps had all ended: its follow-up started at once, continuing a1's run, the note delivered to A in it
  const followup = noted.nodes.find((n) => n.kind === 'followup')!
  expect([followup.participant, followup.depends_on]).toEqual(['A', ['a1']])
  expect(noted.notes.map((n) => [n.status, Object.keys(n.delivered).sort()])).toEqual([['delivered', ['A', 'B']]])
  await waitDone(app!.state, followup.run_id!)
  expect(repo.getRun(app!.state.conn, followup.run_id!)!.resumes_run_id).toBe(detail.nodes[0]!.run_id)
  expect(seen.A![1]).toContain('NOTE_NOW_4e1: go on')
  // B was at work: b1 takes the note at its next request, and b2 is not handed it again
  releaseB()
  const done = await waitInteraction(c, detail.id, ['done', 'error', 'waiting'])
  expect(done.status).toBe('done')
  expect(seen.B![0]).not.toContain('NOTE_NOW_4e1')
  expect(seen.B![1]).toContain('NOTE_NOW_4e1: go on')
  expect(seen.B![2]!.split('NOTE_NOW_4e1')).toHaveLength(2)                                   // handed once, in b1
  expect(done.notes.map((n) => [n.status, Object.keys(n.delivered).sort()])).toEqual([['delivered', ['A', 'B']]])
  expect(seen.A).toHaveLength(2)                                                            // handed once
}, 60_000)

test("words to everyone while every step is on its last run reach each run in flight; a run stopped before its next request gives them back for its next run, and an interaction ended before that says them undelivered", async () => {
  const { c, sid } = await session()
  const seen: Record<string, string[]> = {}
  let release!: () => void
  const held = new Promise<void>((r) => { release = r })
  setModel(app!.state, MODEL, scriptedModel(async (messages: ModelMessage[]) => {
    const me = whoAmI(messages)
    if (!(seen[me] ?? []).length) await held                                                  // both first requests in flight
    seen[me] = [...(seen[me] ?? []), userPrompts(messages).join('\n')]
    return modelResponse([textPart(`${me} ok`)])
  }))
  const detail = await json<InteractionDetail>(await c.post(`/api/sessions/${sid}/interactions`, { text: `${A} ${B}`, plan: { template: 'independent' } }))
  const noted = await json<InteractionDetail>(await c.post(`/api/interactions/${detail.id}/notes`, { to: 'everyone', text: 'NOTE_LAST_5b8: the key is in' }))
  expect(noted.notes.map((n) => [n.status, Object.keys(n.delivered).sort()])).toEqual([['delivered', ['A', 'B']]])
  release()
  const done = await waitInteraction(c, detail.id, ['done', 'error', 'waiting'])
  expect(done.status).toBe('done')
  // each run took it at its next request (B's first one may not have gone yet): once, in its last request
  for (const me of ['A', 'B']) expect(seen[me]!.at(-1)!.split('NOTE_LAST_5b8: the key is in')).toHaveLength(2)
  expect(done.notes.map((n) => n.status)).toEqual(['delivered'])
  // a run stopped while its request is in flight never hands the words over: given back, and the ended interaction says so
  setModel(app!.state, MODEL, scriptedModel(async () => { await sleep(3_600_000); return modelResponse([textPart('never')]) }))
  const second = await json<InteractionDetail>(await c.post(`/api/sessions/${sid}/interactions`, { text: `${A} ${B}`, plan: { template: 'independent' } }))
  const steered = await json<InteractionDetail>(await c.post(`/api/interactions/${second.id}/notes`, { to: 'A', text: 'NOTE_STOPPED_2c4' }))
  expect(steered.notes.map((n) => n.status)).toEqual(['delivered'])
  for (const n of second.nodes) if (n.run_id) await json(await c.post(`/api/runs/${n.run_id}/cancel`))
  for (const n of second.nodes) if (n.run_id) await waitDone(app!.state, n.run_id)
  // the stopped steps can run again (continue): the words wait for that run
  const after = await waitInteraction(c, second.id, ['done', 'error', 'waiting', 'cancelled'])
  expect(after.status).toBe('waiting')
  expect(after.notes.map((n) => [n.status, n.delivered])).toEqual([['queued', {}]])
  expect(after.events.some((e) => e.kind === 'note_returned')).toBe(true)
  // the interaction stopped instead: no run is left to hand them to
  await json(await c.post(`/api/interactions/${second.id}/cancel`))
  expect((await json<InteractionDetail>(await c.get(`/api/interactions/${second.id}`))).notes.map((n) => n.status)).toEqual(['undelivered'])
}, 60_000)

test("each participant runs at the effort the person chose for it; one without runs at the interaction's", async () => {
  const { c, sid } = await session()
  const efforts: Record<string, string | boolean | null> = {}
  setModel(app!.state, MODEL, scriptedModel((messages: ModelMessage[], info) => {
    efforts[whoAmI(messages)] = info.model_settings.thinking ?? null
    return modelResponse([textPart('done')])
  }, 'scripted-a', { supports_thinking: true }))
  const detail = await json<InteractionDetail>(await c.post(`/api/sessions/${sid}/interactions`, { text: `${A} and ${B}: look, each alone.`, plan: { template: 'independent' }, thinking: 'medium', participant_thinking: { B: 'minimal' } }))
  expect(detail.participants.map((p) => p.thinking ?? null)).toEqual([null, 'minimal'])
  await waitInteraction(c, detail.id, ['done', 'error', 'waiting'])
  expect(efforts).toEqual({ A: 'medium', B: 'minimal' })
})
