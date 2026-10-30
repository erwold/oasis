/** A native director directs the session it was opened in and no other: through the real native transport, the
 *  in-memory MCP server and the app's REST API, a scripted director that names another session — directly, or
 *  through a run, a workspace, a checkpoint or an attachment of it — is refused before the harness is asked, reads
 *  nothing of it and starts nothing in it. Scripted models; no live model, no external network. */
import { afterEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DirectorTurn } from '@oasis-code/contract'
import { saveAttachment } from '../src/api/attachments.ts'
import * as repo from '../src/db/repo.ts'
import { namedThings, scopeRefusal } from '../src/director/scope.ts'
import { lastToolReturn, modelResponse, textPart, toolCallPart, type ModelMessage } from '../src/llm/messages.ts'
import type { App } from '../src/main.ts'
import { Client, json, makeApp } from './api_harness.ts'
import { buggyRepo, scriptedModel, setModel, sleep, steps, waitDone } from './harness.ts'
import { rec } from './tree_helpers.ts'
import { asLegacyV1 } from './director_surface_fixtures.ts'

let app: App | null = null
afterEach(async () => { await app?.close(); app = null })

async function settled(c: Client, turnId: string): Promise<DirectorTurn> {
  const deadline = Date.now() + 15000
  for (;;) {
    const turn = await json<DirectorTurn>(await c.get(`/api/director-turns/${turnId}`))
    if (['done', 'error', 'failed', 'cancelled'].includes(String(turn.status)) || Date.now() > deadline) return turn
    await sleep(30)
  }
}

test('a native director bound to A neither reads B nor sends into B, by any id it names', async () => {
  app = await makeApp()
  const c = new Client(app)
  const st = app.state
  const project = await json(await c.post('/api/projects', { source_path: buggyRepo() }))
  const a = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'scope A', model: 'scripted:a' }))
  const b = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'scope B PRIVATE MARKER', model: 'scripted:a' }))
  const other = await json(await c.post('/api/projects', { source_path: buggyRepo() }))
  // B has a run, a checkpoint and an attachment of its own to be named
  setModel(st, 'scripted:a', scriptedModel(() => modelResponse([textPart('B worked')])))
  const bRun = await json(await c.post(`/api/sessions/${b.id}/chat`, { text: 'hello B' }))
  await waitDone(st, bRun.id as string)
  const bWs = repo.getWorkspace(st.conn, b.workspace_id as string)!
  const bCp = await st.workspaces.checkpoint(bWs, null, 'B pinned')
  const png = new Uint8Array(readFileSync(join(import.meta.dir, 'fixtures', 'images', 'red-7x5.png')))
  const bAttachment = saveAttachment({ conn: st.conn, store: st.store }, repo.getSession(st.conn, b.id as string)!, png, 'red.png').asset_id
  const returns: Record<string, unknown> = {}
  const attempts: [string, Record<string, unknown>][] = [
    ['get_session', { session_id: b.id }],
    ['start_run', { session_id: b.id, text: 'cross-session instruction', model: 'scripted:a' }],
    ['start_run', { session_id: b.id, text: 'cross-session separate run', separate: true }],
    ['start_run', { session_id: a.id, text: 'a run on B\'s checkpoint', separate: true, base_checkpoint_id: bCp.id }],
    ['get_run', { run_id: bRun.id }],
    ['get_run', { run_id: bRun.id, view: 'events' }],
    ['start_run', { session_id: a.id, text: 'go on', resume_run_id: bRun.id }],
    ['get_workspace', { workspace_id: b.workspace_id }],
    ['get_workspace', { workspace_id: b.workspace_id, include_diff: true }],
    ['read_file', { workspace_id: b.workspace_id, path: '.' }],
    ['read_file', { workspace_id: b.workspace_id, path: 'README.md' }],
    ['integrate', { workspace_id: a.workspace_id, checkpoint_ids: [bCp.id] }],
    ['integrate', { workspace_id: b.workspace_id, checkpoint_ids: [bCp.id] }],
    ['set_project_config', { project_id: other.id, instructions: 'cross-project' }],
    ['get_run', { run_id: 'run_000000000000' }],
    ['start_run', { session_id: a.id, text: 'with B image', attachments: [bAttachment] }],
    ['get_session', { session_id: a.id }],                                   // and its own session it reads
    ['start_run', { text: 'own session, session_id left out', model: 'scripted:a' }],
  ]
  let i = 0
  setModel(st, 'scripted:b', scriptedModel((m: ModelMessage[]) => {
    if (i > 0) returns[`${i - 1}:${attempts[i - 1]![0]}`] = lastToolReturn(m, attempts[i - 1]![0]) as Record<string, unknown>
    const next = attempts[i++]
    return next ? modelResponse([toolCallPart(next[0], next[1], '')]) : modelResponse([textPart('done')])
  }))
  await json(await c.post(`/api/sessions/${a.id}/director`, { transport: 'native', model: 'scripted:b', config: { allow_destructive: false } }))
  asLegacyV1(st.conn, st.director.requireOpen(a.id as string).id)   // a pre-surface row: this test pins v1's refusal words (v2: test_director_v2)
  const turn = await json<DirectorTurn>(await c.post(`/api/sessions/${a.id}/director/messages`, { text: 'scripted cross-session attempts' }))
  const done = await settled(c, turn.id)
  expect(done.status).toBe('done')
  for (const run of done.dispatched_run_ids) await waitDone(st, run)
  const entries = Object.entries(returns)
  expect(entries).toHaveLength(attempts.length)
  const refusedCount = attempts.length - 2
  for (const [key, value] of entries.slice(0, refusedCount)) {
    const r = rec(value)
    expect(r.status, key).toBe('refused')
    expect(String(r.reason), key).toBe(`This call refers to another session. Use session ${a.id}. Nothing was run.`)
    expect(JSON.stringify(r), key).not.toContain('PRIVATE MARKER')
  }
  expect(JSON.stringify(entries.slice(0, refusedCount))).not.toContain(bWs.path)
  // the refused calls are recorded as refused on the turn; nothing was dispatched into B
  expect(done.tool_calls.filter((t) => t.status === 'refused')).toHaveLength(refusedCount)
  const bDetail = await json(await c.get(`/api/sessions/${b.id}`))
  expect((bDetail.runs as Record<string, unknown>[]).map((r) => r.id)).toEqual([bRun.id])
  expect(repo.getProject(st.conn, other.id as string)!.config.instructions).toBeUndefined()
  // its own session: read, and written to with the session left out
  const own = rec(returns[`${refusedCount}:get_session`])
  expect(own.id).toBe(a.id)
  const sent = rec(returns[`${refusedCount + 1}:start_run`])
  expect(sent.session_id).toBe(a.id)
  expect(done.dispatched_run_ids).toEqual([sent.id as string])
}, 40000)

test('the scope reads every argument that names something, and an unknown id is refused like another session\'s', async () => {
  app = await makeApp()
  const st = app.state
  const c = new Client(app)
  const project = await json(await c.post('/api/projects', { source_path: buggyRepo() }))
  const a = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'A', model: 'scripted:a' }))
  const b = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'B', model: 'scripted:a' }))
  expect(namedThings({ session_id: 's', run_id: 'r', resume_run_id: 'r2', base_checkpoint_id: 'c3', workspace_id: 'w', checkpoint_id: 'c', checkpoint_ids: ['c1', 'c2'], attachments: ['i'], proposal_asset_id: 'p', approval_id: 'ap', work_order: { workspace: { base: 'cp' } }, text: 'not an id' }).map(([kind, id]) => `${kind}:${id}`))
    .toEqual(['session:s', 'run:r', 'run:r2', 'checkpoint:c3', 'workspace:w', 'checkpoint:c', 'checkpoint:c1', 'checkpoint:c2', 'proposal:p', 'approval:ap', 'attachment:i', 'checkpoint:cp'])
  expect(namedThings({ work_order: { workspace: { base: 'parent' } } })).toEqual([])
  expect(scopeRefusal(st.conn, a.id as string, 'get_session', { session_id: a.id })).toBeNull()
  expect(scopeRefusal(st.conn, a.id as string, 'get_session', { session_id: b.id })).toContain('refers to another session')
  expect(scopeRefusal(st.conn, a.id as string, 'get_workspace', { workspace_id: a.workspace_id })).toBeNull()
  expect(scopeRefusal(st.conn, a.id as string, 'get_workspace', { workspace_id: b.workspace_id })).toContain('refers to another session')
  expect(scopeRefusal(st.conn, a.id as string, 'get_workspace', { workspace_id: 'ws_nothing' })).toContain('refers to another session')   // an unknown id: the same answer
  expect(scopeRefusal(st.conn, a.id as string, 'set_project_config', { project_id: project.id })).toBeNull()
  expect(scopeRefusal(st.conn, a.id as string, 'set_project_config', { project_id: 'p_other' })).toContain('refers to another session')
  expect(scopeRefusal(st.conn, 's_gone', 'get_session', { session_id: 's_gone' })).toContain('gone')
})
