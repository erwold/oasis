/** One writer per workspace — per folder, for folders edited in place. The lock is per workspace (never per
 *  application): two sessions on two workspaces write side by side; two writers on one workspace queue. Two direct
 *  projects of one real folder (opened through a link, or twice) are two workspaces of one folder: they share its lock
 *  (`keyOf`). A lock file beside the workspace names the holder so a restart can tell a stale lock from a live one.
 *
 *  The line is fair (first come, first served: a newcomer never takes the folder ahead of a writer already waiting)
 *  and visible: every waiter is told who holds the folder, what kind of writer that is and where it stands in line,
 *  and a waiter that is stopped leaves the line at once, never holding the folder. A writer whose commands outlive it
 *  (a command still running when its wait ended, a run's command still going when the run ends) keeps the folder held
 *  for them until each has exited: a background writer is still a writer. A holder that takes the lock again is let
 *  through (re-entrant): nothing a holder does under its own lock waits for itself. Read-only commands are not
 *  writers: they are listed beside the lock (`readers`), never in its line and never in a writer's way.
 *
 *  One exception to the line, and only one: a run of the same conversation as the run whose commands alone still hold
 *  the folder (its cohort: the same session, participant, conversation and workspace, as the run's persisted record
 *  says) is let in beside those commands at once — even past writers already waiting, who could not write while the
 *  commands run anyway. It becomes the folder's one foreground writer; the commands keep their own provenance (the run
 *  that started each) and hold the folder until each exits, and its Stop does not stop them. Only commands a run's own
 *  tool started are joinable: an approval's, the connector's, an operation's or one of unknown origin is not. When the
 *  last of them exits and the foreground run has let go, the line goes on first come, first served. */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Workspace } from '@oasis-code/contract'
import { QueueCancelled } from '../llm/slots.ts'
import { nowIso } from '../timebase.ts'

/** What holds or waits for a folder: a run, a command sent through the connector's route, the person's approved
 *  action, or one of the harness's own operations on the folder (a checkpoint, an integration, a pinned base). */
export type LockKind = 'run' | 'command' | 'approval' | 'operation'

export interface LockMeta {
  kind?: LockKind
  /** a run's conversation cohort (workspace/cohort.ts cohortKeyOf): what lets a later run of it in beside the commands
   *  an earlier run of it left running. Only a run carries one; null: none (it joins nothing) */
  cohort?: string | null
  run_id?: string | null
  session_id?: string | null
  execution_id?: string | null
  proposal_id?: string | null
  operation?: string | null
}

export interface LockHolderView {
  owner: string
  kind: LockKind
  workspace_id: string
  run_id: string | null
  session_id: string | null
  proposal_id: string | null
  operation: string | null
  since: string
  /** the holder's command(s) now running: the folder stays held for them until they exit */
  execution_ids: string[]
  /** the holder itself let go: only the commands it started hold the folder now */
  background: boolean
  /** the holder's conversation cohort (a run's), or null */
  cohort: string | null
  /** the commands among execution_ids that an earlier run of the conversation started (not this holder) */
  background_execution_ids: string[]
  /** the runs that started the commands holding the folder (each command's own run, whoever holds it now) */
  origin_run_ids: string[]
}

export interface LockWaiterView {
  owner: string
  kind: LockKind
  workspace_id: string
  run_id: string | null
  session_id: string | null
  queued_since: string
  /** 1 is next */
  position: number
}

export interface LockReaderView {
  owner: string
  workspace_id: string
  session_id: string | null
  execution_id: string | null
  since: string
}

export interface LockStateView {
  holder: LockHolderView | null
  waiters: LockWaiterView[]
  readers: LockReaderView[]
}

/** Where a queued writer stands: a run's `waiting`, the data of its run_queued event. */
export interface LockWaiting {
  reason: 'workspace_lock'
  workspace_id: string
  blocking_owner: string | null
  blocking_kind: LockKind | null
  blocking_run_id: string | null
  blocking_session_id: string | null
  blocking_execution_ids: string[]
  blocking_proposal_id: string | null
  queued_since: string
  /** 1 is next */
  position: number
}

/** What a 409 of an operation refused while another writer holds the folder says: who, since when, how to go on. */
export interface BusyDetail {
  workspace_id: string
  operation: string
  blocking_owner: string
  blocking_kind: LockKind
  blocking_run_id: string | null
  blocking_session_id: string | null
  blocking_execution_ids: string[]
  blocking_proposal_id: string | null
  blocking_since: string
  /** writers waiting in line behind the holder */
  queued: number
  next_step: string
}

/** The folder is held by another writer: nothing was done. Answered as 409, code workspace_busy, with the detail. */
export class WorkspaceBusy extends Error {
  readonly status = 409
  readonly code = 'workspace_busy'
  constructor(message: string, readonly detail: BusyDetail) { super(message); this.name = 'WorkspaceBusy' }
}

/** A writer stopped while it waited in line: it left the line and never held the folder. */
export class LockWaitCancelled extends QueueCancelled {
  constructor(message: string) { super(message); this.name = 'LockWaitCancelled' }
}

export interface AcquireOptions extends LockMeta {
  /** aborted: the waiter leaves the line at once (LockWaitCancelled) */
  signal?: AbortSignal | null
  /** polled while waiting, and asked again when the folder is handed on: true leaves the line */
  cancelled?: (() => boolean) | null
  /** told — synchronously, before acquire first awaits — that the writer waits, and again whenever who blocks it or
   *  its place in line changes */
  onQueued?: ((waiting: LockWaiting) => void) | null
  /** told — synchronously, before it is let in — that the run is let in beside commands an earlier run of its
   *  conversation left running (its cohort's), and which: the caller keeps that record here. A notice that throws is
   *  no handoff: the run is not let in beside them (it waits in line as any writer does), and the holder is untouched */
  onJoined?: ((joined: CohortJoin) => void) | null
}

/** What a run let in beside its conversation's commands works beside: their executions and the runs that started them. */
export interface CohortJoin {
  inherited_execution_ids: string[]
  inherited_from_run_ids: string[]
}

/** Where a command holding the folder comes from: the holder that pinned it, the run that started it, and whether a
 *  later run of the holder's conversation may work beside it (only a command a run's own tool started). */
export interface PinProvenance {
  run_id?: string | null
  joinable?: boolean
}

interface Pin {
  owner: string
  run_id: string | null
  joinable: boolean
}

/** The kind an owner string names (the harness's owners: `run_…`, `command:…`, `approval:…`, `operation:…`). */
export function lockKindOf(owner: string): LockKind {
  if (owner.startsWith('command:')) return 'command'
  if (owner.startsWith('approval:')) return 'approval'
  if (owner.startsWith('operation:')) return 'operation'
  return 'run'
}

interface Held {
  owner: string
  workspace_id: string
  meta: Required<LockMeta>
  since: string
  depth: number
  pins: Map<string, Pin>
  released: boolean
}

interface Waiter {
  owner: string
  workspace_id: string
  meta: Required<LockMeta>
  queued_since: string
  cancelled: (() => boolean) | null
  onQueued: ((waiting: LockWaiting) => void) | null
  onJoined: ((joined: CohortJoin) => void) | null
  last: string
  settled: boolean
  settle: (outcome: 'granted' | 'cancelled') => void
}

interface Lane {
  holder: Held | null
  waiters: Waiter[]
  readers: Map<string, LockReaderView>
}

const POLL_MS = 250

function metaOf(owner: string, o: LockMeta): Required<LockMeta> {
  const kind = o.kind ?? lockKindOf(owner)
  return {
    kind, run_id: o.run_id ?? (kind === 'run' ? owner : null), session_id: o.session_id ?? null, execution_id: o.execution_id ?? null,
    proposal_id: o.proposal_id ?? (kind === 'approval' ? owner.slice('approval:'.length) : null), operation: o.operation ?? null,
    cohort: kind === 'run' ? (o.cohort ?? null) : null,
  }
}

/** The lock a workspace writes under: its own, or — a folder edited in place — its real folder's (the workspace's
 *  path is the folder's real path, recorded when it was opened). */
export function lockKeyOf(ws: Pick<Workspace, 'id' | 'kind' | 'path' | 'target' | 'remote'> | null, workspaceId: string): string {
  if (ws?.target?.kind === 'ssh') {
    if (!ws.remote || ws.remote.target_id !== ws.target.target_id || !ws.remote.root_id || !ws.remote.generation) throw new Error('remote workspace identity missing')
    // The transport's private registry binds independently generated root_id/generation
    // to the canonical filesystem object and environment. SSH target IDs are user aliases:
    // partitioning by one lets two aliases enter the model under different writer lanes.
    // Do not use path/state_path either: identical paths on distinct roots are not identity.
    return `remote-${createHash('sha256').update(JSON.stringify([ws.remote.root_id, ws.remote.generation])).digest('hex')}`
  }
  if (ws === null || ws.kind !== 'direct') return workspaceId
  return `folder-${createHash('sha256').update(ws.path).digest('hex').slice(0, 16)}`
}

/** How a holder is named to the person: a run of a session, a command and how it was started, an approval. */
export function describeHolder(h: LockHolderView): string {
  const xids = h.execution_ids.length ? h.execution_ids.join(', ') : null
  if (h.background) {
    const runs = h.origin_run_ids.length ? h.origin_run_ids : [h.run_id ?? h.owner]
    const starter = h.kind === 'run' ? `${runs.length > 1 ? 'runs' : 'run'} ${runs.join(', ')}${h.cohort && runs.length > 1 ? ' of one conversation' : ''}`
      : h.kind === 'approval' ? `the approved action of proposal ${h.proposal_id ?? h.owner}`
      : h.kind === 'command' ? 'the connector' : h.owner
    return `command ${xids ?? h.owner} still running (started by ${starter}, which ${h.kind === 'run' && runs.length > 1 ? 'have' : 'has'} returned)`
  }
  if (h.kind === 'run') {
    const beside = h.background_execution_ids.length ? ` (beside command ${h.background_execution_ids.join(', ')}, still running from an earlier run of its conversation)` : ''
    return `run ${h.run_id ?? h.owner}${h.session_id ? ` of session ${h.session_id}` : ''}${beside}`
  }
  if (h.kind === 'command') return `command ${xids ?? h.owner}${h.session_id ? ` of session ${h.session_id}` : ''} (started through the connector)`
  if (h.kind === 'approval') return `the approved action of proposal ${h.proposal_id ?? h.owner}${xids ? ` (command ${xids})` : ''}`
  return `the harness's ${h.operation ?? 'operation'} (${h.owner})`
}

/** What blocks now: a holder that let go blocks only through its commands. */
function blockingKind(h: LockHolderView): LockKind { return h.background ? 'command' : h.kind }

/** When the holder lets go, in words: what a refused caller waits for before trying again. */
export function holderEnds(h: LockHolderView): string {
  if (h.background || (h.kind === 'command' && h.execution_ids.length)) return `when command ${h.execution_ids.join(', ')} exits (stop it, or read it with its execution id)`
  if (h.kind === 'run' && h.background_execution_ids.length) return `when run ${h.run_id ?? h.owner} ends (GET /api/runs/${h.run_id ?? h.owner}; Stop ends it) and command ${h.background_execution_ids.join(', ')} exits`
  if (h.kind === 'run') return `when run ${h.run_id ?? h.owner} ends (GET /api/runs/${h.run_id ?? h.owner}; Stop ends it)`
  return 'when it ends'
}

export class WorkspaceLocks {
  readonly lock_dir: string
  private readonly lanes = new Map<string, Lane>()
  /** the key each holder took its lock under: released under the same key whatever the workspace's row says by then */
  private readonly taken = new Map<string, string>()
  private readonly keyOf: (workspaceId: string) => string

  constructor(lockDir: string, keyOf: (workspaceId: string) => string = (id) => id) {
    this.lock_dir = lockDir
    this.keyOf = keyOf
    mkdirSync(lockDir, { recursive: true })
  }

  private lane(key: string): Lane {
    let lane = this.lanes.get(key)
    if (!lane) {
      lane = { holder: null, waiters: [], readers: new Map() }
      this.lanes.set(key, lane)
    }
    return lane
  }

  /** The owner holding the workspace's folder (also while only commands it started hold it), or null. */
  holder(workspaceId: string): string | null {
    return this.lanes.get(this.keyOf(workspaceId))?.holder?.owner ?? null
  }

  /** Who holds the folder, who waits for it and in what order, and the read-only commands beside it. */
  state(workspaceId: string): LockStateView {
    const lane = this.lanes.get(this.keyOf(workspaceId))
    if (!lane) return { holder: null, waiters: [], readers: [] }
    return {
      holder: lane.holder ? this.holderView(lane.holder) : null,
      waiters: lane.waiters.map((w, i) => this.waiterView(w, i)),
      readers: [...lane.readers.values()].map((r) => ({ ...r })),
    }
  }

  /** Where `owner` waits in line (a queued run), or null when it waits for no folder. */
  waitingOf(owner: string): LockWaiting | null {
    for (const lane of this.lanes.values()) {
      const i = lane.waiters.findIndex((w) => w.owner === owner)
      if (i >= 0) return this.waitingView(lane, lane.waiters[i]!, i)
    }
    return null
  }

  /** The refusal an operation answers while the folder is held by a writer other than `except` (which holds it
   *  itself, not only through its commands): null when nobody else holds it. */
  busy(workspaceId: string, operation: string, nextStep?: ((holder: LockHolderView) => string) | null, except: string | null = null): WorkspaceBusy | null {
    const lane = this.lanes.get(this.keyOf(workspaceId))
    const held = lane?.holder ?? null
    if (lane === undefined || held === null || (except !== null && held.owner === except && !held.released)) return null
    const view = this.holderView(held)
    const next = nextStep ? nextStep(view) : `try again ${holderEnds(view)}`
    return new WorkspaceBusy(`the working folder is being written by ${describeHolder(view)}; ${next}`, {
      workspace_id: workspaceId, operation, blocking_owner: view.owner, blocking_kind: blockingKind(view), blocking_run_id: view.run_id,
      blocking_session_id: view.session_id, blocking_execution_ids: view.execution_ids, blocking_proposal_id: view.proposal_id, blocking_since: view.since,
      queued: lane.waiters.length, next_step: next,
    })
  }

  /** Take the folder now if it is free and nobody waits for it — or already this owner's (re-entrant) — else false,
   *  without waiting. The check and the take are one step: what runs under it runs with nobody else writing. */
  tryAcquire(workspaceId: string, owner: string, meta: LockMeta = {}): boolean {
    const key = this.keyOf(workspaceId)
    const lane = this.lane(key)
    if (lane.holder !== null && lane.holder.owner === owner && !lane.holder.released) { lane.holder.depth += 1; return true }
    if (lane.holder !== null || lane.waiters.length) return false
    this.take(lane, key, workspaceId, owner, metaOf(owner, meta))
    return true
  }

  /** tryAcquire, else the operation's refusal (WorkspaceBusy) naming who holds the folder and how to go on. */
  acquireNow(workspaceId: string, owner: string, meta: LockMeta & { operation: string }, nextStep?: ((holder: LockHolderView) => string) | null): void {
    if (this.tryAcquire(workspaceId, owner, meta)) return
    const busy = this.busy(workspaceId, meta.operation, nextStep)
    if (busy !== null) throw busy
    // free of a holder but with writers in line (a hand-on under way): the operation goes behind none of them
    const lane = this.lane(this.keyOf(workspaceId))
    const first = lane.waiters[0]
    throw new WorkspaceBusy(`the working folder has ${lane.waiters.length} writer(s) waiting for it; try again when they have run`, {
      workspace_id: workspaceId, operation: meta.operation, blocking_owner: first?.owner ?? 'unknown', blocking_kind: first?.meta.kind ?? 'run', blocking_run_id: first?.meta.run_id ?? null,
      blocking_session_id: first?.meta.session_id ?? null, blocking_execution_ids: [], blocking_proposal_id: first?.meta.proposal_id ?? null,
      blocking_since: first?.queued_since ?? nowIso(), queued: lane.waiters.length, next_step: 'try again when the writers waiting for the folder have run',
    })
  }

  /** Take the folder, in turn: at once when it is free and nobody waits, else at the end of the line until every
   *  writer ahead has let go (and the commands they left running have exited). A waiter that is stopped leaves the
   *  line at once with LockWaitCancelled and never holds the folder. */
  async acquire(workspaceId: string, owner: string, opts: AcquireOptions = {}): Promise<void> {
    const key = this.keyOf(workspaceId)
    const lane = this.lane(key)
    const metaIn = metaOf(owner, opts)
    if (lane.holder !== null && lane.holder.owner === owner && !lane.holder.released) { lane.holder.depth += 1; return }
    if (opts.signal?.aborted || opts.cancelled?.()) throw new LockWaitCancelled(`${owner} was stopped before it took the working folder`)
    if (lane.holder === null && !lane.waiters.length) { this.take(lane, key, workspaceId, owner, metaIn); return }
    // its own conversation's commands alone hold the folder: in at once, beside them, whoever waits — once its record of
    // them is kept (a failed handoff leaves it to wait in line as any writer, never let in unmarked)
    let meta = metaIn
    if (this.joinable(lane.holder, meta)) {
      if (this.join(lane, key, workspaceId, owner, meta, opts.onJoined ?? null)) return
      meta = { ...meta, cohort: null }
    }
    let resolve!: (outcome: 'granted' | 'cancelled') => void
    const outcome = new Promise<'granted' | 'cancelled'>((r) => { resolve = r })
    const waiter: Waiter = {
      owner, workspace_id: workspaceId, meta, queued_since: nowIso(), cancelled: opts.cancelled ?? null, onQueued: opts.onQueued ?? null, onJoined: opts.onJoined ?? null, last: '', settled: false,
      settle: (o) => { if (waiter.settled) return; waiter.settled = true; resolve(o) },
    }
    lane.waiters.push(waiter)
    const leave = () => {
      if (waiter.settled) return
      const i = lane.waiters.indexOf(waiter)
      if (i < 0) return
      lane.waiters.splice(i, 1)
      waiter.settle('cancelled')
      this.notify(lane)
    }
    opts.signal?.addEventListener('abort', leave, { once: true })
    const poll = opts.cancelled ? setInterval(() => { if (opts.cancelled!()) leave() }, POLL_MS) : null
    try {
      this.notify(lane)                                                     // the waiter hears it waits, synchronously
      if (await outcome === 'cancelled') throw new LockWaitCancelled(`${owner} was stopped while it waited for the working folder`)
    } finally {
      if (poll !== null) clearInterval(poll)
      opts.signal?.removeEventListener('abort', leave)
    }
  }

  /** Let go of the folder (or of one re-entrant take of it). A holder whose commands still run keeps the folder held
   *  for them: it passes to the next writer when the last of them has exited. A non-holder's release does nothing. */
  release(workspaceId: string, owner: string): void {
    const key = this.taken.get(`${workspaceId}\0${owner}`) ?? this.keyOf(workspaceId)
    const lane = this.lanes.get(key)
    const held = lane?.holder ?? null
    if (lane === undefined || held === null || held.owner !== owner || held.released) return
    held.depth -= 1
    if (held.depth > 0) return
    this.taken.delete(`${workspaceId}\0${owner}`)
    if (held.pins.size) {
      held.released = true
      this.writeLockFile(key, held)
      // a run of this conversation already in line (it came while this one was ending) goes in beside the commands now
      this.admitCohort(lane, key)
      this.notify(lane)
      return
    }
    this.handOn(lane, key)
  }

  /** Whether a writer of `meta` may be let in beside the commands that alone hold the folder: the holder let go, every
   *  command holding it was started by a run's own tool, and the newcomer is a run of the same conversation cohort. */
  private joinable(held: Held | null, meta: Required<LockMeta>): boolean {
    if (held === null || !held.released || !held.pins.size || held.meta.kind !== 'run' || meta.kind !== 'run') return false
    if (!meta.cohort || held.meta.cohort !== meta.cohort) return false
    for (const pin of held.pins.values()) if (!pin.joinable) return false
    return true
  }

  /** The run is the folder's foreground writer now, beside the commands that hold it: the same holder record, so each
   *  command's pin (and the callback that removes it when the command ends) stays as it was, with its provenance. The
   *  joiner's record of them is kept first; if that fails nothing changes and it is not let in (false). */
  private join(lane: Lane, key: string, workspaceId: string, owner: string, meta: Required<LockMeta>, onJoined: ((joined: CohortJoin) => void) | null): boolean {
    const held = lane.holder!
    const joined: CohortJoin = {
      inherited_execution_ids: [...held.pins.keys()],
      inherited_from_run_ids: [...new Set([...held.pins.values()].map((p) => p.run_id).filter((r): r is string => typeof r === 'string'))],
    }
    if (onJoined !== null) {
      try { onJoined(joined) } catch (error) {
        console.warn(`[locks] ${owner} was not let in beside its conversation's commands: its record of them was not kept (${(error as Error).message})`)
        return false
      }
    }
    held.owner = owner
    held.workspace_id = workspaceId
    held.meta = meta
    held.since = nowIso()
    held.depth = 1
    held.released = false
    this.taken.set(`${workspaceId}\0${owner}`, key)
    this.writeLockFile(key, held)
    this.notify(lane)
    return true
  }

  /** The first run in line of the cohort whose commands alone hold the folder (if any) is let in beside them. */
  private admitCohort(lane: Lane, key: string): void {
    const held = lane.holder
    if (held === null || !held.released) return
    for (const w of [...lane.waiters]) {
      if (w.settled || w.cancelled?.() || !this.joinable(held, w.meta)) continue
      // its record kept: out of the line and in; else it stays in line as any writer (no longer of the cohort)
      if (this.join(lane, key, w.workspace_id, w.owner, w.meta, w.onJoined)) {
        lane.waiters.splice(lane.waiters.indexOf(w), 1)
        w.settle('granted')
        return
      }
      w.meta = { ...w.meta, cohort: null }
    }
  }

  /** The holder's command `executionId` holds the folder until `until` settles (the command's real end): the holder
   *  may let go meanwhile, the folder stays held. `until` may be settled already (the command ended before this was
   *  called): the pin then goes on the next turn, it is never kept. False when `owner` does not hold the folder. */
  holdUntil(workspaceId: string, owner: string, executionId: string, until: Promise<unknown>, provenance: PinProvenance = {}): boolean {
    const key = this.keyOf(workspaceId)
    const lane = this.lanes.get(key)
    const held = lane?.holder ?? null
    if (lane === undefined || held === null || held.owner !== owner) return false
    if (held.pins.has(executionId)) return true
    // not joinable unless the caller says so (a run's own tool's command): an unknown origin never lets anyone in
    held.pins.set(executionId, { owner, run_id: provenance.run_id ?? held.meta.run_id, joinable: provenance.joinable === true })
    this.writeLockFile(key, held)
    this.notify(lane)
    // bound to the holder record, which a run of the cohort keeps when it is let in: the pin goes when its command ends
    const unpin = () => {
      if (lane.holder !== held || !held.pins.delete(executionId)) return
      if (held.released && !held.pins.size) this.handOn(lane, key)
      else { this.writeLockFile(key, held); if (held.released) this.admitCohort(lane, key); this.notify(lane) }
    }
    until.then(unpin, unpin)
    return true
  }

  /** What the holder does now (the execution its command started), shown to whoever waits or is refused. */
  annotate(workspaceId: string, owner: string, meta: Omit<LockMeta, 'kind'>): void {
    const lane = this.lanes.get(this.keyOf(workspaceId))
    const held = lane?.holder ?? null
    if (lane === undefined || held === null || held.owner !== owner) return
    for (const [k, v] of Object.entries(meta)) if (v !== undefined && k !== 'kind' && k !== 'cohort') (held.meta as unknown as Record<string, unknown>)[k] = v
    this.notify(lane)
  }

  /** A read-only command beside the folder: listed, never in the line, never in a writer's way. */
  addReader(workspaceId: string, owner: string, meta: { session_id?: string | null; execution_id?: string | null } = {}): void {
    this.lane(this.keyOf(workspaceId)).readers.set(owner, { owner, workspace_id: workspaceId, session_id: meta.session_id ?? null, execution_id: meta.execution_id ?? null, since: nowIso() })
  }

  setReaderExecution(workspaceId: string, owner: string, executionId: string): void {
    const reader = this.lanes.get(this.keyOf(workspaceId))?.readers.get(owner)
    if (reader) reader.execution_id = executionId
  }

  removeReader(workspaceId: string, owner: string): void {
    this.lanes.get(this.keyOf(workspaceId))?.readers.delete(owner)
  }

  private take(lane: Lane, key: string, workspaceId: string, owner: string, meta: Required<LockMeta>): void {
    const held: Held = { owner, workspace_id: workspaceId, meta, since: nowIso(), depth: 1, pins: new Map(), released: false }
    lane.holder = held
    this.taken.set(`${workspaceId}\0${owner}`, key)
    this.writeLockFile(key, held)
  }

  /** The holder is gone: the folder goes to the first in line still waiting (one stopped meanwhile is passed over
   *  and never holds it), else it is free. */
  private handOn(lane: Lane, key: string): void {
    lane.holder = null
    try { unlinkSync(join(this.lock_dir, `${key}.lock`)) } catch { /* already gone */ }
    for (;;) {
      const next = lane.waiters.shift()
      if (next === undefined) break
      if (next.cancelled?.()) { next.settle('cancelled'); continue }
      this.take(lane, key, next.workspace_id, next.owner, next.meta)
      next.settle('granted')
      break
    }
    this.notify(lane)
  }

  private writeLockFile(key: string, held: Held): void {
    writeFileSync(join(this.lock_dir, `${key}.lock`), JSON.stringify({
      owner: held.owner, kind: held.meta.kind, workspace_id: held.workspace_id, pid: process.pid, since: held.since,
      ...(held.pins.size ? { executions: [...held.pins.keys()] } : {}), ...(held.released ? { background: true } : {}),
      ...(held.meta.cohort ? { cohort: held.meta.cohort } : {}),
    }))
  }

  private holderView(h: Held): LockHolderView {
    const xids = [...h.pins.keys()]
    if (h.meta.execution_id && !xids.includes(h.meta.execution_id) && !h.released) xids.unshift(h.meta.execution_id)
    const inherited = h.released ? [] : [...h.pins].filter(([, p]) => p.owner !== h.owner).map(([x]) => x)
    const origins = [...new Set([...h.pins.values()].map((p) => p.run_id).filter((r): r is string => typeof r === 'string'))]
    return {
      owner: h.owner, kind: h.meta.kind, workspace_id: h.workspace_id, run_id: h.meta.run_id, session_id: h.meta.session_id, proposal_id: h.meta.proposal_id,
      operation: h.meta.operation, since: h.since, execution_ids: xids, background: h.released, cohort: h.meta.cohort, background_execution_ids: inherited,
      origin_run_ids: origins,
    }
  }

  private waiterView(w: Waiter, i: number): LockWaiterView {
    return { owner: w.owner, kind: w.meta.kind, workspace_id: w.workspace_id, run_id: w.meta.run_id, session_id: w.meta.session_id, queued_since: w.queued_since, position: i + 1 }
  }

  private waitingView(lane: Lane, w: Waiter, i: number): LockWaiting {
    const h = lane.holder ? this.holderView(lane.holder) : null
    return {
      reason: 'workspace_lock', workspace_id: w.workspace_id, blocking_owner: h?.owner ?? null, blocking_kind: h ? blockingKind(h) : null,
      blocking_run_id: h?.run_id ?? null, blocking_session_id: h?.session_id ?? null, blocking_execution_ids: h?.execution_ids ?? [],
      blocking_proposal_id: h?.proposal_id ?? null, queued_since: w.queued_since, position: i + 1,
    }
  }

  /** Each waiter whose blocker or place changed is told, once per change. */
  private notify(lane: Lane): void {
    lane.waiters.forEach((w, i) => {
      if (w.onQueued === null) return
      const view = this.waitingView(lane, w, i)
      const sig = JSON.stringify(view)
      if (sig === w.last) return
      w.last = sig
      try { w.onQueued(view) } catch (error) { console.warn(`[locks] a waiter's notice failed: ${(error as Error).message}`) }
    })
  }

  /** Startup: lock files of a dead process are stale; remove them and say which. */
  reconcile(): string[] {
    const stale: string[] = []
    if (!existsSync(this.lock_dir)) return stale
    for (const name of readdirSync(this.lock_dir)) {
      if (!name.endsWith('.lock')) continue
      const path = join(this.lock_dir, name)
      let pid = -1
      try { pid = Number.parseInt(String(JSON.parse(readFileSync(path, 'utf8')).pid ?? -1), 10) } catch { pid = -1 }
      // a lock of a process that still runs is its own (a second harness is refused before it gets here; this holds even so)
      let running = false
      if (pid > 0 && pid !== process.pid) { try { process.kill(pid, 0); running = true } catch (error) { running = (error as NodeJS.ErrnoException).code === 'EPERM' } }
      if (pid !== process.pid && !running) {
        stale.push(name.slice(0, -'.lock'.length))
        try { unlinkSync(path) } catch { /* gone */ }
      }
    }
    return stale
  }
}
