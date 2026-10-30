/** A worker of read_paths_bench.ts: while the main thread is held by one synchronous call (connect() upgrading a
 *  copy: the VACUUM INTO backup, then the step), it samples the apparent bytes of the files it is given and the free
 *  bytes of their file system, and keeps the peak sum and the least free. Numbers only; it opens no file.
 *
 *  Shared memory: Int32 [0] stop flag (the main thread sets 1); Float64 at byte 8: [0] peak apparent sum,
 *  [1] least free bytes, [2] samples taken, [3] the sum at the last sample. */

import { lstatSync, statfsSync } from 'node:fs'

declare const self: Worker

interface Start { paths: string[]; dir: string; shared: SharedArrayBuffer; intervalMs: number }

self.onmessage = (event: MessageEvent<Start>) => {
  const { paths, dir, shared, intervalMs } = event.data
  const stop = new Int32Array(shared, 0, 1)
  const out = new Float64Array(shared, 8, 4)
  out[0] = 0
  out[1] = Number.POSITIVE_INFINITY
  out[2] = 0
  const sample = () => {
    let sum = 0
    for (const p of paths) { try { sum += lstatSync(p).size } catch { /* not there (yet, or any more) */ } }
    const fs = statfsSync(dir)
    const free = Number(fs.bavail) * Number(fs.bsize)
    out[0] = Math.max(out[0]!, sum)
    out[1] = Math.min(out[1]!, free)
    out[2] = out[2]! + 1
    out[3] = sum
  }
  sample()
  self.postMessage('ready')
  while (Atomics.load(stop, 0) === 0) {
    Atomics.wait(stop, 0, 0, intervalMs)
    sample()
  }
  self.postMessage('done')
}
