/** A stand-in backend for session-streams.e2e.ts: plain HTTP/1.1 (node:http, as the real one serves it), the built UI,
 *  and one session whose AGENTS runs never stop talking — no model, no data directory, no network. It answers what the
 *  page reads to show the session (shapes parsed by the contract's own schemas) and counts what a browser does to it:
 *  every event stream it holds open, every socket, every request.
 *
 *  Run streams: GET /api/runs/:id/events (the run's own, as before) and GET /api/sessions/:id/events (the session's
 *  one stream: every run's events, contract events.ts SESSION_STREAM_READY). Both hold the connection open and send a
 *  text_block per run every TICK_MS. */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import type { Socket } from 'node:net'
import { ProjectSchema, RunSchema, SessionDetailSchema, SessionSchema, SESSION_STREAM_READY } from '@oasis-code/contract'

export const AGENTS = 24
const TICK_MS = 400
const NOW = '2026-10-16T00:00:00.000Z'
const SESSION = 's_agents'
const runId = (i: number) => `run_agent_${String(i).padStart(2, '0')}`

export interface StubCounts {
  /** event streams open now, and the most at once */
  streamsOpen: number
  streamsPeak: number
  /** the paths of every event stream asked for */
  streamPaths: string[]
  socketsOpen: number
  socketsPeak: number
  requests: { method: string; path: string; at: number }[]
}

export interface Stub { server: Server; counts: StubCounts; close: () => Promise<void> }

const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.ico': 'image/x-icon' }

function run(i: number, status = 'running') {
  return RunSchema.parse({ id: runId(i), session_id: SESSION, project_id: 'p_agents', workspace_id: null, model: 'scripted:a', user_text: `agent ${i}: keep working`, status, created_at: NOW })
}

export async function startStub(port: number, dist: string): Promise<Stub> {
  const counts: StubCounts = { streamsOpen: 0, streamsPeak: 0, streamPaths: [], socketsOpen: 0, socketsPeak: 0, requests: [] }
  const extra: ReturnType<typeof run>[] = []
  const session = SessionSchema.parse({ id: SESSION, project_id: 'p_agents', title: `${AGENTS} agents at work`, workspace_id: null, model: 'scripted:a', created_at: NOW, updated_at: NOW })
  const project = { ...ProjectSchema.parse({ id: 'p_agents', name: 'agents', kind: 'direct', source_path: '/nowhere/agents', base_repo_path: '/nowhere/agents', base_commit: null, base_branch: null, created_at: NOW, updated_at: NOW }), sessions: [session] }
  const runs = () => [...Array.from({ length: AGENTS }, (_, i) => run(i)), ...extra]
  const detail = () => SessionDetailSchema.parse({
    ...session, workspace: null, runs: runs(), director_notes: [], director: null, active_run: null, relays: [], interactions: [], watches: [], wake_events: [],
    active_children: [], run_count: runs().length, pending_approvals: [], event_cursor: 0,
  })
  let tick = 0
  const send = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)) }

  /** an event stream held open: `frames` writes what it has to say each tick */
  const stream = (req: IncomingMessage, res: ServerResponse, first: () => string, frames: () => string) => {
    counts.streamsOpen += 1
    counts.streamsPeak = Math.max(counts.streamsPeak, counts.streamsOpen)
    counts.streamPaths.push(req.url ?? '')
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    res.write(first())
    const timer = setInterval(() => res.write(frames()), TICK_MS)
    req.on('close', () => { clearInterval(timer); counts.streamsOpen -= 1 })
  }
  const said = (i: number, n: number) => `agent-${String(i).padStart(2, '0')} says ${n}`

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
    const path = url.pathname
    counts.requests.push({ method: req.method ?? 'GET', path, at: Date.now() })
    if (!path.startsWith('/api/')) {
      const file = normalize(join(dist, path === '/' ? 'index.html' : path))
      const target = file.startsWith(dist) && existsSync(file) && statSync(file).isFile() ? file : join(dist, 'index.html')
      res.writeHead(200, { 'content-type': TYPES[extname(target)] ?? 'application/octet-stream' })
      res.end(readFileSync(target))
      return
    }
    if (path === '/api/meta/build') return send(res, 200, { package_version: '0', source_fingerprint: 'stub', api_version: 'code-v1', schema_version: 26, ui_build: null })
    if (path === '/api/models') return send(res, 200, { models: [{ id: 'scripted:a', label: 'Scripted', provider: 'test', available: true }], default: 'scripted:a' })
    if (path === '/api/projects') return send(res, 200, [project])
    if (path === `/api/sessions/${SESSION}`) return send(res, 200, detail())
    if (path === `/api/sessions/${SESSION}/runs/tree`) return send(res, 200, { session_id: SESSION, runs: [] })
    if (path === `/api/sessions/${SESSION}/chat` && req.method === 'POST') {
      const made = run(AGENTS + extra.length, 'done')
      extra.push(made)
      return send(res, 200, made)
    }
    if (path === `/api/sessions/${SESSION}/events`) {
      // the session's one stream: each run's start (the replay), stream_ready, then every run each tick
      let cursor = 0
      return stream(req, res, () => {
        let out = ''
        for (let i = 0; i < AGENTS; i += 1) out += `event: run_started\nid: ${++cursor}\ndata: ${JSON.stringify({ run_id: runId(i), seq: 0, data: { model: 'scripted:a' } })}\n\n`
        return `${out}event: ${SESSION_STREAM_READY}\nid: ${cursor}\ndata: ${JSON.stringify({ cursor, live_runs: Array.from({ length: AGENTS }, (_, i) => runId(i)) })}\n\n`
      }, () => {
        tick += 1
        let out = ''
        for (let i = 0; i < AGENTS; i += 1) out += `event: text_block\nid: ${++cursor}\ndata: ${JSON.stringify({ run_id: runId(i), seq: tick, data: { text: said(i, tick) } })}\n\n`
        return out
      })
    }
    const steer = /^\/api\/runs\/(run_agent_\d+)\/steer$/.exec(path)
    if (steer && req.method === 'POST') {
      // words to a run at work: taken (queued), as the harness answers
      let raw = ''
      req.on('data', (chunk) => { raw += String(chunk) })
      req.on('end', () => {
        const body = JSON.parse(raw || '{}') as { text?: string; client_request_id?: string }
        send(res, 200, { run_id: steer[1], steer: { id: `st_${Date.now()}`, run_id: steer[1], session_id: SESSION, text: body.text ?? '', client_request_id: body.client_request_id ?? 'k', status: 'queued', queued_at: NOW, queued_seq: tick, delivered_at: null, delivered_seq: null, request_index: null, reason: null } })
      })
      return
    }
    const page = /^\/api\/runs\/(run_agent_\d+)\/events\/page$/.exec(path)
    if (page) {
      // the run's record: its start, then a text_block a tick (the session stream's own seqs)
      const i = Number(page[1]!.slice('run_agent_'.length))
      const after = Number(url.searchParams.get('after') ?? -1), limit = Number(url.searchParams.get('limit') ?? 500)
      const events = [{ seq: 0, event: 'run_started', data: { model: 'scripted:a' } }, ...Array.from({ length: tick }, (_, k) => ({ seq: k + 1, event: 'text_block', data: { text: said(i, k + 1) } }))]
      return send(res, 200, { run_id: page[1], session_id: SESSION, events: events.filter((e) => e.seq > after).slice(0, limit) })
    }
    const own = /^\/api\/runs\/([^/]+)\/events$/.exec(path)
    if (own) {
      const i = Number(own[1]!.slice('run_agent_'.length))
      let seq = 0
      return stream(req, res, () => `event: run_started\nid: 0\ndata: ${JSON.stringify({ model: 'scripted:a' })}\n\n`,
        () => { seq += 1; return `event: text_block\nid: ${seq}\ndata: ${JSON.stringify({ text: said(i, seq) })}\n\n` })
    }
    const one = /^\/api\/runs\/([^/]+)(\/[a-z]+)?$/.exec(path)
    if (one) {
      const found = runs().find((r) => r.id === one[1])
      if (!found) return send(res, 404, { detail: 'no such run' })
      if (!one[2]) return send(res, 200, found)
      if (one[2] === '/transcript') return send(res, 200, { run_id: found.id, status: found.status, model: found.model, entries: [], steers: [] })
      if (one[2] === '/diff') return send(res, 200, { run_id: found.id, base_commit: 'stub', tree_sha: 'stub', files: [], patch: '', patch_cut: null })
    }
    return send(res, 404, { detail: `the stub does not serve ${path}` })
  })
  server.keepAliveTimeout = 60_000
  const sockets = new Set<Socket>()
  server.on('connection', (socket) => {
    sockets.add(socket)
    counts.socketsOpen += 1
    counts.socketsPeak = Math.max(counts.socketsPeak, counts.socketsOpen)
    socket.on('close', () => { sockets.delete(socket); counts.socketsOpen -= 1 })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
  return {
    server, counts,
    close: () => new Promise<void>((resolve) => { for (const s of sockets) s.destroy(); server.close(() => resolve()) }),
  }
}

export const STUB_SESSION = SESSION
export const agentRun = runId
