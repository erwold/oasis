/** The fork watcher's thread (macOS): kqueue EVFILT_PROC on every process of a watched command — NOTE_FORK says a
 *  process just made a child, and its children are read at once (proc_listchildpids) and watched in turn, so a
 *  child that exits milliseconds later has been seen with its parent. Each process found is posted with its
 *  kernel identity and the command (key) it descends from; nothing here is inferred — every link is a parent the
 *  kernel reported while the child was alive. */

import { dlopen, FFIType, ptr } from 'bun:ffi'
import { identityOf } from './lineage.ts'

declare const self: Worker

const libc = dlopen('/usr/lib/libSystem.B.dylib', {
  kqueue: { args: [], returns: FFIType.i32 },
  close: { args: [FFIType.i32], returns: FFIType.i32 },
  kevent64: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
  proc_listchildpids: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
})

const EVENT_SIZE = 48 // struct kevent64_s
const EVFILT_PROC = -5
const EV_ADD = 0x1
const EV_CLEAR = 0x20
const NOTE_FORK = 0x40000000
const NOTE_EXIT = 0x80000000
const BATCH = 64

const kq = libc.symbols.kqueue()
/** every watched process, by pid, with the command it descends from */
const owner = new Map<number, string>()
const events = new Uint8Array(EVENT_SIZE * BATCH)
const noWait = new BigInt64Array([0n, 0n])
const wait = new BigInt64Array([0n, 5_000_000n])

function register(pid: number): void {
  const change = new Uint8Array(EVENT_SIZE)
  const view = new DataView(change.buffer)
  view.setBigUint64(0, BigInt(pid), true)
  view.setInt16(8, EVFILT_PROC, true)
  view.setUint16(10, EV_ADD | EV_CLEAR, true)
  view.setUint32(12, NOTE_FORK | NOTE_EXIT, true)
  // a process already gone is refused (ESRCH): nothing to watch
  libc.symbols.kevent64(kq, ptr(change), 1, ptr(events), 0, 0, ptr(noWait))
}

/** The children of `pid`, watched and posted, and theirs, depth first. */
function adopt(pid: number, key: string): void {
  const buffer = new Int32Array(256)
  const count = libc.symbols.proc_listchildpids(pid, ptr(buffer), buffer.byteLength)
  for (const child of buffer.subarray(0, Math.max(0, count))) {
    if (child <= 0 || owner.has(child)) continue
    const identity = identityOf(child)
    if (identity === null) continue
    owner.set(child, key)
    register(child)
    self.postMessage({ type: 'found', key, pid: child, uniqueid: identity.uniqueid.toString() })
    adopt(child, key)
  }
}

let closing = false

self.onmessage = (message: MessageEvent) => {
  const data = message.data as { type: 'watch' | 'unwatch' | 'close'; key?: string; pid?: number }
  if (data.type === 'close') {
    // the kqueue is this thread's: it is closed here, then the owner is told and ends the thread
    closing = true
    owner.clear()
    libc.symbols.close(kq)
    self.postMessage({ type: 'closed' })
    return
  }
  if (closing || !data.key) return
  if (data.type === 'watch' && data.pid) {
    owner.set(data.pid, data.key)
    register(data.pid)
    adopt(data.pid, data.key)
  } else if (data.type === 'unwatch') {
    for (const [pid, key] of owner) if (key === data.key) owner.delete(pid)
  }
}

async function loop(): Promise<void> {
  for (;;) {
    if (closing) return
    const n = libc.symbols.kevent64(kq, null, 0, ptr(events), BATCH, 0, ptr(wait))
    for (let i = 0; i < n; i += 1) {
      const view = new DataView(events.buffer, i * EVENT_SIZE)
      const pid = Number(view.getBigUint64(0, true))
      const fflags = view.getUint32(12, true)
      const key = owner.get(pid)
      if (key !== undefined && fflags & NOTE_FORK) adopt(pid, key)
      if (fflags & NOTE_EXIT) owner.delete(pid)
    }
    // the watch requests come in between two waits
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

// ready: the owner knows the watcher runs (a build that left this file out never says so)
self.postMessage({ type: 'ready', kq })
void loop()
