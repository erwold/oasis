import assert from 'node:assert/strict'
import { test } from 'node:test'
import { thinkingParts } from '../src/state/thinking.ts'
import { THINKING_LEVELS, thinkingLevelsFor } from '../src/state/accounts.ts'

test("a reasoning summary's titles lose their asterisks, one per line as written", () => {
  assert.deepEqual(thinkingParts('**Strengthening narrowpdf tests**\n**Fixing PDF reference parsing**'), [
    { text: 'Strengthening narrowpdf tests', title: true },
    { text: '\n', title: false },
    { text: 'Fixing PDF reference parsing', title: true },
  ])
})

test('a title and the words after it; plain thinking stays as written', () => {
  assert.deepEqual(thinkingParts('**Planning**\n\nI will read the file first.'), [
    { text: 'Planning', title: true },
    { text: '\n\nI will read the file first.', title: false },
  ])
  const plain = 'The user wants 2 * 3 and a ** b, not a title.'
  assert.deepEqual(thinkingParts(plain), [{ text: plain, title: false }])
  assert.deepEqual(thinkingParts('x = a ** b ** c'), [{ text: 'x = a ** b ** c', title: false }])
  assert.deepEqual(thinkingParts(''), [])
})

test('a title still streaming is a title; an unclosed pair inside the text is left alone', () => {
  assert.deepEqual(thinkingParts('**Checking E2E regr'), [{ text: 'Checking E2E regr', title: true }])
  assert.deepEqual(thinkingParts('**Done**\n**Next ste'), [
    { text: 'Done', title: true }, { text: '\n', title: false }, { text: 'Next ste', title: true },
  ])
  assert.deepEqual(thinkingParts('a **loose pair\nthen more'), [{ text: 'a **loose pair\nthen more', title: false }])
})

test("a picker offers the levels the model's route declares, and every level when it declares none", () => {
  assert.deepEqual(thinkingLevelsFor(['low', 'medium', 'high']), ['low', 'medium', 'high'])                       // Gemini 4 Argon
  assert.deepEqual(thinkingLevelsFor(['max', 'low', 'xhigh', 'high', 'medium']), ['low', 'medium', 'high', 'xhigh', 'max'])  // in the picker's order
  assert.deepEqual(thinkingLevelsFor(null), [...THINKING_LEVELS])
  assert.deepEqual(thinkingLevelsFor([]), [...THINKING_LEVELS])
  assert.deepEqual(thinkingLevelsFor(undefined), [...THINKING_LEVELS])
})
