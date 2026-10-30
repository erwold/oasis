/** A short smoke of the relay on real routes: two agents of the catalogue take turns on one tiny request that needs
 *  no tool, under a tight budget (two requests, one tool call per turn). The sign-ins and keys are the person's own
 *  (~/.oasis-code, or OASIS_CODE_AUTH_DIR); the data directory is a fresh one under the temp dir, so nothing lands in
 *  their projects. Every model call here is a paid (or subscription) request: run it on purpose.
 *
 *      bun run scripts/relay_smoke.ts [modelA] [modelB]      (default: anthropic:claude-opus-5-5 openai:gpt-6-astra)
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultAuthDir, setDefaultAuthDir } from '../src/auth/store.ts'
import { getSettings, Settings } from '../src/config.ts'
import * as repo from '../src/db/repo.ts'
import { createApp } from '../src/main.ts'
import { git } from '../tests/harness.ts'

const A = process.argv[2] ?? 'anthropic:claude-opus-5-5'
const B = process.argv[3] ?? 'openai:gpt-6-astra'
const TEXT = 'Relay smoke test. Executor: reply with exactly the single word PONG and nothing else; call no tool. '
  + 'Reviewer: in one short sentence, say whether the executor complied; call no tool.'

async function main(): Promise<void> {
  const authDir = defaultAuthDir()
  const config = getSettings().load()
  const root = mkdtempSync(join(tmpdir(), 'oasis-relay-smoke-'))
  const settings = new Settings({ data_dir: join(root, 'data'), host: '127.0.0.1', port: 0, session_token: 'smoke' })
  const built = await createApp(settings, config, { probe: false })
  // the credentials stay where they are (a token refresh writes back there); only the records go to the temp dir
  setDefaultAuthDir(authDir)
  await built.start()
  const { state } = built
  try {
    const src = join(root, 'repo')
    mkdirSync(src)
    git(['init', '-q', '-b', 'main'], src)
    writeFileSync(join(src, 'README.md'), '# relay smoke\n')
    git(['add', '-A'], src)
    git(['commit', '-q', '-m', 'init'], src)
    const project = await state.workspaces.importProject('relay smoke', src)
    const created = repo.createSession(state.conn, project.id, 'relay smoke', A)
    const ws = await state.workspaces.createWorkspace(project, created.id)
    repo.setSessionWorkspace(state.conn, created.id, ws.id)
    const session = repo.getSession(state.conn, created.id)!
    const plan = state.relays.plan([{ model: A }, { model: B }], 1, [])
    console.log(`participants: ${plan.participants.map((p) => `${p.label} [${p.model}] ${p.role}`).join(' → ')}`)
    const t0 = Date.now()
    const { relay } = await state.relays.start(session, { text: TEXT, plan, mentions: [], attachments: [], thinking: null, budget: { requests: 2, tool_calls: 1 }, client_request_id: null })
    for (;;) {
      const now = repo.getRelay(state.conn, relay.id)!
      if (!['running'].includes(now.status)) break
      if (Date.now() - t0 > 240_000) { console.log('timed out after 240 s; stopping'); state.relays.cancel(relay.id); break }
      await new Promise((r) => setTimeout(r, 500))
    }
    for (const step of repo.getRelay(state.conn, relay.id)!.steps) {
      if (!step.run_id) { console.log(`turn ${step.seq + 1}: never started`); continue }
      const handle = state.runs.handles.get(step.run_id)
      if (handle && !handle.done) await handle.task
    }
    const done = repo.getRelay(state.conn, relay.id)!
    console.log(`relay ${done.id}: ${done.status}${done.reason ? ` (${done.reason})` : ''} after ${((Date.now() - t0) / 1000).toFixed(1)} s`)
    for (const run of repo.listRunsOfRelay(state.conn, relay.id)) {
      const usage = run.usage as Record<string, unknown>
      const text = String((run.receipt as { final_text?: unknown }).final_text ?? '').replace(/\s+/g, ' ').trim()
      console.log(`- turn ${(run.relay_step ?? 0) + 1} ${run.model}: ${run.status}${run.error ? ` (${run.error})` : ''}; requests ${usage.requests ?? '?'}, tokens in ${usage.input_tokens ?? '?'} / out ${usage.output_tokens ?? '?'}, tool calls ${usage.tool_calls ?? 0}`)
      console.log(`  said: ${text.slice(0, 300)}${text.length > 300 ? '…' : ''}`)
      console.log(`  asked: ${run.user_text.replace(/\s+/g, ' ').slice(0, 160)}…`)
    }
    console.log(`records: ${settings.data_dir}`)
  } finally {
    await built.close()
  }
}

await main()
