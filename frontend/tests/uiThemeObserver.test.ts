/** The host-theme observer (state/uiThemeObserver.ts) without a DOM: what makes it read, that it reads once a frame,
 *  reports a changed theme only, and leaves nothing behind. */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HOST_THEME_ATTRIBUTES, HOST_THEME_QUERY, observeHostTheme, themeKey, themeSender, type ThemeObserverEnv } from '../src/state/uiThemeObserver.ts'

type Theme = { scheme: string; tokens: Record<string, string> }

function fakeEnv(opts: { legacyMql?: boolean } = {}) {
  const mqlListeners = new Set<() => void>()
  const queries: string[] = []
  const observed: Array<{ target: unknown; options: MutationObserverInit }> = []
  const observers: Array<{ cb: () => void; connected: boolean }> = []
  const frames = new Map<number, () => void>()
  let nextFrame = 1
  const mql = opts.legacyMql
    ? { addListener: (l: () => void) => mqlListeners.add(l), removeListener: (l: () => void) => mqlListeners.delete(l) }
    : { addEventListener: (_t: 'change', l: () => void) => mqlListeners.add(l), removeEventListener: (_t: 'change', l: () => void) => mqlListeners.delete(l) }
  class FakeMO {
    rec: { cb: () => void; connected: boolean }
    constructor(cb: () => void) { this.rec = { cb, connected: true }; observers.push(this.rec) }
    observe(target: unknown, options: MutationObserverInit) { observed.push({ target, options }) }
    disconnect() { this.rec.connected = false }
  }
  const root = { name: 'html' }, body = { name: 'body' }
  const env: ThemeObserverEnv = {
    matchMedia: (q) => { queries.push(q); return mql },
    targets: () => [root as unknown as Node, body as unknown as Node],
    MutationObserver: FakeMO as unknown as ThemeObserverEnv['MutationObserver'],
    requestFrame: (cb) => { const id = nextFrame++; frames.set(id, cb); return id },
    cancelFrame: (h) => { frames.delete(h as number) },
  }
  return {
    env, queries, observed, observers, frames, root, body, mqlListeners,
    schemeChange: () => { for (const l of [...mqlListeners]) l() },
    mutate: () => { for (const o of observers) if (o.connected) o.cb() },
    runFrames: () => { const now = [...frames.values()]; frames.clear(); for (const f of now) f() },
  }
}

const light: Theme = { scheme: 'light', tokens: { '--surface': 'oklch(1 0 0)', '--ink': 'oklch(0.2 0 0)' } }
const dark: Theme = { scheme: 'dark', tokens: { '--surface': 'oklch(0.21 0 0)', '--ink': 'oklch(0.93 0 0)' } }

test('listens to the colour-scheme query and to class/style/data-theme on the root and the body, nothing else', () => {
  const f = fakeEnv()
  const obs = observeHostTheme({ read: () => light, initial: light, onChange: () => {}, env: f.env })
  assert.deepEqual(f.queries, [HOST_THEME_QUERY])
  assert.equal(f.mqlListeners.size, 1)
  assert.deepEqual(f.observed.map((o) => o.target), [f.root, f.body])
  for (const o of f.observed) {
    assert.equal(o.options.subtree, undefined)
    assert.equal(o.options.childList, undefined)
    assert.deepEqual(o.options, { attributes: true, attributeFilter: [...HOST_THEME_ATTRIBUTES] })
  }
  assert.deepEqual([...HOST_THEME_ATTRIBUTES], ['class', 'style', 'data-theme'], 'the theme choice (data-theme on the root) is watched too')
  obs.dispose()
})

test('a change is read once per frame and reported only when the theme differs from the last one', () => {
  const f = fakeEnv()
  let current: Theme = light
  let reads = 0
  const seen: Theme[] = []
  const obs = observeHostTheme({ read: () => { reads++; return current }, initial: light, onChange: (t) => seen.push(t), env: f.env })
  assert.equal(reads, 0, 'nothing read at start: the initial snapshot is the run\'s')

  // a class change that changes nothing: read, not reported
  f.mutate(); f.mutate(); f.mutate()
  assert.equal(f.frames.size, 1, 'a burst is one frame')
  f.runFrames()
  assert.equal(reads, 1)
  assert.deepEqual(seen, [])

  // the system turns dark: reported once, even with a style mutation in the same frame
  current = dark
  f.schemeChange(); f.mutate()
  f.runFrames()
  assert.deepEqual(seen, [dark])
  assert.equal(obs.current(), dark)

  // the same theme again (a new object, the same JSON): not reported
  current = JSON.parse(JSON.stringify(dark)) as Theme
  f.schemeChange(); f.runFrames()
  assert.equal(seen.length, 1)

  // and back
  current = light
  f.mutate(); f.runFrames()
  assert.deepEqual(seen, [dark, light])
  obs.dispose()
})

test('sync reads now, folds a pending frame into it, and reports only a change', () => {
  const f = fakeEnv()
  let current: Theme = light
  const seen: Theme[] = []
  const obs = observeHostTheme({ read: () => current, initial: light, onChange: (t) => seen.push(t), env: f.env })
  obs.sync()
  assert.deepEqual(seen, [])
  current = dark
  f.mutate()
  assert.equal(f.frames.size, 1)
  obs.sync()
  assert.deepEqual(seen, [dark])
  assert.equal(f.frames.size, 0, 'the pending frame is cancelled')
  f.runFrames()
  assert.deepEqual(seen, [dark])
  obs.dispose()
})

test('dispose removes the listener, disconnects the observer, cancels the frame; nothing is reported after', () => {
  const f = fakeEnv()
  let current: Theme = light
  const seen: Theme[] = []
  const obs = observeHostTheme({ read: () => current, initial: light, onChange: (t) => seen.push(t), env: f.env })
  current = dark
  f.mutate()
  assert.equal(f.frames.size, 1)
  obs.dispose()
  obs.dispose()   // twice is fine (StrictMode, a stop and an unmount)
  assert.equal(f.mqlListeners.size, 0)
  assert.ok(f.observers.every((o) => !o.connected))
  assert.equal(f.frames.size, 0)
  f.schemeChange(); f.mutate(); f.runFrames(); obs.sync()
  assert.deepEqual(seen, [])
})

test('older MediaQueryList (addListener) is listened to and let go of the same way', () => {
  const f = fakeEnv({ legacyMql: true })
  let current: Theme = light
  const seen: Theme[] = []
  const obs = observeHostTheme({ read: () => current, initial: light, onChange: (t) => seen.push(t), env: f.env })
  assert.equal(f.mqlListeners.size, 1)
  current = dark
  f.schemeChange(); f.runFrames()
  assert.deepEqual(seen, [dark])
  obs.dispose()
  assert.equal(f.mqlListeners.size, 0)
})

test('without matchMedia or MutationObserver it still works by sync; a read that throws reports nothing', () => {
  let current: Theme = light
  let fail = false
  const seen: Theme[] = []
  const obs = observeHostTheme({
    read: () => { if (fail) throw new Error('no style'); return current },
    initial: light, onChange: (t) => seen.push(t),
    env: { matchMedia: null, MutationObserver: null, targets: () => [], requestFrame: () => 0, cancelFrame: () => {} },
  })
  fail = true
  current = dark
  obs.sync()
  assert.deepEqual(seen, [])
  fail = false
  obs.sync()
  assert.deepEqual(seen, [dark])
  obs.dispose()
})

test('themeKey: JSON, or empty for what has none', () => {
  assert.equal(themeKey({ a: 1 }), '{"a":1}')
  assert.equal(themeKey(undefined), '')
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  assert.equal(themeKey(cyclic), '')
})

test('the sender: nothing before ready, the latest theme at ready only if it changed since the snapshot, never twice', () => {
  const posted: Theme[] = []
  let allowed = true
  const s = themeSender<Theme>({ initial: light, post: (t) => posted.push(t), allowed: () => allowed })
  s.update(dark)
  assert.deepEqual(posted, [], 'the frame is not ready yet')
  s.update(light)
  s.ready()
  assert.deepEqual(posted, [], 'back to the snapshot before ready: the frame already has it')
  s.update(dark)
  assert.deepEqual(posted, [dark])
  s.update(JSON.parse(JSON.stringify(dark)) as Theme)
  s.ready()
  assert.deepEqual(posted, [dark], 'the same theme is not sent again, a second ready included')
  allowed = false
  s.update(light)
  assert.deepEqual(posted, [dark], 'a run that turned read-only posts nothing')
  allowed = true
  s.close()
  s.update(light); s.ready()
  assert.deepEqual(posted, [dark], 'closed')
})

test('the sender: a change between the snapshot and ready goes out at ready; a failed post is tried again', () => {
  const posted: Theme[] = []
  let fail = true
  const s = themeSender<Theme>({ initial: light, post: (t) => { if (fail) throw new Error('gone'); posted.push(t) }, allowed: () => true })
  s.update(dark)
  s.ready()
  assert.deepEqual(posted, [])
  fail = false
  s.update(dark)
  assert.deepEqual(posted, [dark])
})
