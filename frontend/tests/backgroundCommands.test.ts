import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { registerHooks } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { JSDOM } from 'jsdom'
import type { BackgroundCommand, OutputWindow, Receipt } from '@oasis-code/contract'
import type { Run, SessionDetail } from '../src/api/types.ts'

/** Commands that outlive their run (SessionDetail.background_commands) and the attribution of a run's changes, in the
 *  page: the header's count read from the session the page holds (stable references, the session's own ticker, a
 *  session left), its list (state, output, stop), and the receipt's surfaces (partial / unavailable said, never an
 *  empty "no change"; no automatic undo beside a background command). No browser, server or network: an in-memory
 *  DOM, a stand-in fetch. */

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
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://ui.invalid/' })
class FakeSource { addEventListener() {} removeEventListener() {} close() {} }
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, EventSource: FakeSource, IS_REACT_ACT_ENVIRONMENT: true, __OASIS_CODE_BUILD__: 'test' })
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: dom.window.localStorage })
const { createElement, act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { useStore } = await import('../src/state/store.ts')
const bg = await import('../src/state/backgroundCommands.ts')
const attr = await import('../src/state/attribution.ts')
const { nodeFacts } = await import('../src/state/interaction.ts')
const { BackgroundCommands } = await import('../src/components/BackgroundCommands.tsx')
const { TurnFooter } = await import('../src/components/ThreadTranscript.tsx')
const initial = { ...useStore.getState() }

const command = (id: string, status = 'running', over: Partial<BackgroundCommand> = {}): BackgroundCommand =>
  ({ execution_id: id, run_id: 'run_old', workspace_id: 'w', command: `npm run watch ${id}`, status, conversation_id: 'conv', ...over })
const run = (id: string, status = 'done', receipt: unknown = {}): Run => ({ id, session_id: 's', status, model: 'scripted:a', user_text: id, created_at: '2026-10-23T00:00:00.000Z', usage: {}, receipt } as unknown as Run)
const detail = (id: string, runs: Run[], commands?: BackgroundCommand[]): SessionDetail => ({
  id, project_id: 'p', model: 'scripted:a', title: id, workspace: { id: 'w', kind: 'direct', path: '/work/app' }, runs, director: null, interactions: [], relays: [],
  director_notes: [], active_run: null, active_children: [], run_count: runs.length, pending_approvals: [], event_cursor: 1, watches: [], wake_events: [],
  ...(commands ? { background_commands: commands } : {}),
} as unknown as SessionDetail)

interface Call { path: string; method: string }
type Reply = { body: unknown; status?: number } | undefined
let calls: Call[] = []
let handler: (c: Call) => Reply | Promise<Reply> = () => undefined
let root: ReturnType<typeof createRoot> | null = null
const container = document.getElementById('root')!
const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)) }) }
const mount = async (element: Parameters<ReturnType<typeof createRoot>['render']>[0]) => { root = createRoot(container); await act(async () => root!.render(element)); await flush() }
const click = async (el: Element | null) => { assert.ok(el, 'element to click'); await act(async () => (el as HTMLElement).click()); await flush() }
const q = (sel: string) => container.querySelector(sel)

beforeEach(() => {
  calls = []
  handler = () => undefined
  useStore.setState({ ...initial, session: null, runs: [], threads: {}, replaying: false })
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const c = { path: String(url), method: init?.method ?? 'GET' }
    calls.push(c)
    const reply = await handler(c)
    return new Response(JSON.stringify(reply?.body ?? { detail: 'not found' }), { status: reply?.status ?? (reply ? 200 : 404), headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
})
afterEach(async () => { if (root) { await act(async () => root!.unmount()); root = null }; await flush() })

// ---- the selector and the references it returns ----------------------------------------------------------------

test('the selector returns the stored list itself, and one frozen empty list for none — never a new array per call', () => {
  const none = { session: null }
  assert.equal(bg.selectBackgroundCommands(none), bg.NO_BACKGROUND)
  assert.equal(bg.selectBackgroundCommands({ session: detail('s', []) }), bg.NO_BACKGROUND)
  assert.equal(bg.selectBackgroundCommands({ session: detail('s', []) }), bg.selectBackgroundCommands({ session: detail('t', []) }))
  assert.ok(Object.isFrozen(bg.NO_BACKGROUND))
  const list = [command('x1')]
  const state = { session: detail('s', [], list) }
  assert.equal(bg.selectBackgroundCommands(state), list)
  assert.equal(bg.selectBackgroundCommands(state), bg.selectBackgroundCommands(state))
})

test('a read naming the same commands in the same states keeps the held list; a change, an end or another session does not', () => {
  const held = detail('s', [], [command('x1'), command('x2', 'unknown')])
  const same = detail('s', [], [command('x1'), command('x2', 'unknown')])
  assert.equal(bg.keepBackground(held, same).background_commands, held.background_commands)
  assert.equal(bg.backgroundChanged(held, same), false)
  const moved = detail('s', [], [command('x1', 'unknown'), command('x2', 'unknown')])
  assert.equal(bg.keepBackground(held, moved).background_commands, moved.background_commands)
  assert.equal(bg.backgroundChanged(held, moved), true)
  const ended = detail('s', [], [command('x2', 'unknown')])
  assert.equal(bg.backgroundChanged(held, ended), true)
  assert.equal(bg.backgroundChanged(held, detail('s', [])), true, 'the last command ended (the field absent)')
  assert.equal(bg.backgroundChanged(held, detail('s', [], [])), true, 'the last command ended (an empty list)')
  assert.equal(bg.backgroundChanged(detail('s', []), detail('s', [], [])), false, 'absent and empty are both none')
  const other = detail('t', [], [command('x1'), command('x2', 'unknown')])
  assert.equal(bg.keepBackground(held, other).background_commands, other.background_commands)
})

test('the header words: count, state, a remote writer whose end is not known never said as running', () => {
  assert.equal(bg.backgroundLabel([command('a')]), '1 background command from earlier runs still running')
  assert.equal(bg.backgroundLabel([command('a'), command('b')]), '2 background commands from earlier runs still running')
  assert.equal(bg.backgroundLabel([command('a', 'unknown')]), '1 background command from earlier runs, end not known yet')
  assert.match(bg.backgroundLabel([command('a'), command('b', 'unknown')]), /1 with an end not known yet/)
  assert.equal(bg.backgroundStatus('running'), 'running')
  assert.equal(bg.backgroundStatus('unknown'), 'end not known')
  assert.equal(bg.commandLine('python train.py\n--epochs 3'), 'python train.py …')
  assert.equal(bg.commandLine('x'.repeat(100), 10), `${'x'.repeat(9)}…`)
})

test('the output shown is the log\'s end, from a line start; a short log whole; an unreadable log as the harness said it', async () => {
  const log = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n')
  const asked: [number, number][] = []
  const window_ = (offset: number, limit: number): OutputWindow => {
    const text = log.slice(offset, offset + limit)
    return { execution_id: 'x', stream: 'stdout', offset, returned_bytes: text.length, total_bytes: log.length, next_offset: offset + text.length, eof: offset + text.length >= log.length, running: true, status: 'running', exit_code: null, truncated_at_cap: false, text }
  }
  const output = async (_id: string, _s: string, offset = 0, limit = 0) => { asked.push([offset, limit]); return window_(offset, limit) }
  const tail = await bg.readTail(output, 'x', 'stdout', 100)
  assert.deepEqual(asked, [[0, 100], [log.length - 100, 100]])
  assert.ok(tail.text.startsWith('…\nline '), tail.text.slice(0, 20))
  assert.ok(tail.text.endsWith('line 399'))
  asked.length = 0
  const short = await bg.readTail(output, 'x', 'stdout', log.length + 10)
  assert.equal(asked.length, 1)
  assert.equal(short.text, log)
  const gone = await bg.readTail(async () => ({ ...window_(0, 0), available: false, total_bytes: null, text: '' }), 'x', 'stdout')
  assert.equal(gone.available, false)
})

// ---- the store: the session's own ticker carries them ------------------------------------------------------------

test('syncSession takes the commands in idle and while a run of the thread works, keeps the reference for a read that moved nothing, and drops the last one\'s end', async () => {
  const live = run('run_new', 'running')
  let answer = detail('s', [run('run_old'), live], [command('x1')])
  handler = (c) => (c.path === '/api/sessions/s' ? { body: answer } : undefined)
  useStore.setState({ session: detail('s', [run('run_old'), live]), runs: [run('run_old'), live], threads: { run_old: [], run_new: [] }, disposers: { run_new: () => {} } as never })
  await useStore.getState().syncSession()
  const first = bg.selectBackgroundCommands(useStore.getState())
  assert.deepEqual(first.map((c) => c.execution_id), ['x1'])
  // the same commands again (a new array from the wire): the held reference stays — nothing draws again
  answer = detail('s', [run('run_old'), live], [command('x1')])
  await useStore.getState().syncSession()
  assert.equal(bg.selectBackgroundCommands(useStore.getState()), first)
  // a second one starts writing in the background while the new run still works
  answer = detail('s', [run('run_old'), live], [command('x1'), command('x2', 'unknown')])
  await useStore.getState().syncSession()
  assert.deepEqual(bg.selectBackgroundCommands(useStore.getState()).map((c) => [c.execution_id, c.status]), [['x1', 'running'], ['x2', 'unknown']])
  // both end: the count goes with the last one (the field absent: the stable empty list)
  answer = detail('s', [run('run_old'), live])
  await useStore.getState().syncSession()
  assert.equal(bg.selectBackgroundCommands(useStore.getState()), bg.NO_BACKGROUND)
})

test('a read of a session left lands on nothing: the session now shown keeps its own commands', async () => {
  let release!: () => void
  const held = new Promise<void>((r) => { release = r })
  handler = async (c) => {
    if (c.path !== '/api/sessions/s') return undefined
    await held
    return { body: detail('s', [], [command('from_s')]) }
  }
  useStore.setState({ session: detail('s', []) })
  const reading = useStore.getState().syncSession()
  await flush()
  // the person opened another session meanwhile
  const mine = [command('from_t')]
  useStore.setState({ session: detail('t', [], mine) })
  release()
  await reading
  assert.equal(useStore.getState().session?.id, 't')
  assert.equal(bg.selectBackgroundCommands(useStore.getState()), mine)
})

test('stopping a background command asks the session again at once (the count follows without waiting for the tick)', async () => {
  handler = (c) => (c.path.endsWith('/stop') ? { body: { stopped: true } } : c.path === '/api/sessions/s' ? { body: detail('s', []) } : c.path.includes('/runs/tree') ? { body: { session_id: 's', runs: [] } } : undefined)
  useStore.setState({ session: detail('s', [], [command('x1')]) })
  assert.equal(await useStore.getState().stopExecution('x1'), true)
  await flush()
  assert.ok(calls.some((c) => c.method === 'POST' && c.path === '/api/executions/x1/stop'))
  assert.ok(calls.some((c) => c.path === '/api/sessions/s'), 'the session read again')
  assert.equal(bg.selectBackgroundCommands(useStore.getState()), bg.NO_BACKGROUND)
})

// ---- the header's count and its list -------------------------------------------------------------------------------

test('the header count: a terminal glyph with its count and an accessible name; pressed, each command, its output and Stop; gone with the last one', async () => {
  const output: OutputWindow = { execution_id: 'x1', stream: 'stdout', offset: 0, returned_bytes: 12, total_bytes: 12, next_offset: 12, eof: true, running: true, status: 'running', exit_code: null, truncated_at_cap: false, text: 'epoch 3/10\n' }
  handler = (c) => (c.path.startsWith('/api/executions/x1/output') ? { body: output } : c.path.endsWith('/stop') ? { body: { stopped: true } } : undefined)
  useStore.setState({ session: detail('s', [], []) })
  await mount(createElement(BackgroundCommands))
  assert.equal(q('[data-testid="background-commands"]'), null, 'nothing without commands')
  await act(async () => useStore.setState({ session: detail('s', [], [command('x1'), command('x2', 'unknown', { run_id: null })]) }))
  const button = q('[data-testid="background-commands"]') as HTMLButtonElement
  assert.ok(button)
  assert.equal(button.dataset.count, '2')
  assert.equal(button.getAttribute('aria-label'), '2 background commands from earlier runs (1 with an end not known yet)')
  assert.equal(button.textContent, '2')
  assert.equal(q('[data-testid="background-commands-menu"]'), null)
  await click(button)
  assert.equal(button.getAttribute('aria-expanded'), 'true')
  const rows = [...container.querySelectorAll('[data-testid^="background-command-x"]')] as HTMLElement[]
  assert.deepEqual(rows.map((r) => [r.dataset.testid, r.dataset.status]), [['background-command-x1', 'running'], ['background-command-x2', 'unknown']])
  assert.match(rows[0]!.textContent ?? '', /npm run watch x1.*running/)
  assert.match(rows[1]!.textContent ?? '', /end not known/)
  // a command whose run is not known has no card to open
  assert.ok(rows[0]!.querySelector('[data-testid="background-command-run"]'))
  assert.equal(rows[1]!.querySelector('[data-testid="background-command-run"]'), null)
  // its output, on asking: one command's log read (no read for the other)
  await click(rows[0]!.querySelector('[data-testid="background-command-output-toggle"]'))
  assert.match(q('[data-testid="background-command-output"] pre')?.textContent ?? '', /epoch 3\/10/)
  assert.ok(calls.every((c) => !c.path.includes('/executions/x2/')), 'the closed command is not read')
  // Stop
  await click(rows[0]!.querySelector('[data-testid="background-command-stop"]'))
  assert.ok(calls.some((c) => c.method === 'POST' && c.path === '/api/executions/x1/stop'))
  // the commands end: the count goes and the list closes
  await act(async () => useStore.setState({ session: detail('s', [], []) }))
  assert.equal(q('[data-testid="background-commands"]'), null)
  assert.equal(q('[data-testid="background-commands-menu"]'), null)
  // a replay shows the record: no live command control there
  await act(async () => useStore.setState({ session: detail('s', [], [command('x1')]), replaying: true }))
  assert.equal(q('[data-testid="background-commands"]'), null)
})

test('the list closes on Escape; a failed output read says so instead of loading for ever', async () => {
  handler = (c) => (c.path.startsWith('/api/executions/x1/output') ? { body: { detail: 'the log is gone' }, status: 500 } : undefined)
  useStore.setState({ session: detail('s', [], [command('x1')]) })
  await mount(createElement(BackgroundCommands))
  await click(q('[data-testid="background-commands"]'))
  await click(q('[data-testid="background-command-output-toggle"]'))
  const error = q('[data-testid="background-command-output-error"]')
  assert.match(error?.textContent ?? '', /Could not read the output: 500: the log is gone/)
  assert.equal(q('[data-testid="background-command-output"] pre'), null, 'no "loading…" left standing')
  await act(async () => { document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  await flush()
  assert.equal(q('[data-testid="background-commands-menu"]'), null)
  assert.equal(q('[data-testid="background-commands"]')?.getAttribute('aria-expanded'), 'false')
})

test('another session opened closes the list of the one left', async () => {
  useStore.setState({ session: detail('s', [], [command('x1')]) })
  await mount(createElement(BackgroundCommands))
  await click(q('[data-testid="background-commands"]'))
  assert.ok(q('[data-testid="background-commands-menu"]'))
  await act(async () => useStore.setState({ session: detail('t', [], [command('y1')]) }))
  await flush()
  assert.equal(q('[data-testid="background-commands-menu"]'), null)
  assert.equal((q('[data-testid="background-commands"]') as HTMLElement).dataset.count, '1')
})

// ---- attribution ---------------------------------------------------------------------------------------------------

const receipt = (diff: Record<string, unknown>, files: string[] = ['src/a.ts']): Receipt => ({
  run_id: 'r1', produced: { files_changed: files, final_checkpoint_id: null },
  mechanical: { requests: 1, tool_calls: 2, refused_calls: 0, gated_calls: 0, segments: 1, usage: { input_tokens: 10, output_tokens: 5 }, provider_models: [], checkpoints: [], executions: [], diff, acceptance: {}, cost_status: 'unknown' },
} as unknown as Receipt)

test('attribution: absent is exact; partial keeps its excluded paths and background commands; unavailable says it is not "no change"', () => {
  assert.equal(attr.attributionOf(null).kind, 'exact')
  assert.equal(attr.attributionOf(receipt({ files: 1 })), attr.attributionOf(receipt({ files: 2 })), 'one stable exact view')
  assert.equal(attr.attributionWord(attr.attributionOf(receipt({ attribution: 'exact' }))), null)
  const partial = attr.attributionOf(receipt({ attribution: 'partial', unattributed_paths: ['src/gap.ts'], background_execution_ids: ['x1'] }))
  assert.equal(partial.kind, 'partial')
  assert.equal(attr.attributionWord(partial), 'partial')
  assert.match(attr.attributionDetail(partial), /Not counted .*: src\/gap\.ts/)
  assert.match(attr.attributionDetail(partial), /Background: x1/)
  const unavailable = attr.attributionOf(receipt({ attribution: 'unavailable', background_execution_ids: ['x1'] }, []))
  assert.equal(attr.attributionWord(unavailable), 'not attributable')
  assert.match(attr.attributionDetail(unavailable), /not the same as no change/)
})

test('undo: refused beside a background command (even after it ended) and when unavailable; a run with only unchained paths stays undoable', () => {
  assert.equal(attr.undoRefusal(receipt({})), null)
  assert.match(attr.undoRefusal(receipt({ attribution: 'partial', background_execution_ids: ['x1'] })) ?? '', /No automatic undo: a background command was/)
  assert.match(attr.undoRefusal(receipt({ attribution: 'unavailable' }, [])) ?? '', /No automatic undo/)
  assert.equal(attr.undoRefusal(receipt({ attribution: 'partial', unattributed_paths: ['src/gap.ts'] })), null)
})

test('a step\'s facts: unavailable is never "0 files changed"; a partial count says so', () => {
  assert.equal(nodeFacts(receipt({}, [])), '0 files changed')
  assert.equal(nodeFacts(receipt({ attribution: 'unavailable' }, [])), 'changes not attributable')
  assert.equal(nodeFacts(receipt({ attribution: 'partial' }, ['a', 'b'])), '2 files changed (partial)')
})

test('the turn footer: Undo beside a background command is refused with its reason (title, and said on a press), never sent', async () => {
  const done = run('r1', 'done', receipt({ attribution: 'partial', background_execution_ids: ['x1'], unattributed_paths: ['src/gap.ts'] }, ['src/a.ts', 'src/b.ts']))
  useStore.setState({ session: detail('s', [done]), runs: [done] })
  await mount(createElement(TurnFooter, { run: done, entries: [], receipt: receiptOfRun(done), words: 'go' }))
  const undo = q('[data-testid="undo-run"]') as HTMLButtonElement
  assert.ok(undo)
  assert.equal(undo.getAttribute('aria-disabled'), 'true')
  assert.equal(undo.dataset.refused, 'true')
  assert.match(undo.title, /No automatic undo/)
  await click(undo)
  assert.ok(!calls.some((c) => c.path.endsWith('/undo')), 'no undo request')
  assert.match(String(useStore.getState().notice ?? ''), /No automatic undo/)
  // an exact run of the same folder: Undo as before
  await act(async () => root!.unmount()); root = null
  const exact = run('r2', 'done', receipt({ attribution: 'exact' }, ['src/a.ts']))
  await mount(createElement(TurnFooter, { run: exact, entries: [], receipt: receiptOfRun(exact), words: 'go' }))
  const plain = q('[data-testid="undo-run"]') as HTMLButtonElement
  assert.equal(plain.getAttribute('aria-disabled'), null)
  assert.equal(plain.dataset.refused, undefined)
})

function receiptOfRun(r: Run): Receipt { return r.receipt as Receipt }
