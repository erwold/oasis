/** Math in words from a model, rewritten into the one delimiter the markdown reader takes: `$$` (remark-math with
 *  single dollars off, so a price stays a price). A display — `\[…\]` or a line of `$$…$$` — becomes a `$$` block of
 *  its own lines; inline math — `\(…\)`, and `$…$` by Pandoc's rule (nothing blank just inside the dollars, no digit
 *  right after the closing one: `$120–$180` is two prices) — becomes `$$…$$` within the line. Code, fenced or in
 *  backticks, an escaped dollar and math already in `$$` stay as they are; an opening without its closing stays text
 *  (an answer still streaming). Inside math, the markdown escape a model puts on a star (`r^\*`, kept from emphasis)
 *  is taken back: KaTeX knows no `\*`. Pure, so node --test exercises it. */

const FENCE = /^\s*(`{3,}|~{3,})/
/** A bracket display is math only when it reads as math: a markdown writer also escapes a literal `\[1\]`. */
const LOOKS_LIKE_MATH = /[\\^_{}=+<>]/

/** Math as KaTeX reads it: `\*` a star again; every other pair (`\\`, `\{`, `\_`, …) means what TeX says. */
const tex = (math: string): string => math.replace(/\\([\s\S])/g, (pair, c: string) => (c === '*' ? '*' : pair))

export function mathMarkdown(text: string): string {
  if (!/[$\\]/.test(text)) return text
  const lines = text.split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!
    const indent = /^\s*/.exec(line)![0]
    const trimmed = line.trim()
    const fence = FENCE.exec(line)
    if (fence) {
      // a fenced block goes through as written, up to its closing fence (or the end)
      const marker = fence[1]!
      out.push(line)
      for (i += 1; i < lines.length; i += 1) {
        out.push(lines[i]!)
        if (new RegExp(`^\\s*${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`).test(lines[i]!)) break
      }
      continue
    }
    if (trimmed === '$$') {
      // a display block already: its lines are math
      out.push(line)
      for (i += 1; i < lines.length; i += 1) {
        const closing = lines[i]!.trim() === '$$'
        out.push(closing ? lines[i]! : tex(lines[i]!))
        if (closing) break
      }
      continue
    }
    const oneLine = /^\$\$(.+)\$\$$/.exec(trimmed)
    if (oneLine && !oneLine[1]!.includes('$$') && oneLine[1]!.trim()) {
      out.push(`${indent}$$`, `${indent}${tex(oneLine[1]!.trim())}`, `${indent}$$`)
      continue
    }
    if (trimmed.startsWith('\\[')) {
      const display = bracketDisplay(lines, i)
      if (display) {
        out.push(`${indent}$$`, ...display.body.map((l) => `${indent}${tex(l)}`), `${indent}$$`)
        i = display.end
        continue
      }
    }
    out.push(inlineMath(line))
  }
  return out.join('\n')
}

/** `\[` opening line `i` and its `\]` ending a line, before a blank line: the math between, trimmed. */
function bracketDisplay(lines: string[], i: number): { body: string[]; end: number } | null {
  const first = lines[i]!.trim().slice(2)
  const parts: string[] = []
  for (let j = i; j < lines.length; j += 1) {
    const part = j === i ? first : lines[j]!.trim()
    if (j > i && !part) return null
    const close = part.indexOf('\\]')
    if (close < 0) { parts.push(part); continue }
    if (part.slice(close + 2).trim()) return null
    parts.push(part.slice(0, close))
    const body = parts.map((p) => p.trim()).filter(Boolean)
    return body.length && LOOKS_LIKE_MATH.test(body.join(' ')) ? { body, end: j } : null
  }
  return null
}

/** One line's inline math as `$$…$$`; code spans, escapes and `$$` spans kept. */
function inlineMath(line: string): string {
  let out = ''
  let i = 0
  while (i < line.length) {
    const c = line[i]!
    if (c === '`') {
      const run = /^`+/.exec(line.slice(i))![0]
      const close = line.indexOf(run, i + run.length)
      const end = close < 0 ? i + run.length : close + run.length
      out += line.slice(i, end)
      i = end
      continue
    }
    if (c === '\\') {
      const next = line[i + 1]
      const closer = next === '(' ? '\\)' : next === '[' ? '\\]' : null
      if (closer) {
        const close = line.indexOf(closer, i + 2)
        const inner = close < 0 ? '' : line.slice(i + 2, close).trim()
        if (inner && (next === '(' || LOOKS_LIKE_MATH.test(inner))) {
          out += `$$${tex(inner)}$$`
          i = close + 2
          continue
        }
      }
      out += line.slice(i, i + 2)
      i += 2
      continue
    }
    if (c === '$' && line[i + 1] === '$') {
      const close = line.indexOf('$$', i + 2)
      out += close < 0 ? '$$' : `$$${tex(line.slice(i + 2, close))}$$`
      i = close < 0 ? i + 2 : close + 2
      continue
    }
    if (c === '$') {
      const close = singleDollarClose(line, i)
      if (close > 0) {
        out += `$$${tex(line.slice(i + 1, close))}$$`
        i = close + 1
        continue
      }
    }
    out += c
    i += 1
  }
  return out
}

/** Where the `$` at `open` closes as inline math by Pandoc's rule, or -1: the next unescaped dollar, with nothing
 *  blank just inside either one and no digit (or dollar) right after the closing one. */
function singleDollarClose(line: string, open: number): number {
  const after = line[open + 1]
  if (after === undefined || /\s/.test(after)) return -1
  for (let j = open + 1; j < line.length; j += 1) {
    if (line[j] === '\\') { j += 1; continue }
    if (line[j] !== '$') continue
    if (/\s/.test(line[j - 1]!) || /[\d$]/.test(line[j + 1] ?? '')) return -1
    return j
  }
  return -1
}
