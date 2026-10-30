/** The thread's math through the reader the page uses (state/proseMath.ts: remark-math, rehype-katex, KaTeX),
 *  rendered to markup: inline and display math typeset, code left as code, a formula KaTeX cannot read shown as its
 *  source (never thrown), and KaTeX's default of not trusting a formula (no links out of math). Ordinary input only. */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import Markdown from 'react-markdown'
import { mathMarkdown } from '../src/state/math.ts'
import { KATEX_OPTIONS, REHYPE_PLUGINS, REMARK_PLUGINS } from '../src/state/proseMath.ts'

const render = (text: string): string =>
  renderToStaticMarkup(createElement(Markdown, { remarkPlugins: REMARK_PLUGINS, rehypePlugins: REHYPE_PLUGINS }, mathMarkdown(text)))
const count = (html: string, re: RegExp) => html.match(re)?.length ?? 0

test('inline and display math are typeset by KaTeX, with no error and no command left red', () => {
  const html = render('the loss $L(\\theta)$ falls and \\(x_i\\) is the input\n\n\\[ \\sum_{i=1}^n x_i^2 = \\frac{a}{b} \\]\n\n$$ \\text{实际上是}\\ \\epsilon_{\\rm cov}^{\\mathcal A} $$')
  assert.equal(count(html, /class="katex-display"/g), 2)
  assert.equal(count(html, /class="katex"/g), 4)                                   // the two displays and two inline
  assert.equal(html.includes('katex-error'), false)
  assert.match(html, /<math[^>]*>/)                                                // MathML for readers of the page
  assert.match(html, /<annotation encoding="application\/x-tex">L\(\\theta\)<\/annotation>/)
})

test('code next to math stays code: a fence and a code span are never typeset', () => {
  const html = render('run `echo $x$` then $z$\n\n```sh\necho $HOME and $y$\n```')
  assert.equal(count(html, /class="katex"/g), 1)                                   // $z$ only
  assert.match(html, /<code>echo \$x\$<\/code>/)
  assert.match(html, /<code class="language-sh">echo \$HOME and \$y\$\n<\/code>/)
})

test('a formula KaTeX cannot read shows its source in the error colour, and the rest of the answer still renders', () => {
  const html = render('before $\\notacommand{x}$ and $$\\frac{1}{$$ after $y^2$')
  assert.match(html, /notacommand/)
  assert.match(html, /color:#cc0000/)
  assert.ok(count(html, /class="katex"/g) >= 1, 'the readable formula after it is typeset')
  assert.match(html, /before/)
  assert.match(html, /after/)
})

test('KaTeX keeps its default of not trusting a formula: a link command shows as source, no link is made', () => {
  assert.equal(Object.hasOwn(KATEX_OPTIONS, 'trust'), false)
  assert.equal(Object.getPrototypeOf(KATEX_OPTIONS), Object.prototype)
  const html = render('see $\\href{https://example.com/}{here}$ and $\\url{https://example.com/}$')
  assert.equal(/<a\b/.test(html), false)
  assert.equal(/\bhref=/.test(html), false)
  assert.match(html, /\\href/)                                                     // the source, in the error colour
})

test("the markup KaTeX writes and the stylesheet the page loads name the same classes (0.18 prefixed them)", () => {
  // the page loads katex/dist/katex.min.css (components/Prose.tsx) and styles .katex and .katex-display (index.css)
  const css = readFileSync(createRequire(import.meta.url).resolve('katex/dist/katex.min.css'), 'utf8')
  const styled = new Set([...css.matchAll(/\.([A-Za-z][\w-]*)/g)].map((m) => m[1]!))
  const html = render('$$\n\\boxed{x} + \\sqrt{\\frac{a}{b}} + \\overline{y} + \\widehat{z}\n$$')
  const used = new Set([...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1]!.split(/\s+/)).filter(Boolean))
  for (const name of ['katex', 'katex-display', 'katex-html']) { assert.ok(used.has(name), name); assert.ok(styled.has(name), name) }
  // a class written one way and styled the other is the two-versions mismatch (a \boxed frame drawn as a line)
  const crossed = [...used].filter((c) => (!styled.has(c) && styled.has(`katex-${c}`)) || (c.startsWith('katex-') && !styled.has(c) && styled.has(c.slice(6))))
  assert.deepEqual(crossed, [])
})
