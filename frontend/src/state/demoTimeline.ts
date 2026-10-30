/** A short, declarative walkthrough animation: a script of scenes and cursor actions (move, click, type, set, wait),
 *  compiled to a timeline of frames — the moments something on the stage changes — and played by a controller that
 *  keeps one timer for the next frame only (no per-frame clock, no rAF, nothing while paused, held or reduced).
 *
 *  Nothing here knows what is drawn: a frame names the scene, the cursor's target (an element of the stage marked
 *  `data-demo-target`), whether it clicks, and the values the scene draws from (`set` and `type` write them). The
 *  stage component (components/DemoStage.tsx) draws the cursor and the controls; a feature's own module draws its
 *  scenes from the values. The page's conditions come in through bindDemoEnvironment (reduced motion, a hidden
 *  document, a stage off screen), each injectable: the tests run it without a DOM. */

export type DemoAction =
  | { do: 'scene'; id: string; label: string }
  | { do: 'move'; to: string; ms: number }
  | { do: 'click'; ms: number }
  | { do: 'type'; into: string; text: string; ms: number }
  | { do: 'set'; key: string; value: string }
  | { do: 'wait'; ms: number }

export type DemoScript = readonly DemoAction[]

/** The script's words, short: `scene` starts a scene (its label is the step's name in the controls). */
export const demo = {
  scene: (id: string, label: string): DemoAction => ({ do: 'scene', id, label }),
  move: (to: string, ms = 520): DemoAction => ({ do: 'move', to, ms }),
  click: (ms = 320): DemoAction => ({ do: 'click', ms }),
  type: (into: string, text: string, ms = Math.min(900, 40 * text.length)): DemoAction => ({ do: 'type', into, text, ms }),
  set: (key: string, value: string): DemoAction => ({ do: 'set', key, value }),
  wait: (ms: number): DemoAction => ({ do: 'wait', ms }),
}

export interface DemoFrame {
  /** when it starts (ms from the beginning) */
  readonly t: number
  /** its scene's index */
  readonly scene: number
  /** the element the cursor rests on or travels to (null: none yet) */
  readonly cursor: string | null
  /** how long the cursor's travel to it takes (0: it is already there) */
  readonly moveMs: number
  /** the cursor clicks at this frame */
  readonly click: boolean
  readonly values: Readonly<Record<string, string>>
}

export interface DemoScene { readonly id: string; readonly label: string; readonly start: number; readonly first: number; readonly last: number }

export interface DemoTimeline { readonly frames: readonly DemoFrame[]; readonly scenes: readonly DemoScene[]; readonly duration: number }

/** At most this many frames for one `type` (the text grows in chunks: the page renders a few times, not per letter). */
export const TYPE_STEPS = 10

export function compileDemo(script: DemoScript): DemoTimeline {
  if (!script.length || script[0]!.do !== 'scene') throw new Error('a demo script starts with a scene')
  const frames: DemoFrame[] = []
  const scenes: { id: string; label: string; start: number; first: number }[] = []
  let t = 0
  let cur: DemoFrame = { t: 0, scene: -1, cursor: null, moveMs: 0, click: false, values: {} }
  // a frame at the same moment as the last one of its scene replaces it (two `set`s in a row are one change); a
  // scene's first frame never replaces the one before (that is the last scene's finished picture)
  const push = (next: Omit<DemoFrame, 't'>, merge = true) => {
    const frame = { ...next, t }
    if (merge && frames.length && frames[frames.length - 1]!.t === t) {
      const last = frames[frames.length - 1]!
      frames[frames.length - 1] = { ...frame, click: frame.click || last.click, moveMs: frame.moveMs || last.moveMs }
    } else frames.push(frame)
    cur = frames[frames.length - 1]!
  }
  for (const a of script) {
    if (!(('ms' in a) ? Number.isFinite(a.ms) && a.ms >= 0 : true)) throw new Error(`a demo action's time is not a duration: ${JSON.stringify(a)}`)
    switch (a.do) {
      case 'scene':
        if (scenes.some((s) => s.id === a.id)) throw new Error(`two scenes are named ${a.id}`)
        scenes.push({ id: a.id, label: a.label, start: t, first: frames.length })
        push({ scene: scenes.length - 1, cursor: cur.cursor, moveMs: 0, click: false, values: cur.values }, false)
        break
      case 'move':
        push({ scene: cur.scene, cursor: a.to, moveMs: a.ms, click: false, values: cur.values })
        t += a.ms
        break
      case 'click':
        push({ scene: cur.scene, cursor: cur.cursor, moveMs: 0, click: true, values: cur.values })
        t += a.ms
        break
      case 'set':
        push({ scene: cur.scene, cursor: cur.cursor, moveMs: 0, click: false, values: { ...cur.values, [a.key]: a.value } })
        break
      case 'type': {
        const n = Math.max(1, Math.min(TYPE_STEPS, a.text.length))
        for (let i = 1; i <= n; i += 1) {
          push({ scene: cur.scene, cursor: cur.cursor, moveMs: 0, click: false, values: { ...cur.values, [a.into]: a.text.slice(0, Math.ceil((a.text.length * i) / n)) } })
          t += a.ms / n
        }
        break
      }
      case 'wait':
        t += a.ms
        break
    }
  }
  const done = scenes.map((s, i) => ({ ...s, last: i + 1 < scenes.length ? scenes[i + 1]!.first - 1 : frames.length - 1 }))
  return { frames, scenes: done, duration: t }
}

/** The frame showing at `t` (the last one that started at or before it). */
export function frameAt(timeline: DemoTimeline, t: number): number {
  const { frames } = timeline
  let lo = 0
  let hi = frames.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (frames[mid]!.t <= t) lo = mid
    else hi = mid - 1
  }
  return lo
}

export interface DemoClock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export type DemoStatus = 'playing' | 'paused' | 'ended'
export type DemoHold = 'hidden' | 'offscreen'

/** What the stage draws; the same object until something changes. `running`: the timeline advances now. `jump`: the
 *  last change was a step the person chose (drawn at once, without travel), not playback. */
export interface DemoSnapshot {
  readonly frame: number
  readonly scene: number
  readonly status: DemoStatus
  readonly reduced: boolean
  readonly held: boolean
  readonly running: boolean
  readonly jump: boolean
}

export interface DemoPlayer {
  readonly timeline: DemoTimeline
  snapshot(): DemoSnapshot
  subscribe(listener: () => void): () => void
  play(): void
  pause(): void
  toggle(): void
  replay(): void
  goTo(scene: number): void
  step(delta: number): void
  hold(reason: DemoHold, on: boolean): void
  setReduced(on: boolean): void
  dispose(): void
  readonly disposed: boolean
}

/** Plays a timeline once and stops at its end (no loop). Paused, held (hidden, off screen) or reduced: no timer at
 *  all, and the time spent so does not count — it resumes where it stopped. Reduced motion shows each scene as its
 *  finished picture, chosen with the steps; it never advances on its own. */
export function createDemoPlayer(timeline: DemoTimeline, clock: DemoClock, opts: { reduced?: boolean; autoplay?: boolean } = {}): DemoPlayer {
  const last = timeline.frames.length - 1
  let pos = 0
  let base = 0
  let timer: unknown = null
  let status: DemoStatus = 'paused'
  let reduced = opts.reduced === true
  let frame = 0
  let jump = false
  let disposed = false
  const holds = new Set<DemoHold>()
  const listeners = new Set<() => void>()
  let snap: DemoSnapshot = make()

  function make(): DemoSnapshot {
    return { frame, scene: timeline.frames[frame]!.scene, status, reduced, held: holds.size > 0, running: running(), jump }
  }
  function running() { return !disposed && status === 'playing' && !reduced && holds.size === 0 }
  function emit() {
    const next = make()
    if (next.frame === snap.frame && next.status === snap.status && next.reduced === snap.reduced && next.held === snap.held && next.running === snap.running && next.jump === snap.jump) return
    snap = next
    for (const l of [...listeners]) l()
  }
  function stopTimer() { if (timer !== null) { clock.clearTimeout(timer); timer = null } }
  /** the timer for the next frame (or the end), from where the timeline is now */
  function schedule() {
    stopTimer()
    if (!running()) return
    const next = frame < last ? timeline.frames[frame + 1]!.t : timeline.duration
    timer = clock.setTimeout(tick, Math.max(0, next - pos))
  }
  function tick() {
    timer = null
    if (!running()) return
    pos = Math.min(timeline.duration, clock.now() - base)
    frame = frameAt(timeline, pos)
    jump = false
    if (pos >= timeline.duration) { frame = last; status = 'ended' }
    emit()
    schedule()
  }
  /** stop the clock where it is (pos keeps the time played) */
  function freeze() { if (running()) pos = Math.min(timeline.duration, clock.now() - base); stopTimer() }
  function thaw() { if (running()) { base = clock.now() - pos; schedule() } }
  function show(scene: number, finished: boolean) {
    const s = timeline.scenes[scene]!
    frame = finished ? s.last : s.first
    pos = finished ? (scene + 1 < timeline.scenes.length ? timeline.scenes[scene + 1]!.start : timeline.duration) : s.start
    jump = true
  }

  const player: DemoPlayer = {
    timeline,
    snapshot: () => snap,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    play() {
      if (disposed || reduced) return
      if (status === 'ended') { player.replay(); return }
      if (status === 'playing') return
      status = 'playing'
      thaw()
      emit()
    },
    pause() {
      if (disposed || status !== 'playing') return
      freeze()
      status = 'paused'
      emit()
    },
    toggle() { if (status === 'playing') player.pause(); else player.play() },
    replay() {
      if (disposed) return
      freeze()
      if (reduced) { show(0, true); status = 'paused'; emit(); return }
      pos = 0; frame = 0; jump = true; status = 'playing'
      thaw()
      emit()
    },
    goTo(scene) {
      if (disposed) return
      const i = Math.max(0, Math.min(timeline.scenes.length - 1, Math.trunc(scene)))
      freeze()
      // playing: that scene from its start; paused, ended or reduced: its finished picture (play goes on from there)
      if (status === 'playing' && !reduced) { show(i, false); thaw() } else { show(i, true); status = 'paused' }
      emit()
    },
    step(delta) { player.goTo(timeline.frames[frame]!.scene + delta) },
    hold(reason, on) {
      if (disposed || holds.has(reason) === on) return
      freeze()
      if (on) holds.add(reason); else holds.delete(reason)
      thaw()
      emit()
    },
    setReduced(on) {
      if (disposed || reduced === on) return
      freeze()
      reduced = on
      if (on) { show(timeline.frames[frame]!.scene, true); if (status === 'playing') status = 'paused' }
      emit()
    },
    dispose() { disposed = true; stopTimer(); listeners.clear() },
    get disposed() { return disposed },
  }
  if (reduced) show(0, true)
  snap = make()
  if (opts.autoplay !== false && !reduced) player.play()
  return player
}

/** What bindDemoEnvironment reads of the page; each part may be missing (then that condition is never seen). */
export interface DemoEnvironment {
  matchMedia?: ((query: string) => { matches: boolean; addEventListener?: (type: 'change', l: () => void) => void; removeEventListener?: (type: 'change', l: () => void) => void } | null) | null
  document?: { hidden: boolean; addEventListener(type: 'visibilitychange', l: () => void): void; removeEventListener(type: 'visibilitychange', l: () => void): void } | null
  IntersectionObserver?: (new (cb: (entries: { isIntersecting: boolean }[]) => void) => { observe(el: Element): void; disconnect(): void }) | null
  element?: Element | null
}

export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

/** The page's conditions onto the player, followed as they change: reduced motion (the system setting, at once),
 *  a hidden document, a stage scrolled out of view. Returns the undo: every listener and observer gone. */
export function bindDemoEnvironment(player: DemoPlayer, env: DemoEnvironment): () => void {
  const undo: (() => void)[] = []
  let mql: ReturnType<NonNullable<DemoEnvironment['matchMedia']>> = null
  try { mql = env.matchMedia ? env.matchMedia(REDUCED_MOTION_QUERY) : null } catch { mql = null }
  if (mql) {
    const m = mql
    const onChange = () => player.setReduced(m.matches)
    onChange()
    if (m.addEventListener) { m.addEventListener('change', onChange); undo.push(() => m.removeEventListener?.('change', onChange)) }
  }
  const doc = env.document
  if (doc) {
    const onVisibility = () => player.hold('hidden', doc.hidden)
    onVisibility()
    doc.addEventListener('visibilitychange', onVisibility)
    undo.push(() => doc.removeEventListener('visibilitychange', onVisibility))
  }
  if (env.IntersectionObserver && env.element) {
    // off screen until the observer's first answer says otherwise: no clock starts for a stage opened out of view
    player.hold('offscreen', true)
    const io = new env.IntersectionObserver((entries) => {
      const e = entries[entries.length - 1]
      if (e) player.hold('offscreen', !e.isIntersecting)
    })
    io.observe(env.element)
    undo.push(() => io.disconnect())
  }
  return () => { for (const u of undo.splice(0)) u() }
}
