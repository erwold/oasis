import assert from 'node:assert/strict'
import { beforeEach, afterEach, test } from 'node:test'
import { registerHooks } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { JSDOM } from 'jsdom'
import type { AuthAccounts, AuthProvider, LoginSession, ModelEntry, UsageSnapshot } from '../src/api/types.ts'
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL?.includes('/frontend/src/') && !/\.[a-z]+$/i.test(specifier)) {
      for (const ext of ['.ts', '.tsx']) { const u = new URL(`${specifier}${ext}`, context.parentURL); if (existsSync(u)) return next(u.href, context) }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (/\.(css|png|svg)$/.test(url)) return { format: 'module', source: `export default ${JSON.stringify(url)}`, shortCircuit: true }
    if (url.startsWith('file:') && url.endsWith('.tsx')) return { format: 'module', source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText, shortCircuit: true }
    return next(url, context)
  },
})
// Real Accounts/AgentChip components and HTTP client, with in-memory DOM and synthetic HTTP only.
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://ui.invalid/', pretendToBeVisual: true })
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true, __OASIS_CODE_BUILD__: 'test' })
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: dom.window.localStorage })
dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true }
dom.window.HTMLDialogElement.prototype.close = function () { this.open = false }
const { createElement, act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { renderToStaticMarkup } = await import('react-dom/server')
const { useStore } = await import('../src/state/store.ts')
const { AccountsPanel } = await import('../src/components/AccountsPanel.tsx')
const { agentLogo, agentImage, AgentChip } = await import('../src/components/EntityChip.tsx')
const { AgentModelPicker, ThinkingChip } = await import('../src/components/Composer.tsx')
const initial = { ...useStore.getState() }
const container = document.getElementById('root')!
let root: ReturnType<typeof createRoot>
let accounts: AuthAccounts
let usage: UsageSnapshot
let login: LoginSession
let calls: { path: string; method: string; body: unknown }[]
let opened: string[]
let failure: string | null
let polledState: LoginSession['state']
const provider = (id: AuthProvider['provider'], label: string): AuthProvider => ({ provider: id, label, status: 'signed_out', error: null, account_label: null, expires_at: null, login: null })
const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) }) }
const mount = async () => { await act(async () => root.render(createElement(AccountsPanel))); await flush(); await flush() }
const click = async (element: HTMLElement) => { await act(async () => element.click()); await flush() }
function row(label = 'Antigravity'): HTMLElement {
  const name = [...container.querySelectorAll('section[aria-label="Subscriptions"] .acct-row2-id strong')].find((e) => e.textContent === label)
  assert.ok(name, `subscription ${label}`)
  return name.closest('.acct-row2') as HTMLElement
}
function button(text: string, within: ParentNode = container): HTMLButtonElement {
  const found = [...within.querySelectorAll('button')].find((e) => e.textContent?.trim() === text)
  assert.ok(found, `button ${text}`)
  return found
}
beforeEach(() => {
  calls = []; opened = []; failure = null; polledState = 'waiting'
  login = { id: 'login-fixture', provider: 'antigravity', url: 'https://accounts.example.invalid/oauth', state: 'waiting', error: null, paste_only: false, expires_at: '2026-10-18T15:00:00Z', account_label: null }
  accounts = { local: true, providers: [provider('openai-codex', 'Codex'), provider('anthropic', 'Claude'), provider('antigravity', 'Antigravity')], keys: [
    { provider: 'gemini', label: 'Google Gemini', env: 'GEMINI_API_KEY', unlocks: 'Gemini', docs: '', source: null, hint: null, custom: false },
  ] }
  usage = { accounts: [{ id: 'harness:antigravity', provider: 'antigravity', label: 'Antigravity', source: 'harness', status: 'ok', account_label: null, windows: [], checked_at: null, next_refresh_at: '', error: null, message: null, plan: null }], server_time: new Date().toISOString(), poll_interval_seconds: 60 }
  useStore.setState({ ...initial, settingsOpen: true, settingsTab: 'accounts' })
  dom.window.open = (url) => { opened.push(String(url)); return null }
  globalThis.fetch = (async (url, init) => {
    const path = String(url), method = init?.method ?? 'GET'
    calls.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : null })
    let body: unknown
    if (path === '/api/auth/accounts') body = accounts
    else if (path.startsWith('/api/auth/usage')) body = usage
    else if (path === '/api/settings/web-search') body = { engine: 'automatic' }
    else if (path === '/api/models') body = []
    else if (path === '/api/auth/login/antigravity' && method === 'POST') {
      if (failure) return new Response(JSON.stringify({ detail: failure }), { status: 403 })
      body = login
    } else if (path === '/api/auth/login/login-fixture' && method === 'DELETE') body = { ...login, state: 'cancelled' }
    else if (path === '/api/auth/login/login-fixture' && method === 'GET') {
      if (polledState === 'done') accounts.providers[2] = { ...accounts.providers[2], status: 'ready', account_label: 'test@example.invalid' }
      body = { ...login, state: polledState }
    } else if (path === '/api/auth/login/login-fixture/code' && method === 'POST') body = { ...login, state: 'exchanging' }
    else if (path === '/api/auth/accounts/antigravity' && method === 'DELETE') {
      accounts.providers[2] = provider('antigravity', 'Antigravity')
      body = { provider: 'antigravity', removed: true }
    } else throw new Error(`Unexpected HTTP ${method} ${path}`)
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); await flush() })

test('Antigravity is the third subscription; Gemini remains an API-key row', async () => {
  await mount()
  assert.deepEqual([...container.querySelectorAll('section[aria-label="Subscriptions"] .acct-row2-id strong')].map((e) => e.textContent), ['Codex', 'Claude', 'Antigravity'])
  assert.match(row().textContent!, /Not signed in/)
  assert.match(row().querySelector('img')!.src, /logo-antigravity\.png$/)
  assert.ok(row().querySelector('[data-testid="sign-in-antigravity"]'))
  assert.ok(container.querySelector('section[aria-label="API keys"] [data-testid="add-key-gemini"]'))
  assert.match(container.querySelector('.acct-launcher-name img')!.getAttribute('src')!, /logo-antigravity\.png$/)
  assert.match(row().textContent!, /No allowance windows reported/)
  assert.doesNotMatch(row().textContent!, /100%/)
})

test('Antigravity sign in and cancel use the generic OAuth API and preserve the other rows', async () => {
  await mount()
  await click(button('Sign in', row()))
  assert.ok(calls.some((c) => c.path === '/api/auth/login/antigravity' && c.method === 'POST'))
  assert.deepEqual(opened, [login.url])
  assert.match(row().textContent!, /Signing in/)
  assert.equal(row().querySelector('a')!.getAttribute('href'), login.url)
  assert.match(row('Claude').textContent!, /Not signed in/)
  await click(button('Cancel', row()))
  assert.ok(calls.some((c) => c.path === '/api/auth/login/login-fixture' && c.method === 'DELETE'))
  assert.ok(button('Sign in', row()))
  assert.equal(row().querySelector('[role="status"]'), null)
})

test('Antigravity ready state displays reported usage; refresh and logout use existing endpoints', async () => {
  accounts.providers[2] = { ...accounts.providers[2], status: 'ready', account_label: 'test@example.invalid' }
  usage.accounts[0].windows = [{ id: 'model', label: 'Model allowance', used_percent: 35, resets_at: null, window_seconds: null }]
  await mount()
  assert.match(row().textContent!, /Signed in/)
  assert.match(row().textContent!, /test@example.invalid/)
  assert.match(row().textContent!, /65% left/)
  await click(button('Refresh'))
  assert.ok(calls.some((c) => c.path === '/api/auth/usage?refresh=true'))
  await click(button('Sign out', row()))
  assert.ok(calls.some((c) => c.path === '/api/auth/accounts/antigravity' && c.method === 'DELETE'))
  assert.ok(calls.some((c) => c.path === '/api/models'))
  assert.ok(button('Sign in', row()))
})

test('Antigravity refresh-needed and login-required status respect local-only auth controls', async () => {
  accounts.providers[2].status = 'refresh_needed'
  accounts.local = false
  await mount()
  assert.match(row().textContent!, /Refreshing/)
  assert.equal(button('Sign out', row()).disabled, true)
  await act(async () => root.unmount()); root = createRoot(container)
  accounts.providers[2].status = 'login_required'
  await mount()
  assert.equal(button('Sign in again', row()).disabled, true)
  assert.equal(button('Sign out', row()).disabled, true)
})

test('Antigravity server refusal is shown rather than claiming a login succeeded', async () => {
  failure = 'Antigravity access denied'
  await mount()
  await click(button('Sign in', row()))
  assert.match(container.querySelector('[role="alert"]')!.textContent!, /Antigravity access denied/)
  assert.deepEqual(opened, [])
  assert.match(row().textContent!, /Not signed in/)
})

test('Antigravity redirect submission and completed polling reload accounts and usage', { timeout: 10_000 }, async () => {
  login.paste_only = true
  await mount()
  await click(button('Sign in', row()))
  const input = row().querySelector('input[aria-label="Antigravity redirect URL"]') as HTMLInputElement
  assert.ok(input)
  const redirect = 'http://localhost:9999/callback?code=synthetic&state=fixture'
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, redirect)
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  await click(button('Finish', row()))
  assert.deepEqual(calls.find((c) => c.path.endsWith('/code'))?.body, { input: redirect })
  polledState = 'done'
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 650)) })
  await flush()
  assert.ok(calls.some((c) => c.path === '/api/auth/login/login-fixture' && c.method === 'GET'))
  assert.match(row().textContent!, /Signed in/)
  assert.ok(button('Sign out', row()))
  assert.ok(calls.some((c) => c.path === '/api/auth/usage?refresh=true'))
})

test('Antigravity route identity wins over underlying Claude/Gemini providers in actual agent chips', () => {
  for (const [model, provider] of [['antigravity:claude-sonnet', 'anthropic'], ['antigravity:gemini-flash', 'google']]) {
    const logo = agentLogo(model, provider)
    assert.match(logo!, /logo-antigravity\.png$/)
    const agent = { model, label: 'Test agent', alias: null }
    assert.equal(agentImage(agent, [{ id: model, provider }]), logo)
    useStore.setState({ models: [] })
    assert.match(renderToStaticMarkup(createElement(AgentChip, { agent })), /logo-antigravity\.png/)
  }
  assert.match(agentLogo('unknown', 'antigravity')!, /logo-antigravity\.png$/)
  assert.match(agentLogo('anthropic:claude-sonnet')!, /logo-claude\.png$/)
  assert.match(agentLogo('google:gemini-4-argon', 'google')!, /logo-gemini\.png$/)
  assert.match(agentLogo('openai:gpt')!, /logo-openai\.png$/)
  assert.equal(agentLogo('antigravity-other:model'), null)
})


test('five Antigravity model groups expose only their own efforts, independently of the Gemini API route', async () => {
  const cases = [
    { id: 'antigravity:gemini-4-argon', label: 'Gemini 4 Argon', efforts: ['low', 'medium', 'high'] },
    { id: 'antigravity:gemini-3.8-flash-tiered', label: 'Gemini 3.8 Flash', efforts: ['low', 'medium', 'high'] },
    { id: 'antigravity:claude-opus-5-5-high', label: 'Claude Opus 5.5', efforts: ['low', 'medium', 'high'] },
    { id: 'antigravity:claude-sonnet-5-5-high', label: 'Claude Sonnet 5.5', efforts: ['low', 'medium', 'high'] },
    { id: 'antigravity:gpt-oss-120b-medium', label: 'GPT-OSS 120B', efforts: ['medium'] },
    { id: 'google:gemini-4-argon', label: 'Gemini 4 Argon', efforts: ['low', 'medium', 'high'] },
  ]
  const models: ModelEntry[] = cases.map(({ id, label, efforts }) => {
    const subscription = id.startsWith('antigravity:')
    return {
      id, label, configured_model: id.split(':')[1]!, provider: subscription ? 'antigravity' : 'google',
      endpoint: 'https://provider.example.invalid', api: 'generateContent', auth: subscription ? 'oauth' : 'api_key',
      account: subscription ? 'antigravity' : 'gemini', account_label: null, credential: 'available',
      credential_source: subscription ? 'oauth' : 'env', credential_hint: null, credential_env: subscription ? null : 'GEMINI_API_KEY',
      supported_thinking: efforts, context_window: null, window_source: 'synthetic fixture', concurrency: null,
      slot_scope: id, capabilities: {}, capability_source: 'synthetic fixture', pricing: null, cost_basis: 'unknown', default: false,
    }
  })
  useStore.setState({ models, modelChoice: cases[0]!.id, session: null, thinking: null })
  await act(async () => root.render(createElement('div', null, createElement(AgentModelPicker), createElement(ThinkingChip))))
  const byId = (id: string): HTMLButtonElement => {
    const element = container.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)
    assert.ok(element, id)
    return element
  }
  await click(byId('model-picker'))
  const groups = [...container.querySelectorAll('.picker-group')]
  assert.deepEqual(groups.map((group) => group.querySelector('.picker-group-head')!.textContent), ['Antigravity', 'Google Gemini'])
  assert.deepEqual(groups.map((group) => group.querySelectorAll('[role="option"]').length), [5, 1])
  await click(byId(`model-option-${cases[0]!.id}`))
  for (const entry of cases) {
    await click(byId('model-picker'))
    await click(byId(`model-option-${entry.id}`))
    assert.equal(useStore.getState().modelChoice, entry.id)
    assert.equal(byId('model-current').textContent, entry.label)
    await click(byId('thinking-chip'))
    assert.deepEqual([...container.querySelectorAll('[data-testid^="thinking-option-"]')].map((element) => element.getAttribute('data-testid')), [
      'thinking-option-default', ...entry.efforts.map((effort) => `thinking-option-${effort}`),
    ], entry.id)
    for (const effort of entry.efforts) {
      await click(byId(`thinking-option-${effort}`))
      assert.equal(useStore.getState().thinking, effort)
      await click(byId('thinking-chip'))
    }
    await click(byId('thinking-option-default'))
    assert.equal(useStore.getState().thinking, null, `${entry.id} keeps the provider default distinct from an explicit choice`)
  }
  // A later entitlement refresh can narrow one subscription group without narrowing the identically named API route.
  await act(async () => useStore.setState({ models: models.map((model) => model.id === cases[0]!.id ? { ...model, supported_thinking: ['medium', 'high'] } : model), modelChoice: cases[0]!.id }))
  await click(byId('thinking-chip'))
  assert.equal(container.querySelector('[data-testid="thinking-option-low"]'), null)
  await click(byId('thinking-option-default'))
  await click(byId('model-picker'))
  await click(byId('model-option-google:gemini-4-argon'))
  await click(byId('thinking-chip'))
  assert.ok(byId('thinking-option-low'))
})
