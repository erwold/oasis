import { afterEach, expect, spyOn, test } from 'bun:test'
import type { SessionDetail } from '@oasis-code/contract'
import type { App } from '../src/main.ts'
import { Client, json, makeApp } from './api_harness.ts'
import * as repo from '../src/db/repo.ts'
import { dumpJson, modelRequest, modelResponse, textPart, userPrompt } from '../src/llm/messages.ts'

let app: App | null = null
afterEach(async () => { if (app) await app.close(); app = null })
async function fixture() {
  app = await makeApp()
  const conn = app.state.conn
  const project = repo.createProject(conn, 'synthetic', { source_path: null, base_repo_path: '/synthetic', base_branch: null, base_commit: null, import_report: {} })
  const session = repo.createSession(conn, project.id, 'opening', 'scripted:a')
  const insert = (status = 'done', parent_run_id: string | null = null) => repo.insertRun(conn, { session_id: session.id, project_id: project.id, workspace_id: null, model: 'scripted:a', model_config: {}, user_text: 'question', status, budget: {}, parent_run_id })
  return { conn, session, insert, client: new Client(app), state: app.state }
}
type Opening = SessionDetail & { transcripts: Record<string, unknown>; transcript_errors?: Record<string, string> }

test('complete opt-in envelope equals individual transcript routes; live and off-thread records stay out', async () => {
  const { conn, session, insert, client } = await fixture()
  const first = insert(), second = insert('error'), live = insert('running'), child = insert('done', first.id)
  for (const r of [first, second, live, child]) repo.saveRunProgress(conn, r.id, dumpJson([modelRequest([userPrompt('question')]), modelResponse([textPart(`answer ${r.id}`)])]), {}, 1)
  const plain = await json<SessionDetail & { transcripts?: unknown }>(await client.get(`/api/sessions/${session.id}`))
  expect(plain.transcripts).toBeUndefined()
  const res = await client.get(`/api/sessions/${session.id}?transcripts=1`)
  expect(res.headers.get('cache-control')).toBe('no-store')
  const { transcripts, ...detail } = await json<Opening>(res)
  expect(detail).toEqual(plain)
  expect(Object.keys(transcripts)).toEqual([first.id, second.id])
  for (const r of [first, second]) expect(transcripts[r.id]).toEqual(await json(await client.get(`/api/runs/${r.id}/transcript`)))
  expect(transcripts[live.id]).toBeUndefined(); expect(transcripts[child.id]).toBeUndefined()
  // Aux is never keyed just by collaboration_revision or run status; the completed run's form changes now.
  const form = repo.insertUiInput(conn, { session_id: session.id, run_id: first.id, tool_call_id: 'form', request: { title: 'Choose' } })
  repo.answerUiInput(conn, form.id, { status: 'submitted', values: { answer: 'yes' } })
  const again = await json<Opening>(await client.get(`/api/sessions/${session.id}?transcripts=1`))
  expect(again.transcripts[first.id]).toEqual(await json(await client.get(`/api/runs/${first.id}/transcript`)))
  expect(JSON.stringify(again.transcripts[first.id])).toContain('submitted')
})

test('one unreadable/deleted run does not fail the other transcripts, and retry can recover', async () => {
  const { conn, session, insert, client } = await fixture()
  const a = insert(), b = insert()
  repo.saveRunProgress(conn, a.id, dumpJson([modelResponse([textPart('available')])]), {}, 1)
  const original = repo.getTranscriptRun
  const fail = spyOn(repo, 'getTranscriptRun').mockImplementation((c, id) => id === b.id ? null : original(c, id))
  try {
    const result = await json<Opening>(await client.get(`/api/sessions/${session.id}?transcripts=1`))
    expect(Object.keys(result.transcripts)).toEqual([a.id])
    expect(result.transcript_errors).toEqual({ [b.id]: 'unavailable' })
    expect(JSON.stringify(result.transcripts[a.id])).toContain('available')
  } finally { fail.mockRestore() }
  const recovered = await json<Opening>(await client.get(`/api/sessions/${session.id}?transcripts=1`))
  expect(Object.keys(recovered.transcripts)).toEqual([a.id, b.id]); expect(recovered.transcript_errors).toBeUndefined()
})

test('cursor precedes history reads; a run ending while history is read remains a live-stream subscription', async () => {
  const { conn, session, insert, client, state } = await fixture()
  const a = insert(), live = insert('running')
  const cursor = state.runs.sessionCursor(session.id)
  const original = repo.getTranscriptRun
  let changed = false
  const read = spyOn(repo, 'getTranscriptRun').mockImplementation((c, id) => {
    if (!changed) {
      changed = true
      repo.finishRun(conn, live.id, 'done', { history_json: dumpJson([modelResponse([textPart('ended during opening')])]), saved_seq: 1, usage: {}, receipt: {}, error: null })
      repo.insertEvent(conn, live.id, 1, 'run_finished', { status: 'done' })
    }
    return original(c, id)
  })
  try {
    const result = await json<Opening>(await client.get(`/api/sessions/${session.id}?transcripts=1`))
    expect(result.event_cursor).toBe(cursor)
    expect(result.runs.find(r => r.id === live.id)?.status).toBe('running')
    expect(result.transcripts[live.id]).toBeUndefined()
    expect(result.transcripts[a.id]).toBeDefined()
    expect(state.runs.sessionCursor(session.id)).toBeGreaterThan(cursor)
  } finally { read.mockRestore() }
})

test('display reader preserves exact metadata/tie order, excluding only manifest and other sessions', async () => {
  const { conn, session, insert } = await fixture()
  const a = insert(), b = insert(), excluded = insert()
  conn.run('UPDATE runs SET created_at=?, manifest_json=?, receipt_json=? WHERE session_id=?', ['same', JSON.stringify({ large: 'x'.repeat(100000) }), JSON.stringify({ final_text: 'complete receipt' }), session.id])
  const oracle = repo.listRuns(conn, session.id).filter(r => r.id !== excluded.id).map(({ manifest, ...r }) => r)
  expect(repo.listDisplayRuns(conn, session.id, [b.id, a.id, b.id, 'absent'])).toEqual(oracle)
  expect(repo.listDisplayRuns(conn, 'other', [a.id])).toEqual([])
  expect(repo.listDisplayRuns(conn, session.id, [])).toEqual([])
  expect(repo.getRun(conn, a.id)?.manifest).toEqual({ large: 'x'.repeat(100000) })
})
