/** Whether the public name reaches this gateway: `GET https://<host>/healthz` answered by this gateway's instance.
 *  Every probe is a request through the tunnel (ngrok's free plan counts 20,000 a month), so it runs at start, right
 *  after the tunnel says it (re)connected, and otherwise every five minutes — never on a short loop; the app reads the
 *  local status file as often as it likes instead. A redirect is not followed: an answer that is not this gateway's
 *  own is not a connection. */

import type { FetchLike } from '../director/harness.ts'
import { safeFetch } from '../safe_fetch.ts'
import { GATEWAY_SERVER } from './app.ts'

export const PROBE_EVERY_MS = 5 * 60_000
/** the least time between two probes, however often a reconnect asks for one */
export const PROBE_MIN_GAP_MS = 30_000
export const PROBE_FIRST_MS = 5_000
export const PROBE_TIMEOUT_MS = 10_000

export type ProbeResult = { ok: true } | { ok: false; why: string }

export async function probeOnce(host: string, instance: string, fetchImpl: FetchLike = (i, init) => safeFetch(i, init)): Promise<ProbeResult> {
  try {
    const res = await fetchImpl(`https://${host}/healthz`, { redirect: 'manual', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    if (res.status >= 300 && res.status < 400) return { ok: false, why: `https://${host}/healthz redirected (${res.status}); not followed` }
    const body = await res.json().catch(() => null) as { server?: string; instance?: string } | null
    if (res.ok && body?.server === GATEWAY_SERVER && body.instance === instance) return { ok: true }
    return { ok: false, why: `https://${host}/healthz answered ${res.status}${body?.server ? ` as ${body.server}` : ''}, not as this gateway` }
  } catch (error) {
    return { ok: false, why: `https://${host} did not answer (${(error as Error).message})` }
  }
}

export interface ProbeSchedulerOptions {
  run: () => Promise<void>
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
  everyMs?: number
  minGapMs?: number
  firstMs?: number
}

/** When the probe runs: once soon after start, then every `everyMs`; `kick()` (the tunnel reconnected) brings the next
 *  one forward to now, but never closer than `minGapMs` after the last. One probe at a time. */
export class ProbeScheduler {
  private timer: unknown = null
  private last = -Infinity
  private running = false
  private stopped = false
  private readonly o: Required<ProbeSchedulerOptions>
  constructor(opts: ProbeSchedulerOptions) {
    this.o = {
      now: Date.now, setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
      everyMs: PROBE_EVERY_MS, minGapMs: PROBE_MIN_GAP_MS, firstMs: PROBE_FIRST_MS, ...opts,
    }
  }
  start(): void { this.arm(this.o.firstMs) }
  kick(): void {
    if (this.stopped) return
    const wait = Math.max(0, this.last + this.o.minGapMs - this.o.now())
    this.arm(wait)
  }
  stop(): void { this.stopped = true; if (this.timer !== null) this.o.clearTimer(this.timer); this.timer = null }
  private arm(ms: number): void {
    if (this.stopped) return
    if (this.timer !== null) this.o.clearTimer(this.timer)
    this.timer = this.o.setTimer(() => { this.timer = null; void this.fire() }, ms)
  }
  private async fire(): Promise<void> {
    if (this.stopped) return
    if (this.running || this.o.now() - this.last < this.o.minGapMs) { this.arm(Math.max(1, this.last + this.o.minGapMs - this.o.now())); return }
    this.running = true
    this.last = this.o.now()
    try { await this.o.run() } finally { this.running = false }
    this.arm(this.o.everyMs)
  }
}
