/** The folder's lock and a conversation's background commands (workspace/locks.ts): a run of the same conversation
 *  cohort is let in beside the commands an earlier run of it left running — at once, even past writers already in line
 *  — as the one foreground writer; the commands keep their own provenance and hold the folder until each ends; nothing
 *  else (another cohort, an approval's or an unknown command, a failed handoff) is let in; once the commands are gone
 *  and the foreground run has let go, the line goes on first come, first served. */

import { expect, test } from 'bun:test'
import { describeHolder, WorkspaceLocks, type CohortJoin } from '../src/workspace/locks.ts'
import { tempDir } from './helpers.ts'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const WS = 'ws_cohort'
const A = 'cohort-a'
const B = 'cohort-b'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

/** R1 (cohort A) held the folder, left command x1 running (joinable unless told), and let go: x1 alone holds it. */
function background(opts: { joinable?: boolean; kind?: 'run' | 'approval' } = {}) {
  const locks = new WorkspaceLocks(tempDir('oasis-cohort-locks-'))
  const x1 = deferred()
  const owner = opts.kind === 'approval' ? 'approval:p1' : 'run_r1'
  expect(locks.tryAcquire(WS, owner, opts.kind === 'approval' ? { kind: 'approval' } : { kind: 'run', run_id: 'run_r1', cohort: A })).toBe(true)
  expect(locks.holdUntil(WS, owner, 'x1', x1.promise, { run_id: 'run_r1', joinable: opts.joinable ?? true })).toBe(true)
  locks.release(WS, owner)
  expect(locks.state(WS).holder).toMatchObject({ owner, background: true, execution_ids: ['x1'] })
  return { locks, x1 }
}

test('a run of the same cohort is let in at once beside the commands, as the one foreground writer; their provenance stays', async () => {
  const { locks, x1 } = background()
  const joins: CohortJoin[] = []
  await locks.acquire(WS, 'run_r2', { kind: 'run', run_id: 'run_r2', cohort: A, onJoined: (j) => joins.push(j) })
  expect(joins).toEqual([{ inherited_execution_ids: ['x1'], inherited_from_run_ids: ['run_r1'] }])
  const holder = locks.state(WS).holder!
  expect(holder).toMatchObject({ owner: 'run_r2', kind: 'run', background: false, cohort: A, execution_ids: ['x1'], background_execution_ids: ['x1'], origin_run_ids: ['run_r1'] })
  expect(describeHolder(holder)).toContain('beside command x1')
  // R2's own command beside the inherited one; R2 lets go: both hold the folder, each named for its own run
  const x2 = deferred()
  expect(locks.holdUntil(WS, 'run_r2', 'x2', x2.promise, { run_id: 'run_r2', joinable: true })).toBe(true)
  locks.release(WS, 'run_r2')
  const after = locks.state(WS).holder!
  expect(after).toMatchObject({ background: true, execution_ids: ['x1', 'x2'], origin_run_ids: ['run_r1', 'run_r2'] })
  expect(describeHolder(after)).toContain('runs run_r1, run_r2 of one conversation')
  // the old command's own callback still removes its pin (the holder record was kept)
  x1.resolve(); await sleep(5)
  expect(locks.state(WS).holder).toMatchObject({ execution_ids: ['x2'], origin_run_ids: ['run_r2'] })
  expect(describeHolder(locks.state(WS).holder!)).toContain('started by run run_r2')
  x2.resolve(); await sleep(5)
  expect(locks.holder(WS)).toBeNull()
})

test('an outsider already in line does not keep the conversation\'s next run out; FIFO goes on once the commands and the run are gone', async () => {
  const { locks, x1 } = background()
  const order: string[] = []
  const outsider = locks.acquire(WS, 'run_other', { kind: 'run', run_id: 'run_other', cohort: B }).then(() => order.push('other'))
  await sleep(5)
  expect(locks.state(WS).waiters.map((w) => w.owner)).toEqual(['run_other'])
  await locks.acquire(WS, 'run_r2', { kind: 'run', run_id: 'run_r2', cohort: A })
  order.push('r2')
  expect(locks.holder(WS)).toBe('run_r2')
  // the outsider still waits — for R2 and for the command
  x1.resolve(); await sleep(5)
  expect(locks.holder(WS)).toBe('run_r2')
  expect(order).toEqual(['r2'])
  locks.release(WS, 'run_r2')
  await outsider
  expect(order).toEqual(['r2', 'other'])
  expect(locks.holder(WS)).toBe('run_other')
})

test('a run of the cohort queued while the earlier run was still ending is let in when that run lets go to its commands — one foreground only', async () => {
  const locks = new WorkspaceLocks(tempDir('oasis-cohort-locks-'))
  const x1 = deferred()
  expect(locks.tryAcquire(WS, 'run_r1', { kind: 'run', run_id: 'run_r1', cohort: A })).toBe(true)
  const outsider = locks.acquire(WS, 'run_other', { kind: 'run', run_id: 'run_other', cohort: B })
  const seen: { joined: CohortJoin | null } = { joined: null }
  const r2 = locks.acquire(WS, 'run_r2', { kind: 'run', run_id: 'run_r2', cohort: A, onJoined: (j) => { seen.joined = j } })
  await sleep(5)
  // R1 is still the foreground (its end being written): R2 waits behind the outsider, never a second foreground
  expect(locks.state(WS).waiters.map((w) => w.owner)).toEqual(['run_other', 'run_r2'])
  locks.holdUntil(WS, 'run_r1', 'x1', x1.promise, { run_id: 'run_r1', joinable: true })
  locks.release(WS, 'run_r1')
  await r2
  expect(seen.joined).toEqual({ inherited_execution_ids: ['x1'], inherited_from_run_ids: ['run_r1'] })
  expect(locks.holder(WS)).toBe('run_r2')
  expect(locks.state(WS).waiters.map((w) => w.owner)).toEqual(['run_other'])
  // a third run of the cohort while R2 is the foreground: waits (re-entrance is the holder's own only)
  const r3 = locks.acquire(WS, 'run_r3', { kind: 'run', run_id: 'run_r3', cohort: A })
  await sleep(5)
  expect(locks.state(WS).waiters.map((w) => w.owner)).toEqual(['run_other', 'run_r3'])
  locks.release(WS, 'run_r2')
  await r3                                              // the commands still hold the folder: R3 goes in beside them
  expect(locks.holder(WS)).toBe('run_r3')
  locks.release(WS, 'run_r3'); x1.resolve()
  await outsider
  expect(locks.holder(WS)).toBe('run_other')
})

test('nothing else is let in beside the commands: another cohort, no cohort, a non-run writer, an approval\'s or an unknown command', async () => {
  for (const [label, setup, meta] of [
    ['another cohort', {}, { kind: 'run' as const, cohort: B }],
    ['no cohort', {}, { kind: 'run' as const, cohort: null }],
    ['an operation', {}, { kind: 'operation' as const, cohort: A }],
    ['an unknown command', { joinable: false }, { kind: 'run' as const, cohort: A }],
    ['an approval\'s command', { kind: 'approval' as const }, { kind: 'run' as const, cohort: A }],
  ] as const) {
    const { locks, x1 } = background(setup)
    let granted = false
    const p = locks.acquire(WS, 'run_x', { ...meta, run_id: 'run_x' }).then(() => { granted = true })
    await sleep(5)
    expect(granted, label).toBe(false)
    expect(locks.tryAcquire(WS, 'op', { kind: 'operation', operation: 'checkpoint' }), label).toBe(false)
    x1.resolve()
    await p
    expect(locks.holder(WS), label).toBe('run_x')
  }
})

test('a handoff whose record cannot be kept lets nobody in unmarked: the holder is untouched and the run waits as any writer', async () => {
  const { locks, x1 } = background()
  let granted = false
  const p = locks.acquire(WS, 'run_r2', { kind: 'run', run_id: 'run_r2', cohort: A, onJoined: () => { throw new Error('disk full') } }).then(() => { granted = true })
  await sleep(5)
  expect(granted).toBe(false)
  expect(locks.state(WS).holder).toMatchObject({ owner: 'run_r1', background: true, execution_ids: ['x1'] })
  expect(locks.state(WS).waiters.map((w) => w.owner)).toEqual(['run_r2'])
  x1.resolve()
  await p                                              // in line, it gets the folder when the command ends
  expect(locks.holder(WS)).toBe('run_r2')
  expect(locks.state(WS).holder?.background_execution_ids).toEqual([])
})

test('a queued cohort run whose handoff fails at the release stays in line, and the next eligible one is not skipped over silently', async () => {
  const locks = new WorkspaceLocks(tempDir('oasis-cohort-locks-'))
  const x1 = deferred()
  locks.tryAcquire(WS, 'run_r1', { kind: 'run', run_id: 'run_r1', cohort: A })
  const failing = locks.acquire(WS, 'run_r2', { kind: 'run', run_id: 'run_r2', cohort: A, onJoined: () => { throw new Error('no record') } })
  await sleep(5)
  locks.holdUntil(WS, 'run_r1', 'x1', x1.promise, { run_id: 'run_r1', joinable: true })
  locks.release(WS, 'run_r1')
  await sleep(5)
  expect(locks.state(WS).holder).toMatchObject({ owner: 'run_r1', background: true })
  expect(locks.state(WS).waiters.map((w) => w.owner)).toEqual(['run_r2'])
  x1.resolve()
  await failing
  expect(locks.holder(WS)).toBe('run_r2')
})

test('a stop of the joined run never takes the inherited pins with it; a stopped waiter is never handed the folder', async () => {
  const { locks, x1 } = background()
  const ac = new AbortController()
  // an outsider in line, then stopped
  const outsider = locks.acquire(WS, 'run_other', { kind: 'run', cohort: B, signal: ac.signal }).catch((e) => e)
  await locks.acquire(WS, 'run_r2', { kind: 'run', run_id: 'run_r2', cohort: A })
  ac.abort()
  expect(String(await outsider)).toContain('stopped')
  // R2 ends (stopped): only its own let-go; the command still holds the folder
  locks.release(WS, 'run_r2')
  expect(locks.state(WS).holder).toMatchObject({ background: true, execution_ids: ['x1'] })
  x1.resolve(); await sleep(5)
  expect(locks.holder(WS)).toBeNull()
})
