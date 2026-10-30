/** The isolated HTML preview of a UI surface (kind 'html'): the model's HTML in an opaque-origin iframe that only may
 *  run scripts, behind a strict CSP, started by the person (Run) and stoppable (Stop, Reset). The host never puts the
 *  HTML into its own DOM: it travels as the iframe's srcdoc and nowhere else. What the frame may say back is data —
 *  a bounded state, the id of an action the person clicked, and its task calls (run, stop, tasks) — checked here
 *  against this instance's window and nonce. The two ways an action id comes back act differently:
 *  - oasisUI.action(id): a proposal. The owner puts the action's prompt into a draft for the person to review and
 *    send; nothing is sent or started by it.
 *  - oasisUI.run(id, …) (`tasks`, bridge v2): a start. For an action the surface declares with mode `run`, called in
 *    the person's click, the host checks the call (judgeRun: the declared `run` action, the click, the pace, the
 *    input's bounds), hands the click's state to the owner and starts that action's agent task through it at once —
 *    no draft in between — then answers the frame's call with the task's result when the task ends, or with a
 *    refusal at once. Every update of the surface's tasks is posted to the frame while it runs (what is under way
 *    when it says ready, first). The task's status is the harness's: nothing here reads it from how the frame
 *    answers, and a frame stopped or reloaded meanwhile changes nothing of the task (a new frame finds it with
 *    tasks() and onTask).
 *
 *  The host's look goes in as data: a run's srcdoc carries the theme read when it started (readUiHostTheme, never
 *  changed for that run), and while it runs a change of the host's theme is posted as a theme message — the frame is
 *  not rebuilt, its state not reported, no action taken. The rules live in state/uiSandbox.ts and state/uiTheme.ts,
 *  the watching in state/uiThemeObserver.ts; docs/intelligent-ui.md says what they do and do not guarantee.
 *
 *  On its own the preview draws its own card and title; `embedded` in a surface that has both (UiSurface), it draws
 *  neither and puts its controls into the surface's header (`controlsHost`).
 *
 *  Host precondition: the page that mounts this component must itself forbid frames from loading anything
 *  (`frame-src 'none'` in its CSP, as the app's index.html does). That is what blocks the frame navigating itself —
 *  the one request the frame's own CSP cannot stop. Mounted on a page without it, the frame can still issue that
 *  navigation (the host then notices and stops it, after the fact), and the info text above overstates the case.
 *  The component does not detect or adapt to the host's CSP. */

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FocusEvent } from 'react'
import { createPortal } from 'react-dom'
import { uiTaskRefusal, type UiTaskResult, type UiTaskUpdate, type UiTaskView } from '@oasis-code/contract'
import {
  buildSrcdoc, checkBridgeMessage, clampHeight, htmlTooLarge, judgeAction, judgeRun, makeNonce, MessageBudget, pingMessage, runRefusal,
  sanitizeInitialState, STOP_REASON_TEXT, taskMessage, themeMessage, UI_SANDBOX_ALLOW, UI_SANDBOX_ATTR, UI_SANDBOX_CHANNEL,
  UI_SANDBOX_LIMITS, watchdogVerdict, type StopReason, type TaskHostMessage, type UiSandboxState,
} from '../state/uiSandbox'
import { readUiHostTheme, type UiHostTheme } from '../state/uiTheme'
import { observeHostTheme, themeSender } from '../state/uiThemeObserver'
import { ShieldIcon } from './icons'
import './ui-sandbox.css'

/** What the frame's tasks are done with: the owner's (a surface's tasks, state/uiTasks.ts). */
export interface HtmlTaskBridge {
  /** the surface's actions with their modes: only a `run` one starts a task */
  actions: readonly { id: string; mode?: 'draft' | 'run' }[]
  /** start the task with the click's state and input; `started` hears its id first; resolves once, never rejects */
  run: (actionId: string, state: Record<string, unknown>, input: unknown, started: (taskId: string) => void) => Promise<UiTaskResult>
  stop: (taskId: string) => Promise<boolean>
  list: () => Promise<UiTaskView[]>
  /** every update of the surface's tasks; the function returned stops listening */
  subscribe: (listener: (update: UiTaskUpdate) => void) => () => void
  /** what is under way now (for a frame that just said ready) */
  current: () => UiTaskUpdate[]
}

export type IntelligentHtmlProps = {
  html: string
  title: string
  initialState?: Record<string, unknown>
  /** replay, a finished transcript someone else owns, …: the HTML is not run; the fallback stands instead */
  readOnly?: boolean
  /** the frame's state, coalesced (UI_SANDBOX_LIMITS.stateDebounceMs) — the owner persists it */
  onStateChange?: (state: Record<string, unknown>) => void
  /** the person clicked an action in the preview: a proposal for the owner to put into a draft, not a send */
  onAction?: (actionId: string, state: Record<string, unknown>) => void
  /** the surface's plain-text fallback, shown whenever the preview is not running */
  fallback?: string
  /** the action ids the surface declares; any other id from the frame is refused */
  actionIds?: readonly string[]
  /** run without the person's click. Off by default and nothing in the app turns it on: where the browser runs the
   *  frame on the page's thread a long loop in it holds the page; a read-only preview (a replay) never runs anyway */
  autoRun?: boolean
  /** drawn inside a surface that has its own card and title: no card, no title of its own */
  embedded?: boolean
  /** with embedded: the element (in the surface's header) the Run / Stop / Reset controls are drawn into */
  controlsHost?: HTMLElement | null
  /** the surface's tasks (oasisUI.run / stop / tasks / onTask); absent, run() is refused as unavailable */
  tasks?: HtmlTaskBridge
}

/** one frame: its nonce, the HTML and state it was built with, and the host's theme when it started (the srcdoc's;
 *  later changes travel as messages, never into a new srcdoc) */
type Run = { nonce: string; html: string; state: UiSandboxState; theme: UiHostTheme }
type Status = 'idle' | 'running' | 'stopped' | 'read-only' | 'too-large'

/** The person's account of how it runs, in the app: the app's page allows no frame to load another address
 *  (frame-src 'none'), so the preview's own attempts to load or navigate are blocked; the frame cannot reach the
 *  app's page, files, sign-ins or tools. Not a claim about every browser engine, nor a CPU bound (see CPU_HINT);
 *  the in-frame WebRTC removal is best effort and stays in docs/intelligent-ui.md. */
const INFO_TEXT = 'Runs in an isolated frame that cannot reach oasis-code’s page, your files, your sign-ins or any tool. The app blocks the preview from loading outside content or navigating to another address.'
/** What the watchdog can and cannot do: it runs on the app's page, so it only acts while that page is responsive. Where
 *  the browser runs the frame on the page's own thread, a script that never ends holds the watchdog and the Stop
 *  control too (docs/intelligent-ui.md, "CPU"). */
const CPU_HINT = 'When the app remains responsive, an unresponsive preview is stopped. In some browsers, a long script can freeze this tab, including its Stop control.'

/** Chrome's credentialless iframe: its requests — including a self-navigation, which the frame's own CSP cannot stop (the app page's parent
 *  `frame-src 'none'` policy is what blocks that HTTP navigation) — carry none of the host
 *  site's cookies (measured: a SameSite=None cookie goes along without it; the backend's own SameSite=Strict cookie
 *  does not go along either way). React treats the attribute as a boolean; engines without it ignore it. */
const CREDENTIALLESS = { credentialless: true } as Record<string, boolean>

function hostActivation(): boolean | null {
  const ua = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation
  return ua ? ua.isActive : null
}

/** The host's theme as an intelligent-UI surface's content sees it (the `.uis` scope of index.css: Atelier's face,
 *  radii, shadows and accent over the page's palette), sent to the frame through the same allowlist. */
const readSurfaceTheme = () => readUiHostTheme(document, { scope: 'uis' })

export function IntelligentHtml(props: IntelligentHtmlProps) {
  const { html, title, readOnly = false, fallback, autoRun = false, embedded = false, controlsHost = null } = props
  const tooLarge = useMemo(() => htmlTooLarge(html), [html])
  /** whether a frame may exist at all — decided in render, so the very commit that turns read-only (a replay, a
   *  transcript) or too large has no iframe, no bridge and no callback; a frame never outlives it */
  const canRun = !readOnly && !tooLarge
  const allowed = useRef(canRun)
  allowed.current = canRun
  const initialKey = useMemo(() => { try { return JSON.stringify(props.initialState ?? {}) } catch { return '' } }, [props.initialState])
  const initial = useMemo(() => sanitizeInitialState(props.initialState), [initialKey])
  const latest = useRef<UiSandboxState>(initial.state)
  const callbacks = useRef({ onStateChange: props.onStateChange, onAction: props.onAction, actionIds: props.actionIds, tasks: props.tasks })
  callbacks.current = { onStateChange: props.onStateChange, onAction: props.onAction, actionIds: props.actionIds, tasks: props.tasks }

  const [run, setRun] = useState<Run | null>(() => (autoRun && canRun ? { nonce: makeNonce(), html, state: initial.state, theme: readSurfaceTheme() } : null))
  const [stopReason, setStopReason] = useState<StopReason | null>(null)
  const [height, setHeight] = useState<number>(UI_SANDBOX_LIMITS.defaultHeight)
  const [rejects, setRejects] = useState<{ count: number; last: string }>({ count: 0, last: '' })
  /** every refused message of this instance, all frames together; shown at most once a heartbeat (a flood must
   *  not become a render flood) or at once for an action */
  const refused = useRef({ count: 0, last: '' })
  const [proposed, setProposed] = useState<string | null>(null)
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const infoId = useId()
  const [infoOpen, setInfoOpen] = useState(false)

  const start = useCallback((state: UiSandboxState) => {
    latest.current = state
    setStopReason(null)
    setProposed(null)
    setRun({ nonce: makeNonce(), html, state, theme: readSurfaceTheme() })
  }, [html])

  // while nothing runs, the stored state is the one to start from (a refresh, the owner's save coming back)
  useEffect(() => { if (!run) latest.current = initial.state }, [initial])
  // a new revision of the HTML while it runs: a new frame (a new nonce) with the state the person has now
  useEffect(() => { if (run && run.html !== html) setRun({ nonce: makeNonce(), html, state: latest.current, theme: readSurfaceTheme() }) }, [html, run])
  // read-only or too large: the run is dropped in this very render (its nonce with it — running again later is a new
  // frame), and nothing below renders or listens for it
  if (!canRun && run) setRun(null)
  const live = canRun ? run : null

  // built once per run (nonce, html, state and theme are the run's and never change for it)
  const srcdoc = useMemo(() => (live ? buildSrcdoc(live.html, { nonce: live.nonce, state: live.state, theme: live.theme }) : ''), [live])

  // the bridge, one per frame: attached before the frame can load (layout effect), gone with it
  useLayoutEffect(() => {
    if (!live) return
    const nonce = live.nonce
    const frame = frameRef.current
    if (!frame) return
    const budget = new MessageBudget()
    const startedAt = performance.now()
    let lastTick = startedAt
    let ready = false
    let loaded = false
    let lastPong: number | null = null
    let seq = 0
    let loads = 0
    let lastActionAt: number | null = null
    let ended = false
    let pending: UiSandboxState | null = null
    let stateTimer: ReturnType<typeof setTimeout> | undefined
    let readyTimer: ReturnType<typeof setTimeout> | undefined
    let unhear: (() => void) | null = null
    // to this frame only, while it runs; a frame gone meanwhile misses nothing of the task (it goes on in the harness)
    const post = (m: TaskHostMessage) => {
      if (ended || !allowed.current) return
      try { frame.contentWindow?.postMessage(taskMessage(nonce, m), '*') } catch { /* gone */ }
    }
    // the host's theme while this frame runs: posted after ready, on a change, never the same twice; never a new srcdoc
    const theme = themeSender<UiHostTheme>({
      initial: live.theme,
      allowed: () => !ended && allowed.current,
      post: (t) => {
        const w = frame.contentWindow
        if (!w) throw new Error('no frame window')   // not sent: tried again with the next change
        w.postMessage(themeMessage(nonce, t), '*')
      },
    })
    const watcher = observeHostTheme<UiHostTheme>({ read: readSurfaceTheme, initial: live.theme, onChange: (t) => theme.update(t) })

    const flush = () => {
      clearTimeout(stateTimer)
      stateTimer = undefined
      if (pending) { const s = pending; pending = null; if (allowed.current) callbacks.current.onStateChange?.(s) }
    }
    const showRefused = () => setRejects((r) => (r.count === refused.current.count && r.last === refused.current.last ? r : { ...refused.current }))
    const reject = (reason: string, now = false) => {
      refused.current = { count: refused.current.count + 1, last: reason }
      if (now) showRefused()
    }
    const stop = (reason: StopReason) => {
      if (ended) return
      ended = true
      unhear?.(); unhear = null
      theme.close()
      watcher.dispose()
      flush()
      setRun((r) => (r && r.nonce === nonce ? null : r))
      setStopReason(reason)
      showRefused()
    }

    const onMessage = (event: MessageEvent) => {
      if (ended || !allowed.current) return
      // ours or nothing. Other previews on the page speak on the same channel with their own nonces: not for this
      // instance and not suspicious, so ignored without a count. Only a message from another window that carries
      // THIS instance's nonce is a forgery worth counting. All of it before the budget, which is this frame's.
      if (event.source === null || event.source !== frame.contentWindow) {
        const d = event.data as { channel?: unknown; nonce?: unknown } | null
        if (d && typeof d === 'object' && d.channel === UI_SANDBOX_CHANNEL && d.nonce === nonce) reject('message from another window')
        return
      }
      if (event.origin !== 'null') { reject('message from a non-opaque origin'); stop('navigated'); return }
      const take = budget.take(performance.now())
      if (take === 'flood') { reject('too many messages'); stop('flood'); return }
      if (take === 'drop') { reject('too many messages'); return }
      const checked = checkBridgeMessage(event.data, nonce)
      if (!checked.ok) { reject(checked.reason); return }
      const msg = checked.value
      switch (msg.type) {
        case 'ready': {
          const first = !ready
          ready = true
          lastPong = performance.now()
          // the theme may have changed between the snapshot and now: read it at once, send it if it did (once)
          if (first) {
            watcher.sync(); theme.ready()
            // the tasks under way first, then every update from here on
            const bridge = callbacks.current.tasks
            if (bridge) {
              for (const update of bridge.current()) post({ type: 'task_update', payload: { update } })
              unhear = bridge.subscribe((update) => post({ type: 'task_update', payload: { update } }))
            }
          }
          break
        }
        case 'loaded': loaded = true; clearTimeout(readyTimer); break
        case 'pong': lastPong = performance.now(); break
        case 'resize': setHeight(clampHeight(msg.height + 2)); break
        case 'navigating': if (ready) stop('navigated'); break
        case 'state':
          latest.current = msg.state
          pending = msg.state
          if (stateTimer === undefined) stateTimer = setTimeout(flush, UI_SANDBOX_LIMITS.stateDebounceMs)
          break
        case 'action': {
          const now = performance.now()
          const verdict = judgeAction(msg, { hostActive: hostActivation(), allowed: callbacks.current.actionIds ?? null, now, lastActionAt })
          if (!verdict.ok) { reject(verdict.reason, true); break }
          lastActionAt = now
          latest.current = msg.state
          pending = msg.state
          flush()
          setProposed(msg.actionId)
          if (allowed.current) callbacks.current.onAction?.(msg.actionId, msg.state)
          break
        }
        case 'task_run': {
          const callId = msg.callId
          const reply = (result: UiTaskResult) => post({ type: 'task_reply', payload: { callId, result } })
          const bridge = callbacks.current.tasks
          if (!bridge) { reply(uiTaskRefusal('unavailable', 'this preview starts no task')); break }
          const now = performance.now()
          const verdict = judgeRun(msg, { hostActive: hostActivation(), actions: bridge.actions, now, lastActionAt })
          if (!verdict.ok) { reject(verdict.reason, true); reply(runRefusal(verdict)); break }
          lastActionAt = now
          // the click's state is the person's newest: the owner has it before the task starts with it
          latest.current = msg.state!
          pending = msg.state
          flush()
          void bridge.run(msg.actionId!, msg.state!, msg.input ?? null, (taskId) => post({ type: 'task_started', payload: { callId, taskId } }))
            .then(reply, (e: unknown) => reply(uiTaskRefusal('unavailable', e instanceof Error ? e.message : String(e))))
          break
        }
        case 'task_stop': {
          const callId = msg.callId
          const bridge = callbacks.current.tasks
          if (!bridge) { post({ type: 'stop_reply', payload: { callId, ok: false } }); break }
          void bridge.stop(msg.taskId).then((ok) => post({ type: 'stop_reply', payload: { callId, ok } }), () => post({ type: 'stop_reply', payload: { callId, ok: false } }))
          break
        }
        case 'task_list': {
          const callId = msg.callId
          const bridge = callbacks.current.tasks
          if (!bridge) { post({ type: 'list_reply', payload: { callId, tasks: [] } }); break }
          void bridge.list().then((tasks) => post({ type: 'list_reply', payload: { callId, tasks } }), () => post({ type: 'list_reply', payload: { callId, tasks: [] } }))
          break
        }
      }
    }
    // a second load is a navigation; a first load the bootstrap did not report from its own document is the load of
    // another document: the one the host wrote navigated before it finished
    const onLoad = () => {
      if (ended) return
      loads++
      if (loads > 1) { stop('navigated'); return }
      if (!loaded) readyTimer = setTimeout(() => { if (!loaded) stop('navigated') }, UI_SANDBOX_LIMITS.loadedAfterLoadMs)
    }
    const tick = setInterval(() => {
      if (ended) return
      const now = performance.now()
      const verdict = watchdogVerdict({ now, lastTick, startedAt, ready, lastPong })
      lastTick = now
      showRefused()
      if (verdict) { stop(verdict); return }
      if (ready) { try { frame.contentWindow?.postMessage(pingMessage(nonce, seq++), '*') } catch { /* gone */ } }
    }, UI_SANDBOX_LIMITS.heartbeatMs)

    window.addEventListener('message', onMessage)
    frame.addEventListener('load', onLoad)
    return () => {
      ended = true
      unhear?.(); unhear = null
      theme.close()
      watcher.dispose()
      window.removeEventListener('message', onMessage)
      frame.removeEventListener('load', onLoad)
      clearInterval(tick)
      clearTimeout(readyTimer)
      flush()
    }
  }, [live])

  const status: Status = readOnly ? 'read-only' : tooLarge ? 'too-large' : live ? 'running' : stopReason ? 'stopped' : 'idle'

  // keyboard focus: the control pressed is replaced by its counterpart (Run by Stop, Stop by Run); when the one that
  // had focus is gone with it, its counterpart takes the focus instead of the page
  const runRef = useRef<HTMLButtonElement | null>(null)
  const stopRef = useRef<HTMLButtonElement | null>(null)
  const controlsFocused = useRef(false)
  useLayoutEffect(() => {
    if (!controlsFocused.current) return
    const active = document.activeElement
    if (active && active !== document.body) return
    ;(status === 'running' ? stopRef : runRef).current?.focus()
  }, [status])
  const onControlsFocus = () => { controlsFocused.current = true }
  const onControlsBlur = (e: FocusEvent<HTMLElement>) => {
    const to = e.relatedTarget as Node | null
    if (to && e.currentTarget.contains(to)) return
    if (to) { controlsFocused.current = false; return }
    // focus went nowhere: the control may have been removed (then its counterpart takes it) or the person left
    const from = e.target
    setTimeout(() => { if (from.isConnected) controlsFocused.current = false }, 0)
  }

  const controls = (
    <span className="uisbx-controls" data-testid="intelligent-html-controls" onFocus={onControlsFocus} onBlur={onControlsBlur}>
      {status === 'running' ? <span className="uisbx-live" role="status" data-testid="intelligent-html-live">Running</span> : null}
      <button type="button" className="uisbx-info" data-testid="intelligent-html-info-toggle" aria-expanded={infoOpen} aria-controls={infoId}
              aria-label="How this preview runs" title="How this preview runs — what it can and cannot reach" onClick={() => setInfoOpen((v) => !v)}>
        <ShieldIcon size={13} />
      </button>
      {status === 'running' ? (
        <>
          <button type="button" className="thread-btn uisbx-btn" data-testid="intelligent-html-reset" title="Start again from the stored state"
                  onClick={() => start(initial.state)}>Reset</button>
          <button type="button" ref={stopRef} className="thread-btn uisbx-btn" data-testid="intelligent-html-stop" onClick={() => {
            setRun(null)
            setStopReason('stopped')
          }}>Stop</button>
        </>
      ) : status === 'idle' || status === 'stopped' ? (
        <button type="button" ref={runRef} className="thread-btn primary uisbx-btn" data-testid="intelligent-html-run" aria-describedby={infoId}
                onClick={() => start(latest.current)}>
          {status === 'stopped' ? 'Run again' : 'Run preview'}
        </button>
      ) : null}
    </span>
  )

  // what the person reads about how it runs: one press away (and the Run button's description), never a banner
  const info = (
    <div id={infoId} className="uisbx-info-panel" data-testid="intelligent-html-info" hidden={!infoOpen}>
      <p>{INFO_TEXT}</p>
      <p><span data-testid="intelligent-html-cpu-hint">{CPU_HINT}</span> It runs only when you press Run preview, and never in a replay.</p>
    </div>
  )

  const notice = status === 'read-only' ? 'Read-only: this preview does not run here.'
    : status === 'too-large' ? `This page is longer than ${UI_SANDBOX_LIMITS.htmlChars.toLocaleString('en-US')} characters and is not run.`
    : stopReason ? STOP_REASON_TEXT[stopReason]
    : fallback ? null
    : 'Not running. Run preview opens it here.'

  const Root = embedded ? 'div' : 'section'
  return (
    <Root className={embedded ? 'uisbx embedded' : 'uisbx'} data-testid="intelligent-html" data-status={status} data-stop-reason={stopReason ?? ''}
      data-rejected={rejects.count} data-last-reject={rejects.last} aria-label={embedded ? undefined : title}>
      {embedded
        ? (controlsHost ? createPortal(controls, controlsHost) : <div className="uisbx-bar">{controls}</div>)
        : <header className="uisbx-head"><span className="uisbx-title" title={title}>{title}</span>{controls}</header>}
      {info}
      {live ? (
        <iframe
          key={live.nonce}
          ref={frameRef}
          className="uisbx-frame"
          data-testid="intelligent-html-frame"
          title={`Interactive preview: ${title}`}
          sandbox={UI_SANDBOX_ATTR}
          allow={UI_SANDBOX_ALLOW}
          referrerPolicy="no-referrer"
          {...CREDENTIALLESS}
          srcDoc={srcdoc}
          style={{ height }}
        />
      ) : (
        <div className="uisbx-idle" data-testid="intelligent-html-idle">
          {notice ? <p className="uisbx-note" role="status" data-testid="intelligent-html-notice">{notice}</p> : null}
          {fallback ? <p className="uisbx-fallback" data-testid="intelligent-html-fallback">{fallback}</p> : null}
        </div>
      )}
      {/* embedded, the surface asks about a proposal itself (its suggestion line); what was refused shows either way */}
      {(proposed && !embedded) || rejects.count ? (
        <footer className="uisbx-foot" data-testid="intelligent-html-status">
          {proposed && !embedded ? <span>Proposed “{proposed}” — nothing is sent until you send it.</span> : null}
          {rejects.count ? <span className="uisbx-warn">Ignored {rejects.count} message{rejects.count === 1 ? '' : 's'} from the preview ({rejects.last}).</span> : null}
        </footer>
      ) : null}
    </Root>
  )
}

export default IntelligentHtml
