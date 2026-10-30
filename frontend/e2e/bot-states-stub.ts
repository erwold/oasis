/** A stand-in backend for bot-states.e2e.ts (a CONTROLLED FIXTURE, not a harness): plain HTTP on 127.0.0.1 (the port
 *  OASIS_CODE_E2E_PORT names), the built UI, and the answers the page reads for one session whose agents stand in every
 *  state a bot plays — no model, no data directory, no network, no provider. Its shapes are the contract's own schemas;
 *  the test moves the world (a run's record, the watches, the approvals, a form) and speaks on each run's stream, the
 *  way the harness would, and the real UI draws it.
 *
 *  Session s_bots: the main agent's earlier answer (m_old, ended an hour ago) and its current run (m_cur, live); an
 *  interaction (ix_bots) of six participants A–F whose steps stand idle (stopped), waiting (in line), thinking,
 *  working, blocked (a form waits on the person) and done; their nodes not yet given their run ids (the strip shows). */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import type { AddressInfo, Socket } from 'node:net'
import { InteractionDetailSchema, ProjectSchema, RunSchema, RunTreeRowSchema, SessionDetailSchema, SessionSchema, SESSION_STREAM_READY, WorkspaceSchema } from '@oasis-code/contract'

const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.json': 'application/json', '.ico': 'image/x-icon' }

export const S = 's_bots'
export const IX = 'ix_bots'
export const PARTS = ['A', 'B', 'C', 'D', 'E', 'F'] as const
export const RUN = { A: 'run_a_idle', B: 'run_b_waiting', C: 'run_c_thinking', D: 'run_d_working', E: 'run_e_blocked', F: 'run_f_done' } as const
export const MAIN_OLD = 'run_m_old'
export const MAIN_CUR = 'run_m_cur'
export const INPUT = 'in_e_pick'

type Rec = Record<string, unknown>
export interface StubRun { run: Rec; tree: Rec; events: { event: string; data: Rec }[]; transcript: Rec[] }
export interface BotStub {
  server: Server
  port: number
  runs: Map<string, StubRun>
  world: { watches: Rec[]; wake_events: Rec[]; proposals: Rec[]; inputs: Rec[]; nodes: Record<string, string> }
  /** a word on a run's stream (kept: a stream opened later reads it too) */
  push: (runId: string, event: string, data: Rec) => void
  /** a run's record moved (its row in the session and the tree alike) */
  patch: (runId: string, fields: Rec) => void
  /** a new run of the session */
  add: (run: StubRun) => void
  requests: { method: string; path: string; query: string; body: unknown }[]
  close: () => Promise<void>
}

/** The participants' stable ids: picked so the set's three non-square icons (22-whistle, 23-signpost, 31-pin) are
 *  among the bots the identity table gives them (A 31-pin, B 22-whistle, C 23-signpost). */
export const participantOf = (p: string) => `pa_${p}41`

const origin = (actor: string, extra: Rec = {}) => ({ actor, request: 'message', client: null, director_session_id: null, director_turn_id: null, tool_call_id: null, interaction_id: null, relay_id: null, watch_id: null, ui_task_id: null, parent_run_id: null, basis: 'recorded', ...extra })

export function inputRecord(status: 'pending' | 'submitted', at: string, values: Rec | null = null): Rec {
  return { id: INPUT, session_id: S, run_id: RUN.E, tool_call_id: 'tc_e_input', status, values, closed_reason: null, created_at: at, answered_at: status === 'pending' ? null : at, updated_at: at,
    request: { title: 'Which parser?', root: 'r', elements: { r: { type: 'select', props: { label: 'Parser', key: 'parser', options: [{ label: 'PEG', value: 'peg' }, { label: 'LR', value: 'lr' }] } } }, initial_state: { parser: 'peg' } } }
}

export function makeRun(o: { id: string; status: string; created: string; finished?: string | null; participant?: string | null; role?: string; user_text?: string; spawned_by?: string; receipt?: Rec | null; waiting?: Rec | null }): StubRun {
  const index = o.participant ? PARTS.indexOf(o.participant as typeof PARTS[number]) : -1
  const member = index >= 0
  const collab = {
    participant_id: member ? participantOf(o.participant!) : 'pa_main', participant_role: o.role ?? (member ? 'member' : 'main'), conversation_id: member ? `conv_${o.participant}` : 'conv_main', conversation_seq: 1,
    origin: origin(member ? 'harness' : 'person', member ? { interaction_id: IX } : {}),
    placement: { surface: 'thread', group: member ? { kind: 'interaction', id: IX } : null, anchor: null }, basis: 'recorded',
  }
  const base = {
    id: o.id, session_id: S, project_id: 'p_bots', workspace_id: 'ws_bots', parent_run_id: null, resumes_run_id: null, spawned_by: o.spawned_by ?? 'human',
    label: null, model: 'scripted:a', user_text: o.user_text ?? (member ? `Step of ${o.participant}` : 'Fix the parser'), status: o.status, created_at: o.created, finished_at: o.finished ?? null,
    receipt: o.receipt ?? {}, interaction_id: member ? IX : null, interaction_node: member ? `n_${o.participant!.toLowerCase()}` : null, collab,
  }
  const run = { ...RunSchema.parse(base), waiting: o.waiting ?? null } as Rec
  const tree = {
    ...RunTreeRowSchema.parse({ ...base, live: ['queued', 'running'].includes(o.status), user_text_head: base.user_text, work_order: null, receipt: o.receipt && Object.keys(o.receipt).length ? o.receipt : null, error: null, usage: {}, depth: 0,
      plan_node_id: member ? `${IX}:n_${o.participant!.toLowerCase()}` : null, participant_id: member ? `${IX}:${o.participant}` : null, participant_alias: member ? o.participant : null,
      participant_index: member ? index : null, participant_name: member ? `Agent ${o.participant}` : null, kind: 'run', collab }),
    waiting: o.waiting ?? null,
  } as Rec
  return { run, tree, events: [], transcript: [] }
}

export async function startBotStub(dist: string, t0: number): Promise<BotStub> {
  const at = (sec: number) => new Date(t0 + sec * 1000).toISOString()
  const requests: BotStub['requests'] = []
  const runs = new Map<string, StubRun>()
  const listeners = new Map<string, Set<ServerResponse>>()
  // the session's one stream (as the harness serves it: every run's events, one connection — a browser holds at most
  // six per host): its frames by cursor
  const log: { cursor: number; run_id: string; seq: number; event: string; data: Rec }[] = []
  const sessionListeners = new Set<ServerResponse>()
  const frame = (f: (typeof log)[number]) => `event: ${f.event}\nid: ${f.cursor}\ndata: ${JSON.stringify({ run_id: f.run_id, seq: f.seq, data: f.data })}\n\n`
  const world: BotStub['world'] = { watches: [], wake_events: [], proposals: [], inputs: [], nodes: { A: 'cancelled', B: 'queued', C: 'running', D: 'running', E: 'running', F: 'done' } }

  // the main agent: its answer an hour ago, its run now
  const old = makeRun({ id: MAIN_OLD, status: 'done', created: at(-3600), finished: at(-3590), user_text: 'Read the parser' })
  old.transcript = [{ kind: 'agent', text: 'The parser reads one token too many.' }]
  runs.set(MAIN_OLD, old)
  // the six participants
  const waiting = { reason: 'workspace_lock', workspace_id: 'ws_bots', blocking_owner: RUN.D, blocking_kind: 'run', blocking_run_id: RUN.D, queued_since: at(-30), position: 1 }
  const a = makeRun({ id: RUN.A, status: 'cancelled', created: at(-120), finished: at(-2), participant: 'A' })
  a.transcript = [{ kind: 'agent', text: 'Stopped before it began.' }]
  const f = makeRun({ id: RUN.F, status: 'done', created: at(-70), finished: at(-1), participant: 'F' })
  f.transcript = [{ kind: 'agent', text: 'All green.' }]
  for (const r of [a, makeRun({ id: RUN.B, status: 'queued', created: at(-110), participant: 'B', waiting }), makeRun({ id: RUN.C, status: 'running', created: at(-100), participant: 'C' }),
    makeRun({ id: RUN.D, status: 'running', created: at(-90), participant: 'D', spawned_by: 'director' }), makeRun({ id: RUN.E, status: 'running', created: at(-80), participant: 'E' }), f]) runs.set(r.run.id as string, r)
  runs.set(MAIN_CUR, makeRun({ id: MAIN_CUR, status: 'running', created: at(-10), user_text: 'Now fix it' }))

  const push = (runId: string, event: string, data: Rec) => {
    const r = runs.get(runId)!
    r.events.push({ event, data })
    const seq = r.events.length
    for (const res of listeners.get(runId) ?? []) res.write(`event: ${event}\nid: ${seq}\ndata: ${JSON.stringify(data)}\n\n`)
    const f = { cursor: log.length + 1, run_id: runId, seq: seq - 1, event, data }
    log.push(f)
    for (const res of sessionListeners) res.write(frame(f))
  }
  const patch = (runId: string, fields: Rec) => {
    const r = runs.get(runId)!
    r.run = { ...r.run, ...fields }
    r.tree = { ...r.tree, ...fields, live: ['queued', 'running'].includes(String(fields.status ?? r.tree.status)) }
  }
  const add = (r: StubRun) => {
    const events = r.events
    r.events = []
    runs.set(r.run.id as string, r)
    for (const e of events) push(r.run.id as string, e.event, e.data)
  }
  // the streams as they stand when the page opens
  push(RUN.B, 'run_queued', waiting)
  push(RUN.C, 'run_started', { model: 'scripted:a' }); push(RUN.C, 'thinking_delta', { text: 'Which grammar does it take?', start: true })
  push(RUN.D, 'run_started', { model: 'scripted:a' }); push(RUN.D, 'tool_call', { tool_call_id: 'tc_d1', tool: 'bash', summary: 'npm test', args: { command: 'npm test' } })
  push(RUN.E, 'run_started', { model: 'scripted:a' }); push(RUN.E, 'tool_call', { tool_call_id: 'tc_e_input', tool: 'request_input', summary: 'Which parser?' })
  push(RUN.E, 'ui_input', { input: inputRecord('pending', at(-60)) })
  world.inputs = [inputRecord('pending', at(-60))]
  push(MAIN_CUR, 'run_started', { model: 'scripted:a' }); push(MAIN_CUR, 'text_delta', { text: 'Looking at the tokenizer.', start: true })

  const interaction = () => InteractionDetailSchema.parse({
    id: IX, session_id: S, status: 'running', user_text: 'Try each parser', controller: 'fixed', template: 'independent',
    participants: PARTS.map((p) => ({ id: p, label: `Agent ${p}`, model: 'scripted:a' })), budget: { max_runs: 12, concurrency: 4 }, created_at: at(-130), updated_at: at(-1),
    nodes: PARTS.map((p, i) => ({ id: `n_${p.toLowerCase()}`, interaction_id: IX, seq: i + 1, participant: p, status: world.nodes[p], created_at: at(-130), updated_at: at(-1) })),
  })
  const workspace = WorkspaceSchema.parse({ id: 'ws_bots', project_id: 'p_bots', session_id: S, path: '/fixture/bots', branch: '', base_commit: '', kind: 'direct', created_at: at(-4000) })
  const session = () => SessionSchema.parse({ id: S, project_id: 'p_bots', title: 'Bot states', workspace_id: 'ws_bots', model: 'scripted:a', created_at: at(-4000), updated_at: at(-1), last_activity_at: at(-1) })
  const detail = () => {
    const all = [...runs.values()]
    const parsed = SessionDetailSchema.parse({
      ...session(), workspace, runs: all.map((r) => r.run), director_notes: [], director: null, active_run: null, relays: [], interactions: [interaction()],
      watches: world.watches, wake_events: world.wake_events, active_children: [], run_count: all.length, pending_approvals: [],
    })
    // the fields the parse drops (a run's `waiting`): as the harness sends them
    return { ...parsed, runs: all.map((r) => r.run), event_cursor: 0 }
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
    requests.push({ method, path, query: url.search, body })
    if (!path.startsWith('/api/')) {
      const file = normalize(join(dist, path === '/' ? 'index.html' : decodeURIComponent(path)))
      const target = file.startsWith(dist) && existsSync(file) && statSync(file).isFile() ? file : join(dist, 'index.html')
      res.writeHead(200, { 'content-type': TYPES[extname(target)] ?? 'application/octet-stream' })
      res.end(readFileSync(target))
      return
    }
    if (path === '/api/meta/build') return send(res, 200, { package_version: '0', source_fingerprint: 'stub', api_version: 'code-v1', schema_version: 29, ui_build: null })
    if (path === '/api/models') return send(res, 200, { models: [{ id: 'scripted:a', label: 'Scripted', provider: 'test', available: true }], default: 'scripted:a' })
    if (path === '/api/projects') return send(res, 200, [{ ...ProjectSchema.parse({ id: 'p_bots', name: 'bots', kind: 'direct', source_path: '/fixture/bots', base_repo_path: '/fixture/bots', base_commit: null, base_branch: null, created_at: at(-4000), updated_at: at(-1) }), sessions: [session()] }])
    if (path === `/api/sessions/${S}`) return send(res, 200, detail())
    if (path === `/api/sessions/${S}/runs/tree`) return send(res, 200, { session_id: S, runs: [...runs.values()].map((r) => r.tree) })
    if (path === `/api/sessions/${S}/mode`) return send(res, 200, { mode: 'auto', session: detail(), control: { desired_state: 'run', gate_effects: [] } })
    if (path === `/api/sessions/${S}/action-proposals`) return send(res, 200, { proposals: world.proposals })
    if (path === `/api/sessions/${S}/agent-control`) return send(res, 200, { control: { desired_state: 'run', gate_effects: [] }, effect_tags: [], gateable_tools: [] })
    if (path === `/api/sessions/${S}/ui-inputs`) return send(res, 200, { inputs: world.inputs.filter((i) => !url.searchParams.get('status') || i.status === url.searchParams.get('status')) })
    if (path === `/api/sessions/${S}/ui-inputs/${INPUT}`) return send(res, 200, { input: world.inputs.find((i) => i.id === INPUT) })
    if (path === `/api/sessions/${S}/ui-inputs/${INPUT}/submit` && method === 'POST') {
      const answered = inputRecord('submitted', new Date().toISOString(), (body as { values?: Rec } | null)?.values ?? null)
      world.inputs = [answered]
      // the same run goes on with the answer: the call's result, then its model again
      setTimeout(() => { push(RUN.E, 'ui_input', { input: answered }); push(RUN.E, 'tool_result', { tool_call_id: 'tc_e_input', tool: 'request_input', status: 'ok' }); push(RUN.E, 'thinking_delta', { text: 'PEG it is.', start: true }) }, 50)
      return send(res, 200, { input: answered })
    }
    const decide = /^\/api\/action-proposals\/([^/]+)\/decide$/.exec(path)
    if (decide && method === 'POST') {
      world.proposals = world.proposals.map((p) => (p.proposal_asset_id === decide[1] ? { ...p, status: 'approved', decision: { decision: 'approve', decided_at: new Date().toISOString() } } : p))
      return send(res, 200, { status: 'approved' })
    }
    const watch = /^\/api\/watches\/([^/]+)\/cancel$/.exec(path)
    if (watch && method === 'POST') {
      world.watches = world.watches.map((w) => (w.id === watch[1] ? { ...w, status: 'cancelled', ended_reason: 'cancelled' } : w))
      return send(res, 200, { cancelled: true, watch: world.watches.find((w) => w.id === watch[1]) ?? null })
    }
    if (path === `/api/sessions/${S}/events`) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      const after = Number(url.searchParams.get('after') ?? req.headers['last-event-id'] ?? 0)
      for (const f of log) if (f.cursor > after) res.write(frame(f))
      const live = [...runs.values()].filter((x) => ['queued', 'running'].includes(String(x.run.status))).map((x) => x.run.id)
      res.write(`event: ${SESSION_STREAM_READY}\nid: ${log.length}\ndata: ${JSON.stringify({ cursor: log.length, live_runs: live })}\n\n`)
      sessionListeners.add(res)
      const beat = setInterval(() => res.write(': beat\n\n'), 1000)
      req.on('close', () => { clearInterval(beat); sessionListeners.delete(res) })
      return
    }
    const page = /^\/api\/runs\/([a-z0-9_]+)\/events\/page$/.exec(path)
    if (page && runs.has(page[1]!)) {
      const after = Number(url.searchParams.get('after') ?? -1)
      const limit = Number(url.searchParams.get('limit') ?? 500)
      const events = runs.get(page[1]!)!.events.map((e, i) => ({ seq: i, event: e.event, data: e.data })).filter((e) => e.seq > after).slice(0, limit)
      return send(res, 200, { run_id: page[1], session_id: S, events })
    }
    const one = /^\/api\/runs\/([a-z0-9_]+)(\/[a-z]+)?$/.exec(path)
    const r = one ? runs.get(one[1]!) : undefined
    if (one && r) {
      if (!one[2]) return send(res, 200, { ...r.run, live: ['queued', 'running'].includes(String(r.run.status)), depth: 0, requests: [], executions: [], children: [] })
      if (one[2] === '/transcript') return send(res, 200, { run_id: r.run.id, status: r.run.status, model: 'scripted:a', steers: [], entries: r.transcript })
      if (one[2] === '/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
        const after = Number(url.searchParams.get('after') ?? -1)
        r.events.forEach((e, i) => { if (i + 1 > after) res.write(`event: ${e.event}\nid: ${i + 1}\ndata: ${JSON.stringify(e.data)}\n\n`) })
        const set = listeners.get(r.run.id as string) ?? new Set()
        set.add(res)
        listeners.set(r.run.id as string, set)
        const beat = setInterval(() => res.write(': beat\n\n'), 1000)
        req.on('close', () => { clearInterval(beat); set.delete(res) })
        return
      }
    }
    if (path === '/api/workspaces/ws_bots') return send(res, 200, { ...workspace, status: { modified: [], added: [], deleted: [], untracked: [], renamed: [], external_changes: [] }, lock_owner: null, latest_snapshot: null, checkpoints: [], executions: [], checks: [] })
    if (path === '/api/workspaces/ws_bots/diff') return send(res, 200, { base_commit: '', tree_sha: '', snapshot_id: null, patch: '', files: [], external_changes: [], review_flags: [], patch_cut: null })
    return send(res, 404, { detail: `the stub does not serve ${path}` })
  })
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(Number(process.env.OASIS_CODE_E2E_PORT || 8399), '127.0.0.1', resolve) })
  const port = (server.address() as AddressInfo).port
  return {
    server, port, runs, world, push, patch, add, requests,
    close: () => new Promise<void>((resolve) => { for (const s of sockets) s.destroy(); server.close(() => resolve()) }),
  }
}
