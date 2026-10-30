/** Text diffs as difflib prints them: the file tools' diff of a write, and the journal's of a folder edited in place. */

/** A unified diff (three lines of context) of two texts, the way difflib.unified_diff prints it. */
export function unifiedDiff(a: string, b: string, rel: string, context = 3): string {
  const al = splitKeepEnds(a)
  const bl = splitKeepEnds(b)
  const ops = diffOps(al, bl)
  if (!ops.some((o) => o.tag !== 'equal')) return ''
  const out: string[] = [`--- a/${rel}\n`, `+++ b/${rel}\n`]
  const groups = groupedOpcodes(ops, context)
  for (const group of groups) {
    const first = group[0]!
    const last = group[group.length - 1]!
    const i1 = first.i1
    const i2 = last.i2
    const j1 = first.j1
    const j2 = last.j2
    out.push(`@@ -${range(i1, i2)} +${range(j1, j2)} @@\n`)
    for (const op of group) {
      if (op.tag === 'equal') for (const line of al.slice(op.i1, op.i2)) out.push(' ' + line)
      if (op.tag === 'replace' || op.tag === 'delete') for (const line of al.slice(op.i1, op.i2)) out.push('-' + line)
      if (op.tag === 'replace' || op.tag === 'insert') for (const line of bl.slice(op.j1, op.j2)) out.push('+' + line)
    }
  }
  return out.map((line) => (line.endsWith('\n') ? line : line + '\n\\ No newline at end of file\n')).join('')
}

function range(start: number, stop: number): string {
  const length = stop - start
  const begin = length ? start + 1 : start
  return length === 1 ? String(begin) : `${begin},${length}`
}

function splitKeepEnds(text: string): string[] {
  if (!text) return []
  const out: string[] = []
  let start = 0
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') { out.push(text.slice(start, i + 1)); start = i + 1 }
  }
  if (start < text.length) out.push(text.slice(start))
  return out
}

interface Op { tag: 'equal' | 'replace' | 'delete' | 'insert'; i1: number; i2: number; j1: number; j2: number }

/** Opcodes over two sequences by a longest-common-subsequence table (the files here are small). */
function diffOps(a: string[], b: string[]): Op[] {
  const n = a.length
  const m = b.length
  // strip common prefix / suffix to keep the table small
  let p = 0
  while (p < n && p < m && a[p] === b[p]) p += 1
  let s = 0
  while (s < n - p && s < m - p && a[n - 1 - s] === b[m - 1 - s]) s += 1
  const ca = a.slice(p, n - s)
  const cb = b.slice(p, m - s)
  const lcs: number[][] = Array.from({ length: ca.length + 1 }, () => new Array<number>(cb.length + 1).fill(0))
  for (let i = ca.length - 1; i >= 0; i -= 1) {
    for (let j = cb.length - 1; j >= 0; j -= 1) {
      lcs[i]![j] = ca[i] === cb[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
    }
  }
  const ops: Op[] = []
  const push = (tag: Op['tag'], i1: number, i2: number, j1: number, j2: number) => {
    const last = ops[ops.length - 1]
    if (last && last.tag === tag && last.i2 === i1 && last.j2 === j1) { last.i2 = i2; last.j2 = j2 } else ops.push({ tag, i1, i2, j1, j2 })
  }
  if (p) push('equal', 0, p, 0, p)
  let i = 0
  let j = 0
  while (i < ca.length || j < cb.length) {
    if (i < ca.length && j < cb.length && ca[i] === cb[j]) { push('equal', p + i, p + i + 1, p + j, p + j + 1); i += 1; j += 1 }
    // on a tie the old line goes first: a delete then an insert, merged below into the replace difflib and git print
    else if (j < cb.length && (i >= ca.length || lcs[i]![j + 1]! > lcs[i + 1]![j]!)) { push('insert', p + i, p + i, p + j, p + j + 1); j += 1 }
    else { push('delete', p + i, p + i + 1, p + j, p + j); i += 1 }
  }
  if (s) push('equal', n - s, n, m - s, m)
  // a delete followed by an insert is a replace
  const merged: Op[] = []
  for (const op of ops) {
    const last = merged[merged.length - 1]
    if (last && last.tag === 'delete' && op.tag === 'insert' && last.i2 === op.i1) { last.tag = 'replace'; last.j2 = op.j2 } else merged.push({ ...op })
  }
  return merged
}

function groupedOpcodes(ops: Op[], n: number): Op[][] {
  const codes = ops.map((o) => ({ ...o }))
  if (!codes.length) return []
  const first = codes[0]!
  if (first.tag === 'equal') { first.i1 = Math.max(first.i1, first.i2 - n); first.j1 = Math.max(first.j1, first.j2 - n) }
  const last = codes[codes.length - 1]!
  if (last.tag === 'equal') { last.i2 = Math.min(last.i2, last.i1 + n); last.j2 = Math.min(last.j2, last.j1 + n) }
  const nn = n + n
  const groups: Op[][] = []
  let group: Op[] = []
  for (const op of codes) {
    if (op.tag === 'equal' && op.i2 - op.i1 > nn) {
      group.push({ tag: 'equal', i1: op.i1, i2: Math.min(op.i2, op.i1 + n), j1: op.j1, j2: Math.min(op.j2, op.j1 + n) })
      groups.push(group)
      group = []
      group.push({ tag: 'equal', i1: Math.max(op.i1, op.i2 - n), i2: op.i2, j1: Math.max(op.j1, op.j2 - n), j2: op.j2 })
      continue
    }
    group.push(op)
  }
  if (group.length && !(group.length === 1 && group[0]!.tag === 'equal')) groups.push(group)
  return groups
}
