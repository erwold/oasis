/** What a person can point at in a workspace (the coding counterpart of oasis's entities, see NOTICE): its files
 *  and the definitions in them. The @ picker asks for them by a query; a mention the person sends is a read-only
 *  pointer — resolved through the path policy, pinned by the file's sha256, and never a widening of any grant. */

import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_FILE_BYTES, PathPolicy, PathRefused, posixOf } from './paths.ts'
import { pyDefinitions, PySyntaxError } from './pysyntax.ts'
import { text } from '../prompt_texts.ts'

export const MAX_SYMBOL_FILES = 1500
const DEF = /^[ \t]*(?:export\s+)?(?:default\s+)?(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:static\s+)?(?:function\*?|def|fn|func|class|interface|struct|trait|enum|type)\s+([A-Za-z_$][\w$]*)/gm
export const CODE_SUFFIXES = ['.py', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.rs', '.go', '.java', '.kt', '.swift', '.rb', '.php', '.cs', '.c', '.h', '.cpp', '.hpp', '.scala']

export interface Mention { path: string; symbol?: string | null }
export interface Symbol { path: string; name: string; kind: string; line: number }

/** Every definition in a file with its line: qualified names for Python, definition lines elsewhere. */
export function symbolsOf(path: string, text: string): Symbol[] {
  const out: Symbol[] = []
  if (path.endsWith('.py')) {
    try {
      for (const def of pyDefinitions(text)) out.push({ path, name: def.name, kind: def.kind, line: def.line })
    } catch (error) {
      if (error instanceof PySyntaxError) return []
      throw error
    }
    return out
  }
  DEF.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = DEF.exec(text)) !== null) {
    const line = text.slice(0, m.index).split('\n').length
    out.push({ path, name: m[1]!, kind: 'definition', line })
  }
  return out
}

/** A cheap fuzzy match: a substring beats an in-order subsequence; the basename beats the directory. */
function score(candidate: string, query: string): number | null {
  const c = candidate.toLowerCase()
  const q = query.toLowerCase()
  if (!q) return 0
  const base = c.slice(c.lastIndexOf('/') + 1)
  if (base.startsWith(q)) return 0
  if (base.includes(q)) return 1
  if (c.includes(q)) return 2
  let at = 0
  for (const ch of q) {
    const found = c.indexOf(ch, at)
    if (found < 0) return null
    at = found + 1
  }
  return 3
}

/** Paths and symbols matching `query` (paths from the workspace's file list; symbols only for a non-empty query). */
export function findEntities(files: string[], root: string, rawQuery: string, opts: { limit?: number } = {}): { query: string; paths: string[]; symbols: Symbol[] } {
  const limit = opts.limit ?? 30
  const query = rawQuery.trim().replace(/^@+/, '')
  const sep = query.indexOf('::')
  const pathPart = sep < 0 ? query : query.slice(0, sep)
  const symbolPart = sep < 0 ? '' : query.slice(sep + 2)
  const scored: [number, string][] = []
  for (const f of files) {
    const s = score(f, pathPart)
    if (s !== null) scored.push([s, f])
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].length - b[1].length || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
  let symbols: Symbol[] = []
  const symQuery = symbolPart || (!pathPart.includes('/') && !pathPart.includes('.') ? pathPart : '')
  if (symQuery) {
    let scope = files.filter((f) => CODE_SUFFIXES.some((s) => f.endsWith(s)))
    if (symbolPart) scope = scope.filter((f) => score(f, pathPart) !== null)
    const hits: [number, number, Symbol][] = []
    for (const rel of scope.slice(0, MAX_SYMBOL_FILES)) {
      const path = join(root, rel)
      let text: string
      try {
        if (statSync(path).size > MAX_FILE_BYTES) continue
        text = readFileSync(path, 'utf8')
      } catch {
        continue
      }
      for (const sym of symbolsOf(rel, text)) {
        const s = score(sym.name.slice(sym.name.lastIndexOf('.') + 1), symQuery)
        if (s !== null) hits.push([s, sym.name.length, sym])
      }
    }
    hits.sort((a, b) => a[0] - b[0] || a[1] - b[1] || (a[2].path < b[2].path ? -1 : a[2].path > b[2].path ? 1 : 0))
    symbols = hits.slice(0, limit).map((h) => h[2])
  }
  return { query, paths: scored.slice(0, limit).map((s) => s[1]), symbols }
}

export interface ResolvedMention { path: string; sha256: string; bytes: number; symbol?: string; line?: number }

/** Each mention checked against the workspace (the path policy; the symbol must be defined in the file) and pinned
 *  by the file's sha256. One that does not resolve — no such file, a path outside the workspace, no such definition —
 *  is no mention: its words stay text, as the person wrote them (pasted notes say "@400/500" or "@torch.no_grad"; a
 *  stray @ never refuses a message). */
export function resolveMentions(policy: PathPolicy, mentions: Mention[]): ResolvedMention[] {
  const out: ResolvedMention[] = []
  for (const m of mentions) {
    let pure: string[]
    let real: string
    try {
      ;[pure, real] = policy.resolveRead(m.path)
    } catch (error) {
      if (error instanceof PathRefused) continue
      throw error
    }
    let data: Buffer
    try {
      if (!statSync(real).isFile()) continue
      data = readFileSync(real)
    } catch {
      continue
    }
    const item: ResolvedMention = { path: posixOf(pure), sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length }
    if (m.symbol) {
      const found = symbolsOf(posixOf(pure), data.toString('utf8')).filter((s) => s.name === m.symbol || s.name.endsWith('.' + m.symbol))
      if (!found.length) continue
      item.symbol = found[0]!.name
      item.line = found[0]!.line
    }
    out.push(item)
  }
  return out
}

export function mentionsNote(resolved: ResolvedMention[]): string {
  const references = resolved.map((m) => `- ${m.symbol ? `${m.path}::${m.symbol} (line ${m.line})` : m.path}, version ${m.sha256.slice(0, 16)}`)
  return text('context.mentions', { references: references.join('\n') })
}

/** The @path / @path::symbol tokens a message carries (what the composer inserts), in order, once each. */
export function mentionTokens(text: string): Mention[] {
  const seen = new Set<string>()
  const out: Mention[] = []
  const re = /(?<!\S)@([\w./-]+(?:::[\w.$]+)?)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const token = m[1]!.replace(/[.,;:]+$/, '')
    const sep = token.indexOf('::')
    const path = sep < 0 ? token : token.slice(0, sep)
    const symbol = sep < 0 ? '' : token.slice(sep + 2)
    if (!path || (!path.includes('/') && !path.includes('.')) || seen.has(token)) continue
    seen.add(token)
    out.push({ path, symbol: symbol || null })
  }
  return out
}
