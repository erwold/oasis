/** One harness per data directory. The runs, the workspace locks and the processes a data directory records belong to
 *  the process that is running them; a second harness started on the same data would take them for a dead one's and
 *  "recover" them — marking a live run lost, writing an end it never had, removing its workspace lock. So the data
 *  directory is claimed before anything in it is read.
 *
 *  The claim is the kernel's: an exclusive flock on `instance.lock`, taken without waiting and held on an open file
 *  for the process's life. The kernel refuses it to anyone else while it is held and drops it when the process ends
 *  however it ends, so a dead holder's claim is simply free — there is nothing to judge stale, nothing to remove,
 *  and no moment between a check and a take (the lock file itself is never deleted: a new file under the same name
 *  would be a second lock). The file also carries who holds it (pid, since), for the refusal to name; that text is
 *  a label, never the lock. Commands the harness starts do not inherit the descriptor. A process that claims the
 *  same directory again (a state reopened in it) shares its own claim. */

import { dlopen, FFIType } from 'bun:ffi'
import { closeSync, ftruncateSync, openSync, readFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'

export class DataInUse extends Error {
  constructor(message: string) { super(message); this.name = 'DataInUse' }
}

const LOCK_EX = 2
const LOCK_NB = 4
const LOCK_UN = 8

let flock: ((fd: number, op: number) => number) | null | undefined

function loadFlock(): ((fd: number, op: number) => number) | null {
  if (flock !== undefined) return flock
  flock = null
  const path = process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : process.platform === 'linux' ? 'libc.so.6' : null
  if (path === null) return null
  try {
    const libc = dlopen(path, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } })
    flock = (fd, op) => libc.symbols.flock(fd, op)
  } catch {
    flock = null
  }
  return flock
}

/** This process's claims, by lock path: the descriptor that holds the lock and how many holders share it. */
const held = new Map<string, { fd: number; holders: number }>()

/** The claim on `dataDir` for this process; returns its release. Throws DataInUse while another process holds it. */
export function claimDataDir(dataDir: string): () => void {
  const path = join(dataDir, 'instance.lock')
  const lock = loadFlock()
  if (lock === null) throw new DataInUse(`the data directory ${dataDir} cannot be claimed on this platform (no flock)`)
  const release = () => {
    const mine = held.get(path)
    if (mine === undefined) return
    mine.holders -= 1
    if (mine.holders > 0) return
    held.delete(path)
    lock(mine.fd, LOCK_UN)
    try { closeSync(mine.fd) } catch { /* closed */ }
  }
  const own = held.get(path)
  if (own !== undefined) {
    own.holders += 1
    let released = false
    return () => { if (!released) { released = true; release() } }
  }
  const fd = openSync(path, 'a+', 0o600)
  if (lock(fd, LOCK_EX | LOCK_NB) !== 0) {
    let who = ''
    try { who = readFileSync(path, 'utf8').trim() } catch { who = '' }
    try { closeSync(fd) } catch { /* closed */ }
    const label = (() => { try { const c = JSON.parse(who) as { pid?: number; since?: string }; return ` (pid ${c.pid}, since ${c.since})` } catch { return '' } })()
    throw new DataInUse(`the data directory ${dataDir} is in use by another oasis-code${label}; stop it first, or use another data directory`)
  }
  // held: the label says whose (written after the lock, under it); a claim that cannot be completed is given back —
  // the lock and the descriptor — before the error goes up, so nothing holds the directory that nobody can release
  try {
    ftruncateSync(fd, 0)
    writeSync(fd, JSON.stringify({ pid: process.pid, since: new Date().toISOString() }), 0)
    held.set(path, { fd, holders: 1 })
  } catch (error) {
    lock(fd, LOCK_UN)
    try { closeSync(fd) } catch { /* closed */ }
    throw error
  }
  let released = false
  return () => { if (!released) { released = true; release() } }
}
