/** How an agent is shown on the timeline, the outline and the desk's cards (components/AgentPresentation.ts and its
 *  views): the words, the clock, what it does now, the live edge's redraw rate, the front lane; and, drawn by React
 *  DOM into an in-memory page, the timeline's live head (busy only on the run's own rows), a failed run's end mark,
 *  the front lane, and a card's state line. */

import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import ts from 'typescript'
import { JSDOM } from 'jsdom'
import { answerHead, cardStateWord, elapsedText, frontLaneOf, laneStatus, liveTickMs, stateTone, stateWord, subAgentCounts, toolsDone, workOf } from '../src/components/AgentPresentation.ts'
import { foldAgents } from '../src/state/lineage.ts'
import type { RunTreeRow } from '../src/api/types'
import { bigBoard } from './relationsFixtures.ts'

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL?.includes('/frontend/src/') && !/\.[a-z]+$/i.test(specifier)) {
      for (const ext of ['.ts', '.tsx']) { const u = new URL(`${specifier}${ext}`, context.parentURL); if (existsSync(u)) return next(u.href, context) }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (/\.(css|png|svg)$/.test(url)) return { format: 'module', source: `export default ${JSON.stringify(url)}`, shortCircuit: true }
    if (url.startsWith('file:') && url.endsWith('.tsx')) return { format: 'module', source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText, shortCircuit: true }
    return next(url, context)
  },
})
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://ui.invalid/' })
class NoResize { observe() {} unobserve() {} disconnect() {} }
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
  MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: NoResize, __OASIS_CODE_BUILD__: 'test' })
Object.assign(dom.window, { ResizeObserver: NoResize })
if (!globalThis.requestAnimationFrame) Object.assign(globalThis, { requestAnimationFrame: (f: (t: number) => void) => setTimeout(() => f(Date.now()), 0), cancelAnimationFrame: (id: number) => clearTimeout(id) })
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: dom.window.localStorage })
const { createElement, act } = await import('react')
const { createRoot } = await import('react-dom/client')
/** drawn by React DOM into the in-memory page (the stores read live, effects run), its markup read back */
async function drawn(element: ReturnType<typeof createElement>): Promise<string> {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(element))
  const html = host.innerHTML
  await act(async () => root.unmount())
  host.remove()
  return html
}
const { useStore } = await import('../src/state/store.ts')
const { useDesk } = await import('../src/state/desk.ts')
const { RelationsGraph } = await import('../src/components/RelationsGraph.tsx')
const { AgentCardStrip } = await import('../src/components/AgentPresentationView.tsx')
const { RunCard } = await import('../src/components/Desk.tsx')
const { RunRecords } = await import('../src/components/RunRecords.tsx')

test('the state words are short and true: a failure is failed, a stop is stopped (no failure), queued is never idle', () => {
  assert.deepEqual(['running', 'queued', 'done', 'error', 'cancelled', 'odd'].map(stateWord), ['running', 'queued', 'done', 'failed', 'stopped', 'odd'])
  assert.deepEqual(['running', 'queued', 'done', 'error', 'cancelled'].map(stateTone), ['live', 'wait', 'ok', 'bad', 'mute'])
  assert.equal(cardStateWord({ status: 'queued' }, 'waiting'), 'queued')
  assert.equal(cardStateWord({ status: 'running' }, 'working'), 'working')
  assert.equal(cardStateWord({ status: 'running' }, 'thinking'), 'thinking')
  assert.equal(cardStateWord({ status: 'running' }, 'waiting'), 'waiting')                        // a request slot, its folder
  assert.equal(cardStateWord({ status: 'running' }, 'blocked'), 'needs you')                      // a form it waits on
  assert.equal(cardStateWord({ status: 'done' }, 'done'), 'done')
  assert.equal(cardStateWord({ status: 'done' }, 'static'), 'done')
  // an ended run whose agent a watch or the person holds says so, where its bot plays it
  assert.equal(cardStateWord({ status: 'done' }, 'waiting'), 'waiting')
  assert.equal(cardStateWord({ status: 'done' }, 'blocked'), 'needs you')
  assert.equal(cardStateWord({ status: 'error' }, 'blocked'), 'error')                            // its own failure
  assert.equal(cardStateWord({ status: 'cancelled' }, 'idle'), 'cancelled')
})

test("a lane says queued while its run is queued, live or not; a live run otherwise runs; else its status", () => {
  assert.equal(laneStatus('queued', true), 'queued')
  assert.equal(laneStatus('queued', false), 'queued')
  assert.equal(laneStatus('waiting', true), 'waiting')
  assert.equal(laneStatus('running', true), 'running')
  assert.equal(laneStatus('done', true), 'running', 'the live word is newer than an older done')
  assert.equal(laneStatus('done', false), 'done')
  assert.equal(laneStatus('error', false), 'error')
  // the board of two running, one queued, one done: its lanes as its line says them
  assert.deepEqual([['running', true], ['running', true], ['queued', true], ['done', false]].map(([s, l]) => laneStatus(s as string, l as boolean)), ['running', 'running', 'queued', 'done'])
})

test('the elapsed clock is compact and keeps its width', () => {
  assert.equal(elapsedText(0), '0s')
  assert.equal(elapsedText(42_900), '42s')
  assert.equal(elapsedText(185_000), '3m 05s')
  assert.equal(elapsedText(72 * 60_000 + 30_000), '1h 12m')
  assert.equal(elapsedText(-1), '')
  assert.equal(elapsedText(Number.NaN), '')
})

test('the live edge is laid out again once it has grown a pixel: at most once a second, at least every 15 s', () => {
  assert.equal(liveTickMs(24), 2_500)        // the fastest scale: 24 px a minute
  assert.equal(liveTickMs(120), 1_000)       // never more than once a second
  assert.equal(liveTickMs(1.5), 15_000)      // the slowest scale: every 15 s, as before
  assert.equal(liveTickMs(0), 15_000)
  assert.equal(liveTickMs(Number.NaN), 15_000)
  assert.equal(liveTickMs(7) % 250, 0)
})

test('what a run does now is read from its own rows: the open tool call, else nothing', () => {
  assert.equal(workOf([]), null)
  assert.equal(workOf([{ kind: 'activity', tool: 'bash', summary: 'npm  test\n --watch', running: true }]), 'bash · npm test --watch')
  assert.equal(workOf([{ kind: 'activity', tool: 'bash', running: true }, { kind: 'activity', tool: 'read_file', running: false }]), null)
  assert.equal(workOf([{ kind: 'activity', tool: 'bash', running: true }, { kind: 'agent' }]), null, 'the model writes after it: no tool is open')
  assert.ok(workOf([{ kind: 'activity', tool: 'x', summary: 'y'.repeat(300), running: true }])!.length <= 96)
  assert.equal(toolsDone([{ kind: 'activity', running: false }, { kind: 'activity', running: true }, { kind: 'agent' }, { kind: 'activity' }]), 2)
  assert.equal(answerHead([{ kind: 'agent', text: '\n## Result\nmore' }, { kind: 'activity' }]), 'Result')
  assert.equal(answerHead([{ kind: 'user', text: 'hi' }]), null)
})

test('the front lane is the lane of the first bar of the front agent', () => {
  const bars = [{ lane: 'p0', run: { id: 'a' } }, { lane: 'p1', run: { id: 'b' } }, { lane: 'p1', run: { id: 'c' } }]
  assert.equal(frontLaneOf(bars, new Set(['c'])), 'p1')
  assert.equal(frontLaneOf(bars, new Set()), null)
  assert.equal(frontLaneOf(bars, new Set(['z'])), null)
})

function board() {
  const { graph } = bigBoard(6)
  const r1b = graph.runs.find((r) => r.id === 'r1b')!
  Object.assign(r1b, { status: 'error' })
  const r2b = graph.runs.find((r) => r.id === 'r2b')!
  Object.assign(r2b, { status: 'cancelled' })
  return graph
}
const draw = () => drawn(createElement(RelationsGraph, { graph: board(), agents: [], onOpen: () => {}, laneState: new Map([['p1', { status: 'error', run_id: 'r1b' }], ['p0', { status: 'running', run_id: 'r0b' }]]) }))
const el = (html: string, sel: string) => { const d = new JSDOM(html).window.document; return d.querySelector(sel) }

test('the timeline: a running bar has a ring at its end; it spreads only while the run\'s own rows say a tool runs', async () => {
  useStore.setState({ childThreads: {}, threads: {} } as never)
  let html = await draw()
  const head = el(html, '[data-testid="rg-head-r0b"]')
  assert.ok(head, 'a live bar carries its head')
  assert.equal(head!.getAttribute('data-busy'), 'false')
  assert.equal(el(html, '.rg-head-halo'), null, 'no activity said: no halo')
  assert.equal(el(html, '[data-testid="rg-head-r0a"]'), null, 'an ended bar has none')
  useStore.setState({ childThreads: { r0b: [{ kind: 'activity', runId: 'r0b', tool: 'bash', running: true }] } } as never)
  html = await draw()
  assert.equal(el(html, '[data-testid="rg-head-r0b"]')!.getAttribute('data-busy'), 'true')
  assert.ok(el(html, '[data-testid="rg-head-r0b"] .rg-head-halo.busy'))
  useStore.setState({ childThreads: {} } as never)
})

test('the timeline: failed and stopped runs end in a mark; lane words say failed; the front card\'s lane stands out', async () => {
  useDesk.setState({ windows: {} } as never)
  let html = await draw()
  assert.ok(el(html, '[data-testid="rg-bar-r1b"] .rg-cap'), 'a failed run: its end marked')
  assert.ok(el(html, '[data-testid="rg-bar-r2b"] .rg-cap'), 'a stopped run: its end marked')
  assert.equal(el(html, '[data-testid="rg-bar-r3b"] .rg-cap'), null, 'a done run: none')
  assert.equal(el(html, '[data-testid="rg-lane-p1"] [data-testid="rg-lane-state"]')!.textContent, 'failed')
  assert.equal(el(html, '.rg')!.classList.contains('has-front'), false)
  useDesk.setState({ windows: { 'run:r2a': { id: 'run:r2a', kind: 'run', runId: 'r2a', z: 5, min: false } } } as never)
  html = await draw()
  assert.ok(el(html, '.rg')!.classList.contains('has-front'))
  assert.ok(el(html, '[data-testid="rg-lane-p2"]')!.classList.contains('is-front'))
  assert.equal(el(html, '[data-testid="rg-lane-p1"]')!.classList.contains('is-front'), false)
  assert.ok(el(html, '[data-testid="rg-bar-r2b"]')!.classList.contains('is-front'))
  useDesk.setState({ windows: {} } as never)
})

test('a card\'s state line: the open tool call, the tools ended, the agents it started, its time — nothing made up', async () => {
  const latest = { id: 'run_x', status: 'running', created_at: new Date(Date.now() - 65_000).toISOString(), finished_at: null, model: 'm' }
  const row = { ...latest, latest, lineage: [latest] } as never
  useStore.setState({ childThreads: { run_x: [{ kind: 'activity', runId: 'run_x', tool: 'read_file', running: false }, { kind: 'activity', runId: 'run_x', tool: 'bash', summary: 'npm test', running: true }] } } as never)
  let html = await drawn(createElement(AgentCardStrip, { row, state: 'working', agents: 1 }))
  const strip = el(html, '[data-testid="agent-strip"]')!
  assert.equal(strip.getAttribute('data-status'), 'running')
  assert.equal(strip.querySelector('.ap-work')!.textContent, 'bash · npm test')
  assert.match(strip.querySelector('.ap-nums')!.textContent!, /^1 tool1 agent1m 0[45]s$/)
  assert.ok(!/%/.test(strip.textContent!), 'no percentage: nothing measures one')
  // ended: its answer's first line, its time still
  const ended = { ...latest, status: 'done', finished_at: new Date(Date.parse(latest.created_at) + 30_000).toISOString() }
  useStore.setState({ childThreads: { run_x: [{ kind: 'agent', runId: 'run_x', text: 'All 12 tests pass.' }] } } as never)
  html = await drawn(createElement(AgentCardStrip, { row: { ...ended, latest: ended, lineage: [ended] } as never, state: 'done', agents: 0 }))
  assert.equal(el(html, '.ap-work')!.textContent, 'All 12 tests pass.')
  assert.equal(el(html, '[data-testid="agent-elapsed"]')!.textContent, '30s')
  useStore.setState({ childThreads: {} } as never)
})

const treeRow = (id: string, over: Partial<RunTreeRow> = {}): RunTreeRow => ({
  id, session_id: 's', parent_run_id: null, resumes_run_id: null, spawned_by: 'human', label: null, model: 'm', status: 'done', live: false,
  created_at: '2026-10-17T10:00:00.000Z', finished_at: '2026-10-17T10:01:00.000Z', workspace_id: null, user_text: 'go', user_text_head: 'go',
  work_order: null, receipt: null, error: null, usage: {}, depth: 0, relay_id: null, relay_step: null, interaction_id: null, interaction_node: null, plan_node_id: null,
  participant_id: null, participant_alias: null, participant_index: null, participant_name: null, depends_on: [], scheduled_by: null, kind: 'run', ...over,
} as RunTreeRow)
const at = (min: number) => ({ created_at: new Date(Date.parse('2026-10-17T10:00:00Z') + min * 60_000).toISOString() })

test("a card counts the agents its whole lineage started, each once: r0 → r1, only r1 starts a child, the child goes on", () => {
  const tree = [
    treeRow('r0', at(0)),
    treeRow('r1', { ...at(2), resumes_run_id: 'r0' }),                                                    // the card's agent, continued
    treeRow('c0', { ...at(3), parent_run_id: 'r1', spawned_by: 'run:r1', depth: 1 }),                      // started by the later run
    treeRow('c1', { ...at(5), parent_run_id: 'r1', spawned_by: 'run:r1', depth: 1, resumes_run_id: 'c0' }), // the same child, continued
    treeRow('h', { ...at(6), parent_run_id: 'r1', spawned_by: 'human_action', model: null }),             // a person's action: no agent
  ]
  const agents = foldAgents(tree)
  assert.deepEqual(agents.map((a) => [a.id, a.lineage.map((r) => r.id)]), [['r0', ['r0', 'r1']], ['c0', ['c0', 'c1']], ['h', ['h']]])
  const counts = subAgentCounts(agents, tree)
  assert.equal(counts.get('r0'), 1, 'one agent, though it ran twice and was started by the second run')
  assert.equal(counts.get('c0'), undefined)
  // the old reading — the first run's children, every row — said 0 here; a second child of the first run makes 2
  const more = [...tree, treeRow('d0', { ...at(1), parent_run_id: 'r0', spawned_by: 'run:r0', depth: 1 })]
  assert.equal(subAgentCounts(foldAgents(more), more).get('r0'), 2)
  // a continuation that names its own agent's run as its parent is no agent it started
  const self = [treeRow('r0', at(0)), treeRow('r1', { ...at(2), resumes_run_id: 'r0', parent_run_id: 'r0' })]
  assert.equal(subAgentCounts(foldAgents(self), self).get('r0'), undefined)
})

/** a minimal parser: the rules at the top level and those in a prefers-reduced-motion block, in file order */
function rulesOf(css: string): { selectors: string[]; body: string; reduced: boolean; at: number }[] {
  const out: { selectors: string[]; body: string; reduced: boolean; at: number }[] = []
  const src = css.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
  const walk = (from: number, to: number, reduced: boolean) => {
    let i = from
    while (i < to) {
      const open = src.indexOf('{', i)
      if (open < 0 || open >= to) return
      const head = src.slice(i, open).trim()
      let depth = 1, j = open + 1
      while (j < to && depth) { if (src[j] === '{') depth++; else if (src[j] === '}') depth--; j++ }
      if (head.startsWith('@media')) { if (/prefers-reduced-motion:\s*reduce/.test(head)) walk(open + 1, j - 1, true) }
      else if (!head.startsWith('@')) out.push({ selectors: head.split(',').map((x) => x.trim()), body: src.slice(open + 1, j - 1), reduced, at: open })
      i = j
    }
  }
  walk(0, src.length, false)
  return out
}
const specificity = (sel: string): number => {
  const ids = (sel.match(/#[\w-]+/g) ?? []).length
  const classes = (sel.match(/\.[\w-]+|\[[^\]]+\]|(?<!:):(?!not\()[\w-]+/g) ?? []).length
  const types = (sel.replace(/\[[^\]]+\]|\.[\w-]+|::?[\w-]+(\([^)]*\))?/g, ' ').match(/(^|[\s>+~])[a-z][\w-]*/gi) ?? []).length
  return ids * 10_000 + classes * 100 + types
}
/** the simple tokens a selector needs (classes, attribute names): a selector needing a subset matches at least as much */
const tokens = (sel: string): Set<string> => new Set([...(sel.match(/\.[\w-]+/g) ?? []), ...(sel.match(/\[([\w-]+)/g) ?? []).map((a) => a.replace(/^\[/, '['))])

test('reduced motion stops every breath, halo and flow the agent surfaces start: as specific, later, and as broad', () => {
  const ANIMATED = /\.(ol-ring|ap-dot|rg-head-halo|desk-dot|ix-step-bar|ol-flow)\b/
  for (const file of ['../src/index.css', '../src/components/AgentPresentation.css']) {
    const rules = rulesOf(readFileSync(new URL(file, import.meta.url), 'utf8'))
    const stops = rules.filter((r) => r.reduced && /animation(-name)?\s*:\s*none/.test(r.body))
    let checked = 0
    for (const r of rules) {
      if (r.reduced || !/animation\s*:\s*(?!none)/.test(r.body)) continue
      for (const sel of r.selectors) {
        if (!ANIMATED.test(sel)) continue
        checked++
        const need = tokens(sel)
        const stop = stops.find((x) => x.selectors.some((t) => [...tokens(t)].every((k) => need.has(k)) && (/!important/.test(x.body) || (specificity(t) >= specificity(sel) && x.at > r.at))))
        assert.ok(stop, `${file}: nothing stops "${sel}" for a reduced-motion user`)
      }
    }
    assert.ok(checked > 0, `${file}: animated rules found`)
  }
  // the reading itself: the old rule would not have stopped the outline's dot
  assert.ok(specificity('.ol-node .ol-ring') < specificity('.ol-node[data-state="thinking"] .ol-ring'))
  assert.equal(specificity('.ol-node[data-state] .ol-ring'), specificity('.ol-node[data-state="working"] .ol-ring'))
  assert.equal(specificity('.ol-node.plan .ol-ring'), 300)
})

/** an in-memory data source: every read the card makes is answered here and written down */
function memorySource() {
  const calls: string[] = []
  const detail = { id: 'run_x', status: 'done', model: 'm', created_at: '2026-10-17T10:00:00.000Z', finished_at: '2026-10-17T10:01:00.000Z', receipt: {}, budget: {}, model_config_snapshot: {}, error: null, requests: [], children: [], live: false, depth: 0,
    executions: [{ id: 'ex1', command: 'npm test', status: 'done', exit_code: 0, stdout_bytes: 12, stderr_bytes: 0 }] }
  const source = {
    run: async (id: string) => { calls.push(`run ${id}`); return detail as never },
    output: async (id: string, stream: string) => { calls.push(`output ${id} ${stream}`); return { execution_id: id, stream, offset: 0, next_offset: 12, eof: true, text: 'tests passed', bytes: 12 } as never },
    diff: async (id: string) => { calls.push(`diff ${id}`); return { files: [{ path: 'a.ts', added: 1, removed: 0 }], base_commit: 'b'.repeat(40), tree_sha: 't'.repeat(40), patch: '', review_flags: [], patch_cut: null } as never },
    workspace: async (id: string) => { calls.push(`workspace ${id}`); return { checks: [{ id: 'c', check_id: 'unit', status: 'passed', reason: 'ok', stale: false, run_id: 'run_x' }] } as never },
  }
  return { source, calls }
}

test("a desk card reads its records, changes, terminal and checks from the data source it is handed, never the network", async () => {
  const fetched: string[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (u: unknown) => { fetched.push(String(u)); throw new Error('no network in this test') }) as typeof fetch
  try {
    const { source, calls } = memorySource()
    const latest = treeRow('run_x', { workspace_id: 'ws_1' })
    const row = { ...latest, latest, lineage: [latest] }
    // the thread tab's conversation comes from the store's watch (RunView), not the card's data source: held still here
    const watchChild = useStore.getState().watchChild
    useStore.setState({ runs: [], models: [], childThreads: {}, threads: {}, watchChild: async () => {} } as never)
    useDesk.setState({ windows: {}, expanded: null, focused: null } as never)
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const props = { win: { id: 'run:run_x', kind: 'run', runId: 'run_x', z: 1, min: false }, row, kids: [], place: { x: 0, y: 0, w: 480, h: 400, depth: 0, collapsed: false },
      dragging: false, resizing: false, clock: 0, onTitlePointerDown: () => {}, onResizePointerDown: () => {}, elRef: () => {}, subAgents: 2, dataSource: source }
    try {
    await act(async () => root.render(createElement(RunCard, props as never)))
    const click = async (tab: string) => { await act(async () => { (host.querySelector(`[data-testid="card-tab-${tab}"]`) as HTMLElement).click() }); await act(async () => { await new Promise((r) => setTimeout(r, 450)) }) }
    assert.match(host.querySelector('[data-testid="agent-strip"]')!.textContent!, /2 agents/)
    await click('records')
    await click('terminal')
    assert.match(host.querySelector('[data-testid="card-terminal"] pre')!.textContent!, /tests passed/)
    await click('checks')
    assert.match(host.querySelector('[data-testid="card-checks"]')!.textContent!, /unit/)
    await click('changes')
    assert.match(host.querySelector('[data-testid="card-changes"]')!.textContent!, /1 file\(s\)/)
    assert.ok(calls.includes('run run_x') && calls.includes('output ex1 stdout') && calls.includes('workspace ws_1') && calls.includes('diff ws_1'), calls.join('; '))
    assert.deepEqual(fetched.filter((u) => /\/api\/(runs|workspaces|executions)/.test(u)), [], 'no card read went to the API')
    } finally {
      await act(async () => root.unmount())
      host.remove()
      useStore.setState({ watchChild } as never)
    }
    // RunRecords on its own: the source handed, the API by default
    const { source: own, calls: ownCalls } = memorySource()
    const h2 = document.createElement('div'); document.body.append(h2)
    const r2 = createRoot(h2)
    try {
      await act(async () => r2.render(createElement(RunRecords, { run: { id: 'run_y', status: 'done', model: 'm', budget: {}, error: null } as never, dataSource: own })))
      assert.deepEqual(ownCalls, ['run run_y'])
      assert.ok(h2.querySelector('[data-testid="run-detail"]:not([data-loading])'), 'the detail it read is shown')
    } finally {
      await act(async () => r2.unmount())
      h2.remove()
    }
  } finally {
    globalThis.fetch = realFetch
  }
})

test("an agent chip's logo is its provider's: a DeepSeek route has DeepSeek's whale, a route the page does not know has none", async () => {
  const { agentLogo } = await import('../src/components/EntityChip.tsx')
  assert.match(String(agentLogo('deepseek:deepseek-chat', 'deepseek')), /logo-deepseek\.png$/)
  assert.match(String(agentLogo('deepseek:deepseek-chat')), /logo-deepseek\.png$/)
  assert.match(String(agentLogo('anthropic:claude-opus-5-5', 'anthropic')), /logo-claude\.png$/)
  assert.equal(agentLogo('scripted:a'), null)
})

test('run records show CNY request and receipt costs without a fictitious USD zero', async () => {
  const run = { id: 'cny_run', status: 'done', model: 'zhipu:glm-5.3', budget: {}, error: null }
  const mechanical = { requests: 1, tool_calls: 0, refused_calls: 0, gated_calls: 0, segments: 1, usage: {}, cost_usd: 0, cost_cny: 0.42,
    cost_status: 'estimated', cost_source: 'BigModel list', provider_models: ['glm-5.3'], executions: [], checkpoints: [] }
  const dataSource = { run: async () => ({ receipt: { mechanical }, model_config_snapshot: {}, manifest: {}, requests: [
    { id: 'req_cny', seq: 1, provider_reported_model: 'glm-5.3', status: 'ok', cost_usd: null, cost_cny: 0.42, cost_status: 'estimated', cost_source: 'BigModel list' },
  ] }) }
  const html = await drawn(createElement(RunRecords, { run: run as never, dataSource: dataSource as never }))
  assert.match(html, /¥0\.4200 CNY/)
  assert.doesNotMatch(html, /\$0\.0000/)
  assert.equal((html.match(/¥0\.4200 CNY/g) ?? []).length, 2)
})

for (const dollars of [.1, .22, .28, null]) {
  test(`Sonnet 5.5 run records render receipt and request ${dollars === null ? 'OAuth unknown, not zero' : `USD estimate ${dollars}`}`, async () => {
    const model = `${dollars === null ? 'anthropic' : 'anthropic-api'}:claude-sonnet-5-5`
    const run = { id: 'fixture_sonnet_run', status: 'done', model, budget: {}, error: null }
    const cost = { cost_usd: dollars, cost_cny: null, cost_status: dollars === null ? 'unknown' : 'estimated',
      cost_source: dollars === null ? null : 'https://platform.claude.com/docs/en/about-claude/pricing@2026-10-25' }
    const usage = dollars === .1
      ? { input_tokens: 1_000_000, cache_read_tokens: 1_000_000, cache_write_tokens: 0, output_tokens: 0 }
      : { input_tokens: 360_000, cache_read_tokens: 300_000, cache_write_tokens: 40_000, output_tokens: 5_000 }
    const mechanical = { ...cost, requests: 1, tool_calls: 0, refused_calls: 0, gated_calls: 0, segments: 1,
      usage, provider_models: ['claude-sonnet-5-5'], executions: [], checkpoints: [] }
    const dataSource = { run: async () => ({ receipt: { mechanical }, model_config_snapshot: {}, manifest: {}, requests: [
      { ...cost, ...usage, id: 'fixture_sonnet_request', seq: 1, provider_reported_model: 'claude-sonnet-5-5', status: 'ok' },
    ] }) }
    const html = await drawn(createElement(RunRecords, { run: run as never, dataSource: dataSource as never }))
    const page = document.createElement('div')
    page.innerHTML = html
    const receiptCost = Array.from(page.querySelectorAll('dt')).find((dt) => dt.textContent === 'cost')?.nextElementSibling?.textContent
    const requestCost = page.querySelector('tbody tr td:nth-child(7)')?.textContent
    const expected = dollars === null ? 'unknown (no price list)' : `≈ $${dollars.toFixed(4)} (${cost.cost_source})`
    assert.equal(receiptCost, expected)
    assert.equal(requestCost, expected)
    assert.doesNotMatch(html, /\$0\.0000|¥/)
  })
}
