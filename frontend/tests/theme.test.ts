/** The app's theme (state/theme.ts) without a DOM: the default, what is kept and how a damaged or missing store reads,
 *  System following the system only while it is the choice and never written back as one; and index.html's boot
 *  script, run as the page runs it, drawing the same theme as the module for every choice and system scheme. */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'
import {
  createThemeController, DEFAULT_THEME, parseThemePreference, readThemePreference, resolveTheme, THEME_PREFERENCES, THEME_STORAGE_KEY,
  writeThemePreference, type ThemeEnv,
} from '../src/state/theme.ts'

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v) } }
}
const brokenStorage = { getItem: () => { throw new Error('SecurityError') }, setItem: () => { throw new Error('QuotaExceededError') } }

function fakeSystem(dark: boolean) {
  const listeners = new Set<() => void>()
  const mql = { matches: dark, addEventListener: (_t: 'change', l: () => void) => listeners.add(l), removeEventListener: (_t: 'change', l: () => void) => listeners.delete(l) }
  return { mql, listeners, flip(next: boolean) { mql.matches = next; for (const l of [...listeners]) l() } }
}

function env(opts: { stored?: string; dark?: boolean; storage?: ThemeEnv['storage'] } = {}) {
  const storage = opts.storage !== undefined ? opts.storage : memoryStorage(opts.stored === undefined ? {} : { [THEME_STORAGE_KEY]: opts.stored })
  const system = fakeSystem(opts.dark ?? false)
  const root = { dataset: {} as Record<string, string | undefined> }
  let storageListener: ((key: string | null, value: string | null) => void) | null = null
  const e: ThemeEnv = { storage, matchMedia: () => system.mql, root, onStorage: (l) => { storageListener = l; return () => { storageListener = null } } }
  return { e, storage, system, root, fireStorage: (k: string | null, v: string | null) => storageListener?.(k, v) }
}

test('light is the default; only the four words are choices, anything else reads as light', () => {
  assert.equal(DEFAULT_THEME, 'light')
  assert.deepEqual([...THEME_PREFERENCES], ['light', 'dark', 'claude', 'system'])
  for (const p of THEME_PREFERENCES) assert.equal(parseThemePreference(p), p)
  for (const bad of [null, undefined, '', 'Dark', ' dark', 'atelier', '"dark"', '{"theme":"dark"}', 42, {}]) assert.equal(parseThemePreference(bad), 'light', String(bad))
  assert.equal(readThemePreference(null), 'light')
  assert.equal(readThemePreference(brokenStorage), 'light', 'a store that throws reads as light')
  assert.equal(readThemePreference(memoryStorage({ [THEME_STORAGE_KEY]: 'corrupt\u0000' })), 'light')
  assert.equal(writeThemePreference(null, 'dark'), false)
  assert.equal(writeThemePreference(brokenStorage, 'dark'), false)
})

test('system resolves to light or dark only; the explicit themes stand as they are', () => {
  assert.equal(resolveTheme('system', false), 'light')
  assert.equal(resolveTheme('system', true), 'dark')
  for (const dark of [false, true]) {
    assert.equal(resolveTheme('light', dark), 'light')
    assert.equal(resolveTheme('dark', dark), 'dark')
    assert.equal(resolveTheme('claude', dark), 'claude')
  }
})

test('a first start draws light on the root, even with the system dark, and writes nothing', () => {
  const f = env({ dark: true })
  const c = createThemeController(f.e)
  assert.equal(c.preference(), 'light')
  assert.equal(f.root.dataset.theme, 'light')
  assert.equal((f.storage as ReturnType<typeof memoryStorage>).data.size, 0)
  c.dispose()
})

test('a choice is kept and drawn; a new controller (the app started again) reads it back', () => {
  const f = env()
  const c = createThemeController(f.e)
  let told = 0
  c.subscribe(() => told++)
  for (const p of ['dark', 'claude', 'light'] as const) {
    c.set(p)
    assert.equal(f.root.dataset.theme, p)
    assert.equal(f.storage!.getItem(THEME_STORAGE_KEY), p)
  }
  assert.equal(told, 3)
  c.set('claude')
  c.dispose()
  const again = createThemeController({ ...f.e, root: { dataset: {} } })
  assert.equal(again.preference(), 'claude')
  assert.equal(again.resolved(), 'claude')
  again.dispose()
})

test('system follows the system while it is the choice; what it resolves to is never saved as the choice', () => {
  const f = env({ stored: 'system', dark: false })
  const c = createThemeController(f.e)
  let told = 0
  c.subscribe(() => told++)
  assert.equal(f.root.dataset.theme, 'light')
  f.system.flip(true)
  assert.equal(f.root.dataset.theme, 'dark')
  assert.equal(c.resolved(), 'dark')
  assert.equal(c.preference(), 'system')
  assert.equal(f.storage!.getItem(THEME_STORAGE_KEY), 'system', 'the stored choice stays system')
  f.system.flip(false)
  assert.equal(f.root.dataset.theme, 'light')
  assert.equal(told, 2)
  c.dispose()
  assert.equal(f.system.listeners.size, 0, 'nothing left listening')
})

test('an explicit choice is not overridden when the system changes', () => {
  for (const p of ['light', 'dark', 'claude'] as const) {
    const f = env({ stored: p, dark: false })
    const c = createThemeController(f.e)
    let told = 0
    c.subscribe(() => told++)
    f.system.flip(true)
    f.system.flip(false)
    f.system.flip(true)
    assert.equal(f.root.dataset.theme, p, `${p} stays`)
    assert.equal(told, 0)
    c.dispose()
  }
})

test('no store (or one that refuses): the choice still holds for the page; a damaged value starts as light', () => {
  const f = env({ storage: brokenStorage, dark: true })
  const c = createThemeController(f.e)
  assert.equal(c.preference(), 'light')
  c.set('dark')
  assert.equal(f.root.dataset.theme, 'dark')
  assert.equal(c.preference(), 'dark')
  c.dispose()
  const g = env({ stored: 'midnight' })
  const d = createThemeController(g.e)
  assert.equal(g.root.dataset.theme, 'light')
  d.dispose()
})

test('another window writing the choice is followed; a cleared store goes back to light', () => {
  const f = env({ stored: 'dark' })
  const c = createThemeController(f.e)
  f.fireStorage('unrelated', 'x')
  assert.equal(f.root.dataset.theme, 'dark')
  f.fireStorage(THEME_STORAGE_KEY, 'claude')
  assert.equal(f.root.dataset.theme, 'claude')
  f.fireStorage(THEME_STORAGE_KEY, 'garbage')
  assert.equal(f.root.dataset.theme, 'light')
  f.fireStorage(null, null)
  assert.equal(c.preference(), 'light')
  c.dispose()
})

test("index.html's boot script draws what the module draws, before the app runs, for every stored value and system scheme", () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  const script = /<script id="theme-boot">([\s\S]*?)<\/script>/.exec(html)?.[1]
  assert.ok(script, 'index.html carries the boot script')
  assert.ok(html.indexOf('id="theme-boot"') < html.indexOf('<body'), 'it runs in the head, before the body paints')
  const stored: Array<string | null | 'THROW'> = [null, 'light', 'dark', 'claude', 'system', 'atelier', '', 'THROW']
  for (const value of stored) {
    for (const dark of [false, true]) {
      const root = { dataset: {} as Record<string, string> }
      const localStorage = { getItem: (k: string) => { if (value === 'THROW') throw new Error('denied'); return k === THEME_STORAGE_KEY ? value : null } }
      const window = { matchMedia: (q: string) => ({ matches: q === '(prefers-color-scheme: dark)' && dark }) }
      vm.runInNewContext(script!, { document: { documentElement: root }, localStorage, window })
      const storage = value === 'THROW' ? brokenStorage : memoryStorage(value === null ? {} : { [THEME_STORAGE_KEY]: value })
      const want = resolveTheme(readThemePreference(storage), dark)
      assert.equal(root.dataset.theme, want, `stored ${String(value)}, system ${dark ? 'dark' : 'light'}`)
    }
  }
  // no matchMedia at all (an old engine): system reads as light
  const root = { dataset: {} as Record<string, string> }
  vm.runInNewContext(script!, { document: { documentElement: root }, localStorage: { getItem: () => 'system' }, window: {} })
  assert.equal(root.dataset.theme, 'light')
})
