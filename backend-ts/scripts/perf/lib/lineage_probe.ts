/** Perf harness preload (bun --preload): counts the whole-table readings of the kernel's process table made through
 *  execution/lineage.ts `identities()` (proc_listallpids, then one proc_pidinfo per pid) — their number, their time
 *  and the rows they returned — without a change to any production file, so the same counter reads the baseline and
 *  a changed process manager alike. The module's source is rewritten as Bun loads it: `identities` is renamed and
 *  exported again through one thin wrapper (two clock reads and three additions per table reading; nothing per pid).
 *  A source without the anchor refuses to load (never a silent zero), and the bench refuses to measure when the
 *  rewritten module was not the one loaded. Scope: this process's main thread. The fork watcher's worker thread is
 *  not wrapped, and does not read the whole table (it reads one process's children, proc_listchildpids). Audit
 *  tooling only; CPU measured with it loaded includes the wrapper. */

import { readFileSync } from 'node:fs'

export interface LineageProbe {
  /** the rewritten lineage.ts was loaded (its wrapper is the `identities` every importer got) */
  installed: boolean
  /** whole-table readings (identities()) */
  scans: number
  scan_ms: number
  /** identities returned by those readings */
  scan_rows: number
}

const probe: LineageProbe = { installed: false, scans: 0, scan_ms: 0, scan_rows: 0 }
;(globalThis as { __oasisLineageProbe?: LineageProbe }).__oasisLineageProbe = probe

const ANCHOR = 'export function identities(): ProcessIdentity[] {'

Bun.plugin({
  name: 'oasis-perf-lineage-probe',
  setup(build) {
    build.onLoad({ filter: /[\\/]src[\\/]execution[\\/]lineage\.ts$/ }, ({ path }) => {
      const source = readFileSync(path, 'utf8')
      if (source.split(ANCHOR).length !== 2) throw new Error(`lineage probe: the anchor of ${path} is not found exactly once; nothing is counted`)
      const contents = source.replace(ANCHOR, 'function identitiesUnprobed(): ProcessIdentity[] {') + `
const perfProbe = (globalThis as { __oasisLineageProbe?: { installed: boolean; scans: number; scan_ms: number; scan_rows: number } }).__oasisLineageProbe
if (perfProbe) perfProbe.installed = true
export function identities(): ProcessIdentity[] {
  if (!perfProbe) return identitiesUnprobed()
  const t = performance.now()
  const out = identitiesUnprobed()
  perfProbe.scan_ms += performance.now() - t
  perfProbe.scans += 1
  perfProbe.scan_rows += out.length
  return out
}
`
      return { contents, loader: 'ts' }
    })
  },
})
