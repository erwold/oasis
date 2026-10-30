/** The watches as the harness keeps them: an agent registers what it wants to be woken for and ends its turn; this
 *  service reads every running command's output as it arrives (all of it — the part past the log's cap too), sees
 *  commands end, keeps the timers, and records what fired. Nothing asks a model while nothing fires. A fired watch's
 *  events are delivered as the next run of the conversation of the run that set it — the harness's message, never
 *  the person's — once that conversation is free: the session's thread after the person's own run, never beside it;
 *  a group member's, a relay member's or a separate task's as that participant's follow-up (its group's next step).
 *  Every watch ends by itself (it fired, its command ended, it expired); one whose command a restart stopped says so. */

import { ACTIVE_INTERACTION_STATUSES, ACTIVE_RELAY_STATUSES, ACTIVE_RUN_STATUSES, type Execution, type Run, type Session, type WakeEvent, type Watch } from '@oasis-code/contract'
import { wakeParticipant } from '../../api/collaboration.ts'
import type { AppState } from '../../api/state.ts'
import * as repo from '../../db/repo.ts'
import { nowIso } from '../../timebase.ts'
import { remoteBinding } from '../../workspace/remote_files.ts'
import { emptyRemoteCursor, remoteLines, type RemoteCursorState } from './remote_cursor.ts'
import { text } from '../../prompt_texts.ts'
import { assignmentOf } from '../collab.ts'
import type { Assignment } from '../collab_projection.ts'
import { checkWatch, compilePattern, MAX_LINE_CHARS, metricReader, readLine, shownNumber, type LineState, type WatchInput } from './conditions.ts'

/** How many watches a session may have waiting at once. */
export const MAX_ACTIVE_WATCHES = 20
/** How many runs the watches may start in a session within an hour (more events wait for the hour to allow one). */
export const MAX_WAKES_PER_HOUR = 12
/** How many times a wake that does not start is tried before its events are dropped. */
const MAX_DELIVERY_ATTEMPTS = 3
/** The lines of a running command kept for a watch registered after they were printed. */
const RECENT_LINES = 500
const RECENT_CHARS = 1_000_000
/** How much of a line an event quotes, and how many of the last lines an ended command's event shows. */
const QUOTE_CHARS = 300
const LAST_LINES = 8
const LAST_LINES_CHARS = 1_500
/** A timer further off than this is set again when this comes (setTimeout's own limit is ~24 days). */
const MAX_TIMER_MS = 3_600_000
const SESSION_DELETED = 'the session was deleted'
/** The conversation key of the session's own thread (a run of no participant is the thread's too). */
const THREAD = 'thread'

export interface WatchServiceOptions {
  /** how long events of one moment are gathered into one wake (an exit and the watches it ended) */
  debounce_ms?: number
  /** how often silence, expiry and undelivered events are looked at */
  tick_ms?: number
  wakes_per_hour?: number
}

type Stream = 'stdout' | 'stderr'

interface Armed {
  watch: Watch
  re: RegExp | null
  metric: ((line: string) => number | undefined) | null
  line: LineState
  last_fire_ms: number
  /** silence: whether the command is silent now (fired for this silence already) */
  silent: boolean
  armed_ms: number
}

interface Track {
  decoders: Record<Stream, TextDecoder>
  partial: Record<Stream, string>
  /** the rest of a line longer than the read limit is being skipped, up to its end */
  skipping: Record<Stream, boolean>
  recent: { stream: Stream; line: string }[]
  recent_chars: number
  last_output_ms: number | null
}

export class WatchService {
  private readonly armed = new Map<string, Armed>()
  private readonly byExecution = new Map<string, Set<string>>()
  private readonly tracks = new Map<string, Track>()
  private readonly remoteFlights = new Set<string>()
  private readonly remoteReady = new Map<string, boolean>()
  private readonly scheduled = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly delivering = new Set<string>()
  private readonly failures = new Map<string, number>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private ticker: ReturnType<typeof setInterval> | null = null
  private closed = false
  private readonly debounceMs: number
  private readonly tickMs: number
  private readonly wakesPerHour: number

  constructor(private readonly state: AppState, opts: WatchServiceOptions = {}) {
    this.debounceMs = opts.debounce_ms ?? 2_000
    this.tickMs = opts.tick_ms ?? 5_000
    this.wakesPerHour = opts.wakes_per_hour ?? MAX_WAKES_PER_HOUR
  }

  private get conn() { return this.state.conn }

  /** The commands' output and ends, and the runs' ends (a conversation that becomes free takes its waiting events). */
  attachHooks(): void {
    const guarded = (what: string, fn: () => void) => { try { fn() } catch (error) { console.warn(`watches: ${what}: ${(error as Error).message}`) } }
    this.state.processes.onOutput((xid, stream, chunk) => guarded(`the output of ${xid}`, () => this.state.processes.isRemoteExecution(xid) ? this.pullRemote(xid) : this.output(xid, stream, chunk)))
    this.state.processes.onEnd((xid) => guarded(`the end of ${xid}`, () => this.state.processes.isRemoteExecution(xid) ? this.pullRemote(xid) : this.ended(xid)))
    this.state.processes.onConnection((xid, connected) => { if (!this.closed) { this.remoteReady.set(xid, connected); this.trackOf(xid).last_output_ms = Date.now(); if (connected) this.pullRemote(xid) } })
    this.state.runs.onRunFinished((runId) => guarded(`the end of ${runId}`, () => {
      if (this.closed) return
      const run = repo.getRun(this.conn, runId)
      if (run !== null) this.schedule(run.session_id)
    }))
  }

  /** Startup, after the runner's reconcile (a command of the last life is `lost` by then): the watches still active
   *  are armed again; one whose command ended meanwhile reports how, one whose command the restart stopped says so,
   *  one past its time expires; a timer that came while nothing ran fires now. Then the events not yet delivered go. */
  start(): { armed: number; lost: number; ended: number; expired: number } {
    const counts = { armed: 0, lost: 0, ended: 0, expired: 0 }
    for (const w of repo.listActiveWatches(this.conn)) {
      if (this.sessionGone(w.session_id)) { this.withdraw(w, SESSION_DELETED); counts.ended += 1; continue }
      if (Date.parse(w.expires_at) <= Date.now()) { this.end(this.arm(w), 'expired', text('watch.detail_expired', { at: w.expires_at })); counts.expired += 1; continue }
      const xid = w.spec.execution_id
      if (xid !== null && this.state.processes.isRemoteExecution(xid)) {
        this.arm(w); counts.armed++; this.pullRemote(xid); continue
      }
      if (xid !== null && !this.state.processes.isRunning(xid)) {
        const execution = repo.getExecution(this.conn, xid)
        const armed = this.arm(w)
        if (execution === null || execution.status === 'lost') {
          this.end(armed, 'lost', text('watch.detail_lost', { execution_id: xid }))
          counts.lost += 1
        } else if (w.spec.kind === 'exit') {
          this.fire(armed, this.exitDetail(execution), { execution_id: xid, status: execution.status, exit_code: execution.exit_code })
          counts.ended += 1
        } else {
          this.end(armed, 'ended', text('watch.detail_ended', { execution_id: xid, how: howEnded(execution), last: '' }))
          counts.ended += 1
        }
        continue
      }
      this.arm(w)
      counts.armed += 1
    }
    this.reschedule()
    this.ticker = setInterval(() => { try { this.tick() } catch (error) { console.warn(`watches: ${(error as Error).message}`) } }, this.tickMs)
    this.ticker.unref?.()
    for (const sessionId of new Set(repo.listPendingWakeEvents(this.conn).map((e) => e.session_id))) this.schedule(sessionId)
    return counts
  }

  close(): void {
    this.closed = true
    if (this.timer !== null) clearTimeout(this.timer)
    if (this.ticker !== null) clearInterval(this.ticker)
    for (const t of this.scheduled.values()) clearTimeout(t)
    this.scheduled.clear()
  }

  // -- registration ------------------------------------------------------------------------------

  /** A watch registered by a run of the session's own conversation (the tool checked that the run may read the
   *  command). A command that ended already is refused — but for `exit`, which reports its end at once. A match or a
   *  metric reads the lines the command printed before the watch was set too (a step past the line already, a
   *  traceback already printed). */
  register(o: { session_id: string; run_id: string; note: string; input: WatchInput }): Watch | { error: string } {
    const active = repo.listWatches(this.conn, o.session_id).filter((w) => w.status === 'active').length
    if (active >= MAX_ACTIVE_WATCHES) return { error: `this conversation has ${active} watches waiting (the limit is ${MAX_ACTIVE_WATCHES}); cancel one first (watch with cancel)` }
    const note = o.note.trim()
    if (!note) return { error: 'note is required: what to do when woken' }
    if (note.length > 2000) return { error: 'note is longer than 2000 characters' }
    const checked = checkWatch(o.input, new Date())
    if ('error' in checked) return checked
    const xid = checked.spec.execution_id
    let execution: Execution | null = null
    let running = false
    if (xid !== null) {
      execution = repo.getExecution(this.conn, xid)
      if (execution === null) return { error: `unknown command ${xid}` }
      running = this.state.processes.isRunning(xid)
      if (!running && checked.spec.kind !== 'exit') return { error: `${xid} has already ended (${howEnded(execution)}); read its output with bash_output` }
    }
    const watch = repo.insertWatch(this.conn, {
      session_id: o.session_id, run_id: o.run_id, spec: checked.spec, note, summary: checked.summary, repeat: checked.repeat,
      cooldown_s: checked.cooldown_s, max_fires: checked.max_fires, expires_at: checked.expires_at,
    })
    const armed = this.arm(watch)
    if (xid !== null && this.state.processes.isRemoteExecution(xid)) {
      if (checked.spec.kind === 'exit' && !running) this.fire(armed, this.exitDetail(execution!), { execution_id: xid, status: execution!.status, exit_code: execution!.exit_code })
      else this.pullRemote(xid)
      this.reschedule(); return repo.getWatch(this.conn, watch.id)!
    }
    if (xid !== null && checked.spec.kind === 'exit' && !running) {
      this.fire(armed, this.exitDetail(execution!), { execution_id: xid, status: execution!.status, exit_code: execution!.exit_code })
    } else if (xid !== null && (checked.spec.kind === 'match' || checked.spec.kind === 'metric')) {
      const track = this.tracks.get(xid)
      for (const { stream, line } of track ? [...track.recent] : []) {
        if (!this.armed.has(watch.id)) break
        this.readInto(armed, stream, line, true)
      }
    }
    this.reschedule()
    return repo.getWatch(this.conn, watch.id)!
  }

  /** A watch cancelled (by the agent or the person); false when it was not waiting. It wakes no one after this: its
   *  reports still waiting for the conversation are withdrawn with it (the watch says why). */
  cancel(watchId: string, by: 'agent' | 'person'): boolean {
    const watch = repo.getWatch(this.conn, watchId)
    if (watch === null || watch.status !== 'active') return false
    this.withdraw(watch, by === 'person' ? 'cancelled by the user' : 'cancelled by the agent')
    this.reschedule()
    this.settled(watch.session_id)
    return true
  }

  /** The watches the runs set, withdrawn (their interaction step was stopped): nothing of them wakes anyone. */
  withdrawRuns(sessionId: string, runIds: string[], reason: string): void {
    const runs = new Set(runIds)
    for (const w of repo.listWatches(this.conn, sessionId)) {
      if (runs.has(w.run_id) && (w.status === 'active' || repo.listPendingWakeEvents(this.conn, sessionId).some((e) => e.watch_id === w.id))) this.withdraw(w, reason)
    }
    this.reschedule()
  }

  /** An interaction step waiting on watches that ended with nothing left to deliver is done. */
  private settled(sessionId: string): void {
    try { this.state.interactions.watchesSettled(sessionId) } catch (error) { console.warn(`watches: ${(error as Error).message}`) }
  }

  /** A deleted session's watches end with it: nothing is left waiting (a timer, a listener) for a conversation that
   *  is gone. */
  sessionDeleted(sessionId: string): void {
    for (const w of repo.listWatches(this.conn, sessionId)) if (w.status === 'active') this.withdraw(w, SESSION_DELETED)
    this.reschedule()
  }

  /** Which conversation each run of the session holds: the thread's, or a participant's own (by its id). */
  conversationsOf(sessionId: string): (runId: string) => string {
    const { assignment } = assignmentOf(this.state, sessionId)
    return (runId) => targetOf(assignment, runId).key
  }

  private withdraw(watch: Watch, reason: string): void {
    this.conn.transaction(() => {
      repo.updateWatch(this.conn, watch.id, { status: 'cancelled', ended_reason: reason })
      repo.settleWakeEvents(this.conn, repo.listPendingWakeEvents(this.conn, watch.session_id).filter((e) => e.watch_id === watch.id).map((e) => e.id), 'dropped', null)
    })
    this.disarm(watch.id)
  }

  // -- arming --------------------------------------------------------------------------------------

  private arm(watch: Watch): Armed {
    const spec = watch.spec
    const compiled = spec.kind === 'match' && spec.pattern ? compilePattern(spec.pattern) : null
    const armed: Armed = {
      watch, re: compiled instanceof RegExp ? compiled : null, metric: spec.kind === 'metric' ? metricReader(spec) : null, line: { holding: null },
      last_fire_ms: watch.last_fired_at ? Date.parse(watch.last_fired_at) : 0, silent: false, armed_ms: Date.now(),
    }
    if (spec.execution_id && this.state.processes.isRemoteExecution(spec.execution_id)) {
      const stored = this.conn.get('SELECT state_json FROM remote_watch_cursors WHERE watch_id=? LIMIT 1', [watch.id])
      if (stored) { const value = JSON.parse(String(stored.state_json)) as RemoteCursorState; armed.line.holding = value.holding; armed.silent = value.silent === true }
    }
    this.armed.set(watch.id, armed)
    if (spec.execution_id) {
      const set = this.byExecution.get(spec.execution_id) ?? new Set<string>()
      set.add(watch.id)
      this.byExecution.set(spec.execution_id, set)
    }
    return armed
  }

  private disarm(watchId: string): void {
    const armed = this.armed.get(watchId)
    if (!armed) return
    this.armed.delete(watchId)
    const xid = armed.watch.spec.execution_id
    if (xid) {
      const set = this.byExecution.get(xid)
      set?.delete(watchId)
      if (set && !set.size) this.byExecution.delete(xid)
    }
  }

  private armedOn(xid: string): Armed[] {
    return [...(this.byExecution.get(xid) ?? [])].map((id) => this.armed.get(id)).filter((a): a is Armed => a !== undefined)
  }

  // -- the commands' output and ends -------------------------------------------------------------------

  private trackOf(xid: string): Track {
    let track = this.tracks.get(xid)
    if (!track) {
      track = { decoders: { stdout: new TextDecoder(), stderr: new TextDecoder() }, partial: { stdout: '', stderr: '' }, skipping: { stdout: false, stderr: false }, recent: [], recent_chars: 0, last_output_ms: null }
      this.tracks.set(xid, track)
    }
    return track
  }

  /** Each remote watch owns a durable replay cursor. Driver output callbacks only schedule reads: a crash between
   * the driver's cursor and this reader loses nothing, because matching/event/cursor commits use this cursor. */
  private pullRemote(xid: string): void {
    if (this.closed || this.remoteFlights.has(xid) || !this.armedOn(xid).length) return
    this.remoteFlights.add(xid)
    void this.readRemote(xid).catch(() => {
      if (this.closed) return
      this.remoteReady.set(xid, false); this.trackOf(xid).last_output_ms = Date.now()
      // Restore any in-memory mutation rolled back with a cursor/event transaction.
      for (const w of repo.listActiveWatches(this.conn)) if (w.spec.execution_id === xid) this.arm(w)
    }).finally(() => this.remoteFlights.delete(xid))
  }
  private async readRemote(xid: string): Promise<void> {
    const job = this.conn.get('SELECT * FROM remote_jobs WHERE execution_id=?', [xid])
    const execution = repo.getExecution(this.conn, xid)
    if (!job || !execution) return
    // a target the person disconnected is not dialed, nor one whose connection is being restored: its return polls
    if (this.state.remote.isPaused(String(job.target_id)) || !this.state.remote.reachable(String(job.target_id))) { this.remoteReady.set(xid, false); this.trackOf(xid).last_output_ms = Date.now(); return }
    const ws = execution.workspace_id ? repo.getWorkspace(this.conn, execution.workspace_id) : null
    if (!ws) return
    const root = remoteBinding(ws)
    for (const initial of this.armedOn(xid)) {
      let armed = this.armed.get(initial.watch.id)
      if (!armed) continue
      if (armed.watch.spec.kind === 'exit' && !this.state.processes.isRunning(xid)) {
        this.fire(armed, this.exitDetail(execution), { execution_id: xid, status: execution.status, exit_code: execution.exit_code }); continue
      }
      if (!job.job_id) continue // unknown start is not EOF or terminal
      const streams: Stream[] = armed.watch.spec.stream === 'stdout' ? ['stdout'] : armed.watch.spec.stream === 'stderr' ? ['stderr'] : ['stdout','stderr']
      let drained = true, gap = false, caughtAll = true
      for (const stream of streams) {
        let caughtUp = false
        for (let n = 0; n < 4; n++) {
          if (this.closed || !this.armed.has(initial.watch.id)) return
          const cursor = this.conn.get('SELECT * FROM remote_watch_cursors WHERE watch_id=? AND stream=?', [initial.watch.id, stream])
          const offset = Number(cursor?.byte_offset ?? 0)
          const saved = cursor ? { ...emptyRemoteCursor(), ...JSON.parse(String(cursor.state_json)) } as RemoteCursorState : emptyRemoteCursor()
          const page = await this.state.remote.request(root, 'jobs.read', { job_id: String(job.job_id), stream, byte_offset: offset, limit: 65536 }, undefined, { wait_ms: 0 })
          if (this.closed) return
          if (this.state.remote.isPaused(root.target_id)) { this.remoteReady.set(xid, false); return }
          const bytes = Buffer.from(page.data, 'base64')
          if (page.byte_offset !== offset || page.next_offset !== offset + bytes.length || bytes.length > 65536 || page.next_offset > page.total_retained || (page.eof && page.next_offset < page.total_retained)) throw new Error('Remote watch output page is inconsistent')
          const connected = this.state.processes.remoteConnected(xid)
          if (!this.remoteReady.get(xid) && connected) this.trackOf(xid).last_output_ms = Date.now()
          this.remoteReady.set(xid, connected)
          const final = page.eof && !this.state.processes.isRunning(xid)
          const parsed = remoteLines(saved, bytes, final)
          parsed.state.gap ||= page.gaps.length > 0 || page.storage_failed === true || page.log_complete === false
          if (bytes.length) { this.trackOf(xid).last_output_ms = Date.now(); parsed.state.silent = false }
          this.conn.transaction(() => {
            const current = repo.getWatch(this.conn, initial.watch.id)
            armed = this.armed.get(initial.watch.id)
            if (!current || current.status !== 'active' || !armed) return
            armed.watch = current; armed.last_fire_ms = current.last_fired_at ? Date.parse(current.last_fired_at) : 0
            armed.line.holding = parsed.state.holding; armed.silent = parsed.state.silent
            for (const line of parsed.lines) { if (!this.armed.has(current.id)) break; this.readInto(armed, stream, line, false) }
            parsed.state.holding = armed.line.holding; parsed.state.silent = armed.silent
            this.conn.run('INSERT INTO remote_watch_cursors (watch_id,stream,byte_offset,state_json) VALUES (?,?,?,?) ON CONFLICT(watch_id,stream) DO UPDATE SET byte_offset=excluded.byte_offset,state_json=excluded.state_json', [current.id,stream,page.next_offset,JSON.stringify(parsed.state)])
            this.conn.run("UPDATE remote_watch_cursors SET state_json=json_set(state_json,'$.holding',json(?),'$.silent',json(?)) WHERE watch_id=?", [JSON.stringify(armed.line.holding),JSON.stringify(armed.silent),current.id])
          })
          gap ||= parsed.state.gap
          caughtUp = page.next_offset >= page.total_retained
          if (caughtUp || !bytes.length) { drained &&= final; break }
          drained = false
        }
        if (!caughtUp) { drained = false; caughtAll = false } // backlog is not silence
      }
      if (!caughtAll || gap) this.remoteReady.set(xid, false)
      armed = this.armed.get(initial.watch.id)
      if (armed?.watch.spec.kind === 'silence' && !armed.silent && caughtAll && !gap && this.remoteReady.get(xid) && job.state === 'running') {
        const now = Date.now(), since = Math.max(this.tracks.get(xid)?.last_output_ms ?? armed.armed_ms, armed.armed_ms)
        if (now - since >= armed.watch.spec.silence_s! * 1000) this.conn.transaction(() => {
          armed!.silent = true
          this.fire(armed!, text('watch.detail_silence', { execution_id: xid, seconds: String(Math.round((now - since) / 1000)) }), { execution_id: xid })
          this.conn.run("UPDATE remote_watch_cursors SET state_json=json_set(state_json,'$.silent',json('true')) WHERE watch_id=?", [initial.watch.id])
        })
      }
      if (armed && drained && !this.state.processes.isRunning(xid)) {
        const ended = repo.getExecution(this.conn, xid)!
        if (armed.watch.spec.kind === 'exit') this.fire(armed, this.exitDetail(ended), { execution_id: xid, status: ended.status, exit_code: ended.exit_code })
        else if (gap) this.end(armed, 'lost', 'Remote output was not retained in full; the watch cannot determine whether its condition occurred.')
        else this.end(armed, 'ended', text('watch.detail_ended', { execution_id: xid, how: howEnded(ended), last: '' }))
      }
    }
  }

  /** A chunk of a running command's output: split into lines (a progress bar's carriage returns end lines too), each
   *  kept among the recent ones and read by the watches on it. */
  private output(xid: string, stream: Stream, chunk: Buffer): void {
    if (this.closed) return
    const track = this.trackOf(xid)
    track.last_output_ms = Date.now()
    for (const armed of this.armedOn(xid)) if (armed.watch.spec.kind === 'silence') armed.silent = false
    const lines = this.linesOf(track, stream, track.decoders[stream].decode(chunk, { stream: true }))
    let rest = lines.pop() ?? ''
    // a line past the read limit is read once, as far as the limit; the rest of it is skipped up to its end, never
    // read as a line of its own (a tail that starts with ERROR is not a line that does)
    if (rest.length > MAX_LINE_CHARS) { lines.push(rest); rest = ''; track.skipping[stream] = true }
    track.partial[stream] = rest
    for (const line of lines) this.line(xid, track, stream, line)
  }

  /** The stream's text so far as lines, the last one unfinished; the tail of an over-long line is dropped first. */
  private linesOf(track: Track, stream: Stream, decoded: string): string[] {
    let text = track.partial[stream] + decoded
    if (track.skipping[stream]) {
      const end = /\r\n|\n|\r/.exec(text)
      if (end === null) return ['']
      text = text.slice(end.index + end[0].length)
      track.skipping[stream] = false
    }
    return text.split(/\r\n|\n|\r/)
  }

  private line(xid: string, track: Track, stream: Stream, line: string): void {
    if (!line.trim()) return
    const kept = line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) : line
    track.recent.push({ stream, line: kept })
    track.recent_chars += kept.length
    while (track.recent.length > RECENT_LINES || track.recent_chars > RECENT_CHARS) track.recent_chars -= track.recent.shift()!.line.length
    for (const armed of this.armedOn(xid)) this.readInto(armed, stream, kept, false)
  }

  private readInto(armed: Armed, stream: Stream, line: string, earlier: boolean): void {
    const spec = armed.watch.spec
    if (spec.kind !== 'match' && spec.kind !== 'metric') return
    if (spec.stream !== 'both' && spec.stream !== stream) return
    const read = readLine(spec, { re: armed.re, metric: armed.metric }, armed.line, line)
    if (!read.occurrence) return
    const quoted = quote(line)
    const already = earlier ? text('watch.detail_earlier') : ''
    const detail = spec.kind === 'match'
      ? text('watch.detail_match', { execution_id: spec.execution_id!, stream, line: quoted, earlier: already })
      : text('watch.detail_metric', { name: spec.field ?? 'the number', value: shownNumber(read.value!), execution_id: spec.execution_id!, stream, line: quoted, earlier: already })
    this.fire(armed, detail, { execution_id: spec.execution_id, stream, line: quoted, ...(read.value !== undefined ? { value: shownNumber(read.value) } : {}) })
  }

  /** A command ended (its record says how): its last partial lines are read, its exit watches fire, and the watches
   *  that were waiting for something in its output end, saying the command ended first. */
  private ended(xid: string): void {
    if (this.closed) return
    const track = this.tracks.get(xid)
    if (track) {
      for (const stream of ['stdout', 'stderr'] as const) {
        const lines = this.linesOf(track, stream, track.decoders[stream].decode())
        track.partial[stream] = ''
        for (const line of lines) this.line(xid, track, stream, line)
      }
    }
    const execution = repo.getExecution(this.conn, xid)
    const last = track ? lastLines(track) : ''
    this.tracks.delete(xid)
    if (execution === null) return
    for (const armed of this.armedOn(xid)) {
      if (armed.watch.spec.kind === 'exit') this.fire(armed, this.exitDetail(execution, last), { execution_id: xid, status: execution.status, exit_code: execution.exit_code })
      else this.end(armed, 'ended', text('watch.detail_ended', { execution_id: xid, how: howEnded(execution), last }))
    }
  }

  private exitDetail(execution: Execution, last = ''): string {
    return text('watch.detail_exit', {
      execution_id: execution.id, how: howEnded(execution), stdout: String(execution.stdout_bytes), stderr: String(execution.stderr_bytes), last,
    })
  }

  // -- firing ---------------------------------------------------------------------------------------

  /** The watch reports: an event recorded, the watch's count kept, the watch ended unless it repeats and may again;
   *  a repeat inside its cooldown, or past its fires, is not reported. */
  private fire(armed: Armed, detail: string, payload: Record<string, unknown>): void {
    const w = armed.watch
    const now = Date.now()
    if (w.fires >= w.max_fires) return
    if (w.repeat && armed.last_fire_ms && now - armed.last_fire_ms < w.cooldown_s * 1000) return
    armed.last_fire_ms = now
    const fires = w.fires + 1
    const at = nowIso()
    const done = !w.repeat || fires >= w.max_fires
    // the event and the watch's count are one fact: a restart between them would report again, or count a report
    // nobody gets
    this.conn.transaction(() => {
      repo.insertWakeEvent(this.conn, { watch_id: w.id, session_id: w.session_id, kind: 'fired', detail, payload })
      repo.updateWatch(this.conn, w.id, { fires, last_fired_at: at, ...(done ? { status: 'done', ended_reason: w.repeat ? `reported ${fires} times (its limit)` : 'reported' } : {}) })
    })
    armed.watch = { ...w, fires, last_fired_at: at }
    if (done) this.disarm(w.id)
    this.schedule(w.session_id)
  }

  /** The watch ends without its condition: its command ended or was lost, or its time ran out. */
  private end(armed: Armed, kind: 'ended' | 'lost' | 'expired', detail: string): void {
    const w = armed.watch
    this.conn.transaction(() => {
      repo.insertWakeEvent(this.conn, { watch_id: w.id, session_id: w.session_id, kind, detail, payload: {} })
      repo.updateWatch(this.conn, w.id, { status: kind === 'expired' ? 'expired' : 'done', ended_reason: kind === 'ended' ? 'the command ended' : kind === 'lost' ? 'the command was stopped by a restart' : 'expired' })
    })
    this.disarm(w.id)
    this.schedule(w.session_id)
  }

  // -- time -------------------------------------------------------------------------------------------

  private dueOf(armed: Armed): number | null {
    const spec = armed.watch.spec
    if (spec.kind !== 'timer') return null
    if (armed.watch.fires === 0) return Date.parse(spec.at!)
    // a repeating timer reports no more often than its cooldown allows, whatever its period
    return spec.every_s ? armed.last_fire_ms + Math.max(spec.every_s, armed.watch.cooldown_s) * 1000 : null
  }

  /** The next timer set: the soonest watch due (at most an hour ahead, then looked at again). */
  private reschedule(): void {
    if (this.closed) return
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    let soonest: number | null = null
    for (const armed of this.armed.values()) {
      const due = this.dueOf(armed)
      if (due !== null && (soonest === null || due < soonest)) soonest = due
    }
    if (soonest === null) return
    this.timer = setTimeout(() => {
      this.timer = null
      try { this.timers() } catch (error) { console.warn(`watches: ${(error as Error).message}`) }
    }, Math.min(MAX_TIMER_MS, Math.max(0, soonest - Date.now())))
    this.timer.unref?.()
  }

  private timers(): void {
    const now = Date.now()
    for (const armed of [...this.armed.values()]) {
      if (this.sessionGone(armed.watch.session_id)) { this.withdraw(armed.watch, SESSION_DELETED); continue }
      const due = this.dueOf(armed)
      if (due === null || due > now) continue
      const late = now - due > 60_000 ? text('watch.detail_late', { due: new Date(due).toISOString() }) : ''
      armed.last_fire_ms = 0
      this.fire(armed, text('watch.detail_timer', { at: new Date(now).toISOString(), late }), { due: new Date(due).toISOString() })
      armed.last_fire_ms = now
    }
    this.reschedule()
  }

  /** Every few seconds: a command silent too long, a watch past its time, events that wait for a free conversation. */
  private tick(): void {
    if (this.closed) return
    const now = Date.now()
    for (const armed of [...this.armed.values()]) {
      if (this.sessionGone(armed.watch.session_id)) { this.withdraw(armed.watch, SESSION_DELETED); continue }
      if (now >= Date.parse(armed.watch.expires_at)) { this.end(armed, 'expired', text('watch.detail_expired', { at: armed.watch.expires_at })); continue }
      const spec = armed.watch.spec
      if (spec.execution_id && this.state.processes.isRemoteExecution(spec.execution_id)) { this.pullRemote(spec.execution_id); continue }
      if (spec.kind !== 'silence' || armed.silent) continue
      const since = this.tracks.get(spec.execution_id!)?.last_output_ms ?? armed.armed_ms
      if (now - Math.max(since, armed.armed_ms) < spec.silence_s! * 1000) continue
      armed.silent = true
      this.fire(armed, text('watch.detail_silence', { execution_id: spec.execution_id!, seconds: String(Math.round((now - Math.max(since, armed.armed_ms)) / 1000)) }), { execution_id: spec.execution_id })
    }
    for (const sessionId of new Set(repo.listPendingWakeEvents(this.conn).map((e) => e.session_id))) this.schedule(sessionId)
  }

  // -- delivery ---------------------------------------------------------------------------------------

  /** A session's waiting events go once the moment's events are gathered (an exit and the watches it ended). */
  private schedule(sessionId: string, delayMs = this.debounceMs): void {
    if (this.closed || this.scheduled.has(sessionId)) return
    const timer = setTimeout(() => { this.scheduled.delete(sessionId); void this.deliver(sessionId) }, delayMs)
    timer.unref?.()
    this.scheduled.set(sessionId, timer)
  }

  /** Whether the thread is taken: a run of it under way, an interaction or a relay in progress (its next step starts
   *  on its own). */
  private busy(sessionId: string): boolean {
    if (this.state.runs.activeRunOfSession(sessionId) !== null) return true
    if (repo.listInteractions(this.conn, sessionId).some((i) => (ACTIVE_INTERACTION_STATUSES as readonly string[]).includes(i.status))) return true
    return repo.listRelays(this.conn, sessionId).some((r) => (ACTIVE_RELAY_STATUSES as readonly string[]).includes(r.status))
  }

  /** Whether a participant's conversation is taken: its latest run under way, its interaction being planned or
   *  decided on, its relay in progress. */
  private memberBusy(assignment: Assignment, head: Run): boolean {
    if ((ACTIVE_RUN_STATUSES as readonly string[]).includes(head.status)) return true
    const group = assignment.runs.get(head.id)?.group ?? null
    if (group?.kind === 'interaction') {
      const status = repo.getInteraction(this.conn, group.id)?.status
      return status === 'planning' || status === 'deciding'
    }
    if (group?.kind === 'relay') return repo.listRelays(this.conn, head.session_id).some((r) => r.id === group.id && (ACTIVE_RELAY_STATUSES as readonly string[]).includes(r.status))
    return false
  }

  /** The session's waiting events, each conversation's as one run of it: the harness's message, under the idempotency
   *  key of its first event (a restart between the run and its record takes the same run, never a second one). */
  async deliver(sessionId: string): Promise<string | null> {
    if (this.closed || this.delivering.has(sessionId)) return null
    try { return await this.deliverNow(sessionId) } catch (error) {
      // the database gone under a timer (a harness that died without closing): nothing to deliver to
      console.warn(`watches: session ${sessionId}: ${(error as Error).message}`)
      return null
    }
  }

  private async deliverNow(sessionId: string): Promise<string | null> {
    const pending = repo.listPendingWakeEvents(this.conn, sessionId)
    // a cancelled watch wakes no one: a report of it still here (from before the cancel withdrew them) is dropped
    const withdrawn = pending.filter((e) => repo.getWatch(this.conn, e.watch_id)?.status === 'cancelled')
    if (withdrawn.length) repo.settleWakeEvents(this.conn, withdrawn.map((e) => e.id), 'dropped', null)
    const events = pending.filter((e) => !withdrawn.includes(e))
    if (!events.length) return null
    const session = repo.getSession(this.conn, sessionId)
    if (session === null || session.status === repo.DELETED_SESSION || !session.workspace_id) {
      repo.settleWakeEvents(this.conn, events.map((e) => e.id), 'dropped', null)
      return null
    }
    const { assignment } = assignmentOf(this.state, sessionId)
    const byConversation = new Map<string, { head: string | null; events: WakeEvent[] }>()
    for (const e of events) {
      const setBy = repo.getWatch(this.conn, e.watch_id)?.run_id ?? null
      const target = setBy === null ? { key: THREAD, head: null } : targetOf(assignment, setBy)
      const group = byConversation.get(target.key) ?? { head: target.head, events: [] }
      group.events.push(e)
      byConversation.set(target.key, group)
    }
    this.delivering.add(sessionId)
    try {
      let first: string | null = null
      for (const [key, group] of byConversation) {
        if (repo.countRunsSince(this.conn, sessionId, 'wake', new Date(Date.now() - 3_600_000).toISOString()) >= this.wakesPerHour) break
        const runId = group.head === null ? await this.wakeThread(session, group.events) : await this.wakeMember(assignment, `${sessionId}/${key}`, group.head, group.events)
        first ??= runId
      }
      return first
    } finally {
      this.delivering.delete(sessionId)
    }
  }

  /** The thread's events as its next run, once the thread is free. */
  private async wakeThread(session: Session, events: WakeEvent[]): Promise<string | null> {
    if (this.busy(session.id)) return null
    const failure = `${session.id}/${THREAD}`
    try {
      const message = this.message(events)
      const key = `wake:${events[0]!.id}`
      let made = false
      const run = await this.state.runs.startOnce(session.id, key, () => { made = true; return this.state.runs.start(session, message, { spawned_by: 'wake', wake: true, client_request_id: key }) })
      // the run the key made before a restart carried the events of its own message, not the ones that came since
      this.delivered(session.id, failure, made ? events : this.carriedBy(run, events), events, run.id)
      return run.id
    } catch (error) {
      this.failed(failure, events, error)
      return null
    }
  }

  /** A participant's events as its follow-up (a step of its group when it is a member of one), once its conversation
   *  is free; a step queued behind its group's others has them too. */
  private async wakeMember(assignment: Assignment, failure: string, headId: string, events: WakeEvent[]): Promise<string | null> {
    const head = repo.getRun(this.conn, headId)
    if (head === null || this.memberBusy(assignment, head)) return null
    try {
      const out = await wakeParticipant(this.state, head, { text: this.message(events), client_request_id: `wake:${events[0]!.id}`, watch_id: events[0]!.watch_id })
      if ('queued' in out) { this.delivered(head.session_id, failure, events, events, null); return null }
      // a key that made its run before a restart: the events its message carried, as for the thread
      this.delivered(head.session_id, failure, this.carriedBy(out.run, events), events, out.run.id)
      return out.run.id
    } catch (error) {
      this.failed(failure, events, error)
      return null
    }
  }

  private delivered(sessionId: string, failure: string, carried: WakeEvent[], events: WakeEvent[], runId: string | null): void {
    repo.settleWakeEvents(this.conn, carried.map((e) => e.id), 'delivered', runId)
    this.failures.delete(failure)
    if (carried.length < events.length) this.schedule(sessionId)
  }

  private failed(failure: string, events: WakeEvent[], error: unknown): void {
    const attempts = (this.failures.get(failure) ?? 0) + 1
    this.failures.set(failure, attempts)
    console.warn(`watches: the wake of ${failure} did not start (${(error as Error).message}); attempt ${attempts} of ${MAX_DELIVERY_ATTEMPTS}`)
    if (attempts >= MAX_DELIVERY_ATTEMPTS) {
      repo.settleWakeEvents(this.conn, events.map((e) => e.id), 'dropped', null)
      this.failures.delete(failure)
      if (events[0]) this.settled(events[0].session_id)
    }
  }

  /** The events an earlier wake run's message carried: the waiting events from its key's first one on, as many as
   *  its message was made of (events only come after it, so they are the first of those waiting); the first alone
   *  when no count reproduces it. */
  private carriedBy(run: Run, events: WakeEvent[]): WakeEvent[] {
    for (let count = events.length; count > 0; count -= 1) if (this.message(events.slice(0, count)) === run.user_text) return events.slice(0, count)
    return events.slice(0, 1)
  }

  /** Whether the session is gone (deleted, or never there): its watches wait for nothing. */
  private sessionGone(sessionId: string): boolean {
    const session = repo.getSession(this.conn, sessionId)
    return session === null || session.status === repo.DELETED_SESSION
  }

  /** The message a batch of events becomes: each watch's line, what it saw, and the agent's own note. */
  message(events: WakeEvent[]): string {
    const lines: string[] = []
    for (const e of events) {
      const w = repo.getWatch(this.conn, e.watch_id)
      lines.push(text('watch.event', { watch_id: e.watch_id, summary: w?.summary ?? '?', detail: e.detail, note: w?.note ?? '' }))
    }
    return text('watch.woken', { count: String(events.length), events: lines.join('\n') })
  }
}

function howEnded(execution: Execution): string {
  const code = execution.exit_code !== null ? `, exit code ${execution.exit_code}` : ''
  return `${execution.status}${code}`
}

function quote(line: string): string {
  const t = line.trim()
  return t.length <= QUOTE_CHARS ? t : `${t.slice(0, QUOTE_CHARS)}…`
}

function lastLines(track: Track): string {
  const picked = track.recent.slice(-LAST_LINES).map((r) => r.line.trim().slice(0, 300))
  let out = picked.join('\n')
  if (out.length > LAST_LINES_CHARS) out = out.slice(out.length - LAST_LINES_CHARS)
  return out ? `\n  Last lines:\n  ${out.split('\n').join('\n  ')}` : ''
}

/** The conversation a run holds, and its latest run: the thread's (no head: its next run continues it), or a
 *  participant's own — a group's member, a relay's member, a separate task — continued from its latest run. */
function targetOf(assignment: Assignment, runId: string): { key: string; head: string | null } {
  const a = assignment.runs.get(runId)
  if (!a || a.role === null || a.role === 'main' || a.conversation_id === null) return { key: THREAD, head: null }
  return { key: a.conversation_id, head: assignment.conversations.get(a.conversation_id)?.runs.at(-1) ?? runId }
}
