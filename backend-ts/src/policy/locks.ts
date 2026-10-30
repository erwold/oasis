/** Hard locks — the coding counterpart of oasis's uid × facet locks (see NOTICE): a path glob, optionally one
 *  symbol in it, × a mode — read_only (no change at all), no_delete (the file / the symbol stays), or
 *  no_signature_change (the signatures of the symbol, or of every top-level and nested definition in the file,
 *  stay as they are; bodies may change). Locks are checked against the actual bytes, never promised in a prompt:
 *  before a file write (the write is refused), after a command ran (a violation is recorded and reported),
 *  and before a checkpoint or an integration pins a tree (refused). Signatures are read from Python's definitions
 *  for .py files and from definition lines for other languages. */

import { LockSpecSchema, type LockSpec } from '@oasis-code/contract'
import type { GitHost } from '../workspace/git.ts'
import { foldName, globMatch } from '../workspace/paths.ts'
import { pyDefinitions, PySyntaxError } from '../workspace/pysyntax.ts'
import { text } from '../prompt_texts.ts'

export type { LockSpec }
export { LockSpecSchema }

const DEF_LINE = /^\s*(?:export\s+)?(?:default\s+)?(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:static\s+)?(?:function\*?|def|fn|func|class|interface|struct|trait|enum|type)\s+([A-Za-z_$][\w$]*)\s*([^{;=]*)/gm

export function lockSpec(raw: unknown): LockSpec {
  return LockSpecSchema.parse(raw)
}

export function lockCovers(lock: LockSpec, rel: string): boolean {
  const p = rel.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  const g = lock.path.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (globMatch(p, g)) return true
  const base = foldName(g.endsWith('/**') ? g.slice(0, -3) : g)
  const name = foldName(p)
  return !base.includes('*') && (name === base || name.startsWith(base + '/'))
}

/** What a lock holds, as one line for the model: the path (and symbol) and the one thing it must not do. */
export function describeLock(lock: LockSpec): string {
  const path = `${lock.path}${lock.symbol ? '::' + lock.symbol : ''}`
  if (lock.mode === 'read_only') return text('context.lock_read_only', { path })
  if (lock.mode === 'no_delete') return text('context.lock_no_delete', { path })
  return lock.symbol ? text('context.lock_signature', { path: lock.path, symbol: lock.symbol }) : `${lock.path}: keep the signatures unchanged.`
}

/** The file could not be read for signatures (a syntax error, say): a signature lock cannot be verified. */
export class SignatureUnknown extends Error {
  constructor(message: string) { super(message); this.name = 'SignatureUnknown' }
}

function pySignatures(text: string): [Record<string, string>, Record<string, string>] {
  let defs
  try {
    defs = pyDefinitions(text)
  } catch (error) {
    if (error instanceof PySyntaxError) throw new SignatureUnknown(`python does not parse (${error.message} at line ${error.line})`)
    throw error
  }
  const sigs: Record<string, string> = {}
  const sources: Record<string, string> = {}
  for (const def of defs) {
    sigs[def.name] = def.signature
    sources[def.name] = def.source
  }
  return [sigs, sources]
}

/** [{name: signature}, {name: source or signature}] for a file's definitions. */
export function signatures(path: string, text: string): [Record<string, string>, Record<string, string>] {
  if (path.endsWith('.py')) return pySignatures(text)
  const sigs: Record<string, string> = {}
  DEF_LINE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = DEF_LINE.exec(text)) !== null) {
    if (!(m[1]! in sigs)) sigs[m[1]!] = m[0].split(/\s+/).filter(Boolean).join(' ')
  }
  return [sigs, { ...sigs }]
}

function symbolMatch(sigs: Record<string, string>, symbol: string): string[] {
  return Object.keys(sigs).filter((n) => n === symbol || n.endsWith('.' + symbol))
}

/** Why a change of `rel` from `before` to `after` (null = absent) breaks a lock; empty when none. */
export function checkChange(locks: LockSpec[], rel: string, before: string | null, after: string | null, options: { paths_matched?: boolean } = {}): string[] {
  const reasons: string[] = []
  for (const lock of locks) {
    if (!options.paths_matched && !lockCovers(lock, rel)) continue
    if (before === after) continue
    if (lock.symbol === null || lock.symbol === undefined) {
      if (lock.mode === 'read_only') reasons.push(`${rel} is read-only (${describeLock(lock)})`)
      else if (lock.mode === 'no_delete' && before !== null && after === null) reasons.push(`${rel} must not be deleted (${describeLock(lock)})`)
      else if (lock.mode === 'no_signature_change' && before !== null) {
        if (after === null) { reasons.push(`${rel} must not be deleted: its signatures are locked (${describeLock(lock)})`); continue }
        let old: Record<string, string>
        let fresh: Record<string, string>
        try {
          ;[old] = signatures(rel, before)
          ;[fresh] = signatures(rel, after)
        } catch (error) {
          if (error instanceof SignatureUnknown) { reasons.push(`${rel}: the signature lock cannot be verified — ${error.message} (${describeLock(lock)})`); continue }
          throw error
        }
        const changed = Object.keys(old).filter((n) => fresh[n] !== old[n]).sort()
        if (changed.length) reasons.push(`${rel}: signature(s) changed or removed: ${changed.slice(0, 8).join(', ')} (${describeLock(lock)})`)
      }
      continue
    }
    // a symbol lock
    if (before === null) continue
    let oldSigs: Record<string, string>
    let oldSrc: Record<string, string>
    let newSigs: Record<string, string>
    let newSrc: Record<string, string>
    try {
      ;[oldSigs, oldSrc] = signatures(rel, before)
      ;[newSigs, newSrc] = after !== null ? signatures(rel, after) : [{}, {}]
    } catch (error) {
      if (error instanceof SignatureUnknown) { reasons.push(`${rel}: the lock on ${lock.symbol} cannot be verified — ${error.message} (${describeLock(lock)})`); continue }
      throw error
    }
    const names = symbolMatch(oldSigs, lock.symbol)
    if (!names.length) continue
    for (const name of names) {
      if (!(name in newSigs)) {
        reasons.push(`${rel}: ${name} may not be removed (${describeLock(lock)})`)
      } else if (lock.mode === 'no_signature_change' && newSigs[name] !== oldSigs[name]) {
        reasons.push(`${rel}: the signature of ${name} changed: '${oldSigs[name]}' -> '${newSigs[name]}' (${describeLock(lock)})`)
      } else if (lock.mode === 'read_only' && newSrc[name] !== oldSrc[name]) {
        reasons.push(`${rel}: ${name} is read-only (${describeLock(lock)})`)
      }
    }
  }
  return reasons
}

/** Lock violations between two trees of a repository: every changed path a lock covers, checked on its bytes. */
export async function checkTree(git: GitHost, repo: string, baseTree: string, tree: string, locks: LockSpec[]): Promise<string[]> {
  if (!locks.length || baseTree === tree) return []
  const out = (await git.run(['diff-tree', '-r', '--name-status', '-z', '--no-renames', baseTree, tree], { cwd: repo })).out
  const parts = out.split('\0')
  const reasons: string[] = []
  const decoder = new TextDecoder('utf-8', { fatal: false })
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i]!
    const rel = parts[i + 1]!
    if (!status || !locks.some((lock) => lockCovers(lock, rel))) continue
    const before = status !== 'A' ? await git.showBlob(repo, baseTree, rel) : null
    const after = status !== 'D' ? await git.showBlob(repo, tree, rel) : null
    reasons.push(...checkChange(locks, rel, before !== null ? decoder.decode(before) : null, after !== null ? decoder.decode(after) : null))
  }
  return reasons
}
