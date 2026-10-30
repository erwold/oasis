/** The host's look, as bounded data for the isolated HTML preview (state/uiSandbox.ts): the host page's resolved design
 *  tokens and body typography, read here, checked here, and carried into the opaque frame as JSON — never the host's
 *  stylesheet text, DOM, URLs or anything else of the page. Inside the frame the values only ever reach the CSSOM
 *  (`CSSStyleDeclaration.setProperty` on one zero-specificity `:where(:root)` rule), never a stylesheet's text, so a
 *  value cannot close a rule or an element; on top of that each value is held to a strict grammar for its kind and,
 *  where the engine has one, to the browser's own property parser (`CSS.supports`). What the frame gets:
 *
 *  - the host's 42 custom properties under their own names (`--page` … `--font-mono`: every colour, shadow, radius and
 *    font stack), already resolved — a token that refers to another (`--shadow-card: 0 0 0 1px var(--line)`) arrives
 *    with the reference substituted, and one that still holds a `var()` is dropped (the stylesheet's fallback stands);
 *  - the body's typography as `--ui-font-family`, `--ui-font-size`, `--ui-line-height` (unitless) and
 *    `--ui-letter-spacing` (em), and the host's `color-scheme` (so native controls, scrollbars and system colours
 *    follow the host's light or dark).
 *
 *  UI_BASE_STYLE is the frame's own stylesheet for plain semantic HTML (text, headings, code, tables, buttons, fields,
 *  checkboxes, ranges, progress, focus, selection, scrollbars): every selector is wrapped in `:where()` (specificity
 *  0), so any rule of the generated document overrides it, and every token has a fallback so the frame reads well with
 *  no theme at all. It declares no @font-face and loads nothing: the font stacks name fonts the system already has
 *  (the frame's CSP keeps `font-src 'none'`). */

/** The token allowlist: name → kind. The host's whole :root palette (frontend/src/index.css) — no more. */
export const UI_THEME_TOKENS = {
  '--page': 'color', '--canvas': 'color', '--surface': 'color', '--inset': 'color', '--hover': 'color', '--hover-2': 'color',
  '--field': 'color', '--ink': 'color', '--ink-2': 'color', '--ink-3': 'color', '--line': 'color', '--line-strong': 'color',
  '--line-soft': 'color', '--accent': 'color', '--accent-ink': 'color', '--accent-tint': 'color', '--green': 'color',
  '--green-tint': 'color', '--orange': 'color', '--orange-tint': 'color', '--red': 'color', '--red-tint': 'color',
  '--warning-foreground': 'color', '--success-foreground': 'color',
  '--shadow-xs': 'shadow', '--shadow-sm': 'shadow', '--shadow-md': 'shadow', '--shadow-lg': 'shadow', '--shadow-hairline': 'shadow',
  '--shadow-btn': 'shadow', '--shadow-card': 'shadow', '--shadow-raised': 'shadow', '--shadow-overlay': 'shadow',
  '--shadow-inset-field': 'shadow',
  '--radius': 'radius', '--radius-md': 'radius', '--radius-sm': 'radius', '--radius-chip': 'radius', '--radius-pill': 'radius',
  '--font-body': 'font', '--font-heading': 'font', '--font-mono': 'font',
} as const satisfies Record<string, UiThemeKind>

export type UiThemeKind = 'color' | 'shadow' | 'radius' | 'font' | 'size' | 'lineHeight' | 'letterSpacing'
export type UiThemeToken = keyof typeof UI_THEME_TOKENS
export type UiThemeScheme = 'light' | 'dark' | 'light dark'
export type UiThemeTypography = { family?: string; size?: string; lineHeight?: string; letterSpacing?: string }

/** What the host hands the frame. Always these three keys; a token or a typography field that is missing (unread, or
 *  refused by the checks) is simply absent, and the frame's stylesheet falls back for it. */
export type UiHostTheme = {
  scheme: UiThemeScheme
  tokens: Partial<Record<UiThemeToken, string>>
  typography: UiThemeTypography
}

/** typography field → the custom property the frame sets, and the field's kind */
export const UI_THEME_TYPOGRAPHY = {
  family: ['--ui-font-family', 'font'],
  size: ['--ui-font-size', 'size'],
  lineHeight: ['--ui-line-height', 'lineHeight'],
  letterSpacing: ['--ui-letter-spacing', 'letterSpacing'],
} as const satisfies Record<keyof UiThemeTypography, readonly [string, UiThemeKind]>

export const UI_THEME_SCHEMES: readonly UiThemeScheme[] = ['light', 'dark', 'light dark']

/** The longest value of each kind, UTF-16 code units (the host's longest, --shadow-lg, is about 230). */
export const UI_THEME_MAX_CHARS: Record<UiThemeKind, number> = {
  color: 64, shadow: 512, radius: 16, font: 320, size: 12, lineHeight: 12, letterSpacing: 16,
}

/** Every character any kind may hold: no `;` `{` `}` `<` `>` `\` `:` `!` `@` `*`, no control characters. The frame
 *  checks this again (with UI_THEME_FORBIDDEN) before it sets anything. */
export const UI_THEME_CHARS = /^[A-Za-z0-9 .,%#()/+"'-]*$/
/** Functions that would fetch, read the environment or defer resolution; refused even where the charset lets them by. */
export const UI_THEME_FORBIDDEN = /(?:url|var|env|attr|image|image-set|cross-fade|element|paint|src|expression)\s*\(|@import/i

const TOKEN_NAMES = Object.keys(UI_THEME_TOKENS) as UiThemeToken[]
const TYPOGRAPHY_KEYS = Object.keys(UI_THEME_TYPOGRAPHY) as Array<keyof UiThemeTypography>
const CSS_WIDE = new Set(['inherit', 'initial', 'unset', 'revert', 'revert-layer', 'default'])
const NUM = '[+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)'
const COLOR_ARG = new RegExp(`^(?:${NUM}(?:%|deg|rad|grad|turn)?|none)$`, 'i')
const LENGTH = new RegExp(`^(${NUM})(px|em|rem)?$`, 'i')
const COLOR_FN = /^(rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(([^()]*)\)$/i
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const NAMED_COLORS = new Set([
  'transparent', 'currentcolor', 'black', 'white', 'canvas', 'canvastext', 'linktext', 'visitedtext', 'activetext',
  'buttonface', 'buttontext', 'buttonborder', 'field', 'fieldtext', 'highlight', 'highlighttext', 'selecteditem',
  'selecteditemtext', 'mark', 'marktext', 'graytext', 'accentcolor', 'accentcolortext',
  // the CSS 2 keywords
  'red', 'maroon', 'orange', 'yellow', 'olive', 'lime', 'green', 'aqua', 'teal', 'blue', 'navy', 'fuchsia', 'purple', 'silver', 'gray', 'grey',
])
const FAMILY_QUOTED = /^(["'])[A-Za-z0-9 -]{1,64}\1$/
const FAMILY_IDENT = /^-?[A-Za-z][A-Za-z0-9-]*(?: -?[A-Za-z][A-Za-z0-9-]*)*$/

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return (proto === Object.prototype || proto === null) && Object.getOwnPropertySymbols(v).length === 0
}

/** Split at top-level separators (not inside parentheses or quotes); null for unbalanced input. */
function splitTop(s: string, sep: ',' | ' '): string[] | null {
  const out: string[] = []
  let depth = 0
  let quote = ''
  let cur = ''
  for (const ch of s) {
    if (quote) { if (ch === quote) quote = ''; cur += ch; continue }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue }
    if (ch === '(') depth++
    else if (ch === ')') { if (--depth < 0) return null }
    if (ch === sep && depth === 0) { out.push(cur.trim()); cur = ''; continue }
    cur += ch
  }
  if (depth !== 0 || quote) return null
  out.push(cur.trim())
  return sep === ' ' ? out.filter((p) => p !== '') : out
}

function lengthOk(v: string, opts: { percent?: boolean; min?: number; max: number }): boolean {
  if (opts.percent && /%$/.test(v)) {
    const n = Number(v.slice(0, -1))
    return new RegExp(`^${NUM}$`).test(v.slice(0, -1)) && n >= (opts.min ?? -opts.max) && n <= 100
  }
  const m = LENGTH.exec(v)
  if (!m) return false
  const n = Number(m[1])
  if (!m[2] && n !== 0) return false        // a unitless length must be 0
  return Number.isFinite(n) && n >= (opts.min ?? -opts.max) && n <= opts.max
}

function colorOk(v: string): boolean {
  if (HEX.test(v)) return true
  if (NAMED_COLORS.has(v.toLowerCase())) return true
  const m = COLOR_FN.exec(v)
  if (!m) return false
  const body = m[2]!.trim()
  if ((body.match(/\//g) ?? []).length > 1) return false
  const args = body.split(/\s*[\s,/]\s*/).filter((a) => a !== '')
  return args.length >= 3 && args.length <= 4 && args.every((a) => COLOR_ARG.test(a))
}

function shadowOk(v: string): boolean {
  if (v.toLowerCase() === 'none') return true
  const layers = splitTop(v, ',')
  if (!layers || layers.length > 8) return false
  return layers.every((layer) => {
    const parts = splitTop(layer, ' ')
    if (!parts || parts.length === 0) return false
    let inset = 0
    let colors = 0
    const lengths: string[] = []
    for (const p of parts) {
      if (p.toLowerCase() === 'inset') inset++
      else if (lengthOk(p, { max: 1000 })) lengths.push(p)
      else if (colorOk(p)) colors++
      else return false
    }
    if (inset > 1 || colors > 1 || lengths.length < 2 || lengths.length > 4) return false
    return lengths.length < 3 || !lengths[2]!.startsWith('-')     // blur is never negative
  })
}

function fontOk(v: string): boolean {
  const families = splitTop(v, ',')
  if (!families || families.length > 16) return false
  return families.every((f) => FAMILY_QUOTED.test(f) || (FAMILY_IDENT.test(f) && f.length <= 64 && !CSS_WIDE.has(f.toLowerCase())))
}

const GRAMMAR: Record<UiThemeKind, (v: string) => boolean> = {
  color: colorOk,
  shadow: shadowOk,
  radius: (v) => lengthOk(v, { percent: true, min: 0, max: 9999 }),
  font: fontOk,
  size: (v) => { const m = /^(\d+(?:\.\d+)?)px$/.exec(v); return !!m && Number(m[1]) >= 8 && Number(m[1]) <= 32 },
  lineHeight: (v) => v === 'normal' || (/^\d+(?:\.\d+)?$/.test(v) && Number(v) >= 0.8 && Number(v) <= 3),
  letterSpacing: (v) => v === 'normal' || v === '0' || (new RegExp(`^${NUM}em$`).test(v) && Math.abs(Number(v.slice(0, -2))) <= 0.25),
}

/** The real property a kind is checked against with the engine's own parser, where there is one. */
const PARSE_AS: Record<UiThemeKind, string> = {
  color: 'color', shadow: 'box-shadow', radius: 'border-radius', font: 'font-family', size: 'font-size', lineHeight: 'line-height', letterSpacing: 'letter-spacing',
}

function engineParses(property: string, value: string): boolean {
  const css = (globalThis as { CSS?: { supports?: (p: string, v: string) => boolean } }).CSS
  if (!css || typeof css.supports !== 'function') return true   // no engine here (node): the grammar alone decides
  try { return css.supports(property, value) } catch { return false }
}

/** One value of one kind, whitespace collapsed — or null: not a string, too long, outside the charset, a forbidden
 *  function, not the kind's grammar, or not something the engine parses as that property. */
export function themeValue(kind: UiThemeKind, v: unknown): string | null {
  if (typeof v !== 'string' || v.length > UI_THEME_MAX_CHARS[kind] * 2) return null
  const s = v.replace(/[\t\n\r\f ]+/g, ' ').trim()
  if (s === '' || s.length > UI_THEME_MAX_CHARS[kind]) return null
  if (!UI_THEME_CHARS.test(s) || UI_THEME_FORBIDDEN.test(s)) return null
  if (!GRAMMAR[kind](s)) return null
  return engineParses(PARSE_AS[kind], s) ? s : null
}

export function emptyUiHostTheme(): UiHostTheme {
  return { scheme: 'light dark', tokens: {}, typography: {} }
}

/** Whatever arrives, as a UiHostTheme: the three keys exactly (anything else at the top — an unknown key, a symbol,
 *  a non-plain object — and the whole is refused: the empty theme), each token and typography field kept only if it is
 *  on the allowlist and passes themeValue, in allowlist order (so two normalized themes compare as JSON). An unknown
 *  or prototype-named key inside is dropped, never copied. */
export function normalizeUiHostTheme(input: unknown): UiHostTheme {
  const out = emptyUiHostTheme()
  if (!isPlainObject(input)) return out
  const top = Object.keys(input)
  if (top.length > 3 || !top.every((k) => k === 'scheme' || k === 'tokens' || k === 'typography')) return out
  if (typeof input.scheme === 'string' && (UI_THEME_SCHEMES as readonly string[]).includes(input.scheme)) out.scheme = input.scheme as UiThemeScheme
  const tokens = input.tokens
  if (isPlainObject(tokens) && Object.keys(tokens).length <= TOKEN_NAMES.length * 2) {
    for (const name of TOKEN_NAMES) {
      if (!Object.hasOwn(tokens, name)) continue
      const v = themeValue(UI_THEME_TOKENS[name], tokens[name])
      if (v !== null) out.tokens[name] = v
    }
  }
  const typo = input.typography
  if (isPlainObject(typo) && Object.keys(typo).length <= TYPOGRAPHY_KEYS.length * 2) {
    for (const key of TYPOGRAPHY_KEYS) {
      if (!Object.hasOwn(typo, key)) continue
      const v = themeValue(UI_THEME_TYPOGRAPHY[key][1], typo[key])
      if (v !== null) out.typography[key] = v
    }
  }
  return out
}

/** What the frame does with a theme, as [property, value-or-null] pairs: null removes the property (the stylesheet's
 *  fallback then stands). The frame's bootstrap does exactly this, after checking the theme again. */
export function uiThemeDeclarations(theme: UiHostTheme): Array<[string, string | null]> {
  const t = normalizeUiHostTheme(theme)
  const out: Array<[string, string | null]> = TOKEN_NAMES.map((n) => [n, t.tokens[n] ?? null])
  for (const key of TYPOGRAPHY_KEYS) out.push([UI_THEME_TYPOGRAPHY[key][0], t.typography[key] ?? null])
  out.push(['color-scheme', t.scheme])
  return out
}

function round(n: number): string {
  const r = Math.round(n * 1e4) / 1e4
  return String(Object.is(r, -0) ? 0 : r)
}

function px(v: string): number | null {
  const m = /^(-?\d+(?:\.\d+)?)px$/.exec(v.trim())
  return m ? Number(m[1]) : null
}

/** Substitute var(--allowed) references by the already read value of that token (a browser that does not resolve
 *  custom properties at computed time); a reference to anything else, or one still unresolved, stays and is refused. */
function resolveRefs(raw: Record<string, string>): void {
  const ref = /var\(\s*(--[a-z0-9-]+)\s*(?:,[^()]*)?\)/g
  for (let pass = 0; pass < 3; pass++) {
    let changed = false
    for (const name of TOKEN_NAMES) {
      const v = raw[name]
      if (!v || !v.includes('var(')) continue
      const next = v.replace(ref, (all, n: string) => {
        const sub = raw[n]
        return sub && Object.hasOwn(UI_THEME_TOKENS, n) && !sub.includes('var(') ? sub : all
      })
      if (next !== v) { raw[name] = next; changed = true }
    }
    if (!changed) break
  }
}

function schemeOf(computed: string, prefersDark: boolean | null): UiThemeScheme {
  const words = computed.toLowerCase().split(/\s+/)
  const light = words.includes('light')
  const dark = words.includes('dark')
  if (dark && !light) return 'dark'
  if (light && !dark) return 'light'
  return prefersDark === null ? 'light dark' : prefersDark ? 'dark' : 'light'
}

/** The host page's theme now: the computed (resolved) values of the allowlisted tokens on the body (which inherits
 *  the root's tokens; a class or style on the body may set its own), the body's font stack, size, line height (as a ratio of the size) and letter spacing (in em), and the root's color-scheme — then
 *  normalizeUiHostTheme. Reads computed style only; no stylesheet text, attribute, URL or other DOM content.
 *  `scope`: read the tokens and the typography where content of that class would stand instead — an empty, hidden
 *  element of the class, put in the body for the read and taken out at once (`uis`: an intelligent-UI surface, whose
 *  scope re-points the face, radii, shadows and accent; index.css). The allowlist, the scheme and the shape are the
 *  same either way. */
export function readUiHostTheme(doc: Document = document, opts: { scope?: string } = {}): UiHostTheme {
  const view = doc.defaultView
  if (!view || !doc.documentElement) return emptyUiHostTheme()
  let probe: HTMLElement | null = null
  if (opts.scope && doc.body && typeof doc.createElement === 'function') {
    probe = doc.createElement('div')
    probe.className = opts.scope
    probe.hidden = true
    probe.style.display = 'none'
    probe.setAttribute('aria-hidden', 'true')
    doc.body.appendChild(probe)
  }
  try { return readThemeAt(doc, view, probe) } finally { probe?.remove() }
}

function readThemeAt(doc: Document, view: Window, probe: HTMLElement | null): UiHostTheme {
  const rootStyle = view.getComputedStyle(doc.documentElement)
  const bodyStyle = view.getComputedStyle(probe ?? doc.body ?? doc.documentElement)
  const raw: Record<string, string> = {}
  // the tokens as the page's content sees them: the body's (it inherits the root's, and a class or style on the body
  // — which the observer watches — may set its own)
  for (const name of TOKEN_NAMES) raw[name] = bodyStyle.getPropertyValue(name).replace(/\s+/g, ' ').trim()
  resolveRefs(raw)
  const typography: Record<string, string> = {}
  typography.family = bodyStyle.fontFamily
  const size = px(bodyStyle.fontSize)
  if (size !== null && size > 0) {
    typography.size = `${round(size)}px`
    const lh = bodyStyle.lineHeight.trim()
    const lhPx = px(lh)
    typography.lineHeight = lh === 'normal' ? 'normal' : lhPx !== null ? round(lhPx / size) : lh
    const ls = bodyStyle.letterSpacing.trim()
    const lsPx = px(ls)
    typography.letterSpacing = ls === 'normal' ? 'normal' : lsPx !== null ? (lsPx === 0 ? '0' : `${round(lsPx / size)}em`) : ls
  }
  let prefersDark: boolean | null = null
  try { prefersDark = typeof view.matchMedia === 'function' ? view.matchMedia('(prefers-color-scheme: dark)').matches : null } catch { prefersDark = null }
  return normalizeUiHostTheme({ scheme: schemeOf(rootStyle.colorScheme ?? '', prefersDark), tokens: raw, typography })
}

/** The frame's side, as a script fragment for the bootstrap (state/uiSandbox.ts): it creates one <style> after the
 *  base stylesheet with a single empty `:where(:root){}` rule, keeps that rule's declaration and the CSSOM methods
 *  it needs from before the generated code runs, and defines `THEME(theme)`: the three keys exactly, a known scheme,
 *  every token and typography key on the allowlist, every value a string within its kind's bound, inside the charset
 *  and free of forbidden functions — all checked before anything is applied (a theme is taken whole or not at all);
 *  then each property is set or removed through setProperty / removeProperty. Returns whether it applied.
 *  It runs inside the bootstrap's message listener, so it must not run any of the generated code synchronously (that
 *  code could read `window.event` and with it the nonce): only functions captured before that code ran (Reflect.apply,
 *  Object.keys, hasOwnProperty, Array indexOf, RegExp exec, the CSSOM methods), reads of own properties of the
 *  structured-cloned message, and array literals (defined, never assigned, so no prototype setter runs). */
export function themeFrameScript(json: (v: unknown) => string): string {
  const tok: Record<string, string> = Object.create(null)
  for (const n of TOKEN_NAMES) tok[n] = UI_THEME_TOKENS[n]
  const typ: Record<string, readonly [string, string]> = Object.create(null)
  for (const k of TYPOGRAPHY_KEYS) typ[k] = UI_THEME_TYPOGRAPHY[k]
  return `var THEME=(function(){var TOK=${json(tok)},TYP=${json(typ)},SCH=${json(UI_THEME_SCHEMES)},MAX=${json(UI_THEME_MAX_CHARS)},
CHARS=new RegExp(${json(UI_THEME_CHARS.source)}),BAD=new RegExp(${json(UI_THEME_FORBIDDEN.source)},"i"),
ks=Object.keys,arr=Array.isArray,ap=Reflect.apply,rx=RegExp.prototype.exec,own=Object.prototype.hasOwnProperty,idx=Array.prototype.indexOf,decl=null,setP=null,remP=null;
try{var CSD=window.CSSStyleDeclaration.prototype;setP=CSD.setProperty;remP=CSD.removeProperty}catch(e){}
try{var el=document.createElement("style");(document.head||document.documentElement).appendChild(el);el.sheet.insertRule(":where(:root){}",0);decl=el.sheet.cssRules[0].style}catch(e){decl=null}
function obj(o){return typeof o==="object"&&o!==null&&!arr(o)}
function val(v,k){return typeof v==="string"&&v.length<=MAX[k]&&ap(rx,CHARS,[v])!==null&&ap(rx,BAD,[v])===null}
function put(p,v){try{if(v===null)ap(remP,decl,[p]);else ap(setP,decl,[p,v])}catch(e){}}
return function(t){if(!obj(t))return false;var top=ks(t);if(top.length!==3||!obj(t.tokens)||!obj(t.typography)||ap(idx,SCH,[t.scheme])<0)return false;
for(var i=0;i<3;i++)if(top[i]!=="scheme"&&top[i]!=="tokens"&&top[i]!=="typography")return false;
var a=ks(t.tokens),b=ks(t.typography),j;
for(j=0;j<a.length;j++)if(!ap(own,TOK,[a[j]])||!val(t.tokens[a[j]],TOK[a[j]]))return false;
for(j=0;j<b.length;j++)if(!ap(own,TYP,[b[j]])||!val(t.typography[b[j]],TYP[b[j]][1]))return false;
if(!decl||!setP||!remP)return false;
var tn=ks(TOK),yn=ks(TYP);for(j=0;j<tn.length;j++)put(tn[j],ap(own,t.tokens,[tn[j]])?t.tokens[tn[j]]:null);
for(j=0;j<yn.length;j++)put(TYP[yn[j]][0],ap(own,t.typography,[yn[j]])?t.typography[yn[j]]:null);
put("color-scheme",t.scheme);
return true}})();`
}

/* The frame's stylesheet for plain semantic HTML. Zero specificity throughout (`:where`), so the generated document's
   own rules win; a pseudo-element cannot sit inside :where, so the few pseudo-element rules (::placeholder,
   ::selection, scrollbars) carry the lowest specificity an element selector has. Fallbacks are system colours, so it
   reads in either scheme with no theme. It sets no animation, position, display of layout containers or global
   margin reset: the generated layout is the generated document's. */
const LINE = 'var(--line,color-mix(in srgb,CanvasText 12%,transparent))'
const LINE_STRONG = 'var(--line-strong,color-mix(in srgb,CanvasText 22%,transparent))'
const INSET = 'var(--inset,color-mix(in srgb,CanvasText 4%,Canvas))'
const FOCUS_RING = 'color-mix(in oklch,var(--accent,Highlight) 45%,transparent)'
const FIELD = 'input:not([type=checkbox],[type=radio],[type=range],[type=color],[type=file],[type=button],[type=submit],[type=reset],[type=image],[type=hidden]),select,textarea'
const BUTTON = 'button,input:is([type=button],[type=submit],[type=reset])'
const PRIMARY = 'button[type=submit],input[type=submit]'

export const UI_BASE_STYLE = [
  ':where(*){box-sizing:border-box}::before,::after{box-sizing:border-box}',
  ':where(:root){color-scheme:light dark;font-family:var(--ui-font-family,var(--font-body,system-ui,-apple-system,sans-serif));font-size:var(--ui-font-size,13.5px);'
    + 'line-height:var(--ui-line-height,1.5);letter-spacing:var(--ui-letter-spacing,-0.01em);color:var(--ink,CanvasText);accent-color:var(--accent,AccentColor);'
    + '-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;text-size-adjust:100%;overflow-wrap:break-word}',
  ':where(body){margin:12px;min-width:0}',
  ':where(h1,h2,h3,h4,h5,h6){font-family:var(--font-heading,inherit);font-weight:600;line-height:1.25;letter-spacing:-0.015em;margin:1.2em 0 .45em}',
  ':where(h1){font-size:1.6em}:where(h2){font-size:1.3em}:where(h3){font-size:1.12em}:where(h4){font-size:1em}:where(h5,h6){font-size:.92em;color:var(--ink-2,inherit)}',
  ':where(p,ul,ol,dl,blockquote,pre,table,figure,fieldset,details){margin:0 0 .8em}',
  ':where(h1,h2,h3,h4,h5,h6):where(:first-child){margin-top:0}',
  ':where(p,ul,ol,dl,blockquote,pre,table,figure,fieldset,details):where(:last-child){margin-bottom:0}',
  ':where(ul,ol){padding-inline-start:1.4em}:where(li+li){margin-top:.2em}:where(dt){font-weight:600}:where(dd){margin:0 0 .4em 1.2em}',
  ':where(a){color:var(--accent-ink,LinkText);text-decoration:none}:where(a:hover){text-decoration:underline;text-underline-offset:2px}',
  ':where(small,figcaption,caption){color:var(--ink-2,inherit);font-size:.92em}:where(strong,b,th){font-weight:600}',
  `:where(hr){border:0;border-top:1px solid ${LINE};margin:1em 0}`,
  ':where(mark){background:var(--orange-tint,Mark);color:inherit;border-radius:3px;padding:0 .15em}',
  ':where(code,kbd,samp,pre){font-family:var(--font-mono,ui-monospace,monospace);font-size:.92em;letter-spacing:0}',
  `:where(code,kbd,samp){background:${INSET};box-shadow:0 0 0 1px ${LINE};border-radius:var(--radius-chip,6px);padding:.08em .36em}`,
  `:where(pre){background:${INSET};box-shadow:0 0 0 1px ${LINE};border-radius:var(--radius-sm,8px);padding:10px 12px;overflow:auto;max-width:100%;line-height:1.6}`,
  ':where(pre code,pre kbd,pre samp){background:none;box-shadow:none;padding:0;font-size:inherit}',
  `:where(blockquote){margin-inline:0;padding-inline-start:12px;border-inline-start:2px solid ${LINE_STRONG};color:var(--ink-2,inherit)}`,
  ':where(img,video){max-width:100%;height:auto}:where(svg,canvas){max-width:100%}',
  ':where(table){border-collapse:collapse;border-spacing:0;max-width:100%;font-variant-numeric:tabular-nums}',
  `:where(th,td){padding:6px 10px;text-align:start;vertical-align:top;border-bottom:1px solid ${LINE}}`,
  `:where(th){color:var(--ink-2,inherit);font-size:.92em;border-bottom-color:${LINE_STRONG}}:where(caption){text-align:start;padding-bottom:6px}`,
  ':where(button,input,select,textarea,optgroup){font:inherit;letter-spacing:inherit;color:inherit;margin:0}',
  // the host's own action button (index.css .thread-btn / .btn, and a native surface's ActionButton): a 26 px pill,
  // 0 10px, 12 px at weight 500, the surface colour with the button shadow; type=submit is the host's .primary
  `:where(${BUTTON}){appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:6px;background:var(--surface,ButtonFace);color:var(--ink,ButtonText);`
    + `border:0;border-radius:var(--radius-pill,999px);box-shadow:var(--shadow-btn,0 0 0 1px ${LINE_STRONG});height:26px;padding:0 10px;font-size:12px;font-weight:500;`
    + 'white-space:nowrap;cursor:pointer;transition:background-color .12s ease,opacity .12s ease}',
  `:where(${BUTTON}):where(:hover:not(:disabled)){background:var(--inset,color-mix(in srgb,CanvasText 5%,Canvas))}`,
  `:where(${PRIMARY}){background:var(--accent,AccentColor);color:#fff;box-shadow:inset 0 1px 0 #ffffff2e}`,
  `:where(${PRIMARY}):where(:hover:not(:disabled)){background:var(--accent-ink,color-mix(in oklch,var(--accent,AccentColor) 88%,black))}`,
  `:where(${BUTTON}):where(:disabled){opacity:.45;cursor:not-allowed}`,
  `:where(${FIELD}){background:var(--surface,Field);color:var(--ink,FieldText);border:0;border-radius:var(--radius-sm,8px);`
    + `box-shadow:var(--shadow-inset-field,none),0 0 0 1px ${LINE_STRONG};padding:5px 8px;min-height:30px;max-width:100%}`,
  ':where(textarea){resize:vertical;line-height:inherit}:where(select){cursor:pointer}',
  `:where(:focus-visible){outline:2px solid ${FOCUS_RING};outline-offset:1px}`,
  `:where(${FIELD}):where(:focus){outline:none;box-shadow:var(--shadow-inset-field,none),0 0 0 1px var(--accent,Highlight),0 0 0 3px ${FOCUS_RING}}`,
  `:where(${FIELD}):where(:disabled){opacity:.55;cursor:not-allowed}`,
  ':where(input:is([type=checkbox],[type=radio])){width:15px;height:15px;margin:0 .4em 0 0;vertical-align:-2px;cursor:pointer}',
  ':where(input[type=range]){cursor:pointer;vertical-align:middle;max-width:100%}:where(input[type=color]){cursor:pointer}',
  ':where(input:is([type=checkbox],[type=radio],[type=range],[type=color],[type=file])):where(:disabled){opacity:.5;cursor:not-allowed}',
  ':where(progress,meter){vertical-align:middle;max-width:100%}',
  `:where(fieldset){border:0;box-shadow:0 0 0 1px ${LINE};border-radius:var(--radius-md,10px);padding:10px 12px;margin-inline:0;min-width:0}`,
  ':where(legend){padding:0 4px;color:var(--ink-2,inherit);font-weight:600;font-size:.92em}:where(summary){cursor:pointer;font-weight:500}',
  '::placeholder{color:var(--ink-3,GrayText);opacity:1}',
  '::selection{background:var(--accent-tint,Highlight);color:var(--ink,HighlightText)}',
  `::-webkit-scrollbar{width:8px;height:8px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:${LINE_STRONG};border-radius:4px}`,
].join('\n')
