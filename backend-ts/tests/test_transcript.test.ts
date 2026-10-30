/** A run's stored history as its transcript: a call answered reads its result; one nobody answered reads running
 *  while the run runs and — the run over — closed as the run ended: cancelled for a stopped run, interrupted for one
 *  that crashed or was lost. The transcript route knows which, from the run's status. */

import { afterEach, expect, test } from 'bun:test'
import type { TranscriptEntry } from '@oasis-code/contract'
import { CALL_DETAIL_CHARS, rebuildTranscript, toolCallOf, UNREADABLE_HISTORY } from '../src/agent/transcript.ts'
import * as repo from '../src/db/repo.ts'
import { dumpJson, modelRequest, modelResponse, toolCallPart, toolReturn, userPrompt } from '../src/llm/messages.ts'
import type { App } from '../src/main.ts'
import { Client, json, makeApp } from './api_harness.ts'
import { buggyRepo } from './harness.ts'

const HISTORY = dumpJson([
  modelRequest([userPrompt('read both')]),
  modelResponse([toolCallPart('read_file', { path: 'calc.py' }, 'c1'), toolCallPart('bash', { command: 'sleep 9' }, 'c2')]),
  modelRequest([toolReturn('read_file', { status: 'ok', path: 'calc.py' }, 'c1')]),
])

const activities = (entries: TranscriptEntry[]) => entries.filter((e) => e.kind === 'activity').map((e) => [e.toolCallId, e.result?.status ?? null, e.running])

test('an unanswered call reads running while the run runs, and closed as the run ended once it is over', () => {
  expect(activities(rebuildTranscript(HISTORY))).toEqual([['c1', 'ok', false], ['c2', null, true]])
  const lost = rebuildTranscript(HISTORY, 0, 'error')
  expect(activities(lost)).toEqual([['c1', 'ok', false], ['c2', 'interrupted', false]])
  expect(String(lost[2]!.result!.reason)).toContain('the run ended (error)')
  const stopped = rebuildTranscript(HISTORY, 0, 'cancelled')
  expect(activities(stopped)).toEqual([['c1', 'ok', false], ['c2', 'cancelled', false]])
  // a missing return says the result was not recorded — never that the tool did not run (the record cannot know)
  expect(String(stopped[2]!.result!.reason)).toContain('whether it ran and what it changed is unknown')
  expect(String(stopped[2]!.result!.reason)).not.toContain('not executed')
  expect(String(lost[2]!.result!.reason)).toContain('unknown')
  expect(activities(rebuildTranscript(HISTORY, 0, 'done'))).toEqual([['c1', 'ok', false], ['c2', 'interrupted', false]])
  // an answered call keeps its answer whatever the run's end
  expect(rebuildTranscript(HISTORY, 0, 'error')[1]!.result).toEqual({ status: 'ok', path: 'calc.py' })
})

let app: App | null = null
afterEach(async () => { if (app) await app.close(); app = null })

test('the transcript route of a run the harness lost mid-call shows the call closed as interrupted, never running', async () => {
  app = await makeApp()
  const { state } = app
  const c = new Client(app)
  const project = await json(await c.post('/api/projects', { source_path: buggyRepo() }))
  const session = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 't' }))
  // a run left running with an accepted response and one return: what a process that died mid-tool leaves behind
  const run = repo.insertRun(state.conn, {
    session_id: String(session.id), project_id: String(project.id), workspace_id: String((session.workspace as Record<string, unknown>).id),
    model: 'scripted:a', model_config: {}, user_text: 'read both', status: 'running', budget: {},
  })
  repo.saveRunProgress(state.conn, run.id, HISTORY, {}, 0)
  const live = await json(await c.get(`/api/runs/${run.id}/transcript`))
  expect(live.status).toBe('running')
  expect(activities(live.entries as TranscriptEntry[])).toEqual([['c1', 'ok', false], ['c2', null, true]])
  // the harness comes back: the run is lost; its transcript shows the call as the run ended, not running
  const reconciled = await state.runs.reconcile()
  expect(reconciled.dead_runs).toEqual([run.id])
  const after = await json(await c.get(`/api/runs/${run.id}/transcript`))
  expect(after.status).toBe('error')
  expect(activities(after.entries as TranscriptEntry[])).toEqual([['c1', 'ok', false], ['c2', 'interrupted', false]])
})

test('a computer-use call reads its page and what was done, and the look it took as the image it is — never its bytes', () => {
  const shot = { kind: 'image', asset_id: 'a_shot', sha256: 'f'.repeat(64), name: 'browser-2.jpg', media_type: 'image/jpeg', width: 1280, height: 800, bytes: 9000 }
  const history = dumpJson([
    modelRequest([userPrompt('click go')]),
    modelResponse([toolCallPart('computer_act', { action: 'click', ref: 'e7', snapshot_id: 'browser-1' }, 'k1')]),
    modelRequest([toolReturn('computer_act', { status: 'ok', surface: 'browser', action: 'click', done: { clicked: 'e7' }, snapshot_id: 'browser-2', url: 'https://example.com/', title: 'Example', outline: '- button "Go" [ref=e7]', screenshot: shot }, 'k1')]),
  ])
  const [entry] = rebuildTranscript(history).filter((e) => e.kind === 'activity')
  expect(entry!.result).toEqual({ status: 'ok', surface: 'browser', action: 'click', snapshot_id: 'browser-2', url: 'https://example.com/', title: 'Example', screenshot_asset_id: 'a_shot' })
})

test('an image read_file read shows again as the image it is, labelled with its path — never its bytes', () => {
  const image = { kind: 'image', asset_id: 'a_page', sha256: 'e'.repeat(64), name: 'p_032.png', media_type: 'image/png', width: 1376, height: 826, bytes: 1427095, data: 'QUJD'.repeat(400) }
  const history = dumpJson([
    modelRequest([userPrompt('look at page 32')]),
    modelResponse([toolCallPart('read_file', { path: 'sheets/p_032.png' }, 'r1')]),
    modelRequest([toolReturn('read_file', { status: 'ok', path: 'sheets/p_032.png', kind: 'image', media_type: 'image/png', width: 1376, height: 826, bytes: 1427095, image }, 'r1')]),
  ])
  const [entry] = rebuildTranscript(history).filter((e) => e.kind === 'activity')
  expect(entry!.result).toEqual({ status: 'ok', path: 'sheets/p_032.png', shown: [{ asset_id: 'a_page', width: 1376, height: 826, label: 'sheets/p_032.png' }] })
})

test('a stored history that no longer reads is a transcript that says it is unavailable, never an empty run', () => {
  for (const broken of ['[{"kind":"request","parts":[{"part_kind":"user-pro', '{"kind":"request"}', 'null']) {
    expect(rebuildTranscript(broken)).toEqual([{ kind: 'note', text: UNREADABLE_HISTORY }])
  }
  // a run with no history yet has nothing to show, and says nothing
  expect(rebuildTranscript(null)).toEqual([])
})

test('the transcript route of a run whose history got corrupted shows the unavailable note', async () => {
  app = await makeApp()
  const { state } = app
  const c = new Client(app)
  const project = await json(await c.post('/api/projects', { source_path: buggyRepo() }))
  const session = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 't' }))
  const run = repo.insertRun(state.conn, {
    session_id: String(session.id), project_id: String(project.id), workspace_id: String((session.workspace as Record<string, unknown>).id),
    model: 'scripted:a', model_config: {}, user_text: 'read both', status: 'done', budget: {},
  })
  repo.saveRunProgress(state.conn, run.id, '[{"kind":"request","parts":[{"part_kind":"user-pro', {}, 0)
  const body = await json(await c.get(`/api/runs/${run.id}/transcript`))
  expect(body.entries).toEqual([{ kind: 'note', text: UNREADABLE_HISTORY }])
})

test("a call opened: its arguments and whole return; one past the bound has each long text cut and says so", () => {
  const big = 'x'.repeat(CALL_DETAIL_CHARS * 2)
  const history = dumpJson([
    modelResponse([toolCallPart('read_file', { path: 'a.txt' }, 'c1'), toolCallPart('bash', JSON.stringify({ command: 'ls' }) as never, 'c2')]),
    modelRequest([toolReturn('read_file', { status: 'ok', content: '1\thello' }, 'c1'), toolReturn('bash', { status: 'succeeded', stdout: big, stderr: 'warn' }, 'c2')]),
  ])
  expect(toolCallOf(history, 'c1')).toEqual({ tool: 'read_file', args: { path: 'a.txt' }, result: { status: 'ok', content: '1\thello' }, cut: false })
  const long = toolCallOf(history, 'c2')!
  expect(long.args).toEqual({ command: 'ls' })                                                    // arguments kept as text are read back
  expect(long.cut).toBe(true)
  const result = long.result as Record<string, string>
  expect(result.stdout!.length).toBeLessThan(CALL_DETAIL_CHARS)
  expect(result.stderr).toBe('warn')                                                              // a short text stays whole
  expect(toolCallOf(history, 'nope')).toBeNull()
  expect(toolCallOf('not json', 'c1')).toBeNull()
})


test('a stored computer history retains the sharp display asset separately from the agent image', () => {
  const screenshot = { kind: 'image', asset_id: 'agent', sha256: 'f'.repeat(64), name: 'screen.jpg', media_type: 'image/jpeg', width: 1280, height: 800, bytes: 9000 }
  const history = dumpJson([
    modelResponse([toolCallPart('computer_observe', {}, 'k1')]),
    modelRequest([toolReturn('computer_observe', { status: 'ok', surface: 'browser', screenshot, screenshot_display_asset_id: 'display' }, 'k1')]),
  ])
  const [entry] = rebuildTranscript(history).filter((entry) => entry.kind === 'activity')
  expect(entry!.result!.screenshot_asset_id).toBe('agent')
  expect(entry!.result!.screenshot_display_asset_id).toBe('display')
})
