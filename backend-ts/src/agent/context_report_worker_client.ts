/** One lazy worker for context reports, not for runner budgeting. One dispatched job at a time; bounded input
 * retention, jobs, callers and end-to-end deadlines. Only EXACT in-flight snapshots coalesce; no result cache.
 * Failure never falls back to expensive synchronous work on the API loop. A later job can start a fresh worker. */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ContextReportInput, ContextReportResult } from './context_report_compute.ts'

/** Same source/bundle/embedded-root convention as the fork watcher and live projector. */
export function contextReportWorkerEntry(): string | null {
  const here = import.meta.url
  const candidates: string[] = []
  if (here.startsWith('file:')) {
    candidates.push(fileURLToPath(new URL('./context_report_worker.ts', here)))
    candidates.push(fileURLToPath(new URL('./context_report_worker.js', here)))
  }
  const root = here.includes('$bunfs') ? here.replace(/^file:\/\//, '').replace(/\/\$bunfs\/root\/.*$/, '/$bunfs/root') : null
  for (const base of [root, '/$bunfs/root', 'B:/~BUN/root'].filter((b): b is string => b !== null)) {
    candidates.push(`${base}/agent/context_report_worker.js`, `${base}/context_report_worker.js`)
  }
  return candidates.find((path) => { try { return existsSync(path) } catch { return false } }) ?? null
}

export class ContextReportUnavailable extends Error {
  constructor(message = 'context report worker unavailable') { super(message); this.name = 'ContextReportUnavailable' }
}

export type ReportWorkerPort = Pick<Worker, 'postMessage' | 'terminate' | 'addEventListener' | 'onmessage' | 'onerror'>
export interface ContextReportWorkerOptions {
  entry?: string | null
  timeoutMs?: number
  maxJobs?: number
  maxBytes?: number
  maxCallers?: number
  /** A small lifecycle seam for deterministic tests; never sent to the worker. */
  createWorker?: (entry: string) => ReportWorkerPort
}
interface Waiter { resolve: (result: ContextReportResult) => void; reject: (error: Error) => void }
interface Job {
  id: number
  input: ContextReportInput
  metadata: string
  bytes: number
  waiters: Waiter[]
  timer: ReturnType<typeof setTimeout>
}

export class ContextReportWorker {
  private worker: ReportWorkerPort | null = null
  private ready = false
  private active: Job | null = null
  private jobs: Job[] = []
  private nextId = 1
  private bytes = 0
  private callers = 0
  private closed = false
  private readonly timeoutMs: number
  private readonly maxJobs: number
  private readonly maxBytes: number
  private readonly maxCallers: number

  constructor(private readonly options: ContextReportWorkerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 120_000
    this.maxJobs = options.maxJobs ?? 8
    this.maxBytes = options.maxBytes ?? 64 * 1024 * 1024
    this.maxCallers = options.maxCallers ?? 64
  }

  compute(input: ContextReportInput): Promise<ContextReportResult> {
    if (this.closed) return Promise.reject(new ContextReportUnavailable('context report worker closed'))
    if (this.callers >= this.maxCallers) return Promise.reject(new ContextReportUnavailable('context report queue full'))
    // Do NOT stringify/hash the entire history on the API loop. String equality plus all the metadata makes
    // an exact key (not a session/status/version heuristic); at most maxJobs comparisons are made.
    const { historyJson, ...rest } = input
    const metadata = JSON.stringify(rest)
    const same = this.jobs.find((job) => job.metadata === metadata && job.input.historyJson === historyJson)
    if (same) return this.join(same)
    // Backlog budget in UTF-16 serialized input bytes, NOT a cap on the size of a session. An oversized job
    // may run alone; while it does, only identical callers join it. No input is truncated. Encoder, parsed
    // history, metadata objects and clone transit buffers are additional to this accounting.
    const bytes = 2 * (metadata.length + (historyJson?.length ?? 0))
    if (this.jobs.length >= this.maxJobs || (this.jobs.length > 0 && this.bytes + bytes > this.maxBytes)) {
      return Promise.reject(new ContextReportUnavailable('context report queue full'))
    }
    const job: Job = {
      id: this.nextId++, input: { ...structuredClone(rest), historyJson }, metadata, bytes, waiters: [],
      timer: setTimeout(() => this.expire(job), this.timeoutMs),
    }
    this.jobs.push(job)
    this.bytes += bytes
    const promise = this.join(job)
    this.pump()
    return promise
  }

  private join(job: Job): Promise<ContextReportResult> {
    this.callers += 1
    return new Promise((resolve, reject) => job.waiters.push({ resolve, reject }))
  }

  private finish(job: Job, result?: ContextReportResult, error?: Error): void {
    const index = this.jobs.indexOf(job)
    if (index < 0) return
    this.jobs.splice(index, 1)
    clearTimeout(job.timer)
    this.bytes -= job.bytes
    this.callers -= job.waiters.length
    if (this.active === job) this.active = null
    for (const waiter of job.waiters) {
      if (error || !result) waiter.reject(error ?? new ContextReportUnavailable())
      else {
        // Coalescing shares computation, never mutable return values (including override callback texts).
        try { waiter.resolve(structuredClone(result)) } catch { waiter.reject(new ContextReportUnavailable()) }
      }
    }
  }

  private discardWorker(): void {
    const worker = this.worker
    this.worker = null
    this.ready = false
    try { worker?.terminate() } catch { /* already gone */ }
  }

  private failed(worker: ReportWorkerPort): void {
    if (this.worker !== worker) return
    this.discardWorker()
    if (this.active) this.finish(this.active, undefined, new ContextReportUnavailable())
    this.pump()
  }

  private expire(job: Job): void {
    if (!this.jobs.includes(job)) return
    if (this.active === job) this.discardWorker()
    this.finish(job, undefined, new ContextReportUnavailable('context report timed out'))
    this.pump()
  }

  private pump(): void {
    if (this.closed || this.active || !this.jobs.length) return
    const job = this.jobs[0]!
    if (!this.worker) {
      const entry = this.options.entry === undefined ? contextReportWorkerEntry() : this.options.entry
      if (entry === null) {
        for (const pending of [...this.jobs]) this.finish(pending, undefined, new ContextReportUnavailable('context report worker not in this build'))
        return
      }
      let worker: ReportWorkerPort
      try { worker = (this.options.createWorker ?? ((path) => new Worker(path, { ref: false })))(entry) }
      catch {
        for (const pending of [...this.jobs]) this.finish(pending, undefined, new ContextReportUnavailable())
        return
      }
      this.worker = worker
      // Count startup in this job's deadline, including module loading and first encoder initialization.
      this.active = job
      worker.onmessage = (event: MessageEvent) => {
        if (this.worker !== worker) return
        const message = event.data
        if (message?.type === 'ready') {
          if (this.ready) return
          this.ready = true
          this.active = null
          this.pump()
          return
        }
        if (message?.type !== 'reply' || !this.active || message.id !== this.active.id) return
        const current = this.active
        if (message.ok) this.finish(current, message.result)
        else this.finish(current, undefined, new ContextReportUnavailable('context report computation failed'))
        this.pump()
      }
      worker.onerror = () => this.failed(worker)
      worker.addEventListener('close', () => this.failed(worker))
      return // No postMessage until ready: Bun need not queue messages before the handler is installed.
    }
    if (!this.ready) return
    const worker = this.worker
    this.active = job
    try { worker.postMessage({ id: job.id, input: job.input }) }
    catch { this.failed(worker) }
  }

  /** Tests/owners may dispose this service. Production's single idle worker is unref'd, and retains no reports. */
  close(): void {
    this.closed = true
    this.discardWorker()
    for (const job of [...this.jobs]) this.finish(job, undefined, new ContextReportUnavailable('context report worker closed'))
  }
}
