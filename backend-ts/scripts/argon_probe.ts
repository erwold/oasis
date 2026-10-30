/** The Gemini 4 Argon long-thinking stream probe (docs/argon-probe-runbook.md) — run by the person on their own
 *  machine, outside any sandbox; never by the test suite against a real host, never by an agent with a key.
 *
 *    bun run scripts/argon_probe.ts gemini --body <google-body.json> --out <dir> [--mode raw|pinned|both]
 *    bun run scripts/argon_probe.ts gemini --app-request <app-request.json> --out <dir>          (--mode app)
 *        dry run (the default, zero network): reads the file and prints its structure (counts, sizes, keyed hashes —
 *        never its text), a rough cost estimate and, for app, whether the body the app builds matches expected_body
 *        (by keyed hash and differing JSON paths); nothing is sent.
 *        --live --max-fetches N --path-label TEXT [--yes]: at most N physical requests (1..6; the app's own retries and
 *        any resume hop count). The real key, from the variable --key-env names (default ARGON_PROBE_API_KEY), goes
 *        only to https://generativelanguage.googleapis.com exactly; any other --base-url gets a made-up key and the
 *        variable is never read.
 *          raw     the Google body file sent by fetch as it is (the app's headers), metered byte by byte
 *          pinned  the same file through the app's own GoogleModel.requestStream (buildModel), the body pinned to the
 *                  file: it tests the transport, the stream handling and the adapter's resume — not message mapping
 *          both    raw, then pinned, with the same file
 *          app     an app-native request (messages, settings, params as the app holds them) through buildModel +
 *                  requestStream unchanged; an expected_body in the file is compared first and a difference refuses
 *        --save-text (pinned / app, off by default): the returned response's words (text parts only) to a private 0600
 *        file for the person's own review; raw never writes merged text.
 *    bun run scripts/argon_probe.ts idle-server --port P [--host H] [--tls-cert F --tls-key F] [--secret-env NAME]
 *    bun run scripts/argon_probe.ts idle-client --url URL --out DIR --gaps 30,55,65,90 [--live --path-label TEXT]
 *    bun run scripts/argon_probe.ts idle-selftest [--gaps 1,2]          (127.0.0.1 only)
 *
 *  Importing this module does nothing: no folder, no environment change. `main` sets up what a command needs and
 *  puts it back (environment, the global fetch, the app's credential folder) in `finally`. It never starts the app,
 *  never opens its database and never reads its credential store (the app's model is built over an empty private
 *  credential folder). */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import * as lib from './argon_probe_lib.ts'
import type { WireRecord, SseScanner } from './argon_probe_lib.ts'
import { safeFetchVia } from '../src/safe_fetch.ts'

const SYNTHETIC_KEY = 'argon-probe-synthetic-key-not-real'
const SYNTHETIC_KEY_ENV = 'ARGON_PROBE_SYNTHETIC_KEY'

/** Each command's flags: anything else (a misspelt budget or mode flag among them) is refused. */
export const COMMAND_FLAGS: Record<string, { values: string[]; bools: string[] }> = {
  gemini: { values: ['body', 'app-request', 'out', 'mode', 'max-fetches', 'path-label', 'key-env', 'base-url', 'model', 'min-text-chars', 'app-max-retries', 'socket-idle-ms'], bools: ['live', 'yes', 'raw-resume', 'save-text'] },
  'idle-server': { values: ['port', 'host', 'tls-cert', 'tls-key', 'secret-env'], bools: [] },
  'idle-client': { values: ['url', 'out', 'gaps', 'headers-delay', 'heartbeat', 'chunk-bytes', 'request-pad-kb', 'path-label', 'secret-env'], bools: ['live'] },
  'idle-selftest': { values: ['gaps', 'heartbeat', 'headers-delay'], bools: [] },
  help: { values: [], bools: [] },
}

export interface Args { cmd: string; flags: Map<string, string>; bools: Set<string> }

export function parseArgs(argv: string[]): Args {
  const [cmd = 'help', ...rest] = argv
  const spec = COMMAND_FLAGS[cmd]
  if (!spec) throw new lib.ProbeUsageError(`unknown command ${cmd}`)
  const flags = new Map<string, string>()
  const bools = new Set<string>()
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!
    if (!a.startsWith('--')) throw new lib.ProbeUsageError(`unexpected argument ${a}`)
    const name = a.slice(2)
    if (spec.bools.includes(name)) { bools.add(name); continue }
    if (!spec.values.includes(name)) throw new lib.ProbeUsageError(`unknown flag --${name} for ${cmd}`)
    const v = rest[i + 1]
    if (v === undefined || v.startsWith('--')) throw new lib.ProbeUsageError(`--${name} needs a value`)
    if (flags.has(name)) throw new lib.ProbeUsageError(`--${name} given twice`)
    flags.set(name, v)
    i++
  }
  return { cmd, flags, bools }
}

const whole = (v: string | undefined, d: number, name: string, max = Number.MAX_SAFE_INTEGER): number => {
  if (v === undefined) return d
  const n = Number(v)
  if (!/^\d+$/.test(v) || !Number.isSafeInteger(n) || n > max) throw new lib.ProbeUsageError(`--${name} takes a whole number${max < Number.MAX_SAFE_INTEGER ? ` up to ${max}` : ''}`)
  return n
}
const stamp = () => `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(16).slice(2, 6)}`

export interface Io { out: (s: string) => void; err: (s: string) => void; sleep: (ms: number) => Promise<void> }
const defaultIo: Io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(`${s}\n`), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) }

/** Sets process.env names for the length of `fn`, then puts back exactly what was there. */
async function withEnv<T>(changes: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>()
  for (const [k, v] of Object.entries(changes)) {
    saved.set(k, process.env[k])
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try { return await fn() } finally {
    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  }
}

/** Puts `replacement` in place of the global fetch for the length of `fn`. */
async function withGlobalFetch<T>(replacement: (input: string | URL | Request, init?: RequestInit) => Promise<Response>, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = Object.assign(replacement, { preconnect: () => {} }) as typeof fetch
  try { return await fn() } finally { globalThis.fetch = original }
}

// ---- gemini ---------------------------------------------------------------------------------------------------

type AppModule = { buildModel: typeof import('../src/llm/providers.ts').buildModel; ModelConfig: typeof import('../src/config.ts').ModelConfig }
type GoogleModelT = import('../src/llm/providers.ts').GoogleModel

/** A dry run (the default) runs with a global fetch that refuses everything: zero network, whatever the code does. */
async function gemini(args: Args, io: Io): Promise<number> {
  if (args.bools.has('live')) return geminiRun(args, io)
  return withGlobalFetch(async () => { throw new lib.ProbeUsageError('a dry run sends nothing') }, () => geminiRun(args, io))
}

async function geminiRun(args: Args, io: Io): Promise<number> {
  const bodyPath = args.flags.get('body')
  const appPath = args.flags.get('app-request')
  const outDir = args.flags.get('out')
  if (!outDir || (bodyPath === undefined) === (appPath === undefined)) throw new lib.ProbeUsageError('gemini needs --out and exactly one of --body <google body> or --app-request <app request>')
  const mode = args.flags.get('mode') ?? (appPath ? 'app' : 'raw')
  if (appPath && mode !== 'app') throw new lib.ProbeUsageError('--app-request goes with --mode app only')
  if (bodyPath && !['raw', 'pinned', 'both'].includes(mode)) throw new lib.ProbeUsageError('--body goes with --mode raw, pinned or both')
  const live = args.bools.has('live')
  const model = args.flags.get('model') ?? 'gemini-4-argon'
  if (!/^[a-z0-9.\-]{1,64}$/.test(model)) throw new lib.ProbeUsageError('--model is a model id like gemini-4-argon')
  const baseUrl = (args.flags.get('base-url') ?? lib.GOOGLE_ORIGIN).replace(/\/+$/, '')
  let parsedBase: URL
  try { parsedBase = new URL(baseUrl) } catch { throw new lib.ProbeUsageError('--base-url is not a URL') }
  const official = lib.isOfficialGoogleOrigin(baseUrl)
  const keyEnv = args.flags.get('key-env') ?? 'ARGON_PROBE_API_KEY'
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(keyEnv)) throw new lib.ProbeUsageError('--key-env is a variable name like ARGON_PROBE_API_KEY')
  const minText = whole(args.flags.get('min-text-chars'), 40, 'min-text-chars')
  const appMaxRetries = whole(args.flags.get('app-max-retries'), 0, 'app-max-retries', 2)
  const socketIdle = whole(args.flags.get('socket-idle-ms'), lib.RAW_SOCKET_IDLE_MS, 'socket-idle-ms')
  if (socketIdle !== 0 && socketIdle < 1000) throw new lib.ProbeUsageError('--socket-idle-ms is 0 (off) or at least 1000')
  const maxFetches = live ? whole(args.flags.get('max-fetches'), 0, 'max-fetches', lib.ABSOLUTE_MAX_FETCHES) : 0
  if (!live && args.flags.has('max-fetches')) throw new lib.ProbeUsageError('--max-fetches goes with --live')
  if (live) {
    if (maxFetches < 1) throw new lib.ProbeUsageError(`--live needs --max-fetches 1..${lib.ABSOLUTE_MAX_FETCHES}`)
    if (mode === 'both' && maxFetches < 2) throw new lib.ProbeUsageError('--mode both needs --max-fetches 2 or more')
    if (!args.flags.get('path-label')) throw new lib.ProbeUsageError('--live needs --path-label (the network path of this run, e.g. "tunnel on, env proxy 1082, node A")')
    // Bun's verbose fetch prints each request's headers (the key among them) and body to the terminal, past this tool
    if (lib.verboseFetchOn(process.env.BUN_CONFIG_VERBOSE_FETCH)) throw new lib.ProbeUsageError('BUN_CONFIG_VERBOSE_FETCH is set: Bun would print the key and the body; unset it (env -u BUN_CONFIG_VERBOSE_FETCH …) and run again — nothing sent')
  }

  const googleBody = bodyPath ? lib.loadGoogleBody(resolve(bodyPath)) : null
  const appRequest = appPath ? lib.loadAppRequest(resolve(appPath)) : null
  const { salt } = lib.prepareOutputDir(resolve(outDir))
  const secrets = new Set<string>(lib.requestSecrets(googleBody ?? appRequest))
  const runDir = join(resolve(outDir), `${live ? 'live' : 'dry'}-${stamp()}`)
  mkdirSync(runDir, { mode: 0o700 })

  // the real key: only for the exact official origin, only when live; any other endpoint gets a made-up one and the
  // variable is never read
  let key = SYNTHETIC_KEY
  if (live && official) {
    const v = process.env[keyEnv]
    if (!v || v.length < 8 || v.length > 512 || !/^[\x21-\x7e]+$/.test(v)) throw new lib.ProbeUsageError(`--live on Google needs the key in ${keyEnv} (set it in this shell yourself; it is never printed)`)
    key = v
  }
  secrets.add(key)

  const needsApp = mode !== 'raw'
  const privateAppDir = needsApp ? mkdtempSync(join(tmpdir(), 'argon-probe-app-')) : null
  const envChanges: Record<string, string | undefined> = privateAppDir ? { OASIS_CODE_DATA: privateAppDir, OASIS_CODE_AUTH_DIR: privateAppDir } : {}
  if (needsApp && !(live && official)) envChanges[SYNTHETIC_KEY_ENV] = SYNTHETIC_KEY
  let setDefaultAuthDir: ((p: string | null) => void) | null = null
  try {
    return await withEnv(envChanges, async () => {
      let app: AppModule | null = null
      if (needsApp) {
        // the app's modules, over an empty private data and credential folder: buildModel's stored-key lookup finds
        // nothing, and the key comes from the named variable (or the synthetic one)
        const store = await import('../src/auth/store.ts')
        setDefaultAuthDir = store.setDefaultAuthDir
        store.setDefaultAuthDir(privateAppDir)
        const [{ buildModel }, { ModelConfig }] = await Promise.all([import('../src/llm/providers.ts'), import('../src/config.ts')])
        app = { buildModel, ModelConfig }
      }
      const appKeyEnv = live && official ? keyEnv : SYNTHETIC_KEY_ENV
      const makeModel = (fetchImpl: (i: string | URL, init?: RequestInit) => Promise<Response>): GoogleModelT => app!.buildModel(new app!.ModelConfig({
        id: 'google:gemini-4-argon', label: 'Gemini 4 Argon (probe)', provider: 'google', model, api_key_env: appKeyEnv, base_url: official ? null : baseUrl,
        reasoning_efforts: ['low', 'medium', 'high'], context_window: 1_048_576, max_tokens: 65_536,
      }), { fetchImpl, maxRetries: appMaxRetries }) as GoogleModelT

      // the body that goes out: the file's (raw / pinned), or the one the app builds from its own request (app)
      let wireBody: Record<string, unknown>
      let appBody: Record<string, unknown> | null = null
      const refuse = async (): Promise<Response> => { throw new lib.ProbeUsageError('the dry check sends nothing') }
      if (appRequest) {
        appBody = makeModel(refuse).body(appRequest.messages, appRequest.settings, appRequest.params)
        wireBody = appBody
      } else wireBody = googleBody!
      const shape = lib.bodyShape(wireBody)
      const inputHash = lib.keyedHash(salt, lib.canonicalJson(wireBody))
      const expected = appRequest?.expected_body ?? null
      const appCheck = appRequest ? {
        expected_body_given: expected !== null,
        matches_expected: expected === null ? null : lib.canonicalJson(expected) === lib.canonicalJson(appBody),
        diff_paths_expected_vs_app: expected === null ? [] : lib.diffPaths(expected, appBody),
        app_body_signatures: shape.parts.thoughtSignature ?? 0,
      } : null
      const physical = mode === 'both' ? 2 : 1
      const summary: Record<string, unknown> = {
        tool: 'argon-probe gemini', format: 1, live, mode, path_label: args.flags.get('path-label') ?? null,
        same_request_note: mode === 'app' ? 'the app built this body from its own request; it is the same request as another run only where their body hashes are equal'
          : 'raw and pinned send the file body unchanged; each request record says whether the body that went out equals the file (same_body_as_input)',
        started_at: new Date().toISOString(), bun: Bun.version, platform: `${process.platform}-${process.arch}`,
        endpoint: `${parsedBase.origin}/v1beta/models/${model}:streamGenerateContent`, official_endpoint: official, real_key_used: live && official,
        proxy_env: lib.proxyEnvironment(),
        proxy_note: 'unsetting the proxy variables does not bypass a system tunnel (Shadowrocket MacPacketTunnel); see the runbook',
        transport_config: {
          raw: mode === 'raw' || mode === 'both' ? { bun_socket_idle_timeout_ms: socketIdle, bun_socket_idle_timeout_sent: socketIdle === 0 ? false : socketIdle, whole_deadline_ms: lib.RAW_WHOLE_DEADLINE_MS, redirect: 'manual (never followed)' } : null,
          app: needsApp ? { bun_socket_idle_timeout: 'as the app sets it (recorded per request as socket_idle_timeout; bun-default = not set)', BUN_CONFIG_HTTP_IDLE_TIMEOUT: process.env.BUN_CONFIG_HTTP_IDLE_TIMEOUT ?? null, max_retries: appMaxRetries } : null,
        },
        input: { kind: appRequest ? 'app-request' : 'google-body', ...shape, body_hash_canonical: inputHash },
        app_body_check: appCheck,
        cost_estimate: lib.costEstimate(shape, live ? maxFetches : physical),
      }
      if (shape.max_output_tokens !== null && shape.max_output_tokens <= 32_768) {
        summary.warning = 'maxOutputTokens is at most 32768: checkpoints come only past 32768 output tokens, so this request cannot reproduce the long-thinking drop'
      }
      if (needsApp && app) {
        const m = makeModel(refuse)
        summary.app_adapter = { timeout_ms: m.http.timeoutMs ?? null, idle_timeout_ms: m.http.idleTimeoutMs ?? null }
      }

      if (!live) {
        summary.network_requests = 0
        summary.plan = { physical_requests_if_live: physical, note: 'dry run: nothing was sent. Live: --live --max-fetches N --path-label TEXT, the key in the variable named by --key-env.' }
        if (appCheck?.matches_expected === false) summary.plan = { ...summary.plan as object, live_refused: 'the app builds a body different from expected_body' }
        const text = lib.writePrivateJson(join(runDir, 'summary.json'), summary, secrets)
        io.out(text)
        io.err(`dry run: nothing sent. summary: ${join(runDir, 'summary.json')}`)
        return 0
      }
      if (appCheck?.matches_expected === false) throw new lib.ProbeUsageError('the app builds a body different from expected_body (see the dry run\'s diff paths); nothing sent')

      // ---- live ----
      const records: WireRecord[] = []
      const scanners = new Map<WireRecord, SseScanner>()
      let label = 'raw#0'
      // the fetch under the meter and the budget: Bun's own, taken before the budget takes the global's place, with
      // its Brotli decoding off and the body's coding screened once (CVE-2026-111497; --base-url may be any host)
      const realFetch = safeFetchVia(globalThis.fetch.bind(globalThis)) as (i: string | URL | Request, init?: RequestInit) => Promise<Response>
      const metered = lib.meteredFetch(realFetch, { salt, secrets, label: () => label, onRecord: (r, s) => { if (!scanners.has(r)) { scanners.set(r, s); records.push(r) } } })
      const budget = new lib.FetchBudget(maxFetches, metered, new AbortController())
      const onSigint = () => { budget.cancel(); io.err('cancelled: nothing more is sent; writing the summary') }
      process.on('SIGINT', onSigint)
      try {
        // the global fetch is the budget too: a code path that forgets the injected fetch is still counted and capped
        return await withGlobalFetch((input, init) => budget.fetch(input instanceof Request ? input.url : input, init), async () => {
          io.err(`live: at most ${maxFetches} physical request(s) (the only hard limit), path "${args.flags.get('path-label')}"; rough estimate $${(summary.cost_estimate as { rough_estimate_usd: number }).rough_estimate_usd} — not a quote, not a limit`)
          if (!args.bools.has('yes')) {
            io.err('starting in 10 s — Ctrl-C now to send nothing')
            await io.sleep(10_000)
          }
          const outcomes: Record<string, unknown> = {}
          if (!budget.cancelled && (mode === 'raw' || mode === 'both')) {
            outcomes.raw = await runRaw({ url: `${baseUrl}/v1beta/models/${model}:streamGenerateContent?alt=sse`, key, body: wireBody, budget, socketIdle,
              resume: args.bools.has('raw-resume'), setLabel: (l) => { label = l }, records, scanners, minText, sleep: io.sleep })
          }
          if (!budget.cancelled && (mode === 'pinned' || mode === 'both' || mode === 'app')) {
            let n = 0
            const sentBefore = budget.attempted
            const model = makeModel((i, init) => { label = `${mode === 'app' ? 'app' : 'pinned'}#${n++}`; return budget.fetch(i, init) })
            if (mode !== 'app') {
              // transport, stream handling and the adapter's resume only: the file body goes out unchanged
              const pinned = JSON.stringify(wireBody)
              ;(model as unknown as { body: () => Record<string, unknown> }).body = () => JSON.parse(pinned) as Record<string, unknown>
            }
            const req = appRequest ?? { messages: [], settings: {}, params: { function_tools: [], allow_text_output: true, thinking: null } }
            const name = mode === 'app' ? 'app' : 'pinned'
            const saveTo = args.bools.has('save-text') ? join(runDir, `answer-${name}.private.txt`) : null
            // physical_requests: the adapter's requests that went out (the budget's count); adapter_fetch_calls: every
            // call it made, a refused one (past the budget, after a cancel) among them
            outcomes[name] = { ...await runApp(model, req, budget.controller.signal, () => budget.attempted - sentBefore, saveTo, salt), adapter_fetch_calls: n }
          }
          summary.finished_at = new Date().toISOString()
          summary.budget = { max: maxFetches, physical_requests: budget.attempted, refused: budget.refused, cancelled: budget.cancelled && budget.controller.signal.reason instanceof lib.ProbeCancelledError }
          summary.requests = records.map((r) => ({ ...r, same_body_as_input: r.body_hash_canonical === inputHash, outcome: lib.outcomeOf(r, minText) }))
          summary.outcomes = outcomes
          if (args.bools.has('save-text') && mode === 'raw') summary.answer_text = 'not written: raw mode does not splice the committed text of several hops (pending output past the last checkpoint is not tracked); use --mode pinned or app for the manual review'
          else if (args.bools.has('save-text') && mode === 'both') summary.answer_text = 'written for the pinned run only (raw does not splice hops)'
          const text = lib.writePrivateJson(join(runDir, 'summary.json'), summary, secrets)
          io.out(text)
          io.err(`summary: ${join(runDir, 'summary.json')}`)
          return budget.cancelled && budget.controller.signal.reason instanceof lib.ProbeCancelledError ? 130 : 0
        })
      } finally {
        process.off('SIGINT', onSigint)
      }
    })
  } finally {
    if (setDefaultAuthDir) (setDefaultAuthDir as (p: string | null) => void)(null)
    if (privateAppDir) rmSync(privateAppDir, { recursive: true, force: true })
  }
}

interface RawRun {
  url: string; key: string; body: Record<string, unknown>; budget: lib.FetchBudget; socketIdle: number; resume: boolean
  setLabel: (l: string) => void; records: WireRecord[]; scanners: Map<WireRecord, SseScanner>; minText: number; sleep: (ms: number) => Promise<void>
}

/** The body sent by fetch as it is (the headers the app's postJson sends; a redirect never followed), read to the end
 *  through the meter. With --raw-resume, a drop after a checkpoint, or a CONTINUATION, is followed by the identical
 *  body plus the last continuationToken (the long-decode guide's resume), within the same budget; a drop before any
 *  checkpoint is not restarted. */
async function runRaw(o: RawRun): Promise<Record<string, unknown>> {
  const hops: Record<string, unknown>[] = []
  let token: string | null = null
  for (let hop = 0; ; hop++) {
    o.setLabel(`raw#${hop}`)
    const body = token ? { ...o.body, continuationToken: token } : o.body
    const before = o.records.length
    let response: Response
    try {
      response = await o.budget.fetch(o.url, {
        method: 'POST', redirect: 'manual',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-goog-api-key': o.key },
        body: JSON.stringify(body), signal: AbortSignal.timeout(lib.RAW_WHOLE_DEADLINE_MS),
        // Bun's socket idle timeout (milliseconds, reset by every byte; 0 = off): recorded in the summary
        timeout: o.socketIdle === 0 ? false : o.socketIdle,
      } as RequestInit)
    } catch (error) {
      hops.push({ hop, sent: o.records.length > before, error: lib.errorSummary(error) })
      break
    }
    try {
      const reader = response.body?.getReader()
      if (reader) for (;;) { const r = await reader.read(); if (r.done) break }
    } catch { /* the meter recorded how it ended */ }
    const record = o.records[o.records.length - 1]
    if (!record || o.records.length === before) break
    const outcome = lib.outcomeOf(record, o.minText)
    hops.push({ hop, seq: record.seq, ...outcome, resumed_with_token: token !== null })
    const next = o.scanners.get(record)?.lastToken ?? null
    const resumable = outcome.transport === 'dropped_mid_stream' || outcome.response === 'continuation'
    if (resumable && !next) hops.push({ note: 'no checkpoint before the drop: only a full restart is possible (the probe does not restart)' })
    if (!o.resume || !resumable || !next || o.budget.cancelled || o.budget.attempted >= o.budget.max) break
    token = next
    await o.sleep(lib.RESUME_DELAY_MS)
  }
  return { hops }
}

/** The app's own requestStream, drained; what came back as counts, never its text. */
async function runApp(model: GoogleModelT, req: { messages: lib.AppRequest['messages']; settings: lib.AppRequest['settings']; params: lib.AppRequest['params'] }, signal: AbortSignal, physical: () => number,
  saveTo: string | null, salt: Buffer): Promise<Record<string, unknown>> {
  const t0 = Date.now()
  const out: Record<string, unknown> = {}
  let events = 0
  try {
    const stream = await model.requestStream(req.messages, req.settings, req.params, { signal })
    for await (const _ of stream.events()) events += 1
    const response = stream.get()
    const kinds: Record<string, number> = {}
    let textChars = 0
    for (const p of response.parts) {
      kinds[p.part_kind] = (kinds[p.part_kind] ?? 0) + 1
      if (p.part_kind === 'text') textChars += (p as { content: string }).content.length
    }
    const finish = typeof response.finish_reason === 'string' && /^[a-z_]{1,40}$/.test(response.finish_reason) ? response.finish_reason : null
    const u = response.usage
    // --save-text: the words of the response the adapter returned whole (its text parts only: no thinking, no signature,
    // no token), private (0600), for the person to judge whether it is a complete final answer. Nothing is written for a
    // stream that threw: a cut response's words are not an answer.
    if (saveTo) {
      const words = response.parts.filter((p) => p.part_kind === 'text').map((p) => (p as { content: string }).content).join('')
      writeFileSync(saveTo, words, { mode: 0o600 })
      chmodSync(saveTo, 0o600)
      out.answer_file = { name: basename(saveTo), chars: words.length, hash: lib.keyedHash(salt, words), note: 'private; read it to judge the answer — the summary never does' }
    }
    Object.assign(out, { outcome: 'returned', finish_reason: finish, usage: u ? { input_tokens: u.input_tokens, output_tokens: u.output_tokens, cache_read_tokens: u.cache_read_tokens } : null, parts: kinds, text_chars: textChars,
      final_answer: 'manual_review_needed', note: finish === 'tool_call' ? 'this response ended with a tool call: the model turn ended normally; the task is not finished' : null })
  } catch (error) {
    Object.assign(out, { outcome: 'threw', error: lib.errorSummary(error) })
  }
  Object.assign(out, { events, elapsed_ms: Date.now() - t0, physical_requests: physical() })
  return out
}

// ---- idle test ------------------------------------------------------------------------------------------------

async function idleServer(args: Args, io: Io): Promise<number> {
  const secretEnv = args.flags.get('secret-env') ?? 'IDLE_PROBE_SECRET'
  const secret = process.env[secretEnv] ?? ''
  if (secret.length < 16) throw new lib.ProbeUsageError(`set ${secretEnv} to a random secret of 16+ characters (the same one on the client)`)
  const port = whole(args.flags.get('port'), 8787, 'port', 65535)
  const hostname = args.flags.get('host') ?? '0.0.0.0'
  const cert = args.flags.get('tls-cert'), keyFile = args.flags.get('tls-key')
  if ((cert === undefined) !== (keyFile === undefined)) throw new lib.ProbeUsageError('--tls-cert and --tls-key go together')
  const handler = lib.idleHandler({ secret, log: (e) => io.out(JSON.stringify({ t: new Date().toISOString(), ...e }) + '\n') })
  const server = Bun.serve({
    hostname, port, idleTimeout: 0,
    ...(cert && keyFile ? { tls: { cert: Bun.file(cert), key: Bun.file(keyFile) } } : {}),
    fetch(req, srv) {
      try { srv.timeout(req, 0) } catch { /* idleTimeout 0 covers it */ }
      return handler(req, srv.requestIP(req)?.address ?? null)
    },
  })
  io.err(`idle server on ${cert ? 'https' : 'http'}://${hostname}:${server.port}/idle (Bun server idle timeout off); Ctrl-C to stop`)
  await new Promise<void>((r) => process.once('SIGINT', () => r()))
  server.stop(true)
  return 0
}

async function idleClient(args: Args, io: Io, fixed?: { url: string; secret: string }): Promise<number> {
  const url = fixed?.url ?? args.flags.get('url')
  const outDir = args.flags.get('out')
  if (!url || (!outDir && !fixed)) throw new lib.ProbeUsageError('idle-client needs --url and --out')
  const gaps = (args.flags.get('gaps') ?? '30,55,65,90').split(',').map((g) => Number(g))
  if (gaps.length === 0 || gaps.length > lib.IDLE_MAX_REQUESTS || gaps.some((g) => !Number.isFinite(g) || g < 0 || g > 1200)) throw new lib.ProbeUsageError('--gaps: up to 24 numbers of seconds, 0..1200')
  const num = (name: string, max: number) => { const v = Number(args.flags.get(name) ?? 0); if (!Number.isFinite(v) || v < 0 || v > max) throw new lib.ProbeUsageError(`--${name}: 0..${max}`); return v }
  const plan = { headers_delay_s: num('headers-delay', 1200), heartbeat_s: num('heartbeat', 600), chunk_bytes: whole(args.flags.get('chunk-bytes'), 64, 'chunk-bytes', 1_000_000) }
  const padKb = whole(args.flags.get('request-pad-kb'), 0, 'request-pad-kb', 4096)
  const live = fixed !== undefined || args.bools.has('live')
  const u = new URL(url)
  const summary: Record<string, unknown> = {
    tool: 'argon-probe idle-client', format: 1, live, path_label: args.flags.get('path-label') ?? (fixed ? 'loopback selftest' : null), endpoint: `${u.protocol}//${u.host}${u.pathname}`,
    proxy_env: lib.proxyEnvironment(), bun: Bun.version, plan: { gaps_s: gaps, ...plan, request_pad_kb: padKb },
    warning: u.protocol === 'http:' && u.hostname !== '127.0.0.1' ? 'plain HTTP: a proxy may treat it differently from the TLS stream to Google; prefer https' : null,
  }
  if (!live) {
    io.out(JSON.stringify({ ...summary, network_requests: 0, note: `dry run: nothing sent; ${gaps.length} request(s) with --live` }, null, 2) + '\n')
    return 0
  }
  const secretEnv = args.flags.get('secret-env') ?? 'IDLE_PROBE_SECRET'
  const secret = fixed?.secret ?? process.env[secretEnv] ?? ''
  if (secret.length < 16) throw new lib.ProbeUsageError(`set ${secretEnv} (the server's secret)`)
  if (!fixed && !args.flags.get('path-label')) throw new lib.ProbeUsageError('--live needs --path-label')
  const salt = outDir ? lib.prepareOutputDir(resolve(outDir)).salt : Buffer.alloc(32)
  const secrets = new Set([secret])
  const records: WireRecord[] = []
  // --url may be any host: Bun's fetch with its Brotli decoding off, the coding screened once (CVE-2026-111497)
  const metered = lib.meteredFetch(safeFetchVia(globalThis.fetch.bind(globalThis)), { salt, secrets, label: () => 'idle', onRecord: (r) => { if (!records.includes(r)) records.push(r) } })
  const results: Record<string, unknown>[] = []
  for (const gap of gaps) {
    const body = JSON.stringify({ plan: { gaps_s: [gap], ...plan }, pad: 'x'.repeat(padKb * 1024) })
    // the client never gives up first: Bun's socket idle timeout is off (false — a numeric value was not seen to take
    // effect on Bun 1.4.0) and the whole deadline outlasts the planned silence
    const planned = Math.round((gap + plan.headers_delay_s) * 1000)
    const socketIdle = false as const
    const deadline = Math.max(lib.RAW_WHOLE_DEADLINE_MS, planned + 180_000)
    let done = false, error: lib.ErrorSummary | null = null, chunks = 0
    const before = records.length
    try {
      const res = await metered(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-idle-probe-secret': secret }, body, signal: AbortSignal.timeout(deadline), timeout: socketIdle } as RequestInit)
      const r = await lib.readIdleResponse(res)
      done = r.done; error = r.error; chunks = r.chunks
    } catch (e) { error = lib.errorSummary(e) }
    const rec = records.length > before ? records[records.length - 1] : undefined
    results.push({ gap_s: gap, survived: done, data_chunks: chunks, status: rec?.status ?? null, headers_ms: rec?.headers_ms ?? null, first_byte_ms: rec?.first_byte_ms ?? null,
      end: rec?.end ?? null, end_ms: rec?.end_ms ?? null, silence_at_end_ms: rec?.silence_at_end_ms ?? null, max_gap_ms: rec?.max_gap_ms ?? null,
      bun_socket_idle_timeout: socketIdle, whole_deadline_ms: deadline, error })
    io.err(`gap ${gap}s: ${done ? 'survived' : `dropped (${error?.category ?? 'eof before done'}) at ${rec?.end_ms ?? '?'} ms, silent ${rec?.silence_at_end_ms ?? '?'} ms`}`)
  }
  summary.results = results
  summary.finished_at = new Date().toISOString()
  const text = outDir ? lib.writePrivateJson(join(resolve(outDir), `idle-${stamp()}.json`), summary, secrets) : JSON.stringify(summary, null, 2) + '\n'
  io.out(text)
  return 0
}

async function idleSelftest(args: Args, io: Io): Promise<number> {
  // loopback only: this command's own proxy variables are set aside (and put back) so 127.0.0.1 is reached directly
  const off = Object.fromEntries(['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'].map((n) => [n, undefined]))
  return withEnv(off, async () => {
    const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('hex')
    const handler = lib.idleHandler({ secret, log: (e) => io.err(`server ${JSON.stringify(e)}`) })
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, fetch(req, srv) { try { srv.timeout(req, 0) } catch { /* */ } return handler(req, null) } })
    try {
      if (!args.flags.has('gaps')) args.flags.set('gaps', '1,2')
      return await idleClient(args, io, { url: `http://127.0.0.1:${server.port}/idle`, secret })
    } finally { server.stop(true) }
  })
}

const HELP = `argon probe — docs/argon-probe-runbook.md
  gemini        --out DIR (--body FILE [--mode raw|pinned|both] | --app-request FILE) [--live --max-fetches N --path-label TEXT [--yes]]
                [--key-env NAME] [--raw-resume] [--save-text] [--app-max-retries 0..2] [--socket-idle-ms N] [--min-text-chars N] [--base-url URL] [--model ID]
  idle-server   --port P [--host H] [--tls-cert F --tls-key F] [--secret-env NAME]
  idle-client   --url URL --out DIR [--gaps 30,55,65,90] [--headers-delay S] [--heartbeat S] [--chunk-bytes N] [--request-pad-kb N] [--live --path-label TEXT]
  idle-selftest [--gaps 1,2] [--heartbeat S] [--headers-delay S]`

/** The command line. Errors are printed from a whitelist: the probe's own usage messages whole, anything else as a
 *  name and a category (an error's text can quote the request). */
export async function main(argv: string[], io: Io = defaultIo): Promise<number> {
  try {
    const args = parseArgs(argv)
    if (args.cmd === 'gemini') return await gemini(args, io)
    if (args.cmd === 'idle-server') return await idleServer(args, io)
    if (args.cmd === 'idle-client') return await idleClient(args, io)
    if (args.cmd === 'idle-selftest') return await idleSelftest(args, io)
    io.err(HELP)
    return 0
  } catch (error) {
    if (error instanceof lib.ProbeUsageError) { io.err(`argon-probe: ${error.message}`); if (/unknown|unexpected|needs a value|twice/.test(error.message)) io.err(HELP); return 2 }
    const e = lib.errorSummary(error)
    io.err(`argon-probe: failed (${e.name}, ${e.category}); no request text is printed`)
    return 1
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)))
