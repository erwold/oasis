import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import ts from 'typescript'
import { JSDOM } from 'jsdom'
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
const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://ui.invalid/' })
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true })
const { createElement, act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { WebSearchCard } = await import('../src/components/AccountsPanel.tsx')
const { api } = await import('../src/api/client.ts')

const rowOf = (host: HTMLElement, name: string) => [...host.querySelectorAll('.acct-row2')].find((r) => r.querySelector('strong')?.textContent === name) as HTMLElement
const click = (el: Element | null) => act(async () => { (el as HTMLElement).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
}

test('the engines are rows like the accounts: the one in use says so, Use saves another at once, DeepSeek without a key asks for it and is used once it is saved', async () => {
  const oldGet = api.getWebSearch, oldSave = api.saveWebSearch
  api.getWebSearch = async () => ({ engine: 'automatic' })
  const saved: unknown[] = [], keys: string[] = []
  api.saveWebSearch = async (value) => { saved.push(value); return value }
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(createElement(WebSearchCard, { local: true, keyRow: null, busy: false, onSaveKey: async (key: string) => { keys.push(key) } })))
    assert.deepEqual([...host.querySelectorAll('.acct-row2 strong')].map((n) => n.textContent), ['Automatic', 'Web', 'DeepSeek'])
    assert.match(rowOf(host, 'Automatic').textContent!, /In use/)
    assert.match(rowOf(host, 'DeepSeek').textContent!, /No key/)
    assert.equal(host.querySelector('select'), null)
    assert.equal(host.querySelector('input'), null)
    await click(host.querySelector('[data-testid="web-search-use-web"]'))
    assert.deepEqual(saved, [{ engine: 'web' }])
    assert.match(rowOf(host, 'Web').textContent!, /In use/)
    assert.doesNotMatch(rowOf(host, 'Automatic').textContent!, /In use/)
    await click(host.querySelector('[data-testid="web-search-add-key"]'))
    const input = host.querySelector('[data-testid="web-search-key"]') as HTMLInputElement
    assert.equal(input.type, 'password')
    await act(async () => type(input, ' sk-synthetic '))
    await act(async () => { input.form!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })) })
    assert.deepEqual(keys, ['sk-synthetic'])
    assert.deepEqual(saved, [{ engine: 'web' }, { engine: 'deepseek' }])
    assert.equal(host.querySelector('[data-testid="web-search-key"]'), null)
    assert.match(rowOf(host, 'DeepSeek').textContent!, /In use/)
  } finally { await act(async () => root.unmount()); host.remove(); api.getWebSearch = oldGet; api.saveWebSearch = oldSave }
})

test('remote settings are read-only and fetch errors do not expose response text', async () => {
  const oldGet = api.getWebSearch
  api.getWebSearch = async () => { throw new Error('secret upstream text') }
  const host = document.createElement('div'); const root = createRoot(host)
  try {
    await act(async () => root.render(createElement(WebSearchCard, { local: false, keyRow: null, busy: false, onSaveKey: async () => {} })))
    assert.ok([...host.querySelectorAll('button')].every((b) => b.disabled))
    assert.match(host.textContent!, /Could not load/)
    assert.doesNotMatch(host.textContent!, /secret upstream/)
  } finally { await act(async () => root.unmount()); api.getWebSearch = oldGet }
})
