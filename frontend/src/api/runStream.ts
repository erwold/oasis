/** Reconnect only the event subscription, never the chat POST or a tool execution. */
export interface RunEvent { event: string; data: Record<string, unknown>; id?: string }
export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'closed'
export interface EventSourceLike {
  addEventListener(type: string, listener: (event: any) => void): void
  close(): void
}
export interface StreamOptions {
  names: readonly string[]
  after?: number | null
  source: (after: number | null) => EventSourceLike
  event: (event: RunEvent) => void
  finished: () => void
  connection?: (state: ConnectionState) => void
  schedule?: (callback: () => void, delay: number) => unknown
  unschedule?: (timer: unknown) => void
  random?: () => number
  /** asked when the transport drops: has the run ended? A server ends the stream of a finished (or lost) run with
   *  nothing left to send, which reads as a drop; such a stream is closed as finished instead of retried forever */
  settled?: () => Promise<boolean>
  /** the event that ends the stream (a run's run_finished by default; a director turn's turn_finished) */
  endEvent?: string
}
export function createRunStream(options: StreamOptions): { close: () => void; reconnect: () => void } {
  const schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms))
  const unschedule = options.unschedule ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>))
  const random = options.random ?? Math.random
  let cursor = Number.isSafeInteger(options.after) && options.after! >= 0 ? options.after! : -1
  let source: EventSourceLike | null = null
  let timer: unknown = null
  let disposed = false
  let generation = 0
  let failures = 0
  const clearTimer = () => { if (timer !== null) { unschedule(timer); timer = null } }
  const disconnect = () => { generation += 1; source?.close(); source = null }
  const close = () => {
    if (disposed) return
    disposed = true; clearTimer(); disconnect(); options.connection?.('closed')
  }
  const retry = () => {
    if (disposed || timer !== null) return
    disconnect(); options.connection?.('reconnecting')
    const cap = Math.min(30_000, 1_000 * 2 ** Math.min(failures++, 5))
    const delay = Math.round(cap * (0.5 + random() * 0.5))
    timer = schedule(() => { timer = null; connect() }, delay)
  }
  const dropped = () => {
    if (!options.settled) { retry(); return }
    disconnect()
    const asked = generation // a reconnect meanwhile (online, visible) owns the stream from then on
    options.settled().then(
      (over) => { if (disposed || generation !== asked) return; if (over) { close(); options.finished() } else retry() },
      () => { if (!disposed && generation === asked) retry() },
    )
  }
  const connect = () => {
    if (disposed) return
    const current = ++generation
    options.connection?.(failures ? 'reconnecting' : 'connecting')
    let next: EventSourceLike
    try { next = options.source(cursor < 0 ? null : cursor) } catch { retry(); return }
    source = next
    const stale = () => disposed || generation !== current || source !== next
    const handle = (event: { type: string; data?: unknown; lastEventId?: string }) => {
      if (stale() || typeof event.data !== 'string') return // a transport ErrorEvent is NOT an application error
      const id = event.lastEventId ?? ''
      const seq = /^\d+$/.test(id) ? Number(id) : NaN
      if (id && (!Number.isSafeInteger(seq) || seq < 0)) { retry(); return }
      if (id && seq <= cursor) return
      let data: unknown
      try { data = JSON.parse(event.data) } catch { retry(); return }
      if (!data || typeof data !== 'object' || Array.isArray(data)) { retry(); return }
      // Advance only after a complete, accepted event. A malformed frame is replayed, not skipped.
      try { options.event({ event: event.type, data: data as Record<string, unknown>, ...(id ? { id } : {}) }) }
      catch { retry(); return }
      if (stale()) return
      if (id) cursor = seq
      failures = 0; options.connection?.('connected')
      if (event.type === (options.endEvent ?? 'run_finished')) { close(); options.finished() }
    }
    for (const name of new Set([...options.names, 'message'])) next.addEventListener(name, handle)
    next.addEventListener('open', () => { if (!stale()) options.connection?.('connected') })
    next.addEventListener('error', (event: { data?: unknown }) => {
      if (!stale() && typeof event.data !== 'string') dropped()
    })
  }
  connect()
  return { close, reconnect: () => { if (!disposed) { clearTimer(); disconnect(); connect() } } }
}
