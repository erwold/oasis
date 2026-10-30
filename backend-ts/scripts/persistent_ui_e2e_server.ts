/** A backend for frontend/e2e/persistent-panel.e2e.ts: one persistent (session-scoped) panel that three independent
 *  forecasts and a timed collection of FIXTURE market data keep up to date. The real app (createApp: RunManager, the
 *  registered tools — present_ui, read_ui, fetch_url, watch —, SQLite, REST, SSE, the WatchService, the built UI) on
 *  a fresh data directory, with SCRIPTED MODELS in place of providers.
 *
 *  Where the data comes from: a local HTTP server this script starts on 127.0.0.1 (a free port) answers the quote
 *  requests from the FIXTURE stages (frontend/e2e/persistent-panel-fixtures.ts: STAGES, every body marked
 *  `"fixture": true`). The scripted models reach it only through the real fetch_url tool. fetch_url refuses the
 *  loopback, and that policy is not touched: the request names a public-looking host of the e2e's own
 *  (quotes.fixture.e2e.example), and the web tools' test hooks — the same `setWebHooks` seam scripts/e2e_server.ts
 *  uses for its pretend web — resolve that one name and carry its connection to the local fixture server. Every other
 *  name is refused before a lookup; the global fetch refuses every host but the loopback (installNetworkGuard). So
 *  fetch_url's own checks (the URL, the host check on the resolved address, the redirect rule, the size cap, the
 *  saved response and its provenance) all run; only DNS and the socket's destination are the harness's. Nothing is
 *  routed or fulfilled in the browser, no tool is stubbed, nothing is written to the database by this script.
 *
 *  The scripted routes (their tool calls written in advance; they prove the harness's path, not a model's choices):
 *    scripted:pf-owner — the session's main thread: creates the panel (scope session, expected_revision 0) with its
 *      own forecast; aggregates A's and B's forecasts from the relay's answers; sets timer watches; on every wake
 *      collects quotes (twice — a repeated collection), merges by market time and publishes at the revision it read,
 *      re-reading and merging after a conflict (see ownerScript);
 *    scripted:pf-a, scripted:pf-b — the relay's two turns: each probes the panel (read_ui and present_ui with scope
 *      session — refused for a relay turn; read_ui with scope run — not found), fetches the origin quote and answers
 *      with its forecast as a <forecast> block (the bounded, structured hand-back the relay carries to the thread).
 *
 *  It listens on 127.0.0.1 at a free port (port 0) and prints one JSON line first on stdout:
 *  { port, token, data, isolation, fixture_port }.
 *
 *      bun run scripts/persistent_ui_e2e_server.ts
 *
 *  Test-only routes, behind `authorization: Bearer <token>` (every other request goes to the app's fetch with the Bun
 *  server as its second argument — the app reads the caller's address from it):
 *    POST /e2e/fixture/stage?n=0|1|2 — the fixture market's stage (its reply queue starts over)
 *    GET  /e2e/fixture/log            — every request the fixture server answered: stage, reply, time
 *    POST /e2e/gate?name=&op=arm|release|disarm — hold the owner's wake run at a named point (GATES), or let it go
 *    GET  /e2e/seen                   — what each scripted turn saw (probe answers, publication statuses)
 *    GET  /e2e/ui-events?run_id=      — the run's persisted ui_surface events and present_ui/read_ui results (read-only) */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ModelConfig, Settings, type HarnessConfig } from '../src/config.ts'
import * as repo from '../src/db/repo.ts'
import { setWebHooks } from '../src/agent/tools/web.ts'
import {
  isRequest, isResponse, isText, isToolCall, isUserPrompt, modelResponse, textPart, toolCallPart, toolReturns,
  type ModelMessage, type ModelRequest, type ModelResponse, type ToolReturnPart,
} from '../src/llm/messages.ts'
import { scriptedModel } from '../src/llm/scripted.ts'
import { createApp } from '../src/main.ts'
import { installNetworkGuard, TestNetworkBlocked } from '../tests/network_guard.ts'
import {
  AGENTS, applyOutcomes, emptyModel, FIXTURE_HOST, forecastBlock, forecastsIn, GATES, makeForecast, MARK, modelOfSpec, ORIGIN_MS, outcomeOfFetch,
  PANEL_ID, panelSpec, protocolIn, publishArgs, QUOTE_PATH, QUOTE_URL, quoteBody, sameModel, STAGES, SYMBOL, WAKE_DELAY_S, WAKE_NOTE, withForecast,
  type FetchOutcome, type FixtureReply,
} from '../../frontend/e2e/persistent-panel-fixtures.ts'

const TOKEN = 'pf-e2e-token'
/** A public address (TEST-NET would be refused as reserved): what the fixture's name "resolves" to for the host check. */
const FIXTURE_ADDRESS = '93.184.216.34'
const rec = (v: unknown) => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {})

// ---------------------------------------------------------------- the fixture market (a real HTTP server on the loopback)

interface FixtureHit { n: number; stage: number; reply: string; at: string; path: string }
const fixture = { stage: 0, served: 0, log: [] as FixtureHit[] }

function startFixtureServer() {
  return Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname !== QUOTE_PATH || url.searchParams.get('symbol') !== SYMBOL) return Response.json({ fixture: true, error: 'unknown symbol' }, { status: 404 })
      const queue = STAGES[fixture.stage] ?? STAGES[STAGES.length - 1]!
      const reply: FixtureReply = queue[Math.min(fixture.served, queue.length - 1)]!
      fixture.served += 1
      const hit = { n: fixture.log.length + 1, stage: fixture.stage, at: new Date().toISOString(), path: `${url.pathname}${url.search}` }
      if (reply.kind === 'error') {
        fixture.log.push({ ...hit, reply: `HTTP ${reply.status}` })
        return Response.json({ fixture: true, error: 'the fixture feed is unavailable (a scripted failure)' }, { status: reply.status })
      }
      fixture.log.push({ ...hit, reply: `quote ${new Date(reply.quote.asof_ms).toISOString()} ${reply.quote.price}` })
      return new Response(quoteBody(reply.quote), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
    },
  })
}

/** fetch_url's transport for the fixture's one name: the connection goes to the local fixture server (the checked
 *  address is the harness's to ignore, as a scripted transport may); the answer is handed back as a new Response, so
 *  it lands at the URL that was asked (fetch_url checks where a response landed). Any other name: refused loudly. */
function fixtureWeb(port: number) {
  return {
    resolve: async (host: string) => {
      if (host !== FIXTURE_HOST) throw new TestNetworkBlocked(`lookup ${host}`)
      return [FIXTURE_ADDRESS]
    },
    fetchImpl: async (input: string | URL, init: RequestInit & { address?: string | null } = {}) => {
      const u = new URL(String(input))
      if (u.hostname !== FIXTURE_HOST) throw new TestNetworkBlocked(`fetch ${u.hostname}`)
      const { address: _address, ...rest } = init
      const r = await fetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`, { ...rest, redirect: 'manual' })
      return new Response(await r.arrayBuffer(), { status: r.status, headers: r.headers })
    },
  }
}

// ---------------------------------------------------------------- gates (the test holds and releases a run)

const armed = new Set<string>()
const waiting = new Map<string, () => void>()
function hold(name: string): Promise<void> {
  return new Promise<void>((resolve) => {
    // never for ever: a failed test must not keep the server from closing
    const timer = setTimeout(() => { waiting.delete(name); resolve() }, 120_000)
    waiting.set(name, () => { clearTimeout(timer); waiting.delete(name); resolve() })
  })
}
async function checkpoint(name: string): Promise<void> {
  if (!armed.delete(name)) return
  await hold(name)
}

// ---------------------------------------------------------------- what the scripted turns saw

interface Seen { model: string; turn: string; statuses: Record<string, unknown>[]; note?: string }
const seen: Seen[] = []

/** This turn: the words of the last request that carries a prompt (the person's, or the app's note of a wake), and
 *  what came after it. */
function thisTurn(messages: ModelMessage[]): { words: string; since: ModelMessage[] } {
  const at = messages.findLastIndex((m) => isRequest(m) && m.parts.some(isUserPrompt))
  if (at < 0) return { words: '', since: messages }
  const request = messages[at] as ModelRequest
  const words = request.parts.filter(isUserPrompt)
    .map((p) => (typeof p.content === 'string' ? p.content : p.content.filter((c): c is string => typeof c === 'string').join('\n'))).join('\n')
  const after = request.parts.findLastIndex(isUserPrompt) + 1
  return { words, since: [{ ...request, parts: request.parts.slice(after) }, ...messages.slice(at + 1)] }
}
/** Every text of a history: the prompts (a relay turn's packets ride in them) and the answers. */
function allTexts(messages: ModelMessage[]): string {
  const out: string[] = []
  for (const m of messages) {
    if (isRequest(m)) for (const p of m.parts) if (isUserPrompt(p)) out.push(typeof p.content === 'string' ? p.content : p.content.filter((c): c is string => typeof c === 'string').join('\n'))
    if (isResponse(m)) for (const p of m.parts) if (isText(p)) out.push(p.content)
  }
  return out.join('\n')
}
/** The arguments of this turn's calls of a tool, in order. */
function callsOf(since: ModelMessage[], tool: string): Record<string, unknown>[] {
  return since.flatMap((m) => (isResponse(m) ? m.parts.filter(isToolCall).filter((p) => p.tool_name === tool).map((p) => rec(typeof p.args === 'string' ? JSON.parse(p.args) : p.args)) : []))
}

const call = (name: string, args: Record<string, unknown>, text?: string): ModelResponse =>
  modelResponse([...(text ? [textPart(text)] : []), toolCallPart(name, args, '')])
const say = (text: string): ModelResponse => modelResponse([textPart(text)])
const readPanel = () => call('read_ui', { surface_id: PANEL_ID, scope: 'session' })
const fetchQuote = (why: string) => call('fetch_url', { url: QUOTE_URL }, why)
const brief = (p: ToolReturnPart) => {
  const c = rec(p.content)
  return { tool: p.tool_name, status: c.status ?? null, revision: c.revision ?? rec(c.surface).revision ?? null, current_revision: c.current_revision ?? null, reason: c.reason ?? c.message ?? null }
}
/** The surface record a read_ui answer carries (status ok), or null. */
const readRecord = (p: ToolReturnPart | undefined) => {
  const c = rec(p?.content)
  return c.status === 'ok' && rec(c.surface).spec ? rec(c.surface) as unknown as { revision: number; spec: unknown } : null
}
const outcomes = (fetches: ToolReturnPart[]): FetchOutcome[] => fetches.map((p) => outcomeOfFetch(p.content, p.tool_call_id))

// ---------------------------------------------------------------- scripted:pf-owner (the session's main thread)

function ownerScript(model: string) {
  return async (messages: ModelMessage[]): Promise<ModelResponse> => {
    const { words, since } = thisTurn(messages)
    const rs = toolReturns(since)
    const of = (tool: string) => rs.filter((p) => p.tool_name === tool)
    const done = (turn: string, text: string, note?: string) => { seen.push({ model, turn, statuses: rs.map(brief), note }); return say(text) }
    const reads = of('read_ui'), fetches = of('fetch_url'), presents = of('present_ui'), watches = of('watch')
    const status = (p: ToolReturnPart | undefined) => String(rec(p?.content).status ?? '')

    // 1. the panel, with the owner's own forecast (the relay's are not in yet)
    if (words.includes('PF_START')) {
      if (protocolIn(words) === null) return done('start', `${MARK.error}: no forecast protocol in the request`)
      if (fetches.length === 0) return fetchQuote('Reading the origin quote first.')
      const o = outcomes(fetches)[0]!
      if (o.kind !== 'quote' || o.quote.asof_ms !== ORIGIN_MS) return done('start', `${MARK.error}: the origin quote is not available (${JSON.stringify(o)})`)
      if (presents.length === 0) {
        const m = withForecast(applyOutcomes(emptyModel(), [o]), makeForecast('owner', o.quote, new Date().toISOString()))
        return call('present_ui', publishArgs(m, 0))
      }
      if (status(presents[0]) !== 'ok') return done('start', `${MARK.error}: the panel was not created (${JSON.stringify(presents[0]!.content)})`)
      // the forecast as it was published (frozen): read from this turn's own call, never computed again
      const mine = modelOfSpec(callsOf(since, 'present_ui')[0]).forecasts.owner!
      return done('start', `${MARK.created} revision ${String(rec(presents[0]!.content).revision)}\n${forecastBlock(mine)}`)
    }

    // 2. the relay's forecasts into the panel, then a timer watch
    if (words.includes('PF_AGGREGATE')) {
      // a session read of an id that does not exist: not found, nothing else is told
      if (reads.length === 0) return call('read_ui', { surface_id: 'fx_no_such_panel', scope: 'session' })
      if (reads.length === 1) return readPanel()
      const current = readRecord(reads[1])
      if (current === null) return done('aggregate', `${MARK.error}: the panel could not be read (${JSON.stringify(reads[1]!.content)})`)
      if (presents.length === 0) {
        let m = modelOfSpec(current.spec)
        const found = forecastsIn(allTexts(messages))
        for (const k of ['A', 'B'] as const) {
          const f = found.find((x) => x.agent === k)
          if (!f) return done('aggregate', `${MARK.error}: no forecast of ${k} in the relay's answers`)
          m = withForecast(m, f)
        }
        return call('present_ui', publishArgs(m, current.revision))
      }
      if (status(presents[0]) !== 'ok') return done('aggregate', `${MARK.error}: the aggregate was not published (${JSON.stringify(presents[0]!.content)})`)
      if (watches.length === 0) return call('watch', { kind: 'timer', delay_s: WAKE_DELAY_S, note: WAKE_NOTE(1) })
      return done('aggregate', `${MARK.aggregated} revision ${String(rec(presents[0]!.content).revision)}; watch ${String(rec(watches[0]!.content).watch_id)} ${status(watches[0])}`)
    }

    // 3. wake 1: collect twice, publish; the same publication again (as a retry after a lost answer) conflicts; the
    //    panel read again already holds this collection, so nothing more is published
    if (words.includes(WAKE_NOTE(1))) {
      if (reads.length === 0) return readPanel()
      if (fetches.length < 2) return fetchQuote(fetches.length === 0 ? 'Collecting the quote.' : 'Collecting it once more (a repeated collection).')
      const first = readRecord(reads[0])
      if (first === null) return done('wake1', `${MARK.error}: the panel could not be read`)
      const got = outcomes(fetches)
      const args = publishArgs(applyOutcomes(modelOfSpec(first.spec), got), first.revision)
      if (presents.length === 0) return call('present_ui', args)
      if (status(presents[0]) !== 'ok') return done('wake1', `${MARK.error}: the collection was not published (${JSON.stringify(presents[0]!.content)})`)
      if (presents.length === 1) return call('present_ui', args, 'Publishing the same revision again, as a retry of a call whose answer was lost would.')
      if (reads.length === 1) return call('read_ui', { surface_id: PANEL_ID, scope: 'session' }, `The retry conflicted (${status(presents[1])}); reading the panel again.`)
      const again = readRecord(reads[1])
      if (again === null) return done('wake1', `${MARK.error}: the panel could not be read again`)
      const merged = applyOutcomes(modelOfSpec(again.spec), got)
      if (!sameModel(merged, modelOfSpec(again.spec)) && presents.length === 2) return call('present_ui', publishArgs(merged, again.revision))
      if (watches.length === 0) return call('watch', { kind: 'timer', delay_s: WAKE_DELAY_S, note: WAKE_NOTE(2) })
      return done('wake1', `${MARK.wake} 1: published ${presents.filter((p) => status(p) === 'ok').length}, statuses ${presents.map(status).join(',')}; the re-read panel already held this collection (revision ${again.revision})`)
    }

    // 4. wake 2: a failed fetch and a stale quote (published: the last success kept), then a new quote merged first
    //    into the snapshot this run read at its start — a stale writer: it conflicts — then read again and merged
    if (words.includes(WAKE_NOTE(2))) {
      if (reads.length === 0) return readPanel()
      if (fetches.length < 2) return fetchQuote(fetches.length === 0 ? 'Collecting the quote.' : 'Collecting it once more.')
      const first = readRecord(reads[0])
      if (first === null) return done('wake2', `${MARK.error}: the panel could not be read`)
      const early = outcomes(fetches.slice(0, 2))
      if (presents.length === 0) return call('present_ui', publishArgs(applyOutcomes(modelOfSpec(first.spec), early), first.revision))
      if (status(presents[0]) !== 'ok') return done('wake2', `${MARK.error}: the collection was not published (${JSON.stringify(presents[0]!.content)})`)
      if (fetches.length < 3) {
        // the test may hold the run here, the failed collection on the page
        await checkpoint(GATES.afterFailure)
        return fetchQuote('Collecting again.')
      }
      const late = outcomes(fetches.slice(2, 3))
      if (presents.length === 1) return call('present_ui', publishArgs(applyOutcomes(modelOfSpec(first.spec), late), first.revision), 'Publishing the new quote onto the snapshot read at the start of this turn.')
      if (reads.length === 1) return call('read_ui', { surface_id: PANEL_ID, scope: 'session' }, `That conflicted (${status(presents[1])}); reading the current panel to merge into it.`)
      const again = readRecord(reads[1])
      if (again === null) return done('wake2', `${MARK.error}: the panel could not be read again`)
      if (presents.length === 2) return call('present_ui', publishArgs(applyOutcomes(modelOfSpec(again.spec), [...early, ...late]), again.revision))
      return done('wake2', `${MARK.wake} 2: statuses ${presents.map(status).join(',')}; revision ${String(rec(presents[2]!.content).revision)}`)
    }

    return say('PF_IDLE: nothing to do for these words.')
  }
}

// ---------------------------------------------------------------- scripted:pf-a / pf-b (the relay's turns)

function forecasterScript(model: string, agent: 'A' | 'B') {
  return async (messages: ModelMessage[]): Promise<ModelResponse> => {
    const { words, since } = thisTurn(messages)
    const rs = toolReturns(since)
    const protocol = protocolIn(allTexts(messages)) ?? protocolIn(words)
    if (protocol === null) return say(`${MARK.error}: no forecast protocol`)
    // the probes a turn that is not the session's main thread makes: none of them may reach the panel
    if (rs.length === 0) return call('read_ui', { surface_id: PANEL_ID, scope: 'session' })
    if (rs.length === 1) return call('read_ui', { surface_id: PANEL_ID, scope: 'run' })
    if (rs.length === 2) return call('present_ui', { ...panelSpec(emptyModel()), scope: 'session', expected_revision: 1 })
    const fetches = rs.filter((p) => p.tool_name === 'fetch_url')
    if (fetches.length === 0) return fetchQuote('Reading the origin quote.')
    const o = outcomes(fetches)[0]!
    const probes = rs.slice(0, 3).map(brief)
    seen.push({ model, turn: `relay-${agent}`, statuses: rs.map(brief) })
    if (o.kind !== 'quote' || o.quote.asof_ms !== protocol.origin_ms) return say(`${MARK.error}: the origin quote is not available (${JSON.stringify(o)})`)
    const f = makeForecast(agent, o.quote, new Date().toISOString())
    return say(`${AGENTS[agent].label}（${AGENTS[agent].rule}）的预测如下。\n${forecastBlock(f)}\n${MARK.probes} ${probes.map((p) => `${p.tool}=${String(p.status)}`).join(' ')}`)
  }
}

// ---------------------------------------------------------------- the server

function config(): HarnessConfig {
  const route = (id: string, label: string) => new ModelConfig({ id, label, provider: 'openai', model: id.replace(':', '-'), api_key_env: 'OASIS_PF_E2E_KEY' })
  return {
    models: [route('scripted:pf-owner', 'Scripted Forecast Owner'), route('scripted:pf-a', 'Scripted Forecaster A'), route('scripted:pf-b', 'Scripted Forecaster B')],
    default_model: 'scripted:pf-owner', context_window_fallback_tokens: 120_000, protected_paths: ['secrets/**'],
    command_env_passthrough: ['PATH', 'LANG', 'LC_ALL'], checks: [], command_timeout_s: 600, command_output_cap_bytes: 8 * 1024 * 1024,
    // confirmed as on a machine where the person said yes once (the question itself: full-access-ask.e2e.ts)
    full_access_confirmed: true,
  }
}

async function main(): Promise<void> {
  // The isolated fixture app must not inherit a proxy account directory.
  delete process.env.OASIS_CODE_USAGE_PROXY_AUTH_DIR
  // nothing but the loopback, before anything of the app is made
  installNetworkGuard()
  process.env.OASIS_PF_E2E_KEY = 'pf-e2e-fake-key'
  const root = mkdtempSync(join(process.env.OASIS_CODE_E2E_TMP || tmpdir(), 'oasis-pf-e2e-'))
  const market = startFixtureServer()
  setWebHooks(fixtureWeb(market.port as number))
  let resolveApp!: (fetch: (req: Request, srv: unknown) => Response | Promise<Response>) => void
  const appFetch = new Promise<(req: Request, srv: unknown) => Response | Promise<Response>>((r) => { resolveApp = r })
  let conn: Parameters<typeof repo.listEvents>[0] | null = null
  const server = Bun.serve({
    hostname: '127.0.0.1', port: Number(process.env.OASIS_CODE_E2E_PORT || 0), idleTimeout: 255,
    async fetch(req, srv) {
      const url = new URL(req.url)
      // the app's own routes: the request and the Bun server (the app reads the caller's address from it)
      if (!url.pathname.startsWith('/e2e/')) return (await appFetch)(req, srv)
      if (req.headers.get('authorization') !== `Bearer ${TOKEN}`) return new Response('no', { status: 403 })
      if (url.pathname === '/e2e/seen' && req.method === 'GET') return Response.json(seen)
      if (url.pathname === '/e2e/fixture/log' && req.method === 'GET') return Response.json({ stage: fixture.stage, log: fixture.log })
      if (url.pathname === '/e2e/fixture/stage' && req.method === 'POST') {
        const n = Number(url.searchParams.get('n'))
        if (!Number.isInteger(n) || n < 0 || n >= STAGES.length) return Response.json({ error: 'no such stage' }, { status: 400 })
        fixture.stage = n
        fixture.served = 0
        return Response.json({ stage: n })
      }
      if (url.pathname === '/e2e/gate' && req.method === 'POST') {
        const name = url.searchParams.get('name') ?? ''
        const op = url.searchParams.get('op') ?? 'release'
        if (op === 'arm') { armed.add(name); return Response.json({ armed: true }) }
        if (op === 'disarm') return Response.json({ disarmed: armed.delete(name) })
        const release = waiting.get(name)
        release?.()
        return Response.json({ released: release !== undefined })
      }
      if (url.pathname === '/e2e/ui-events' && req.method === 'GET' && conn !== null) {
        const runId = url.searchParams.get('run_id') ?? ''
        const events = repo.listEvents(conn, runId).filter((e) => e.event === 'ui_surface' || (e.event === 'tool_result' && ['present_ui', 'read_ui'].includes(String(e.data.tool))))
        return Response.json({ run_id: runId, events })
      }
      return new Response('not found', { status: 404 })
    },
  })
  const settings = new Settings({ data_dir: join(root, 'data'), host: '127.0.0.1', port: server.port, session_token: TOKEN })
  const models = {
    'scripted:pf-owner': scriptedModel(ownerScript('scripted:pf-owner'), 'scripted-pf-owner'),
    'scripted:pf-a': scriptedModel(forecasterScript('scripted:pf-a', 'A'), 'scripted-pf-a'),
    'scripted:pf-b': scriptedModel(forecasterScript('scripted:pf-b', 'B'), 'scripted-pf-b'),
  }
  const built = await createApp(settings, config(), { model_overrides: models, probe: false })
  await built.start()
  conn = built.state.conn
  resolveApp((req, srv) => built.fetch(req, srv))
  console.log(JSON.stringify({ port: server.port, token: TOKEN, data: settings.data_dir, isolation: built.state.isolation.enforcement, fixture_port: market.port }))
  const stop = async () => {
    for (const release of waiting.values()) release()
    server.stop(true)
    market.stop(true)
    await built.close()
    rmSync(root, { recursive: true, force: true })
    process.exit(0)
  }
  process.on('SIGTERM', () => { void stop() })
  process.on('SIGINT', () => { void stop() })
}

if (import.meta.main) await main()
