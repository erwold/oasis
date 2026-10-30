/** Watching the host's look while an isolated preview runs, apart from React and from what a theme holds.
 *
 *  A preview's frame gets the host's theme twice: once inside its srcdoc (the snapshot taken when the run starts,
 *  never changed after) and then, while it runs, as a message whenever the host's look changes — the system's light
 *  or dark switching (prefers-color-scheme), the app's theme (data-theme), or a class or inline style on the root or body element. A change never
 *  rebuilds the document: the frame, its script, its inputs, focus, scroll and state stay as they are.
 *
 *  This module does not know what a theme is made of: `read` gives one (the host's resolved tokens, in practice
 *  state/uiTheme.ts's readUiHostTheme), and two themes are the same when their JSON is. Changes are coalesced to one
 *  read per animation frame and only a theme different from the last one reported is reported again. */

export const HOST_THEME_QUERY = '(prefers-color-scheme: dark)'
/** the root's and the body's attributes whose change may change the resolved tokens */
export const HOST_THEME_ATTRIBUTES: readonly string[] = ['class', 'style', 'data-theme']

type MediaQueryLike = {
  addEventListener?: (type: 'change', listener: () => void) => void
  removeEventListener?: (type: 'change', listener: () => void) => void
  /** older engines */
  addListener?: (listener: () => void) => void
  removeListener?: (listener: () => void) => void
}
type MutationObserverLike = { observe(target: Node, options: MutationObserverInit): void; disconnect(): void }
type MutationObserverCtor = new (callback: () => void) => MutationObserverLike

/** What the observer touches of the page; each part is injectable (tests run without a DOM). */
export type ThemeObserverEnv = {
  matchMedia: ((query: string) => MediaQueryLike) | null
  /** the elements whose class and style are watched (root, body); a missing one is skipped */
  targets: () => ReadonlyArray<Node | null | undefined>
  MutationObserver: MutationObserverCtor | null
  requestFrame: (cb: () => void) => unknown
  cancelFrame: (handle: unknown) => void
}

export type HostThemeObserver<T> = {
  /** read now (a pending frame's read is folded into this one) and report if it changed */
  sync(): void
  /** the last theme read (the initial one until a change) */
  current(): T
  /** every listener, observer and pending frame gone; nothing is reported after */
  dispose(): void
}

/** The comparison key of a theme: its JSON ('' for something that has none). */
export function themeKey(theme: unknown): string {
  try { return JSON.stringify(theme) ?? '' } catch { return '' }
}

export function defaultThemeObserverEnv(): ThemeObserverEnv {
  const g = globalThis as typeof globalThis & { document?: Document }
  const raf = typeof g.requestAnimationFrame === 'function' ? g.requestAnimationFrame.bind(g) : null
  const caf = typeof g.cancelAnimationFrame === 'function' ? g.cancelAnimationFrame.bind(g) : null
  return {
    matchMedia: typeof g.matchMedia === 'function' ? (q) => g.matchMedia(q) : null,
    targets: () => (g.document ? [g.document.documentElement, g.document.body] : []),
    MutationObserver: typeof g.MutationObserver === 'function' ? (g.MutationObserver as unknown as MutationObserverCtor) : null,
    requestFrame: raf ? (cb) => raf(cb) : (cb) => setTimeout(cb, 16),
    cancelFrame: caf ? (h) => caf(h as number) : (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  }
}

export function observeHostTheme<T>(opts: { read: () => T; initial: T; onChange: (theme: T) => void; env?: Partial<ThemeObserverEnv> }): HostThemeObserver<T> {
  const env: ThemeObserverEnv = { ...defaultThemeObserverEnv(), ...opts.env }
  let last = opts.initial
  let lastKey = themeKey(opts.initial)
  let frame: unknown = null
  let pending = false
  let disposed = false

  const check = () => {
    if (disposed) return
    let next: T
    try { next = opts.read() } catch { return }
    const key = themeKey(next)
    if (key === lastKey) return
    last = next
    lastKey = key
    opts.onChange(next)
  }
  const schedule = () => {
    if (disposed || pending) return
    pending = true
    frame = env.requestFrame(() => { if (!pending) return; pending = false; frame = null; check() })
  }
  const cancel = () => {
    if (!pending) return
    pending = false
    try { env.cancelFrame(frame) } catch { /* already run */ }
    frame = null
  }

  let mql: MediaQueryLike | null = null
  try { mql = env.matchMedia ? env.matchMedia(HOST_THEME_QUERY) : null } catch { mql = null }
  if (mql) {
    if (typeof mql.addEventListener === 'function') mql.addEventListener('change', schedule)
    else mql.addListener?.(schedule)
  }

  let mo: MutationObserverLike | null = null
  if (env.MutationObserver) {
    try {
      mo = new env.MutationObserver(schedule)
      for (const t of env.targets()) if (t) mo.observe(t, { attributes: true, attributeFilter: [...HOST_THEME_ATTRIBUTES] })
    } catch { mo?.disconnect(); mo = null }
  }

  return {
    sync() { if (disposed) return; cancel(); check() },
    current: () => last,
    dispose() {
      if (disposed) return
      disposed = true
      cancel()
      mo?.disconnect()
      if (mql) {
        if (typeof mql.removeEventListener === 'function') mql.removeEventListener('change', schedule)
        else mql.removeListener?.(schedule)
      }
    },
  }
}

export type ThemeSender<T> = {
  /** the host's latest theme (from the observer): posted at once when the frame is ready, else held */
  update(theme: T): void
  /** the frame said ready: the latest theme goes out if it is not the one its document was built with */
  ready(): void
  /** the run ended (stop, read-only, unmount): nothing is posted after */
  close(): void
}

/** What one running frame is told of the host's theme: nothing before its bootstrap says ready (the srcdoc already
 *  holds the run's initial snapshot), then the latest theme whenever it differs from the last one the frame got — a
 *  change between the snapshot and ready included, and never the same theme twice. `post` sends one theme message;
 *  `allowed` is checked before every post (a run that turned read-only posts nothing). */
export function themeSender<T>(opts: { initial: T; post: (theme: T) => void; allowed: () => boolean }): ThemeSender<T> {
  let latest = opts.initial
  let sentKey = themeKey(opts.initial)
  let isReady = false
  let closed = false
  const flush = () => {
    if (closed || !isReady || !opts.allowed()) return
    const key = themeKey(latest)
    if (key === sentKey) return
    try { opts.post(latest) } catch { return }
    sentKey = key
  }
  return {
    update(theme) { latest = theme; flush() },
    ready() { isReady = true; flush() },
    close() { closed = true },
  }
}
