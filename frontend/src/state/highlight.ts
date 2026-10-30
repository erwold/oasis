/** A light syntax colouring for code in the thread (after beautiful-ui's code block): strings and numbers, keywords,
 *  calls, and line comments in the languages that have them. It never changes the text: the pieces joined give the
 *  line back exactly. */

export type TokenKind = 'plain' | 'string' | 'number' | 'keyword' | 'call' | 'comment'
export interface Token { text: string; kind: TokenKind }

const KEYWORDS = new Set([
  // JavaScript / TypeScript
  'import', 'from', 'export', 'default', 'async', 'function', 'const', 'let', 'var', 'await', 'return', 'if', 'else', 'for', 'while',
  'new', 'throw', 'try', 'catch', 'finally', 'null', 'true', 'false', 'undefined', 'class', 'extends', 'interface', 'type', 'of', 'in',
  // Python
  'def', 'lambda', 'elif', 'pass', 'yield', 'with', 'as', 'not', 'and', 'or', 'is', 'None', 'True', 'False', 'raise', 'except', 'global',
  // shell
  'then', 'fi', 'do', 'done', 'case', 'esac', 'echo',
])
const HASH_COMMENTS = new Set(['python', 'py', 'sh', 'bash', 'zsh', 'shell', 'console', 'yaml', 'yml', 'toml', 'ruby', 'rb', 'r', 'dockerfile', 'makefile'])
const SLASH_COMMENTS = new Set(['js', 'javascript', 'ts', 'typescript', 'tsx', 'jsx', 'java', 'c', 'cpp', 'c++', 'go', 'rust', 'rs', 'swift', 'kotlin', 'kt', 'json5', 'css', 'scss'])
const TOKEN = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*\b(?=\s*\()|\b[A-Za-z_]+\b)/g

function commentAt(line: string, lang: string): number {
  const marker = HASH_COMMENTS.has(lang) ? '#' : SLASH_COMMENTS.has(lang) ? '//' : null
  if (!marker) return -1
  // the first marker outside a string, at the line's start or after a space
  let quote: string | null = null
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!
    if (quote) { if (ch === '\\') i += 1; else if (ch === quote) quote = null; continue }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue }
    if (line.startsWith(marker, i) && (i === 0 || /\s/.test(line[i - 1]!))) return i
  }
  return -1
}

export function highlightLine(line: string, language = ''): Token[] {
  const lang = language.toLowerCase()
  const cut = commentAt(line, lang)
  const code = cut >= 0 ? line.slice(0, cut) : line
  const out: Token[] = []
  let last = 0
  for (const m of code.matchAll(TOKEN)) {
    const at = m.index ?? 0
    const t = m[0]
    const kind: TokenKind = /^["'`]/.test(t) ? 'string' : /^\d/.test(t) ? 'number' : KEYWORDS.has(t) ? 'keyword' : /^\s*\(/.test(code.slice(at + t.length)) ? 'call' : 'plain'
    if (kind === 'plain') continue
    if (at > last) out.push({ text: code.slice(last, at), kind: 'plain' })
    out.push({ text: t, kind })
    last = at + t.length
  }
  if (last < code.length) out.push({ text: code.slice(last), kind: 'plain' })
  if (cut >= 0) out.push({ text: line.slice(cut), kind: 'comment' })
  return out
}

/** The language a fenced block names (`language-python` → `python`), or '' when it names none. */
export function languageOf(className: unknown): string {
  const names = Array.isArray(className) ? className.map(String) : typeof className === 'string' ? className.split(/\s+/) : []
  const tag = names.find((n) => n.startsWith('language-'))
  return tag ? tag.slice('language-'.length) : ''
}

/** Where a link or an image in a director's answer points: a web address, an inline image, an image the session
 *  keeps (a picture the director's answer showed, copied by the bridge), or a file in ChatGPT's own sandbox
 *  (`sandbox:/mnt/data/…`), which lives in the ChatGPT conversation and never reaches oasis-code. */
export function linkKind(url: string): 'web' | 'inline' | 'attachment' | 'sandbox' | 'other' {
  if (/^https?:\/\//i.test(url)) return 'web'
  if (/^\/api\/sessions\/[\w-]+\/attachments\/[\w-]+$/.test(url)) return 'attachment'
  if (/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(url)) return 'inline'
  if (/^sandbox:/i.test(url)) return 'sandbox'
  return 'other'
}

/** What a link in the words may do when clicked: open a web page or a mail message outside the app, or nothing — an
 *  address the renderer refused (it arrives empty), a relative path, an anchor, any other scheme is shown as text,
 *  never followed inside the app (following it would reload the page and lose what is being typed). */
export function linkTarget(href: string | undefined | null): 'web' | 'mail' | 'inert' {
  const url = (href ?? '').trim()
  if (/^https?:\/\/[^\s]+$/i.test(url)) return 'web'
  if (/^mailto:[^\s]+$/i.test(url)) return 'mail'
  return 'inert'
}

export function fileNameOf(url: string): string {
  const path = url.replace(/^sandbox:/i, '').split(/[?#]/)[0] ?? ''
  return path.split('/').filter(Boolean).pop() ?? path
}

/** ChatGPT's citation markers left in an answer (`\ue200cite\ue202turn945630view0\ue201`: private-use characters the
 *  ChatGPT page draws as its sources): an answer the bridge brought back before it made them links (2026-09-29) shows
 *  without them rather than as the private characters they are; the words around them stand. Its mention of an app
 *  (`[$github](app://connector_…)`, as a message to it names one) is the app's name: its dollar never opens math. */
export function withoutChatGptMarkers(text: string): string {
  const named = text.includes('](app://') ? text.replace(/\[\$([^\]\n]+)\]\(app:\/\/[^)\s]*\)/g, '$1') : text
  return named.includes('\ue200') ? named.replace(/ ?\ue200[^\ue201]*(\ue201|$)/g, '') : named
}
