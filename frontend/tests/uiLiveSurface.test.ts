/** A live surface in the page, as React renders it into an in-memory DOM: a new revision of the same surface updates it
 *  in place (the field keeps its focus, the chart its cursor), another surface / run / session or the replay draws it
 *  afresh, a revision that fails to draw is not retried until a newer one comes, and a dense chart's values table is
 *  built only when opened, a page at a time. No server: every request is answered 404. */
import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { registerHooks } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { JSDOM } from 'jsdom'
import { parseUiSurfaceSpec, type UiSurfaceRecord } from '@oasis-code/contract'
import { calculator, record, simLoss, training } from './uiFixtures.ts'

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
globalThis.fetch = (async () => new Response(JSON.stringify({ detail: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } })) as typeof fetch

const { createElement, act, Profiler } = await import('react')
const { createRoot } = await import('react-dom/client')
const { useStore } = await import('../src/state/store.ts')
const { UiSurfaceBlock, SurfaceBoundary, surfaceKey } = await import('../src/components/UiSurface.tsx')

const container = document.getElementById('root')!
let root: ReturnType<typeof createRoot>
const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)) }) }
const show = async (r: UiSurfaceRecord) => { await act(async () => root.render(createElement(UiSurfaceBlock, { entry: { kind: 'ui', surface: r } }))); await flush() }
const key = async (el: Element, k: string) => { await act(async () => { el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true })) }) }
const q = <T extends Element = HTMLElement>(sel: string) => container.querySelector<T>(sel)

/** the training panel at `steps` steps, as revision `revision` of its record */
const panel = (steps: number, revision: number, over: Partial<UiSurfaceRecord> = {}): UiSurfaceRecord =>
  record({ surface_id: 'train', revision, spec: training(steps) as UiSurfaceRecord['spec'], state: { note: '' }, ...over })

beforeEach(() => { useStore.setState({ replaying: false }); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); await flush() })

test('the fixture is the protocol: the training panel parses', () => {
  assert.ok(parseUiSurfaceSpec(training(40)).ok)
  assert.ok(parseUiSurfaceSpec(training(40, {}, 20)).ok)
})

test('a new revision of the same surface updates in place: the focused field keeps its focus, the chart its cursor', async () => {
  await show(panel(30, 1))
  const input = q<HTMLInputElement>('.uis-input')!
  const plot = q('.uis-plot')!
  await act(async () => { plot.focus() })
  await key(plot, 'End')
  await key(plot, 'ArrowLeft')
  const chart = () => q('[data-testid="ui-chart-series"]')!
  assert.equal(chart().getAttribute('data-cursor'), '29', 'the cursor on the step before the last')
  // the cursor reads the data's own point there (not a thinned or interpolated one)
  assert.equal(q('.uis-legend-value')!.getAttribute('title'), String(simLoss(29)))
  assert.match(q('[data-testid="ui-chart-spoken"]')!.textContent!, /^29: loss /)

  await show(panel(31, 2))                               // the next step arrives
  assert.equal(q('[data-surface="train"]')!.getAttribute('data-revision'), '2')
  assert.equal(chart().getAttribute('data-latest-x'), '31')
  assert.equal(chart().getAttribute('data-cursor'), '29', 'a later point does not move the cursor')
  assert.equal(q('.uis-plot'), plot, 'the same plot element')
  assert.equal(document.activeElement, plot, 'focus stays where the person left it')

  await act(async () => { input.focus() })
  await show(panel(32, 3))
  assert.equal(q('.uis-input'), input, 'the same field element')
  assert.equal(document.activeElement, input)
  await key(q('.uis-plot')!, 'Escape')
})

test('another surface, run or session — or the replay — is drawn afresh; the key never holds the revision', async () => {
  const base = panel(10, 1)
  assert.equal(surfaceKey(base, false), surfaceKey({ ...base, revision: 9 } as UiSurfaceRecord, false))
  const keys = new Set([
    surfaceKey(base, false), surfaceKey(base, true), surfaceKey({ ...base, run_id: 'r2' }, false),
    surfaceKey({ ...base, session_id: 's2' }, false), surfaceKey({ ...base, surface_id: 'other' }, false),
  ])
  assert.equal(keys.size, 5)
  // ids that would run together when joined by a separator stay apart
  assert.notEqual(surfaceKey({ session_id: 'a:b', run_id: 'c', surface_id: 'd' }, false), surfaceKey({ session_id: 'a', run_id: 'b:c', surface_id: 'd' }, false))

  await show(base)
  const plot = q('.uis-plot')
  await show(panel(10, 1, { run_id: 'r2' }))
  assert.notEqual(q('.uis-plot'), plot, 'another run: a new tree')
  const plot2 = q('.uis-plot')
  await act(async () => { useStore.setState({ replaying: true }) })
  await flush()
  assert.notEqual(q('.uis-plot'), plot2, 'the replay: a new tree')
  assert.ok(q('[data-testid="ui-readonly"]'))
})

test('a revision that fails to draw shows its text version, is not retried, and a newer revision draws again', async () => {
  let renders = 0
  let broken = true
  function Part() { renders += 1; if (broken) throw new Error('boom'); return createElement('p', { id: 'ok' }, 'drawn') }
  const boundary = (revision: number) => createElement(SurfaceBoundary, { fallback: 'text version', revision, children: createElement(Part) })
  const quiet = console.error
  console.error = () => {}
  try {
    await act(async () => root.render(boundary(1)))
    await flush()
    assert.match(container.textContent!, /failed to draw: boom/)
    const tried = renders
    broken = false
    await act(async () => root.render(boundary(1)))      // the same revision again (a re-render of the page)
    await flush()
    assert.equal(renders, tried, 'the failed revision is not drawn again')
    assert.match(container.textContent!, /text version/)
    await act(async () => root.render(boundary(2)))      // a newer revision
    await flush()
    assert.equal(q('#ok')?.textContent, 'drawn')
    broken = true
    await act(async () => root.render(boundary(3)))      // and it fails again: shown once more, no loop
    await flush()
    const after = renders
    await flush()
    assert.equal(renders, after)
    assert.match(container.textContent!, /failed to draw/)
  } finally { console.error = quiet }
})

test('a dense chart: a few marks, not a circle per point; its values table is built when opened, a page at a time', async () => {
  await show(panel(1000, 1))
  const chart = q('[data-testid="ui-chart-series"]')!
  assert.equal(chart.getAttribute('data-points'), '2000')
  // at most four points per pixel column of the plot (here about two per column: drawn as they are)
  assert.ok(Number(chart.getAttribute('data-drawn')) <= 2000)
  assert.equal(chart.querySelectorAll('circle.uis-series-dot').length, 0, 'no per-point dots on a dense line')
  assert.equal(chart.querySelectorAll('circle.uis-series-latest').length, 2, 'one hollow ring per series, at its latest point')
  assert.equal(chart.querySelectorAll('title').length, 0, 'no per-point tooltip')
  const details = q<HTMLDetailsElement>('[data-testid="ui-chart-values"]')!
  assert.equal(details.querySelectorAll('tbody tr').length, 0, 'nothing built while closed')
  await act(async () => { details.open = true; details.dispatchEvent(new dom.window.Event('toggle')) })
  const rows = () => [...details.querySelectorAll('tbody tr')]
  assert.equal(rows().length, 100)
  assert.equal(rows()[99]!.querySelector('th')!.textContent, '1000', 'the newest page first')
  assert.equal(rows()[99]!.querySelectorAll('td')[0]!.textContent, String(simLoss(1000)), 'exact values')
  assert.match(q('[data-testid="ui-chart-pager"]')!.textContent!, /901–1000 of 1,000/)
  await act(async () => { q<HTMLButtonElement>('[aria-label="Earlier rows"]')!.click() })
  assert.equal(rows()[0]!.querySelector('th')!.textContent, '801')
})

test('a sparse chart still shows each point; a point alone between gaps is never lost', async () => {
  await show(record({ surface_id: 'train', spec: training(12, {}, 6) as UiSurfaceRecord['spec'], state: { note: '' } }))
  const chart = q('[data-testid="ui-chart-series"]')!
  assert.equal(chart.querySelectorAll('circle.uis-series-dot').length, 23, 'every value of both series (one reward is a gap)')
  const reward = chart.querySelector('g[data-series="reward"] path')!.getAttribute('d')!
  assert.equal(reward.match(/M/g)!.length, 2, 'the gap lifts the pen')
})

test("an image that failed to load is the source's failure: a later revision with another source loads it", async () => {
  const pic = (revision: number, src: string) => record({
    surface_id: 'pic', revision, state: {},
    spec: { version: 1, surface_id: 'pic', title: 'Sample', fallback: 'a sample', kind: 'native', root: 'img', elements: { img: { type: 'image', props: { src, alt: 'sample' } } } } as UiSurfaceRecord['spec'],
  })
  await show(pic(1, 'https://img.invalid/a.png'))
  await act(async () => { q('img.uis-image')!.dispatchEvent(new dom.window.Event('error')) })
  assert.ok(q('[data-testid="ui-image-missing"]'), 'the failed source shows its words')
  await show(pic(2, 'https://img.invalid/a.png'))
  assert.ok(q('[data-testid="ui-image-missing"]'), 'the same source is not tried again')
  await show(pic(3, 'https://img.invalid/b.png'))
  assert.equal(q('img.uis-image')?.getAttribute('src'), 'https://img.invalid/b.png', 'another source is drawn')
  assert.equal(q('[data-testid="ui-image-missing"]'), null)
})

test('a new revision is never drawn with the state of the one before (the state is taken while drawing)', async () => {
  const seen: string[] = []
  const probe = (r: UiSurfaceRecord) => createElement(Profiler, {
    id: 'p', onRender: () => { seen.push(container.querySelector('.uis-metric')?.getAttribute('aria-label') ?? '') },
    children: createElement(UiSurfaceBlock, { entry: { kind: 'ui', surface: r } }),
  })
  await act(async () => root.render(probe(record())))
  await flush()
  assert.equal(seen.at(-1), 'Total: 12 USD')
  const spec = calculator() as { elements: Record<string, { props: Record<string, unknown> }> }
  spec.elements.total!.props.label = 'Grand total'
  await act(async () => root.render(probe(record({ revision: 2, spec: spec as never, state: { qty: 5, price: 4 } }))))
  await flush()
  assert.equal(seen.at(-1), 'Grand total: 20 USD')
  assert.ok(!seen.includes('Grand total: 12 USD'), `no commit of the new spec with the old state: ${JSON.stringify(seen)}`)
})

test('a tiny value (a learning rate) reads as itself: the legend in exponent form, the keyboard the exact number', async () => {
  const lr = [3e-7, 1.23456789e-7, 0]
  const spec = calculator({
    root: 'c', initial_state: {}, actions: [],
    elements: { c: { type: 'chart', props: { kind: 'line', x_axis: 'number', label: 'lr', series: [{ id: 'lr', label: 'lr', data: lr.map((value, x) => ({ x, value })) }] } } },
  })
  assert.ok(parseUiSurfaceSpec(spec).ok)
  await show(record({ spec: spec as never, state: {} }))
  const plot = q('.uis-plot')!
  await act(async () => { plot.focus() })
  await key(plot, 'Home')
  assert.equal(q('.uis-legend-value')!.textContent, '3e-7')
  await key(plot, 'ArrowRight')
  assert.equal(q('.uis-legend-value')!.textContent, '1.235e-7', 'never rounded to 0')
  assert.equal(q('[data-testid="ui-chart-spoken"]')!.textContent, '1: lr 1.23456789e-7')
  await key(plot, 'End')
  assert.equal(q('.uis-legend-value')!.textContent, '0')
})
