/** A watch's condition as plain code: what a registration may ask for, how a number is read from a line of output,
 *  and when a condition starts to hold — a step printed 99 then 101 crosses 100 once, a NaN loss is seen whether
 *  the log writes JSON, name=value or a table row. */

import { expect, test } from 'bun:test'
import type { WatchSpec } from '@oasis-code/contract'
import { checkWatch, holds, metricReader, parseNumber, readLine, summaryOf, type LineState, type WatchInput } from '../src/agent/watches/conditions.ts'

const NOW = new Date('2026-09-30T00:00:00.000Z')
const ok = (input: WatchInput) => {
  const out = checkWatch(input, NOW)
  if ('error' in out) throw new Error(out.error)
  return out
}
const refusal = (input: WatchInput) => {
  const out = checkWatch(input, NOW)
  return 'error' in out ? out.error : null
}

test('a registration is checked before anything is kept: what each kind needs, and the limits', () => {
  expect(refusal({ kind: 'exit' })).toContain('needs execution_id')
  expect(refusal({ kind: 'timer', delay_s: 5 })).toContain('between 30')
  expect(refusal({ kind: 'timer', delay_s: 60, at: '2026-10-01T00:00:00Z' })).toContain('not both')
  expect(refusal({ kind: 'timer', at: 'tomorrow' })).toContain('not a time')
  expect(refusal({ kind: 'timer', at: '2026-12-01T00:00:00Z' })).toContain('within 30 days')
  expect(refusal({ kind: 'match', execution_id: 'x_1', pattern: '(' })).toContain('not a regular expression')
  expect(refusal({ kind: 'metric', execution_id: 'x_1', op: '>=' , value: 1 })).toContain('needs field')
  expect(refusal({ kind: 'metric', execution_id: 'x_1', field: 'loss', op: '>' })).toContain('needs a number value')
  expect(refusal({ kind: 'metric', execution_id: 'x_1', pattern: 'loss (\\d+)', field: 'loss', op: 'nonfinite' })).toContain('not both')
  expect(refusal({ kind: 'metric', execution_id: 'x_1', pattern: 'loss \\d+', op: 'nonfinite' })).toContain('capture group')
  expect(refusal({ kind: 'metric', execution_id: 'x_1', field: 'a b', op: 'nonfinite' })).toContain('field must be a name')
  expect(refusal({ kind: 'silence', execution_id: 'x_1', silence_s: 5 })).toContain('between 30')
  expect(refusal({ kind: 'exit', execution_id: 'x_1', repeat: true })).toContain('does not repeat')
  expect(refusal({ kind: 'match', execution_id: 'x_1', pattern: 'x', repeat: true, cooldown_s: 10 })).toContain('at least 60')
  expect(refusal({ kind: 'match', execution_id: 'x_1', pattern: 'x', repeat: true, max_fires: 50 })).toContain('between 1 and 20')
  expect(refusal({ kind: 'timer', delay_s: 60, repeat: true })).toBeNull()                    // every minute: the shortest repeat

  const once = ok({ kind: 'metric', execution_id: 'x_1', field: 'step', op: '>=', value: 100 })
  expect(once).toMatchObject({ repeat: false, max_fires: 1, cooldown_s: 0, summary: 'step >= 100 in x_1' })
  expect(once.expires_at).toBe('2026-10-07T00:00:00.000Z')                                   // a week by default
  const timer = ok({ kind: 'timer', delay_s: 600 })
  expect(timer.spec.at).toBe('2026-09-30T00:10:00.000Z')
  const every = ok({ kind: 'timer', delay_s: 1800, repeat: true })
  expect(every).toMatchObject({ repeat: true, cooldown_s: 1800, max_fires: 10 })
  expect(every.spec.every_s).toBe(1800)
  expect(ok({ kind: 'metric', execution_id: 'x_1', field: 'loss', op: 'nonfinite', stream: 'stderr' }).summary).toBe('loss not finite (NaN or infinite) in x_1 (stderr)')
  expect(summaryOf(ok({ kind: 'silence', execution_id: 'x_1', silence_s: 600 }).spec)).toBe('no output in x_1 for 600 s')
})

test('numbers as logs print them', () => {
  expect(parseNumber('0.53')).toBe(0.53)
  expect(parseNumber('1e-4,')).toBe(1e-4)
  expect(parseNumber('nan')).toBeNaN()
  expect(parseNumber('NaN')).toBeNaN()
  expect(parseNumber('-inf')).toBe(Number.NEGATIVE_INFINITY)
  expect(parseNumber('Infinity')).toBe(Number.POSITIVE_INFINITY)
  expect(parseNumber('"12"')).toBe(12)
  expect(parseNumber('3.2s')).toBe(3.2)
  expect(parseNumber('abc')).toBeNull()
  expect(parseNumber(7)).toBe(7)
  expect(holds('nonfinite', null, Number.NaN)).toBe(true)
  expect(holds('>=', 100, Number.NaN)).toBe(false)                                            // a comparison needs a finite number
  expect(holds('<', 1, -Infinity)).toBe(false)
})

test('a metric is read from a JSON line (NaN as Python writes it), name=value, name: value, a spaced pair, or a pattern', () => {
  const step = metricReader({ field: 'step', pattern: null })
  const loss = metricReader({ field: 'loss', pattern: null })
  const nested = metricReader({ field: 'train.loss', pattern: null })
  expect(step('{"step": 120, "loss": 0.4}')).toBe(120)
  expect(loss('{"step": 120, "loss": NaN}')).toBeNaN()
  expect(loss('{"step": 1, "loss": -Infinity}')).toBe(Number.NEGATIVE_INFINITY)
  expect(nested('{"train": {"loss": 0.25}}')).toBe(0.25)
  expect(step('epoch=1 step=240 loss=0.31')).toBe(240)
  expect(loss('step: 5 | loss: nan | lr: 1e-3')).toBeNaN()
  expect(loss('Step 300 Loss 0.2')).toBeUndefined()                                          // names are case-sensitive
  expect(loss('step 300 loss 0.2')).toBe(0.2)
  expect(step('mystep=4 step=9')).toBe(9)                                                     // a longer name is not the field
  expect(step('no numbers here')).toBeUndefined()
  expect(loss('{"step": 3}')).toBeUndefined()
  const pat = metricReader({ field: null, pattern: 'it/s, loss ([\\d.]+|nan)' })
  expect(pat('100%|███| 10/10 [00:01<00:00, 9.1it/s, loss 0.07]')).toBe(0.07)
  expect(pat('nothing')).toBeUndefined()
})

const spec = (s: Partial<WatchSpec>): WatchSpec => ({ kind: 'metric', execution_id: 'x_1', at: null, every_s: null, pattern: null, field: null, op: null, value: null, stream: 'both', silence_s: null, ...s })

test('a metric reports when its condition starts to hold: 99 then 101 crosses 100 once, again only after it stops holding', () => {
  const s = spec({ field: 'step', op: '>=', value: 100 })
  const compiled = { re: null, metric: metricReader(s) }
  const state: LineState = { holding: null }
  const seen = ['step=50', 'noise', 'step=99', 'step=101', 'step=150', 'step=20', 'step=100'].map((l) => readLine(s, compiled, state, l).occurrence)
  expect(seen).toEqual([false, false, false, true, false, false, true])
  // one that already holds on the first line reporting it (a watch set late) reports at once
  const late: LineState = { holding: null }
  expect(readLine(s, compiled, late, 'step=400').occurrence).toBe(true)
  const nan = spec({ field: 'loss', op: 'nonfinite' })
  const n = { re: null, metric: metricReader(nan) }
  const st: LineState = { holding: null }
  expect(['loss=0.3', 'loss=nan', 'loss=nan', 'loss=inf', 'loss=0.2', 'loss=nan'].map((l) => readLine(nan, n, st, l).occurrence)).toEqual([false, true, false, false, false, true])
  const m = spec({ kind: 'match', pattern: 'Traceback|CUDA out of memory' })
  const mc = { re: new RegExp(m.pattern!), metric: null }
  expect(['ok', 'Traceback (most recent call last):', 'torch.OutOfMemoryError: CUDA out of memory.'].map((l) => readLine(m, mc, { holding: null }, l).occurrence)).toEqual([false, true, true])
})
