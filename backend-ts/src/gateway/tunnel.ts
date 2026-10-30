/** The tunnel the gateway keeps up for a configured provider: one child process, started with fixed arguments (no
 *  secret in them: tokens are read from 0600 files by the tool itself), restarted with a growing wait when it dies,
 *  stopped with the gateway. `external` starts nothing (another tunnel the person runs brings the public name here);
 *  `quick` is a Cloudflare quick tunnel, only for an explicit test run (`gateway --quick`). */

import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { CLOUDFLARED_TOKEN_FILE, NGROK_CONFIG_FILE, gatewayDir, readProviderToken, writePrivate, type Provider } from './config.ts'

export const CLOUDFLARED_BINS = ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared']
export const NGROK_BINS = ['/opt/homebrew/bin/ngrok', '/usr/local/bin/ngrok']
export const CLOUDFLARED_CONFIG_FILE = 'cloudflared.yml'

/** The tunnel's whole environment: a fixed PATH and a HOME of its own (the gateway's folder), nothing inherited — no
 *  TUNNEL_TOKEN / TUNNEL_* / CLOUDFLARE_* / NGROK_* from wherever the gateway was started (cloudflared's TUNNEL_TOKEN
 *  would take precedence over --token-file), no default config of the person's under their home. */
export function tunnelEnv(dataDir: string): Record<string, string> {
  return { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: gatewayDir(dataDir), LANG: 'en_US.UTF-8' }
}

export interface TunnelCommand { command: string; args: string[] }

function firstExisting(paths: readonly string[], exists: (p: string) => boolean): string | null {
  return paths.find((p) => exists(p)) ?? null
}

/** The command for a provider, or why there is none. ngrok's config (its authtoken) is written here, 0600, from the
 *  token file: it is passed as --config so the person's own ngrok config is never read; its inspector is off (it
 *  would keep request bodies — the secret path and tool data — on a local web page). */
export function tunnelCommand(provider: Provider | 'quick', opts: { dataDir: string; port: number; host: string | null; exists?: (p: string) => boolean }): { cmd: TunnelCommand | null; why: string | null } {
  const exists = opts.exists ?? existsSync
  const origin = `http://127.0.0.1:${opts.port}`
  if (provider === 'external') return { cmd: null, why: null }
  if (provider === 'quick' || provider === 'cloudflare') {
    const bin = firstExisting(CLOUDFLARED_BINS, exists)
    if (!bin) return { cmd: null, why: 'cloudflared is not installed (brew install cloudflared)' }
    // a config file of its own (empty): the person's ~/.cloudflared/config.yml is never read
    const config = join(gatewayDir(opts.dataDir), CLOUDFLARED_CONFIG_FILE)
    // a valid, non-empty document (an empty one makes cloudflared log an ERR on every start); no token in it. HTTP/2 to
    // the edge (TCP 443): QUIC's UDP is blocked on many networks, where cloudflared keeps dialing it and never falls
    // back, until a quick tunnel is gone for good
    writePrivate(config, '# oasis-code gateway: its own settings only; a named tunnel\'s token comes from --token-file\nno-autoupdate: true\nprotocol: http2\n')
    if (provider === 'quick') return { cmd: { command: bin, args: ['tunnel', '--config', config, '--no-autoupdate', '--url', origin] }, why: null }
    if (!readProviderToken(opts.dataDir, 'cloudflare')) return { cmd: null, why: 'no Cloudflare tunnel token saved' }
    // a remotely managed tunnel: its public hostname routes to the gateway's port in Cloudflare's dashboard
    return { cmd: { command: bin, args: ['tunnel', '--config', config, '--no-autoupdate', 'run', '--token-file', join(gatewayDir(opts.dataDir), CLOUDFLARED_TOKEN_FILE)] }, why: null }
  }
  const bin = firstExisting(NGROK_BINS, exists)
  if (!bin) return { cmd: null, why: 'ngrok is not installed (brew install ngrok)' }
  const authtoken = readProviderToken(opts.dataDir, 'ngrok')
  if (!authtoken) return { cmd: null, why: 'no ngrok authtoken saved' }
  if (!opts.host) return { cmd: null, why: 'no ngrok domain configured' }
  const config = join(gatewayDir(opts.dataDir), NGROK_CONFIG_FILE)
  writePrivate(config, `version: "3"\nagent:\n  authtoken: ${JSON.stringify(authtoken)}\n  update_check: false\n`)
  return { cmd: { command: bin, args: ['http', origin, '--url', `https://${opts.host}`, '--config', config, '--inspect=false', '--log', 'stdout', '--log-format', 'logfmt'] }, why: null }
}

/** A quick tunnel's hostname in cloudflared's output. */
export function quickHostOf(text: string): string | null {
  const m = /https:\/\/([a-z0-9-]+\.trycloudflare\.com)/.exec(text)
  return m ? m[1]! : null
}

/** The quick test tunnel's name after `text`: a new trycloudflare name replaces the one before (a restarted quick
 *  tunnel comes back under another name — it is never a fixed address); text without one keeps it. */
export function quickHostAfter(current: string | null, text: string): string | null {
  return quickHostOf(text) ?? current
}

/** Whether the tool says its tunnel is up (a hint only: the gateway believes the public name once it answers). */
export function tunnelUpIn(provider: Provider | 'quick', text: string): boolean {
  if (provider === 'ngrok') return /started tunnel|url=https:\/\//.test(text)
  return /Registered tunnel connection|trycloudflare\.com/.test(text)
}

export const RESTART_MS = [2_000, 5_000, 15_000, 60_000] as const
export const STABLE_MS = 5 * 60_000

/** The next wait before a restart, after `restarts` restarts in a row without a stable run. */
export function restartDelay(restarts: number, ladder: readonly number[] = RESTART_MS): number {
  return ladder[Math.min(restarts, ladder.length - 1)]!
}

/** What the supervisor needs of a child process (node's ChildProcess, or a test's fake). */
export interface ChildLike {
  stdout?: { on(event: 'data', fn: (d: Buffer) => void): unknown } | null
  stderr?: { on(event: 'data', fn: (d: Buffer) => void): unknown } | null
  on(event: 'exit', fn: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  on(event: 'error', fn: (error: Error) => void): unknown
  kill(signal?: NodeJS.Signals): boolean
}

export interface SupervisorOptions {
  command: () => { cmd: TunnelCommand | null; why: string | null }
  spawn: (command: string, args: string[]) => ChildLike
  onOutput?: (text: string) => void
  /** the child ended (exit, or a spawn that failed: ENOENT), with the wait before the next start */
  onEnded?: (why: string, waitMs: number) => void
  onNoCommand?: (why: string) => void
  log?: (line: string) => void
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
  ladder?: readonly number[]
  stableMs?: number
  killMs?: number
  graceMs?: number
}

/** One tunnel child at a time: started, restarted up the ladder when it ends (an exit, or an `error` — a spawn that
 *  failed never exits — each settled once), stopped with SIGTERM, SIGKILL after `killMs`, and given up on after
 *  `graceMs` more: `stop()` always resolves. */
export class TunnelSupervisor {
  private child: ChildLike | null = null
  private restarts = 0
  private since = 0
  private timer: unknown = null
  private stopped = false
  private ending: Promise<void> | null = null
  private endChild: (() => void) | null = null
  readonly spawned: ChildLike[] = []
  private readonly o: Required<Omit<SupervisorOptions, 'onOutput' | 'onEnded' | 'onNoCommand' | 'log'>> & SupervisorOptions
  constructor(opts: SupervisorOptions) {
    this.o = { now: Date.now, setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>), ladder: RESTART_MS, stableMs: STABLE_MS, killMs: 3_000, graceMs: 1_000, ...opts }
  }
  get running(): boolean { return this.child !== null }
  start(): void {
    if (this.stopped || this.child) return
    const { cmd, why } = this.o.command()
    if (why) { this.o.onNoCommand?.(why); return }
    if (!cmd) return
    this.o.log?.(`[gateway] starting ${cmd.command} ${cmd.args.join(' ')}`)
    let child: ChildLike
    try { child = this.o.spawn(cmd.command, cmd.args) } catch (error) { this.ended(null, `the tunnel did not start (${(error as Error).message})`); return }
    this.child = child
    this.spawned.push(child)
    this.since = this.o.now()
    let settled = false
    let resolveEnd: () => void = () => {}
    this.ending = new Promise<void>((r) => { resolveEnd = r })
    const settle = (why: string) => {
      if (settled) return
      settled = true
      resolveEnd()
      this.ended(child, why)
    }
    this.endChild = () => settle('stopped')
    const hear = (d: Buffer) => this.o.onOutput?.(String(d))
    child.stdout?.on('data', hear)
    child.stderr?.on('data', hear)
    child.on('error', (error) => settle(`the tunnel did not start or failed (${error.message})`))
    child.on('exit', (code, signal) => settle(`the tunnel exited (code ${code}, signal ${signal})`))
  }
  private ended(child: ChildLike | null, why: string): void {
    if (child && this.child === child) { this.child = null; this.endChild = null }
    if (this.stopped) return
    if (this.o.now() - this.since >= this.o.stableMs) this.restarts = 0
    const wait = restartDelay(this.restarts, this.o.ladder)
    this.restarts += 1
    this.o.onEnded?.(why, wait)
    if (this.timer !== null) this.o.clearTimer(this.timer)
    this.timer = this.o.setTimer(() => { this.timer = null; this.start() }, wait)
  }
  /** No restart from now on; the child asked to stop, killed if it stays; resolves in at most killMs + graceMs. */
  stop(): Promise<void> {
    this.stopped = true
    if (this.timer !== null) { this.o.clearTimer(this.timer); this.timer = null }
    const child = this.child
    if (!child) return Promise.resolve()
    const ending = this.ending ?? Promise.resolve()
    return new Promise<void>((resolve) => {
      let hard: unknown = null
      let grace: unknown = null
      const done = () => { if (hard !== null) this.o.clearTimer(hard); if (grace !== null) this.o.clearTimer(grace); this.child = null; resolve() }
      void ending.then(done)
      try { child.kill('SIGTERM') } catch { /* gone */ }
      hard = this.o.setTimer(() => {
        try { child.kill('SIGKILL') } catch { /* gone */ }
        grace = this.o.setTimer(() => { this.endChild?.(); done() }, this.o.graceMs)
      }, this.o.killMs)
    })
  }
}
