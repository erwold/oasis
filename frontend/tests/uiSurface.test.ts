import assert from 'node:assert/strict'
import { test } from 'node:test'
import { UiSurfaceRecordSchema, UiSurfaceSpecSchema, parseUiSurfaceSpec, type UiState, type UiSurfaceSpec } from '@oasis-code/contract'
import {
  acceptState, appendToDraft, fallbackOf, footerActions, formatValue, isSurfaceRecord, parseNumberInput, placeOnce,
  reconcile, sameWord, sliderValue, snapshotAction, stateOf, supersedes, titleOf, valueAt, viewOf, writeState,
} from '../src/state/uiSurface.ts'
import { barsOf, chartPoints, chartSummary, lineOf, scaleOf, yOf } from '../src/state/uiChart.ts'
import { calculator, record, sharedChildren } from './uiFixtures.ts'

const spec = (): UiSurfaceSpec => {
  const parsed = parseUiSurfaceSpec(calculator())
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.errors.join('; '))
  return parsed.value
}

test('the fixtures are the protocol: the contract parses the spec and the record', () => {
  assert.ok(parseUiSurfaceSpec(calculator()).ok)
  assert.ok(UiSurfaceRecordSchema.safeParse(record()).success)
  assert.ok(isSurfaceRecord(record()))
})

test("a spec is read by the contract's whole parser, not its schema: shared children (2^depth draws) are refused", () => {
  const diamond = sharedChildren(20)
  assert.equal(UiSurfaceSpecSchema.safeParse(diamond).success, true, 'the schema alone accepts it (21 elements)')
  const view = viewOf({ spec: diamond as UiSurfaceSpec })
  assert.equal(view.ok, false)
  if (!view.ok) assert.match(view.reason, /already belongs to n0 \(an element has one parent\)/)
  // and the other refusals the parser owns, each a reason — never a throw
  for (const bad of [
    calculator({ version: 2 }), calculator({ root: 'nowhere' }), calculator({ actions: [] }),
    calculator({ elements: { main: { type: 'stack', children: ['main'] } } }),
    calculator({ elements: { main: { type: 'stack' }, lost: { type: 'divider' } } }),
    calculator({ elements: { main: { type: 'image', props: { src: 'javascript:alert(1)', alt: 'x' } } } }),
    calculator({ elements: { main: { type: 'marquee', props: {} } } }),
    calculator({ initial_state: { qty: 500, price: 4 } }),
  ]) {
    const v = viewOf({ spec: bad as UiSurfaceSpec })
    assert.equal(v.ok, false, JSON.stringify(bad).slice(0, 120))
  }
  assert.equal(viewOf({ spec: calculator() as UiSurfaceSpec }).ok, true)
})

test('a spec this build cannot draw still has its title and text version (an envelope of a later version)', () => {
  const later = { version: 2, surface_id: 'x', title: 'From the future', fallback: 'Plain words', kind: 'hologram' }
  assert.equal(viewOf({ spec: later as never }).ok, false)
  assert.equal(titleOf(later), 'From the future')
  assert.equal(fallbackOf(later), 'Plain words')
  assert.equal(fallbackOf({}), 'This surface has no text version.')
})

test("values are the contract's evaluator: numeric strings count, a list is no number", () => {
  assert.equal(valueAt({ op: 'add', args: ['2', 1] }, {}), 3)
  assert.equal(valueAt({ op: 'add', args: [{ state: 'xs' }] }, { xs: [1, 2] }), null)
  assert.equal(valueAt({ op: 'divide', args: [1, 0] }, {}), null)
  assert.equal(valueAt({ state: 'toString' }, {}), null)
  assert.equal(formatValue(1234.5, 'en-US'), '1,234.5')
  assert.equal(formatValue(null), '—')
  assert.equal(formatValue(['a', 2]), 'a, 2')
})

test("a record's state: the contract's defaults, then each kept value the contract accepts — null included", () => {
  const s = spec()
  assert.deepEqual(stateOf(s, {}), { qty: 3, price: 4, size: null, extras: [], gift: false })
  assert.deepEqual(stateOf(s, { qty: null, size: 'l', extras: ['card'], gift: true }), { qty: null, price: 4, size: 'l', extras: ['card'], gift: true })
  // a value of another kind, out of range, or a key the spec does not have is left at its default
  assert.deepEqual(stateOf(s, { qty: 500, size: 'xl', price: 'cheap', stray: 1 }), { qty: 3, price: 4, size: null, extras: [], gift: false })
})

test('null is the clearing value: an emptied number field writes null, never keeps the old number', () => {
  const s = spec()
  const before = stateOf(s, {})
  assert.equal(parseNumberInput(''), null)
  assert.equal(parseNumberInput('  '), null)
  assert.equal(parseNumberInput('12.5'), 12.5)
  assert.equal(parseNumberInput('abc'), undefined, 'words that are no number: nothing is written')
  assert.equal(parseNumberInput('1e999'), undefined)
  const cleared = writeState(s, before, 'qty', parseNumberInput(''))
  assert.equal(cleared.qty, null)
  assert.notEqual(cleared, before)
  assert.equal(writeState(s, before, 'size', null).size, null, 'a single select cleared')
})

test('a write the contract refuses leaves the state as it was: range, options, kinds, unknown keys', () => {
  const s = spec()
  const st = stateOf(s, {})
  assert.equal(writeState(s, st, 'qty', 0), st, 'below the input min')
  assert.equal(writeState(s, st, 'price', 11), st, 'above the slider max')
  assert.equal(writeState(s, st, 'size', 'xl'), st, 'not an option')
  assert.equal(writeState(s, st, 'extras', ['box', 'box']), st, 'chosen twice')
  assert.equal(writeState(s, st, 'gift', 'yes'), st)
  assert.equal(writeState(s, st, 'stray', 1), st, 'not a key of this surface')
  assert.deepEqual(writeState(s, st, 'extras', ['box', 'card']).extras, ['box', 'card'])
  assert.equal(acceptState(s, { ...st, qty: 5 })?.qty, 5)
  assert.equal(acceptState(s, { ...st, qty: 'five' }), null, 'a whole state an html page hands back is checked the same way')
})

test('footer actions are those no button offers; an html page only suggests, so the host offers all of its actions', () => {
  assert.deepEqual(footerActions(spec()).map((a) => a.id), ['explain'])
  const html = parseUiSurfaceSpec({ ...calculator(), kind: 'html', html: '<p>hi</p>', root: undefined, elements: undefined, initial_state: undefined })
  assert.ok(html.ok)
  if (html.ok) assert.deepEqual(footerActions(html.value).map((a) => a.id), ['order', 'explain'])
})

test('sliders: clamped to their scale and step', () => {
  assert.equal(sliderValue(3.3, 0, 10, 0.5), 3.5)
  assert.equal(sliderValue(42, 0, 10), 10)
  assert.equal(sliderValue(0.1 + 0.2, 0, 1, 0.1), 0.3)
})

test('records: the contract schema (model and created_at required); a later revision wins, then a strictly later write', () => {
  const { model: _m, ...noModel } = record()
  assert.ok(!isSurfaceRecord(noModel))
  const { created_at: _c, ...noCreated } = record()
  assert.ok(!isSurfaceRecord(noCreated))
  assert.ok(isSurfaceRecord(record({ model: null })))
  assert.ok(supersedes(record({ revision: 2 }), record({ revision: 1, updated_at: '2030-01-01T00:00:00.000Z' })))
  assert.ok(!supersedes(record({ revision: 1, updated_at: '2030-01-01T00:00:00.000Z' }), record({ revision: 2 })))
  assert.ok(supersedes(record({ updated_at: '2026-10-11T00:00:05.000Z' }), record()))
  assert.ok(!supersedes(record(), record({ updated_at: '2026-10-11T00:00:05.000Z' })))
  // the harness makes updated_at strictly increase per surface: an equal one is the same write again — never taken
  // over the one on the page, so the order of arrival decides nothing
  const a = record({ state: { qty: 4, price: 4 } }), b = record({ state: { qty: 5, price: 4 } })
  assert.ok(!supersedes(b, a) && !supersedes(a, b))
  assert.ok(!supersedes(record(), record()))
  assert.ok(sameWord(a, record({ state: { qty: 4, price: 4 } })))
})

test("reconcile: a new revision takes the record's state; while the person's edit waits, nothing undoes it", () => {
  const s = spec()
  const local = { revision: 1, state: { ...stateOf(s, {}), qty: 9 } }
  assert.equal(reconcile(local, record({ revision: 2, state: { qty: 1 } }), s, true).state.qty, 1)
  assert.equal(reconcile(local, record({ state: { qty: 5 } }), s, true), local, 'editing: kept')
  assert.equal(reconcile(local, record({ state: { qty: 5 } }), s, false).state.qty, 5, 'idle: the record is taken')
  assert.equal(reconcile(local, record({ state: { ...local.state } }), s, false), local, 'the same state: the same object (no redraw)')
})

test('a press is a fixed snapshot; a retry of the same snapshot keeps its key, any change is a new key', () => {
  let n = 0
  const id = () => `ui-test-${++n}`
  const state: UiState = { qty: 3, price: 4 }
  const first = snapshotAction(record(), 1, 'order', state, null, id)
  assert.deepEqual({ ...first, state: undefined }, { session_id: 's1', run_id: 'r1', surface_id: 'calc', revision: 1, action_id: 'order', state: undefined, request_id: 'ui-test-1' })
  state.qty = 99
  assert.equal(first.state.qty, 3, 'the snapshot keeps the state as pressed')
  assert.equal(snapshotAction(record(), 1, 'order', { qty: 3, price: 4 }, first, id).request_id, 'ui-test-1', 'the failed press again: same key')
  assert.equal(snapshotAction(record(), 1, 'order', { qty: 4, price: 4 }, first, id).request_id, 'ui-test-2', 'another state: a new key')
  assert.equal(snapshotAction(record(), 2, 'order', { qty: 3, price: 4 }, first, id).request_id, 'ui-test-3', 'another revision: a new key')
  assert.equal(snapshotAction(record(), 1, 'explain', { qty: 3, price: 4 }, first, id).request_id, 'ui-test-4', 'another action: a new key')
  assert.equal(snapshotAction(record({ session_id: 's2' }), 1, 'order', { qty: 3, price: 4 }, first, id).request_id, 'ui-test-5')
})

test('a prompt goes once per receipt into the draft, after what the person wrote (mentions kept), never over it', () => {
  const placed = new Set<string>()
  let draft = 'Ask @[Claude](agent:claude-opus) about it   '
  const put = (receipt: string, prompt: string) => placeOnce(placed, receipt, () => { draft = appendToDraft(draft, prompt) })
  assert.equal(put('rc1', '[UI action] Order'), true)
  assert.equal(put('rc1', '[UI action] Order'), false, 'a retry answered with the same receipt adds nothing')
  assert.equal(draft, 'Ask @[Claude](agent:claude-opus) about it\n\n[UI action] Order')
  assert.equal(appendToDraft('', 'x'), 'x')
  assert.equal(appendToDraft('keep me', '   '), 'keep me')
})

test('charts: bars from zero, negatives below it, gaps for no number; ±1e308 gives finite geometry, never NaN', () => {
  const points = chartPoints([{ label: 'Q1', value: 10 }, { label: 'Q2', value: { state: 'q2' } }, { label: 'Q3', value: -5 }, { label: 'Q4', value: 'n/a' }], { q2: 20 })
  assert.deepEqual(points.map((p) => p.value), [10, 20, -5, null])
  const bars = barsOf(points, 400, 100)
  assert.equal(bars.length, 3)
  const zero = yOf(0, scaleOf(points), 100)
  assert.ok(Math.abs(zero - 80) < 1e-9, 'zero sits a fifth up a 25-wide range')
  assert.ok(Math.abs(bars[0]!.y + bars[0]!.height - zero) < 1e-9, 'a positive bar stands on the zero line')
  assert.ok(Math.abs(bars[2]!.y - zero) < 1e-9, 'a negative bar hangs from it')
  assert.equal(lineOf([{ label: 'a', value: 1, text: '1' }, { label: 'b', value: null, text: '—' }, { label: 'c', value: 2, text: '2' }], 300, 100).path.split('M').length - 1, 2, 'a gap lifts the pen')
  const extreme = chartPoints([{ label: 'hi', value: 1e308 }, { label: 'lo', value: -1e308 }, { label: 'max', value: Number.MAX_VALUE }], {})
  const finite = (n: number) => Number.isFinite(n)
  const xb = barsOf(extreme, 320, 140)
  assert.equal(xb.length, 3)
  assert.ok(xb.every((b) => [b.x, b.y, b.width, b.height].every(finite)), JSON.stringify(xb.map(({ point: _p, ...g }) => g)))
  const xl = lineOf(extreme, 320, 140)
  assert.ok(xl.dots.every((d) => finite(d.x) && finite(d.y)))
  assert.doesNotMatch(xl.path, /NaN|Infinity/)
  assert.ok(finite(yOf(0, scaleOf(extreme), 140)))
  assert.equal(chartSummary('Revenue', 'bar', points.slice(0, 2)), 'Revenue: Q1 10, Q2 20')
})
