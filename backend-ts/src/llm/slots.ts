/** Request slots: at most N provider requests in flight per scope (an endpoint / credential / model family the
 *  operator configured). The slot wraps ONE request — a run holds nothing between requests, nothing while it runs
 *  a command, nothing while it waits — and a run that waits for a slot says so with slot_wait, every time, not only
 *  before its first request. Adapted from oasis agent/runner.py ModelSlot / Serialized (see NOTICE). */

import type { ModelMessage, ModelResponse } from './messages.ts'
import { WrapperModel, type Model, type ModelRequestParameters, type ModelSettings, type RequestContext, type StreamedResponse } from './model.ts'

/** The run was stopped while it waited for a slot: no request was made. */
export class QueueCancelled extends Error {
  constructor(message: string) { super(message); this.name = 'QueueCancelled' }
}

const POLL_MS = 250

export class ModelSlot {
  readonly holders: string[] = []
  readonly waiters: string[] = []
  private inFlight = 0
  private readonly queue: (() => void)[] = []

  constructor(readonly scope: string, readonly limit: number) {}

  get locked(): boolean { return this.inFlight >= this.limit }

  busyFor(runId: string): string[] {
    return [...this.holders, ...this.waiters].filter((r) => r !== runId)
  }

  private acquire(): Promise<void> {
    if (this.inFlight < this.limit) { this.inFlight += 1; return Promise.resolve() }
    return new Promise((resolve) => this.queue.push(() => { this.inFlight += 1; resolve() }))
  }

  private release(): void {
    this.inFlight -= 1
    const next = this.queue.shift()
    if (next) next()
  }

  /** Hold the slot around `fn`; `cancelled` is polled while queued. */
  async hold<T>(runId: string, cancelled: () => boolean, onWait: ((behind: string[]) => void) | null, fn: (waited: boolean) => Promise<T>): Promise<T> {
    const { waited, release } = await this.take(runId, cancelled, onWait)
    try {
      return await fn(waited)
    } finally {
      release()
    }
  }

  /** Take the slot, queued in turn (`cancelled` is polled while queued: a stopped run leaves the queue with
   *  QueueCancelled), and hold it until the returned release is called (once; a second call does nothing). */
  async take(runId: string, cancelled: () => boolean, onWait: ((behind: string[]) => void) | null): Promise<{ waited: boolean; release: () => void }> {
    let waited = false
    if (this.locked) {
      waited = true
      if (onWait) onWait(this.busyFor(runId))
    }
    this.waiters.push(runId)
    try {
      let acquired = false
      const pending = this.acquire().then(() => { acquired = true })
      while (!acquired) {
        await Promise.race([pending, new Promise((r) => setTimeout(r, POLL_MS))])
        if (!acquired && cancelled()) {
          // drop out of the queue: when the slot frees for us later, hand it straight back
          pending.then(() => this.release())
          throw new QueueCancelled(`run ${runId} was stopped while queued for ${this.scope}`)
        }
      }
    } finally {
      this.waiters.splice(this.waiters.indexOf(runId), 1)
    }
    this.holders.push(runId)
    let released = false
    return {
      waited,
      release: () => {
        if (released) return
        released = true
        this.holders.splice(this.holders.indexOf(runId), 1)
        this.release()
      },
    }
  }
}

export type Emit = (event: string, data: Record<string, unknown>) => void

/** Takes the scope's slot around each provider request. */
export class Serialized extends WrapperModel {
  constructor(wrapped: Model, readonly slot: ModelSlot, readonly run_id: string, readonly cancelled: () => boolean, readonly emit: Emit) {
    super(wrapped)
  }

  private onWait = (behind: string[]): void => {
    this.emit('slot_wait', { scope: this.slot.scope, limit: this.slot.limit, behind })
  }

  override request(messages: ModelMessage[], settings: ModelSettings, params: ModelRequestParameters, ctx?: RequestContext): Promise<ModelResponse> {
    return this.slot.hold(this.run_id, this.cancelled, this.onWait, async (waited) => {
      if (waited) this.emit('slot_acquired', { scope: this.slot.scope })
      return super.request(messages, settings, params, ctx)
    })
  }

  /** The slot is held until the stream ends (the request is in flight until then). */
  override async requestStream(messages: ModelMessage[], settings: ModelSettings, params: ModelRequestParameters, ctx?: RequestContext): Promise<StreamedResponse> {
    // taken once, in turn and Stop-able while queued, and held for the stream's lifetime, not only the request's
    const { waited, release } = await this.slot.take(this.run_id, this.cancelled, this.onWait)
    if (waited) this.emit('slot_acquired', { scope: this.slot.scope })
    let stream: StreamedResponse
    try {
      stream = await super.requestStream(messages, settings, params, ctx)
    } catch (error) {
      release()
      throw error
    }
    const events = async function* () {
      try {
        yield* stream.events()
      } finally {
        release()
      }
    }
    return { events, get: () => stream.get(), usage: () => stream.usage(), get model_name() { return stream.model_name } }
  }
}

export class SlotRegistry {
  readonly slots = new Map<string, ModelSlot>()

  slotFor(scope: string, limit: number | null | undefined): ModelSlot | null {
    if (!limit) return null
    let slot = this.slots.get(scope)
    if (!slot) {
      slot = new ModelSlot(scope, limit)
      this.slots.set(scope, slot)
    }
    return slot
  }
}
