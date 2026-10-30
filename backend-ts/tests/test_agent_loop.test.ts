/** The first closed loop: a scripted model fixes a reproducible defect in a real Git repository through the real
 *  tools — list, read, edit (at the version it read), run the tests in the sandbox — and the harness pins the final
 *  state as a checkpoint and leaves a diff, logs with provenance, and a mechanical receipt. No backdoor edits the
 *  expected answer. */

import { afterEach, expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as repo from '../src/db/repo.ts'
import { modelResponse, textPart, toolCallPart, type ModelMessage } from '../src/llm/messages.ts'
import { appState, buggyRepo, closeState, git, lastToolReturn, openSession, scriptedModel, steps, toolReturns, waitDone, type AppState } from './harness.ts'

let state: AppState | null = null
afterEach(async () => { if (state) await closeState(state); state = null })

function fixingScript() {
  const edit = (messages: ModelMessage[]) => {
    const read = lastToolReturn(messages, 'read_file') as Record<string, unknown>
    expect(read.status).toBe('ok')
    return modelResponse([toolCallPart('edit_file', { path: 'calc.py', old_string: '    return a - b   # the bug: this should add', new_string: '    return a + b' }, '')])
  }
  const final = (messages: ModelMessage[]) => {
    const run = lastToolReturn(messages, 'bash') as Record<string, unknown>
    return modelResponse([textPart(`Fixed add(): calc.py now returns a + b. Tests: execution ${run.execution_id} exit ${run.exit_code}.`)])
  }
  return steps(
    [toolCallPart('read_file', { path: '.' }, '')],
    [toolCallPart('read_file', { path: 'calc.py' }, '')],
    edit,
    [toolCallPart('bash', { command: 'python3 -m unittest -v 2>&1' }, '')],
    final,
  )
}

test('a scripted model fixes the bug end to end', async () => {
  state = await appState({ sandbox: true, models: { 'scripted:a': scriptedModel(fixingScript(), 'scripted-a') } })
  const src = buggyRepo()
  const { project, session, ws } = await openSession(state, src)
  let run = await state.runs.start(session, 'add() returns the wrong result; fix it and run the tests')
  run = await waitDone(state, run.id)
  expect(run.status).toBe('done')
  // the workspace holds the fix; the person's repository does not
  expect(readFileSync(join(ws.path, 'calc.py'), 'utf8')).toContain('return a + b')
  expect(readFileSync(join(src, 'calc.py'), 'utf8')).toContain('return a - b')
  // the harness pinned the final state: a real commit off the base, under refs/oasis-code in the workspace's own
  // repository (the base repository never learns it)
  const cps = repo.listCheckpoints(state.conn, ws.id)
  expect(cps).toHaveLength(1)
  expect(cps[0]!.run_id).toBe(run.id)
  expect(cps[0]!.note).toBe('the final state of the run')
  expect(git(['rev-parse', cps[0]!.ref], ws.path)).toBe(cps[0]!.commit_sha)
  expect(() => git(['cat-file', '-e', cps[0]!.commit_sha], project.base_repo_path)).toThrow()
  const shown = git(['show', '--stat', '--format=%s', cps[0]!.commit_sha], ws.path)
  expect(shown).toContain('calc.py')
  expect(shown).toContain('oasis-code checkpoint')
  const diff = await state.workspaces.diff(ws)
  expect(diff.patch).toContain('+    return a + b')
  expect(diff.files.map((f) => f.path)).toEqual(['calc.py'])
  // the test run is an execution with exit 0 and a log asset that shows the tests
  const xs = repo.listExecutions(state.conn, { run_id: run.id })
  expect(xs).toHaveLength(1)
  expect(xs[0]!.exit_code).toBe(0)
  expect(xs[0]!.status).toBe('succeeded')
  expect(xs[0]!.effect_state).toBe('applied')
  const log = state.store.read(repo.getAsset(state.conn, xs[0]!.stdout_asset_id!)!.storage_path).toString()
  expect(log).toContain('test_add')
  expect(log).toContain('OK')
  expect(xs[0]!.isolation.enforcement).toBe('full')
  // events: every tool call has a result keyed by the same tool_call_id, persisted
  const events = repo.listEvents(state.conn, run.id)
  const calls = new Map(events.filter((e) => e.event === 'tool_call').map((e) => [e.data.tool_call_id as string, e.data.tool as string]))
  const results = new Map(events.filter((e) => e.event === 'tool_result').map((e) => [e.data.tool_call_id as string, e.data]))
  expect(new Set(calls.keys())).toEqual(new Set(results.keys()))
  expect([...calls.values()]).toEqual(['read_file', 'read_file', 'edit_file', 'bash'])
  const idOf = (tool: string) => [...calls.entries()].find(([, v]) => v === tool)![0]
  expect(results.get(idOf('edit_file'))!.path).toBe('calc.py')
  expect(results.get(idOf('bash'))!.exit_code).toBe(0)
  expect(events.map((e) => e.seq)).toEqual([...events.map((e) => e.seq)].sort((a, b) => a - b))
  expect(events[events.length - 1]!.event).toBe('run_finished')
  expect(events[events.length - 1]!.data.status).toBe('done')
  // the receipt is mechanical; the model's words are separate; cost is unknown, not 0
  const rec = run.receipt.mechanical as Record<string, unknown>
  expect(rec.tool_calls).toBe(4)
  expect(rec.requests).toBe(5)
  expect(rec.checkpoints).toEqual([cps[0]!.id])
  expect((rec.executions as Record<string, unknown>[])[0]!.exit_code).toBe(0)
  expect(rec.cost_status).toBe('unknown')
  expect(rec.cost_usd).toBeNull()
  expect(run.receipt.final_text as string).toContain(xs[0]!.id)
  expect((run.receipt.produced as Record<string, unknown>).final_checkpoint_id).toBe(cps[0]!.id)
  // per-request records and the manifest
  const reqs = repo.listModelRequests(state.conn, run.id)
  expect(reqs).toHaveLength(5)
  expect(reqs.every((r) => r.cost_status === 'unknown' && r.cost_usd === null)).toBe(true)
  expect(reqs[0]!.configured_model).toBe('scripted-a')
  expect(reqs[0]!.tool_schema_sha256).toBeTruthy()
  expect((run.manifest.tools as string[]).length).toBeGreaterThan(0)
  expect((run.manifest.model as Record<string, unknown>).id).toBe('scripted:a')
  expect(JSON.stringify(run.manifest.model)).not.toContain('api_key')
  expect((run.manifest.workspace as Record<string, unknown>).base_commit).toBe(ws.base_commit)
  // the stored history reloads; the next run in the session continues it
  expect(repo.getRunHistory(state.conn, run.id)).toBeTruthy()
  expect(existsSync(join(ws.path, 'calc.py'))).toBe(true)
  expect(state.locks.holder(ws.id)).toBeNull()
})

test('without isolation bash is refused and the rest works', async () => {
  const final = (messages: ModelMessage[]) => {
    const run = lastToolReturn(messages, 'bash') as Record<string, unknown>
    return modelResponse([textPart(`Edited; tests NOT run (${run.status}: ${String(run.reason).slice(0, 40)})`)])
  }
  const script = steps(
    [toolCallPart('read_file', { path: 'calc.py' }, '')],
    [toolCallPart('edit_file', { path: 'calc.py', old_string: 'return a - b   # the bug: this should add', new_string: 'return a + b' }, '')],
    [toolCallPart('bash', { command: 'python3 -m unittest' }, '')],
    final,
  )
  state = await appState({ models: { 'scripted:a': scriptedModel(script) } })
  expect(state.isolation.enforcement).toBe('unavailable')
  const { session, ws } = await openSession(state, buggyRepo())
  const run = await waitDone(state, (await state.runs.start(session, 'fix add')).id)
  expect(run.status).toBe('done')
  expect(run.receipt.final_text as string).toContain('tests NOT run (refused')
  expect(repo.listExecutions(state.conn, { run_id: run.id })).toEqual([])
  expect((run.receipt.mechanical as Record<string, unknown>).refused_calls).toBe(1)
  expect(repo.listCheckpoints(state.conn, ws.id)).toHaveLength(1)
})

test('a file changed since it was read is a conflict, not an overwrite', async () => {
  const seen: Record<string, string> = {}
  const editAfterOutsideChange = () => {
    // an editor changes the file between the read and the write
    writeFileSync(join(state!.settings.workspaces_dir, seen.ws!, 'calc.py'), 'def add(a, b):\n    return a + b  # edited outside\n')
    return modelResponse([toolCallPart('edit_file', { path: 'calc.py', old_string: 'a + b', new_string: 'a - b' }, '')])
  }
  const final = (messages: ModelMessage[]) => {
    const r = lastToolReturn(messages, 'edit_file') as Record<string, unknown>
    return modelResponse([textPart(`${r.status}: ${r.reason}`)])
  }
  state = await appState({ models: { 'scripted:a': scriptedModel(steps([toolCallPart('read_file', { path: 'calc.py' }, '')], editAfterOutsideChange, final)) } })
  const { session, ws } = await openSession(state, buggyRepo())
  seen.ws = ws.id
  const run = await waitDone(state, (await state.runs.start(session, 'fix')).id)
  expect(run.status).toBe('done')
  expect(run.receipt.final_text as string).toStartWith('refused: calc.py changed after your last read')
  expect(readFileSync(join(ws.path, 'calc.py'), 'utf8')).toEndWith('# edited outside\n')     // the outside edit survived
})

test('protected path and git metadata writes are refused', async () => {
  const script = steps(
    [toolCallPart('write_file', { path: 'secrets/key.pem', content: 'x' }, '')],
    [toolCallPart('write_file', { path: '.git/config', content: 'x' }, '')],
    [toolCallPart('write_file', { path: '../outside.txt', content: 'x' }, '')],
    (m) => modelResponse([textPart(toolReturns(m).map((p) => (p.content as Record<string, unknown>).reason).join(' | '))]),
  )
  state = await appState({ models: { 'scripted:a': scriptedModel(script) } })
  const { session, ws } = await openSession(state, buggyRepo())
  const run = await waitDone(state, (await state.runs.start(session, 'try')).id)
  const text = run.receipt.final_text as string
  expect(text).toContain('protected path')
  expect(text).toContain('Git metadata')
  expect(text).toContain("'..' is refused")
  expect(existsSync(join(ws.path, 'secrets'))).toBe(false)
  expect(existsSync(join(ws.path, '..', 'outside.txt'))).toBe(false)
  expect(readFileSync(join(ws.path, '.git'), 'utf8')).toStartWith('gitdir:')
})
