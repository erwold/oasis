import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { bindDemoEnvironment, createDemoPlayer, type DemoFrame, type DemoPlayer, type DemoSnapshot, type DemoTimeline } from '../state/demoTimeline'
import { ChevronLeftIcon, ChevronRightIcon, PauseIcon, PlayIcon, RotateCcwIcon, XIcon } from './icons'
import './DemoStage.css'

/** A walkthrough's stage: the scenes a feature draws (`scene`), a cursor that travels to the element of the scene
 *  marked `data-demo-target`, and the controls — previous, play/pause, next, a dot per step, replay, close. It plays
 *  once when it opens and stops at the end. The drawing is a picture: inert and hidden from assistive technology; the
 *  step's name is announced when the step changes, never per frame.
 *
 *  Escape (anywhere in the dialog it sits in) closes the stage only (the caller puts the focus back). While nothing
 *  runs — paused, ended, reduced motion, a hidden page, scrolled out of view — no timer is set and the stage's CSS
 *  animations and transitions are paused where they are; reduced motion draws each step finished, without motion. */
export function DemoStage({ timeline, scene, label, onClose, testId = 'demo-stage' }: {
  timeline: DemoTimeline
  scene: (id: string, frame: DemoFrame) => ReactNode
  label: string
  onClose: () => void
  testId?: string
}) {
  const root = useRef<HTMLDivElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const cursor = useRef<HTMLSpanElement>(null)
  const [player, setPlayer] = useState<DemoPlayer | null>(null)
  const snap = useSyncExternalStore(player ? player.subscribe : noSubscribe, player ? player.snapshot : () => staticSnapshot(timeline), () => staticSnapshot(timeline))

  // one player per opening: made, bound to the page and playing; disposed (no timer, no listener) when it closes
  useEffect(() => {
    const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const p = createDemoPlayer(timeline, { now: () => performance.now(), setTimeout: (fn, ms) => window.setTimeout(fn, ms), clearTimeout: (h) => window.clearTimeout(h as number) }, { reduced, autoplay: false })
    const unbind = bindDemoEnvironment(p, {
      matchMedia: typeof window.matchMedia === 'function' ? (q) => window.matchMedia(q) : null,
      document,
      IntersectionObserver: typeof IntersectionObserver === 'function' ? IntersectionObserver : null,
      element: root.current,
    })
    p.play()
    setPlayer(p)
    return () => { unbind(); p.dispose() }
  }, [timeline])

  const frame = timeline.frames[snap.frame]!
  const sceneId = timeline.scenes[snap.scene]!.id
  const instant = snap.jump || snap.reduced

  // the cursor onto its target, measured once per frame (layout offsets: a scene's entrance transform is not counted)
  useLayoutEffect(() => {
    const el = cursor.current
    const box = stage.current
    if (!el || !box || !frame.cursor) return
    const target = box.querySelector<HTMLElement>(`[data-demo-target="${CSS.escape(frame.cursor)}"]`)
    if (!target) return
    let x = target.offsetWidth * 0.62
    let y = target.offsetHeight * 0.58
    for (let n: HTMLElement | null = target; n && n !== box; n = n.offsetParent as HTMLElement | null) { x += n.offsetLeft; y += n.offsetTop }
    el.style.transitionDuration = instant ? '0ms' : `${frame.moveMs}ms`
    el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`
    el.dataset.at = frame.cursor
  }, [frame, instant])

  // the CSS's own motion follows the timeline: what is moving is frozen where it is while nothing runs, and only
  // that is set going again (a finished entrance or click stays finished: it never plays twice)
  const frozen = useRef<Animation[]>([])
  useLayoutEffect(() => {
    const box = root.current
    if (!box || typeof box.getAnimations !== 'function') return
    if (!snap.running) {
      for (const a of box.getAnimations({ subtree: true })) if (a.playState === 'running') { a.pause(); frozen.current.push(a) }
    } else {
      for (const a of frozen.current.splice(0)) if (a.playState === 'paused') a.play()
    }
  }, [snap.running])

  // Escape closes the stage before it reaches the dialog around it
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // an input method composing (Escape cancels the composition) keeps its key
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return
      const box = root.current
      const scope = box?.closest('dialog') ?? document.body
      if (!box || !(event.target instanceof Node) || !scope.contains(event.target)) return
      event.preventDefault()
      event.stopPropagation()
      close.current()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [])

  const playing = snap.status === 'playing'
  const scenes = timeline.scenes
  return (
    <div ref={root} className="demo" role="group" aria-label={label} data-testid={testId}
         data-scene={sceneId} data-frame={snap.frame} data-status={snap.status} data-running={snap.running}
         data-reduced={snap.reduced} data-held={snap.held}>
      <div ref={stage} className="demo-stage" aria-hidden="true" inert data-instant={instant || undefined}>
        <div key={sceneId} className="demo-scene">{scene(sceneId, frame)}</div>
        <span ref={cursor} className="demo-cursor">
          <svg width="14" height="18" viewBox="0 0 14 18"><path d="M1 1v14.2l3.6-3.4 2.5 5.5 2.4-1.1-2.5-5.4H12L1 1Z" /></svg>
          {frame.click && !instant && <i key={snap.frame} className="demo-click" />}
        </span>
      </div>
      <div className="demo-bar">
        <button type="button" className="demo-btn" aria-label="Previous step" disabled={snap.scene === 0} onClick={() => player?.step(-1)} data-testid="demo-prev"><ChevronLeftIcon size={13} /></button>
        {!snap.reduced && (
          <button type="button" className="demo-btn" aria-label={playing ? 'Pause' : snap.status === 'ended' ? 'Play again' : 'Play'} onClick={() => player?.toggle()} data-testid="demo-play">
            {playing ? <PauseIcon size={12} /> : <PlayIcon size={12} />}
          </button>
        )}
        <button type="button" className="demo-btn" aria-label="Next step" disabled={snap.scene === scenes.length - 1} onClick={() => player?.step(1)} data-testid="demo-next"><ChevronRightIcon size={13} /></button>
        <span className="demo-dots">
          {scenes.map((s, i) => (
            <button key={s.id} type="button" className="demo-dot" aria-label={`Step ${i + 1} of ${scenes.length}: ${s.label}`}
                    aria-current={i === snap.scene ? 'step' : undefined} onClick={() => player?.goTo(i)} data-testid="demo-dot" />
          ))}
        </span>
        <span className="demo-step" aria-live="polite" data-testid="demo-step">{scenes[snap.scene]!.label}</span>
        <button type="button" className="demo-btn" aria-label="Replay" onClick={() => player?.replay()} data-testid="demo-replay"><RotateCcwIcon size={12} /></button>
        <button type="button" className="demo-btn" aria-label="Close demo" onClick={() => close.current()} data-testid="demo-close"><XIcon size={13} /></button>
      </div>
    </div>
  )
}

const noSubscribe = () => () => {}
const statics = new WeakMap<DemoTimeline, DemoSnapshot>()
/** before the player exists (and on the server): the first frame, still — one object per timeline */
function staticSnapshot(timeline: DemoTimeline): DemoSnapshot {
  let s = statics.get(timeline)
  if (!s) { s = { frame: 0, scene: 0, status: 'paused', reduced: false, held: false, running: false, jump: true }; statics.set(timeline, s) }
  return s
}
