import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CollaborationGraph } from '@oasis-code/contract'
import { agentsLine, boardAgents, GAP_PX, layoutRelations, scopeToAgents, tickClearsNow, timeScale, watchMarks } from '../src/state/relationsGraph.ts'
import { BIG_NOW, bigBoard } from './relationsFixtures.ts'

const T0 = Date.parse('2026-10-14T04:00:00Z')
const at = (min: number) => new Date(T0 + min * 60_000).toISOString()
const origin = (actor: string, client: string | null = null) => ({ actor, request: 'message', client, director_session_id: null, director_turn_id: null, tool_call_id: null, interaction_id: null, relay_id: null, watch_id: null, ui_task_id: null, parent_run_id: null, basis: 'recorded' })
const run = (id: string, participant: string | null, from: number, to: number | null, extra: Record<string, unknown> = {}) => ({
  id, status: to === null ? 'running' : 'done', live: to === null, model: 'm', label: null, created_at: at(from), finished_at: to === null ? null : at(to),
  workspace_id: null, resumes_run_id: null, interaction_id: null, interaction_node: null, relay_id: null, relay_step: null, user_text_head: `asked ${id}`,
  final_text_chars: to === null ? null : 100, error: null,
  collab: { participant_id: participant, participant_role: null, conversation_id: null, conversation_seq: null, origin: origin('person'), placement: { surface: 'thread', group: null, anchor: null } },
  ...extra,
})
const participant = (id: string, role: string, label: string, group: string | null = null, alias: string | null = null) => ({ id, session_id: 's', role, alias, label, model: 'm', group: group ? { kind: 'interaction', id: group } : null, introduced_by: origin('person'), current_conversation_id: null, latest_run_id: null, state: 'idle', run_count: 1, basis: 'recorded' })

function graph(): CollaborationGraph {
  const directed = (r: ReturnType<typeof run>) => ({ ...r, collab: { ...r.collab, origin: origin('director') } })
  return {
    actors: [{ kind: 'person' }, { kind: 'director', id: 'd', transport: 'native', label: 'Opus', model: 'opus', state: 'idle', tool_surface: 'director.v2', open: true }],
    participants: [participant('pb', 'member', 'B', 'ix', 'b'), participant('pm', 'main', 'Main'), participant('pa', 'member', 'A', 'ix', 'a')],
    groups: [{ kind: 'interaction', id: 'ix', status: 'done', controller: 'director', template: 'discussion', then: null, workspace_policy: null, rounds: null, participant_ids: ['pa', 'pb'], runs_started: 4, max_runs: null, concurrency: null, origin: null, anchor: null, reason: null, created_at: at(0), finished_at: at(30) }],
    runs: [
      run('rm1', 'pm', 0, 1),
      directed(run('ra1', 'pa', 2, 10, { interaction_node: 'solo-1' })),
      directed(run('rb1', 'pb', 2, 8, { interaction_node: 'solo-2' })),
      directed(run('ra2', 'pa', 12, 20, { interaction_node: 'cross-1' })),
      // two hours of rest, then the main agent again and a person's checkpoint
      run('rm2', 'pm', 140, 142),
      run('hand', null, 141, 141),
    ],
    edges: [
      { id: 'e1', kind: 'received', from: { kind: 'run', id: 'rb1' }, to: { kind: 'run', id: 'ra2' }, basis: 'recorded', created_at: at(12), meta: { handed_chars: 6612 } },
      { id: 'e2', kind: 'continues', from: { kind: 'run', id: 'ra1' }, to: { kind: 'run', id: 'ra2' }, basis: 'recorded', created_at: at(12) },
      { id: 'e3', kind: 'workspace', from: { kind: 'checkpoint', id: 'cp' }, to: { kind: 'run', id: 'ra1' }, basis: 'recorded', created_at: at(2) },
    ],
  } as unknown as CollaborationGraph
}

const opts = { width: 600, now: T0 + 200 * 60_000, clock: (t: number) => new Date(t).toISOString().slice(11, 16) }

test('lanes: the dispatcher over everyone, the main agent, the group by its members, what was done by hand last', () => {
  const l = layoutRelations(graph(), opts)
  assert.deepEqual(l.lanes.map((x) => [x.id, x.label]), [['dispatcher', 'Opus'], ['pm', 'Main'], ['pb', 'B'], ['pa', 'A'], ['hand', 'By hand']])
  assert.equal(l.lanes.find((x) => x.id === 'pa')!.sub, 'discussion · a')
  assert.ok(l.lanes.every((x, i) => i === 0 || x.y > l.lanes[i - 1]!.y))
  assert.equal(l.now_x, null)                                                               // nothing runs: no playhead
})

test('while a run works, the playhead stands at now, at the end of its growing bar; a planned step waits after everything that ran', () => {
  const g = graph()
  const live = { ...g, runs: [...g.runs, run('ra3', 'pa', 150, null, { interaction_id: 'ix' })],
    nodes: [{ id: 'ix/cross-2', interaction_id: 'ix', node_id: 'cross-2', kind: 'plan', participant_id: 'pb', alias: 'b', status: 'queued', run_ids: [], current_run_id: null, depends_on: [], receives: [], receive_runs: [], cites: [], workspace: 'own', wave: 3 }] } as unknown as CollaborationGraph
  const l = layoutRelations(live, { ...opts, now: T0 + 155 * 60_000 })
  const bar = l.bars.find((b) => b.run.id === 'ra3')!
  assert.ok(l.now_x !== null && Math.abs(l.now_x - bar.x1) < 1)
  const ghost = l.ghosts.find((x) => x.tag === 'cross-2')!
  assert.equal(ghost.lane, 'pb')
  assert.ok(ghost.x0 > Math.max(...l.bars.map((b) => b.x1)))
})

test('a run is a bar from its start to its end on its lane; two hours of rest are a short break', () => {
  const l = layoutRelations(graph(), opts)
  const bar = (id: string) => l.bars.find((b) => b.run.id === id)!
  assert.ok(bar('ra1').x1 > bar('ra1').x0 && bar('ra2').x0 > bar('ra1').x1)
  assert.equal(bar('ra1').tag, 'solo-1')
  // the rest between minute 20 and minute 140 takes the width of a break, not of two hours
  const rest = bar('rm2').x0 - bar('ra2').x1
  assert.ok(rest <= GAP_PX + 1, `the rest is drawn ${rest}px wide`)
  assert.ok(l.ticks.some((t) => t.gap))
})

test('arrows: dispatches from the dispatcher, handovers between runs with what was handed; a conversation in its own lane is the lane', () => {
  const l = layoutRelations(graph(), opts)
  assert.deepEqual(l.links.filter((k) => k.kind === 'dispatched').map((k) => k.run_to).sort(), ['ra1', 'ra2', 'rb1'])
  const handed = l.links.find((k) => k.kind === 'received')!
  assert.deepEqual([handed.run_from, handed.run_to, handed.chars], ['rb1', 'ra2', 6612])
  assert.equal(l.links.filter((k) => k.kind === 'continues').length, 0)
  assert.equal(l.links.some((k) => (k.kind as string) === 'workspace'), false)
})

test('clock labels never touch; a scale fills the width it is given within its bounds', () => {
  const l = layoutRelations(graph(), opts)
  const labelled = l.ticks.filter((t) => t.label)
  for (let i = 1; i < labelled.length; i++) assert.ok(labelled[i]!.x - labelled[i - 1]!.x >= 46)
  const s = timeScale([[0, 60 * 60_000]], 400)
  assert.ok(Math.abs(s.width - 400) < 2)
  assert.ok(timeScale([[0, 600 * 60_000]], 100).pxPerMs * 60_000 >= 1.5)                // never slower than 1.5 px a minute
})

test("a watch still set draws a clock after the last bar of its setter's lane, one per lane; a run not on the timeline draws none", () => {
  const layout = layoutRelations(graph(), { width: 600, now: T0 + 60 * 60_000, clock: () => '' })
  const [first] = layout.bars
  const lane = first!.lane
  const last = layout.bars.filter((b) => b.lane === lane).reduce((a, b) => (b.x1 > a.x1 ? b : a))
  const marks = watchMarks(layout.bars, [{ run_id: first!.run.id, label: 'timer · in 2 min' }, { run_id: first!.run.id, label: 'exit of x_1' }, { run_id: 'run_elsewhere', label: 'timer' }])
  assert.deepEqual(marks, [{ lane, x: last.x1, y: last.y, labels: ['timer · in 2 min', 'exit of x_1'] }])
})

test("a step that went on in further runs: its first bar says the step, the later ones its run's number", () => {
  const ix = (id: string, from: number, to: number, node: string) => run(id, 'pa', from, to, { interaction_id: 'ix_1', interaction_node: node })
  const g = { ...graph(), runs: [ix('r1', 0, 10, 'a1'), ix('r2', 12, 20, 'a1'), ix('r3', 21, 22, 'a1'), ix('r4', 0, 5, 'b1')], edges: [], participants: [participant('pa', 'member', 'A', 'ix_1', 'A')] } as unknown as CollaborationGraph
  const layout = layoutRelations(g, { width: 600, now: T0 + 60 * 60_000, clock: () => '' })
  assert.deepEqual(layout.bars.map((b) => [b.run.id, b.tag]), [['r1', 'a1'], ['r4', 'b1'], ['r2', 'a1·2'], ['r3', 'a1·3']])
})

test("the session's agents board: every agent, the main one among them, all its runs and its planned steps, what passed between them; nothing by hand; none for the main agent alone", () => {
  const g = graph()
  const planned = { ...g, nodes: [{ id: 'ix/cross-2', interaction_id: 'ix', node_id: 'cross-2', kind: 'plan', participant_id: 'pb', alias: 'b', status: 'queued', run_ids: [], current_run_id: null, depends_on: [], receives: [], receive_runs: [], cites: [], workspace: 'own', wave: 3 }] } as unknown as CollaborationGraph
  const board = scopeToAgents(planned)!
  assert.deepEqual(board.participants.map((p) => p.id), ['pb', 'pm', 'pa'])
  assert.deepEqual(board.runs.map((r) => r.id), ['rm1', 'ra1', 'rb1', 'ra2', 'rm2'])
  assert.deepEqual(board.edges.map((e) => e.id), ['e1', 'e2', 'e3'])
  assert.deepEqual(board.nodes.map((n) => n.node_id), ['cross-2'])
  const l = layoutRelations(board, opts)
  assert.deepEqual(l.lanes.map((x) => x.id), ['dispatcher', 'pm', 'pb', 'pa'])
  // the main agent first, the rest in the order they first ran (a tie in the participants' order), each as its latest
  // run stands; the line counts them
  const agents = boardAgents(board)
  assert.deepEqual(agents.map((a) => [a.participant.id, a.latest.id]), [['pm', 'rm2'], ['pb', 'rb1'], ['pa', 'ra2']])
  // the main agent working alone: no board
  assert.equal(scopeToAgents({ ...g, runs: g.runs.filter((r) => r.collab.participant_id === 'pm'), nodes: [] } as unknown as CollaborationGraph), null)
  assert.equal(agentsLine([{ latest: { status: 'running', live: true } }, { latest: { status: 'done', live: false } }, { latest: { status: 'error', live: false } }, { latest: { status: 'done', live: false } }]), '4 agents · 1 running · 2 done · 1 failed')
  assert.equal(agentsLine([{ latest: { status: 'cancelled', live: false } }]), '1 agent · 1 stopped')
  // queued is queued, never running — live or not; a live run whose status is older still runs
  const two = [{ latest: { status: 'running', live: true } }, { latest: { status: 'running', live: true } }, { latest: { status: 'queued', live: false } }, { latest: { status: 'done', live: false } }] as const
  assert.equal(agentsLine([...two]), '4 agents · 2 running · 1 queued · 1 done')
  assert.equal(agentsLine([{ latest: { status: 'queued', live: true } }]), '1 agent · 1 queued')
  assert.equal(agentsLine([{ latest: { status: 'done', live: true } }]), '1 agent · 1 running')
  assert.equal(agentsLine([{ latest: { status: 'queued', live: false } }, { latest: { status: 'running', live: false } }]), '2 agents · 1 running · 1 queued')
})

// ——— a long board (the numbers are the thresholds of relationsGraph.ts: FOLD_LANES_ABOVE 12, SETTLED_MS 30 min) ———

test('a long board folds its settled agents into one row; one that runs, has a step to come, a watch waiting or ended a moment ago keeps its lane; opened, every lane is back', () => {
  const { graph: g, watched } = bigBoard(300)
  const layout = layoutRelations(g, { width: 600, now: BIG_NOW, clock: () => '', keep: new Set([watched]) })
  // the dispatcher, the four that stay, the row of the 296 settled where the first of them stood — not 301 lanes
  assert.deepEqual(layout.lanes.map((l) => l.id), ['dispatcher', 'p0', 'p1', 'p2', 'p3', 'settled'])
  assert.equal(layout.lanes.at(-1)!.count, 296)
  assert.equal(layout.height, 22 + 6 * 30 + 6)
  assert.deepEqual([...new Set(layout.bars.map((b) => b.lane))], ['p0', 'p1', 'p2', 'p3'])
  assert.ok(layout.spans.length > 0 && layout.spans.length < 296, `${layout.spans.length} stretches`)
  assert.deepEqual(layout.ghosts.map((x) => x.lane), ['p1'])
  // what the settled handed to one that stays comes from their row; what passed among the settled stays folded
  const handed = layout.links.filter((k) => k.kind === 'received')
  assert.deepEqual(handed.map((k) => [k.lane_from, k.lane_to]), [['p0', 'p1'], ['p1', 'p2'], ['p2', 'p3'], ['p3', 'settled']])
  assert.equal(layout.links.filter((k) => k.kind === 'dispatched').length, 8)
  const open = layoutRelations(g, { width: 600, now: BIG_NOW, clock: () => '', keep: new Set([watched]), expanded: true })
  assert.equal(open.lanes.length, 302)
  assert.equal(open.bars.length, 600)
  assert.equal(open.spans.length, 0)
  // a board of no more than 12 lanes folds nothing, however long ago its agents ended (the six runs of a group just over)
  const small = layoutRelations(bigBoard(8).graph, { width: 600, now: BIG_NOW, clock: () => '' })
  assert.equal(small.lanes.length, 9)
  assert.equal(small.bars.length, 16)
})

test('a long board says when its next agent settles, so its lane folds then though nothing runs; one that ended a moment ago folds 30 minutes after it ended', () => {
  const { graph: g, watched } = bigBoard(300)
  const before = layoutRelations(g, { width: 600, now: BIG_NOW, clock: () => '', keep: new Set([watched]) })
  // the agent 3 ended five minutes before: it settles 25 minutes later
  assert.equal(before.settles_at, BIG_NOW + 25 * 60_000)
  assert.ok(before.lanes.some((l) => l.id === 'p3'))
  const after = layoutRelations(g, { width: 600, now: before.settles_at!, clock: () => '', keep: new Set([watched]) })
  assert.ok(!after.lanes.some((l) => l.id === 'p3'))
  assert.equal(after.lanes.find((l) => l.id === 'settled')!.count, 297)
  assert.equal(after.settles_at, null)                                         // the running, the planned, the watched wait for a new graph
  assert.equal(layoutRelations(bigBoard(8).graph, { width: 600, now: BIG_NOW, clock: () => '' }).settles_at, null)
})

test("the board's agents are found in passes over the runs, not a pass for every agent", () => {
  const { graph: g } = bigBoard(1000)
  let reads = 0
  const counted = <T extends object>(xs: T[]): T[] => new Proxy(xs, { get(target, key, receiver) { if (typeof key === 'string' && /^\d+$/.test(key)) reads++; return Reflect.get(target, key, receiver) } })
  const runs = g.runs.length
  const board = scopeToAgents({ ...g, runs: counted(g.runs), nodes: counted(g.nodes) })!
  assert.equal(board.participants.length, 1000)
  assert.ok(reads <= 4 * runs, `scopeToAgents read ${reads} runs and steps for ${runs} runs`)
  reads = 0
  const agents = boardAgents({ participants: board.participants, runs: counted(board.runs) })
  assert.equal(agents.length, 1000)
  assert.ok(reads <= 2 * runs, `boardAgents read ${reads} runs for ${runs} runs`)
})

test('a clock label never runs under "now": the tick whose words would touch the playhead keeps its mark, not its words; the others keep both', () => {
  // the playhead a few px after the first tick (a board a minute old): the start's words would sit under "now"
  assert.equal(tickClearsNow({ x: 0, gap: false }, 12), false)
  assert.equal(tickClearsNow({ x: 60, gap: false }, 12), true, 'a tick past now, clear of it')
  // a tick just before now, its words running into it; one far enough before stays
  assert.equal(tickClearsNow({ x: 400, gap: false }, 430), false)
  assert.equal(tickClearsNow({ x: 300, gap: false }, 430), true)
  // a break's words are centred on its mark
  assert.equal(tickClearsNow({ x: 420, gap: true }, 430), false)
  assert.equal(tickClearsNow({ x: 380, gap: true }, 430), true)
  // nothing runs: no playhead, every label stands
  assert.equal(tickClearsNow({ x: 0, gap: false }, null), true)
})
