/** Intelligent UI fixtures shared by the ui tests (a module, not a test file: importing it runs nothing). Every spec
 *  here passes the contract's own parser (parseUiSurfaceSpec) and every record its record schema — the tests assert
 *  so — so the fixtures cannot drift from the protocol. */

import type { UiSurfaceRecord } from '@oasis-code/contract'

/** A native spec of the contract: a price calculator — a number input, a slider, a select, a checkbox, a computed
 *  metric, a chart, a table, a button and a footer action. */
export function calculator(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1, surface_id: 'calc', title: 'Price calculator', fallback: 'Price: 3 × 4 = 12', kind: 'native',
    initial_state: { qty: 3, price: 4 },
    actions: [{ id: 'order', label: 'Order', prompt: 'Order the items' }, { id: 'explain', label: 'Explain', prompt: 'Explain the price' }],
    root: 'main',
    elements: {
      main: { type: 'stack', props: { title: 'Order' }, children: ['qty', 'price', 'size', 'extras', 'gift', 'total', 'split', 'list', 'go'] },
      qty: { type: 'input', props: { label: 'Quantity', key: 'qty', inputType: 'number', min: 1, max: 99 } },
      price: { type: 'slider', props: { label: 'Price', key: 'price', min: 0, max: 10, step: 0.5 } },
      size: { type: 'select', props: { label: 'Size', key: 'size', options: [{ label: 'Small', value: 's' }, { label: 'Large', value: 'l' }] } },
      extras: { type: 'select', props: { label: 'Extras', key: 'extras', multiple: true, options: [{ label: 'Box', value: 'box' }, { label: 'Card', value: 'card' }] } },
      gift: { type: 'checkbox', props: { label: 'Gift wrap', key: 'gift' } },
      total: { type: 'metric', props: { label: 'Total', value: { op: 'multiply', args: [{ state: 'qty' }, { state: 'price' }] }, unit: 'USD' } },
      split: { type: 'chart', props: { kind: 'bar', data: [{ label: 'Items', value: { state: 'qty' } }, { label: 'Unit', value: { state: 'price' } }] } },
      list: { type: 'table', props: { columns: [{ key: 'name', label: 'Name' }, { key: 'n', label: 'Count' }], rows: [{ name: 'a', n: 1 }] } },
      go: { type: 'button', props: { label: 'Order', action: 'order' } },
    },
    ...over,
  }
}

export function record(over: Partial<UiSurfaceRecord> = {}): UiSurfaceRecord {
  return {
    session_id: 's1', run_id: 'r1', surface_id: 'calc', revision: 1, spec: calculator() as UiSurfaceRecord['spec'], state: { qty: 3, price: 4 },
    model: 'claude-opus', created_at: '2026-10-11T00:00:00.000Z', updated_at: '2026-10-11T00:00:00.000Z', ...over,
  }
}

/** A chain `depth` levels deep where each level names the next level twice — schema-valid (ids, children, types),
 *  but every element below the root has two parents: drawn as a tree it would be drawn 2^depth times. */
export function sharedChildren(depth: number): Record<string, unknown> {
  const elements: Record<string, unknown> = {}
  for (let i = 0; i < depth; i += 1) elements[`n${i}`] = { type: 'stack', children: [`n${i + 1}`, `n${i + 1}`] }
  elements[`n${depth}`] = { type: 'text', props: { text: 'leaf' } }
  return calculator({ root: 'n0', elements, initial_state: {}, actions: [] })
}

/** A simulated training run's values at `step` (deterministic, no randomness: a decaying loss and a rising reward, each
 *  with a small fixed wobble) — demo and test data, not a measurement of anything. */
export const simLoss = (step: number): number => Math.round((2.4 * Math.exp(-step / 380) + 0.18 + 0.04 * Math.sin(step / 7)) * 1e4) / 1e4
export const simReward = (step: number): number => Math.round((0.92 - 0.7 * Math.exp(-step / 450) + 0.03 * Math.cos(step / 5)) * 1e4) / 1e4

/** A native spec of the contract: a live training panel — three metrics, a two-series chart over `steps` steps (a gap
 *  in the reward at `gapAt`), a text field. `steps` points per series: within the contract's point bound for up to
 *  UI_LIMITS.chartPoints / 2 steps. */
export function training(steps: number, over: Record<string, unknown> = {}, gapAt: number | null = null): Record<string, unknown> {
  const xs = Array.from({ length: steps }, (_, i) => i + 1)
  const last = steps
  return {
    version: 1, surface_id: 'train', title: 'Training run', fallback: `step ${last} · loss ${simLoss(last)} · reward ${simReward(last)}`, kind: 'native',
    initial_state: { note: '' },
    root: 'main',
    elements: {
      main: { type: 'stack', children: ['facts', 'curve', 'note'] },
      facts: { type: 'row', children: ['step', 'loss', 'reward'] },
      step: { type: 'metric', props: { label: 'Step', value: last } },
      loss: { type: 'metric', props: { label: 'Loss', value: simLoss(last) } },
      reward: { type: 'metric', props: { label: 'Reward', value: simReward(last) } },
      curve: {
        type: 'chart', props: {
          kind: 'line', x_axis: 'number', label: 'Loss and reward', series: [
            { id: 'loss', label: 'loss', data: xs.map((x) => ({ x, value: simLoss(x) })) },
            { id: 'reward', label: 'reward', line_style: 'dashed', data: xs.map((x) => ({ x, value: x === gapAt ? null : simReward(x) })) },
          ],
        },
      },
      note: { type: 'input', props: { label: 'Note', key: 'note', inputType: 'text' } },
    },
    ...over,
  }
}
