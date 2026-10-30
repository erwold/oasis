/** Whether one set of scope globs covers only paths another covers: the languages the globs match, compared
 *  exactly. A glob matches as the file tools read it (work_orders.inScope): fnmatch's `*` and `?` cross `/`,
 *  `[...]` is a class, and a glob whose fixed form has no wildcard also covers everything below it. Each glob is a
 *  small automaton; inclusion is decided on the product of the two, over one representative character per class of
 *  characters no glob tells apart — so a fixed prefix that falls inside the old glob proves nothing by itself. */

type Token =
  | { kind: 'char'; c: number }
  | { kind: 'any' }
  | { kind: 'star' }
  | { kind: 'set'; negated: boolean; ranges: [number, number][] }

function clean(glob: string): string {
  const g = glob.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  return g === '.' ? '' : g
}

/** A pattern's tokens, as workspace/paths.fnmatchcase reads it (an unterminated `[` is a literal). */
function tokens(pattern: string): Token[] {
  const out: Token[] = []
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i]!
    if (c === '*') { if (out.at(-1)?.kind !== 'star') out.push({ kind: 'star' }); continue }
    if (c === '?') { out.push({ kind: 'any' }); continue }
    if (c === '[') {
      let j = i + 1
      if (j < pattern.length && pattern[j] === '!') j += 1
      if (j < pattern.length && pattern[j] === ']') j += 1
      while (j < pattern.length && pattern[j] !== ']') j += 1
      if (j < pattern.length) {
        let body = pattern.slice(i + 1, j)
        const negated = body.startsWith('!')
        if (negated) body = body.slice(1)
        const ranges: [number, number][] = []
        for (let k = 0; k < body.length; k += 1) {
          const lo = body.codePointAt(k)!
          if (body[k + 1] === '-' && k + 2 < body.length) { ranges.push([lo, body.codePointAt(k + 2)!]); k += 2 } else ranges.push([lo, lo])
        }
        out.push({ kind: 'set', negated, ranges })
        i = j
        continue
      }
    }
    out.push({ kind: 'char', c: c.codePointAt(0)! })
  }
  return out
}

function literal(text: string): Token[] {
  return [...text].map((ch) => ({ kind: 'char' as const, c: ch.codePointAt(0)! }))
}

/** The token patterns whose union is what one glob covers (null: the whole worktree). */
function patternsOf(globIn: string): Token[][] | null {
  const g = clean(globIn)
  if (g === '' || g === '*' || g === '**') return null
  const out = [tokens(g)]
  const base = g.endsWith('/**') ? g.slice(0, -3) : g
  if (!/[*?[]/.test(base)) out.push(literal(base), [...literal(`${base}/`), { kind: 'star' }])
  return out
}

function matches(t: Token, c: number): boolean {
  if (t.kind === 'char') return t.c === c
  if (t.kind === 'any' || t.kind === 'star') return true
  const inside = t.ranges.some(([lo, hi]) => c >= lo && c <= hi)
  return t.negated ? !inside : inside
}

/** An automaton over several patterns at once: a state is [pattern, position]. */
class Nfa {
  constructor(readonly patterns: Token[][]) {}

  private close(states: Set<string>): Set<string> {
    const out = new Set(states)
    const queue = [...states]
    while (queue.length) {
      const [p, i] = queue.pop()!.split(':').map(Number) as [number, number]
      if (this.patterns[p]![i]?.kind === 'star') {
        const next = `${p}:${i + 1}`
        if (!out.has(next)) { out.add(next); queue.push(next) }
      }
    }
    return out
  }

  start(): Set<string> { return this.close(new Set(this.patterns.map((_t, p) => `${p}:0`))) }

  step(states: Set<string>, c: number): Set<string> {
    const next = new Set<string>()
    for (const s of states) {
      const [p, i] = s.split(':').map(Number) as [number, number]
      const t = this.patterns[p]![i]
      if (t === undefined || !matches(t, c)) continue
      next.add(t.kind === 'star' ? s : `${p}:${i + 1}`)
    }
    return this.close(next)
  }

  accepts(states: Set<string>): boolean {
    for (const s of states) { const [p, i] = s.split(':').map(Number) as [number, number]; if (i === this.patterns[p]!.length) return true }
    return false
  }
}

/** One character per class of characters the patterns cannot tell apart. */
function alphabet(patterns: Token[][]): number[] {
  const cuts = new Set<number>([0, '/'.codePointAt(0)!, '/'.codePointAt(0)! + 1])
  for (const pattern of patterns) {
    for (const t of pattern) {
      if (t.kind === 'char') { cuts.add(t.c); cuts.add(t.c + 1) }
      if (t.kind === 'set') for (const [lo, hi] of t.ranges) { cuts.add(lo); cuts.add(hi + 1) }
    }
  }
  return [...cuts].filter((c) => c <= 0x10ffff).sort((a, b) => a - b)
}

/** Whether every path the `inner` globs cover is covered by the `outer` globs (null: the whole worktree). */
export function globsWithin(inner: string[], outer: string[] | null): boolean {
  if (outer === null) return true
  const outerPatterns: Token[][] = []
  for (const g of outer) { const p = patternsOf(g); if (p === null) return true; outerPatterns.push(...p) }
  for (const g of inner) {
    const innerPatterns = patternsOf(g)
    if (innerPatterns === null) return false
    const a = new Nfa(innerPatterns)
    const b = new Nfa(outerPatterns)
    const sigma = alphabet([...innerPatterns, ...outerPatterns])
    const key = (x: Set<string>, y: Set<string>) => `${[...x].sort().join(',')}|${[...y].sort().join(',')}`
    const seen = new Set<string>()
    const queue: [Set<string>, Set<string>][] = [[a.start(), b.start()]]
    while (queue.length) {
      const [x, y] = queue.pop()!
      const k = key(x, y)
      if (seen.has(k)) continue
      seen.add(k)
      if (a.accepts(x) && !b.accepts(y)) return false
      for (const c of sigma) {
        const nx = a.step(x, c)
        if (nx.size) queue.push([nx, b.step(y, c)])
      }
    }
  }
  return true
}
