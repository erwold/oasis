/** The app's theme: what the person chose (Settings › Appearance) and what the page draws.
 *
 *  A choice is one of light (the default), dark, claude or system; what the page draws is light, dark or claude, put
 *  on the root as `data-theme` (index.css keys every palette on it). System follows prefers-color-scheme and only
 *  ever resolves to light or dark; what it resolves to is never written back as the choice. The choice is kept in
 *  localStorage under THEME_STORAGE_KEY as the bare word; anything else there (an old or damaged value) reads as
 *  light, and a page with no storage keeps the choice for itself.
 *
 *  index.html carries the same reading as a tiny inline script that runs before the stylesheet paints, so the first
 *  frame is already in the right theme (tests/theme.test.ts runs that script against this module). The isolated
 *  previews' theme observer (uiThemeObserver.ts) sees `data-theme` change and passes the new tokens on. */

export const THEME_STORAGE_KEY = 'oasis-code.theme'
export const THEME_PREFERENCES = ['light', 'dark', 'claude', 'system'] as const
export type ThemePreference = (typeof THEME_PREFERENCES)[number]
export type ResolvedTheme = 'light' | 'dark' | 'claude'
export const DEFAULT_THEME: ThemePreference = 'light'
export const THEME_LABELS: Record<ThemePreference, string> = { light: 'Light', dark: 'Dark', claude: 'Claude', system: 'System' }
export const DARK_QUERY = '(prefers-color-scheme: dark)'

type StorageLike = { getItem(key: string): string | null; setItem(key: string, value: string): void }
type MediaQueryLike = {
  matches: boolean
  addEventListener?: (type: 'change', listener: () => void) => void
  removeEventListener?: (type: 'change', listener: () => void) => void
  addListener?: (listener: () => void) => void
  removeListener?: (listener: () => void) => void
}

export function parseThemePreference(raw: unknown): ThemePreference {
  return typeof raw === 'string' && (THEME_PREFERENCES as readonly string[]).includes(raw) ? (raw as ThemePreference) : DEFAULT_THEME
}

export function resolveTheme(preference: ThemePreference, prefersDark: boolean): ResolvedTheme {
  return preference === 'system' ? (prefersDark ? 'dark' : 'light') : preference
}

export function readThemePreference(storage: StorageLike | null): ThemePreference {
  try { return parseThemePreference(storage?.getItem(THEME_STORAGE_KEY) ?? null) } catch { return DEFAULT_THEME }
}

/** whether the choice was kept (false: no storage, or it refused) */
export function writeThemePreference(storage: StorageLike | null, preference: ThemePreference): boolean {
  if (!storage) return false
  try { storage.setItem(THEME_STORAGE_KEY, preference); return true } catch { return false }
}

export type ThemeEnv = {
  storage: StorageLike | null
  matchMedia: ((query: string) => MediaQueryLike) | null
  root: { dataset: Record<string, string | undefined> } | null
  /** another window of the same origin wrote the choice */
  onStorage?: (listener: (key: string | null, value: string | null) => void) => () => void
}

export type ThemeController = {
  preference(): ThemePreference
  resolved(): ResolvedTheme
  set(preference: ThemePreference): void
  subscribe(listener: () => void): () => void
  dispose(): void
}

export function defaultThemeEnv(): ThemeEnv {
  const g = globalThis as typeof globalThis & { localStorage?: Storage; document?: Document }
  let storage: StorageLike | null = null
  try { storage = g.localStorage ?? null } catch { storage = null }
  return {
    storage,
    matchMedia: typeof g.matchMedia === 'function' ? (q) => g.matchMedia(q) : null,
    root: g.document?.documentElement ?? null,
    onStorage: typeof g.addEventListener === 'function' ? (listener) => {
      const on = (e: StorageEvent) => listener(e.key, e.newValue)
      g.addEventListener('storage', on)
      return () => g.removeEventListener('storage', on)
    } : undefined,
  }
}

/** Reads the choice, draws it, and keeps drawing it: a system change re-resolves only while the choice is system. */
export function createThemeController(env: ThemeEnv = defaultThemeEnv()): ThemeController {
  let preference = readThemePreference(env.storage)
  let mql: MediaQueryLike | null = null
  try { mql = env.matchMedia ? env.matchMedia(DARK_QUERY) : null } catch { mql = null }
  const listeners = new Set<() => void>()
  const prefersDark = () => { try { return mql?.matches === true } catch { return false } }
  let resolved = resolveTheme(preference, prefersDark())
  const apply = () => {
    const next = resolveTheme(preference, prefersDark())
    const changed = next !== resolved
    resolved = next
    if (env.root && env.root.dataset.theme !== next) env.root.dataset.theme = next
    return changed
  }
  const notify = () => { for (const l of [...listeners]) l() }
  apply()
  const onSystem = () => { if (preference === 'system' && apply()) notify() }
  if (mql) {
    if (typeof mql.addEventListener === 'function') mql.addEventListener('change', onSystem)
    else mql.addListener?.(onSystem)
  }
  const offStorage = env.onStorage?.((key, value) => {
    if (key !== THEME_STORAGE_KEY && key !== null) return
    preference = parseThemePreference(key === null ? null : value)
    apply()
    notify()
  })
  return {
    preference: () => preference,
    resolved: () => resolved,
    set(next) {
      preference = parseThemePreference(next)
      writeThemePreference(env.storage, preference)
      apply()
      notify()
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    dispose() {
      listeners.clear()
      offStorage?.()
      if (mql) {
        if (typeof mql.removeEventListener === 'function') mql.removeEventListener('change', onSystem)
        else mql.removeListener?.(onSystem)
      }
    },
  }
}

let shared: ThemeController | null = null
/** the page's one controller, made on first use */
export function appTheme(): ThemeController {
  shared ??= createThemeController()
  return shared
}
