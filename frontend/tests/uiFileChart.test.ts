/** A chart read from a file, as React renders it into an in-memory DOM, against a fake of the source route (the
 *  server's page semantics over files in memory): the points come from the file (never the spec), the legend and the
 *  latest ring read the raw latest point, a hover reads the raw point at its x; a later revision that names another
 *  file — with more series — is another chart: nothing of the first is drawn, no cursor carried over, nothing thrown. */
import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { registerHooks } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { JSDOM } from 'jsdom'
import { parseUiSurfaceSpec, type UiSurfaceRecord } from '@oasis-code/contract'
import { record } from './uiFixtures.ts'

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
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true, __OASIS_CODE_BUILD__: 'test' })
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: dom.window.localStorage })

/** the files the fake route serves, by path; the record's current spec names which */
const files = new Map<string, string>()
let current: UiSurfaceRecord | null = null
const requests: string[] = []
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input), 'https://ui.invalid/')
  requests.push(url.pathname + url.search)
  const m = /\/ui\/[^/]+\/[^/]+\/sources\/([^/]+)$/.exec(url.pathname)
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  if (!m || !current) return reply({ detail: 'not found' }, 404)
  if (Number(url.searchParams.get('revision')) !== current.revision) return reply({ detail: 'stale', error: 'stale_revision' }, 409)
  const spec = current.spec as unknown as { elements: Record<string, { props: { source?: { path: string } } }> }
  const path = spec.elements[m[1]!]?.props.source?.path
  const text = path === undefined ? undefined : files.get(path)
  if (text === undefined) return reply({ status: 'missing', reason: 'no file' })
  const data = Buffer.from(text), off = Number(url.searchParams.get('offset')), lim = Number(url.searchParams.get('limit'))
  const page = data.subarray(off, Math.min(data.length, off + lim))
  return reply({ status: 'ok', file_id: `1:${path}`, size: data.length, mtime_ms: 1, offset: off, next_offset: off + page.length, eof: off + page.length >= data.length,
    data: page.toString('base64'), head: data.subarray(0, 64).toString('base64'), anchor: data.subarray(Math.max(0, off - 64), off).toString('base64'), crc: null })
}) as typeof fetch

const { createElement, act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { useStore } = await import('../src/state/store.ts')
const { UiSurfaceBlock } = await import('../src/components/UiSurface.tsx')

const container = document.getElementById('root')!
let root: ReturnType<typeof createRoot>
const flush = async (n = 6) => { for (let i = 0; i < n; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 5)) }) }
const show = async (r: UiSurfaceRecord) => { current = r; await act(async () => root.render(createElement(UiSurfaceBlock, { entry: { kind: 'ui', surface: r } }))); await flush() }
const q = <T extends Element = HTMLElement>(sel: string) => container.querySelector<T>(sel)

const spec = (path: string, series: { id: string; column: string; dashed?: boolean }[]) => ({
  version: 1, surface_id: 'train', title: 'Training', fallback: 'Loss read from the run log.', kind: 'native', root: 'c',
  elements: { c: { type: 'chart', props: { kind: 'line', x_axis: 'number', label: 'Loss', source: { path, format: 'jsonl', x: 'step', series: series.map((s) => ({ id: s.id, label: s.id, column: s.column, ...(s.dashed ? { line_style: 'dashed' } : {}) })) } } } },
})
const rec = (revision: number, s: unknown) => record({ surface_id: 'train', revision, spec: s as UiSurfaceRecord['spec'], state: {} })

beforeEach(() => { useStore.setState({ replaying: false }); root = createRoot(container); requests.length = 0 })
afterEach(async () => { await act(async () => root.unmount()); await flush(1) })

test('a file chart draws the file\'s points (5,000 of them, past the inline bound) with a bounded drawing and the raw latest', async () => {
  const lines = Array.from({ length: 5000 }, (_, i) => JSON.stringify({ step: i, loss: i === 2500 ? 50 : 1 / (i + 1), ...(i % 500 === 0 ? { val_loss: 2 / (i + 1) } : {}) })).join('\n') + '\n'
  files.set('a.jsonl', lines)
  const s = spec('a.jsonl', [{ id: 'loss', column: 'loss' }, { id: 'val', column: 'val_loss', dashed: true }])
  assert.ok(parseUiSurfaceSpec(s).ok)
  await show(rec(1, s))
  await flush(20)
  const chart = q('[data-testid="ui-chart-series"]')!
  assert.equal(chart.getAttribute('data-source'), 'file')
  assert.equal(chart.getAttribute('data-points'), String(5000 + 10))
  assert.equal(chart.getAttribute('data-latest-x'), '4999')
  const plotW = Number(chart.getAttribute('data-plot-width'))
  assert.ok(Number(chart.getAttribute('data-drawn')) <= plotW * 10 * 2, `drawn ${chart.getAttribute('data-drawn')} for ${plotW} px`)
  assert.ok(container.querySelectorAll('circle').length < 100, 'no element per point')
  const values = [...container.querySelectorAll('[data-testid="ui-chart-value"]')].map((e) => [e.getAttribute('data-x'), e.getAttribute('data-value')])
  assert.deepEqual(values, [['4999', String(1 / 5000)], ['4500', String(2 / 4501)]])
  assert.equal(container.querySelector('[data-series="val"]')!.getAttribute('data-style'), 'dashed')
  // the spec carries no point; every page asked for is bounded
  assert.ok(!JSON.stringify(s).includes('0.0002'))
  const pages = requests.filter((r) => r.includes('/sources/'))
  assert.ok(pages.length > 0 && pages.every((r) => /limit=1048576/.test(r)))
  // the keyboard lands on raw points (the spike's x)
  const plot = q('.uis-plot')!
  await act(async () => { plot.focus() })
  await act(async () => { plot.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true })) })
  assert.equal(q('[data-testid="ui-chart-series"]')!.getAttribute('data-cursor'), '0')
})

test('a later revision naming another file with more series is another chart: no old points, no carried cursor, nothing thrown', async () => {
  files.set('one.jsonl', Array.from({ length: 20 }, (_, i) => JSON.stringify({ step: i, loss: i })).join('\n') + '\n')
  files.set('two.jsonl', '{"step":100,"a":1,"b":2}\n{"step":200,"a":3,"b":4}\n')
  await show(rec(1, spec('one.jsonl', [{ id: 'loss', column: 'loss' }])))
  await flush(10)
  assert.equal(q('[data-testid="ui-chart-series"]')!.getAttribute('data-latest-x'), '19')
  const plot = q('.uis-plot')!
  await act(async () => { plot.focus() })
  await act(async () => { plot.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true })) })
  await act(async () => { plot.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })) })
  assert.equal(q('[data-testid="ui-chart-series"]')!.getAttribute('data-cursor'), '1')
  const errors: unknown[] = []
  const onError = (e: ErrorEvent) => errors.push(e.error)
  dom.window.addEventListener('error', onError)
  await show(rec(2, spec('two.jsonl', [{ id: 'a', column: 'a' }, { id: 'b', column: 'b', dashed: true }])))
  // the first render of revision 2 already: never the first file's points under the new series
  const chart = () => q('[data-testid="ui-chart-series"]')!
  assert.notEqual(chart().getAttribute('data-latest-x'), '19')
  await flush(10)
  dom.window.removeEventListener('error', onError)
  assert.deepEqual(errors, [])
  assert.equal(q('[data-surface="train"]')!.getAttribute('data-valid'), 'true')
  assert.equal(chart().getAttribute('data-series-count'), '2')
  assert.equal(chart().getAttribute('data-latest-x'), '200')
  assert.equal(chart().getAttribute('data-cursor'), null, 'the cursor of the first file is not carried to the second')
  assert.deepEqual([...container.querySelectorAll('[data-testid="ui-chart-value"]')].map((e) => e.getAttribute('data-value')), ['3', '4'])
})

test('a file not there yet says so and is drawn once it appears', async () => {
  files.delete('later.jsonl')
  await show(rec(1, spec('later.jsonl', [{ id: 'loss', column: 'loss' }])))
  assert.equal(q('[data-testid="ui-chart-source-status"]')!.getAttribute('data-status'), 'missing')
  files.set('later.jsonl', '{"step":1,"loss":0.5}\n')
  for (let i = 0; i < 40 && q('[data-testid="ui-chart-series"]')!.getAttribute('data-points') !== '1'; i += 1) await flush(10)
  assert.equal(q('[data-testid="ui-chart-series"]')!.getAttribute('data-points'), '1')
  assert.equal(q('[data-testid="ui-chart-source-status"]'), null)
})

test('progress-only card needs no fake series, escapes logs, formats hours, and 100% without a terminal stays running', async () => {
  const s = { version: 1, surface_id: 'train', title: 'Batch images', fallback: 'Batch progress', kind: 'native', root: 'p',
    elements: { p: { type: 'progress', props: { label: 'Converting', source: { path: 'batch-progress.jsonl', format: 'jsonl', progress: { completed: 'done', total: 'total', rate: 'rate', eta: 'eta', status: 'status', log: 'log' } } } } } }
  assert.equal(parseUiSurfaceSpec(s).ok, true)
  files.set('batch-progress.jsonl', '{"done":10,"total":10,"rate":2,"eta":7260,"log":"<img src=x onerror=alert(1)>"}\n')
  await show(rec(1, s))
  assert.equal(q('[data-testid="ui-task-progress"]')?.getAttribute('data-task-status'), 'running')
  assert.equal(q('[data-testid="ui-chart-series"]'), null)
  assert.match(container.textContent!, /ETA 2h 1m/)
  assert.equal(q('.uis-progress-logs img'), null)
  files.set('batch-progress.jsonl', '{"done":10,"total":10,"rate":2,"eta":7260,"log":"<img src=x onerror=alert(1)>"}\n{"status":"failed","log":"crashed"}\n')
  await act(async () => { await new Promise((r) => setTimeout(r, 1100)) }); await flush()
  assert.equal(q('[data-testid="ui-task-progress"]')?.getAttribute('data-task-status'), 'failed')
})
