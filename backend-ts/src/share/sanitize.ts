/** The one sanitizer every string of a share snapshot passes through (contract/src/share.ts). Order matters:
 *
 *  1. NFC, then invisible / format characters removed (zero-width spaces, BOM, soft hyphen, bidi controls, stray tag
 *     and variation-selector "smuggling" characters) — the legitimate joiners of emoji sequences, of scripts that need
 *     ZWJ/ZWNJ between letters, and of subdivision flags are kept. Every later rule sees the cleaned text, and the
 *     cleaned text is what is exported, so a key name or a secret split by an invisible character is caught.
 *  2. The app's own session token, exactly (any non-empty token; held in memory here, never written anywhere).
 *  3. Private key blocks; Authorization / cookie / API-key headers and bearer-like schemes; credentials in URLs;
 *     known token shapes; credential-like assignments and CLI flags.
 *  4. Paths: the session's folders become project-relative, the app's data folder `<app-data>`, a home folder `~` —
 *     each under every spelling of it (path_alias.ts: macOS's /tmp, /var, /etc and their /private real paths);
 *     the account name as a word; email addresses.
 *
 *  This is defense in depth for prose, not a classifier: a secret in an unknown shape, encoded (base64, hex,
 *  homoglyphs, fullwidth letters) or inside an image is not promised to be found. Credential / configuration /
 *  environment OBJECTS are never handed to it — they are never part of a snapshot at all. */

import type { ShareStats } from '@oasis-code/contract'
import { withAliases } from './path_alias.ts'

export type RedactionKey = keyof ShareStats['redacted']

export interface SanitizerContext {
  /** the app's session token, in memory only ('' when none: nothing is matched) */
  token: string
  /** folders whose paths become project-relative (the session's workspaces, the project's folder) */
  project_dirs: string[]
  /** folders shown as `<app-data>` (the app's data directory) */
  data_dirs: string[]
  /** the account's home folders (shown as `~`), besides the generic /Users/<name>, /home/<name>, C:\Users\<name> */
  home_dirs: string[]
  /** the account's name, masked as a word when it is distinctive enough (null: none known) */
  username: string | null
}

export const REDACTED = '[redacted]'

const COMMON_NAMES = new Set(['admin', 'user', 'users', 'test', 'root', 'guest', 'ubuntu', 'runner', 'build', 'docker', 'node', 'home', 'work', 'code',
  'mac', 'dev', 'developer', 'default', 'owner', 'staff', 'local', 'app', 'apps', 'data', 'shared', 'public', 'oasis'])

const ZWJ = 0x200d
const ZWNJ = 0x200c
const BLACK_FLAG = 0x1f3f4
const CANCEL_TAG = 0xe007f

const isPictographic = (cp: number | undefined): boolean => cp !== undefined && /\p{Extended_Pictographic}/u.test(String.fromCodePoint(cp))
const isEmojiTail = (cp: number | undefined): boolean => cp !== undefined && (cp === 0xfe0f || (cp >= 0x1f3fb && cp <= 0x1f3ff) || isPictographic(cp))
const isScriptLetter = (cp: number | undefined): boolean => cp !== undefined && cp > 0x7f && /[\p{L}\p{M}]/u.test(String.fromCodePoint(cp))
const isHan = (cp: number | undefined): boolean => cp !== undefined && /\p{Script=Han}/u.test(String.fromCodePoint(cp))
/** invisible characters outside \p{Cf} that hide text as well */
const INVISIBLE_OTHER = new Set([0x034f, 0x115f, 0x1160, 0x3164, 0xffa0, 0x17b4, 0x17b5])

/** The text without invisible / format characters, the legitimate joiners kept; and how many were removed. */
export function stripInvisible(input: string): { text: string; removed: number } {
  const cps = Array.from(input.normalize('NFC'), (c) => c.codePointAt(0)!)
  const out: number[] = []
  let removed = 0
  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i]!
    const prev = out[out.length - 1]
    const next = cps[i + 1]
    // a subdivision flag: black flag, tag letters, cancel tag — kept whole
    if (cp === BLACK_FLAG) {
      let j = i + 1
      while (j < cps.length && cps[j]! >= 0xe0020 && cps[j]! <= 0xe007e) j++
      if (j > i + 1 && cps[j] === CANCEL_TAG) { for (let k = i; k <= j; k++) out.push(cps[k]!); i = j; continue }
      out.push(cp)
      continue
    }
    if (cp === ZWJ && ((isEmojiTail(prev) && isPictographic(next)) || (isScriptLetter(prev) && isScriptLetter(next)))) { out.push(cp); continue }
    if (cp === ZWNJ && isScriptLetter(prev) && isScriptLetter(next)) { out.push(cp); continue }
    // ideographic variation sequences are kept after a Han character; anywhere else they hide data
    if (cp >= 0xe0100 && cp <= 0xe01ef) { if (isHan(prev)) out.push(cp); else removed++; continue }
    // VS1–VS16: kept after an emoji or a symbol / CJK character (standardized and emoji presentation sequences) and in a
    // keycap (digit, #, * then U+20E3); after an ASCII or Latin letter, digit or punctuation they only hide data
    if (cp >= 0xfe00 && cp <= 0xfe0f) {
      const keycap = prev !== undefined && /^[0-9#*]$/.test(String.fromCodePoint(prev)) && next === 0x20e3
      if (keycap || isPictographic(prev) || (prev !== undefined && prev >= 0x2000 && !/\p{Script=Latin}/u.test(String.fromCodePoint(prev)))) out.push(cp)
      else removed++
      continue
    }
    if (INVISIBLE_OTHER.has(cp) || /\p{Cf}/u.test(String.fromCodePoint(cp))) { removed++; continue }
    out.push(cp)
  }
  return { text: removed ? fromCodePoints(out) : input.normalize('NFC'), removed }
}

/** String.fromCodePoint takes its arguments on the stack: a long text is joined in chunks. */
function fromCodePoints(cps: number[]): string {
  let s = ''
  for (let i = 0; i < cps.length; i += 8192) s += String.fromCodePoint(...cps.slice(i, i + 8192))
  return s
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// ---- the rules --------------------------------------------------------------------------------------------------------

const PRIVATE_KEY = /-----BEGIN[ A-Z0-9]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END[ A-Z0-9]*PRIVATE KEY(?: BLOCK)?-----|$)/g
const PUTTY_KEY = /PuTTY-User-Key-File-\d+:[\s\S]*?(?:Private-MAC:[^\r\n]*|$)/g

const HEADER_NAMES = '(?:proxy-)?authorization|x-api-key|api-key|x-auth-token|x-access-token|x-goog-api-key|x-oasis-code-token|x-amz-security-token|private-token|x-csrf-token'
const HEADER = new RegExp(`(["']?)\\b(${HEADER_NAMES})\\1(\\s*[:=]\\s*)(["']?)([^\\r\\n"']+)`, 'gi')
const COOKIE = /\b((?:set-)?cookie)(["']?\s*:\s*["']?)([^=\s;"']+=[^\r\n"']*)/gi
// an auth scheme is context enough: any non-empty credential after it is masked
const SCHEME = /\b(Bearer|Basic|Digest)(\s+)(?!\[redacted)[A-Za-z0-9._~+/=:-]+/gi

const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@:"'<>]+):([^\s/@"'<>]+)@/gi
const URL_TOKEN_USER = /\b(https?:\/\/)([A-Za-z0-9._~-]{12,})@/gi
const QUERY_SECRET = /([?&#;](?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|auth|api[_-]?key|apikey|key|secret|client[_-]?secret|password|passwd|pwd|sig|signature|code|session|session[_-]?id|sid|x-amz-signature|x-amz-credential|x-amz-security-token|x-goog-signature|x-goog-credential)=)([^&#\s"'<>)\]]+)/gi

const SECRET_SHAPES: RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  /\b(?:sk|rk|pk)-(?:proj-|live-|test-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /\bwhsec_[A-Za-z0-9]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\bhttps:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g,
  /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[A-Z0-9]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bya29\.[0-9A-Za-z_-]{20,}/g,
  /\b1\/\/0[0-9A-Za-z_-]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\bpypi-AgE[A-Za-z0-9_-]{50,}/g,
  /\bhf_[A-Za-z0-9]{30,}/g,
  /\bdop_v1_[a-f0-9]{64}\b/g,
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
  /\bshp(?:at|ss|ca|pa)_[a-fA-F0-9]{32}\b/g,
]

const SECRET_KEY_WORDS = 'api[_.-]?key|apikey|secret(?:[_.-]?key)?|client[_.-]?secret|passw(?:or)?d|passphrase|pwd|access[_.-]?token|refresh[_.-]?token|id[_.-]?token'
  + '|auth[_.-]?token|bearer[_.-]?token|session[_.-]?token|token|private[_.-]?key|access[_.-]?key(?:[_.-]?id)?|secret[_.-]?access[_.-]?key|account[_.-]?key'
  + '|credentials?|cookie|session[_.-]?id|signing[_.-]?key|encryption[_.-]?key|webhook[_.-]?secret|dsn|connection[_.-]?string|conn[_.-]?str|authorization'
/** A secret-named key and its separator; the value after it is read by `secretValueEnd` (quoted: to its closing quote;
 *  after `:` unquoted: to the end of the line; after `=` unquoted: one word). */
// a candidate key is one bounded run of key characters (no nested repetition: a long run that is not followed by a
// separator costs at most 128 steps from a word start); whether it names a secret is tested separately (SECRET_KEY)
const ASSIGNMENT_KEY = /(?<![A-Za-z0-9_.-])(["'`]?)([A-Za-z0-9_.-]{1,128})\1(\s*(?::=|=>|:(?!:)|=(?![=>]))[ \t]*)/g
const SECRET_WORD_RES = SECRET_KEY_WORDS.split('|').map((w) => new RegExp(`(?:${w})$`))
const CLI_FLAG_KEY = /(--(?:password|passwd|pass|token|api-key|apikey|secret|client-secret|access-token|auth-token)(?:=|[ \t]+))/gi
/** What may follow a secret-named key without being a secret: an explicit reference to where the value comes from, a
 *  type, an empty / masked placeholder, a literal null or boolean. Nothing else (a number, a short word, a plain word). */
const REFERENCE = new RegExp('^(?:'
  + 'true|false|null|none|nil|undefined|\\*+|\\.{3}|…|\\[redacted[^\\]]*\\]?|<[^<>\\n]*>|""|\'\'|``'
  + '|\\$\\{?[A-Za-z_][A-Za-z0-9_]*\\}?|%[A-Za-z_][A-Za-z0-9_]*%|\\{\\{\\s*[\\w.]+\\s*\\}\\}'
  + '|process\\.env(?:\\.[A-Za-z_$][\\w$]*|\\[[^\\]\\n]+\\])|import\\.meta\\.env\\.[A-Za-z_$][\\w$]*|os\\.environ(?:\\.get)?[\\[(][^\\n]*|os\\.getenv\\([^\\n]*\\)'
  + '|(?:Deno\\.env\\.get|System\\.getenv|getenv|env)\\([^\\n]*\\)|ENV\\[[^\\]\\n]+\\]'
  + '|string|String|str|number|bool|boolean|bytes|SecretStr|Secret<[^>\\n]*>|Optional\\[str\\]|string \\| (?:null|undefined)'
  + ')[,;]?$')

/** True when a key names a secret: it ends with a secret word, alone or after a separator (`OPENAI_API_KEY`,
 *  `db.password`, `csrf-token`, `githubToken`); `max_tokens`, `tokenizer`, `passwordless` do not. */
export function secretKey(key: string): boolean {
  const k = key.toLowerCase()
  for (const re of SECRET_WORD_RES) {
    const m = re.exec(k)
    // at the start, after a separator, or at a camelCase hump (`githubToken`)
    if (m !== null && (m.index === 0 || /[_.-]/.test(k[m.index - 1]!) || (/[A-Z]/.test(key[m.index]!) && /[a-z0-9]/.test(key[m.index - 1]!)))) return true
  }
  return false
}

/** The end of the value that starts at `i`: a quoted value to its closing quote (escapes honoured, across lines; an
 *  unterminated one to the end of the text); after `:` a YAML block scalar (`|` / `>`) with every line indented past
 *  the key's line, any other unquoted value to the end of its line; after `=` one word. `keyIndent` is the indentation
 *  of the key's line. */
function secretValueEnd(t: string, i: number, sep: string, keyIndent: number): number {
  const q = t[i]
  // a triple-quoted literal (Python) runs to its matching triple delimiter, across lines
  if ((q === '"' || q === "'") && t.startsWith(q.repeat(3), i)) {
    const close = t.indexOf(q.repeat(3), i + 3)
    return close < 0 ? t.length : close + 3
  }
  if (q === '"' || q === "'" || q === '`') {
    for (let j = i + 1; j < t.length; j++) {
      if (t[j] === '\\') { j++; continue }
      if (t[j] === q) return j + 1
    }
    return t.length
  }
  if (sep.includes(':') && !sep.includes('=')) {
    let j = i
    while (j < t.length && t[j] !== '\n' && t[j] !== '\r') j++
    if (/^[|>][+-]?[0-9]?[+-]?\s*(?:#.*)?$/.test(t.slice(i, j))) {
      // a block scalar: the lines after it while they are blank or indented past the key's line
      let end = j
      let k = j
      while (k < t.length) {
        const lineStart = t[k] === '\r' && t[k + 1] === '\n' ? k + 2 : k + 1
        let lineEnd = lineStart
        while (lineEnd < t.length && t[lineEnd] !== '\n' && t[lineEnd] !== '\r') lineEnd++
        const line = t.slice(lineStart, lineEnd)
        const indent = line.length - line.trimStart().length
        if (line.trim() !== '' && indent <= keyIndent) break
        if (lineStart >= t.length) break
        end = lineEnd
        k = lineEnd
      }
      return end
    }
    while (j > i && /[\s,;]/.test(t[j - 1]!)) j--
    return j
  }
  // a `<placeholder with words>` is read whole (to its `>` on the same line), so REFERENCE can see it
  if (t[i] === '<') {
    const close = t.indexOf('>', i)
    const eol = t.indexOf('\n', i)
    if (close > i && (eol < 0 || close < eol)) return close + 1
  }
  // one word; a call's parentheses are kept whole (`os.getenv("X")`)
  let j = i
  let depth = 0
  while (j < t.length) {
    const ch = t[j]!
    if (ch === '\n') break
    if (ch === '(') depth++
    else if (ch === ')') { if (depth === 0) break; depth-- }
    else if (depth === 0 && /[\s,;&|}\]]/.test(ch)) break
    j++
  }
  return j
}

const FILE_TLDS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'md', 'css', 'html', 'py', 'rs', 'go', 'txt', 'lock', 'yml', 'yaml', 'toml', 'sh', 'pdf', 'zip', 'gz'])
const EMAIL = /(?<![\w.+%-])[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+([A-Za-z]{2,24}))(?![\w-])/g

const HOME_POSIX = /(?<![\w.-])\/(?:Users|home)\/(?!Shared\b)[^/\s"'`:;,)\]}<>]+/g
const HOME_WIN = /\b[A-Za-z]:\\(?:Users|Documents and Settings)\\[^\\\s"'`:;,)\]}<>]+/gi

/** One snapshot's sanitizer: the context's rules, and the counts of what it masked. */
export class ShareSanitizer {
  readonly redacted: Record<RedactionKey, number> = {
    session_token: 0, private_key: 0, auth_header: 0, credential_url: 0, secret_pattern: 0, credential_assignment: 0, path: 0, username: 0, email: 0, invisible_chars: 0,
  }
  truncated = 0
  private readonly tokenForms: string[]
  private readonly dirRules: { re: RegExp; to: string }[]
  private readonly userRe: RegExp | null

  constructor(ctx: SanitizerContext) {
    // the token itself, and the way a URL carries it; the empty string matches nothing
    // the forms are cleaned as the text is (NFC, invisible characters out), so they meet the text on the same terms
    const forms = ctx.token === '' ? [] : [ctx.token, encodeURIComponent(ctx.token)].map((f) => stripInvisible(f).text).filter((f) => f !== '')
    this.tokenForms = [...new Set(forms)].sort((a, b) => b.length - a.length)
    // longest first: a workspace inside the data folder becomes project-relative, not `<app-data>/…`
    // each known folder under every spelling of it (path_alias.ts: /private/tmp ↔ /tmp, /private/var ↔ /var, …)
    const dirs = [
      ...withAliases(ctx.project_dirs).map((d) => ({ dir: d, to: '' })), ...withAliases(ctx.data_dirs).map((d) => ({ dir: d, to: '<app-data>' })),
      ...withAliases(ctx.home_dirs).map((d) => ({ dir: d, to: '~' })),
    ].map((r) => ({ ...r, dir: r.dir.replace(/[\\/]+$/, '') })).filter((r) => r.dir.length > 1)
    dirs.sort((a, b) => b.dir.length - a.dir.length)
    this.dirRules = dirs.map(({ dir, to }) => ({
      // the folder followed by a separator, or standing alone (not a longer name that starts the same)
      re: new RegExp(`${escapeRe(dir)}(?:[\\\\/]|(?![\\w.-]))`, 'g'),
      to,
    }))
    const name = ctx.username?.trim() ?? ''
    this.userRe = name.length >= 4 && !COMMON_NAMES.has(name.toLowerCase()) && /^[\w.-]+$/.test(name) ? new RegExp(`(?<![\\w.-])${escapeRe(name)}(?![\\w-])`, 'gi') : null
  }

  private count(key: RedactionKey, n = 1): void { this.redacted[key] += n }

  private replace(text: string, re: RegExp, key: RedactionKey, fn: (...m: string[]) => string): string {
    return text.replace(re, (...args: unknown[]) => {
      // the match and its groups (an optional group that took nothing is ''), before the offset argument
      const end = args.findIndex((a) => typeof a === 'number')
      const groups = args.slice(0, end).map((a) => (typeof a === 'string' ? a : ''))
      const out = fn(...groups)
      if (out !== groups[0]) this.count(key)
      return out
    })
  }

  /** Every value after a secret-named key (or flag) masked whole — quoted with its spaces, YAML to the line's end —
   *  unless it is an explicit reference, a type or a placeholder (REFERENCE). */
  private maskValues(t: string, keyRe: RegExp): string {
    let out = ''
    let last = 0
    keyRe.lastIndex = 0
    for (let m = keyRe.exec(t); m !== null; m = keyRe.exec(t)) {
      const start = m.index + m[0].length
      const sep = m[m.length - 1] ?? m[0]
      // ASSIGNMENT_KEY names a candidate; only a secret-named key's value is read and masked
      if (keyRe === ASSIGNMENT_KEY && !secretKey(m[2] ?? '')) continue
      const lineStart = t.lastIndexOf('\n', m.index) + 1
      const keyIndent = t.slice(lineStart, m.index).length - t.slice(lineStart, m.index).trimStart().length
      const end = secretValueEnd(t, start, sep, keyIndent)
      const value = t.slice(start, end)
      if (end > start && !REFERENCE.test(value.trim())) {
        const q = /^(?:"""|''')/.test(value) ? value.slice(0, 3) : /^["'`]/.test(value) ? value[0]! : ''
        const closed = q !== '' && value.length >= q.length * 2 && value.endsWith(q)
        out += t.slice(last, start) + `${q}${REDACTED}${closed ? q : ''}`
        last = end
        this.count('credential_assignment')
      }
      keyRe.lastIndex = Math.max(end, keyRe.lastIndex)
    }
    return last === 0 ? t : out + t.slice(last)
  }

  /** The text as it may be exported (at most `max` characters; a cut says so). */
  text(input: string, max = Infinity): string {
    if (!input) return ''
    const stripped = stripInvisible(input)
    let t = stripped.text
    if (stripped.removed) this.count('invisible_chars', stripped.removed)
    for (const form of this.tokenForms) {
      const parts = t.split(form)
      if (parts.length > 1) { this.count('session_token', parts.length - 1); t = parts.join(REDACTED) }
    }
    t = this.replace(t, PRIVATE_KEY, 'private_key', () => '[redacted private key]')
    t = this.replace(t, PUTTY_KEY, 'private_key', () => '[redacted private key]')
    t = this.replace(t, HEADER, 'auth_header', (m, q, name, sep, vq, value) => (value!.trim() === '' || value!.startsWith('[redacted') ? m! : `${q}${name}${q}${sep}${vq}${REDACTED}`))
    t = this.replace(t, COOKIE, 'auth_header', (_m, name, sep) => `${name}${sep}${REDACTED}`)
    t = this.replace(t, SCHEME, 'auth_header', (_m, scheme, space) => `${scheme}${space}${REDACTED}`)
    t = this.replace(t, URL_USERINFO, 'credential_url', (_m, scheme) => `${scheme}${REDACTED}@`)
    t = this.replace(t, URL_TOKEN_USER, 'credential_url', (_m, scheme) => `${scheme}${REDACTED}@`)
    t = this.replace(t, QUERY_SECRET, 'credential_url', (m, key, value) => (value!.startsWith('[redacted') ? m! : `${key}${REDACTED}`))
    for (const re of SECRET_SHAPES) t = this.replace(t, re, 'secret_pattern', () => REDACTED)
    t = this.maskValues(t, ASSIGNMENT_KEY)
    t = this.maskValues(t, CLI_FLAG_KEY)
    for (const rule of this.dirRules) {
      t = t.replace(rule.re, (m) => {
        this.count('path')
        const sep = /[\\/]$/.test(m) ? m.slice(-1) : ''
        if (rule.to === '') return sep ? '' : '.'
        return `${rule.to}${sep}`
      })
    }
    t = this.replace(t, HOME_POSIX, 'path', () => '~')
    t = this.replace(t, HOME_WIN, 'path', () => '~')
    if (this.userRe !== null) t = this.replace(t, this.userRe, 'username', () => '[user]')
    t = this.replace(t, EMAIL, 'email', (m, _domain, tld) => (FILE_TLDS.has(tld!.toLowerCase()) ? m! : '[email]'))
    if (t.length > max) {
      this.truncated++
      t = `${t.slice(0, max)}\n…[cut: ${t.length - max} more characters]`
    }
    return t
  }

  /** A one-line label: whitespace collapsed, at most `max` characters. */
  label(input: string | null | undefined, max = 200): string {
    const t = this.text(String(input ?? '').replace(/\s+/g, ' ').trim())
    return t.length > max ? `${t.slice(0, max - 1)}…` : t
  }
}
