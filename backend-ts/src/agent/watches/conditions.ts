/** A watch's condition, as plain code: what a registration may ask for (checked before anything is stored), how a
 *  number is read from a line of a command's output, and whether a line makes the condition hold. The service keeps
 *  the state between lines; nothing here reads the clock, the database or a process. */

import type { MetricOp, WatchSpec } from '@oasis-code/contract'

export const MIN_DELAY_S = 30
export const MAX_HORIZON_S = 30 * 24 * 3600
export const MIN_SILENCE_S = 30
export const MAX_SILENCE_S = 24 * 3600
export const MIN_COOLDOWN_S = 60
export const DEFAULT_COOLDOWN_S = 300
export const MAX_FIRES = 20
export const DEFAULT_REPEAT_FIRES = 10
export const DEFAULT_EXPIRES_S = 7 * 24 * 3600
export const MAX_PATTERN_CHARS = 500
/** the longest line a condition reads (a longer one is read up to here) */
export const MAX_LINE_CHARS = 16_384

/** What the tool is called with (every field but kind optional; which ones a kind needs is checked here). */
export interface WatchInput {
  kind: WatchSpec['kind']
  execution_id?: string | null
  delay_s?: number | null
  at?: string | null
  pattern?: string | null
  field?: string | null
  op?: MetricOp | null
  value?: number | null
  stream?: WatchSpec['stream'] | null
  silence_s?: number | null
  repeat?: boolean | null
  cooldown_s?: number | null
  max_fires?: number | null
  expires_in_s?: number | null
}

export interface CheckedWatch {
  spec: WatchSpec
  summary: string
  repeat: boolean
  cooldown_s: number
  max_fires: number
  expires_at: string
}

const finiteIn = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi

/** The pattern as a regular expression, or why it is not one. */
export function compilePattern(pattern: string): RegExp | string {
  if (!pattern) return 'pattern is empty'
  if (pattern.length > MAX_PATTERN_CHARS) return `pattern is longer than ${MAX_PATTERN_CHARS} characters`
  try { return new RegExp(pattern) } catch (error) { return `pattern is not a regular expression: ${(error as Error).message}` }
}

/** A registration checked: the spec the harness evaluates, the line the page shows, how often it may fire and until
 *  when — or why it is refused. `now` is when it is registered. */
export function checkWatch(input: WatchInput, now: Date): CheckedWatch | { error: string } {
  const kind = input.kind
  const execution = input.execution_id?.trim() || null
  const spec: WatchSpec = {
    kind, execution_id: null, at: null, every_s: null, pattern: null, field: null, op: null, value: null, stream: input.stream ?? 'both', silence_s: null,
  }
  const repeat = input.repeat === true
  if (kind !== 'timer') {
    if (!execution) return { error: `${kind} needs execution_id: the id bash returned for a command still running` }
    spec.execution_id = execution
  }
  if (kind === 'timer') {
    if (input.at && input.delay_s != null) return { error: 'give delay_s or at, not both' }
    let first: number
    if (input.at) {
      first = Date.parse(input.at)
      if (!Number.isFinite(first)) return { error: `at is not a time: ${input.at}` }
      if (first < now.getTime() + MIN_DELAY_S * 1000) return { error: `at must be at least ${MIN_DELAY_S} s from now` }
    } else {
      if (!finiteIn(input.delay_s, MIN_DELAY_S, MAX_HORIZON_S)) return { error: `delay_s must be between ${MIN_DELAY_S} and ${MAX_HORIZON_S} seconds` }
      first = now.getTime() + input.delay_s * 1000
    }
    if (first > now.getTime() + MAX_HORIZON_S * 1000) return { error: 'at must be within 30 days' }
    spec.at = new Date(first).toISOString()
    if (repeat) {
      const every = input.delay_s ?? null
      if (!finiteIn(every, MIN_COOLDOWN_S, MAX_HORIZON_S)) return { error: `a repeating timer needs delay_s (at least ${MIN_COOLDOWN_S} s): the time between firings` }
      spec.every_s = every
    }
  } else if (kind === 'match') {
    const re = compilePattern(input.pattern ?? '')
    if (typeof re === 'string') return { error: re }
    spec.pattern = input.pattern!
  } else if (kind === 'metric') {
    const field = input.field?.trim() || null
    if (!field && !input.pattern) return { error: 'metric needs field (a JSON key or the name in name=value) or pattern (its first group is the number)' }
    if (field && input.pattern) return { error: 'give field or pattern, not both' }
    if (field && !/^[\w.-]{1,80}$/.test(field)) return { error: 'field must be a name: letters, digits, _ . -' }
    if (input.pattern) {
      const re = compilePattern(input.pattern)
      if (typeof re === 'string') return { error: re }
      if (new RegExp(`${input.pattern}|`).exec('')!.length < 2) return { error: 'pattern needs a capture group around the number' }
      spec.pattern = input.pattern
    }
    spec.field = field
    if (!input.op) return { error: "metric needs op: >=, <=, >, <, ==, != or 'nonfinite'" }
    spec.op = input.op
    if (input.op !== 'nonfinite') {
      if (typeof input.value !== 'number' || !Number.isFinite(input.value)) return { error: `op ${input.op} needs a number value` }
      spec.value = input.value
    }
  } else if (kind === 'silence') {
    if (!finiteIn(input.silence_s, MIN_SILENCE_S, MAX_SILENCE_S)) return { error: `silence_s must be between ${MIN_SILENCE_S} and ${MAX_SILENCE_S} seconds` }
    spec.silence_s = input.silence_s
  }
  if (repeat && kind === 'exit') return { error: 'a command ends once: exit does not repeat' }
  const cooldown = repeat ? (input.cooldown_s ?? (kind === 'timer' ? spec.every_s! : DEFAULT_COOLDOWN_S)) : 0
  if (repeat && !finiteIn(cooldown, MIN_COOLDOWN_S, MAX_HORIZON_S)) return { error: `cooldown_s must be at least ${MIN_COOLDOWN_S} seconds` }
  const maxFires = repeat ? (input.max_fires ?? DEFAULT_REPEAT_FIRES) : 1
  if (!Number.isInteger(maxFires) || maxFires < 1 || maxFires > MAX_FIRES) return { error: `max_fires must be between 1 and ${MAX_FIRES}` }
  const expiresIn = input.expires_in_s ?? DEFAULT_EXPIRES_S
  if (!finiteIn(expiresIn, 60, MAX_HORIZON_S)) return { error: 'expires_in_s must be between 60 seconds and 30 days' }
  let expires = now.getTime() + expiresIn * 1000
  if (kind === 'timer' && !repeat) expires = Math.max(expires, Date.parse(spec.at!) + 60_000)
  return { spec, summary: summaryOf(spec), repeat, cooldown_s: Math.trunc(cooldown), max_fires: maxFires, expires_at: new Date(expires).toISOString() }
}

/** The line the page and the agent read for a watch. */
export function summaryOf(spec: WatchSpec): string {
  const on = spec.execution_id ? ` in ${spec.execution_id}` : ''
  const where = spec.stream === 'both' ? '' : ` (${spec.stream})`
  switch (spec.kind) {
    case 'timer': return spec.every_s ? `every ${spec.every_s} s from ${spec.at}` : `at ${spec.at}`
    case 'exit': return `when ${spec.execution_id} ends`
    case 'match': return `a line matching /${spec.pattern}/${on}${where}`
    case 'metric': {
      const name = spec.field ?? `/${spec.pattern}/`
      return spec.op === 'nonfinite' ? `${name} not finite (NaN or infinite)${on}${where}` : `${name} ${spec.op} ${spec.value}${on}${where}`
    }
    case 'silence': return `no output${on} for ${spec.silence_s} s`
  }
}

/** A number as a log prints it: 0.53, 1e-4, nan, inf, -Infinity, "0.2"; null when it is none. */
export function parseNumber(raw: unknown): number | null {
  if (typeof raw === 'number') return raw
  if (typeof raw !== 'string') return null
  const token = raw.trim().replace(/^["'(\[]+|["',;:)\]}]+$/g, '').toLowerCase()
  if (!token) return null
  if (/^[-+]?nan$/.test(token)) return Number.NaN
  if (/^\+?inf(inity)?$/.test(token)) return Number.POSITIVE_INFINITY
  if (/^-inf(inity)?$/.test(token)) return Number.NEGATIVE_INFINITY
  const whole = Number(token)
  if (!Number.isNaN(whole)) return whole
  const lead = Number.parseFloat(token)
  return Number.isNaN(lead) ? null : lead
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function dotted(value: unknown, path: string): unknown {
  let at = value
  for (const key of path.split('.')) {
    if (at === null || typeof at !== 'object') return undefined
    at = (at as Record<string, unknown>)[key]
  }
  return at
}

/** The field of a JSON line — NaN and Infinity as Python's json writes them read as numbers — or undefined. */
function jsonField(line: string, field: string): unknown {
  const text = line.trim()
  if (!text.startsWith('{')) return undefined
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch {
    try { parsed = JSON.parse(text.replace(/([:\[,]\s*)(-?Infinity|NaN)\b/g, '$1"$2"')) } catch { return undefined }
  }
  return dotted(parsed, field)
}

/** A compiled metric reader: the number a line reports, or undefined when the line does not report it. */
export function metricReader(spec: Pick<WatchSpec, 'field' | 'pattern'>): (line: string) => number | undefined {
  if (spec.pattern) {
    const re = new RegExp(spec.pattern)
    return (line) => {
      const m = re.exec(line)
      if (!m || m[1] === undefined) return undefined
      return parseNumber(m[1]) ?? undefined
    }
  }
  const field = spec.field!
  const named = new RegExp(`(?:^|[^\\w.])${escapeRegExp(field)}\\s*[=:]\\s*([^\\s,;|)\\]}]+)`)
  // the name as written; the number may be nan or inf in any case
  const spaced = new RegExp(`(?:^|[^\\w.])${escapeRegExp(field)}\\s+([-+]?(?:\\d|\\.\\d|[Nn][Aa][Nn]\\b|[Ii][Nn][Ff])[^\\s,;|)\\]}]*)`)
  return (line) => {
    const json = jsonField(line, field)
    if (json !== undefined) return parseNumber(json) ?? undefined
    const m = named.exec(line) ?? spaced.exec(line)
    return m ? (parseNumber(m[1]) ?? undefined) : undefined
  }
}

/** Whether the number meets the condition (a comparison needs a finite number). */
export function holds(op: MetricOp, value: number | null, x: number): boolean {
  if (op === 'nonfinite') return !Number.isFinite(x)
  if (!Number.isFinite(x) || value === null) return false
  switch (op) {
    case '>=': return x >= value
    case '<=': return x <= value
    case '>': return x > value
    case '<': return x < value
    case '==': return x === value
    case '!=': return x !== value
  }
}

/** What a line of output does to a watch: `occurrence` when the condition starts to hold on it (a match; a metric
 *  that did not hold on the last line reporting it and does now — so a step printed 99 then 101 crosses 100 once),
 *  with the number read. `holding` is the state carried from line to line (null: no line has reported yet). */
export interface LineState { holding: boolean | null }

export function readLine(spec: WatchSpec, compiled: { re: RegExp | null; metric: ((line: string) => number | undefined) | null }, state: LineState, lineIn: string):
  { occurrence: boolean; value?: number } {
  const line = lineIn.length > MAX_LINE_CHARS ? lineIn.slice(0, MAX_LINE_CHARS) : lineIn
  if (spec.kind === 'match') return { occurrence: compiled.re!.test(line) }
  if (spec.kind !== 'metric') return { occurrence: false }
  const x = compiled.metric!(line)
  if (x === undefined) return { occurrence: false }
  const now = holds(spec.op!, spec.value, x)
  const began = now && state.holding !== true
  state.holding = now
  return { occurrence: began, value: x }
}

/** A number as the agent reads it. */
export function shownNumber(x: number): string {
  if (Number.isNaN(x)) return 'NaN'
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : '-inf'
  return String(x)
}
