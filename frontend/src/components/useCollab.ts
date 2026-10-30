import { useMemo } from 'react'
import { graphAt, legacyGraph, type CollabView } from '../state/collab'
import { foldAgents, type Lineage } from '../state/lineage'
import { botFor } from '../state/outline'
import { useReplay } from '../state/replay'
import { useStore } from '../state/store'

/** The session's collaboration as the components read it: the harness's graph when it served one (cut to the
 *  replay's moment while a replay plays), else the page's projection of the rows it holds — never nothing while a
 *  session is open. `source` says which, so the UI can say "from older records". */
export function useCollabView(): CollabView | null {
  const session = useStore((s) => s.session)
  const collab = useStore((s) => s.collab)
  const tree = useStore((s) => s.tree)
  const runs = useStore((s) => s.runs)
  const interactions = useStore((s) => s.interactions)
  const relays = useStore((s) => s.relays)
  const turns = useStore((s) => s.director?.turns)
  const replaying = useReplay((s) => s.active)
  const cursor = useReplay((s) => s.cursor)
  return useMemo(() => {
    if (!session) return null
    const graph = collab.sessionId === session.id ? collab.graph : null
    if (graph) {
      if (!replaying) return { source: 'graph', graph }
      return { source: 'graph', graph: cutAt(graph, cursor, tree) }
    }
    return { source: 'legacy', graph: projected(session.id, session.workspace?.id ?? null, tree, runs, interactions, relays, turns ?? NO_TURNS) }
  }, [session, collab, tree, runs, interactions, relays, turns, replaying, cursor])
}

const NO_TURNS: never[] = []
let lastCut: { graph: unknown; cursor: number; tree: unknown; out: ReturnType<typeof graphAt> } | null = null
function cutAt(graph: Parameters<typeof graphAt>[0], cursor: number, tree: { id: string; status: string }[]) {
  if (lastCut && lastCut.graph === graph && lastCut.cursor === cursor && lastCut.tree === tree) return lastCut.out
  const at = new Map(tree.map((r) => [r.id, r.status]))
  const out = graphAt(graph, cursor, (id) => at.get(id))
  lastCut = { graph, cursor, tree, out }
  return out
}
// the projection is shared by every component that reads it (each turn's handover line, the summaries, the dock):
// computed once per change of what it is made of
let last: { args: unknown[]; graph: ReturnType<typeof legacyGraph> } | null = null
function projected(...args: [string, string | null, Parameters<typeof legacyGraph>[0]['tree'], Parameters<typeof legacyGraph>[0]['runs'], Parameters<typeof legacyGraph>[0]['interactions'], Parameters<typeof legacyGraph>[0]['relays'], Parameters<typeof legacyGraph>[0]['turns']]) {
  if (last && last.args.length === args.length && last.args.every((a, i) => a === args[i])) return last.graph
  const [sessionId, sessionWorkspaceId, tree, runs, interactions, relays, turns] = args
  const graph = legacyGraph({ sessionId, sessionWorkspaceId, tree, runs, interactions, relays, turns })
  last = { args, graph }
  return graph
}

/** The desk's agents (one card each), memoised over the tree. */
export function useAgents(): Lineage[] {
  const tree = useStore((s) => s.tree)
  return useMemo(() => foldAgents(tree), [tree])
}

/** The bot each run wears everywhere it is named outside its own turn (a summary, the relations): its card's — the
 *  first agent that carries it — so a participant is one picture on its card, in the thread's summary and in the
 *  relations. One pass over the agents, for every run at once. */
export function botsOfRuns(agents: Lineage[]): Map<string, string | null> {
  const bots = new Map<string, string | null>()
  for (const agent of agents) {
    const bot = botFor(agent)
    for (const r of agent.lineage) if (!bots.has(r.id)) bots.set(r.id, bot)
  }
  return bots
}
