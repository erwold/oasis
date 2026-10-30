/** A backend that dies by SIGKILL inside a file-tool write in a folder edited in place (test_direct_recovery): the
 *  run's first write completes; its second is kept in the journal exactly as writeText keeps it (the file as it is,
 *  what the write means to leave), its bytes land or not (`written`), and the process is killed before the write is
 *  marked. Parameters come from JOURNAL_CRASH (JSON): { data_dir, folder, target, written, agent_text, out }; the ids
 *  of what it made are written to `out`. */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Settings } from '../src/config.ts'
import * as repo from '../src/db/repo.ts'
import { modelResponse, toolCallPart } from '../src/llm/messages.ts'
import { ScriptedModel } from '../src/llm/scripted.ts'
import { createApp } from '../src/main.ts'
import { testConfig } from './harness.ts'

const p = JSON.parse(process.env.JOURNAL_CRASH ?? '{}') as { data_dir: string; folder: string; target: string; written: boolean; agent_text: string; out: string }
const settings = new Settings({ data_dir: p.data_dir, host: '127.0.0.1', port: 0, session_token: 'test-token' })
const app = await createApp(settings, testConfig(), { probe: false })
await app.start()
const headers = { 'x-oasis-code-token': 'test-token', origin: 'http://localhost', 'content-type': 'application/json' }
const post = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
  const response = await app.app.request(`http://localhost${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
  const text = await response.text()
  if (response.status !== 200) throw new Error(`${path}: ${response.status} ${text}`)
  return JSON.parse(text) as Record<string, unknown>
}
const project = await post('/api/projects', { source_path: p.folder, mode: 'direct' })
const session = await post(`/api/projects/${project.id}/sessions`, { title: 'stopped' })
const workspaceId = (session.workspace as { id: string }).id
let step = 0
app.state.model_overrides.set('scripted:a', new ScriptedModel(async () => {
  step += 1
  if (step === 1) return modelResponse([toolCallPart('write_file', { path: 'made_by_run.txt', content: 'first write, completed\n' }, 'w1')])
  const runId = [...app.state.runs.handles.keys()][0]!
  const real = join(p.folder, p.target)
  const before = existsSync(real) ? readFileSync(real) : null
  const entry = app.state.workspaces.journal.prepare(repo.getWorkspace(app.state.conn, workspaceId)!, {
    session_id: session.id as string, run_id: runId, tool_call_id: 'w2', path: p.target, action: before === null ? 'created' : 'overwritten', before,
    intended: Buffer.from(p.agent_text),
  })
  if (p.written) writeFileSync(real, p.agent_text)
  writeFileSync(p.out, JSON.stringify({ workspace_id: workspaceId, run_id: runId, entry_id: entry.id }))
  process.kill(process.pid, 'SIGKILL')
  return new Promise(() => {})
}))
await post(`/api/sessions/${session.id}/chat`, { text: 'write two files' })
await new Promise(() => {})
