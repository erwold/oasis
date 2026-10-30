/** The project's own instruction files, read into a run's context with their source and the folder they apply to:
 *  the person's explicit project instructions (the project settings), then the instruction files at the working
 *  folder's root and at an attached folder's root — `.oasis-code/INSTRUCTIONS.md`, `AGENTS.md`, `CLAUDE.md` —
 *  and, when a run enters a subfolder that carries its own, that folder's, appended then. Every file is read through
 *  the same path checks a tool's read goes through (never above a root, never through a link out), cut at a byte
 *  limit that says so, and fingerprinted once for the prompt and the manifest alike. Nothing here widens a grant. */

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { PathPolicy, PathRefused, posixOf, SKIP_DIRS, type PurePath } from '../workspace/paths.ts'

export const MAX_INSTRUCTION_BYTES = 24_000
/** How many subfolder instruction files a run's first message carries; the rest are named and shown on entry. */
export const MAX_DISCOVERED_FILES = 24
/** How many bytes of subfolder instruction files a run's first message carries in all (as Codex caps its project
 *  docs at 32 KiB); the folders past it are named and shown on entry, or before a command. */
export const MAX_DISCOVERED_BYTES = 32_000
/** The files a folder's instructions come from, in priority order (the most specific to this harness first). */
export const INSTRUCTION_FILES = ['.oasis-code/INSTRUCTIONS.md', 'AGENTS.md', 'CLAUDE.md'] as const
export const SETTINGS_SOURCE = 'project settings'

export interface InstructionFile {
  /** where it comes from: the project settings, or a file path as the run names it */
  source: string
  /** the folder it applies to, as the run names it: the working folder, `name/` for an attached folder, `src/` for a subfolder */
  scope: string
  priority: string
  text: string
  /** the text was cut at MAX_INSTRUCTION_BYTES (the cut is said in the text itself) */
  truncated: boolean
}

/** UTF-8 bytes of the text up to the limit — never a character split in two — with the cut named. */
export function truncateBytes(textIn: string, limit = MAX_INSTRUCTION_BYTES): { text: string; truncated: boolean } {
  const bytes = Buffer.from(textIn, 'utf8')
  if (bytes.length <= limit) return { text: textIn, truncated: false }
  let cut = bytes.subarray(0, limit).toString('utf8')
  if (cut.endsWith('\uFFFD')) cut = cut.slice(0, -1)
  return { text: `${cut}\n[truncated at ${limit} bytes]`, truncated: true }
}

function readInstruction(real: string): string | null {
  try {
    if (!statSync(real).isFile()) return null
    return readFileSync(real, 'utf8')
  } catch {
    return null
  }
}

/** The instruction files of one folder (a root or a subfolder), read through the policy: [source, text] pairs. */
function folderFiles(policy: PathPolicy, folder: PurePath): { source: string; text: string }[] {
  const out: { source: string; text: string }[] = []
  for (const name of INSTRUCTION_FILES) {
    const parts = [...folder, ...name.split('/')]
    let real: string
    try { [, real] = policy.resolveRead(posixOf(parts)) } catch (error) { if (error instanceof PathRefused) continue; throw error }
    const text = readInstruction(real)
    if (text === null) continue
    out.push({ source: posixOf(parts), text })
  }
  return out
}

function scopeOf(folder: PurePath): string {
  return folder.length ? `${posixOf(folder)}/` : 'the working folder'
}

/** A text's fingerprint, as the manifest and the run's own record of what was shown keep it. */
export function instructionFingerprint(textIn: string): string {
  return createHash('sha256').update(textIn).digest('hex')
}

/** A folder whose instruction files are another tool's state or another project's, not this one's rules: a hidden
 *  folder (`.omx/`, `.claude/`…) other than this harness's own `.oasis-code/`. */
const hiddenFolder = (name: string): boolean => name.startsWith('.') && name !== '.oasis-code'

/** The instruction files of the subfolders of the working folder (from the workspace's file list) and of a writable
 *  attached folder (walked, links and excluded directories skipped), shallowest first, in path order: the ones a
 *  run's first message shows, so a folder's rules are known before anything changes there, and the folders of the
 *  rest, named. Left out, to be shown when the run reads or works there: a read-only attached folder's subfolders (no
 *  change can happen there — its root's rules come with the run), a subfolder that is a repository of its own (another
 *  project), and hidden folders. The first message carries at most MAX_DISCOVERED_FILES files and
 *  MAX_DISCOVERED_BYTES bytes of them. A file is read through the policy like any other. */
export function discoverInstructions(policy: PathPolicy, workspaceFiles: string[]): { shown: InstructionFile[]; more: string[] } {
  const names = new Set<string>(INSTRUCTION_FILES)
  const folders = new Set<string>()
  const consider = (rel: string) => {
    const parts = rel.split('/')
    for (const name of names) {
      const nameParts = name.split('/')
      if (parts.length > nameParts.length && parts.slice(-nameParts.length).join('/') === name) folders.add(parts.slice(0, parts.length - nameParts.length).join('/'))
    }
  }
  for (const rel of workspaceFiles) {
    const parts = rel.split('/')
    if (policy.isSkippedDir(parts) || parts.includes('.oasis-code') && !rel.endsWith('.oasis-code/INSTRUCTIONS.md')) { if (!rel.endsWith('.oasis-code/INSTRUCTIONS.md')) continue }
    if (parts.slice(0, -1).some(hiddenFolder)) continue
    consider(rel)
  }
  if (policy.attached !== null && policy.attached.writable && existsSync(join(policy.root, policy.attached.name))) {
    const walk = (dir: string, rel: string, depth: number): void => {
      if (depth > 12) return
      let entries
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name) || hiddenFolder(entry.name)) continue
          // a repository of its own inside the attached folder is another project: its rules come when the run works there
          if (existsSync(join(dir, entry.name, '.git'))) continue
          walk(join(dir, entry.name), `${rel}${entry.name}/`, depth + 1)
          continue
        }
        if (entry.isFile()) consider(`${rel}${entry.name}`)
      }
    }
    walk(policy.attached.root, `${policy.attached.name}/`, 0)
  }
  const ordered = [...folders].filter((f) => f !== '' && f !== policy.attached?.name).sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : a > b ? 1 : 0))
  const shown: InstructionFile[] = []
  const more: string[] = []
  let bytes = 0
  for (const folder of ordered) {
    const files = folderInstructions(policy, folder.split('/')).filter((f) => f.scope === scopeOf(folder.split('/')))
    if (!files.length) continue
    const size = files.reduce((n, f) => n + Buffer.byteLength(f.text, 'utf8'), 0)
    if (shown.length + files.length > MAX_DISCOVERED_FILES || bytes + size > MAX_DISCOVERED_BYTES) { more.push(`${folder}/`); continue }
    shown.push(...files)
    bytes += size
  }
  return { shown, more }
}

/** The instructions a run starts with: the settings' text, the working folder's files, an attached folder's
 *  files — each with its source and scope, in that order. */
export function projectInstructions(policy: PathPolicy, extraText: string | null | undefined = null): InstructionFile[] {
  const found: InstructionFile[] = []
  const push = (source: string, scope: string, text: string) => {
    const cut = truncateBytes(text)
    found.push({ source, scope, priority: String(found.length + 1), text: cut.text, truncated: cut.truncated })
  }
  if (extraText && extraText.trim()) push(SETTINGS_SOURCE, 'the whole project', extraText)
  for (const f of folderFiles(policy, [])) push(f.source, scopeOf([]), f.text)
  if (policy.attached !== null && existsSync(join(policy.root, policy.attached.name))) {
    for (const f of folderFiles(policy, [policy.attached.name])) push(f.source, scopeOf([policy.attached.name]), f.text)
  }
  return found
}

/** The instructions of the folders between a root and `folder` (a subfolder a run enters, as its normalized
 *  parts): the root's own are the run's from the start, so they are left out; deeper folders come later. */
export function folderInstructions(policy: PathPolicy, folder: PurePath): InstructionFile[] {
  if (policy.isOutside(folder)) return []
  const rootDepth = policy.isAttached(folder) ? 1 : 0
  const out: InstructionFile[] = []
  for (let depth = rootDepth + 1; depth <= folder.length; depth += 1) {
    const dir = folder.slice(0, depth)
    for (const f of folderFiles(policy, dir)) {
      const cut = truncateBytes(f.text)
      out.push({ source: f.source, scope: scopeOf(dir), priority: String(depth), text: cut.text, truncated: cut.truncated })
    }
  }
  return out
}

/** The parts of the folder a path names: the path itself for a directory, its parent for a file (a path that
 *  does not exist yet counts as a file's). */
export function folderOf(pure: PurePath, real: string): PurePath {
  let isDir = false
  try { isDir = statSync(real).isDirectory() } catch { isDir = false }
  return isDir ? pure : pure.slice(0, -1)
}
