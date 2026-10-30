import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Workspace } from '@oasis-code/contract'
import { lockKeyOf, WorkspaceLocks, LockWaitCancelled, type LockWaiting } from '../src/workspace/locks.ts'

type BindingWorkspace = Pick<Workspace, 'id' | 'kind' | 'path' | 'target' | 'remote'>
function workspace(id: string, target = id, root = 'remote-root-A', generation = 'generation-A'): BindingWorkspace {
  return { id, kind: 'direct', path: '/same/path', target: { kind: 'ssh', target_id: target },
    remote: { target_id: target, root_id: root, generation, path: '/same/path', state_path: '/tmp/private-state' } }
}
function lanes() {
  const roots = new Map(['a', 'b', 'c', 'd'].map(id => [id, workspace(id)]))
  const dir = mkdtempSync(join(tmpdir(), 'remote-lock-identity-'))
  const keyOf = (id: string) => lockKeyOf(roots.get(id)!, id)
  return { roots, dir, keyOf, locks: new WorkspaceLocks(dir, keyOf), close() { rmSync(dir, { recursive: true, force: true }) } }
}

test('remote aliases and persisted binding reload use one identity, not target/path/state spelling', () => {
  const a = workspace('workspace-a', 'alias-a'), b = workspace('workspace-b', 'alias-b')
  expect(lockKeyOf(a, a.id)).toBe(lockKeyOf(b, b.id))
  const reloaded = JSON.parse(JSON.stringify(a)) as BindingWorkspace
  reloaded.target = { kind: 'ssh', target_id: 'new-local-target-row' }; reloaded.remote!.target_id = 'new-local-target-row'
  expect(lockKeyOf(reloaded, reloaded.id)).toBe(lockKeyOf(a, a.id))
  // Hash uses only the trusted identity tuple; policy validates paths before reaching this boundary.
  const spelling = { ...b, path: '/OTHER', remote: { ...b.remote!, path: '/OTHER', state_path: '/another/private' } }
  expect(lockKeyOf(spelling, b.id)).toBe(lockKeyOf(a, a.id))
})
test('equal path does not merge distinct remote root or generation identities, or local direct folders', () => {
  const a = workspace('a', 'host-a'), otherHost = workspace('b', 'host-b', 'independently-issued-root-B', 'independently-issued-generation-B')
  expect(a.path).toBe(otherHost.path); expect(lockKeyOf(a, 'a')).not.toBe(lockKeyOf(otherHost, 'b'))
  expect(lockKeyOf(a, 'a')).not.toBe(lockKeyOf(workspace('b', 'host-b', 'remote-root-A', 'new-generation'), 'b'))
  const local = { ...a, target: { kind: 'local' as const }, remote: null }
  expect(lockKeyOf(local, 'a')).toBe(`folder-${createHash('sha256').update(local.path).digest('hex').slice(0, 16)}`)
  expect(lockKeyOf(a, 'a')).not.toBe(lockKeyOf(local, 'a'))
  expect(lockKeyOf({ ...local, id: 'another-local-workspace' }, 'different-id')).toBe(lockKeyOf(local, 'a'))
  expect(lockKeyOf(null, 'isolated-workspace')).toBe('isolated-workspace')
})
test('missing or mismatched remote identity is refused rather than creating a fallback lane', () => {
  const a = workspace('a')
  for (const remote of [null, { ...a.remote!, target_id: 'other' }, { ...a.remote!, root_id: '' }, { ...a.remote!, generation: '' }]) {
    expect(() => lockKeyOf({ ...a, remote }, 'a')).toThrow('remote workspace identity missing')
  }
})
test('aliases share unknown background pin, queued visibility, readers and FIFO without newcomer bypass', async () => {
  const f = lanes(), notices: LockWaiting[] = [], order: string[] = []
  let terminal!: () => void
  const unknown = new Promise<void>(resolve => { terminal = resolve })
  try {
    expect(f.locks.tryAcquire('a', 'run:first', { session_id: 's-first' })).toBe(true)
    f.locks.addReader('c', 'reader', { execution_id: 'read-x' })
    expect(f.locks.holdUntil('a', 'run:first', 'remote-unknown', unknown)).toBe(true)
    const b = f.locks.acquire('b', 'run:second', { onQueued: value => notices.push(value) }).then(() => { order.push('second') })
    const c = f.locks.acquire('c', 'run:third').then(() => { order.push('third') })
    expect(f.locks.state('b').readers.map(r => r.execution_id)).toEqual(['read-x'])
    expect(f.locks.state('c').waiters.map(w => w.position)).toEqual([1, 2])
    expect(notices[0].blocking_owner).toBe('run:first')
    f.locks.release('a', 'run:first')
    await Bun.sleep(15)
    expect(order).toEqual([]); expect(f.locks.state('b').holder?.background).toBe(true)
    expect(f.locks.state('b').holder?.execution_ids).toEqual(['remote-unknown'])
    expect(f.locks.tryAcquire('d', 'newcomer')).toBe(false)
    expect(f.locks.waitingOf('run:second')?.blocking_execution_ids).toEqual(['remote-unknown'])
    f.locks.removeReader('a', 'reader'); expect(f.locks.state('c').readers).toEqual([])
    terminal(); await b
    expect(order).toEqual(['second']); expect(f.locks.holder('a')).toBe('run:second')
    f.locks.release('b', 'run:second'); await c
    expect(order).toEqual(['second', 'third'])
    f.locks.release('c', 'run:third'); expect(f.locks.holder('a')).toBeNull()
  } finally { terminal(); f.close() }
})
test('cancelled alias leaves the shared queue; reentrant owner retains it until final release', async () => {
  const f = lanes(), abort = new AbortController()
  try {
    f.locks.tryAcquire('a', 'first'); expect(f.locks.tryAcquire('b', 'first')).toBe(true)
    const cancelled = f.locks.acquire('c', 'cancelled', { signal: abort.signal }).catch(e => e)
    let entered = false
    const next = f.locks.acquire('d', 'next').then(() => { entered = true })
    abort.abort(); expect(await cancelled).toBeInstanceOf(LockWaitCancelled)
    expect(f.locks.state('a').waiters.map(w => w.owner)).toEqual(['next'])
    f.locks.release('b', 'first'); await Promise.resolve(); expect(entered).toBe(false)
    f.locks.release('a', 'first'); await next; expect(entered).toBe(true)
    f.locks.release('d', 'next')
  } finally { f.close() }
})
test('rehydrated binding and explicitly restored unknown pin block all aliases in a new lock manager', async () => {
  const f = lanes()
  let terminal!: () => void
  try {
    const originalKey = f.keyOf('a')
    f.roots.set('a', JSON.parse(JSON.stringify(f.roots.get('a'))))
    const restored = new WorkspaceLocks(f.dir, f.keyOf)
    expect(f.keyOf('a')).toBe(originalKey)
    expect(restored.tryAcquire('a', 'restored-command', { execution_id: 'remote-job' })).toBe(true)
    restored.holdUntil('a', 'restored-command', 'remote-job', new Promise<void>(resolve => { terminal = resolve }))
    restored.release('a', 'restored-command')
    expect(restored.tryAcquire('b', 'other-alias')).toBe(false)
    expect(restored.state('c').holder?.execution_ids).toEqual(['remote-job'])
    terminal(); await Promise.resolve(); expect(restored.tryAcquire('b', 'other-alias')).toBe(true)
    restored.release('b', 'other-alias')
  } finally { terminal?.(); f.close() }
})
