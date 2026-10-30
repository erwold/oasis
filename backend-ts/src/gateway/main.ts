/** `oasis-code gateway …`: the MCP ingress that stays up on its own (a per-user launchd agent the desktop app
 *  installs when the person turns remote access on), so the public URL ChatGPT holds does not depend on the app
 *  running. It serves the director's tools itself (no director process in between) and keeps the tunnel of the
 *  configured provider up.
 *
 *    gateway [run] [--port N] [--quick]   serve on 127.0.0.1:N (OASIS_CODE_GATEWAY_PORT, 8324); --quick: a Cloudflare
 *                                         quick tunnel whatever is set up
 *    gateway setup --provider P --host H  save the provider and its fixed public host; a token (Cloudflare tunnel
 *                                         token, ngrok authtoken) is read from stdin, never from the command line;
 *                                         `--provider quick` (no host) goes back to the quick tunnel
 *    gateway url                          the public URL (JSON on stdout; it carries the external secret)
 *    gateway revoke                       a new external secret: the old URL stops answering (JSON: the new URL)
 *    gateway status                       what the running gateway last wrote (no URL, no secret)
 *    gateway version                      the code this command runs (compared with the running gateway's)
 *
 *  Without a configured provider it runs a Cloudflare quick tunnel: its name changes whenever the gateway starts again
 *  (a reboot, the tunnel's own restart), not when the app does. Everything it prints goes to stderr except the JSON
 *  answers above. */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { getSettings } from '../config.ts'
import { sourceFingerprint } from '../version.ts'
import { BACKEND_UNAVAILABLE, buildGatewayApp, GATEWAY_SERVER } from './app.ts'
import { join } from 'node:path'
import { checkProviderToken, CONFIG_FILE, DEFAULT_GATEWAY_PORT, gatewayDir, ensureSecret, normalizeHost, providerTokenPath, PROVIDERS, removeFile, readConfig, readProviderToken, readSecret, readSessionToken, readStatus, rotateSecret, writeConfig, writeProviderToken, writeStatus, type GatewayStatus, type Provider } from './config.ts'
import { probeOnce, ProbeScheduler } from './probe.ts'
import { HEADER } from '../api/auth.ts'
import { safeFetch } from '../safe_fetch.ts'
import { quickHostAfter, tunnelCommand, tunnelEnv, TunnelSupervisor, tunnelUpIn } from './tunnel.ts'

export { BACKEND_UNAVAILABLE }

const USAGE = 'usage: oasis-code gateway [run] [--port N] [--quick] | setup --provider quick|cloudflare|ngrok|external [--host HOST] | url | revoke | status | version'

export function gatewayPort(env: Record<string, string | undefined> = process.env): number {
  const raw = env.OASIS_CODE_GATEWAY_PORT
  const n = raw ? Number(raw) : DEFAULT_GATEWAY_PORT
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`OASIS_CODE_GATEWAY_PORT is not a port: ${raw}`)
  return n
}

export function publicUrl(host: string, secret: string): string {
  return `https://${host}/${secret}/mcp/current`
}

/** Every secret this process knows, masked in a line it prints (a tool's output included). */
function redactor(dataDir: string): (line: string) => string {
  return (line) => {
    let out = line
    for (const s of [readSecret(dataDir), readSessionToken(dataDir), readProviderToken(dataDir, 'cloudflare'), readProviderToken(dataDir, 'ngrok')]) {
      if (s && s.length >= 8) out = out.split(s).join('…')
    }
    return out.replace(/\/[A-Za-z0-9_-]{16,}(\/mcp\b)/g, '/…$1').replace(/(authtoken|token)([=: ]+)\S+/gi, '$1$2…')
  }
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8').trim()
}

interface RunOptions { port: number; quick: boolean }

async function run(opts: RunOptions): Promise<number> {
  const settings = getSettings()
  const dataDir = settings.data_dir
  const redact = redactor(dataDir)
  const log = (line: string) => process.stderr.write(`${new Date().toISOString()} ${redact(line)}\n`)
  ensureSecret(dataDir)
  const config = opts.quick ? null : readConfig(dataDir)
  const provider: Provider | 'quick' = config?.provider ?? 'quick'
  let host: string | null = config?.host ?? null
  const instance = randomBytes(12).toString('base64url')
  const started = new Date().toISOString()
  const status: GatewayStatus = {
    pid: process.pid, instance, started_at: started, updated_at: started, port: opts.port, provider, host,
    public: 'starting', public_checked_at: null, backend: 'unknown', backend_checked_at: null, error: null,
    build: sourceFingerprint(),
  }
  const save = () => { status.updated_at = new Date().toISOString(); status.host = host; try { writeStatus(dataDir, status) } catch (error) { log(`[gateway] status not written: ${(error as Error).message}`) } }

  const app = buildGatewayApp({ dataDir, harnessPort: settings.port, host: () => host, instance, log })
  let server: ReturnType<typeof Bun.serve>
  try {
    server = Bun.serve({ hostname: '127.0.0.1', port: opts.port, fetch: app.fetch, idleTimeout: 255 })
  } catch (error) {
    log(`[gateway] cannot listen on 127.0.0.1:${opts.port}: ${(error as Error).message}`)
    return 1
  }
  status.port = server.port ?? opts.port
  log(`[gateway] ${GATEWAY_SERVER} on 127.0.0.1:${server.port} (provider ${provider}${host ? `, host ${host}` : ''}, backend 127.0.0.1:${settings.port}, data ${dataDir})`)
  save()

  let stopping = false
  const tunnel = new TunnelSupervisor({
    command: () => tunnelCommand(provider, { dataDir, port: status.port, host }),
    spawn: (command, args) => spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: tunnelEnv(dataDir) }),
    log,
    onNoCommand: (why) => { status.public = 'unavailable'; status.error = why; save(); log(`[gateway] tunnel: ${why}`) },
    onOutput: (text) => {
      for (const line of text.split('\n')) if (line.trim()) log(`[tunnel] ${line.trimEnd()}`)
      // a quick tunnel that restarted comes back under a new name: follow it (the old one is gone for good)
      if (provider === 'quick') { const h = quickHostAfter(host, text); if (h !== host) { host = h; status.public = 'starting'; save(); log(`[gateway] quick tunnel host ${h}`) } }
      // the tunnel says it (re)connected: one probe now (rate limited), not a loop
      if (tunnelUpIn(provider, text) && status.public !== 'connected') probes.kick()
    },
    // the child's end is known here at once: offline without asking the public name
    onEnded: (why, wait) => { status.public = 'unavailable'; status.error = `${why}; starting it again in ${wait / 1000} s`; save(); log(`[gateway] ${status.error}`) },
  })
  const startTunnel = () => tunnel.start()

  // the public name is believed once it answers as this gateway (its instance), through whatever tunnel carries it;
  // probed at start, after a reconnect and every five minutes (each probe is a request a provider may count)
  const probes = new ProbeScheduler({
    run: async () => {
      if (stopping) return
      if (!host) { status.public = 'starting'; save(); return }
      const result = await probeOnce(host, instance)
      if (result.ok) { status.public = 'connected'; status.error = null }
      else { status.public = Date.now() - Date.parse(started) < 90_000 && status.public !== 'connected' ? 'starting' : 'unavailable'; status.error = result.why }
      status.public_checked_at = new Date().toISOString()
      save()
    },
  })
  let backendWhy: string | null = null
  const checkBackend = async () => {
    const seen = await backendState(settings.port, dataDir)
    status.backend = seen.state
    if (seen.why !== backendWhy) { backendWhy = seen.why; if (seen.why) log(`[gateway] backend: ${seen.why}`) }
    status.backend_checked_at = new Date().toISOString()
    save()
  }

  startTunnel()
  await checkBackend()
  const timers = [setInterval(() => void checkBackend(), 15_000)]
  probes.start()

  await new Promise<void>((resolve) => {
    const stop = () => {
      if (stopping) return
      stopping = true
      for (const t of timers) clearInterval(t)
      probes.stop()
      log('[gateway] stopping')
      void tunnel.stop().then(() => { server.stop(true); resolve() })
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
  })
  return 0
}

/** Whether this data directory's backend answers AND accepts its session token (a light authenticated read): the
 *  public /api/meta/build alone would call a backend of another data directory, or one that minted a new token the
 *  file does not hold yet, "up". The token goes in the header only, never into a log line. */
export async function backendState(port: number, dataDir: string, fetchImpl: (input: string, init?: RequestInit) => Promise<Response> = safeFetch): Promise<{ state: 'up' | 'down'; why: string | null }> {
  try {
    const build = await fetchImpl(`http://127.0.0.1:${port}/api/meta/build`, { signal: AbortSignal.timeout(3_000) })
    if (!build.ok) return { state: 'down', why: `/api/meta/build answered ${build.status}` }
    const token = readSessionToken(dataDir)
    if (!token) return { state: 'down', why: 'no session token in the data directory' }
    const res = await fetchImpl(`http://127.0.0.1:${port}/api/models`, { headers: { [HEADER]: token, accept: 'application/json' }, signal: AbortSignal.timeout(3_000) })
    if (res.status === 401) return { state: 'down', why: 'the backend on this port rejected this data directory\'s session token' }
    return res.ok ? { state: 'up', why: null } : { state: 'down', why: `/api/models answered ${res.status}` }
  } catch {
    return { state: 'down', why: null }
  }
}

/** The provider and public name there are now: the one set up, else the quick tunnel's name as the running gateway
 *  last wrote it (none while it starts). */
function publicName(dataDir: string): { provider: Provider | 'quick'; host: string | null } {
  const config = readConfig(dataDir)
  if (config) return { provider: config.provider, host: config.host }
  const status = readStatus(dataDir)
  return { provider: 'quick', host: status?.provider === 'quick' ? status.host : null }
}

function out(value: unknown): void { process.stdout.write(`${JSON.stringify(value)}\n`) }

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const [first, ...rest] = argv
  const sub = first === undefined || first.startsWith('--') ? 'run' : first
  const args = first === undefined || first.startsWith('--') ? argv : rest
  const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
  try {
    const dataDir = getSettings().data_dir
    if (sub === 'run') {
      for (let i = 0; i < args.length; i += 1) {
        if (args[i] === '--quick') continue
        if (args[i] === '--port') { i += 1; continue }
        throw new Error(`unknown option ${args[i]}\n${USAGE}`)
      }
      const port = flag('--port') !== undefined ? Number(flag('--port')) : gatewayPort()
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`--port is not a port\n${USAGE}`)
      return await run({ port, quick: args.includes('--quick') })
    }
    if (sub === 'setup') {
      if (flag('--provider') === 'quick') {
        removeFile(join(gatewayDir(dataDir), CONFIG_FILE))
        ensureSecret(dataDir)
        out({ provider: 'quick', host: null, token_set: null })
        return 0
      }
      const provider = flag('--provider') as Provider | undefined
      if (!provider || !PROVIDERS.includes(provider)) throw new Error(`--provider must be one of quick, ${PROVIDERS.join(', ')}\n${USAGE}`)
      const token = await readStdin()
      // everything checked before anything is written: a refused setup leaves the one before as it was
      const { host, why } = normalizeHost(flag('--host') ?? '')
      if (!host) throw new Error(why ?? 'invalid host')
      if (provider !== 'external') {
        if (token) checkProviderToken(token)
        else if (!readProviderToken(dataDir, provider)) throw new Error(`a ${provider === 'cloudflare' ? 'Cloudflare tunnel token' : 'ngrok authtoken'} is needed (on stdin)`)
      }
      const before = provider !== 'external' && token ? readProviderToken(dataDir, provider) : null
      if (provider !== 'external' && token) writeProviderToken(dataDir, provider, token)
      let config
      try {
        config = writeConfig(dataDir, { provider, host })
      } catch (error) {
        if (provider !== 'external' && token) { if (before) writeProviderToken(dataDir, provider, before); else removeFile(providerTokenPath(dataDir, provider)) }
        throw error
      }
      ensureSecret(dataDir)
      out({ provider: config.provider, host: config.host, token_set: provider === 'external' ? null : true })
      return 0
    }
    if (sub === 'url') {
      const { provider, host } = publicName(dataDir)
      out({ url: host ? publicUrl(host, ensureSecret(dataDir)) : null, provider, host })
      return 0
    }
    if (sub === 'revoke') {
      const secret = rotateSecret(dataDir)
      const { host } = publicName(dataDir)
      out({ url: host ? publicUrl(host, secret) : null })
      return 0
    }
    if (sub === 'status') { out(readStatus(dataDir)); return 0 }
    if (sub === 'version') { out({ build: sourceFingerprint() }); return 0 }
    throw new Error(`unknown command ${sub}\n${USAGE}`)
  } catch (error) {
    process.stderr.write(`gateway: ${(error as Error).message}\n`)
    return 2
  }
}

if (import.meta.main) process.exit(await main())
