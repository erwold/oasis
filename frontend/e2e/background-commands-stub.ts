/** A stand-in backend for background-commands.e2e.ts: plain HTTP/1.1 (node:http), the built UI, and one session of a
 *  folder edited in place whose earlier run left a command running in the background — no model, no data directory,
 *  no network. Every answer is parsed by the contract's own schemas. The test drives it: a message sent starts a run
 *  (held running until `finishRun`), the background command writes output on each read and ends on `endCommand` (or
 *  Stop). It counts every request, so the test can tell how often the page reads a command's output. */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import type { Socket } from 'node:net'
import {
  BackgroundCommandSchema, OutputWindowSchema, ProjectSchema, SessionAccessSchema, ReceiptSchema, RunDiffResponseSchema, RunSchema, SessionDetailSchema, SessionSchema,
  SESSION_STREAM_READY, ContextReportSchema, WorkspaceSchema, WorkspaceDetailSchema, DiffResponseSchema, type BackgroundCommand,
} from '@oasis-code/contract'

const NOW = '2026-10-23T00:00:00.000Z'
export const BG_SESSION = 's_bg'
export const BG_COMMAND = 'x_watch'
export const REMOTE_COMMAND = 'x_remote'
export const OVERLAP_RUN = 'run_overlap'
/** a finished run whose changes cannot be told apart (attribution unavailable): never shown as "no change" */
export const UNATTRIBUTED_RUN = 'run_unattributed'
const PROJECT = 'p_bg'
const WORKSPACE = 'w_bg'
const MODEL = 'scripted:a'

const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.ico': 'image/x-icon' }

export interface BgStub {
  server: Server
  requests: { method: string; path: string; at: number; status?: number }[]
  /** the session's background commands as the session detail names them */
  background: BackgroundCommand[]
  /** a run of the thread ends (its run_finished on the session stream, its status in the detail) */
  finishRun: (runId: string) => void
  /** the background command ends on its own */
  endCommand: (executionId: string) => void
  /** the runs the composer started */
  started: string[]
  close: () => Promise<void>
}

const receipt = (runId: string, files: string[], diff: Record<string, unknown>) => ReceiptSchema.parse({
  run_id: runId, status: 'done', final_text: 'done', finished_at: NOW,
  produced: { workspace_id: WORKSPACE, files_changed: files },
  mechanical: { requests: 1, tool_calls: files.length + 1, usage: { input_tokens: 1200, output_tokens: 80 }, diff: { in_place: true, files: files.length, added: 3 * files.length, removed: files.length, ...diff } },
})

export async function startBgStub(port: number, dist: string): Promise<BgStub> {
  const requests: (BgStub['requests'][number] & { res?: ServerResponse })[] = []
  const started: string[] = []
  const workspace = WorkspaceSchema.parse({ id: WORKSPACE, project_id: PROJECT, session_id: BG_SESSION, path: '/nowhere/app', branch: '', base_commit: '', kind: 'direct', created_at: NOW })
  const session = SessionSchema.parse({ id: BG_SESSION, project_id: PROJECT, title: 'Train beside a watcher', workspace_id: WORKSPACE, model: MODEL, created_at: NOW, updated_at: NOW })
  const project = { ...ProjectSchema.parse({ id: PROJECT, name: 'app', kind: 'direct', source_path: '/nowhere/app', base_repo_path: '/nowhere/app', base_commit: null, base_branch: null, created_at: NOW, updated_at: NOW }), sessions: [session] }
  const run = (id: string, text: string, status: string, rec: Record<string, unknown> = {}, at = new Date().toISOString()) =>
    RunSchema.parse({ id, session_id: BG_SESSION, project_id: PROJECT, workspace_id: WORKSPACE, model: MODEL, user_text: text, status, created_at: at, receipt: rec, usage: { input_tokens: 1200, output_tokens: 80 } })
  // the fixture's runs in a fixed order (each its own time); a run the composer starts comes after them
  const at = (minute: number) => `2026-10-23T00:0${minute}:00.000Z`
  const runs = [
    run('run_old', 'start the watcher in the background', 'done', receipt('run_old', [], { attribution: 'exact' }), at(0)),
    // its receipt's counts are 0 on purpose: the page must not show them as "no change"
    run(UNATTRIBUTED_RUN, 'regenerate the snapshot fixtures', 'done', receipt(UNATTRIBUTED_RUN, [], { attribution: 'unavailable', background_execution_ids: [BG_COMMAND] }), at(1)),
    run(OVERLAP_RUN, 'fix src/a.ts while it watches', 'done', receipt(OVERLAP_RUN, ['src/a.ts', 'src/b.ts'], { attribution: 'partial', unattributed_paths: ['src/gap.ts'], background_execution_ids: [BG_COMMAND] }), at(2)),
  ]
  const background: BackgroundCommand[] = [
    BackgroundCommandSchema.parse({ execution_id: BG_COMMAND, run_id: 'run_old', workspace_id: WORKSPACE, command: 'npm run watch -- --poll', status: 'running', conversation_id: 'conv_main' }),
    // a remote writer whose end is not known yet (its run unknown)
    BackgroundCommandSchema.parse({ execution_id: REMOTE_COMMAND, run_id: null, workspace_id: WORKSPACE, command: 'python train.py --epochs 50', status: 'unknown', conversation_id: null }),
  ]
  const transcripts: Record<string, unknown[]> = {
    run_old: [{ kind: 'activity', tool: 'bash', toolCallId: 'c_old', summary: 'npm run watch -- --poll &', result: { execution_id: BG_COMMAND, status: 'running' } }, { kind: 'agent', text: 'The watcher runs in the background.' }],
    [UNATTRIBUTED_RUN]: [{ kind: 'activity', tool: 'bash', toolCallId: 'c_gen', summary: 'npm run fixtures', result: { status: 'done' } }, { kind: 'agent', text: 'Regenerated the fixtures while the watcher ran.' }],
    [OVERLAP_RUN]: [{ kind: 'activity', tool: 'edit_file', toolCallId: 'c_a', summary: 'src/a.ts', result: {} }, { kind: 'activity', tool: 'edit_file', toolCallId: 'c_b', summary: 'src/b.ts', result: {} }, { kind: 'agent', text: 'Fixed src/a.ts and src/b.ts while the watcher ran.' }],
  }
  let outputReads = 0
  let cursor = 0
  /** each run's events as the session stream sent them (its history page reads them again) */
  const events: Record<string, { seq: number; event: string; data: Record<string, unknown> }[]> = {}
  const streams = new Set<ServerResponse>()
  const push = (runId: string, event: string, data: Record<string, unknown>) => {
    const list = (events[runId] ??= [])
    const seq = list.length
    list.push({ seq, event, data })
    cursor += 1
    const frame = `event: ${event}\nid: ${cursor}\ndata: ${JSON.stringify({ run_id: runId, seq, data })}\n\n`
    for (const res of streams) res.write(frame)
  }
  const detail = () => SessionDetailSchema.parse({
    ...session, workspace, runs, director_notes: [], director: null, active_run: null, relays: [], interactions: [], watches: [], wake_events: [],
    active_children: [], run_count: runs.length, pending_approvals: [], event_cursor: cursor, background_commands: background,
  })
  const send = (res: ServerResponse, status: number, body: unknown) => { const asked = requests.findLast((r) => r.res === res); if (asked) asked.status = status; res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)) }
  const body = (req: IncomingMessage) => new Promise<Record<string, unknown>>((resolve) => { let raw = ''; req.on('data', (c) => { raw += String(c) }); req.on('end', () => { try { resolve(JSON.parse(raw || '{}')) } catch { resolve({}) } }) })

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
    const path = url.pathname
    requests.push({ method: req.method ?? 'GET', path, at: Date.now(), res })
    if (!path.startsWith('/api/')) {
      const file = normalize(join(dist, path === '/' ? 'index.html' : path))
      const target = file.startsWith(dist) && existsSync(file) && statSync(file).isFile() ? file : join(dist, 'index.html')
      res.writeHead(200, { 'content-type': TYPES[extname(target)] ?? 'application/octet-stream' })
      res.end(readFileSync(target))
      return
    }
    if (path === '/api/meta/build') return send(res, 200, { package_version: '0', source_fingerprint: 'stub', api_version: 'code-v1', schema_version: 26, ui_build: null })
    if (path === '/api/models') return send(res, 200, { models: [{ id: MODEL, label: 'Scripted', provider: 'test', available: true }], default: MODEL })
    if (path === '/api/projects') return send(res, 200, [project])
    if (path === `/api/sessions/${BG_SESSION}`) return send(res, 200, detail())
    // what the page reads beside the session as it opens it (a 404 here would be a toast over the page's own notices);
    // each answer carries the same detail, background commands included
    const control = { desired_state: 'run', gate_effects: [] }
    if (path === `/api/sessions/${BG_SESSION}/mode`) return send(res, 200, { mode: 'auto', session: detail(), control })
    if (path === `/api/sessions/${BG_SESSION}/access`) return send(res, 200, SessionAccessSchema.parse({ access_mode: 'full', switchable: true, blocked_by: { runs: 0, executions: 0, approvals: 0 }, session: detail() }))
    if (path === `/api/sessions/${BG_SESSION}/agent-control`) return send(res, 200, { control, effect_tags: [], gateable_tools: [] })
    if (path === `/api/sessions/${BG_SESSION}/action-proposals`) return send(res, 200, { proposals: [] })
    if (path === '/api/ssh/targets' || path === '/api/ssh/asks') return send(res, 200, [])
    if (path === `/api/workspaces/${WORKSPACE}`) return send(res, 200, WorkspaceDetailSchema.parse({ ...workspace, status: { modified: [], added: [], deleted: [], untracked: [], renamed: [], external_changes: [] }, lock_owner: null, latest_snapshot: null, checkpoints: [], executions: [], checks: [] }))
    if (path === `/api/workspaces/${WORKSPACE}/diff`) return send(res, 200, DiffResponseSchema.parse({ base_commit: '', tree_sha: '', snapshot_id: null, patch: '', files: [], external_changes: [], review_flags: [] }))
    // the composer's context ring reads what the next request carries: a small valid report (a 404 here is a card of
    // its own over the composer)
    if (path === `/api/sessions/${BG_SESSION}/context`) return send(res, 200, ContextReportSchema.parse({
      schema_version: '1', session_id: BG_SESSION, model_id: MODEL, total_bytes: 4800, total_tokens: 1200, tokenizer: null, tokens_basis: 'estimate',
      context_window: 200000, context_window_source: 'stub', budget_tokens: 160000, budget_source: 'stub', budget_note: '', bytes_basis: 'utf8',
      tokens_est: 1200, estimate_basis: 'stub', segments: [], per_message: [], tools: [],
      history: { messages: 6, raw_bytes: 4800, content_bytes: 4800, wire_bytes: 4800, wire_tokens: null, compactions: 0, tool_returns: 3, model_turns: 3, user_turns: 3, bytes_basis: 'utf8' },
      last_run: null,
    }))
    if (path === `/api/sessions/${BG_SESSION}/runs/tree`) return send(res, 200, { session_id: BG_SESSION, runs: [] })
    if (path === `/api/sessions/${BG_SESSION}/events`) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      const live = runs.filter((r) => r.status === 'running').map((r) => r.id)
      res.write(`event: ${SESSION_STREAM_READY}\nid: ${cursor}\ndata: ${JSON.stringify({ cursor, live_runs: live })}\n\n`)
      streams.add(res)
      req.on('close', () => streams.delete(res))
      return
    }
    if (path === `/api/sessions/${BG_SESSION}/chat` && req.method === 'POST') {
      void body(req).then((b) => {
        // the same conversation's next run starts beside the background command: never queued behind it
        const id = `run_new_${started.length + 1}`
        const made = run(id, String(b.text ?? ''), 'running')
        runs.push(made)
        started.push(id)
        transcripts[id] = []
        send(res, 200, made)
        setTimeout(() => {
          push(id, 'run_started', { model: MODEL })
          push(id, 'text_block', { text: 'Working beside the watcher.' })
        }, 50)
      })
      return
    }
    const exec = /^\/api\/executions\/([^/]+)\/(output|stop)$/.exec(path)
    if (exec) {
      const id = decodeURIComponent(exec[1]!)
      if (exec[2] === 'stop' && req.method === 'POST') {
        const at = background.findIndex((c) => c.execution_id === id)
        if (at >= 0) background.splice(at, 1)
        return send(res, 200, { stopped: at >= 0 })
      }
      outputReads += 1
      const stream = url.searchParams.get('stream') ?? 'stdout'
      const running = background.some((c) => c.execution_id === id)
      const lines = Array.from({ length: Math.min(40, 3 + outputReads) }, (_, i) => `[watch] rebuilt in ${20 + i} ms (change ${i + 1})`)
      const text = stream === 'stdout' ? `${lines.join('\n')}\n` : ''
      const offset = Number(url.searchParams.get('offset') ?? 0)
      const slice = text.slice(offset)
      return send(res, 200, OutputWindowSchema.parse({ execution_id: id, stream, offset, returned_bytes: slice.length, total_bytes: text.length, next_offset: offset + slice.length, eof: true, running, status: running ? 'running' : 'done', exit_code: running ? null : 0, truncated_at_cap: false, text: slice }))
    }
    const page = /^\/api\/runs\/([^/]+)\/events\/page$/.exec(path)
    if (page) {
      const after = Number(url.searchParams.get('after') ?? -1)
      return send(res, 200, { run_id: page[1], session_id: BG_SESSION, events: (events[page[1]!] ?? []).filter((e) => e.seq > after) })
    }
    const one = /^\/api\/runs\/([^/]+)(\/[a-z]+)?$/.exec(path)
    if (one) {
      const found = runs.find((r) => r.id === one[1])
      if (!found) return send(res, 404, { detail: 'no such run' })
      if (!one[2]) return send(res, 200, { ...found, live: found.status === 'running', depth: 0, requests: [], executions: [], children: [] })
      if (one[2] === '/transcript') return send(res, 200, { run_id: found.id, status: found.status, model: found.model, entries: transcripts[found.id] ?? [], steers: [] })
      if (one[2] === '/diff') {
        // no reliable baseline: the harness refuses the run's diff rather than claim nothing changed
        if (found.id === UNATTRIBUTED_RUN) return send(res, 409, { detail: "this run's changes cannot be told apart", code: 'attribution_unavailable', background_execution_ids: [BG_COMMAND] })
        const files = found.id === OVERLAP_RUN ? [{ path: 'src/a.ts', added: 4, removed: 1 }, { path: 'src/b.ts', added: 2, removed: 1 }] : []
        const patch = files.map((f) => `diff --git a/${f.path} b/${f.path}\n--- a/${f.path}\n+++ b/${f.path}\n@@ -1,1 +1,1 @@\n-old\n+new\n`).join('')
        return send(res, 200, RunDiffResponseSchema.parse({ run_id: found.id, base_commit: '', tree_sha: '', files, patch, in_place: true,
          ...(found.id === OVERLAP_RUN ? { attribution: 'partial', unattributed_paths: ['src/gap.ts'], background_execution_ids: [BG_COMMAND] } : { attribution: 'exact' }) }))
      }
      if (one[2] === '/undo') return send(res, 409, { detail: 'the stub never undoes' })
    }
    return send(res, 404, { detail: `the stub does not serve ${path}` })
  })
  server.keepAliveTimeout = 60_000
  const sockets = new Set<Socket>()
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
  return {
    server, requests, background, started,
    finishRun: (runId) => {
      const at = runs.findIndex((r) => r.id === runId)
      if (at < 0) return
      const rec = receipt(runId, [], { attribution: 'partial', background_execution_ids: [BG_COMMAND] })
      runs[at] = { ...runs[at]!, status: 'done', receipt: rec, finished_at: NOW }
      transcripts[runId] = [{ kind: 'agent', text: 'Working beside the watcher.' }]
      push(runId, 'run_finished', { status: 'done', receipt: rec })
    },
    endCommand: (executionId) => {
      const at = background.findIndex((c) => c.execution_id === executionId)
      if (at >= 0) background.splice(at, 1)
    },
    close: () => new Promise<void>((resolve) => { for (const s of streams) s.end(); for (const s of sockets) s.destroy(); server.close(() => resolve()) }),
  }
}
