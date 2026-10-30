import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { mathMarkdown } from '../src/state/math.ts'

test('a display in any of its spellings becomes a $$ block of its own lines, indented as it stood', () => {
  const owner = '$$ \\epsilon_{\\rm cov}(\\mu,\\pi^*)\\ \\text{实际上是}\\ \\epsilon_{\\rm cov}^{\\mathcal A}(\\mu,\\pi^*),\\qquad \\epsilon_{\\rm cov}^{\\rm DPO}\\ \\ge\\ \\epsilon_{\\rm cov}^{\\rm RM+RL} $$'
  assert.equal(mathMarkdown(`结论：\n${owner}\n所以`), `结论：\n$$\n${owner.slice(3, -3).trim()}\n$$\n所以`)
  assert.equal(mathMarkdown('\\[ a^2 + b^2 = c^2 \\]'), '$$\na^2 + b^2 = c^2\n$$')
  assert.equal(mathMarkdown('where\n\\[\n\\sum_{i=1}^n x_i\n\\]\nholds'), 'where\n$$\n\\sum_{i=1}^n x_i\n$$\nholds')
  assert.equal(mathMarkdown('- item\n  \\[ x_1 \\]'), '- item\n  $$\n  x_1\n  $$')
  assert.equal(mathMarkdown('$$\nx^2 $y$\n$$'), '$$\nx^2 $y$\n$$')                                        // a block already: as written
})

test('inline math becomes $$…$$ in the line; a price, an escaped dollar and a lone opening stay text', () => {
  assert.equal(mathMarkdown('where \\(x_i\\) is the input'), 'where $$x_i$$ is the input')
  assert.equal(mathMarkdown('the loss $L(\\theta)$ falls, $2x+1$ too'), 'the loss $$L(\\theta)$$ falls, $$2x+1$$ too')
  for (const price of ['¥25,000 or $120–$180 per night', 'costs $5 and $10 total', '$5, $10, $15', '$50/night and $60/night', 'costs \\$5 and \\$x\\$', 'a lone $x^2 still streaming', 'a lone \\(x still streaming'])
    assert.equal(mathMarkdown(price), price, price)
  assert.equal(mathMarkdown('costs $5 while $x$ grows'), 'costs $5 while $$x$$ grows')                   // the price stays, the variable is math
  assert.equal(mathMarkdown('see \\[1\\] and \\[2\\]'), 'see \\[1\\] and \\[2\\]')                          // escaped brackets that are no math
  assert.equal(mathMarkdown('inline $$x^2$$ here'), 'inline $$x^2$$ here')
})

test("inside math a model's markdown escape on a star is taken back; TeX's own pairs stay", () => {
  assert.equal(mathMarkdown('the optimum $r^\\*$ and \\(\\pi^\\*\\)'), 'the optimum $$r^*$$ and $$\\pi^*$$')
  assert.equal(mathMarkdown('$$\nJ(\\pi^\\*) \\\\ \\{x\\}\n$$'), '$$\nJ(\\pi^*) \\\\ \\{x\\}\n$$')
  assert.equal(mathMarkdown('$$ r^\\* $$'), '$$\nr^*\n$$')
  assert.equal(mathMarkdown('\\[ \\text{max\\_len} = r^\\* \\]'), '$$\n\\text{max\\_len} = r^*\n$$')
  assert.equal(mathMarkdown('not math: 5 \\* 3'), 'not math: 5 \\* 3')                                  // outside math, markdown's escape is markdown's
})

test('code is never math: a fenced block and a code span go through as written', () => {
  const fenced = '```sh\necho $HOME and $x$\n\\[ a^2 \\]\n```\nafter $y$'
  assert.equal(mathMarkdown(fenced), '```sh\necho $HOME and $x$\n\\[ a^2 \\]\n```\nafter $$y$$')
  assert.equal(mathMarkdown('run `echo $x$` then $z$'), 'run `echo $x$` then $$z$$')
  assert.equal(mathMarkdown('~~~\n$$ x $$\n~~~'), '~~~\n$$ x $$\n~~~')
  assert.equal(mathMarkdown('plain words'), 'plain words')
})

test("the KaTeX that renders the thread's math (rehype-katex's) is the one whose stylesheet the page loads", () => {
  // two versions read each other's class names wrongly: 0.16's \boxed frame (`stretchy`) under 0.18's stylesheet
  // (`katex-stretchy`) drew as a one-pixel line through the formula (seen 2026-09-29)
  const top = createRequire(import.meta.url)
  const renderer = createRequire(top.resolve('rehype-katex'))
  assert.equal(renderer.resolve('katex'), top.resolve('katex'))                   // one copy of KaTeX, not two
})
