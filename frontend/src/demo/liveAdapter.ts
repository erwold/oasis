/** The live UI demo's isolation: the product's components read the page's stores, so for the demo's life the stores'
 *  actions that would reach the harness (a run read or stopped, a surface saved, a stream followed) or the browser's
 *  storage (the desk remembers its cards per session) are swapped for in-memory ones, and the stores' whole state is
 *  put back when the demo leaves. Nothing global is patched: no fetch, no localStorage, no EventSource — the swap is
 *  at the actions the components call. The surfaces' task and save queues of the demo session are taken first with
 *  in-memory work, so a surface drawn in the demo never lists or starts a task on the harness. */

import { useStore } from '../state/store'
import { useDesk, type DeskKind, type DeskWindow, type Size, type StackMode } from '../state/desk'
import { surfaceTasks, type TaskDeps } from '../state/uiTasks'
import { surfaceQueues, type QueueDeps, type SurfaceTarget } from '../state/uiQueue'

export interface AdapterCall { store: 'page' | 'desk'; action: string; at: number }

/** Every action the components asked of the stores while the demo ran (none reached the harness or the storage). */
const calls: AdapterCall[] = []
export const adapterCalls = (): readonly AdapterCall[] => calls
const note = (store: AdapterCall['store'], action: string) => { calls.push({ store, action, at: Date.now() }); if (calls.length > 500) calls.shift() }

/** The page store's actions that only change what the page shows (no request, no storage): kept as they are. */
const LOCAL_PAGE_ACTIONS = new Set(['showToast', 'setNotice'])

/** In the demo, an action of the page store does nothing but say it was asked; a few answer what their callers read. */
function pageStandIns(state: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(state)) {
    if (typeof value !== 'function' || LOCAL_PAGE_ACTIONS.has(key)) continue
    if (key === 'startSync') out[key] = () => { note('page', key); return () => undefined }
    else if (key === 'placeActionPrompt') out[key] = () => { note('page', key); return false }
    else if (key === 'saveSurfaceState' || key === 'prepareSurfaceAction') out[key] = () => { note('page', key); return Promise.reject(new Error('the demo saves nothing')) }
    else out[key] = () => { note('page', key); return Promise.resolve(undefined) }
  }
  return out
}

type DeskSet = typeof useDesk.setState
type DeskGet = typeof useDesk.getState

/** The desk's actions as they are, without the storage: the same moves in memory only. */
function deskStandIns(set: DeskSet, get: DeskGet) {
  // the demo's desk holds the agents' cards only: its team and its timeline are drawn on the page, and a worktree, a
  // browser or a ChatGPT page are not part of it (their cards would read the harness)
  const ensure = (id: string, kind: DeskKind, runId?: string) => {
    note('desk', 'ensure')
    if (kind !== 'run' || get().windows[id]) return
    const z = get().zTop + 1
    set({ windows: { ...get().windows, [id]: { id, kind, runId, z, min: false } }, zTop: z })
  }
  const focus = (id: string) => {
    note('desk', 'focus')
    const s = get(), win = s.windows[id]
    if (!win || win.z === s.zTop) return
    const z = s.zTop + 1
    set({ windows: { ...s.windows, [id]: { ...win, z } }, zTop: z })
  }
  const setMin = (id: string, min: boolean) => {
    note('desk', 'setMin')
    const s = get(), win = s.windows[id]
    if (!win) return
    set({ windows: { ...s.windows, [id]: { ...win, min } }, expanded: s.expanded === id && min ? null : s.expanded })
  }
  return {
    reveal: (windowId: string, runId: string) => {
      note('desk', 'reveal')
      if (!get().windows[windowId]) ensure(windowId, 'run', windowId.startsWith('run:') ? windowId.slice(4) : undefined)
      if (get().windows[windowId]?.min) setMin(windowId, false)
      focus(windowId)
      const pending = { ...get().pendingReveal }
      delete pending[runId]
      set({ focused: { windowId, runId, nonce: (get().focused?.nonce ?? 0) + 1 }, pendingReveal: pending, revealed: { ...get().revealed, [windowId]: Date.now() } })
    },
    waitReveal: (runId: string, at: number) => set({ pendingReveal: { ...get().pendingReveal, [runId]: at } }),
    dropPending: (runIds: string[]) => {
      if (!runIds.some((id) => id in get().pendingReveal)) return
      const pending = { ...get().pendingReveal }
      for (const id of runIds) delete pending[id]
      set({ pendingReveal: pending })
    },
    setStackMode: (stackMode: StackMode) => { note('desk', 'setStackMode'); set({ stackMode }) },
    // a session's desk starts empty: the demo never reads a remembered one
    openSession: (sessionId: string | null) => {
      note('desk', 'openSession')
      if (sessionId === get().sessionId) return
      set({ sessionId, windows: {}, expanded: null, zTop: 1, focused: null, pendingReveal: {}, revealed: {} })
    },
    ensure, focus, setMin,
    expand: (id: string | null) => {
      note('desk', 'expand')
      const s = get()
      if (id && s.windows[id]?.min) set({ windows: { ...s.windows, [id]: { ...s.windows[id], min: false } }, expanded: id })
      else set({ expanded: id })
    },
    forget: (id: string) => {
      note('desk', 'forget')
      const s = get()
      if (!s.windows[id]) return
      const windows: Record<string, DeskWindow> = { ...s.windows }
      delete windows[id]
      set({ windows, expanded: s.expanded === id ? null : s.expanded })
    },
    setStackCorner: (stackCorner: ReturnType<DeskGet>['stackCorner']) => set({ stackCorner }),
    setGraphCorner: (graphCorner: ReturnType<DeskGet>['graphCorner']) => set({ graphCorner }),
    setCardSize: (size: Size) => set({ card: { w: Math.round(Math.max(240, size.w)), h: Math.round(Math.max(160, size.h)) } }),
    setGraphSize: (size: Size) => set({ graph: { w: Math.round(Math.max(220, size.w)), h: Math.round(Math.max(140, size.h)) } }),
  }
}

const taskStandIns: TaskDeps = {
  list: async () => [],
  get: () => Promise.reject(new Error('the demo has no tasks')),
  cancel: () => Promise.reject(new Error('the demo has no tasks')),
  follow: () => () => undefined,
}

const queueStandIns: QueueDeps = {
  delay: 450,
  save: () => Promise.reject(new Error('the demo saves nothing')),
  prepare: () => Promise.reject(new Error('the demo prepares nothing')),
  place: () => false,
  isConflict: () => false,
  onConflict: () => undefined,
}

/** The demo's surfaces' queues, taken before the surfaces draw (a registry keeps the first taker's work). */
export function claimSurfaces(targets: SurfaceTarget[]): void {
  for (const t of targets) {
    surfaceTasks.acquire(t, taskStandIns)
    surfaceQueues.acquire(t, queueStandIns)
  }
}

let installed: (() => void) | null = null

/** Swap the stores' actions for the demo's; the returned function puts both stores back as they were (state and
 *  actions). Installing twice keeps the first. */
export function installLiveAdapter(): () => void {
  if (installed) return installed
  const page = useStore.getState()
  const desk = useDesk.getState()
  useStore.setState(pageStandIns(page as unknown as Record<string, unknown>) as Partial<typeof page>)
  useDesk.setState(deskStandIns(useDesk.setState, useDesk.getState))
  const restore = () => {
    useStore.setState(page, true)
    useDesk.setState(desk, true)
    installed = null
  }
  installed = restore
  return restore
}
