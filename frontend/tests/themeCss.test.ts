/** index.css's three palettes: light is the neutral palette the app had up to 126e2ca (exactly), claude is Atelier's
 *  warm paper as it is today, dark the dark ramp; the warm Atelier colours (the --uis-* / --agent-* skin, the ink
 *  accent, the hairline shadows) are set under claude only, and nothing reads the system's scheme in CSS any more
 *  (System is resolved to light or dark by state/theme.ts). */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')
const decls = (block: string) => Object.fromEntries([...block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]))
const block = (selector: string, nth = 0) => {
  const blocks = [...css.matchAll(new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([\\s\\S]*?)^\\}`, 'gm'))]
  assert.ok(blocks[nth], `${selector} #${nth}`)
  return decls(blocks[nth]![1]!)
}
const LIGHT = block(':root')
const CLAUDE = { ...block(':root:where([data-theme="claude"])'), ...block(':root:where([data-theme="claude"])', 1) }
const DARK = block(':root:where([data-theme="dark"])')
// the warm Atelier hexes (index.css at 261b385)
const WARM = /#(fbfaf8|f5f3ef|ece9e3|f4f2ee|655e53|958d80|e9e5de|d7d1c7|f2efea|ece8e1|f1eee9|8f877b|4f4a43|b3ab9f|6f685e|c9c2b7|3a3631|a39b8f|e2401f|f6f4f0|c4bcb0|f3f1ed)\b|#222\b|rgb\(34 34 34/i

test("light is 126e2ca's neutral palette, value for value", () => {
  assert.deepEqual({
    page: LIGHT['--page'], canvas: LIGHT['--canvas'], surface: LIGHT['--surface'], inset: LIGHT['--inset'], hover: LIGHT['--hover'], field: LIGHT['--field'],
    ink: LIGHT['--ink'], ink2: LIGHT['--ink-2'], ink3: LIGHT['--ink-3'], line: LIGHT['--line'], lineStrong: LIGHT['--line-strong'], accent: LIGHT['--accent'],
    green: LIGHT['--green'], orange: LIGHT['--orange'], red: LIGHT['--red'],
  }, {
    page: 'oklch(0.985 0.001 286.376)', canvas: 'oklch(0.961 0.002 247.84)', surface: 'oklch(1 0 0)', inset: 'oklch(0.979 0.002 247.839)',
    hover: 'oklch(0.97 0.002 247.839)', field: 'oklch(0.961 0.001 286.375)', ink: 'oklch(0.247 0.006 258.361)', ink2: 'oklch(0.506 0.01 264.477)',
    ink3: 'oklch(0.695 0.009 264.505)', line: 'oklch(0.946 0.003 264.542)', lineStrong: 'oklch(0.912 0.005 258.326)', accent: 'oklch(0.626 0.205 254.947)',
    green: 'oklch(0.603 0.155 150.883)', orange: 'oklch(0.689 0.179 49.902)', red: 'oklch(0.621 0.192 23.042)',
  })
  assert.match(/^:root \{\s*color-scheme: (\w+);/m.exec(css)![1]!, /^light$/)
  for (const [name, value] of Object.entries(LIGHT)) assert.doesNotMatch(value, WARM, `light ${name}`)
})

test("claude is Atelier's paper and inks; dark keeps its ramp", () => {
  assert.deepEqual([CLAUDE['--page'], CLAUDE['--ink'], CLAUDE['--ink-2'], CLAUDE['--line'], CLAUDE['--uis-latest'], CLAUDE['--uis-series-0'], CLAUDE['--agent-live']],
    ['#fff', '#222', '#655e53', '#e9e5de', '#e2401f', '#222', '#e2401f'])
  assert.equal(DARK['--page'], 'oklch(0.17 0.004 264)')
  assert.equal(DARK['--ink'], 'oklch(0.93 0.003 264)')
  for (const [name, value] of Object.entries(DARK)) assert.doesNotMatch(value, WARM, `dark ${name}`)
})

test('every warm Atelier colour sits under claude; no rule reads prefers-color-scheme', () => {
  assert.doesNotMatch(css, /prefers-color-scheme/)
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  const warm = rules.filter((r) => WARM.test(r[2]!)).map((r) => r[1]!.trim().split('\n').pop()!.trim())
  assert.ok(warm.length >= 4)
  for (const sel of warm) assert.match(sel, /data-theme="claude"/, `a warm colour outside claude: ${sel}`)
  // the skin variables are set nowhere else: light and dark fall back to their own tokens
  for (const r of rules) {
    if (/data-theme="claude"/.test(r[1]!)) continue
    for (const name of Object.keys(decls(r[2]!))) if (/^--(uis|agent)-(bg|head-bg|shadow|rule|grid|ink|ink-2|ink-3|muted|field|btn-shadow|series-\d|latest|cursor|fresh|title-bg|line|line-soft|sel-bg|live|ok|wait|bad|mute|card-shadow)$/.test(name)) assert.fail(`${name} outside claude: ${r[1]!.trim()}`)
  }
})
