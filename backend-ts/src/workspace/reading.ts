/** Reading a workspace without a run: the listing and the numbered, paged read the agent's file tools answer with,
 *  as plain functions over a path policy — so the read-only API (and the director behind it) sees exactly what a
 *  run would see, under the same bounds and refusals. */

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_FILE_BYTES, PathPolicy, PathRefused, posixOf, SKIP_DIRS } from './paths.ts'

export const MAX_LIST = 500
export const MAX_READ_LINES = 2000

export function isBinary(data: Uint8Array): boolean {
  const sample = data.subarray(0, 8192)
  if (sample.includes(0)) return true
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample)
  } catch {
    // a multi-byte character cut at the sample's edge is not binary
    for (let cut = 1; cut <= 3 && cut < sample.length; cut += 1) {
      try { new TextDecoder('utf-8', { fatal: true }).decode(sample.subarray(0, sample.length - cut)); return false } catch { /* keep trying */ }
    }
    return true
  }
  return false
}

export function sha256Of(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

function refused(reason: string): { status: 'refused'; reason: string } {
  return { status: 'refused', reason }
}

export type Listing = { status: 'refused'; reason: string } | {
  status: 'ok'; path: string; entries: { path: string; bytes: number | null; attached?: true }[]; count: number; truncated: boolean; skipped_in_excluded_dirs: number
}

/** The files under `path` (tracked and untracked, ignore rules honoured by the caller's listing; build outputs,
 *  node_modules, .git and virtualenvs skipped), paged: `truncated` says there is more. */
export function listWorkspaceFiles(policy: PathPolicy, files: string[], root: string, path = '.', maxEntries = 300, offsetIn = 0): Listing {
  let pure: string[]
  let real: string
  try {
    ;[pure, real] = policy.resolveRead(path)
  } catch (error) {
    if (error instanceof PathRefused) return refused(error.message)
    throw error
  }
  let prefix = posixOf(pure)
  prefix = prefix === '' || prefix === '.' ? '' : prefix.replace(/\/+$/, '') + '/'
  const limit = Math.max(1, Math.min(Math.trunc(Number(maxEntries)) || 1, MAX_LIST))
  const offset = Math.max(0, Math.trunc(Number(offsetIn)) || 0)
  // the attached folder and the temporary folder are no repository: their files are walked as they stand, up to
  // the page and one more
  if (policy.isAttached(pure)) return listFolder(prefix, real, limit, 'attached folder', offset)
  if (policy.isTemp(pure)) return listFolder(prefix, real, limit, 'temporary folder', offset)
  if (policy.isRoot(pure)) return listFolder(prefix, real, limit, 'root', offset)
  let skipped = 0
  // the attached folder is no file of the workspace's (a link its snapshots leave out): the root's listing names it
  // first, or a reader who only lists would never find it
  const entries: { path: string; bytes: number | null; attached?: true }[] = !prefix && policy.attached ? [{ path: `${policy.attached.name}/`, bytes: null, attached: true }] : []
  for (const rel of files) {
    if (prefix && !rel.startsWith(prefix)) continue
    if (policy.isSkippedDir(rel.split('/'))) { skipped += 1; continue }
    let size: number | null
    try { size = statSync(join(root, rel)).size } catch { size = null }
    entries.push({ path: rel, bytes: size })
  }
  const truncated = entries.length > offset + limit
  return { status: 'ok', path: prefix || '.', entries: entries.slice(offset, offset + limit), count: entries.length, truncated, skipped_in_excluded_dirs: skipped }
}

/** A page of a folder under `real` (the folder itself or a directory inside it): a depth-first walk in name
 *  order, the excluded directories skipped, symlinks not followed, stopped one entry past the page. */
function listFolder(prefix: string, real: string, limit: number, what: string, offset = 0): Listing {
  let isDir = false
  try { isDir = statSync(real).isDirectory() } catch { isDir = false }
  if (!isDir) return refused(`'${prefix.replace(/\/$/, '')}' is not a directory of the ${what}`)
  const entries: { path: string; bytes: number | null }[] = []
  let skipped = 0
  let truncated = false
  const walk = (dir: string, rel: string): void => {
    let dirents
    try { dirents = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) } catch { return }
    for (const entry of dirents) {
      if (truncated) return
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) { skipped += 1; continue }
        walk(join(dir, entry.name), rel + entry.name + '/')
        continue
      }
      if (!entry.isFile()) continue
      if (entries.length >= offset + limit) { truncated = true; return }
      let size: number | null
      try { size = statSync(join(dir, entry.name)).size } catch { size = null }
      entries.push({ path: prefix + rel + entry.name, bytes: size })
    }
  }
  walk(real, '')
  return { status: 'ok', path: prefix || '.', entries: entries.slice(offset), count: entries.length, truncated, skipped_in_excluded_dirs: skipped }
}

export type FileRead = { status: 'refused'; reason: string } | {
  status: 'ok'; path: string; sha256: string; bytes: number; total_lines: number; from_line: number; to_line: number; truncated: boolean;
  next_offset_line: number | null; content: string
}

/** A text file with line numbers, `limitLines` at a time from `offsetLine` (1-based), with its sha256. Binary files
 *  and files over the read cap are refused. */
export function readWorkspaceFile(policy: PathPolicy, path: string, offsetLine = 1, limitLines = 400): FileRead {
  let pure: string[]
  let real: string
  try {
    ;[pure, real] = policy.resolveRead(path)
  } catch (error) {
    if (error instanceof PathRefused) return refused(error.message)
    throw error
  }
  let size: number
  try {
    const st = statSync(real)
    if (!st.isFile()) return refused(`'${posixOf(pure)}' is not a file`)
    size = st.size
  } catch {
    return refused(`'${posixOf(pure)}' is not a file`)
  }
  if (size > MAX_FILE_BYTES) return refused(`'${posixOf(pure)}' is ${size} bytes; the read cap is ${MAX_FILE_BYTES}`)
  const data = readFileSync(real)
  if (isBinary(data)) return refused(`'${posixOf(pure)}' is binary (${size} bytes); text tools only`)
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(data) } catch { return refused(`'${posixOf(pure)}' is not valid UTF-8; text tools only`) }
  const lines = text.split('\n')
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  const total = lines.length
  const start = Math.max(1, Math.trunc(Number(offsetLine)) || 1)
  const count = Math.max(1, Math.min(Math.trunc(Number(limitLines)) || 1, MAX_READ_LINES))
  const window = lines.slice(start - 1, start - 1 + count)
  const body = window.map((line, i) => `${start + i}\t${line}`).join('\n')
  const toLine = start + window.length - 1
  const truncated = toLine < total
  return {
    status: 'ok', path: posixOf(pure), sha256: sha256Of(data), bytes: size, total_lines: total, from_line: start, to_line: toLine, truncated,
    next_offset_line: truncated ? toLine + 1 : null, content: body,
  }
}
