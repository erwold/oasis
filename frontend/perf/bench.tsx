import { Profiler } from 'react'
import { createRoot } from 'react-dom/client'
import { Desk, revealRun } from '../src/components/Desk'
import { useStore } from '../src/state/store'
import type { ThreadEntry } from '../src/state/thread'
import '../src/index.css'

/** The desk on its own, in a real browser, on the bench's session (perf/fixtures.ts): the store is set as a session
 *  that just opened would set it, the backend is the driver's routes. What it counts: the commits and the render
 *  time React reports for the desk (react-dom/profiling), the renders of the components the build counts
 *  (perf/vite.perf.config.ts), the DOM it holds. */

type Counts = Record<string, number>
interface BenchWindow { __counts: Counts; __bench: unknown }
const w = window as unknown as BenchWindow
w.__counts = w.__counts ?? {}
const prof = { commits: 0, ms: 0 }

// the page's clocks (setInterval) run when the bench says, never on their own: a phase measures what it caused alone
// (the desk's and the outline's once-a-second clock while agents are live would otherwise land in any phase)
const clocks = new Map<number, () => void>()
let clockIds = 0
window.setInterval = ((fn: () => void) => { clockIds += 1; clocks.set(clockIds, fn); return clockIds }) as unknown as typeof window.setInterval
window.clearInterval = ((id: number) => { clocks.delete(id) }) as typeof window.clearInterval

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))

w.__bench = {
  open(data: { session: unknown; tree: unknown[]; threadRun: unknown }) {
    useStore.setState({
      session: data.session as never, tree: data.tree as never, runs: [data.threadRun] as never,
      threads: { run_main: [{ kind: 'user', text: 'start', runId: 'run_main' }, { kind: 'agent', text: 'dispatched the agents', runId: 'run_main' }] as ThreadEntry[] },
      childThreads: {}, childDisposers: {}, models: [],
    })
    const root = document.getElementById('root')!
    createRoot(root).render(
      <main className="thread desk-main" style={{ position: 'fixed', inset: 0 }}>
        <div className="composer-dock"><div style={{ width: 480, height: 120 }} /></div>
        <Profiler id="desk" onRender={(_id, _phase, actual) => { prof.commits += 1; prof.ms += actual }}><Desk /></Profiler>
      </main>,
    )
  },
  /** a jump to a run's card (the outline's click, the thread's summary): its card to the front */
  reveal(runId: string) { revealRun(runId) },
  reset() { for (const k of Object.keys(w.__counts)) w.__counts[k] = 0; prof.commits = 0; prof.ms = 0 },
  snapshot() {
    const s = useStore.getState()
    return {
      counts: { ...w.__counts }, commits: prof.commits, renderMs: Math.round(prof.ms * 10) / 10,
      domNodes: document.querySelectorAll('*').length,
      outlineRows: document.querySelectorAll('.ol-node:not(.folder)').length,
      railPaths: document.querySelectorAll('.ol-rail path').length,
      depEdges: document.querySelectorAll('[data-testid="ol-deps"] > g').length,
      cards: document.querySelectorAll('.desk-win.kind-run').length,
      runViews: document.querySelectorAll('[data-testid^="agent-view-"]').length,
      childThreads: Object.keys(s.childThreads).length,
      childThreadRows: Object.values(s.childThreads).reduce((n, rows) => n + rows.length, 0),
      heapMB: Math.round(((performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0) / 1e5) / 10,
    }
  },
  /** a live agent's stream: `k` events, each in a frame of its own (the store's frame batch sets one per frame) */
  async stream(runId: string, k: number) {
    for (let i = 0; i < k; i += 1) {
      const rows = useStore.getState().childThreads[runId] ?? []
      const entry: ThreadEntry = i % 2 ? { kind: 'agent', text: `word ${i}`, runId } as ThreadEntry : { kind: 'activity', tool: 'bash', toolCallId: `${runId}-live-${i}`, summary: `step ${i}`, running: false, runId } as ThreadEntry
      useStore.setState({ childThreads: { ...useStore.getState().childThreads, [runId]: [...rows, entry] } })
      await frame()
    }
  },
  /** the tree read again with nothing in it changed (every TREE_EVENT of any run does this) */
  async reloadTree(k: number) {
    for (let i = 0; i < k; i += 1) {
      useStore.setState({ tree: structuredClone(useStore.getState().tree) })
      await frame()
    }
  },
  /** every clock of the page fires once (a second goes by), `k` times, a frame between */
  async tick(k: number) {
    for (let i = 0; i < k; i += 1) {
      for (const fn of [...clocks.values()]) fn()
      await frame()
    }
    return clocks.size
  },
  frame,
}
