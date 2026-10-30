import { Component, useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ErrorInfo, type ReactNode } from 'react'
import { UI_LIMITS, isSafeImageSrc, isUiTaskActive, uiActionMode, uiSurfaceUpdatedBy, uiTaskRefusal, type UiElement, type UiTaskResult } from '@oasis-code/contract'
import { ApiError, api } from '../api/client'
import { subscribeRunEvents } from '../api/sse'
import { useStore } from '../state/store'
import type { ThreadEntry } from '../state/thread'
import {
  acceptState, fallbackOf, footerActions, formatValue, isSessionSurface, outOfRange, parseNumberInput, reconcile, sameState,
  sliderValue, stateOf, titleOf, updatedLabel, valueAt, viewOf, writeState,
  type LocalSurface, type UiAction, type UiResolved, type UiState, type UiSurfaceRecord, type UiSurfaceSpec,
} from '../state/uiSurface'
import { surfaceQueues, type ActionStatus, type QueueDeps, type QueueView, type SaveStatus, type SurfaceQueue, type SurfaceTarget } from '../state/uiQueue'
import { exactText, numberText, utcText } from '../state/uiChart'
import { Chart } from './UiLiveChart'
import { useArrival } from './UiLiveMotion'
import { surfaceTasks, type SurfaceTasks, type TaskDeps, type TaskLive, type TasksView } from '../state/uiTasks'
import { holdThread } from '../state/threadFollow'
import { IntelligentHtml, type HtmlTaskBridge } from './IntelligentHtml'
import { CheckIcon, LayersIcon, StopIcon } from './icons'
import { Prose } from './Prose'
import './UiSurface.css'

const SAVE_DELAY_MS = 450

/** A surface an agent presented, as its own block in the answer: the title, who presented it in which run, the
 *  surface itself — native elements drawn here, or an html page in the isolated preview (IntelligentHtml, embedded:
 *  one card, one title, its Run / Stop / Reset in this header) — the actions the host offers, and its plain-text
 *  version on request. The spec is read by the contract's full parser; one it refuses shows its text version and
 *  why. A replay shows it read-only (an html page is not run). */
export function UiSurfaceBlock({ entry, who = null }: { entry: ThreadEntry; who?: ReactNode }) {
  const record = entry.surface
  const replaying = useStore((s) => s.replaying)
  const [textOnly, setTextOnly] = useState(false)
  /** the header's slot an html surface's preview draws its controls into */
  const [controlsHost, setControlsHost] = useState<HTMLElement | null>(null)
  const view = useMemo(() => (record ? viewOf(record) : null), [record])
  const provenanceId = useId()
  if (!record || !view) return null
  const title = titleOf(record.spec)
  const kind = view.ok ? view.spec.kind : 'native'
  // no kind badge: native or html, a surface is the host's content under one title. Where it came from (surface,
  // revision, run, model) is a detail for whoever looks for it — the title's tooltip and the section's description
  // a live surface (kept up to date by the thread's later runs) says so, and when it last changed; which run wrote it
  // is a detail with the rest
  const live = isSessionSurface(record)
  const writer = uiSurfaceUpdatedBy(record)
  const provenance = live
    ? `surface ${record.surface_id} · revision ${record.revision} · presented in run ${record.run_id} · last updated in run ${writer}${record.model ? ` by ${record.model}` : ''}`
    : `surface ${record.surface_id} · revision ${record.revision} · presented in run ${record.run_id}${record.model ? ` by ${record.model}` : ''}`
  const updated = live ? updatedLabel(record.updated_at) : ''
  const updatedAt = Date.parse(record.updated_at)
  return (
    <section className="uis" aria-label={title} aria-describedby={provenanceId} data-testid={`ui-surface-${record.surface_id}`} data-run={record.run_id} data-surface={record.surface_id}
             data-revision={record.revision} data-kind={kind} data-valid={view.ok ? 'true' : 'false'}
             data-live={live ? 'true' : undefined} data-updated-by={live ? writer : undefined} data-updated-at={live ? record.updated_at : undefined}>
      <header className="uis-head">
        <LayersIcon size={12} />
        <span className="uis-name" title={`${title} — ${provenance}`}>{title}</span>
        <span id={provenanceId} className="uis-sr-only" data-testid="ui-provenance">{provenance}</span>
        {who && <span className="uis-who">{who}</span>}
        {live && <span className="uis-tag live" data-testid="ui-live" title="Kept up to date in this conversation: later updates change it here">Live</span>}
        {live && updated && (
          <time className="uis-updated" dateTime={record.updated_at} data-testid="ui-updated" title={Number.isFinite(updatedAt) ? `Last updated ${utcText(updatedAt)}` : undefined}>Updated {updated}</time>
        )}
        <span className="uis-spacer" />
        {replaying && <span className="uis-tag readonly" data-testid="ui-readonly">replay · read-only</span>}
        {kind === 'html' && !textOnly && view.ok && <span className="uis-controls" ref={setControlsHost} data-testid="ui-html-controls" />}
        <button type="button" className="uis-toggle" aria-pressed={textOnly} onClick={() => setTextOnly((v) => !v)} data-testid="ui-text-toggle"
                title={textOnly ? 'Show the surface' : 'Show its plain-text version'}>{textOnly ? 'Show surface' : 'Text version'}</button>
      </header>
      {textOnly || !view.ok
        ? <SurfaceFallback text={fallbackOf(record.spec)} reason={view.ok ? null : view.reason} />
        // one boundary per surface (its session, run and id) and per mode (live or replay): a new revision of it draws
        // into the same tree — fields keep their focus, a chart its cursor — and a revision that failed to draw is
        // tried again only when a newer revision comes (never in a loop on the same one)
        : <SurfaceBoundary key={surfaceKey(record, replaying)} revision={record.revision} fallback={fallbackOf(record.spec)}>
            <LiveSurface record={record} spec={view.spec} readOnly={replaying} controlsHost={controlsHost} />
          </SurfaceBoundary>}
    </section>
  )
}

function SurfaceFallback({ text, reason }: { text: string; reason: string | null }) {
  return (
    <div className="uis-fallback" data-testid="ui-fallback">
      {reason && <p className="uis-problem" role="note">This surface could not be drawn ({reason}); its text version:</p>}
      <div className="uis-fallback-text">{text}</div>
    </div>
  )
}

/** The identity a surface is drawn under: its session, run and id, and whether the replay shows it. Not its
 *  revision: a later revision updates what is drawn in place. */
export const surfaceKey = (record: Pick<UiSurfaceRecord, 'session_id' | 'run_id' | 'surface_id'>, replaying: boolean): string =>
  JSON.stringify([record.session_id, record.run_id, record.surface_id, replaying ? 'replay' : 'live'])

/** A surface that throws while drawing shows its text version; the thread around it goes on. A failure belongs to the
 *  revision it happened at: a newer revision is drawn afresh, the same one is not tried again. */
export class SurfaceBoundary extends Component<{ fallback: string; revision: number; children: ReactNode }, { error: string | null; revision: number }> {
  state = { error: null as string | null, revision: this.props.revision }
  static getDerivedStateFromProps(props: { revision: number }, state: { error: string | null; revision: number }) {
    return props.revision !== state.revision ? { error: null, revision: props.revision } : null
  }
  static getDerivedStateFromError(error: unknown) { return { error: error instanceof Error ? error.message : String(error) } }
  componentDidCatch(_error: unknown, _info: ErrorInfo) { /* shown, not rethrown */ }
  render() {
    if (this.state.error !== null) return <SurfaceFallback text={this.props.fallback} reason={`it failed to draw: ${this.state.error.slice(0, 200)}`} />
    return this.props.children
  }
}

type ActionState = ActionStatus

const errorText = (e: unknown): string => (e instanceof ApiError ? e.detail : e instanceof Error ? e.message : String(e))

/** What a surface's queue works with: the store's actions, read when used (never a stale closure of a component). */
function queueDeps(): QueueDeps {
  return {
    delay: SAVE_DELAY_MS,
    save: (target, revision, state) => useStore.getState().saveSurfaceState(target, revision, state),
    startTask,
    prepare: (snapshot) => useStore.getState().prepareSurfaceAction(snapshot),
    place: (sessionId, receiptId, prompt) => useStore.getState().placeActionPrompt(sessionId, receiptId, prompt),
    isConflict: (e) => e instanceof ApiError && e.status === 409,
    onConflict: () => { void useStore.getState().loadSurfaces() },
    errorText,
  }
}
const queueOf = (target: SurfaceTarget): SurfaceQueue => surfaceQueues.acquire(target, queueDeps())

type ActionSnapshotLike = Parameters<NonNullable<QueueDeps['startTask']>>[0]
/** A `run` action's press, as the queue fixed it, sent as the start of its task (POST …/tasks): the harness saves the
 *  state with it and answers the task (queued or running) and the surface. */
async function startTask(snapshot: ActionSnapshotLike, input: unknown) {
  if (useStore.getState().replaying) throw new Error('the replay shows the record; go back to live to use a surface')
  // the task's run will join the thread below this surface: the thread stays where the person works
  holdThread()
  const answered = await api.startUiTask(snapshot.session_id, snapshot.run_id, snapshot.surface_id, {
    revision: snapshot.revision, action_id: snapshot.action_id, state: snapshot.state, request_id: snapshot.request_id,
    ...(input !== undefined && input !== null ? { input } : {}),
  })
  useStore.getState().adoptSurface(answered.surface)
  return answered
}

/** What a surface's tasks work with: the API, the run's stream (the one the thread uses), the store. */
function taskDeps(): TaskDeps {
  return {
    list: async (t) => (await api.uiTasks(t.session_id, { run_id: t.run_id, surface_id: t.surface_id })).tasks,
    get: async (sessionId, taskId) => (await api.uiTask(sessionId, taskId)).task,
    cancel: async (sessionId, taskId) => (await api.cancelUiTask(sessionId, taskId)).task,
    follow: (runId, after, onEvent, onClose) => subscribeRunEvents(runId, onEvent, onClose, after),
    onRun: (record) => {
      const s = useStore.getState()
      s.adoptTaskRun(record)
      // the task's run joins the thread now rather than on the next tick
      if (s.session?.id === record.session_id && record.agent_run_id && !s.runs.some((r) => r.id === record.agent_run_id)) void s.syncSession()
    },
  }
}
const tasksOf = (target: SurfaceTarget): SurfaceTasks => surfaceTasks.acquire(target, taskDeps())
const EMPTY_TASKS: TasksView = { tasks: [], starting: null, refused: null, loaded: false }

/** The surface's state as the person edits it, and its actions. The requests go through the surface's own queue
 *  (uiQueue.ts), shared by every view of it and kept across mounts: drawing it again (its text version and back, a
 *  session left and opened again) neither reorders nor drops them, and an action pressed here completes into its own
 *  session's draft even after this view is gone. This view only shows what the queue says, and the person's newest
 *  unconfirmed edit when it is drawn again. Nothing is sent and no agent is started or resumed. */
function useSurface(record: UiSurfaceRecord, spec: UiSurfaceSpec, readOnly: boolean) {
  const { session_id, run_id, surface_id } = record
  const target = useMemo<SurfaceTarget>(() => ({ session_id, run_id, surface_id }), [session_id, run_id, surface_id])
  const [local, setLocal] = useState<LocalSurface>(() => {
    const pending = readOnly ? null : surfaceQueues.peek(target)?.view().unconfirmed
    return pending && pending.revision === record.revision
      ? { revision: record.revision, state: stateOf(spec, pending.state) }
      : { revision: record.revision, state: stateOf(spec, record.state) }
  })
  const [view, setView] = useState<QueueView>(() => surfaceQueues.peek(target)?.view() ?? { status: { kind: 'idle' }, action: null, unconfirmed: null })
  const localRef = useRef(local)
  localRef.current = local

  // listen to the surface's queue while drawn; the queue itself goes on (and is let go when idle and unheard)
  useEffect(() => {
    const queue = queueOf(target)
    setView(queue.view())
    return queue.subscribe(setView)
  }, [target])

  // what the harness said since: a replay shows the record as it stood; live, a new revision, or a later state while
  // nothing of the person's waits, is on its way or is held. Taken while drawing (not after): the surface is drawn in
  // place across revisions, and a new revision's spec is never drawn with the state of the one before
  const [heard, setHeard] = useState({ record, spec, readOnly })
  if (heard.record !== record || heard.spec !== spec || heard.readOnly !== readOnly) {
    setHeard({ record, spec, readOnly })
    const busy = surfaceQueues.peek(target)?.busy() ?? false
    setLocal((cur) => (readOnly ? { revision: record.revision, state: stateOf(spec, record.state) } : reconcile(cur, record, spec, busy)))
  }
  // and once when drawn, as ever: what the queue holds against the record as it stands
  useEffect(() => {
    setLocal((cur) => (readOnly ? { revision: record.revision, state: stateOf(spec, record.state) } : reconcile(cur, record, spec, surfaceQueues.peek(target)?.busy() ?? false)))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const commit = useCallback((next: UiState) => {
    if (readOnly || next === localRef.current.state || sameState(next, localRef.current.state)) return
    localRef.current = { ...localRef.current, state: next }
    setLocal(localRef.current)
    queueOf(target).edit(next, localRef.current.revision)
  }, [readOnly, target])

  const setValue = useCallback((key: string, value: unknown) => commit(writeState(spec, localRef.current.state, key, value)), [commit, spec])

  // a press: the queue takes its snapshot now; a replay presses nothing
  const runAction = useCallback((act: UiAction, stateOverride?: UiState) => {
    if (readOnly || !(spec.actions ?? []).some((a) => a.id === act.id)) return
    if (stateOverride) commit(stateOverride)
    queueOf(target).press(act.id, localRef.current)
  }, [readOnly, spec, commit, target])

  // a `run` action: the press starts its task (no draft, no question): the queue fixes the state as it stands now —
  // the edit just made included — and the surface's tasks follow it until it ends. Never rejects.
  const runTask = useCallback((act: UiAction, stateOverride?: UiState, input?: unknown, started?: (taskId: string) => void): Promise<UiTaskResult> => {
    if (readOnly) return Promise.resolve(uiTaskRefusal('unavailable', 'the replay shows the record'))
    if (!(spec.actions ?? []).some((a) => a.id === act.id) || uiActionMode(act) !== 'run') return Promise.resolve(uiTaskRefusal('not_a_run_action', `action ${act.id} does not start a task`))
    if (stateOverride) commit(stateOverride)
    const own = tasksOf(target)
    // a second press while the first start is on its way (before the button could say so) starts nothing
    if (own.view().starting !== null) return Promise.resolve(uiTaskRefusal('task_active', 'a task of this surface is starting'))
    return own.run(act.id, () => queueOf(target).launch(act.id, localRef.current, input).started, started)
  }, [readOnly, spec, commit, target])

  const retry = useCallback(() => queueOf(target).retry(), [target])
  return { state: local.state, revision: local.revision, status: view.status, action: view.action, setValue, commit, runAction, runTask, retry, target }
}

/** The surface's tasks as they stand (none in a replay: it shows the record). */
function useTasks(target: SurfaceTarget, readOnly: boolean): TasksView {
  const tasks = useMemo(() => (readOnly ? null : tasksOf(target)), [target, readOnly])
  const subscribe = useCallback((cb: () => void) => (tasks ? tasks.subscribe(cb) : () => undefined), [tasks])
  return useSyncExternalStore(subscribe, () => (tasks ? tasks.view() : EMPTY_TASKS), () => EMPTY_TASKS)
}

function LiveSurface({ record, spec, readOnly, controlsHost = null }: { record: UiSurfaceRecord; spec: UiSurfaceSpec; readOnly: boolean; controlsHost?: HTMLElement | null }) {
  const { state, revision, status, action, setValue, commit, runAction, runTask, retry, target } = useSurface(record, spec, readOnly)
  const tasks = useTasks(target, readOnly)
  const latestTask = tasks.tasks[0] ?? null
  /** a task of this surface under way, or a start on its way: another start would be refused (task_active) */
  const taskBusy = tasks.starting !== null || (latestTask !== null && isUiTaskActive(latestTask.record.status))
  const actions = useMemo(() => spec.actions ?? [], [spec])
  const actionIds = useMemo(() => actions.map((a) => a.id), [actions])
  const footer = useMemo(() => footerActions(spec), [spec])
  // an html page's suggestion waits for the person's own press; it is dropped when the replay starts, the agent
  // republishes the surface, or the surface leaves the page (it never becomes an action by itself)
  const [suggested, setSuggested] = useState<{ action: UiAction; state: UiState; revision: number } | null>(null)
  useEffect(() => { if (readOnly) setSuggested(null) }, [readOnly])
  // a suggestion is the revision's it was made on: the record's own revision decides (a newer one drops it)
  const pending = suggested && suggested.revision === record.revision && !readOnly ? suggested : null
  const onAction = useCallback((id: string) => {
    const act = actions.find((a) => a.id === id)
    if (!act) return
    if (uiActionMode(act) === 'run') void runTask(act)
    else runAction(act)
  }, [actions, runAction, runTask])
  // the html page's tasks: oasisUI.run / stop / tasks / onTask through the surface's own tasks
  const bridge = useMemo<HtmlTaskBridge | undefined>(() => {
    if (readOnly || spec.kind !== 'html') return undefined
    const own = tasksOf(target)
    return {
      actions,
      run: (actionId, next, input, started) => {
        const act = actions.find((a) => a.id === actionId)
        if (!act) return Promise.resolve(uiTaskRefusal('unknown_action', `unknown action ${actionId}`))
        const accepted = acceptState(spec, next)
        if (!accepted) return Promise.resolve(uiTaskRefusal('invalid_state', 'the state does not fit this surface'))
        return runTask(act, accepted, input ?? undefined, started)
      },
      stop: (taskId) => own.stop(taskId),
      list: async () => { await own.refresh(); return own.views() },
      subscribe: (listener) => own.onUpdate(listener),
      current: () => own.current(),
    }
  }, [readOnly, spec, actions, target, runTask])
  // the html page is handed its state when it is made (a new revision makes it again)
  const initial = useMemo(() => stateOf(spec, record.state), [record.surface_id, record.revision]) // eslint-disable-line react-hooks/exhaustive-deps
  const preparing = action?.phase === 'preparing'
  return (
    <>
      <div className={spec.kind === 'native' ? 'uis-body' : 'uis-body html'}>
        {spec.kind === 'native'
          ? <NativeNode id={spec.root!} ctx={{ elements: spec.elements ?? {}, state, readOnly, setValue, onAction, actions, action, taskBusy, task: latestTask, surface: { session_id: record.session_id, run_id: record.run_id, surface_id: record.surface_id, revision: record.revision } }} depth={1} />
          : <IntelligentHtml key={`${record.surface_id}:${record.revision}`} html={spec.html ?? ''} title={spec.title} fallback={spec.fallback}
                             actionIds={actionIds} initialState={initial} readOnly={readOnly} embedded controlsHost={controlsHost} tasks={bridge}
                             onStateChange={(next: Record<string, unknown>) => {
                               if (readOnly) return
                               const accepted = acceptState(spec, next)
                               if (accepted) commit(accepted)
                             }}
                             onAction={(id: string, next: Record<string, unknown>) => {
                               // the page only suggests: the host asks the person; an id the spec does not declare is ignored
                               const act = actions.find((a) => a.id === id)
                               if (readOnly || !act) return
                               setSuggested({ action: act, state: acceptState(spec, next) ?? state, revision })
                             }} />}
      </div>
      {pending && (
        <div className="uis-suggest" role="group" aria-label="Suggested action" data-testid="ui-suggested-action">
          <span>The preview suggests <b>{pending.action.label}</b>. Put it in your draft to review before sending?</span>
          <button type="button" className="thread-btn primary" disabled={preparing} onClick={() => { setSuggested(null); runAction(pending.action, pending.state) }} data-testid="ui-suggested-accept">Put in draft</button>
          <button type="button" className="thread-btn" onClick={() => setSuggested(null)} data-testid="ui-suggested-dismiss">Dismiss</button>
        </div>
      )}
      {(footer.length > 0 || status.kind !== 'idle' || action) && (
        <footer className="uis-foot">
          {footer.map((a) => {
            const runs = uiActionMode(a) === 'run'
            return (
              <button key={a.id} type="button" className={runs ? 'thread-btn primary' : 'thread-btn'} disabled={readOnly || (runs ? taskBusy : preparing)} onClick={() => onAction(a.id)}
                      title={readOnly ? 'The replay shows the record' : runs ? RUN_TITLE : DRAFT_TITLE} data-testid={`ui-action-${a.id}`} data-mode={runs ? 'run' : 'draft'}>{a.label}</button>
            )
          })}
          <span className="uis-spacer" />
          <ActionLine action={action} actions={actions} />
          <SaveLine status={status} retry={retry} />
        </footer>
      )}
      {/* the task panel under the action row: a long result grows below the buttons the next run is pressed with, never
          pushing them away (the body, its fields and an html frame keep their place and identity) */}
      {!readOnly && (tasks.starting || tasks.refused || latestTask) && (
        <TaskPanel view={tasks} actions={actions} target={target} onRetry={(id) => { const act = actions.find((a) => a.id === id); if (act) void runTask(act) }} />
      )}
    </>
  )
}

const RUN_TITLE = 'Start this action now: the agent works on it and its answer comes back here'
const DRAFT_TITLE = 'Prepare this action and put it in your draft (not sent)'

const TASK_STATUS_TEXT: Record<string, string> = {
  starting: 'Starting…', queued: 'Queued — starts when the conversation is free', running: 'Running',
  succeeded: 'Done', failed: 'Failed', cancelled: 'Stopped', refused: 'Not started',
}

/** The task of this surface the person sees: the newest one — its status as the harness keeps it, the answer as it
 *  streams (the final answer once it ended), the tools it calls, the structured result it sent, its error; Stop while
 *  it runs, Run again once it ended without success. A start the harness refused says why, with Run again. */
function TaskPanel({ view, actions, target, onRetry }: { view: TasksView; actions: UiAction[]; target: SurfaceTarget; onRetry: (actionId: string) => void }) {
  const task = view.tasks[0] ?? null
  const label = (id: string) => actions.find((a) => a.id === id)?.label ?? id
  const canRun = (id: string) => actions.some((a) => a.id === id && uiActionMode(a) === 'run')
  const busy = view.starting !== null || (task !== null && isUiTaskActive(task.record.status))
  return (
    <div className="uis-tasks">
      {view.starting && (
        <div className="uis-task" data-testid="ui-task-starting" data-status="starting" role="status">
          <div className="uis-task-head"><span className="uis-task-pill starting">{TASK_STATUS_TEXT.starting}</span><span className="uis-task-action">“{label(view.starting)}”</span></div>
        </div>
      )}
      {view.refused && !view.starting && (
        <div className="uis-task" data-testid="ui-task-refused" data-status="refused" data-code={view.refused.result.error?.code ?? ''}>
          <div className="uis-task-head">
            <span className="uis-task-pill failed">{TASK_STATUS_TEXT.refused}</span>
            <span className="uis-task-action">“{label(view.refused.action_id)}”</span>
            <span className="uis-spacer" />
            {!busy && canRun(view.refused.action_id) && <button type="button" className="thread-btn" onClick={() => onRetry(view.refused!.action_id)} data-testid="ui-task-retry">Run again</button>}
          </div>
          <p className="uis-task-error" role="alert" data-testid="ui-task-error">{view.refused.result.error?.message} ({view.refused.result.error?.code})</p>
        </div>
      )}
      {/* keyed by the task: what one card holds of its own (a refused Stop's words) never passes to the next task */}
      {task && <TaskCard key={task.record.id} live={task} label={label(task.record.action_id)} target={target} canRetry={!busy && canRun(task.record.action_id) && task.record.input === null} onRetry={onRetry} />}
    </div>
  )
}

function TaskCard({ live, label, target, canRetry, onRetry }: { live: TaskLive; label: string; target: SurfaceTarget; canRetry: boolean; onRetry: (actionId: string) => void }) {
  const { record, text, tools, stopping } = live
  const active = isUiTaskActive(record.status)
  const [stopError, setStopError] = useState<string | null>(null)
  const stop = async () => {
    setStopError(null)
    if (!(await tasksOf(target).stop(record.id))) setStopError('the stop was not taken; the task stands as shown')
  }
  const shownTools = tools.slice(-4)
  return (
    <div className="uis-task" data-testid="ui-task" data-task-id={record.id} data-status={record.status} data-action={record.action_id} aria-busy={active || undefined}>
      <div className="uis-task-head">
        <span className={`uis-task-pill ${record.status}`} role="status" data-testid="ui-task-status">{TASK_STATUS_TEXT[record.status] ?? record.status}</span>
        <span className="uis-task-action">“{label}”</span>
        <span className="uis-spacer" />
        {active && <button type="button" className="thread-btn danger" disabled={stopping} onClick={() => void stop()} data-testid="ui-task-stop"
                           title="Stop this task: a queued one ends now, a running one with its run"><StopIcon size={10} /> {stopping ? 'Stopping…' : 'Stop'}</button>}
        {!active && record.status !== 'succeeded' && canRetry && <button type="button" className="thread-btn" onClick={() => onRetry(record.action_id)} data-testid="ui-task-retry">Run again</button>}
      </div>
      {active && shownTools.length > 0 && (
        <ul className="uis-task-tools" data-testid="ui-task-tools" aria-label="Tools the agent called">
          {shownTools.map((t, i) => <li key={`${tools.length - shownTools.length + i}`}><span className="uis-task-tool">{t.name}</span> <span className="uis-task-summary">{t.summary}</span></li>)}
        </ul>
      )}
      {text && (
        <div className={`uis-task-text prose${active ? ' streaming' : ''}`} data-testid={active ? 'ui-task-text' : 'ui-task-answer'} aria-live={active ? 'polite' : undefined}>
          <Prose text={text} />
        </div>
      )}
      {record.error && record.status === 'failed' && <p className="uis-task-error" role="alert" data-testid="ui-task-error">{record.error.message} ({record.error.code})</p>}
      {stopError && <p className="uis-task-error" role="alert" data-testid="ui-task-stop-refused">{stopError}</p>}
      {record.data !== null && record.data !== undefined && <TaskData data={record.data} />}
    </div>
  )
}

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isScalar = (v: unknown) => v === null || ['string', 'number', 'boolean'].includes(typeof v)
const cellText = (v: unknown): string => (v === undefined ? '' : isScalar(v) ? formatValue(v as UiResolved) : JSON.stringify(v))

/** The structured result a task sent (return_ui_result's data), usable as it is: a list of records as a table, a
 *  record of values as a list of fields, anything else as its JSON — the JSON always one press away, and copyable. */
function TaskData({ data }: { data: unknown }) {
  const [copied, setCopied] = useState(false)
  const json = useMemo(() => JSON.stringify(data, null, 2), [data])
  const rows = Array.isArray(data) && data.length > 0 && data.length <= 500 && data.every(isPlain) ? data as Record<string, unknown>[] : null
  const columns = rows ? [...new Set(rows.flatMap((r) => Object.keys(r)))].slice(0, 16) : []
  const fields = !rows && isPlain(data) && Object.keys(data).length > 0 && Object.values(data).every(isScalar) ? Object.entries(data) : null
  const copy = async () => {
    try { await navigator.clipboard.writeText(json); setCopied(true); window.setTimeout(() => setCopied(false), 1500) } catch { /* not allowed */ }
  }
  return (
    <div className="uis-task-data" data-testid="ui-task-data">
      <div className="uis-task-data-head">
        <span className="uis-title">Result data</span>
        <span className="uis-spacer" />
        <button type="button" className="uis-link" onClick={() => void copy()} data-testid="ui-task-data-copy">{copied ? 'Copied' : 'Copy JSON'}</button>
      </div>
      {rows && (
        <div className="uis-table" role="region" tabIndex={0} aria-label="Result data" data-testid="ui-task-data-table">
          <table>
            <thead><tr>{columns.map((c) => <th key={c} scope="col">{c}</th>)}</tr></thead>
            <tbody>{rows.map((r, i) => <tr key={i}>{columns.map((c) => <td key={c} className={typeof r[c] === 'number' ? 'num' : undefined}>{cellText(r[c])}</td>)}</tr>)}</tbody>
          </table>
        </div>
      )}
      {fields && (
        <dl className="uis-task-fields" data-testid="ui-task-data-fields">
          {fields.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{cellText(v)}</dd></div>)}
        </dl>
      )}
      <details className="uis-task-json" open={!rows && !fields}>
        <summary>JSON</summary>
        <pre data-testid="ui-task-data-json">{json}</pre>
      </details>
    </div>
  )
}

function ActionLine({ action, actions }: { action: ActionState; actions: UiAction[] }) {
  if (!action) return null
  const label = actions.find((a) => a.id === action.snapshot.action_id)?.label ?? action.snapshot.action_id
  if (action.phase === 'preparing') return <span className="uis-status" role="status">Preparing “{label}”…</span>
  if (action.phase === 'done') return <span className="uis-status ok" role="status" data-testid="ui-action-drafted"><CheckIcon size={11} /> “{label}” is in your draft — not sent. Review it, then send.</span>
  if (action.phase === 'already') return <span className="uis-status ok" role="status" data-testid="ui-action-drafted"><CheckIcon size={11} /> “{label}” is already in your draft — not sent.</span>
  return <span className="uis-status bad" role="alert" data-testid="ui-action-error">“{label}” was not prepared: {action.message} — press it again to retry</span>
}

function SaveLine({ status, retry }: { status: SaveStatus; retry: () => void }) {
  switch (status.kind) {
    case 'idle': return null
    case 'pending': case 'saving': return <span className="uis-status" role="status" data-testid="ui-save" data-state="saving">Saving…</span>
    case 'saved': return <span className="uis-status" role="status" data-testid="ui-save" data-state="saved">Saved</span>
    case 'conflict': return <span className="uis-status bad" role="status" data-testid="ui-save" data-state="conflict">The surface changed; your last edit was not saved</span>
    case 'error': return <span className="uis-status bad" role="status" data-testid="ui-save" data-state="error">Not saved ({status.message}) <button type="button" className="uis-link" onClick={retry}>Retry</button></span>
  }
}

// ---------------------------------------------------------------- the native catalog (a parsed spec: a tree)

export interface Ctx {
  elements: Record<string, UiElement>
  state: UiState
  readOnly: boolean
  setValue: (key: string, value: unknown) => void
  onAction: (id: string) => void
  actions: UiAction[]
  action: ActionState
  /** a task of the surface under way (or starting): a `run` button waits for it */
  taskBusy?: boolean
  task?: TaskLive | null
  /** the surface drawn (a chart's file source is read for it, at this revision); none for a form (request_input) */
  surface?: { session_id: string; run_id: string; surface_id: string; revision: number }
}

const textOf = (v: UiResolved): string => (typeof v === 'string' ? v : formatValue(v))

/** One element of the tree. The contract's parser made it a tree (one parent each, no cycle, at most
 *  UI_LIMITS.treeDepth deep, at most UI_LIMITS.nodes): each element is drawn once; the depth is bounded here again. */
export function NativeNode({ id, ctx, depth }: { id: string; ctx: Ctx; depth: number }): ReactNode {
  if (depth > UI_LIMITS.treeDepth || !Object.hasOwn(ctx.elements, id)) return null
  const el = ctx.elements[id]!
  switch (el.type) {
    case 'stack': case 'row': case 'card': {
      const title = el.props?.title
      const children = (el.children ?? []).map((c) => <NativeNode key={c} id={c} ctx={ctx} depth={depth + 1} />)
      if (el.type === 'stack') return <div className="uis-stack">{title && <div className="uis-title">{title}</div>}{children}</div>
      if (el.type === 'row') return <div className="uis-row-wrap">{title && <div className="uis-title">{title}</div>}<div className="uis-row">{children}</div></div>
      return <section className="uis-card" aria-label={title}>{title && <h4 className="uis-card-title">{title}</h4>}{children}</section>
    }
    case 'text': return <p className="uis-text">{textOf(valueAt(el.props.text, ctx.state))}</p>
    case 'metric': return <Metric el={el} state={ctx.state} />
    case 'table': return <Table el={el} />
    case 'chart': return <Chart el={el} state={ctx.state} target={ctx.surface ? { ...ctx.surface, element_id: id } : null} />
    case 'input': return <InputField el={el} ctx={ctx} />
    case 'select': return <SelectField el={el} ctx={ctx} />
    case 'slider': return <SliderField el={el} ctx={ctx} />
    case 'checkbox': return <CheckboxField el={el} ctx={ctx} />
    case 'button': return <ActionButton el={el} ctx={ctx} />
    case 'image': return <SurfaceImage el={el} />
    case 'divider': return <hr className="uis-divider" />
  }
}

type El<T extends UiElement['type']> = Extract<UiElement, { type: T }>

function Metric({ el, state }: { el: El<'metric'>; state: UiState }) {
  const { label, unit } = el.props
  const resolved = valueAt(el.props.value, state)
  // a small number (a learning rate) keeps its digits; the exact number is its tooltip
  const value = typeof resolved === 'number' ? numberText(resolved) : formatValue(resolved)
  // a value that changed while the page was in view marks it once (the CSS; none when motion is reduced)
  const fresh = useArrival(value)
  return (
    <div className="uis-metric" role="group" aria-label={`${label}: ${value}${unit ? ` ${unit}` : ''}`}>
      <span className="uis-metric-label">{label}</span>
      <span className="uis-metric-value" aria-live="polite" data-fresh={fresh ? 'true' : undefined} title={typeof resolved === 'number' ? exactText(resolved) : undefined}><span key={fresh ?? 'still'} className={fresh ? 'uis-fresh' : undefined}>{value}</span>{unit && <span className="uis-metric-unit">{unit}</span>}</span>
    </div>
  )
}

function Table({ el }: { el: El<'table'> }) {
  const { columns, rows, caption } = el.props
  // a column of numbers reads right-aligned, its head with it
  const numeric = new Set(columns.filter((c) => rows.length > 0 && rows.every((r) => typeof r[c.key] === 'number' || !Object.hasOwn(r, c.key))).map((c) => c.key))
  return (
    <div className="uis-table" role="region" tabIndex={0} aria-label={caption ?? 'Table'}>
      <table>
        {caption && <caption>{caption}</caption>}
        <thead><tr>{columns.map((c) => <th key={c.key} scope="col" className={numeric.has(c.key) ? 'num' : undefined}>{c.label}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>{columns.map((c) => {
              const v = Object.hasOwn(r, c.key) ? r[c.key]! : undefined
              return <td key={c.key} className={typeof v === 'number' ? 'num' : undefined}>{v === undefined ? '' : textOf(v)}</td>
            })}</tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Field({ label, id, children, hint }: { label: string; id: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="uis-field">
      <label htmlFor={id} className="uis-label">{label}</label>
      {children}
      {hint}
    </div>
  )
}

function InputField({ el, ctx }: { el: El<'input'>; ctx: Ctx }) {
  const id = useId()
  const { key, label, placeholder, required } = el.props
  const current = ctx.state[key]
  if (el.props.inputType === 'number') return <NumberInput id={id} el={el} value={typeof current === 'number' ? current : null} ctx={ctx} />
  return (
    <Field label={label} id={id}>
      <input id={id} className="uis-input" type="text" value={typeof current === 'string' ? current : ''} placeholder={placeholder}
             required={required === true} maxLength={UI_LIMITS.stringChars} disabled={ctx.readOnly} aria-required={required === true || undefined}
             onChange={(e) => ctx.setValue(key, e.target.value)} />
    </Field>
  )
}

/** A number field keeps the person's words while they type ("1.", "-", a number out of range): those stay local and
 *  are said invalid; a number the contract accepts is written; an empty field is written as null (cleared). */
function NumberInput({ id, el, value, ctx }: { id: string; el: El<'input'>; value: number | null; ctx: Ctx }) {
  const { key, label, min, max, placeholder, required } = el.props
  const [raw, setRaw] = useState(value === null ? '' : String(value))
  useEffect(() => { if (parseNumberInput(raw) !== value) setRaw(value === null ? '' : String(value)) }, [value]) // eslint-disable-line react-hooks/exhaustive-deps
  const parsed = parseNumberInput(raw)
  const invalid = parsed === undefined || outOfRange(parsed, min, max) || (required === true && parsed === null)
  const hintId = `${id}-hint`
  const bounds = min !== undefined || max !== undefined ? `${min ?? '−∞'} to ${max ?? '∞'}` : null
  return (
    <Field label={label} id={id} hint={invalid ? <span id={hintId} className="uis-hint bad">{parsed === undefined ? 'Not a number' : parsed === null ? 'Required' : `Expected ${bounds}`}</span> : null}>
      <input id={id} className="uis-input" type="text" inputMode="decimal" value={raw} placeholder={placeholder} disabled={ctx.readOnly}
             aria-invalid={invalid || undefined} aria-describedby={invalid ? hintId : undefined} aria-required={required === true || undefined}
             onChange={(e) => { setRaw(e.target.value); const n = parseNumberInput(e.target.value); if (n !== undefined) ctx.setValue(key, n) }} />
    </Field>
  )
}

/** Choices drawn as chips when they fit at a glance: a multiple choice always (each chip toggles, what is chosen is
 *  plain to see), a single one of a few options (choosing the chosen one again clears it); a longer single choice is a
 *  dropdown. */
const CHIP_CHOICES_MAX = 5

function SelectField({ el, ctx }: { el: El<'select'>; ctx: Ctx }) {
  const id = useId()
  const { key, label, options } = el.props
  const multiple = el.props.multiple === true
  const current = ctx.state[key]
  const chosen = multiple ? (Array.isArray(current) ? current.filter((v): v is string => typeof v === 'string') : []) : (typeof current === 'string' ? current : '')
  if (multiple || options.length <= CHIP_CHOICES_MAX) {
    const isOn = (value: string) => (multiple ? (chosen as string[]).includes(value) : chosen === value)
    const toggle = (value: string) => {
      if (multiple) {
        const list = chosen as string[]
        // the order the options are listed in, whatever order they were clicked in
        const next = list.includes(value) ? list.filter((v) => v !== value) : options.map((o) => o.value).filter((v) => v === value || list.includes(v))
        ctx.setValue(key, next)
      } else {
        ctx.setValue(key, chosen === value ? null : value)
      }
    }
    return (
      <div className="uis-field">
        <span className="uis-label" id={id}>{label}</span>
        <div className="uis-choices" role={multiple ? 'group' : 'radiogroup'} aria-labelledby={id}>
          {options.map((o) => (
            <button key={o.value} type="button" className={`uis-choice${isOn(o.value) ? ' on' : ''}`} role={multiple ? 'checkbox' : 'radio'} data-value={o.value}
                    aria-checked={isOn(o.value)} disabled={ctx.readOnly} onClick={() => toggle(o.value)}>
              {multiple && <span className="uis-choice-mark" aria-hidden>{isOn(o.value) ? '✓' : ''}</span>}
              {o.label}
            </button>
          ))}
        </div>
      </div>
    )
  }
  return (
    <Field label={label} id={id}>
      <select id={id} className="uis-input uis-select" disabled={ctx.readOnly} value={chosen as string}
              onChange={(e) => ctx.setValue(key, e.target.value ? e.target.value : null)}>
        <option value="">{chosen === '' ? 'Choose…' : '— none —'}</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </Field>
  )
}

function SliderField({ el, ctx }: { el: El<'slider'>; ctx: Ctx }) {
  const id = useId()
  const { key, label, min, max, step } = el.props
  const current = ctx.state[key]
  const value = typeof current === 'number' ? current : min
  return (
    <Field label={label} id={id}>
      <div className="uis-slider">
        <input id={id} type="range" min={min} max={max} step={step ?? 'any'} value={value} disabled={ctx.readOnly}
               onChange={(e) => ctx.setValue(key, sliderValue(Number(e.target.value), min, max, step))} />
        <output htmlFor={id} className="uis-slider-value">{typeof current === 'number' ? formatValue(current) : '—'}</output>
      </div>
    </Field>
  )
}

function CheckboxField({ el, ctx }: { el: El<'checkbox'>; ctx: Ctx }) {
  const id = useId()
  const { key, label } = el.props
  return (
    <div className="uis-check">
      <input id={id} type="checkbox" checked={ctx.state[key] === true} disabled={ctx.readOnly} onChange={(e) => ctx.setValue(key, e.target.checked)} />
      <label htmlFor={id}>{label}</label>
    </div>
  )
}

function ActionButton({ el, ctx }: { el: El<'button'>; ctx: Ctx }) {
  const { action: id, label } = el.props
  const act = ctx.actions.find((a) => a.id === id)
  if (act && uiActionMode(act) === 'run') {
    // a `run` action: one press starts the task; it waits while a task of the surface is under way
    const mine = ctx.task && ctx.task.record.action_id === id && isUiTaskActive(ctx.task.record.status) ? ctx.task.record.status : null
    return (
      <button type="button" className="thread-btn primary uis-button" disabled={ctx.readOnly || ctx.taskBusy} onClick={() => ctx.onAction(id)} data-testid={`ui-action-${id}`} data-mode="run"
              aria-busy={mine ? true : undefined} title={ctx.readOnly ? 'The replay shows the record' : RUN_TITLE}>
        {mine === 'queued' ? 'Queued…' : mine === 'running' ? 'Running…' : label}
      </button>
    )
  }
  const busy = ctx.action?.phase === 'preparing'
  return (
    <button type="button" className="thread-btn primary uis-button" disabled={ctx.readOnly || busy} onClick={() => ctx.onAction(id)} data-testid={`ui-action-${id}`} data-mode="draft"
            title={ctx.readOnly ? 'The replay shows the record' : DRAFT_TITLE}>
      {ctx.action?.snapshot.action_id === id && busy ? 'Preparing…' : label}
    </button>
  )
}

/** An image the contract calls safe (https, or an inline raster); its words otherwise, or when it fails to load. */
function SurfaceImage({ el }: { el: El<'image'> }) {
  const { src, alt } = el.props
  // the failure is the source's: a later revision of the surface that names another source tries that one (the element
  // is not drawn afresh for a revision)
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  if (!isSafeImageSrc(src) || failedSrc === src) return <div className="uis-image-missing" role="img" aria-label={alt || 'image'} data-testid="ui-image-missing">{alt || 'image not shown'}</div>
  return <img className="uis-image" src={src} alt={alt} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailedSrc(src)} />
}
