/** The host theme for the isolated HTML preview (state/uiTheme.ts): what is read, what is refused, how it maps onto
 *  the frame's custom properties, and the base stylesheet's shape. The frame's side of it (the bootstrap applying a
 *  theme through the CSSOM) is in ui_sandbox.test.ts; the browser itself, in the sandbox e2e. */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  emptyUiHostTheme, normalizeUiHostTheme, readUiHostTheme, themeValue, UI_BASE_STYLE, UI_THEME_TOKENS, UI_THEME_TYPOGRAPHY,
  uiThemeDeclarations, type UiHostTheme,
} from '../src/state/uiTheme.ts'

const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')
const decls = (block: string) => Object.fromEntries([...block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]))
const LIGHT = decls(/^:root \{([\s\S]*?)^\}/m.exec(css)![1]!)
const themeBlock = (name: string) => decls(new RegExp(`^:root:where\\(\\[data-theme="${name}"\\]\\) \\{([\\s\\S]*?)^\\}`, 'm').exec(css)![1]!)
const DARK = { ...LIGHT, ...themeBlock('dark') }
const CLAUDE = { ...LIGHT, ...themeBlock('claude') }

/** a host document as readUiHostTheme sees it: computed styles only (custom properties given unresolved, as an engine
 *  that does not substitute would — readUiHostTheme resolves references between allowlisted tokens itself) */
function hostDoc(vars: Record<string, string>, opts: { scheme?: string; prefersDark?: boolean | null; body?: Partial<Record<'fontFamily' | 'fontSize' | 'lineHeight' | 'letterSpacing', string>>; bodyVars?: Record<string, string> } = {}) {
  const root = {}, body = {}
  const style = (el: object) => el === root
    ? { getPropertyValue: (n: string) => vars[n] ?? '', colorScheme: opts.scheme ?? 'light', fontFamily: '', fontSize: '', lineHeight: '', letterSpacing: '' }
    // the body inherits the root's custom properties; a class or style on the body may set its own
    : { getPropertyValue: (n: string) => opts.bodyVars?.[n] ?? vars[n] ?? '', colorScheme: '', fontFamily: '"Inter Variable", -apple-system, sans-serif', fontSize: '13.5px', lineHeight: '20.25px', letterSpacing: '-0.135px', ...opts.body }
  const view = {
    getComputedStyle: style,
    matchMedia: opts.prefersDark === null ? undefined : () => ({ matches: !!opts.prefersDark }),
  }
  return { defaultView: view, documentElement: root, body } as unknown as Document
}

test("the allowlist is the host's whole :root palette, nothing more: 42 tokens + 4 typography fields + color-scheme = 47", () => {
  assert.deepEqual(Object.keys(UI_THEME_TOKENS).sort(), Object.keys(LIGHT).sort(), 'index.css :root and the allowlist agree')
  assert.equal(Object.keys(UI_THEME_TOKENS).length, 42)
  assert.equal(Object.keys(UI_THEME_TOKENS).length + Object.keys(UI_THEME_TYPOGRAPHY).length + 1, 47)
  for (const name of Object.keys(DARK)) assert.ok(Object.hasOwn(UI_THEME_TOKENS, name), `dark overrides only allowlisted ${name}`)
  for (const name of Object.keys(CLAUDE)) assert.ok(Object.hasOwn(UI_THEME_TOKENS, name), `claude overrides only allowlisted ${name}`)
})

test("the host's own light, dark and claude values all pass, references between tokens resolved, typography as ratios", () => {
  for (const [vars, scheme] of [[LIGHT, 'light'], [DARK, 'dark'], [CLAUDE, 'light']] as const) {
    const t = readUiHostTheme(hostDoc(vars, { scheme }))
    assert.equal(t.scheme, scheme)
    assert.deepEqual(Object.keys(t.tokens), Object.keys(UI_THEME_TOKENS), `${scheme}: every token kept, in allowlist order`)
    for (const v of Object.values(t.tokens)) assert.ok(!v!.includes('var('), v)
    assert.equal(t.tokens['--shadow-card'], `0 0 0 1px ${vars['--line']}, ${scheme === 'light' ? LIGHT['--shadow-sm'] : '0 1px 2px oklch(0 0 0 / 0.3)'}`)
    assert.equal(t.tokens['--font-heading'], `Outfit, ${vars['--font-body']}`)
    assert.deepEqual(t.typography, { family: '"Inter Variable", -apple-system, sans-serif', size: '13.5px', lineHeight: '1.5', letterSpacing: '-0.01em' })
  }
  // the root's color-scheme decides; when it names both (or neither), the media query does
  assert.equal(readUiHostTheme(hostDoc(LIGHT, { scheme: 'light dark', prefersDark: true })).scheme, 'dark')
  assert.equal(readUiHostTheme(hostDoc(LIGHT, { scheme: 'normal', prefersDark: false })).scheme, 'light')
  assert.equal(readUiHostTheme(hostDoc(LIGHT, { scheme: 'normal', prefersDark: null })).scheme, 'light dark')
  // normal line height and letter spacing stay keywords; a zero spacing is 0
  assert.deepEqual(readUiHostTheme(hostDoc(LIGHT, { body: { lineHeight: 'normal', letterSpacing: 'normal' } })).typography.lineHeight, 'normal')
  assert.equal(readUiHostTheme(hostDoc(LIGHT, { body: { letterSpacing: '0px' } })).typography.letterSpacing, '0')
  // a reference to a token outside the allowlist, or a cycle, is not resolved and the token is dropped (fallback stands)
  const odd = readUiHostTheme(hostDoc({ ...LIGHT, '--line': 'var(--secret)', '--ink': 'var(--ink-2)', '--ink-2': 'var(--ink)' }))
  assert.equal(odd.tokens['--line'], undefined)
  assert.equal(odd.tokens['--shadow-hairline'], undefined, 'built on an unresolved token: dropped too')
  assert.equal(odd.tokens['--ink'], undefined)
  assert.ok(odd.tokens['--accent'])
  assert.deepEqual(readUiHostTheme({ defaultView: null } as unknown as Document), emptyUiHostTheme())
})

test('a value is held to its kind: charset, forbidden functions, grammar, bounds', () => {
  const ok: Array<[Parameters<typeof themeValue>[0], string]> = [
    ['color', 'oklch(0.626 0.205 254.947)'], ['color', 'oklch(0 0 0 / 0.04)'], ['color', 'rgb(12, 34, 56)'], ['color', 'rgba(0,0,0,.5)'],
    ['color', '#1a2b3c'], ['color', '#abc'], ['color', 'transparent'], ['color', 'CanvasText'], ['color', 'hsl(210deg 40% 50%)'],
    ['shadow', 'inset 0 1px 2px oklch(0 0 0 / 0.08)'], ['shadow', '0 0 0 1px #ddd, 0 2px 6px rgba(0, 0, 0, 0.04)'], ['shadow', 'none'],
    ['radius', '14px'], ['radius', '999px'], ['radius', '50%'], ['radius', '0'], ['radius', '0.5rem'],
    ['font', 'Inter, "Inter Variable", -apple-system, "SF Pro Text", ui-sans-serif, system-ui, sans-serif'], ['font', "'JetBrains Mono', monospace"],
    ['size', '13.5px'], ['lineHeight', '1.5'], ['lineHeight', 'normal'], ['letterSpacing', '-0.01em'], ['letterSpacing', '0'],
  ]
  for (const [kind, v] of ok) assert.equal(themeValue(kind, v), v, `${kind}: ${v}`)
  assert.equal(themeValue('color', '  oklch(1\n0\t0) '), 'oklch(1 0 0)', 'whitespace collapsed')
  const refused: Array<[Parameters<typeof themeValue>[0], unknown]> = [
    ['color', 'red;}body{background:red'], ['color', '</style><script>alert(1)</script>'], ['color', 'url(https://x.test/a)'],
    ['color', 'var(--ink)'], ['color', 'env(safe-area-inset-top)'], ['color', 'attr(data-x)'], ['color', '\\72 ed'], ['color', 'expression(alert(1))'],
    ['color', 'oklch(1 2)'], ['color', 'oklch(1 2 3 4 5)'], ['color', 'oklch(1 2 3'], ['color', 'rgb(1 2 3) red'], ['color', 'color-mix(in srgb, red, blue)'],
    ['color', 'inherit'], ['color', 'notacolor'], ['color', 'red !important'], ['color', ''], ['color', 42], ['color', null], ['color', { toString: () => 'red' }],
    ['color', '#12'], ['color', 'oklch(0.5 0.1 /* x */ 200)'], ['color', 'rgb(1 2 3 / 4 / 5)'],
    ['shadow', '0 0 0 1px red, url(x)'], ['shadow', '1px'], ['shadow', '0 0 -2px red'], ['shadow', 'inset inset 0 0 red'], ['shadow', '0 0 red blue'],
    ['shadow', Array.from({ length: 9 }, () => '0 0 1px red').join(', ')], ['shadow', '0 0 0 1px red)'], ['shadow', '0 0 0 1px ' + 'x'.repeat(600)],
    ['radius', '-1px'], ['radius', '14'], ['radius', '1e3px'], ['radius', 'calc(1px + 2px)'], ['radius', '101%'],
    ['font', 'inherit'], ['font', 'Inter, inherit'], ['font', '"Inter;}"'], ['font', '"unterminated'], ['font', 'Inter,, sans-serif'],
    ['font', 'local("x")'], ['font', '"Ünïcode"'], ['font', Array.from({ length: 17 }, (_, i) => `f${i}`).map((f) => `F${f}`).join(', ')],
    ['size', '13.5'], ['size', '200px'], ['size', '1em'], ['lineHeight', '20px'], ['lineHeight', '9'], ['letterSpacing', '-0.135px'], ['letterSpacing', '2em'],
  ]
  for (const [kind, v] of refused) assert.equal(themeValue(kind, v), null, `${kind}: ${String(v).slice(0, 60)}`)
})

test('the engine\'s own parser is consulted where there is one', () => {
  const g = globalThis as { CSS?: unknown }
  const before = g.CSS
  const asked: string[] = []
  g.CSS = { supports: (p: string, v: string) => { asked.push(`${p}:${v}`); return !v.startsWith('#') } }
  try {
    assert.equal(themeValue('color', 'oklch(1 0 0)'), 'oklch(1 0 0)')
    assert.equal(themeValue('color', '#fff'), null, 'the grammar alone would take it; the engine does not')
    assert.equal(themeValue('shadow', '0 1px 2px red'), '0 1px 2px red')
    assert.deepEqual(asked, ['color:oklch(1 0 0)', 'color:#fff', 'box-shadow:0 1px 2px red'])
    g.CSS = { supports: () => { throw new Error('x') } }
    assert.equal(themeValue('color', 'red'), null)
  } finally { g.CSS = before }
})

test('normalize: exactly three keys at the top, allowlisted keys inside, nothing else copied', () => {
  const good: UiHostTheme = { scheme: 'dark', tokens: { '--ink': 'oklch(0.93 0.003 264)', '--radius': '14px' }, typography: { size: '13.5px' } }
  assert.deepEqual(normalizeUiHostTheme(good), good)
  for (const bad of [null, 'x', [], 1, new Date(), Object.assign(Object.create({ evil: 1 }), good), { ...good, extra: 1 }, { ...good, [Symbol('s')]: 1 },
    JSON.parse('{"scheme":"dark","tokens":{},"typography":{},"__proto__":{"x":1}}')])
    assert.deepEqual(normalizeUiHostTheme(bad), emptyUiHostTheme(), String(bad))
  const mixed = normalizeUiHostTheme(JSON.parse(JSON.stringify({
    scheme: 'sepia',
    tokens: { '--ink': 'red', '--evil': 'red', '--accent': 'url(x)', '--font-body': 'Inter' },
    typography: { size: '14px', weight: '900', lineHeight: 'calc(1)' },
  }).replace('"--evil"', '"__proto__"')))
  assert.deepEqual(mixed, { scheme: 'light dark', tokens: { '--ink': 'red', '--font-body': 'Inter' }, typography: { size: '14px' } })
  assert.equal(({} as Record<string, unknown>).x, undefined, 'no prototype touched')
  // the same theme, keys in another order: the same JSON (the host compares themes as JSON)
  const shuffled = { typography: { letterSpacing: '0', size: '13px' }, tokens: { '--radius': '4px', '--ink': '#000' }, scheme: 'light' }
  const ordered = { scheme: 'light', tokens: { '--ink': '#000', '--radius': '4px' }, typography: { size: '13px', letterSpacing: '0' } }
  assert.equal(JSON.stringify(normalizeUiHostTheme(shuffled)), JSON.stringify(normalizeUiHostTheme(ordered)))
  // bounded: a token map far over the allowlist is not walked
  assert.deepEqual(normalizeUiHostTheme({ scheme: 'dark', tokens: Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`--k${i}`, 'red'])), typography: {} }).tokens, {})
  const t = readUiHostTheme(hostDoc(LIGHT))
  assert.ok(JSON.stringify(t).length < 6_000, `the whole theme is small: ${JSON.stringify(t).length}`)
})

test('declarations: every allowlisted property set or removed, typography under --ui-*, the scheme as color-scheme', () => {
  const d = uiThemeDeclarations({ scheme: 'dark', tokens: { '--ink': '#eee' }, typography: { size: '14px', lineHeight: '1.5' } })
  assert.equal(d.length, 42 + 4 + 1)
  const m = new Map(d)
  assert.equal(m.get('--ink'), '#eee')
  assert.equal(m.get('--accent'), null, 'a token not given is removed: the fallback stands')
  assert.equal(m.get('--ui-font-size'), '14px')
  assert.equal(m.get('--ui-line-height'), '1.5')
  assert.equal(m.get('--ui-font-family'), null)
  assert.equal(m.get('color-scheme'), 'dark')
  assert.deepEqual(new Map(uiThemeDeclarations({ scheme: 'x', tokens: { '--ink': 'red;' } } as never)).get('--ink'), null)
})

test('the base stylesheet: zero specificity, every token with a fallback, nothing loaded, nothing that resets a layout', () => {
  const s = UI_BASE_STYLE
  assert.ok(!/@import|@font-face|url\(|!important|[<>\\]/i.test(s), 'no import, font, url, !important, markup or escapes')
  assert.equal((s.match(/\{/g) ?? []).length, (s.match(/\}/g) ?? []).length, 'balanced')
  const rules = [...s.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1]!.trim(), body: m[2]! }))
  assert.ok(rules.length > 40)
  for (const r of rules) {
    const zero = r.selector.startsWith(':where(') && r.selector.replace(/:where\((?:[^()]|\([^()]*\))*\)/g, '') === ''
    assert.ok(zero || /^::[a-z-]+(?:,::[a-z-]+)*$/.test(r.selector), `zero specificity (or bare pseudo-elements): ${r.selector}`)
    assert.ok(!/:where\([^)]*::/.test(r.selector), `no pseudo-element inside :where (it would void the rule): ${r.selector}`)
    assert.ok(!/animation|transform|position\s*:|float\s*:|grid|z-index/.test(r.body), `no layout or animation reset: ${r.selector}`)
    for (const v of r.body.matchAll(/var\((--[a-z0-9-]+)(,?)/g)) assert.equal(v[2], ',', `var(${v[1]}) has a fallback in ${r.selector}`)
  }
  for (const name of Object.keys(UI_THEME_TOKENS).filter((n) => /^--(ink|surface|line|accent|radius-sm|font-mono|font-heading|shadow-btn|shadow-inset-field)$/.test(n)))
    assert.ok(s.includes(`var(${name}`), `uses ${name}`)
  for (const [, [prop]] of Object.entries(UI_THEME_TYPOGRAPHY)) assert.ok(s.includes(`var(${prop},`), `uses ${prop}`)
  // the controls it covers
  for (const sel of ['button', 'input[type=range]', 'select', 'textarea', '[type=checkbox]', 'progress', 'table', 'code', 'pre', 'h1', ':focus-visible', ':disabled', '::selection', '::-webkit-scrollbar', 'accent-color', 'color-scheme'])
    assert.ok(s.includes(sel), sel)
})

test('the tokens are read where the content is: a token the body sets (a class, an inline style) wins over the root\'s', () => {
  const t = readUiHostTheme(hostDoc(LIGHT, { bodyVars: { '--ink': 'rgb(4, 5, 6)' } }))
  assert.equal(t.tokens['--ink'], 'rgb(4, 5, 6)')
  assert.equal(t.tokens['--surface'], readUiHostTheme(hostDoc(LIGHT)).tokens['--surface'], 'the rest inherited from the root')
})

test('a scope reads the tokens and the face where that content stands (a hidden probe of the class, taken out at once); the rest as before', () => {
  const doc = hostDoc(LIGHT)
  const added: { className: string; hidden: boolean; display: string; removed: boolean }[] = []
  const body = doc.body as unknown as Record<string, unknown>
  const SCOPED = { '--font-body': '"Helvetica Neue", Helvetica, Arial, sans-serif', '--radius-sm': '3px', '--accent': '#222' }
  ;(doc as unknown as Record<string, unknown>).createElement = () => {
    const el = { className: '', hidden: false, style: { display: '' }, removed: false, setAttribute() {}, remove() { el.removed = true } }
    return el
  }
  body.appendChild = (el: { className: string; hidden: boolean; style: { display: string }; removed: boolean }) => { added.push(el as never); return el }
  const view = doc.defaultView as unknown as { getComputedStyle: (el: object) => unknown }
  const plain = view.getComputedStyle
  view.getComputedStyle = (el: object) => (added.includes(el as never)
    ? { getPropertyValue: (n: string) => (SCOPED as Record<string, string>)[n] ?? (LIGHT as Record<string, string>)[n] ?? '', colorScheme: '', fontFamily: SCOPED['--font-body'], fontSize: '13.5px', lineHeight: '20.25px', letterSpacing: '-0.0675px' }
    : plain(el))
  const t = readUiHostTheme(doc, { scope: 'uis' })
  assert.equal(added.length, 1)
  assert.deepEqual([added[0]!.className, added[0]!.hidden, (added[0] as unknown as { style: { display: string } }).style.display, added[0]!.removed], ['uis', true, 'none', true], 'a hidden probe of the class, removed after the read')
  assert.equal(t.tokens['--font-body'], SCOPED['--font-body'])
  assert.equal(t.tokens['--radius-sm'], '3px')
  assert.equal(t.tokens['--accent'], '#222')
  assert.equal(t.tokens['--ink'], LIGHT['--ink'], 'the palette inherited from the root')
  assert.equal(t.typography.family, SCOPED['--font-body'])
  assert.equal(t.typography.letterSpacing, '-0.005em')
  assert.deepEqual(Object.keys(t.tokens), Object.keys(UI_THEME_TOKENS), 'the same allowlist, nothing more')
  assert.deepEqual(readUiHostTheme(hostDoc(LIGHT)).typography.family, '"Inter Variable", -apple-system, sans-serif', 'without a scope: the body, as before')
})
