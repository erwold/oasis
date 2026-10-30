/** A stand-in backend for friction-ui.e2e.ts: plain HTTP on a loopback port the OS picks, the built UI, and the few
 *  answers the page reads for the 2026-10-16 friction cleanup — no model, no data directory, no network, no provider.
 *  Its shapes are the contract's own schemas, with the fields the task/locking/execution workers add read loosely
 *  (schema v29 `task_root_id` and `roots`, a run's `waiting`, a command's `requested_access` / `effective_access` /
 *  `access_reasons`), as the task worker's API contract (relayed by the director, 2026-10-16) names them.
 *
 *  - two projects: `app` holds the task's first session (s_root) and s_cmd; `docs` holds s_docs, joined to s_root's task
 *  - s_root: a run waiting for the folder's writer (queued, `waiting`, its stream says run_queued), one further folder
 *    (read)
 *  - s_groups: two groups running (no run of the thread)
 *  - s_cmd: one finished run whose command ran narrower than asked (full asked, sandbox ran) */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import type { AddressInfo, Socket } from 'node:net'
import { InteractionDetailSchema, ProjectSchema, RunSchema, SessionDetailSchema, SessionSchema, WorkspaceSchema } from '@oasis-code/contract'

const NOW = '2026-10-16T08:00:00.000Z'
const at = (min: number) => new Date(Date.parse(NOW) + min * 60_000).toISOString()
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.ico': 'image/x-icon' }

export const IDS = {
  root: 's_root', docs: 's_docs', cmd: 's_cmd', groups: 's_groups', projectApp: 'p_app', projectDocs: 'p_docs',
  queuedRun: 'run_queued_1', writerRun: 'run_writer_1', cmdRun: 'run_cmd_1', groupA: 'ix_a', groupB: 'ix_b',
} as const

export interface Recorded { method: string; path: string; body: unknown }
export interface FrictionStub {
  server: Server
  port: number
  /** every request the page made, in order (the body parsed when JSON) */
  requests: Recorded[]
  /** the second group stopped (the page reads it on its next session read) */
  stopGroupB: () => void
  close: () => Promise<void>
}

export async function startFrictionStub(dist: string): Promise<FrictionStub> {
  const requests: Recorded[] = []
  let groupBStatus: 'running' | 'cancelled' = 'running'
  const roots: { path: string; access: 'read' | 'write'; created_at: string }[] = [{ path: '/fixture/ref', access: 'read', created_at: NOW }]

  const workspace = WorkspaceSchema.parse({ id: 'ws_app', project_id: IDS.projectApp, session_id: IDS.root, path: '/fixture/app', branch: '', base_commit: '', kind: 'direct', created_at: NOW })
  const session = (id: string, projectId: string, title: string, minute: number, extra: Record<string, unknown> = {}) => ({
    ...SessionSchema.parse({ id, project_id: projectId, title, workspace_id: projectId === IDS.projectApp ? 'ws_app' : null, model: 'scripted:a', created_at: at(minute), updated_at: at(minute), last_activity_at: at(minute) }),
    task_root_id: null as string | null, ...extra,
  })
  const sessions = () => ({
    root: session(IDS.root, IDS.projectApp, 'Fix the parser', 1, { roots: roots.map(({ path, access }) => ({ path, access })) }),
    cmd: session(IDS.cmd, IDS.projectApp, 'Build it', 0),
    groups: session(IDS.groups, IDS.projectApp, 'Two groups', 0),
    docs: session(IDS.docs, IDS.projectDocs, 'Update the parser docs', 2, { task_root_id: IDS.root }),
  })
  const project = (id: string, path: string, list: unknown[]) => ({ ...ProjectSchema.parse({ id, name: id === IDS.projectApp ? 'app' : 'docs', kind: 'direct', source_path: path, base_repo_path: path, base_commit: null, base_branch: null, created_at: NOW, updated_at: NOW }), sessions: list })
  const waiting = { reason: 'workspace_lock', workspace_id: 'ws_app', blocking_owner: IDS.writerRun, blocking_kind: 'run', blocking_run_id: IDS.writerRun, queued_since: at(3), position: 1 }
  const queuedRun = () => ({ ...RunSchema.parse({ id: IDS.queuedRun, session_id: IDS.root, project_id: IDS.projectApp, workspace_id: 'ws_app', model: 'scripted:a', user_text: 'rename the helper', status: 'queued', created_at: at(3) }), waiting })
  const cmdRun = RunSchema.parse({ id: IDS.cmdRun, session_id: IDS.cmd, project_id: IDS.projectApp, workspace_id: 'ws_app', model: 'scripted:a', user_text: 'build it', status: 'done', created_at: at(0), finished_at: at(0) })
  const group = (id: string, words: string, status: string, minute: number) => InteractionDetailSchema.parse({
    id, session_id: IDS.groups, status, user_text: words, controller: 'fixed', template: 'independent',
    participants: [{ id: 'A', label: 'Scripted A', model: 'scripted:a' }, { id: 'B', label: 'Scripted B', model: 'scripted:b' }],
    budget: { max_runs: 4, concurrency: 2 }, created_at: at(minute), updated_at: at(minute),
    nodes: [{ id: 'a1', interaction_id: id, seq: 1, participant: 'A', status: 'queued', created_at: at(minute), updated_at: at(minute) }],
  })
  const groups = () => [group(IDS.groupA, 'compare the parsers', 'running', 4), group(IDS.groupB, 'review the docs', groupBStatus, 5)]
  const detail = (id: string) => {
    const s = sessions()
    const own = id === IDS.root ? s.root : id === IDS.cmd ? s.cmd : id === IDS.groups ? s.groups : s.docs
    const runs = id === IDS.root ? [queuedRun()] : id === IDS.cmd ? [cmdRun] : []
    const parsed = SessionDetailSchema.parse({
      ...own, workspace: id === IDS.docs ? null : { ...workspace, session_id: id }, runs, director_notes: [], director: null, active_run: null,
      relays: [], interactions: id === IDS.groups ? groups() : [], watches: [], wake_events: [], active_children: [], run_count: runs.length, pending_approvals: [],
    })
    // the contract parse drops the fields it does not name yet: put them back as the harness sends them
    return { ...parsed, task_root_id: own.task_root_id, roots: id === IDS.root ? roots.map(({ path, access }) => ({ path, access })) : [], runs: id === IDS.root ? [queuedRun()] : parsed.runs,
      task_sessions: [s.root, s.docs].map((x) => ({ id: x.id, project_id: x.project_id, title: x.title, status: x.status, last_activity_at: x.last_activity_at })) }
  }
  const send = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)) }
  const readBody = (req: IncomingMessage) => new Promise<unknown>((resolve) => {
    let raw = ''
    req.on('data', (c) => { raw += String(c) })
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : null) } catch { resolve(raw) } })
  })
  const sockets = new Set<Socket>()

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname
    const method = req.method ?? 'GET'
    const body = method === 'GET' ? null : await readBody(req)
    requests.push({ method, path, body })
    if (!path.startsWith('/api/')) {
      const file = normalize(join(dist, path === '/' ? 'index.html' : path))
      const target = file.startsWith(dist) && existsSync(file) && statSync(file).isFile() ? file : join(dist, 'index.html')
      res.writeHead(200, { 'content-type': TYPES[extname(target)] ?? 'application/octet-stream' })
      res.end(readFileSync(target))
      return
    }
    if (path === '/api/meta/build') return send(res, 200, { package_version: '0', source_fingerprint: 'stub', api_version: 'code-v1', schema_version: 29, ui_build: null })
    if (path === '/api/models') return send(res, 200, { models: [{ id: 'scripted:a', label: 'Scripted', provider: 'test', available: true }], default: 'scripted:a' })
    if (path === '/api/projects') {
      const s = sessions()
      return send(res, 200, [project(IDS.projectApp, '/fixture/app', [s.root, s.cmd, s.groups]), project(IDS.projectDocs, '/fixture/docs', [s.docs])])
    }
    const one = /^\/api\/sessions\/(s_[a-z]+)(\/.*)?$/.exec(path)
    if (one && !one[2]) return send(res, 200, detail(one[1]!))
    if (one && one[2] === '/runs/tree') return send(res, 200, { session_id: one[1], runs: [] })
    const note = /^\/api\/interactions\/(ix_[a-z])\/notes$/.exec(path)
    if (note && method === 'POST') return send(res, 200, groups().find((g) => g.id === note[1]))
    if (path === `/api/runs/${IDS.queuedRun}/cancel` && method === 'POST') return send(res, 200, { cancelled: true })
    if (path === `/api/runs/${IDS.queuedRun}`) return send(res, 200, { ...queuedRun(), live: true, depth: 0, requests: [], executions: [], children: [] })
    if (path === `/api/runs/${IDS.queuedRun}/events`) {
      // the waiting run's stream: it says what holds its folder, then holds the connection open
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      res.write(`event: run_queued\nid: 0\ndata: ${JSON.stringify(waiting)}\n\n`)
      const beat = setInterval(() => res.write(': beat\n\n'), 1000)
      req.on('close', () => clearInterval(beat))
      return
    }
    if (path === `/api/runs/${IDS.cmdRun}/transcript`) {
      return send(res, 200, { run_id: IDS.cmdRun, status: 'done', model: 'scripted:a', steers: [], entries: [
        { kind: 'activity', tool: 'bash', toolCallId: 'call_1', summary: 'make', args: { command: 'make' },
          result: { status: 'succeeded', exit_code: 0, duration_ms: 12, command: 'make', requested_access: 'full', effective_access: 'sandbox',
            access_reasons: [{ code: 'network_off', detail: 'the session has no network grant', next_step: 'grant the network to run it with full access' }] } },
        { kind: 'agent', text: 'Built.' },
      ] })
    }
    if (path === '/api/workspaces/ws_app') {
      return send(res, 200, { ...workspace, status: { modified: [], added: [], deleted: [], untracked: [], renamed: [], external_changes: [] }, lock_owner: IDS.writerRun, latest_snapshot: null, checkpoints: [], executions: [], checks: [] })
    }
    if (path === '/api/workspaces/ws_app/diff') return send(res, 200, { base_commit: '', tree_sha: '', snapshot_id: null, patch: '', files: [], external_changes: [], review_flags: [], patch_cut: null })
    return send(res, 404, { detail: `the stub does not serve ${path}` })
  })
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  // port 0: a port of this test's own, never one another service holds
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(Number(process.env.OASIS_CODE_E2E_PORT || 0), '127.0.0.1', resolve) })
  const port = (server.address() as AddressInfo).port
  return {
    server, port, requests,
    stopGroupB: () => { groupBStatus = 'cancelled' },
    close: () => new Promise<void>((resolve) => { for (const s of sockets) s.destroy(); server.close(() => resolve()) }),
  }
}
