/** A command's id is not its authorization: bash_output and stop_command answer for the executions of this run's
 *  session — its own, its workspace's, an earlier run's of the same session — and treat another session's id as
 *  one that names nothing, whatever it prints and however it was learnt. Real processes through PassthroughRuntime
 *  (the manager's mechanics; no OS isolation is claimed here). */
import { afterEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Session } from '@oasis-code/contract'
import { parseWorkOrder } from '../src/agent/work_orders.ts'
import { sandboxForWorkspace } from '../src/workspace/sandbox.ts'
import { lastToolReturn, modelResponse, textPart, toolCallPart } from '../src/llm/messages.ts'
import { appState, buggyRepo, closeState, openSession, scriptedModel, setModel, sleep, waitDone, type AppState } from './harness.ts'

let state: AppState | null = null
afterEach(async () => { if (state) await closeState(state); state = null })

async function calls(session: Session, orderRaw: Record<string, unknown> | null, sequence: [string, Record<string, unknown>][]) {
  const results: Record<string, unknown>[] = []
  let index = 0
  setModel(state!, 'scripted:a', scriptedModel((messages) => {
    if (index > 0) results.push(lastToolReturn(messages, sequence[index - 1]![0]) as Record<string, unknown>)
    const next = sequence[index++]
    return next ? modelResponse([toolCallPart(next[0], next[1], '')]) : modelResponse([textPart('done')])
  }))
  const run = await state!.runs.start(session, 'synthetic', { fresh: true, ...(orderRaw ? { work_order: parseWorkOrder({ prompt: 'synthetic', ...orderRaw }) } : {}) })
  await waitDone(state!, run.id)
  return results
}

async function started(ws: { path: string; id: string }, project: { id: string } & Record<string, unknown>, command: string) {
  const execution = await state!.processes.start({
    command, cwd: ws.path, sandbox: sandboxForWorkspace(state!.settings.data_dir, project as never, ws as never, { network: false }), project_id: project.id, workspace_id: ws.id,
  })
  for (let i = 0; i < 100 && state!.processes.readOutput(execution.id, 'stdout', 0, 100).total_bytes === 0; i++) await sleep(20)
  return execution
}

test("session A neither reads nor stops session B's command; its own session's it does", async () => {
  state = await appState({ sandbox: true })
  const a = await openSession(state, buggyRepo())
  const b = await openSession(state, buggyRepo())
  const secret = await started(b.ws, b.project, 'printf SYNTHETIC_B_PRIVATE_MARKER; sleep 20')
  const heartbeat = await started(b.ws, b.project, 'echo READY; while true; do echo tick >> heartbeats; sleep 0.05; done')
  const own = await started(a.ws, a.project, 'echo MINE; sleep 20')
  const [read, stop, ownRead, ownStop] = await calls(a.session, { read_only: true }, [
    ['bash_output', { execution_id: secret.id }], ['stop_command', { execution_id: heartbeat.id }],
    ['bash_output', { execution_id: own.id }], ['stop_command', { execution_id: own.id }],
  ])
  expect(read!.status).toBe('refused')
  expect(JSON.stringify(read)).not.toContain('SYNTHETIC_B_PRIVATE_MARKER')
  expect(read!.reason).toBe(`unknown command ${secret.id}`)             // the same answer as for an id that names nothing
  expect(stop!.status).toBe('refused')
  expect(state.processes.isRunning(heartbeat.id)).toBe(true)
  const before = readFileSync(join(b.ws.path, 'heartbeats'), 'utf8').length
  await sleep(300)
  expect(readFileSync(join(b.ws.path, 'heartbeats'), 'utf8').length).toBeGreaterThan(before)
  expect(ownRead!.status).toBe('running')                              // the execution's own status, as bash_output reports it
  expect(ownRead!.text).toContain('MINE')
  expect(ownStop!.status).toBe('ok')
  expect(ownStop!.stopped).toBe(true)
  state.processes.stop(secret.id)
  state.processes.stop(heartbeat.id)
  // a later run of the same session reads the command an earlier one started
  const later = await started(a.ws, a.project, 'echo LATER; sleep 20')
  const [again] = await calls(a.session, null, [['bash_output', { execution_id: later.id }]])
  expect(again!.status).toBe('running')
  expect(again!.text).toContain('LATER')
  const [nothing] = await calls(a.session, null, [['bash_output', { execution_id: 'x_000000000000' }]])
  expect(nothing!.status).toBe('refused')
  expect(nothing!.reason).toBe('unknown command x_000000000000')
})
