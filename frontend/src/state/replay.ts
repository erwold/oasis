import { create } from 'zustand'
import { api } from '../api/client'
import type { Relay, Run, RunTreeRow } from '../api/types'
import { type ReplayBody, stateAt } from './replayState'
import { useStore } from './store'
import type { ThreadEntry } from './thread'

/** The replay's clock (adapted from oasis state/replay.ts, see NOTICE): it walks from the session's first moment to
 *  its last at a chosen speed and, at every tick, writes the state of that moment into the live store — the thread,
 *  the desk's cards and the relays render it exactly as they rendered the live session, and nothing later than the
 *  moment. The live state is kept aside and reloaded whole at the end. */

interface Aside { runs: Run[]; threads: Record<string, ThreadEntry[]>; liveRunId: string | null; tree: RunTreeRow[]; childThreads: Record<string, ThreadEntry[]>; relays: Relay[] }

interface ReplayState {
  active: boolean; loading: boolean; body: ReplayBody | null
  t0: number; t1: number; cursor: number; playing: boolean; speed: number; aside: Aside | null
  start: (sessionId: string) => Promise<void>
  stop: () => void
  play: () => void
  pause: () => void
  setSpeed: (speed: number) => void
  seek: (t: number) => void
}

const TICK_MS = 100
let timer: number | null = null

function apply(body: ReplayBody, cursor: number, relays: Relay[]): void {
  useStore.setState(stateAt(body, cursor, relays, useStore.getState().session))
}

export const useReplay = create<ReplayState>((set, get) => ({
  active: false, loading: false, body: null, t0: 0, t1: 0, cursor: 0, playing: false, speed: 30, aside: null,

  start: async (sessionId) => {
    if (get().active || get().loading) return
    set({ loading: true })
    try {
      const body = await api.replay(sessionId)
      const t0 = body.t0 ? Date.parse(body.t0) : Date.now()
      const t1 = body.t1 ? Date.parse(body.t1) : t0
      const live = useStore.getState()
      for (const dispose of Object.values(live.disposers)) dispose()
      for (const dispose of Object.values(live.childDisposers)) dispose()          // no child stream writes over the replay
      const aside: Aside = { runs: live.runs, threads: live.threads, liveRunId: live.liveRunId, tree: live.tree, childThreads: live.childThreads, relays: live.relays }
      set({ active: true, loading: false, body, t0, t1, cursor: t0, playing: false, aside })
      useStore.setState({ replaying: true, disposers: {}, childDisposers: {} })
      apply(body, t0, aside.relays)
      get().play()
    } catch (e) {
      set({ loading: false })
      useStore.getState().showToast(`replay: ${e instanceof Error ? e.message : String(e)}`)
    }
  },

  stop: () => {
    if (timer != null) { window.clearInterval(timer); timer = null }
    set({ active: false, playing: false, body: null, aside: null })
    const session = useStore.getState().session
    useStore.setState({ replaying: false })
    if (session) void useStore.getState().openSession(session.id)   // the live state, reloaded (a run may have moved meanwhile)
  },

  play: () => {
    const s = get()
    if (!s.active || !s.body) return
    if (timer != null) window.clearInterval(timer)
    if (s.cursor >= s.t1) set({ cursor: s.t0 })
    let last = performance.now()
    timer = window.setInterval(() => {
      const now = get()
      if (!now.body) return
      const tick = performance.now()
      const cursor = Math.min(now.t1, now.cursor + (tick - last) * now.speed)
      last = tick
      set({ cursor })
      apply(now.body, cursor, now.aside?.relays ?? [])
      if (cursor >= now.t1) get().pause()
    }, TICK_MS)
    set({ playing: true })
  },

  pause: () => {
    if (timer != null) { window.clearInterval(timer); timer = null }
    set({ playing: false })
  },

  setSpeed: (speed) => set({ speed }),

  seek: (t) => {
    const s = get()
    if (!s.body) return
    const cursor = Math.min(s.t1, Math.max(s.t0, t))
    set({ cursor })
    apply(s.body, cursor, s.aside?.relays ?? [])
  },
}))
