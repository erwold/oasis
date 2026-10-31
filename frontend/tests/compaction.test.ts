import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerHooks } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import ts from 'typescript'
import { JSDOM } from 'jsdom'
import { applyEvent, compactionNote, fromTranscript, type ThreadEntry } from '../src/state/thread.ts'
import { turnParts } from '../src/state/turns.ts'

const start = (id = 'c1') => ({ event: 'context_compacting', id: `start-${id}`, data: { compaction_id: id } })
const end = (status = 'compacted', id = 'c1') => ({ event: 'context_compacted', id: `end-${id}`, data: { compaction_id: id, status, estimate_tokens: 11133, after_tokens: 5766 } })
const apply = (rows: ThreadEntry[], event: ReturnType<typeof start> | ReturnType<typeof end>) => applyEvent(rows, 'r', event)

test('one summary attempt updates in place; duplicates, late starts and completion-first replay never reopen it', () => {
  const began = apply([], start())
  assert.equal(began[0].text, 'Compacting context')
  assert.equal(began[0].running, true)
  assert.strictEqual(apply(began, start()), began)
  const finished = apply(began, end())
  assert.equal(finished.length, 1)
  assert.equal(finished[0].eventId, 'start-c1')
  assert.equal(finished[0].text, 'Context compacted · ~11,133 → ~5,766 tokens')
  assert.equal(finished[0].running, false)
  assert.strictEqual(apply(finished, start()), finished)
  assert.strictEqual(apply(finished, end()), finished)
  const endOnly = apply([], end())
  assert.strictEqual(apply(endOnly, start()), endOnly)
  assert.equal(apply(apply(finished, start('c2')), end('compacted', 'c2')).length, 2)
  assert.equal(applyEvent(finished, 'other-run', start()).length, 2)
})

test('failure, skip, stop and run termination settle the row without invented token counts', () => {
  for (const [status, line] of [['failed', 'Context compaction failed'], ['skipped', 'Context compaction skipped'], ['cancelled', 'Context compaction stopped']]) {
    const rows = apply(apply([], start()), end(status))
    assert.equal(rows.length, 1)
    assert.equal(rows[0].running, false)
    assert.equal(rows[0].text, line)
  }
  for (const status of ['done', 'error', 'cancelled']) {
    const rows = applyEvent(apply([], start()), 'r', { event: 'run_finished', data: { status } })
    assert.equal(rows[0].running, false)
    assert.equal(rows[0].text, 'Context compaction interrupted')
    assert.equal(apply(rows, end())[0].status, 'compacted', 'a delayed completion can replace the fallback')
  }
  const other = applyEvent(apply([], start()), 'other-run', { event: 'run_finished', data: { status: 'done' } })
  assert.equal(other[0].running, true)
  assert.equal(compactionNote({ after_tokens: null, estimate_tokens: NaN }), 'Context compacted · ? → ? tokens')
})

test('legacy completion-only events still work; compaction is a standalone turn part, never inside a work fold', () => {
  const event = { event: 'context_compacted', id: 'legacy', data: { status: 'compacted', estimate_tokens: 100, after_tokens: 20 } }
  const rows = applyEvent([], 'r', event)
  assert.strictEqual(applyEvent(rows, 'r', event), rows)
  const parts = turnParts([{ kind: 'activity', tool: 'read_file' }, ...rows, { kind: 'activity', tool: 'bash' }, { kind: 'agent', text: 'Done' }])
  assert.deepEqual(parts.map((p) => p.kind), ['work', 'compaction', 'work', 'agent'])
  assert.equal(parts.filter((p) => p.kind === 'work').flatMap((p) => p.entries).some((e) => e.kind === 'compaction'), false)
})

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL?.includes('/frontend/src/') && !/\.[a-z]+$/i.test(specifier)) {
      for (const ext of ['.ts', '.tsx']) { const url = new URL(`${specifier}${ext}`, context.parentURL); if (existsSync(url)) return next(url.href, context) }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.startsWith('file:') && url.endsWith('.tsx')) return { format: 'module', shortCircuit: true,
      source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext } }).outputText }
    return next(url, context)
  },
})
const dom = new JSDOM('<!doctype html><html><body></body></html>')
Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })
const { createElement, act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { CompactionRow } = await import('../src/components/CompactionRow.tsx')

test('the mounted status animates only while live, then becomes a static accessible record in the same element', async () => {
  const host = document.createElement('div')
  const root = createRoot(host)
  let rows = apply([], start())
  const render = async (live: boolean) => act(async () => root.render(createElement(CompactionRow, { entry: rows[0], live })))
  try {
    await render(true)
    const row = host.querySelector('[role="status"]')!
    assert.equal(row.textContent, 'Compacting context')
    assert.equal(row.getAttribute('aria-live'), 'polite')
    assert.equal(row.querySelectorAll('.compaction-spinner').length, 1)
    await render(false)
    assert.equal(row.querySelectorAll('.compaction-spinner').length, 0, 'a truncated finished replay cannot spin')
    assert.equal(row.textContent, 'Context compaction interrupted')
    rows = apply(rows, end())
    await render(true)
    assert.strictEqual(host.firstElementChild, row)
    assert.equal(row.textContent, 'Context compacted · ~11,133 → ~5,766 tokens')
    assert.equal(row.querySelectorAll('.compaction-spinner').length, 0)
  } finally { await act(async () => root.unmount()) }
})


test('finished transcript hydration produces the same short standalone line as live events', () => {
  const rows = fromTranscript('r', [{ kind: 'compaction', seq: 4, running: false, compaction: end().data }])
  assert.equal(rows[0].kind, 'compaction')
  assert.equal(rows[0].text, apply(apply([], start()), end())[0].text)
  assert.equal(rows[0].running, false)
  assert.equal(fromTranscript('r', [{ kind: 'compaction', running: false, compaction: { status: 'interrupted' } }])[0].text, 'Context compaction interrupted')
})
