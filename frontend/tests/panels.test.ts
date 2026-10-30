import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RunTreeRow } from '../src/api/types'
import { anyEntry, commandPulse, entriesPicker, foldAgents, keepUnchanged, sameData } from '../src/state/lineage.ts'
import { botClock, botState, buildTree, durationOf, railsOf, rowWindow, stateClock } from '../src/state/outline.ts'
import type { ThreadEntry } from '../src/state/thread.ts'

const row = (id: string, over: Partial<RunTreeRow> = {}): RunTreeRow => ({
  id, session_id: 's', parent_run_id: null, resumes_run_id: null, spawned_by: 'human', label: null, model: 'm', status: 'done', live: false,
  created_at: '2026-09-26T10:00:00.000Z', finished_at: '2026-09-26T10:01:30.000Z', workspace_id: 'ws', user_text: 'go', user_text_head: 'go',
  work_order: null, receipt: null, error: null, usage: {}, depth: 0, relay_id: null, relay_step: null, interaction_id: null, interaction_node: null, plan_node_id: null, participant_id: null, participant_alias: null, participant_index: null, participant_name: null, depends_on: [], scheduled_by: null, kind: 'run', ...over,
})

test('a tree read again keeps the rows that did not change, and the whole list when none did', () => {
  const first = foldAgents([row('a'), row('b', { parent_run_id: 'a', spawned_by: 'run:a', usage: { input: 3 } })])
  const same = foldAgents(structuredClone([row('a'), row('b', { parent_run_id: 'a', spawned_by: 'run:a', usage: { input: 3 } })]))
  assert.notEqual(same, first)
  assert.equal(keepUnchanged(first, same), first, 'the same data: the list as it was')
  const changed = foldAgents([row('a'), row('b', { parent_run_id: 'a', spawned_by: 'run:a', usage: { input: 4 } })])
  const kept = keepUnchanged(first, changed)
  assert.notEqual(kept, first)
  assert.equal(kept[0], first[0], 'the row that did not change is the object it was')
  assert.equal(kept[1], changed[1], 'the row that changed is the new one')
  // a row gone, a row come, the order changed: a new list, the unchanged rows kept
  const reordered = keepUnchanged(first, [changed[1]!, structuredClone(first[0]!)])
  assert.equal(reordered[1], first[0])
  assert.equal(keepUnchanged(null, same), same)
  assert.equal(sameData({ a: [1, { b: null }] }, { a: [1, { b: null }] }), true)
  assert.equal(sameData({ a: [1] }, { a: [1, 2] }), false)
  assert.equal(sameData({ a: undefined }, {}), false)
  assert.equal(sameData([1], { 0: 1 }), false)
})

test("a card's rows: the same answer while its runs' rows are the same arrays, whatever else the store holds", () => {
  const pick = entriesPicker()
  const mine: ThreadEntry[] = [{ kind: 'agent', text: 'hi', runId: 'a' }]
  const other: ThreadEntry[] = [{ kind: 'agent', text: 'other', runId: 'z' }]
  const first = pick(['a', 'b'], { a: mine, z: other }, {})
  assert.deepEqual(first, [mine, undefined], 'a run never read is undefined (not an empty conversation)')
  assert.equal(pick(['a', 'b'], { a: mine, z: [...other, ...other] }, {}), first, "another run's rows came: the same answer")
  const more = [...mine, { kind: 'agent', text: 'more', runId: 'a' } as ThreadEntry]
  const next = pick(['a', 'b'], { a: more }, { b: [] })
  assert.notEqual(next, first)
  assert.deepEqual(next, [more, []])
})

test('whether any run used the browser: each run looked at once per rows array', () => {
  let looks = 0
  const used = anyEntry((e) => { looks += 1; return e.tool === 'computer_act' })
  const a: ThreadEntry[] = [{ kind: 'activity', tool: 'bash', runId: 'a' }, { kind: 'agent', text: 'x', runId: 'a' }]
  const b: ThreadEntry[] = [{ kind: 'activity', tool: 'read_file', runId: 'b' }]
  assert.equal(used({ a }, { b }), false)
  assert.equal(looks, 3)
  assert.equal(used({ a }, { b }), false)
  assert.equal(looks, 3, 'the same arrays: no row looked at again')
  const c: ThreadEntry[] = [...a, { kind: 'activity', tool: 'computer_act', runId: 'a' }]
  assert.equal(used({ a: c }, { b }), true)
})

test("a row's clock stops once the time no longer changes what it shows", () => {
  const now = Date.parse('2026-09-26T10:01:40.000Z')                       // 10 s after the row ended
  const ended = row('a')
  assert.equal(stateClock(ended, now), now, 'just ended: its icon still plays done')
  const later = now + 60_000
  assert.equal(stateClock(ended, later), Number.POSITIVE_INFINITY)
  // what a stopped clock shows is what the time would show
  assert.equal(botState(ended, false, stateClock(ended, later)), botState(ended, false, later))
  assert.equal(durationOf(ended, stateClock(ended, later)), durationOf(ended, later))
  const failed = row('f', { status: 'error' })
  assert.equal(botState(failed, false, stateClock(failed, later)), botState(failed, false, later))
  const running = row('r', { status: 'running', finished_at: null })
  assert.equal(stateClock(running, later), later, 'a live row reads the time (its duration grows)')
  assert.equal(botClock(running, later), 0, "a live card's bot is its stream's, never the time's")
  assert.equal(botState(running, true, botClock(running, later)), botState(running, true, later))
  assert.equal(botClock(ended, now), now)
})

test('the rows drawn: those in view and a margin, never past the ends', () => {
  assert.deepEqual(rowWindow(0, 260, 300, 26, 30), { start: 0, end: 40 })
  assert.deepEqual(rowWindow(26 * 100, 260, 300, 26, 30), { start: 70, end: 140 })
  assert.deepEqual(rowWindow(26 * 295, 260, 300, 26, 30), { start: 265, end: 300 })
  assert.deepEqual(rowWindow(-50, 260, 5, 26, 30), { start: 0, end: 5 })
})

test("the rails stand where the rows' icons do, drawn or not, and only those crossing the view are kept", () => {
  // a thread row with 40 children, the 20th waiting on the 19th
  const rows = [row('t'), ...Array.from({ length: 40 }, (_, i) => row(`c${i}`, { parent_run_id: 't', spawned_by: 'run:t', depends_on: i === 20 ? ['c19'] : [] }))]
  const roots = buildTree(rows)
  const visible = [roots[0]!, ...roots[0]!.children]
  const base = { visible, roots, closed: new Set<string>(), folder: { x: 10, y: 15 }, ind: 22, rowH: 26, right: 300, spawnLit: new Set<string>(), selected: null, colorOf: () => '#000' }
  // every row in view: a line from the folder to the root and one from the root to each child, the one dependency
  const all = railsOf({ ...base, ref: { index: 0, depth: 0, at: { x: 33, y: 41 } }, top: 0, bottom: 10_000 })
  assert.equal(all.lines.length, 1 + 40)
  const toC5 = all.lines.find((l) => l.key === 't->c5')!
  assert.match(toC5.d, /^M33 51 /, "from the root's icon")
  assert.ok(toC5.d.endsWith(` L${33 + 22 - 10} ${41 + 6 * 26}`), "into the sixth child's icon, a row each and one step in")
  assert.deepEqual(all.edges.map((e) => [e.key, e.x, e.y1, e.y2]), [['c19~>c20', 300 - 9, 41 + 20 * 26 + 9, 41 + 21 * 26 - 9]])
  // measured from a row further down (the first one drawn), the same places
  const fromRow = railsOf({ ...base, ref: { index: 10, depth: 1, at: { x: 55, y: 41 + 10 * 26 } }, top: 0, bottom: 10_000 })
  assert.deepEqual(fromRow.lines, all.lines)
  assert.deepEqual(fromRow.edges, all.edges)
  // a view of rows 25 to 35: the children whose arm is in it, and of those below it only the last one (which runs
  // over the same stretch, drawn on top); none above it, no folder line, the dependency out of view
  const band = railsOf({ ...base, ref: { index: 0, depth: 0, at: { x: 33, y: 41 } }, top: 41 + 25 * 26, bottom: 41 + 35 * 26 })
  const keys = band.lines.map((l) => l.key)
  assert.deepEqual(keys, [...Array.from({ length: 11 }, (_, i) => `t->c${24 + i}`), 't->c39'])
  assert.deepEqual(band.edges, [])
  // a lit child below the view keeps its line (its flow is drawn)
  const lit = railsOf({ ...base, spawnLit: new Set(['c37']), ref: { index: 0, depth: 0, at: { x: 33, y: 41 } }, top: 41 + 25 * 26, bottom: 41 + 35 * 26 })
  assert.ok(lit.lines.some((l) => l.key === 't->c37' && l.lit))
  // a folded row draws no line to its children
  const folded = railsOf({ ...base, visible: [roots[0]!], closed: new Set(['t']), ref: { index: 0, depth: 0, at: { x: 33, y: 41 } }, top: 0, bottom: 10_000 })
  assert.deepEqual(folded.lines.map((l) => l.key), ['__session->t'])
  // nothing measured yet: nothing drawn
  assert.deepEqual(railsOf({ ...base, ref: null, top: 0, bottom: 10_000 }), { lines: [], edges: [] })
})

test("the terminal's pulse moves for the run's commands, not for its other tool calls", () => {
  const read: ThreadEntry = { kind: 'activity', tool: 'read_file', running: false, runId: 'a' }
  const bash = (running: boolean): ThreadEntry => ({ kind: 'activity', tool: 'bash', running, runId: 'a' })
  const rows: ThreadEntry[] = [bash(false), read, read]
  assert.equal(commandPulse(rows), 2)
  assert.equal(commandPulse([...rows, read, { kind: 'agent', text: 'x', runId: 'a' }]), 2, 'another read: the same pulse')
  assert.equal(commandPulse([...rows, bash(true)]), 3, 'a command running')
  assert.equal(commandPulse([...rows, bash(false)]), 4, 'a command ended')
  assert.equal(commandPulse([...rows, { kind: 'activity', tool: 'bash_output', running: false, runId: 'a' }]), 4, "a command's output read (it may have ended)")
})
