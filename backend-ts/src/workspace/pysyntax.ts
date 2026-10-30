/** A small reader of Python definitions — enough for the symbol picker and the signature locks: every `def` /
 *  `class` with its qualified name (nesting by indentation), its line, its signature as Python's ast.unparse would
 *  print it for ordinary code (decorators, `async`, annotations, defaults, the return annotation), and its source
 *  segment. The first backend used the `ast` module; this one reads the text and refuses what it cannot follow
 *  (an unbalanced header, a `def` without a name) the way a parse error did. */

export class PySyntaxError extends Error {
  constructor(message: string, readonly line: number) { super(message); this.name = 'PySyntaxError' }
}

export interface PyDefinition {
  name: string           // qualified: Outer.inner
  kind: 'class' | 'function'
  line: number           // 1-based line of the def / class keyword
  signature: string
  source: string
}

const HEADER = /^(\s*)(?:(async)\s+)?(def|class)\b\s*(.*)$/
const DEF_KEYWORD = /^\s*(?:async\s+)?(?:def|class)\b/
const DECORATOR = /^\s*@/

function stripComment(line: string): string {
  let inStr: string | null = null
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]!
    if (inStr) {
      if (c === '\\') i += 1
      else if (c === inStr) inStr = null
    } else if (c === '"' || c === "'") inStr = c
    else if (c === '#') return line.slice(0, i)
  }
  return line
}

function depthDelta(text: string): number {
  let depth = 0
  let inStr: string | null = null
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!
    if (inStr) {
      if (c === '\\') i += 1
      else if (c === inStr) inStr = null
      continue
    }
    if (c === '"' || c === "'") inStr = c
    else if (c === '(' || c === '[' || c === '{') depth += 1
    else if (c === ')' || c === ']' || c === '}') depth -= 1
  }
  return depth
}

/** One parameter list normalized the way ast.unparse prints it: `a`, `a: int`, `a=1`, `a: int = 1`, `*args`, `**kw`. */
function normalizeParams(inner: string): string {
  const params: string[] = []
  let current = ''
  let depth = 0
  let inStr: string | null = null
  for (let i = 0; i < inner.length; i += 1) {
    const c = inner[i]!
    if (inStr) {
      current += c
      if (c === '\\') { current += inner[i + 1] ?? ''; i += 1 } else if (c === inStr) inStr = null
      continue
    }
    if (c === '"' || c === "'") { inStr = c; current += c; continue }
    if (c === '(' || c === '[' || c === '{') depth += 1
    if (c === ')' || c === ']' || c === '}') depth -= 1
    if (c === ',' && depth === 0) { params.push(current); current = ''; continue }
    current += c
  }
  if (current.trim()) params.push(current)
  return params.map((p) => normalizeParam(p.trim())).filter(Boolean).join(', ')
}

function normalizeParam(p: string): string {
  const compact = p.replace(/\s+/g, ' ').trim()
  if (compact === '/' || compact === '*') return compact
  // split at the first top-level ':' (annotation) and '=' (default)
  let depth = 0
  let colon = -1
  let eq = -1
  let inStr: string | null = null
  for (let i = 0; i < compact.length; i += 1) {
    const c = compact[i]!
    if (inStr) { if (c === '\\') i += 1; else if (c === inStr) inStr = null; continue }
    if (c === '"' || c === "'") { inStr = c; continue }
    if (c === '(' || c === '[' || c === '{') depth += 1
    else if (c === ')' || c === ']' || c === '}') depth -= 1
    else if (depth === 0 && c === ':' && colon < 0 && eq < 0) colon = i
    else if (depth === 0 && c === '=' && eq < 0 && compact[i + 1] !== '=' && compact[i - 1] !== '=' && compact[i - 1] !== '!' && compact[i - 1] !== '<' && compact[i - 1] !== '>') eq = i
  }
  const name = compact.slice(0, colon >= 0 ? colon : eq >= 0 ? eq : compact.length).trim()
  const annotation = colon >= 0 ? compact.slice(colon + 1, eq >= 0 ? eq : compact.length).trim() : null
  const dflt = eq >= 0 ? compact.slice(eq + 1).trim() : null
  let out = name
  if (annotation) out += `: ${normalizeExpr(annotation)}`
  if (dflt !== null) out += annotation ? ` = ${normalizeExpr(dflt)}` : `=${normalizeExpr(dflt)}`
  return out
}

/** Whitespace of an expression the way ast.unparse spaces it: none inside brackets' edges, one after commas. */
function normalizeExpr(expr: string): string {
  return expr.replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').replace(/\[\s+/g, '[').replace(/\s+\]/g, ']').trim()
}

function signatureOf(kind: 'def' | 'class', isAsync: boolean, header: string, decorators: string[], line: number): string {
  // header: everything after the keyword up to and including the header's ':'
  const nameMatch = /^([A-Za-z_][\w]*)\s*(.*)$/s.exec(header.trim())
  if (!nameMatch) throw new PySyntaxError(`invalid syntax`, line)
  const name = nameMatch[1]!
  let rest = nameMatch[2]!.trim()
  const deco = decorators.map((d) => `@${normalizeExpr(d.trim().slice(1))} `).join('')
  if (kind === 'class') {
    let bases = ''
    if (rest.startsWith('(')) {
      const close = matchingParen(rest, 0)
      if (close < 0) throw new PySyntaxError('unbalanced parentheses', line)
      bases = normalizeParams(rest.slice(1, close))
      rest = rest.slice(close + 1).trim()
    }
    if (!rest.startsWith(':')) throw new PySyntaxError("expected ':'", line)
    return `${deco}class ${name}(${bases})`
  }
  if (!rest.startsWith('(')) throw new PySyntaxError("expected '('", line)
  const close = matchingParen(rest, 0)
  if (close < 0) throw new PySyntaxError('unbalanced parentheses', line)
  const params = normalizeParams(rest.slice(1, close))
  rest = rest.slice(close + 1).trim()
  let ret = ''
  if (rest.startsWith('->')) {
    const colon = rest.lastIndexOf(':')
    if (colon < 0) throw new PySyntaxError("expected ':'", line)
    ret = ` -> ${normalizeExpr(rest.slice(2, colon))}`
    rest = rest.slice(colon)
  }
  if (!rest.startsWith(':')) throw new PySyntaxError("expected ':'", line)
  return `${deco}${isAsync ? 'async ' : ''}def ${name}(${params})${ret}`
}

function matchingParen(text: string, open: number): number {
  let depth = 0
  let inStr: string | null = null
  for (let i = open; i < text.length; i += 1) {
    const c = text[i]!
    if (inStr) { if (c === '\\') i += 1; else if (c === inStr) inStr = null; continue }
    if (c === '"' || c === "'") inStr = c
    else if (c === '(' || c === '[' || c === '{') depth += 1
    else if (c === ')' || c === ']' || c === '}') { depth -= 1; if (depth === 0) return i }
  }
  return -1
}

/** Every definition of a Python file, in source order. Throws PySyntaxError for what it cannot follow. */
export function pyDefinitions(text: string): PyDefinition[] {
  const lines = text.split('\n')
  const out: PyDefinition[] = []
  const stack: { indent: number; name: string; def: PyDefinition; startLine: number }[] = []
  let pendingDecorators: string[] = []
  let decoratorIndent = -1
  const endBodies = (indent: number, upToLine: number) => {
    while (stack.length && stack[stack.length - 1]!.indent >= indent) {
      const done = stack.pop()!
      done.def.source = sourceSegment(lines, done.startLine, upToLine)
    }
  }
  let i = 0
  while (i < lines.length) {
    const raw = lines[i]!
    const line = stripComment(raw)
    if (!line.trim()) { i += 1; continue }
    const indent = line.length - line.trimStart().length
    if (DECORATOR.test(line)) {
      // a decorator may span lines
      let deco = line.trim()
      let depth = depthDelta(deco)
      let j = i
      while (depth > 0 && j + 1 < lines.length) { j += 1; deco += ' ' + stripComment(lines[j]!).trim(); depth += depthDelta(stripComment(lines[j]!)) }
      if (decoratorIndent !== indent) pendingDecorators = []
      decoratorIndent = indent
      pendingDecorators.push(deco)
      i = j + 1
      continue
    }
    const header = HEADER.exec(line)
    if (header) {
      const startLine = i
      endBodies(indent, startLine)
      // the header may span lines until its ':' at depth 0
      let text = header[4]!
      let depth = depthDelta(text)
      let j = i
      while ((depth > 0 || !/:\s*$/.test(text)) && j + 1 < lines.length && depth >= 0) {
        j += 1
        const more = stripComment(lines[j]!)
        text += ' ' + more.trim()
        depth += depthDelta(more)
        if (depth === 0 && /:\s*$/.test(text)) break
        if (j - i > 200) break
      }
      // the header's last ':' at depth 0 (a one-line body may follow it)
      const kind = header[3] as 'def' | 'class'
      const decorators = decoratorIndent === indent ? pendingDecorators : []
      pendingDecorators = []
      decoratorIndent = -1
      const colonAt = headerColon(text)
      if (colonAt < 0) throw new PySyntaxError('invalid syntax', i + 1)
      const signature = signatureOf(kind, header[2] === 'async', text.slice(0, colonAt + 1), decorators, i + 1)
      const localName = /^\s*([A-Za-z_]\w*)/.exec(text)![1]!
      const qualified = [...stack.map((s) => s.name), localName].join('.')
      const def: PyDefinition = { name: qualified, kind: kind === 'class' ? 'class' : 'function', line: i + 1, signature, source: '' }
      out.push(def)
      stack.push({ indent, name: localName, def, startLine })
      i = j + 1
      continue
    }
    if (DEF_KEYWORD.test(line)) throw new PySyntaxError('invalid syntax', i + 1)
    if (stack.length && indent <= stack[stack.length - 1]!.indent) endBodies(indent, i)
    pendingDecorators = []
    decoratorIndent = -1
    // a statement may open brackets that span lines: skip to their end
    let depth = depthDelta(line)
    let j = i
    while (depth > 0 && j + 1 < lines.length) { j += 1; depth += depthDelta(stripComment(lines[j]!)) }
    i = j + 1
  }
  endBodies(-1, lines.length)
  return out
}

function headerColon(text: string): number {
  let depth = 0
  let inStr: string | null = null
  let last = -1
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!
    if (inStr) { if (c === '\\') i += 1; else if (c === inStr) inStr = null; continue }
    if (c === '"' || c === "'") inStr = c
    else if (c === '(' || c === '[' || c === '{') depth += 1
    else if (c === ')' || c === ']' || c === '}') depth -= 1
    else if (c === ':' && depth === 0) { last = i; break }
  }
  return last
}

/** The lines of a definition from its header to the last non-blank line of its body. */
function sourceSegment(lines: string[], start: number, end: number): string {
  let last = Math.min(end, lines.length) - 1
  while (last > start && !lines[last]!.trim()) last -= 1
  return lines.slice(start, last + 1).join('\n')
}
