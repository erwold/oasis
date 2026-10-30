import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SessionActivity } from '@oasis-code/contract'
import { applyEvent, type ThreadEntry } from '../src/state/thread.ts'
import { BOT_STATES } from '../src/state/outline.ts'
import { isRunningState, presenceOf, RUNNING_STATES, summaryRunPresence } from '../src/state/presence.ts'
import {
  activityRunning, isUnread, NOT_READY, readSeen, recordsRunning, SEEN_KEY, seenAfterLook, seenAfterSummary, sessionDot, writeSeen,
} from '../src/state/sessionDots.ts'
import type { SSEItem } from '../src/api/types.ts'

// The rail's dot (state/sessionDots.ts) over the bots' own rules (state/presence.ts). Synthetic records only.
const rows = (events: [string, Record<string, unknown>][], runId = 'run_a'): ThreadEntry[] =>
  events.reduce<ThreadEntry[]>((t, [event, data], i) => applyEvent(t, runId, { event, data, id: String(i + 1) } as SSEItem), [])
const live = (o: Partial<SessionActivity['live'][number]> = {}): SessionActivity['live'][number] =>
  ({ id: 'run_a', status: 'running', spawned_by: 'human', model: 'm', slot_waiting: false, pending_input: false, ...o })
const act = (o: Partial<SessionActivity> = {}): SessionActivity => ({ live: [], director: null, ended: 0, ...o })
const memory = () => { const m = new Map<string, string>(); return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) } } }

test('running is the bots\' thinking or working, nothing else: never waiting, blocked, an ending or the still icon', () => {
  assert.deepEqual([...RUNNING_STATES].sort(), ['thinking', 'working'])
  for (const s of BOT_STATES) assert.equal(isRunningState(s), s === 'thinking' || s === 'working', s)
  // the same run read from its rows by presenceOf: in line → waiting, a form → blocked, a call → working
  const run = { id: 'run_a', status: 'running' }
  assert.equal(isRunningState(presenceOf(run, rows([['run_started', {}]]))), true)
  assert.equal(isRunningState(presenceOf(run, rows([['run_started', {}], ['tool_call', { tool_call_id: 't', tool: 'bash', summary: 'x' }]]))), true)
  assert.equal(isRunningState(presenceOf(run, rows([['run_started', {}], ['slot_wait', { scope: 's', limit: 1, behind: ['b'] }]]))), false)
  assert.equal(isRunningState(presenceOf({ id: 'q', status: 'queued' }, [])), false)
  assert.equal(isRunningState(presenceOf(run, [], { pendingInput: true })), false)
})

test('a summary\'s live run is read by the same rules: slot wait and a pending form are not running; queued is not', () => {
  assert.equal(summaryRunPresence(live()), 'thinking')
  assert.equal(summaryRunPresence(live({ slot_waiting: true })), 'waiting')
  assert.equal(summaryRunPresence(live({ pending_input: true })), 'blocked')
  assert.equal(summaryRunPresence(live({ status: 'queued' })), 'waiting')
  // the same verdict presenceOf gives the rows that carry those signals
  const run = { id: 'run_a', status: 'running' }
  assert.equal(summaryRunPresence(live({ slot_waiting: true })), presenceOf(run, rows([['slot_wait', { scope: 's', limit: 1, behind: [] }]])))
  assert.equal(summaryRunPresence(live()), presenceOf(run, rows([['run_started', {}]])))
})

test('a session runs when any agent of it runs (several at once, a background one), or its director answers', () => {
  assert.equal(activityRunning(undefined), false)
  assert.equal(activityRunning(act()), false)
  assert.equal(activityRunning(act({ live: [live({ status: 'queued' }), live({ id: 'b' })] })), true)
  assert.equal(activityRunning(act({ live: [live({ status: 'queued' }), live({ id: 'b', pending_input: true })] })), false)
  // a person's action or a plan's placeholder is no agent
  assert.equal(activityRunning(act({ live: [live({ spawned_by: 'human_action' })] })), false)
  assert.equal(activityRunning(act({ live: [live({ spawned_by: 'plan' })] })), false)
  const director = (state: string, status: string | null) => act({ director: { state, turn: status ? { id: 't', status, finished_at: null } : null } })
  assert.equal(activityRunning(director('generating', 'generating')), true)
  assert.equal(activityRunning(director('generating', 'awaiting_answer')), true)
  assert.equal(activityRunning(director('idle', 'queued')), false)
  assert.equal(activityRunning(director('waiting_for_tasks', null)), false)
  assert.equal(activityRunning(director('needs_login', 'generating')), false)
})

test('the open session runs by its records\' bots: a live agent run thinking or working, its director', () => {
  const stateOf = (r: { id: string }) => (r.id === 'w' ? 'working' : r.id === 'q' ? 'waiting' : 'blocked') as never
  assert.equal(recordsRunning([{ id: 'q', status: 'queued' }, { id: 'b', status: 'running' }], stateOf), false)
  assert.equal(recordsRunning([{ id: 'q', status: 'queued' }, { id: 'w', status: 'running' }], stateOf), true)
  // an ended record is not asked; a person's action never runs as an agent
  assert.equal(recordsRunning([{ id: 'w', status: 'done' }], stateOf), false)
  assert.equal(recordsRunning([{ id: 'w', status: 'running', spawned_by: 'human_action' }], stateOf), false)
  assert.equal(recordsRunning([], stateOf, { state: 'generating', turn: { status: 'generating' } }), true)
  assert.equal(recordsRunning([], stateOf, { state: 'idle', turn: { status: 'done', finished_at: 'x' } }), false)
})

test('the dot: blue over green; green for any unseen end, never while the session is in view', () => {
  assert.equal(sessionDot({ running: true, ended: 3, seen: 1, viewing: false }), 'running')
  assert.equal(sessionDot({ running: true, ended: 0, seen: null, viewing: true }), 'running')
  assert.equal(sessionDot({ running: false, ended: 2, seen: 1, viewing: false }), 'unread')
  assert.equal(sessionDot({ running: false, ended: 2, seen: 2, viewing: false }), null)
  assert.equal(sessionDot({ running: false, ended: 2, seen: 1, viewing: true }), null)
  assert.equal(sessionDot({ running: false, ended: 0, seen: null, viewing: false }), null)
  assert.equal(isUnread(1, undefined), true)
})

test('two ends in one millisecond, the first one seen: the second is still unread (a count, not a time)', () => {
  let seen = seenAfterSummary(NOT_READY, { s: act({ ended: 0 }) })
  // the first end is seen as it happens (the person reads the session)
  seen = seenAfterLook(seen, 's', 1)
  assert.equal(isUnread(1, seen.marks.s), false)
  // the second end, the same millisecond as the first: one more end, unread
  assert.equal(isUnread(2, seen.marks.s), true)
})

test('a later end (a failure) never hides an earlier unseen one; looking again sees both', () => {
  let seen = seenAfterSummary(NOT_READY, { s: act({ ended: 1 }) })
  assert.equal(isUnread(2, seen.marks.s), true)   // a run ended well, unseen
  assert.equal(isUnread(3, seen.marks.s), true)   // then one failed: still unread
  seen = seenAfterLook(seen, 's', 3)
  assert.equal(isUnread(3, seen.marks.s), false)
  // a mark only moves forward: an older answer read late never takes it back
  assert.equal(seenAfterLook(seen, 's', 2), seen)
})

test('what was seen: the first summary lays history as seen (no old end turns green); a later session starts unseen; marks persist', () => {
  const storage = memory()
  assert.equal(readSeen(storage), NOT_READY)
  const sessions = { s1: act({ ended: 4 }), s2: act(), s3: act({ live: [live()], ended: 1 }) }
  let seen = seenAfterSummary(NOT_READY, sessions)
  assert.equal(seen.ready, true)
  for (const [id, a] of Object.entries(sessions)) assert.equal(sessionDot({ running: false, ended: a.ended, seen: seen.marks[id], viewing: false }), null, id)
  // s3 was running at the first summary and ended after: green; s2 had nothing and ends: green
  assert.equal(isUnread(2, seen.marks.s3), true)
  assert.equal(isUnread(1, seen.marks.s2), true)
  // a session made after (a director's, in the background) starts unseen
  assert.equal(isUnread(1, seen.marks.s4), true)
  seen = seenAfterLook(seen, 's3', 2)
  assert.equal(isUnread(2, seen.marks.s3), false)
  // the marks outlive the page: written and read back (a restart of the app)
  writeSeen(storage, seen)
  const back = readSeen(storage)
  assert.deepEqual(back, seen)
  assert.ok(storage.m.has(SEEN_KEY))
  // a session no longer listed loses its mark; nothing to change gives the same object
  const pruned = seenAfterSummary(back, { s3: act({ ended: 2 }) })
  assert.deepEqual(Object.keys(pruned.marks), ['s3'])
  assert.equal(seenAfterSummary(pruned, { s3: act({ ended: 2 }) }), pruned)
  // a broken storage, or the v1 store of times, reads as never laid (the next summary lays history again, never all green)
  storage.setItem(SEEN_KEY, '{oops')
  assert.equal(readSeen(storage), NOT_READY)
  const v1 = memory()
  v1.setItem('oasis-code.railSeen.v1', JSON.stringify({ marks: { s1: '2026-10-18T10:00:00.000Z' } }))
  assert.equal(readSeen(v1), NOT_READY)
})
