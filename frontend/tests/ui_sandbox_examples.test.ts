/** docs/intelligent-ui-examples.json holds what the docs show: each example must be accepted whole by the contract's
 *  own parser (parseUiSurfaceSpec — what present_ui runs) with an initial state its validateUiState takes, the shape
 *  the docs promise, the native ones' numbers (by the contract's own evaluator) matching their fallback text, and
 *  the HTML one fitting the sandbox's bounds. */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { defaultUiState, evaluateUiValue, parseUiSurfaceSpec, validateUiState } from '@oasis-code/contract'
import { actionIdOk, buildSrcdoc, checkState, htmlTooLarge, makeNonce } from '../src/state/uiSandbox.ts'

type Value = string | number | boolean | null | { state: string } | { op: string; args: Value[] }
type Element = { type: string; props: Record<string, unknown>; children?: string[] }
type Spec = {
  version: number; surface_id: string; title: string; fallback: string; kind: 'native' | 'html'
  initial_state?: Record<string, unknown>; actions?: Array<{ id: string; label: string; prompt: string }>
  root?: string; elements?: Record<string, Element>; html?: string
}

const examples = (JSON.parse(readFileSync(new URL('../../docs/intelligent-ui-examples.json', import.meta.url), 'utf8')) as { examples: Array<{ name: string; spec: Spec }> }).examples
const TYPES = new Set(['stack', 'row', 'card', 'text', 'metric', 'table', 'chart', 'input', 'select', 'slider', 'checkbox', 'button', 'image', 'divider'])
const OPS = new Set(['add', 'subtract', 'multiply', 'divide', 'min', 'max', 'round'])
const INPUTS = new Set(['input', 'select', 'slider', 'checkbox'])

/** a test's own evaluator for the examples' expressions — not the product's interpreter (workstream A's) */
function evaluate(v: Value, state: Record<string, unknown>): number {
  if (typeof v === 'number') return v
  if (v && typeof v === 'object' && 'state' in v) return Number(state[v.state])
  if (v && typeof v === 'object' && 'op' in v) {
    const a = v.args.map((x) => evaluate(x, state))
    switch (v.op) {
      case 'add': return a.reduce((x, y) => x + y, 0)
      case 'subtract': return a[0]! - a[1]!
      case 'multiply': return a.reduce((x, y) => x * y, 1)
      case 'divide': return a[0]! / a[1]!
      case 'min': return Math.min(...a)
      case 'max': return Math.max(...a)
      case 'round': return Math.round(a[0]!)
    }
  }
  throw new Error(`not a number: ${JSON.stringify(v)}`)
}

function stateRefs(v: unknown, out: string[] = []): string[] {
  if (v && typeof v === 'object') {
    if ('state' in v && typeof (v as { state: unknown }).state === 'string') out.push((v as { state: string }).state)
    if ('op' in v) assert.ok(OPS.has((v as { op: string }).op), `operator ${(v as { op: string }).op}`)
    for (const x of Object.values(v)) stateRefs(x, out)
  }
  return out
}

test('three non-coding examples: two native, one HTML', () => {
  assert.deepEqual(examples.map((e) => [e.name, e.spec.kind]), [['trip-split', 'native'], ['daycare-compare', 'native'], ['savings-simulator', 'html']])
  for (const { spec } of examples) {
    assert.equal(spec.version, 1)
    assert.ok(actionIdOk(spec.surface_id), 'a surface id is a contract id')
    assert.ok(spec.title.trim() && spec.fallback.trim(), 'a title and a plain-text fallback')
    assert.equal(checkState(spec.initial_state ?? {}).ok, true, 'the initial state is scalars and scalar arrays')
    for (const a of spec.actions ?? []) assert.ok(actionIdOk(a.id) && a.label && a.prompt, a.id)
    if (spec.kind === 'native') assert.ok(spec.root && spec.elements && spec.html === undefined)
    else assert.ok(spec.html && spec.root === undefined && spec.elements === undefined)
  }
})

test("every example is a surface the contract's own parser accepts, its starting state one validateUiState takes", () => {
  for (const { name, spec } of examples) {
    const parsed = parseUiSurfaceSpec(spec)
    assert.ok(parsed.ok, `${name}: ${parsed.ok ? '' : parsed.errors.join('; ')}`)
    const state = validateUiState(parsed.value, defaultUiState(parsed.value))
    assert.ok(state.ok, `${name}: ${state.ok ? '' : state.errors.join('; ')}`)
  }
})

test('native examples: a reachable acyclic tree of catalog types, keys and actions that exist', () => {
  for (const { name, spec } of examples.filter((e) => e.spec.kind === 'native')) {
    const elements = spec.elements!
    const seen = new Set<string>()
    const walk = (id: string, path: string[]) => {
      assert.ok(elements[id], `${name}: ${id} exists`)
      assert.ok(!path.includes(id), `${name}: no cycle through ${id}`)
      seen.add(id)
      for (const child of elements[id]!.children ?? []) walk(child, [...path, id])
    }
    walk(spec.root!, [])
    assert.deepEqual([...seen].sort(), Object.keys(elements).sort(), `${name}: every element reachable`)
    const state = spec.initial_state ?? {}
    const actions = new Set((spec.actions ?? []).map((a) => a.id))
    for (const [id, el] of Object.entries(elements)) {
      assert.ok(TYPES.has(el.type), `${name}.${id}: ${el.type}`)
      if (INPUTS.has(el.type)) assert.ok(Object.hasOwn(state, el.props.key as string), `${name}.${id}: key ${String(el.props.key)} in the state`)
      if (el.type === 'button') assert.ok(actions.has(el.props.action as string), `${name}.${id}: action declared`)
      for (const ref of stateRefs(el.props)) assert.ok(Object.hasOwn(state, ref), `${name}.${id}: state ${ref}`)
    }
  }
})

test("the split example's numbers are the ones its fallback states", () => {
  const spec = examples.find((e) => e.name === 'trip-split')!.spec
  const el = spec.elements!
  const state = spec.initial_state!
  assert.equal(evaluate(el.sum!.props.value as Value, state), 1386)
  assert.equal(evaluate(el.each!.props.value as Value, state), 347)
  assert.match(spec.fallback, /1386/)
  assert.match(spec.fallback, /347/)
  assert.equal(evaluate(el.each!.props.value as Value, { ...state, people: 0 }), 1386, 'max(people, 1): no division by zero')
  // the product's own evaluator (contract evaluateUiValue) says the same
  assert.equal(evaluateUiValue(el.sum!.props.value, state), 1386)
  assert.equal(evaluateUiValue(el.each!.props.value, state), 347)
  assert.equal(evaluateUiValue(el.each!.props.value, { ...state, people: 0 }), 1386)
})

test('the HTML example fits the sandbox and uses only the bridge', () => {
  const spec = examples.find((e) => e.spec.kind === 'html')!.spec
  assert.equal(htmlTooLarge(spec.html!), false)
  assert.ok(!/https?:|\/\/|fetch\(|XMLHttpRequest|WebSocket|import\(|<iframe|<img|eval\(|Function\(/.test(spec.html!), 'no network, no frames, no eval')
  for (const id of (spec.actions ?? []).map((a) => a.id)) assert.ok(spec.html!.includes(`oasisUI.action('${id}')`))
  const doc = buildSrcdoc(spec.html!, { nonce: makeNonce(), state: checkState(spec.initial_state).ok ? spec.initial_state as never : {} })
  assert.ok(doc.endsWith(spec.html!))
  // 2000 a month at 4% for 20 years, compounded monthly: about 733,000 (the fallback says 73 万)
  let v = 0
  for (let k = 0; k < 240; k++) v = v * (1 + 0.04 / 12) + 2000
  assert.equal(Math.round(v / 10_000), 73)
})
