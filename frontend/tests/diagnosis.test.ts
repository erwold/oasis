import assert from 'node:assert/strict'
import { test } from 'node:test'
import { explain } from '../src/state/diagnosis.ts'

test('each failure kind says what happened and where to act; an unknown one falls back', () => {
  for (const kind of ['auth', 'quota', 'rate_limit', 'context_overflow', 'model_unavailable', 'bad_request', 'outage', 'timeout', 'disconnect', 'budget', 'incomplete', 'chatgpt_signin', 'chatgpt_unreachable', 'chatgpt_refused', 'other']) {
    const e = explain(kind)
    assert.ok(e.title.length > 10 && e.advice.length > 20, kind)
  }
  assert.equal(explain('auth').accounts, true)
  assert.equal(explain('quota').accounts, true)
  assert.match(explain('quota').title, /API credit balance/)
  assert.match(explain('quota').advice, /not automatically retried/)
  assert.equal(explain('timeout').accounts, false)
  // ChatGPT's page is where a sign-in is fixed, never the Accounts page
  assert.equal(explain('chatgpt_signin').chatgpt, true)
  assert.equal(explain('chatgpt_signin').accounts, false)
  assert.match(explain('chatgpt_unreachable').advice, /desktop app/)
  assert.deepEqual(explain('something new'), explain('other'))
  assert.deepEqual(explain(null), explain('other'))
})
