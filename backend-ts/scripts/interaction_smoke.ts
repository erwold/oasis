/** A short smoke of the interaction on real routes: two participants on ONE model (their letters tell them apart) and
 *  a director on a route of the catalogue, one tiny request that needs no tool. The director reads the request and
 *  the roster, calls schedule; the harness runs the plan; the director is asked once more at the end when its plan
 *  says so. The sign-ins and keys are the person's own (~/.oasis-code, or OASIS_CODE_AUTH_DIR); the data directory is
 *  a fresh one under the temp dir, so nothing lands in their projects. Every model call here is a paid (or
 *  subscription) request: run it on purpose.
 *
 *      bun run scripts/interaction_smoke.ts [participantModel] [directorModel] [independent]
 *      (default: anthropic:claude-opus-5-5 for both; `independent` runs the fixed template, no director)
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentMentionToken, type InteractionDetail } from '@oasis-code/contract'
import { defaultAuthDir, setDefaultAuthDir } from '../src/auth/store.ts'
import { getSettings, Settings } from '../src/config.ts'
import * as repo from '../src/db/repo.ts'
import * as dstore from '../src/director/store.ts'
import { createApp } from '../src/main.ts'
import { git } from '../tests/harness.ts'

const MODEL = process.argv[2] ?? 'anthropic:claude-opus-5-5'
const DIRECTOR = process.argv[3] ?? 'anthropic:claude-opus-5-5'
const INDEPENDENT = process.argv[4] === 'independent'

async function main(): Promise<void> {
  const authDir = defaultAuthDir()
  const config = getSettings().load()
  const root = mkdtempSync(join(tmpdir(), 'oasis-interaction-smoke-'))
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
    writeFileSync(join(src, 'README.md'), '# interaction smoke\n')
    git(['add', '-A'], src)
    git(['commit', '-q', '-m', 'init'], src)
    const project = await state.workspaces.importProject('interaction smoke', src)
    const created = repo.createSession(state.conn, project.id, 'interaction smoke', MODEL)
    const ws = await state.workspaces.createWorkspace(project, created.id)
    repo.setSessionWorkspace(state.conn, created.id, ws.id)
    const session = repo.getSession(state.conn, created.id)!
    const label = config.models.find((m) => m.id === MODEL)?.label ?? MODEL
    const A = agentMentionToken(label, MODEL, 'A')
    const B = agentMentionToken(label, MODEL, 'B')
    const text = INDEPENDENT
      ? `${A} and ${B}: each of you, alone, reply with exactly one word — your own letter (A or B) — and nothing else; call no tool.`
      : `${A} and ${B}: first each of you, independently, replies with exactly one word — your own letter (A or B); call no tool. Then ${A} reads ${B}'s answer and replies with the two letters it now knows, e.g. "A B", and nothing else. Stop there; I decide.`
    const participants = state.interactions.plan([{ model: MODEL, id: 'A', label }, { model: MODEL, id: 'B', label }], [])
    console.log(`participants: ${participants.map((p) => `${p.id}=${p.label} [${p.model}]`).join(', ')}${INDEPENDENT ? '' : `; director ${DIRECTOR}`}`)
    const t0 = Date.now()
    const detail = await state.interactions.start(session, {
      text, participants, plan: INDEPENDENT ? { template: 'independent' } : null, director_model: DIRECTOR, mentions: [], attachments: [], thinking: null,
      budget: { requests: 2, tool_calls: 1 }, max_runs: 4, concurrency: 2, client_request_id: null,
    })
    console.log(`interaction ${detail.id}: ${detail.status} (controller ${detail.controller})`)
    let last = ''
    for (;;) {
      const now = state.interactions.detail(repo.getInteraction(state.conn, detail.id)!)
      const line = `${now.status} · nodes ${now.nodes.map((n) => `${n.id}:${n.status}`).join(' ') || '(none yet)'}`
      if (line !== last) { console.log(`  ${((Date.now() - t0) / 1000).toFixed(1)}s ${line}`); last = line }
      if (!['planning', 'running', 'deciding'].includes(now.status)) break
      if (Date.now() - t0 > 600_000) { console.log('timed out after 600 s; stopping'); state.interactions.cancel(detail.id); break }
      await new Promise((r) => setTimeout(r, 500))
    }
    for (const n of state.interactions.detail(repo.getInteraction(state.conn, detail.id)!).nodes) {
      const handle = n.run_id ? state.runs.handles.get(n.run_id) : undefined
      if (handle && !handle.done) await handle.task
    }
    // the director's turn may still be answering after the plan ran (a tiny plan ends before its planner's words do)
    if (detail.director_session_id) {
      const until = Date.now() + 180_000
      while (Date.now() < until && dstore.activeTurns(state.conn, detail.director_session_id).length) await new Promise((r) => setTimeout(r, 500))
    }
    const done: InteractionDetail = state.interactions.detail(repo.getInteraction(state.conn, detail.id)!)
    console.log(`interaction ${done.id}: ${done.status}${done.reason ? ` (${done.reason})` : ''} after ${((Date.now() - t0) / 1000).toFixed(1)} s; revision ${done.revision}, then ${done.then}, runs ${done.runs_started} of ${done.budget.max_runs}`)
    for (const n of done.nodes) {
      const run = n.run_id ? repo.getRun(state.conn, n.run_id) : null
      console.log(`- step ${n.id} (${n.participant}) after [${n.depends_on.join(', ')}] reads [${n.receives.join(', ')}] on ${n.workspace}: ${n.status}${n.instruction ? ` · "${n.instruction}"` : ''}`)
      if (run) {
        const usage = run.usage as Record<string, unknown>
        const said = String((run.receipt as { final_text?: unknown }).final_text ?? '').replace(/\s+/g, ' ').trim()
        console.log(`  run ${run.id} ${run.model}: ${run.status}${run.error ? ` (${run.error})` : ''}; requests ${usage.requests ?? '?'}, tokens in ${usage.input_tokens ?? '?'} / out ${usage.output_tokens ?? '?'}, cache read ${usage.cache_read_tokens ?? '?'}, workspace ${run.workspace_id}, continues ${run.resumes_run_id ?? 'nothing'}`)
        console.log(`  said: ${said.slice(0, 300)}${said.length > 300 ? '…' : ''}`)
      }
    }
    if (done.director_session_id) {
      for (const turn of dstore.listTurns(state.conn, done.director_session_id)) {
        const usage = turn.usage as Record<string, unknown>
        console.log(`- director turn ${turn.kind} ${turn.status}: tools ${turn.tool_calls.map((t) => `${t.name}:${t.status}`).join(', ') || 'none'}; requests ${usage.requests ?? '?'}, tokens in ${usage.input_tokens ?? '?'} / out ${usage.output_tokens ?? '?'}`)
        console.log(`  asked: ${turn.input.replace(/\s+/g, ' ').slice(0, 160)}…`)
        console.log(`  said: ${turn.output.replace(/\s+/g, ' ').slice(0, 400)}${turn.output.length > 400 ? '…' : ''}`)
      }
    }
    console.log(`events: ${done.events.map((e) => e.kind).join(' → ')}`)
    console.log(`records: ${settings.data_dir}`)
  } finally {
    await built.close()
  }
}

await main()
