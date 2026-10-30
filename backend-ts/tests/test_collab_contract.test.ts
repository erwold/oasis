/** The collaboration model's contract (docs/multi-agent-unification-design.md), before the backend serves it: the
 *  director.v1 tool surface a held conversation already has stays byte-for-byte what it was (its tools, schemas,
 *  descriptions, the native subset and the native instructions — the prompt cache and the append-only rule both rest
 *  on it); a citation can never be recorded as an answer handed over, nor a handover as a citation; the readings of
 *  a pre-v25 row fall back to its own fields; a director session without a named surface holds v1. */

import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import {
  CitationsSchema, CollabEdgeSchema, CollaborationGraphSchema, COLLABORATION_ROUTES, directorToolSurfaceOf, isMainThreadRun, MAX_CITATIONS,
  MAX_RECEIVED_RUNS, ReceiveRunIdsSchema, RunCollabSchema, RunSchema, runSurface, ScheduleBodySchema, ScheduleNodeSchema, ScheduleNodeV2Schema,
} from '@oasis-code/contract'
import { Harness } from '../src/director/harness.ts'
import { NATIVE_INSTRUCTIONS, SERVER_INSTRUCTIONS } from '../src/director/manual.ts'
import { buildServer } from '../src/director/server.ts'
import { NATIVE_EXCLUDED_TOOLS } from '../src/director/tools.ts'

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)

async function listed() {
  const server = buildServer(Harness.connect('http://127.0.0.1:9', 'unused'))
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new McpClient({ name: 'surface pin', version: '1' })
  await client.connect(clientSide)
  const { tools } = await client.listTools()
  await client.close()
  await server.close()
  return tools
}

// Measured on the baseline (main 3d06c7b, schema v24) and on this contract: equal. A change here is a change of the
// tool list every held director conversation sends with each request — it belongs on a new surface (director.v2).
test('director.v1: the connector tools, the native subset and the instructions are the baseline bytes', async () => {
  const tools = await listed()
  expect(tools).toHaveLength(18)
  expect(digest(tools)).toBe('b25e8f63457c1965')
  expect(digest(tools.filter((t) => !NATIVE_EXCLUDED_TOOLS.has(t.name)))).toBe('198bb7d7bd7bda81')
  expect(digest(tools.find((t) => t.name === 'schedule'))).toBe('3a828a1f5c9805a0')
  expect(digest(tools.find((t) => t.name === 'start_run'))).toBe('4636f21450383631')
  expect(digest(NATIVE_INSTRUCTIONS)).toBe('3fa43604bb90d07f')
  expect(digest(SERVER_INSTRUCTIONS)).toBe('33af802d83513cd3')
})

test('the frozen v1 node drops what v2 adds; the HTTP bodies keep it', () => {
  const node = { id: 'a1', participant: 'A', cites: ['run_0a1b2c3d4e5f'], receive_runs: ['run_0a1b2c3d4e6f'] }
  expect(Object.keys(ScheduleNodeSchema.parse(node)).sort()).toEqual(['depends_on', 'id', 'participant', 'receives', 'workspace'])
  expect(ScheduleNodeV2Schema.parse(node).cites).toEqual(['run_0a1b2c3d4e5f'])
  expect(ScheduleBodySchema.parse({ nodes: [node] }).nodes[0]!.receive_runs).toEqual(['run_0a1b2c3d4e6f'])
  expect(() => ScheduleNodeV2Schema.parse({ ...node, cites: ['latest'] })).toThrow()                      // a run id, never a name
})

const at = '2026-10-14T00:00:00.000Z'
const ends = { from: { kind: 'run', id: 'run_aaaaaaaaaaaa' }, to: { kind: 'run', id: 'run_bbbbbbbbbbbb' }, basis: 'recorded', created_at: at } as const

test('a citation hands nothing over, a handover is no citation: the edge says which, and cannot say the other', () => {
  const cited = { ...ends, id: 'eg_1', kind: 'cited', meta: { by: 'director', director_turn_id: 'dt_1', note: 'its table', content_delivered: false } }
  expect(CollabEdgeSchema.parse(cited).kind).toBe('cited')
  expect(() => CollabEdgeSchema.parse({ ...cited, meta: { ...cited.meta, content_delivered: true } })).toThrow()
  const received = { ...ends, id: 'eg_2', kind: 'received', meta: { via: 'dispatch', packet: 'whole', answer_chars: 10, handed_chars: 10, node: null, content_delivered: true } }
  expect(CollabEdgeSchema.parse(received).kind).toBe('received')
  expect(() => CollabEdgeSchema.parse({ ...received, meta: { ...received.meta, content_delivered: false } })).toThrow()
  expect(() => CollabEdgeSchema.parse({ ...ends, id: 'eg_3', kind: 'shares', meta: {} })).toThrow()            // no kind outside the list
})

test('a dispatch names at most so many runs, each an exact run id', () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `run_${String(i).padStart(12, '0')}`)
  expect(CitationsSchema.parse(ids(MAX_CITATIONS).map((run_id) => ({ run_id })))).toHaveLength(MAX_CITATIONS)
  expect(() => CitationsSchema.parse(ids(MAX_CITATIONS + 1).map((run_id) => ({ run_id })))).toThrow()
  expect(ReceiveRunIdsSchema.parse(ids(MAX_RECEIVED_RUNS))).toHaveLength(MAX_RECEIVED_RUNS)
  expect(() => ReceiveRunIdsSchema.parse(ids(MAX_RECEIVED_RUNS + 1))).toThrow()
  expect(() => ReceiveRunIdsSchema.parse(['pt_3f2a9c'])).toThrow()
})

const row = (fields: Record<string, unknown>) => RunSchema.parse({ id: 'run_cccccccccccc', session_id: 's_1', project_id: 'p_1', workspace_id: 'ws_1', model: 'm', user_text: 'x', status: 'done', created_at: at, ...fields })

test("a pre-v25 row is read by its own fields; a v25 row by its placement and participant", () => {
  expect(row({}).collab).toBeUndefined()
  expect(runSurface(row({}))).toBe('thread')
  expect(isMainThreadRun(row({}))).toBe(true)
  expect(runSurface(row({ spawned_by: 'human_action' }))).toBe('record')
  expect(runSurface(row({ interaction_id: 'ix_1', interaction_node: 'a1' }))).toBe('group')
  expect(runSurface(row({ work_order: { prompt: 'p' } }))).toBe('card')
  expect(isMainThreadRun(row({ relay_id: 'rl_1', relay_step: 0 }))).toBe(false)
  const member = RunCollabSchema.parse({
    participant_id: 'pa_0123456789abcdef', participant_role: 'member', conversation_id: 'cv_0123456789abcdef',
    origin: { actor: 'person', request: 'resume', basis: 'projected' }, placement: { surface: 'group', group: { kind: 'interaction', id: 'ix_1' } }, basis: 'inferred',
  })
  // the pre-v25 follow-up of a participant (no interaction id, no order): its own fields read the thread, the projection a member
  const followUp = row({ resumes_run_id: 'run_aaaaaaaaaaaa', collab: member })
  expect(runSurface({ ...followUp, collab: undefined })).toBe('thread')
  expect(runSurface(followUp)).toBe('group')
  expect(isMainThreadRun(followUp)).toBe(false)
})

test('a director session holds the surface its config names, else v1', () => {
  expect(directorToolSurfaceOf(undefined)).toBe('director.v1')
  expect(directorToolSurfaceOf({})).toBe('director.v1')
  expect(directorToolSurfaceOf({ tool_surface: 'director.v99' })).toBe('director.v1')
  expect(directorToolSurfaceOf({ tool_surface: 'director.v2' })).toBe('director.v2')
})

test('the graph answer parses with every part empty, and its routes are named once', () => {
  const graph = CollaborationGraphSchema.parse({ session_id: 's_1', revision: 'r', main_participant_id: null, actors: [{ kind: 'person' }], participants: [], conversations: [],
    groups: [], runs: [], nodes: [], edges: [], thread_items: [], legacy: { projected_runs: 0, inferred_facts: 0, notes: [] } })
  expect(graph.actors).toEqual([{ kind: 'person' }])
  const keys = COLLABORATION_ROUTES.map((r) => `${r.method} ${r.path}`)
  expect(new Set(keys).size).toBe(keys.length)
})
