/** The session's one stream at the module level (agent/session_events.ts, schema v26's cursor): a persisted cursor that
 *  only goes up, a replay of a session's runs in cursor order from memory and from the database, a resume after any id
 *  that loses nothing, the live events after it, no event of another session, a subscriber that goes away or falls too
 *  far behind let go. The runner itself is not loaded: these hold on a database and the hub alone. */

import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { SESSION_STREAM_READY } from '@oasis-code/contract'
import { connect, type Conn } from '../src/db/database.ts'
import * as repo from '../src/db/repo.ts'
import { runEventsPage, SESSION_BACKLOG, SessionEventHub, sessionEvents, snapshotCursor, type CursorRunEvent, type MemoryRun, type SessionFrame } from '../src/agent/session_events.ts'
import { tempDir } from './helpers.ts'

function database(): Conn {
  const conn = connect(join(tempDir(), 'index.db'))
  conn.run("INSERT INTO projects (id, name, base_repo_path, created_at, updated_at) VALUES ('p','p','/x','t','t')")
  for (const s of ['s1', 's2']) conn.run("INSERT INTO sessions (id, project_id, title, model, created_at, updated_at) VALUES (?,'p','t','m','t','t')", [s])
  return conn
}
function addRun(conn: Conn, id: string, session: string): void {
  conn.run("INSERT INTO runs (id, session_id, project_id, model, user_text, status, created_at) VALUES (?,?,'p','m','hi','running','t')", [id, session])
}

/** A run as the runner holds one: emit writes all but a delta, publishes to the hub. */
class Held implements MemoryRun {
  events: CursorRunEvent[] = []
  done = false
  constructor(readonly conn: Conn, readonly hub: SessionEventHub, readonly session: string, readonly run_id: string) { addRun(conn, run_id, session) }
  emit(event: string, data: Record<string, unknown> = {}): CursorRunEvent {
    const item: CursorRunEvent = { seq: this.events.length, event, data, run_id: this.run_id, cursor: null }
    this.events.push(item)
    if (event !== 'text_delta') item.cursor = repo.insertEvent(this.conn, this.run_id, item.seq, event, data)
    this.hub.publish(this.session, item)
    return item
  }
}

interface Heard { event: string; id: number; run_id?: string; seq?: number; data: Record<string, unknown> }
const parse = (f: SessionFrame): Heard => {
  const d = JSON.parse(f.data) as Record<string, unknown>
  return f.event === SESSION_STREAM_READY ? { event: f.event, id: f.id, data: d } : { event: f.event, id: f.id, run_id: d.run_id as string, seq: d.seq as number, data: d.data as Record<string, unknown> }
}
/** What a stream sends up to its stream_ready (the replay), and the generator to read on from. */
async function replay(stream: AsyncGenerator<SessionFrame>): Promise<{ frames: Heard[]; ready: Heard }> {
  const frames: Heard[] = []
  for (;;) {
    const next = await stream.next()
    if (next.done) throw new Error('the stream ended before stream_ready')
    const heard = parse(next.value)
    if (heard.event === SESSION_STREAM_READY) return { frames, ready: heard }
    frames.push(heard)
  }
}
const key = (h: Heard) => `${h.run_id}#${h.seq}`

test('the cursor is persisted, only goes up, survives a VACUUM and is never reused after the newest row is deleted', () => {
  const conn = database()
  addRun(conn, 'r', 's1')
  const a = repo.insertEvent(conn, 'r', 0, 'run_started', {})!
  const b = repo.insertEvent(conn, 'r', 1, 'text_block', {})!
  expect(b).toBeGreaterThan(a)
  expect(repo.insertEvent(conn, 'r', 1, 'text_block', {})).toBeNull()                     // the same (run, seq): nothing written
  conn.run('DELETE FROM run_events WHERE cursor = ?', [b])                                  // the newest row gone (by hand)
  const c = repo.insertEvent(conn, 'r', 2, 'run_finished', {})!
  expect(c).toBeGreaterThan(b)                                                              // a rowid would have been reused here
  conn.exec('VACUUM')
  expect(conn.all('SELECT cursor FROM run_events ORDER BY seq').map((r) => r.cursor)).toEqual([a, c])
  expect(repo.lastEventCursor(conn)).toBe(c)
})

test('a v25 database migrates to v26: its events take their rowid, in written order, and the counter goes on after them', () => {
  const dir = tempDir()
  const path = join(dir, 'index.db')
  const fresh = connect(path)
  fresh.run("INSERT INTO projects (id, name, base_repo_path, created_at, updated_at) VALUES ('p','p','/x','t','t')")
  fresh.run("INSERT INTO sessions (id, project_id, title, model, created_at, updated_at) VALUES ('s1','p','t','m','t','t')")
  addRun(fresh, 'r', 's1')
  fresh.close()
  // back to v25 as it stood: no cursor column, no counter
  const raw = new Database(path)
  raw.exec('DROP INDEX run_events_by_cursor; DROP INDEX run_events_by_session_cursor; DROP TABLE event_cursor; ALTER TABLE run_events DROP COLUMN cursor; ALTER TABLE run_events DROP COLUMN session_id; DROP INDEX IF EXISTS runs_read; PRAGMA user_version = 25;')
  for (let seq = 0; seq < 3; seq += 1) raw.run("INSERT INTO run_events (run_id, seq, version, event, data_json, created_at) VALUES ('r', ?, 1, 'text_block', '{}', 't')", [seq])
  raw.close()
  const migrated = connect(path)
  expect(migrated.get('PRAGMA user_version')!.user_version).toBe(37)  // v29: the sessions' task and roots; v30: SSH targets; v31: SSH connect intent; v32: CNY costs, v33 read-path indexes
  const rows = migrated.all('SELECT seq, cursor, session_id, rowid AS r FROM run_events ORDER BY seq')
  expect(rows.map((r) => r.cursor)).toEqual(rows.map((r) => r.r))
  expect(rows.map((r) => r.session_id)).toEqual(['s1', 's1', 's1'])
  expect(repo.sessionEventsAfter(migrated, 's1', 0, repo.lastEventCursor(migrated), 10).map((e) => e.seq)).toEqual([0, 1, 2])
  expect(repo.lastEventCursor(migrated)).toBe(Number(rows[2]!.cursor))
  expect(repo.insertEvent(migrated, 'r', 3, 'run_finished', {})).toBe(Number(rows[2]!.cursor) + 1)
})

test('a fresh subscriber from the snapshot cursor hears every run live at the snapshot whole, deltas included, then live', async () => {
  const conn = database()
  const hub = new SessionEventHub()
  const old = new Held(conn, hub, 's1', 'old')
  old.emit('run_started'); old.emit('run_finished'); old.done = true                      // ended before: its transcript
  const live = new Held(conn, hub, 's1', 'live')
  live.emit('run_started'); live.emit('text_delta', { text: 'he' }); live.emit('text_delta', { text: 'llo' })
  const runs = [old, live]
  const cursor = snapshotCursor(conn, runs)
  const stream = sessionEvents({ conn, hub, runs: () => runs }, 's1', { after: cursor })
  const { frames, ready } = await replay(stream)
  expect(frames.map(key)).toEqual(['live#0', 'live#1', 'live#2'])
  expect(ready.data).toEqual({ cursor: frames.at(-1)!.id, live_runs: ['live'] })
  // a run started after the snapshot is heard from its first event, without being named to the stream
  const later = new Held(conn, hub, 's1', 'later'); runs.push(later)
  later.emit('run_started')
  live.emit('text_block', { text: 'hello' })
  const a = parse((await stream.next()).value!), b = parse((await stream.next()).value!)
  expect([key(a), key(b)]).toEqual(['later#0', 'live#3'])
  expect(b.id).toBeGreaterThan(a.id)
  await stream.return(undefined)
  expect(hub.subscribers('s1')).toBe(0)
})

test('a resume after any id it sent loses nothing and repeats only what the client drops by seq', async () => {
  const conn = database()
  const hub = new SessionEventHub()
  // runs of an earlier process (the database only) and runs this one holds, interleaved
  const runs: Held[] = []
  for (let i = 0; i < 4; i += 1) runs.push(new Held(conn, hub, 's1', `r${i}`))
  for (let round = 0; round < 30; round += 1) for (const r of runs) { r.emit(round % 3 === 0 ? 'text_delta' : 'tool_call', { round }); }
  const held = runs.slice(2)                                                                // r0, r1: no handle any more
  const deps = { conn, hub, runs: () => held as MemoryRun[] }
  const whole = (await replay(sessionEvents(deps, 's1', { after: 0 }))).frames
  // every persisted event of every run, every delta of a held run, each run in seq order, ids never going down
  const persisted = (r: Held) => r.events.filter((e) => e.event !== 'text_delta').map((e) => `${r.run_id}#${e.seq}`)
  const expected = new Set([...persisted(runs[0]!), ...persisted(runs[1]!), ...runs[2]!.events.map((e) => `r2#${e.seq}`), ...runs[3]!.events.map((e) => `r3#${e.seq}`)])
  expect(new Set(whole.map(key))).toEqual(expected)
  expect(whole.length).toBe(expected.size)
  for (let i = 1; i < whole.length; i += 1) expect(whole[i]!.id).toBeGreaterThanOrEqual(whole[i - 1]!.id)
  for (const r of runs) {
    const seqs = whole.filter((h) => h.run_id === r.run_id).map((h) => h.seq!)
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y))
  }
  // cut after every frame in turn: what the client had plus the resume is everything, once by (run, seq)
  for (let cut = 0; cut < whole.length; cut += 7) {
    const had = whole.slice(0, cut + 1)
    const again = (await replay(sessionEvents(deps, 's1', { after: had.at(-1)!.id }))).frames
    const union = new Set([...had.map(key), ...again.map(key)])
    expect(union).toEqual(expected)
  }
})

test('no event of another session; a deleted session ends its streams; a stalled subscriber is let go, bounded', async () => {
  const conn = database()
  const hub = new SessionEventHub()
  const mine = new Held(conn, hub, 's1', 'mine')
  const theirs = new Held(conn, hub, 's2', 'theirs')
  mine.emit('run_started'); theirs.emit('run_started')
  const stream = sessionEvents({ conn, hub, runs: () => [mine] }, 's1', { after: 0 })
  const { frames } = await replay(stream)
  expect(frames.map(key)).toEqual(['mine#0'])
  theirs.emit('text_block'); mine.emit('text_block')
  expect(key(parse((await stream.next()).value!))).toBe('mine#1')
  hub.end('s1')
  expect((await stream.next()).done).toBe(true)
  expect(hub.subscribers('s1')).toBe(0)
  // a reader that stops reading: past SESSION_BACKLOG it is ended (its client resumes after its cursor)
  const stalled = sessionEvents({ conn, hub, runs: () => [mine] }, 's1', { after: 0 })
  await replay(stalled)
  for (let i = 0; i < SESSION_BACKLOG + 5; i += 1) mine.emit('text_delta', { text: 'x' })
  let rest = 0
  for await (const f of stalled) { void f; rest += 1 }
  expect(rest).toBe(0)
  expect(hub.subscribers('s1')).toBe(0)
})

test('an abort while the session is quiet lets the subscriber go at once', async () => {
  const conn = database()
  const hub = new SessionEventHub()
  const run = new Held(conn, hub, 's1', 'r')
  run.emit('run_started')
  const gone = new AbortController()
  const stream = sessionEvents({ conn, hub, runs: () => [run] }, 's1', { after: 0, signal: gone.signal })
  await replay(stream)
  const waiting = stream.next()
  expect(hub.subscribers('s1')).toBe(1)
  gone.abort()
  expect((await waiting).done).toBe(true)
  expect(hub.subscribers('s1')).toBe(0)
})

test('a replay reads pages by the cursor index, not each run\'s history: 24 runs x 100 events', async () => {
  const conn = database()
  const hub = new SessionEventHub()
  const runs: Held[] = []
  for (let i = 0; i < 24; i += 1) runs.push(new Held(conn, hub, 's1', `r${i}`))
  for (let round = 0; round < 100; round += 1) for (const r of runs) r.emit('tool_call', { round })
  const plan = conn.all('EXPLAIN QUERY PLAN SELECT run_id, seq, event, data_json, cursor FROM run_events'
    + ' WHERE session_id = ? AND cursor > ? AND cursor <= ? ORDER BY cursor LIMIT ?', ['s1', 0, 1, 500]).map((r) => String(r.detail))
  expect(plan).toEqual(['SEARCH run_events USING INDEX run_events_by_session_cursor (session_id=? AND cursor>? AND cursor<?)'])
  const started = performance.now()
  const { frames } = await replay(sessionEvents({ conn, hub, runs: () => [] }, 's1', { after: 0 }))
  const ms = performance.now() - started
  expect(frames.length).toBe(2400)
  const resumed = performance.now()
  const tail = (await replay(sessionEvents({ conn, hub, runs: () => [] }, 's1', { after: frames[2389]!.id }))).frames
  expect(tail.length).toBe(10)
  console.log(`session replay: 2400 events (24 runs x 100) in ${ms.toFixed(1)} ms; a resume 10 from the end in ${(performance.now() - resumed).toFixed(1)} ms; plan: ${plan.join(' | ')}`)
})

test('a run\'s record in bounded pages: from memory with its deltas for a held run, from its key otherwise', () => {
  const conn = database()
  const hub = new SessionEventHub()
  const run = new Held(conn, hub, 's1', 'r')
  for (let i = 0; i < 25; i += 1) run.emit(i % 2 ? 'text_delta' : 'tool_call', { i })
  const pages: number[][] = []
  for (let after = -1; ;) {
    const page = runEventsPage(conn, run, 'r', after, 10)
    pages.push(page.map((e) => e.seq))
    if (page.length < 10) break
    after = page.at(-1)!.seq
  }
  expect(pages.flat()).toEqual(Array.from({ length: 25 }, (_, i) => i))                      // deltas included, each once
  expect(pages.map((p) => p.length)).toEqual([10, 10, 5])
  const stored = runEventsPage(conn, null, 'r', 10, 4)                                        // an earlier process's run
  expect(stored.map((e) => e.seq)).toEqual([12, 14, 16, 18])
  expect(runEventsPage(conn, null, 'r', 24, 10)).toEqual([])
})
