/** Where a live state is made: the projector worker thread (the default: WorkerProjector), or in process for tests only
 *  (InlineProjector). Both answer the same two questions — a state (bytes of a checked DTO) and a picture — with replies
 *  that carry no error text. The worker is started when first asked and stopped when the service has nothing to watch
 *  (close), so a share nobody watches holds no thread and no parsed records. */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ProjectorCore, type ImageReply, type ImageRequest, type PartReply, type PartRequest, type ProjectorInit, type ProjectReply, type ProjectRequest } from './projector_core.ts'

export interface Projector {
  readonly kind: 'worker' | 'inline'
  project(req: ProjectRequest): Promise<ProjectReply>
  /** live state v2: one session's part (a projector without it answers every v2 build as failed) */
  part?(req: PartRequest): Promise<PartReply>
  image(req: ImageRequest): Promise<ImageReply>
  /** stop (the worker terminated, its memory released); a later request starts it again */
  close(): Promise<void>
  /** how many projections it has made (a test's question) */
  readonly builds: number
}

/** In process: the same core on the app's own connection. Tests only (it would run on the app's event loop). */
export class InlineProjector implements Projector {
  readonly kind = 'inline' as const
  builds = 0
  constructor(private readonly core: () => ProjectorCore) {}
  private made: ProjectorCore | null = null
  private get c(): ProjectorCore { return this.made ??= this.core() }
  async project(req: ProjectRequest): Promise<ProjectReply> { this.builds++; await Promise.resolve(); return this.c.project(req) }
  /** how many v2 parts it has built, by session id (a test's question) */
  readonly partBuilds = new Map<string, number>()
  async part(req: PartRequest): Promise<PartReply> {
    this.builds++
    this.partBuilds.set(req.session_id, (this.partBuilds.get(req.session_id) ?? 0) + 1)
    await Promise.resolve()
    return this.c.projectPart(req)
  }
  async image(req: ImageRequest): Promise<ImageReply> { await Promise.resolve(); return this.c.image(req) }
  async close(): Promise<void> { this.made = null }
}

/** The worker's file: beside this module in the source; in a compiled build, where `bun build --compile` put the
 *  extra entry point (the build roots its entries at src/: `share/live/projector_worker.js` in the embedded root). */
export function projectorWorkerEntry(): string | null {
  const here = import.meta.url
  const candidates: string[] = []
  if (here.startsWith('file:')) {
    candidates.push(fileURLToPath(new URL('./projector_worker.ts', here)))
    candidates.push(fileURLToPath(new URL('./projector_worker.js', here)))
  }
  const root = here.includes('$bunfs') ? here.replace(/^file:\/\//, '').replace(/\/\$bunfs\/root\/.*$/, '/$bunfs/root') : null
  for (const base of [root, '/$bunfs/root', 'B:/~BUN/root'].filter((b): b is string => b !== null)) {
    candidates.push(`${base}/share/live/projector_worker.js`, `${base}/projector_worker.js`)
  }
  return candidates.find((c) => { try { return existsSync(c) } catch { return false } }) ?? null
}

/** a question to one thread: only that thread's end answers it as failed (a late error of an older thread never does) */
interface Pending { worker: Worker; resolve: (reply: unknown) => void; fail: unknown; timer: ReturnType<typeof setTimeout> }

export interface WorkerProjectorOptions {
  /** the longest a projection may take before the thread is stopped (and started again on the next request) */
  project_timeout_ms?: number
  image_timeout_ms?: number
  /** the worker file (a test names a broken one); default projectorWorkerEntry() */
  entry?: string | null
}

export class WorkerProjector implements Projector {
  readonly kind = 'worker' as const
  builds = 0
  private worker: Worker | null = null
  private next = 1
  private readonly pending = new Map<number, Pending>()
  private readonly projectTimeout: number
  private readonly imageTimeout: number
  private readonly entry: string | null
  /** why the last start failed (no file in this build, …): requests answer `error` until the next close */
  failed: string | null = null

  constructor(private readonly init: () => ProjectorInit, opts: WorkerProjectorOptions = {}) {
    this.projectTimeout = opts.project_timeout_ms ?? 60_000
    this.imageTimeout = opts.image_timeout_ms ?? 15_000
    this.entry = opts.entry === undefined ? projectorWorkerEntry() : opts.entry
  }

  private start(): Worker | null {
    if (this.worker !== null) return this.worker
    if (this.entry === null) { this.failed = 'the projector thread is not in this build'; return null }
    let worker: Worker
    try { worker = new Worker(this.entry) } catch { this.failed = 'the projector thread could not start'; return null }
    worker.onmessage = (event: MessageEvent<{ type: string; id?: number; reply?: unknown }>) => {
      const m = event.data
      if (m.type === 'failed') { this.failed = 'the projector thread could not open the database'; this.stop(worker); return }
      if (m.type !== 'reply' || typeof m.id !== 'number') return
      const p = this.pending.get(m.id)
      if (p === undefined) return
      this.pending.delete(m.id)
      clearTimeout(p.timer)
      p.resolve(m.reply)
    }
    worker.onerror = () => { this.stop(worker) }
    worker.addEventListener('close', () => { if (this.worker === worker) this.stop(worker) })
    worker.postMessage({ type: 'init', init: this.init() })
    this.worker = worker
    return worker
  }

  /** The thread is stopped: every question IT still had is answered as failed (another thread's are not touched). */
  private stop(worker: Worker): void {
    if (this.worker === worker) this.worker = null
    try { worker.terminate() } catch { /* gone */ }
    for (const [id, p] of this.pending) {
      if (p.worker !== worker) continue
      clearTimeout(p.timer)
      this.pending.delete(id)
      p.resolve(p.fail)
    }
  }

  private ask<T>(type: 'project' | 'image' | 'part', req: unknown, fail: T, timeout: number): Promise<T> {
    const worker = this.start()
    if (worker === null) return Promise.resolve(fail)
    const id = this.next++
    return new Promise<T>((resolve) => {
      const timer = setTimeout(() => { if (this.pending.has(id)) this.stop(worker) }, timeout)
      this.pending.set(id, { worker, resolve: resolve as (r: unknown) => void, fail, timer })
      // a question that cannot be posted is answered as failed, never thrown at the caller
      try { worker.postMessage({ type, id, req }) } catch { this.stop(worker) }
    })
  }

  project(req: ProjectRequest): Promise<ProjectReply> {
    this.builds++
    return this.ask<ProjectReply>('project', req, { ok: false, code: 'error' }, this.projectTimeout)
  }

  part(req: PartRequest): Promise<PartReply> {
    this.builds++
    return this.ask<PartReply>('part', req, { ok: false, code: 'error' }, this.projectTimeout)
  }

  image(req: ImageRequest): Promise<ImageReply> {
    return this.ask<ImageReply>('image', req, { ok: false }, this.imageTimeout)
  }

  async close(): Promise<void> {
    const worker = this.worker
    this.failed = null
    if (worker !== null) this.stop(worker)
  }

  /** a thread is running now (a test's question) */
  get running(): boolean { return this.worker !== null }
}
