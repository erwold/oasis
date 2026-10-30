/** How big a folder is before the harness copies it. A snapshot import walks the folder into a base repository;
 *  a 300 GB Downloads once went that way by accident. The measure walks the same tree (the excluded directories
 *  left out, symlinks not followed) and stops at the first limit crossed, so what it reports is a lower bound and
 *  the walk of a huge tree ends in a moment. Ignore rules are not applied: the limit is about the folder the person
 *  pointed at, and the way out is to attach it read-only or to pick a subfolder. */

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export interface SnapshotLimits { max_bytes: number; max_files: number }
export interface FolderMeasure { bytes: number; files: number; stopped_early: boolean; seconds: number }

/** Directories the snapshot leaves out anyway (SNAPSHOT_EXCLUDES' directory entries plus git's own). */
export const MEASURE_SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache'])

export function measureFolder(root: string, limits: SnapshotLimits): FolderMeasure {
  const started = performance.now()
  let bytes = 0
  let files = 0
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()!
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (!MEASURE_SKIP_DIRS.has(entry.name)) stack.push(join(dir, entry.name))
        continue
      }
      if (!entry.isFile()) continue
      files += 1
      try { bytes += statSync(join(dir, entry.name)).size } catch { /* gone meanwhile */ }
      if (bytes > limits.max_bytes || files > limits.max_files) {
        return { bytes, files, stopped_early: true, seconds: (performance.now() - started) / 1000 }
      }
    }
  }
  return { bytes, files, stopped_early: false, seconds: (performance.now() - started) / 1000 }
}

export function overLimits(measure: FolderMeasure, limits: SnapshotLimits): boolean {
  return measure.bytes > limits.max_bytes || measure.files > limits.max_files
}

export function humanBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(bytes >= 10 * 1024 ** 3 ? 0 : 1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(bytes >= 10 * 1024 ** 2 ? 0 : 1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} kB`
  return `${bytes} B`
}

/** The import refused: the folder is over a snapshot limit. The message says what was measured and the ways out. */
export class SnapshotTooLarge extends Error {
  constructor(readonly source: string, readonly measured: FolderMeasure, readonly limits: SnapshotLimits) {
    super(`${source} is ${measured.stopped_early ? 'at least ' : ''}${humanBytes(measured.bytes)} in ${measured.files.toLocaleString('en-US')} files`
      + ` (the snapshot limit is ${humanBytes(limits.max_bytes)} / ${limits.max_files.toLocaleString('en-US')} files, measured without ignore rules):`
      + ' attach the folder read-only (mode "attached") or pick a subfolder')
    this.name = 'SnapshotTooLarge'
  }

  asBody(): Record<string, unknown> {
    return { detail: this.message, refusal: 'snapshot_too_large', source_path: this.source, measured: { ...this.measured }, limits: { ...this.limits }, options: ['attached', 'subfolder'] }
  }
}
