import assert from 'node:assert/strict'
import { test } from 'node:test'
import { accountLabel, chatGptRoute, contextLabel, customProviderId, groupByAccount, maskKey, monogram, participantThinking, pickerModels, suggestEnvName, thinkingLevelsFor, thinkingLabel, thinkingOption, thinkingRecord, thinkingWord, unavailableHint } from '../src/state/accounts.ts'
import { loginHint, pollDelay, showPasteBox } from '../src/state/auth.ts'
import { hiddenProxyCount, quotaSummary, railAccounts, remainingPercent, resetCountdown, visibleAccounts } from '../src/state/quota.ts'
import type { AccountUsage, LoginSession } from '../src/api/types.ts'

test('keys are masked and custom providers named the way the backend expects', () => {
  assert.equal(maskKey('sk-0123456789abcdef'), 'sk-…cdef')
  assert.equal(maskKey('abcdefghijk'), '…hijk')
  assert.equal(maskKey('short'), '••••')
  assert.equal(customProviderId('OpenRouter (beta)!'), 'openrouter-beta')
  assert.equal(suggestEnvName('Open Router'), 'OPEN_ROUTER_API_KEY')
  assert.equal(monogram('Open Router'), 'OR')
  assert.equal(accountLabel('openai-codex'), 'Codex (ChatGPT)')
  assert.equal(accountLabel('env:MY_KEY'), 'MY_KEY')
  assert.equal(unavailableHint('anthropic', null), 'sign in')
  assert.equal(unavailableHint('anthropic-api', 'no key (ANTHROPIC_API_KEY)'), 'no key (ANTHROPIC_API_KEY)')
})

test('models group by the account that gates them', () => {
  const groups = groupByAccount([
    { id: 'a', account: 'anthropic', credential: 'unavailable' as const },
    { id: 'b', account: 'anthropic', credential: 'available' as const },
    { id: 'c', account: 'openai-api', credential: 'unavailable' as const },
  ])
  assert.deepEqual(groups.map((g) => [g.account, g.available, g.models.length]), [['anthropic', true, 2], ['openai-api', false, 1]])
})

test('sign-in sessions: polling cadence, paste box, hints', () => {
  const waiting: LoginSession = { id: 'l', provider: 'anthropic', url: 'u', state: 'waiting', error: null, paste_only: false, expires_at: '', account_label: null }
  assert.equal(pollDelay(waiting), 1000)
  assert.equal(pollDelay({ ...waiting, state: 'exchanging' }), 500)
  assert.equal(pollDelay({ ...waiting, state: 'done' }), null)
  assert.equal(showPasteBox(waiting, 0, 10_000), false)
  assert.equal(showPasteBox(waiting, 0, 20_000), true)
  assert.equal(showPasteBox({ ...waiting, paste_only: true }, 0, 0), true)
  assert.match(loginHint({ ...waiting, state: 'done', account_label: 'me@x' }), /Signed in as me@x/)
  assert.match(loginHint({ ...waiting, state: 'failed', error: 'timed out' }), /timed out/)
})

test('quota words never invent a full allowance', () => {
  assert.equal(remainingPercent(null), null)
  assert.equal(remainingPercent(-1), null)
  assert.equal(remainingPercent(30), 70)
  const now = Date.parse('2026-09-26T00:00:00Z')
  assert.equal(resetCountdown(new Date(now + 90 * 60 * 1000).toISOString(), now), 'Resets in 1h 30m')
  assert.equal(resetCountdown(null, now), 'Reset time not reported')
  const account: AccountUsage = { id: 'harness:anthropic', provider: 'anthropic', label: 'Claude', source: 'harness', account_label: null,
    status: 'ok', windows: [{ id: 'w', label: '5 hours', used_percent: 40, resets_at: null, window_seconds: 18000 }],
    checked_at: null, next_refresh_at: '', error: null, message: null, plan: null }
  assert.equal(quotaSummary(account, now), '60% left')
  assert.equal(quotaSummary({ ...account, status: 'login_required' }, now), 'Sign in')
  assert.equal(quotaSummary({ ...account, windows: [] }, now), 'Not reported')
  const proxy: AccountUsage = { ...account, id: 'proxy:x', source: 'proxy' }
  assert.equal(visibleAccounts([account, proxy], false).length, 1)
  assert.equal(hiddenProxyCount([account, proxy]), 1)
  assert.equal(visibleAccounts([proxy], false).length, 1)
})

test('the rail leaves Antigravity out until it is signed in; Codex and Claude stay, signed in or not', () => {
  const row = (provider: AccountUsage['provider'], status: AccountUsage['status']): AccountUsage => ({ id: `harness:${provider}`, provider, label: provider,
    source: 'harness', account_label: null, status, windows: [], checked_at: null, next_refresh_at: '', error: null, message: null, plan: null })
  const ids = (accounts: AccountUsage[]) => railAccounts(accounts, false).map((a) => a.provider)
  assert.deepEqual(ids([row('openai-codex', 'ok'), row('anthropic', 'login_required'), row('antigravity', 'login_required')]), ['openai-codex', 'anthropic'])
  assert.deepEqual(ids([row('openai-codex', 'ok'), row('antigravity', 'ok')]), ['openai-codex', 'antigravity'])
  assert.deepEqual(ids([row('antigravity', 'stale')]), ['antigravity'])
})

test('the Gemini key row has its own label', () => {
  assert.equal(accountLabel('gemini'), 'Google Gemini')
  assert.equal(unavailableHint('gemini', null), 'no key')
})

test('a context window reads as k or m; a thinking level has a short name', () => {
  assert.equal(contextLabel(1_000_000), '1m context')
  assert.equal(contextLabel(1_048_576), '1m context')
  assert.equal(contextLabel(272_000), '272k context')
  assert.equal(contextLabel(921_000), '921k context')
  assert.equal(contextLabel(null), 'context unknown')
  assert.equal(thinkingLabel(null), 'Thinking: default')
  assert.equal(thinkingLabel('off'), 'Thinking off')
  assert.equal(thinkingLabel('xhigh'), 'Thinking: extra high')
})

test('a picker offers only routes with a credential, plus the chosen one', () => {
  const models = [
    { id: 'a', credential: 'available' as const }, { id: 'b', credential: 'unavailable' as const }, { id: 'c', credential: 'unavailable' as const },
  ]
  assert.deepEqual(pickerModels(models, null).map((m) => m.id), ['a'])
  assert.deepEqual(pickerModels(models, 'c').map((m) => m.id), ['a', 'c'])
})

test('ChatGPT on the web is named with @ where the desktop app holds its page, never picked as a model (unless it is the one chosen)', () => {
  const models = [{ id: 'a', credential: 'available' as const }, { id: 'chatgpt:web', credential: 'unavailable' as const }]
  assert.deepEqual(pickerModels([{ id: 'a', credential: 'available' as const }, { id: 'chatgpt:web', credential: 'available' as const }], null).map((m) => m.id), ['a'])
  assert.deepEqual(pickerModels(models, 'chatgpt:web').map((m) => m.id), ['a', 'chatgpt:web'])
  // offered by the desktop app's own word, whatever the catalogue read when the page loaded
  assert.equal(chatGptRoute(models, true)?.id, 'chatgpt:web')
  assert.equal(chatGptRoute(models, false), null)
  assert.equal(chatGptRoute([{ id: 'a' }], true), null)
})

test("a participant's own effort comes from its model's choice in the @ menu; ChatGPT's page keeps its own", () => {
  const participants = [{ id: 'pt_a', model: 'anthropic:opus' }, { id: 'pt_b', model: 'openai:gpt' }, { id: 'pt_c', model: 'anthropic:opus' }, { id: 'pt_d', model: 'chatgpt:web' }]
  assert.deepEqual(participantThinking(participants, { 'anthropic:opus': 'xhigh', 'chatgpt:web': 'high' }), { pt_a: 'xhigh', pt_c: 'xhigh' })
  assert.deepEqual(participantThinking(participants, {}), {})
  assert.equal(thinkingWord(null), 'default')
  assert.equal(thinkingWord('xhigh'), 'xhigh')
  assert.equal(thinkingOption('xhigh'), 'Extra high')
  assert.equal(thinkingOption('off'), 'Off')
})

test("a run's thinking line says what was asked and, where the route took another level, what was sent", () => {
  assert.equal(thinkingRecord(null, null), "the provider's default")
  assert.equal(thinkingRecord('high', 'high'), 'asked for high')
  assert.equal(thinkingRecord('high', undefined), 'asked for high')
  // a level the route lacks: the route is the reason, not the request's tools
  assert.equal(thinkingRecord('off', 'low'), 'asked for off · sent as low (the nearest the route takes)')
  assert.equal(thinkingRecord('xhigh', 'high', ['low', 'medium', 'high']), 'asked for xhigh · sent as high (the nearest the route takes)')
  // minimal is raised beside the provider's web search: the line does not say the route lacks it
  assert.equal(thinkingRecord('minimal', 'low'), "asked for minimal · sent as low (the nearest the route takes with this request's tools)")
  assert.equal(thinkingRecord('minimal', 'low', ['minimal', 'low', 'medium', 'high']), "asked for minimal · sent as low (the nearest the route takes with this request's tools)")
  // a route without minimal raises it for itself
  assert.equal(thinkingRecord('minimal', 'low', ['low', 'medium', 'high']), 'asked for minimal · sent as low (the nearest the route takes)')
  assert.equal(thinkingRecord('high', null), 'asked for high · none sent (the model takes no thinking setting)')
})

test('DeepSeek and GLM use ordinary API-key account labels', () => {
  assert.equal(accountLabel('deepseek'), 'DeepSeek')
  assert.equal(accountLabel('zhipu'), 'Zhipu BigModel')
})

test('the new model menus respect declared thinking choices', () => {
  assert.deepEqual(thinkingLevelsFor(['off', 'low', 'high', 'max']), ['off', 'low', 'high', 'max'])
  assert.deepEqual(thinkingLevelsFor(['low', 'high', 'max']), ['low', 'high', 'max'])
})

test('Antigravity groups its subscription models separately from Gemini API keys and Claude subscriptions', () => {
  assert.equal(accountLabel('antigravity'), 'Antigravity')
  assert.equal(unavailableHint('antigravity', null), 'sign in')
  assert.equal(unavailableHint('antigravity', 'access denied'), 'access denied')
  const groups = groupByAccount([
    { id: 'antigravity:claude-sonnet', account: 'antigravity', credential: 'unavailable' as const },
    { id: 'antigravity:gemini-flash', account: 'antigravity', credential: 'available' as const },
    { id: 'google:gemini-4-argon', account: 'gemini', credential: 'unavailable' as const },
    { id: 'anthropic:claude-sonnet', account: 'anthropic', credential: 'available' as const },
  ])
  assert.deepEqual(groups.map((g) => [g.account, g.label, g.available, g.models.length]), [
    ['antigravity', 'Antigravity', true, 2], ['gemini', 'Google Gemini', false, 1], ['anthropic', 'Claude', true, 1],
  ])
  assert.equal(unavailableHint('gemini', null), 'no key')
})
