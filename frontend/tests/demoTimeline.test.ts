/** The walkthrough player (state/demoTimeline.ts) on a fake clock, its page bindings on fake media queries, document
 *  and IntersectionObserver, the Remote access script, and both stages rendered (a non-Remote one too: the player and
 *  stage are not Remote access's own). */

import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL?.includes('/frontend/src/') && !/\.[a-z]+$/i.test(specifier)) {
      for (const ext of ['.ts', '.tsx']) {
        const candidate = new URL(`${specifier}${ext}`, context.parentURL)
        if (existsSync(candidate)) return next(candidate.href, context)
      }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (/\.(css|png|svg)$/.test(url)) return { format: 'module', source: `export default ${JSON.stringify(url)}`, shortCircuit: true }
    if (url.startsWith('file:') && url.endsWith('.tsx')) {
      const file = fileURLToPath(url)
      const out = ts.transpileModule(readFileSync(file, 'utf8'), { fileName: file, compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } })
      return { format: 'module', source: out.outputText, shortCircuit: true }
    }
    return next(url, context)
  },
})

const { bindDemoEnvironment, compileDemo, createDemoPlayer, demo, frameAt, TYPE_STEPS } = await import('../src/state/demoTimeline.ts')
const { REMOTE_DEMO_SCRIPT, REMOTE_DEMO_URL } = await import('../src/state/remoteDemoScript.ts')
type Player = ReturnType<typeof createDemoPlayer>

/** A clock whose time moves only when the test says; its timers are counted. */
function fakeClock() {
  let now = 0
  let id = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  return {
    clock: {
      now: () => now,
      setTimeout: (fn: () => void, ms: number) => { const i = ++id; timers.set(i, { at: now + ms, fn }); return i },
      clearTimeout: (h: unknown) => { timers.delete(h as number) },
    },
    pending: () => timers.size,
    made: () => id,
    advance(ms: number) {
      const end = now + ms
      for (;;) {
        let next: [number, { at: number; fn: () => void }] | null = null
        for (const entry of timers) if (entry[1].at <= end && (!next || entry[1].at < next[1].at)) next = entry
        if (!next) break
        timers.delete(next[0])
        now = next[1].at
        next[1].fn()
      }
      now = end
    },
  }
}

/** Not Remote access: a file dropped into an upload box, said in the same few words. */
const UPLOAD = compileDemo([
  demo.scene('pick', 'Choose a file'),
  demo.move('browse', 400), demo.click(), demo.set('picked', 'report.pdf'), demo.wait(300),
  demo.scene('send', 'Send it'),
  demo.move('note', 300), demo.click(), demo.type('note', 'for review', 400), demo.move('send', 300), demo.click(), demo.set('sent', '1'), demo.wait(500),
])
const values = (p: Player) => p.timeline.frames[p.snapshot().frame]!.values

test('a script compiles to frames on its change points: scenes, a move travels, a click, typing in a few chunks, set values', () => {
  assert.deepEqual(UPLOAD.scenes.map((s) => [s.id, s.label]), [['pick', 'Choose a file'], ['send', 'Send it']])
  assert.equal(UPLOAD.duration, 400 + 320 + 300 + 300 + 320 + 400 + 300 + 320 + 500)
  const first = UPLOAD.frames[UPLOAD.scenes[0]!.first]!
  assert.deepEqual([first.t, first.scene, first.cursor], [0, 0, 'browse'], 'a move at the scene start is its first frame')
  assert.equal(first.moveMs, 400)
  const typing = [...new Set(UPLOAD.frames.flatMap((f) => (f.values.note === undefined ? [] : [f.values.note])))]
  assert.equal(typing.at(-1), 'for review')
  assert.ok(typing.length <= TYPE_STEPS, 'typing renders in chunks, not per letter')
  assert.ok(UPLOAD.frames.every((f, i) => i === 0 || f.t >= UPLOAD.frames[i - 1]!.t), 'frames in time order')
  const pickDone = UPLOAD.frames[UPLOAD.scenes[0]!.last]!
  assert.equal(pickDone.values.picked, 'report.pdf', "a scene's last frame is its finished picture")
  assert.equal(frameAt(UPLOAD, UPLOAD.duration + 10), UPLOAD.frames.length - 1)
  assert.throws(() => compileDemo([demo.move('x')]), /starts with a scene/)
  assert.throws(() => compileDemo([demo.scene('a', 'A'), demo.scene('a', 'B')]), /two scenes/)
  assert.throws(() => compileDemo([demo.scene('a', 'A'), demo.wait(-1)]), /not a duration/)
})

test('the player plays once with one timer at a time, stops at the end (no loop, no timer left), and replays on request', () => {
  const c = fakeClock()
  const p = createDemoPlayer(UPLOAD, c.clock)
  assert.equal(p.snapshot().status, 'playing')
  assert.equal(c.pending(), 1)
  const seen = new Set<number>()
  p.subscribe(() => seen.add(p.snapshot().frame))
  for (let t = 0; t < UPLOAD.duration + 2000; t += 50) { c.advance(50); assert.ok(c.pending() <= 1) }
  assert.equal(p.snapshot().status, 'ended')
  assert.equal(c.pending(), 0, 'nothing scheduled after the end')
  assert.equal(values(p).sent, '1')
  assert.ok(seen.size >= UPLOAD.frames.length - 3, 'every change point was shown (frames at one instant are folded)')
  const timersMade = c.made()
  c.advance(60_000)
  assert.equal(c.made(), timersMade, 'an ended walkthrough sets no timer: it does not loop')
  p.play()   // play at the end: from the beginning
  assert.deepEqual([p.snapshot().status, p.snapshot().frame], ['playing', 0])
  p.replay()
  assert.equal(p.snapshot().frame, 0)
})

test('paused or held (a hidden page, off screen): no timer, the frame stays, and the time away is not counted on resume', () => {
  const c = fakeClock()
  const p = createDemoPlayer(UPLOAD, c.clock)
  c.advance(500)
  const at = p.snapshot().frame
  p.pause()
  assert.equal(c.pending(), 0)
  c.advance(10_000)
  assert.equal(p.snapshot().frame, at)
  p.play()
  c.advance(10)
  assert.equal(p.snapshot().frame, at, 'resumes where it stopped, not 10 s later')
  p.hold('hidden', true)
  assert.deepEqual([c.pending(), p.snapshot().held, p.snapshot().running, p.snapshot().status], [0, true, false, 'playing'])
  c.advance(30_000)
  p.hold('offscreen', true)
  p.hold('hidden', false)
  assert.equal(c.pending(), 0, 'still off screen')
  p.hold('offscreen', false)
  assert.equal(c.pending(), 1)
  c.advance(UPLOAD.duration - 500 - 10 - 1)
  assert.notEqual(p.snapshot().status, 'ended', 'the hidden 30 s did not count')
  c.advance(2)
  assert.equal(p.snapshot().status, 'ended')
})

test('reduced motion: never a timer; each step drawn finished, chosen with previous, next and the dots; a change mid-play stops at once', () => {
  const c = fakeClock()
  const r = createDemoPlayer(UPLOAD, c.clock, { reduced: true })
  assert.deepEqual([c.made(), r.snapshot().status, r.snapshot().frame], [0, 'paused', UPLOAD.scenes[0]!.last])
  r.play(); r.toggle()
  assert.equal(c.made(), 0, 'play does nothing under reduced motion')
  r.step(1)
  assert.deepEqual([r.snapshot().scene, r.snapshot().frame], [1, UPLOAD.scenes[1]!.last])
  assert.equal(values(r).sent, '1')
  r.step(5); assert.equal(r.snapshot().scene, 1)
  r.goTo(0); assert.equal(r.snapshot().frame, UPLOAD.scenes[0]!.last)
  r.replay(); assert.equal(r.snapshot().scene, 0)
  assert.equal(c.made(), 0)

  const c2 = fakeClock()
  const p = createDemoPlayer(UPLOAD, c2.clock)
  c2.advance(1100)   // inside the second scene (it starts at 1020 ms)
  p.setReduced(true)
  assert.equal(c2.pending(), 0, 'the timer is gone at once')
  assert.deepEqual([p.snapshot().scene, p.snapshot().frame, p.snapshot().status], [1, UPLOAD.scenes[1]!.last, 'paused'])
  p.setReduced(false)
  assert.equal(c2.pending(), 0, 'motion allowed again: it waits for play')
})

test('steps while playing restart that scene; while paused show it finished; the snapshot is one object until something changes', () => {
  const c = fakeClock()
  const p = createDemoPlayer(UPLOAD, c.clock)
  p.goTo(1)
  assert.deepEqual([p.snapshot().frame, p.snapshot().status, p.snapshot().jump], [UPLOAD.scenes[1]!.first, 'playing', true])
  p.pause()
  p.step(-1)
  assert.equal(p.snapshot().frame, UPLOAD.scenes[0]!.last)
  const a = p.snapshot()
  p.pause(); p.hold('hidden', false); p.setReduced(false)
  assert.equal(p.snapshot(), a, 'no change, the same object (a React external store)')
  p.play()
  c.advance(UPLOAD.scenes[1]!.start - UPLOAD.scenes[0]!.start)
  assert.equal(p.snapshot().scene, 1, 'play goes on from the finished step to the next one')
})

test('dispose: no timer, no listener called, every call after it is nothing', () => {
  const c = fakeClock()
  const p = createDemoPlayer(UPLOAD, c.clock)
  let calls = 0
  p.subscribe(() => { calls += 1 })
  p.dispose()
  assert.equal(c.pending(), 0)
  p.play(); p.replay(); p.goTo(1); p.hold('hidden', true); p.setReduced(true)
  c.advance(60_000)
  assert.deepEqual([calls, c.pending(), c.made(), p.disposed], [0, 0, 1, true])
})

test("the page's conditions: reduced motion followed live, a hidden document, off screen until the observer's first answer; undo removes all", () => {
  const c = fakeClock()
  const p = createDemoPlayer(UPLOAD, c.clock, { autoplay: false })
  const mq = { matches: false, ls: new Set<() => void>(), addEventListener(_: 'change', l: () => void) { this.ls.add(l) }, removeEventListener(_: 'change', l: () => void) { this.ls.delete(l) } }
  const doc = { hidden: false, ls: new Set<() => void>(), addEventListener(_: 'visibilitychange', l: () => void) { this.ls.add(l) }, removeEventListener(_: 'visibilitychange', l: () => void) { this.ls.delete(l) } }
  let observed: ((e: { isIntersecting: boolean }[]) => void) | null = null
  let disconnected = 0
  class IO { constructor(cb: (e: { isIntersecting: boolean }[]) => void) { observed = cb } observe() {} disconnect() { disconnected += 1 } }
  const queries: string[] = []
  const undo = bindDemoEnvironment(p, { matchMedia: (q) => { queries.push(q); return mq }, document: doc, IntersectionObserver: IO, element: {} as Element })
  assert.deepEqual(queries, ['(prefers-reduced-motion: reduce)'])
  p.play()
  assert.deepEqual([p.snapshot().held, c.pending()], [true, 0], 'no clock before the observer has answered')
  observed!([{ isIntersecting: true }])
  assert.deepEqual([p.snapshot().running, c.pending()], [true, 1])
  doc.hidden = true; for (const l of doc.ls) l()
  assert.equal(c.pending(), 0)
  doc.hidden = false; for (const l of doc.ls) l()
  observed!([{ isIntersecting: false }])
  assert.equal(c.pending(), 0)
  observed!([{ isIntersecting: true }])
  mq.matches = true; for (const l of mq.ls) l()
  assert.deepEqual([p.snapshot().reduced, c.pending()], [true, 0])
  undo()
  assert.deepEqual([mq.ls.size, doc.ls.size, disconnected], [0, 0, 1])
  // nothing to bind to: the player still works
  const q = createDemoPlayer(UPLOAD, fakeClock().clock)
  bindDemoEnvironment(q, {})()
  assert.equal(q.snapshot().running, true)
})

test("Remote access's script: ChatGPT's own steps in order, a New chat before Work, a reserved placeholder address with /mcp/current", () => {
  const t = compileDemo(REMOTE_DEMO_SCRIPT)
  assert.deepEqual(t.scenes.map((s) => s.id), ['oasis', 'plugins', 'server', 'risk', 'install', 'work'])
  const targets = REMOTE_DEMO_SCRIPT.flatMap((a) => (a.do === 'move' ? [a.to] : []))
  const order = ['toggle', 'copy', 'nav-plugins', 'plus', 'add-custom', 'name', 'desc', 'server-url', 'auth', 'risk', 'create', 'plugin-card', 'install', 'new-chat', 'tab-work', 'composer', 'mention-item']
  assert.deepEqual(targets, order)
  // every move is followed by a click: the cursor points at what it presses
  REMOTE_DEMO_SCRIPT.forEach((a, i) => { if (a.do === 'move') assert.equal(REMOTE_DEMO_SCRIPT[i + 1]!.do, 'click', `a click after the move to ${a.to}`) })
  const end = t.frames.at(-1)!.values
  assert.equal(end.name, 'oasis-code')
  assert.equal(end.prompt, '@')
  assert.equal(end.picked, '1')
  assert.equal(REMOTE_DEMO_URL, 'https://demo.invalid/key/mcp/current')
  const url = new URL(REMOTE_DEMO_URL)
  assert.equal(url.protocol, 'https:')
  assert.match(url.hostname, /\.invalid$/, 'a name reserved never to resolve')
  assert.match(url.pathname, /\/mcp\/current$/)
  assert.ok(t.duration >= 20_000 && t.duration <= 40_000, `a readable pace: ${t.duration} ms for six steps`)
  for (const s of t.scenes) assert.ok(s.label.length <= 40, `a step's name stays short: ${s.label}`)
})

const { renderToStaticMarkup } = await import('react-dom/server')
const { createElement } = await import('react')
const { DemoStage } = await import('../src/components/DemoStage.tsx')
const RemoteAccessDemo = (await import('../src/components/RemoteAccessDemo.tsx')).default

/** tags that take the keyboard's focus */
const focusable = (html: string) => html.match(/<(button|a|input|select|textarea)\b|tabindex="0"/g) ?? []

test('the stage (any feature’s): the picture inert and hidden from assistive technology, the controls named; the step announced, not each frame', () => {
  const html = renderToStaticMarkup(createElement(DemoStage, {
    timeline: UPLOAD, label: 'Upload demo', onClose: () => {}, testId: 'upload-demo',
    scene: (id: string, f: { values: Readonly<Record<string, string>> }) => createElement('div', { 'data-demo-target': 'browse' }, `${id}:${f.values.picked ?? 'none'}`),
  }))
  assert.match(html, /role="group" aria-label="Upload demo" data-testid="upload-demo"/)
  const stage = /<div class="demo-stage" aria-hidden="true" inert=""[^>]*>([\s\S]*?)<div class="demo-bar">/.exec(html)
  assert.ok(stage, 'the picture is aria-hidden and inert')
  assert.equal(focusable(stage![1]!).length, 0, 'nothing in the picture takes focus')
  assert.match(stage![1]!, /pick:none/)
  for (const name of ['Previous step', 'Play', 'Next step', 'Step 1 of 2: Choose a file', 'Step 2 of 2: Send it', 'Replay', 'Close demo']) assert.ok(html.includes(`aria-label="${name}"`), name)
  assert.match(html, /aria-live="polite" data-testid="demo-step">Choose a file</)
  assert.equal((html.match(/aria-live/g) ?? []).length, 1)
})

test("Remote access's drawing: ChatGPT's labels, only the placeholder address, nothing focusable in the picture", () => {
  const html = renderToStaticMarkup(createElement(RemoteAccessDemo, { onClose: () => {} }))
  assert.match(html, /data-testid="remote-demo"/)
  assert.ok(html.includes(REMOTE_DEMO_URL))
  assert.doesNotMatch(html, /trycloudflare|ngrok|127\.0\.0\.1/)
  const stage = /<div class="demo-stage" aria-hidden="true" inert=""[^>]*>([\s\S]*?)<div class="demo-bar">/.exec(html)!
  assert.equal(focusable(stage[1]!).length, 0)
  assert.match(html, /Turn on/)
})

test("the walkthrough's stylesheets name only their own classes and keyframes: none is the app's (they load into the whole page)", () => {
  const dir = new URL('../src/', import.meta.url)
  const sheets = (d: URL): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? sheets(new URL(`${e.name}/`, d)) : e.name.endsWith('.css') ? [fileURLToPath(new URL(e.name, d))] : [])
  const classes = (css: string) => new Set([...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\.([a-zA-Z_][\w-]*)/g)].map((m) => m[1]!).filter((c) => !/^\d/.test(c)))
  const keyframes = (css: string) => new Set([...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]!))
  const own = ['components/DemoStage.css', 'components/RemoteAccessDemo.css'].map((f) => fileURLToPath(new URL(f, dir)))
  const others = sheets(dir).filter((f) => !own.includes(f))
  assert.ok(others.some((f) => f.endsWith('index.css')))
  const theirs = new Set(others.flatMap((f) => [...classes(readFileSync(f, 'utf8'))]))
  const theirFrames = new Set(others.flatMap((f) => [...keyframes(readFileSync(f, 'utf8'))]))
  for (const f of own) {
    const css = readFileSync(f, 'utf8')
    // a state class (is-on, is-done…) only ever follows one of the walkthrough's own classes
    const mine = [...classes(css)].filter((c) => !c.startsWith('is-'))
    for (const c of mine) {
      assert.match(c, /^(demo|rdemo-)/, `${c}: the walkthrough's prefix`)
      assert.ok(!theirs.has(c), `.${c} is also the app's class`)
    }
    for (const k of keyframes(css)) assert.ok(!theirFrames.has(k) && /^(demo|rdemo-)/.test(k), `@keyframes ${k}`)
    for (const rule of css.replace(/\/\*[\s\S]*?\*\//g, '').split('}')) {
      const sel = rule.split('{')[0]!.trim()
      if (!sel || sel.startsWith('@') || sel.startsWith('from') || sel.startsWith('to')) continue
      for (const part of sel.split(',')) assert.match(part.trim(), /^\.(demo|rdemo-)/, `the rule "${part.trim()}" starts at one of the walkthrough's own classes`)
    }
  }
})
