/** A watched run's tools in the live projection (share/snapshot.ts buildLiveSnapshot), the conservative whitelist: a
 *  tool's result event carries no output (bash's says its command head, execution id, exit code and byte counts), and a
 *  run that works is read from its events alone — so while it works a returned command shows its outcome, never its
 *  output, and a command known only from a possibly cut event is withheld. Once the run has finished its record is
 *  read (as the offline share reads it): the preview, sanitized, appears; a sensitive command and its polling stay
 *  withheld whole in every state. Synthetic rows only; secrets put together at run time. */

import { afterEach, expect, test } from 'bun:test'
import * as repo from '../src/db/repo.ts'
import { appShareSource, buildLiveSnapshot, type LiveInput } from '../src/share/snapshot.ts'
import type { App } from '../src/main.ts'
import { liveApp, openSession } from './live_share_helpers.ts'

let app: App | null = null
afterEach(async () => { if (app) await app.close(); app = null })

const MARK = 'HARMLESS-' + 'TOOL-MARK-' + '42'
const BEARER = 'synthbearer' + 'Q'.repeat(20)
const SECRET = 'SYNTH-DOTENV-' + 'Z'.repeat(12)
const LONG_MARK = 'LONG-HARMLESS-' + 'OUT'

const call = (id: string, command: string) => ({ part_kind: 'tool-call', tool_name: 'bash', tool_call_id: id, args: { command, wait_s: 30 } })
const ret = (id: string, content: Record<string, unknown>) => ({ part_kind: 'tool-return', tool_name: 'bash', tool_call_id: id, content })

test('while it works: outcomes without output, the cut sensitive call and its polling withheld; once done: the sanitized preview', async () => {
  app = await liveApp()
  const session = await openSession(app)
  const conn = app.state.conn
  const run = repo.insertRun(conn, {
    session_id: session.id, project_id: session.project_id, workspace_id: session.workspace_id, model: 'scripted:a', model_config: {}, user_text: 'check things', status: 'running',
    budget: {}, resumes_run_id: null, attachments: [] as never, spawned_by: 'human', relay_id: null, relay_step: null,
  })
  const harmless = `echo "Authorization: Bearer ${BEARER}"; echo ${MARK}`
  const sensitive = 'echo ' + 'a'.repeat(300) + ' && cat .env'            // the sensitive part past the event's cut
  const longSafe = 'echo ' + 'b'.repeat(320) + ` && echo ${LONG_MARK}`      // long, and harmless as a whole
  const events: [string, Record<string, unknown>][] = [
    ['tool_call', { tool: 'bash', tool_call_id: 'tc_ok', command: harmless, summary: '' }],
    ['tool_result', { tool: 'bash', tool_call_id: 'tc_ok', status: 'ok', execution_id: 'x_00000000000a', exit_code: 0, duration_ms: 12, command: harmless }],
    ['tool_call', { tool: 'bash', tool_call_id: 'tc_env', command: sensitive.slice(0, 300), summary: '' }],
    ['tool_result', { tool: 'bash', tool_call_id: 'tc_env', status: 'ok', execution_id: 'x_00000000000b', exit_code: 0, command: sensitive.slice(0, 200) }],
    ['tool_call', { tool: 'bash', tool_call_id: 'tc_long', command: longSafe.slice(0, 300), summary: '' }],
    ['tool_result', { tool: 'bash', tool_call_id: 'tc_long', status: 'ok', execution_id: 'x_00000000000c', exit_code: 0, command: longSafe.slice(0, 200) }],
    ['tool_call', { tool: 'bash_output', tool_call_id: 'tc_poll', execution_id: 'x_00000000000b', summary: '' }],
    ['tool_result', { tool: 'bash_output', tool_call_id: 'tc_poll', status: 'ok', execution_id: 'x_00000000000b', summary: 'read' }],
  ]
  let seq = 0
  for (const [event, data] of events) repo.insertEvent(conn, run.id, ++seq, event, data)
  // the record as the runner writes it while the run works (on_history → persistProgress): calls and their returns
  const history = [
    { kind: 'request', parts: [{ part_kind: 'user-prompt', content: 'check things', origin: 'person' }] },
    { kind: 'response', parts: [call('tc_ok', harmless), call('tc_env', sensitive), call('tc_long', longSafe)], timestamp: new Date().toISOString() },
    { kind: 'request', parts: [
      ret('tc_ok', { status: 'ok', execution_id: 'x_00000000000a', exit_code: 0, stdout: `Authorization: Bearer ${BEARER}\n${MARK}\n`, command: harmless }),
      ret('tc_env', { status: 'ok', execution_id: 'x_00000000000b', exit_code: 0, stdout: `SYNTH=${SECRET}\n`, command: sensitive }),
      ret('tc_long', { status: 'ok', execution_id: 'x_00000000000c', exit_code: 0, stdout: `${LONG_MARK}\n`, command: longSafe }),
    ] },
    { kind: 'response', parts: [{ part_kind: 'tool-call', tool_name: 'bash_output', tool_call_id: 'tc_poll', args: { execution_id: 'x_00000000000b' } }], timestamp: new Date().toISOString() },
    { kind: 'request', parts: [{ part_kind: 'tool-return', tool_name: 'bash_output', tool_call_id: 'tc_poll', content: { status: 'ok', execution_id: 'x_00000000000b', stdout: `SYNTH=${SECRET}\n` } }] },
  ]
  repo.saveRunProgress(conn, run.id, JSON.stringify(history), {}, seq)
  const options = { include_tool_details: true, include_images: false, exclude_run_ids: [] }
  const image = () => ({ omitted: 'unsupported' as const })
  const toolsOf = (s: ReturnType<typeof buildLiveSnapshot>) => s.snapshot.items.filter((i) => i.kind === 'tool')

  // while it works: from its events alone
  const working = buildLiveSnapshot(appShareSource(app.state), session.id, options, { runs: new Map([[run.id, { run_id: run.id, status: 'running', bound_seq: seq, open_text: null }]]), image })
  const w = toolsOf(working)
  expect(working.snapshot.runs[0]!.status).toBe('running')
  expect(w.map((t) => t.kind === 'tool' && [t.name, t.withheld])).toEqual([['bash', null], ['bash', 'sensitive_source'], ['bash', 'sensitive_source'], ['bash_output', 'sensitive_source']])
  const done = w[0]!
  expect(done.kind === 'tool' && done.status).toBe('ok')
  expect(done.kind === 'tool' && done.details?.fields.some((f) => f.name === 'exit_code' && f.value === 0)).toBe(true)
  expect(done.kind === 'tool' && done.details?.preview).toBeNull()
  for (const t of w.slice(1)) expect(t.kind === 'tool' && t.details === null && t.target === null).toBe(true)
  const workingText = JSON.stringify(working.snapshot)
  for (const never of [MARK, LONG_MARK, BEARER, SECRET, '.env']) expect(workingText).not.toContain(never)

  // once it has finished: its record is read, as the offline share reads it
  repo.finishRun(conn, run.id, 'done', { history_json: JSON.stringify(history), usage: {}, error: null, receipt: {}, saved_seq: seq })
  const finished = buildLiveSnapshot(appShareSource(app.state), session.id, options, { runs: new Map(), image })
  const f = toolsOf(finished)
  expect(finished.snapshot.runs[0]!.status).toBe('done')
  expect(f.map((t) => t.kind === 'tool' && [t.name, t.withheld])).toEqual([['bash', null], ['bash', 'sensitive_source'], ['bash', null], ['bash_output', 'sensitive_source']])
  expect(f[0]!.kind === 'tool' && f[0]!.details?.preview?.includes(MARK)).toBe(true)
  expect(f[2]!.kind === 'tool' && f[2]!.details?.preview?.includes(LONG_MARK)).toBe(true)
  for (const t of [f[1]!, f[3]!]) expect(t.kind === 'tool' && t.details === null && t.target === null).toBe(true)
  const finishedText = JSON.stringify(finished.snapshot)
  for (const never of [BEARER, SECRET, '.env']) expect(finishedText).not.toContain(never)
})
