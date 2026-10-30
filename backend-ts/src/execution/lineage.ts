/** A process's lineage as the kernel keeps it (macOS): every process has a unique id that is never reused, and the
 *  unique id of the process that created it — kept when the parent dies and the child is handed to launchd, kept
 *  across setsid and exec, and out of the process's own reach (unlike its environment or its process group). A
 *  command's descendants are the processes whose creator is the command's process or one of its known
 *  descendants, however they detached. Read through libproc (proc_listallpids, proc_pidinfo); elsewhere, or when
 *  the library cannot be loaded, there is no lineage and the callers fall back to what they have.
 *
 *  A creator the harness never saw (an intermediate that made a child and exited before it was known) breaks the
 *  chain: its child is then nobody's, and is not taken for anyone's — no guess by time or folder stands in for a
 *  parent the kernel reported. The fork watcher narrows that window to the time it takes to read a process's
 *  children after the kernel says it forked. */

import { dlopen, FFIType, ptr } from 'bun:ffi'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const PROC_PIDUNIQIDENTIFIERINFO = 17
/** struct proc_uniqidentifierinfo: p_uuid[16], p_uniqueid, p_puniqueid, … */
const UNIQ_INFO_SIZE = 56
const PROC_PIDTBSDINFO = 3
/** struct proc_bsdinfo: pbi_flags, pbi_status (SZOMB = 5), … */
const BSD_INFO_SIZE = 136
const SZOMB = 5

export interface ProcessIdentity { pid: number; uniqueid: bigint; creator: bigint }

type Libproc = { listAll: (buffer: Int32Array) => number; info: (pid: number, buffer: Uint8Array) => number; bsd: (pid: number, buffer: Uint8Array) => number }

let libproc: Libproc | null | undefined

function load(): Libproc | null {
  if (libproc !== undefined) return libproc
  libproc = null
  if (process.platform !== 'darwin') return null
  try {
    const lib = dlopen('/usr/lib/libproc.dylib', {
      proc_listallpids: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
      proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    })
    libproc = {
      listAll: (buffer) => lib.symbols.proc_listallpids(ptr(buffer), buffer.byteLength),
      info: (pid, buffer) => lib.symbols.proc_pidinfo(pid, PROC_PIDUNIQIDENTIFIERINFO, 0n, ptr(buffer), buffer.byteLength),
      bsd: (pid, buffer) => lib.symbols.proc_pidinfo(pid, PROC_PIDTBSDINFO, 0n, ptr(buffer), buffer.byteLength),
    }
  } catch {
    libproc = null
  }
  return libproc
}

/** Whether this host keeps a lineage the harness can read. */
export function lineageAvailable(): boolean {
  return load() !== null
}

/** One process's identity, or null (gone, or not readable by this user). */
export function identityOf(pid: number): ProcessIdentity | null {
  const lib = load()
  if (lib === null || !(pid > 0)) return null
  const buffer = new Uint8Array(UNIQ_INFO_SIZE)
  if (lib.info(pid, buffer) < UNIQ_INFO_SIZE) return null
  const view = new DataView(buffer.buffer)
  return { pid, uniqueid: view.getBigUint64(16, true), creator: view.getBigUint64(24, true) }
}

/** Whether a process has exited and waits to be reaped (nothing of it runs any more). */
export function isZombie(pid: number): boolean {
  const lib = load()
  if (lib === null) return false
  const buffer = new Uint8Array(BSD_INFO_SIZE)
  if (lib.bsd(pid, buffer) < BSD_INFO_SIZE) return false
  return new DataView(buffer.buffer).getUint32(4, true) === SZOMB
}

const CTL_KERN = 1
const KERN_ARGMAX = 8
const KERN_PROCARGS2 = 49

type ProcArgs = { read: (pid: number, buffer: Uint8Array) => number | null; argmax: number }

let procargs: ProcArgs | null | undefined

function loadProcArgs(): ProcArgs | null {
  if (procargs !== undefined) return procargs
  procargs = null
  if (process.platform !== 'darwin') return null
  try {
    const lib = dlopen('/usr/lib/libSystem.B.dylib', {
      sysctl: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
    })
    const argmax = new Int32Array(1)
    const argmaxSize = new BigUint64Array([4n])
    if (lib.symbols.sysctl(ptr(new Int32Array([CTL_KERN, KERN_ARGMAX])), 2, ptr(argmax), ptr(argmaxSize), null, 0n) !== 0 || !(argmax[0]! > 0)) return null
    procargs = {
      argmax: argmax[0]!,
      read: (pid, buffer) => {
        const size = new BigUint64Array([BigInt(buffer.byteLength)])
        const rc = lib.symbols.sysctl(ptr(new Int32Array([CTL_KERN, KERN_PROCARGS2, pid])), 3, ptr(buffer), ptr(size), null, 0n)
        return rc === 0 ? Number(size[0]) : null
      },
    }
  } catch {
    procargs = null
  }
  return procargs
}

/** A process's environment as the kernel keeps it (macOS: KERN_PROCARGS2, the block `ps -E` prints after the
 *  arguments), apart from its arguments — so a variable is matched as a variable, never as text some argument
 *  happens to carry. Null when it cannot be read (gone, another user's); empty for a process whose environment the
 *  kernel withholds (a platform binary's, /bin/sh's among them). */
export function environmentOf(pid: number, buffer?: Uint8Array): string[] | null {
  const lib = loadProcArgs()
  if (lib === null || !(pid > 0)) return null
  const bytes = buffer ?? new Uint8Array(lib.argmax)
  const size = lib.read(pid, bytes)
  if (size === null || size < 4) return null
  // argc, the executable's path, padding, argc arguments, then the environment up to an empty string
  const argc = new DataView(bytes.buffer, bytes.byteOffset, size).getInt32(0, true)
  let i = 4
  while (i < size && bytes[i] !== 0) i += 1
  while (i < size && bytes[i] === 0) i += 1
  const env: string[] = []
  for (let n = 0; i < size; n += 1) {
    let end = i
    while (end < size && bytes[end] !== 0) end += 1
    if (n >= argc) {
      if (end === i) break
      env.push(Buffer.from(bytes.subarray(i, end)).toString('latin1'))
    }
    i = end + 1
  }
  return env
}

/** A buffer environmentOf can read any process's block into (one per sweep, not one per process). */
export function environmentBuffer(): Uint8Array | null {
  const lib = loadProcArgs()
  return lib === null ? null : new Uint8Array(lib.argmax)
}

/** Every process this user can read, with its identity (empty when there is no lineage). */
export function identities(): ProcessIdentity[] {
  const lib = load()
  if (lib === null) return []
  let size = 4096
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const buffer = new Int32Array(size)
    const count = lib.listAll(buffer)
    if (count <= 0) return []
    if (count < size) {
      const out: ProcessIdentity[] = []
      for (const pid of buffer.subarray(0, count)) {
        const identity = identityOf(pid)
        if (identity !== null) out.push(identity)
      }
      return out
    }
    size *= 2
  }
  return []
}

/** The processes newly found to descend from the known unique ids (`known` grows with every one found), from one
 *  reading of the table: a process whose creator is known is known, to a fixed point. The ones known before are
 *  not returned; a caller that wants every live one filters the table by `known`. */
export function descendantsOf(known: Set<bigint>, table: ProcessIdentity[] = identities()): ProcessIdentity[] {
  const found: ProcessIdentity[] = []
  for (let grew = true; grew;) {
    grew = false
    for (const p of table) {
      if (!known.has(p.uniqueid) && known.has(p.creator)) { known.add(p.uniqueid); found.push(p); grew = true }
    }
  }
  return found
}

/** Where the watcher's thread is: beside this module in the source, or where the compiled build put its entry — the
 *  build roots its entries at their common folder (src/), so the worker is `execution/fork_watch_worker.js` in the
 *  binary's embedded root, whatever this module's own (bundled) location is. The first that exists; null: none. */
export function workerEntry(): string | null {
  const here = import.meta.url
  const candidates: string[] = []
  if (here.startsWith('file:')) {
    candidates.push(fileURLToPath(new URL('./fork_watch_worker.ts', here)))
    candidates.push(fileURLToPath(new URL('./fork_watch_worker.js', here)))
  }
  const root = here.includes('$bunfs') ? here.replace(/^file:\/\//, '').replace(/\/\$bunfs\/root\/.*$/, '/$bunfs/root') : null
  for (const base of [root, '/$bunfs/root', 'B:/~BUN/root'].filter((b): b is string => b !== null)) {
    candidates.push(`${base}/execution/fork_watch_worker.js`, `${base}/fork_watch_worker.js`)
  }
  return candidates.find((c) => { try { return existsSync(c) } catch { return false } }) ?? null
}

/** The fork watcher (macOS): one thread for every running command (fork_watch_worker.ts). The kernel tells it
 *  (kqueue NOTE_FORK) when a watched process makes a child; it reads that process's children at once and adds
 *  each, with its unique id, to the command's lineage, and watches them in turn — so an intermediate that lives a
 *  few milliseconds is seen with its parent before it goes, and its children with it. What it cannot see: a
 *  process that makes a child and exits before the watcher has read its parent's children. The thread says when it
 *  runs (`ready`) and when it could not start (`failed`: a build without its file, say) — then commands are tracked
 *  by the lineage tick alone, and their executions say so. Closing it closes its kqueue before the thread ends. */
export class ForkWatcher {
  private worker: Worker | null = null
  /** told of every change of state (starting, ready, failed, off) */
  onState: ((state: ForkWatcher['state']) => void) | null = null
  private readonly found = new Map<string, (uniqueid: bigint) => void>()
  private closed: Promise<void> | null = null
  private resolveClosed: (() => void) | null = null
  /** starting, ready (the thread runs), failed (it did not start), off (no lineage here) */
  state: 'off' | 'starting' | 'ready' | 'failed' = 'off'

  watch(key: string, pid: number, found: (uniqueid: bigint) => void): void {
    // a thread that could not start does not start later (its file is not in this build): the tick alone, said once
    if (load() === null || this.state === 'failed') return
    if (this.worker === null) {
      const entry = workerEntry()
      if (entry === null) { this.fail(new Error('the watcher\'s thread is not in this build')); return }
      try {
        this.worker = new Worker(entry)
      } catch (error) {
        this.fail(error)
        return
      }
      this.setState('starting')
      this.worker.unref()
      this.worker.onerror = (event) => { this.fail((event as ErrorEvent).message ?? event) }
      this.worker.onmessage = (message: MessageEvent) => {
        const data = message.data as { type: string; key?: string; uniqueid?: string }
        if (data.type === 'ready') this.setState('ready')
        else if (data.type === 'closed') this.resolveClosed?.()
        else if (data.type === 'found' && data.key && data.uniqueid) this.found.get(data.key)?.(BigInt(data.uniqueid))
      }
    }
    this.found.set(key, found)
    this.worker.postMessage({ type: 'watch', key, pid })
  }

  private fail(error: unknown): void {
    if (this.state !== 'failed') console.warn(`the fork watcher did not start (${String(error)}); commands are tracked by the lineage tick alone`)
    this.failure = String(error)
    this.setState('failed')
    try { this.worker?.terminate() } catch { /* gone */ }
    this.worker = null
  }

  unwatch(key: string): void {
    this.found.delete(key)
    this.worker?.postMessage({ type: 'unwatch', key })
  }

  /** The thread closes its kqueue and says so, then ends; one that does not answer within a second is ended as it is. */
  async close(): Promise<void> {
    const worker = this.worker
    this.found.clear()
    if (worker === null) return
    if (this.closed === null) {
      this.closed = new Promise<void>((resolve) => { this.resolveClosed = resolve })
      worker.postMessage({ type: 'close' })
    }
    await Promise.race([this.closed, new Promise((resolve) => setTimeout(resolve, 1000))])
    worker.terminate()
    this.worker = null
    this.closed = null
    this.resolveClosed = null
    this.setState('off')
  }

  /** why it did not start, when it did not */
  failure: string | null = null

  private setState(state: ForkWatcher['state']): void {
    if (this.state === state) return
    this.state = state
    this.onState?.(state)
  }
}
