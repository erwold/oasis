/** Isolated runtime probes: source-worker exit, encoder-unavailable fallback, and an opt-in compiled-worker
 * smoke test. Never starts an HTTP server or opens a database. Compile only in the coordinated build window. */
import { expect, test } from 'bun:test'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { reportInput } from './context_report_fixture.ts'
import { removeDir, tempDir } from './helpers.ts'

const backend = join(import.meta.dir, '..')
const clientUrl = pathToFileURL(join(backend, 'src/agent/context_report_worker_client.ts')).href
const computeUrl = pathToFileURL(join(backend, 'src/agent/context_report_compute.ts')).href
const input = reportInput()

function probe(clientImport: string): string {
  return `
    import { ContextReportWorker, contextReportWorkerEntry } from ${JSON.stringify(clientImport)};
    const worker = new ContextReportWorker();
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1 }, 1);
    try {
      const { report } = await worker.compute(${JSON.stringify(input)});
      console.log(JSON.stringify({ report, ticks, entry: contextReportWorkerEntry() }));
    } finally { clearInterval(timer) }
    // Deliberately NO close()/process.exit(): an idle worker must not hold this process alive.
  `
}

function checkProbe(result: SpawnSyncReturns<string>, embedded = false): void {
  expect(result.error, result.stderr?.toString()).toBeUndefined()
  expect(result.status, result.stderr?.toString()).toBe(0)
  const parsed = JSON.parse(result.stdout!.toString())
  expect(parsed.report.session_id).toBe(input.sessionId)
  expect(parsed.report.tokens_est).toBeGreaterThan(0)
  expect(parsed.report.total_tokens).toBeGreaterThan(0)
  expect(parsed.report.tokenizer).toBe('o200k_base')
  expect(parsed.ticks).toBeGreaterThan(0)
  expect(parsed.entry).toContain('context_report_worker.')
  if (embedded) expect(parsed.entry).toMatch(/\$bunfs|~BUN/)
}

test('a fresh source process completes a cold report and exits with its idle worker unrefed', () => {
  checkProbe(spawnSync(process.execPath, ['-e', probe(clientUrl)], { cwd: backend, encoding: 'utf8', timeout: 30_000 }))
}, 35_000)

test('missing encoder preserves no-count display and the original byte fallback estimate (isolated module mock)', () => {
  // Mock only this child realm; never contaminate another test's tokenizer module or real worker.
  const code = `
    import { mock } from 'bun:test';
    mock.module('js-tiktoken', () => ({ getEncoding() { throw new Error('synthetic unavailable encoder') } }));
    const { computeContextReport } = await import(${JSON.stringify(computeUrl)});
    console.log(JSON.stringify(computeContextReport(${JSON.stringify(input)}).report));
  `
  const result = spawnSync(process.execPath, ['-e', code], { cwd: backend, encoding: 'utf8', timeout: 30_000 })
  expect(result.error, result.stderr).toBeUndefined()
  expect(result.status, result.stderr).toBe(0)
  const report = JSON.parse(result.stdout)
  const fallback = (text: string) => Math.max(1, Math.floor(Buffer.byteLength(text, 'utf8') / 4))
  expect(report.total_tokens).toBeNull()
  expect(report.tokenizer).toBeNull()
  expect(report.tokens_basis).toContain('not available here')
  expect(report.history.wire_tokens).toBeNull()
  expect(report.tokens_est).toBe(Math.ceil((fallback(input.text) + fallback(input.schemaEstimateText) + fallback('')) * 1.3))
})

test.skipIf(process.env.OASIS_TEST_CONTEXT_REPORT_COMPILE !== '1')('compiled entries resolve the report worker and the binary exits without starting the app', () => {
  const dir = tempDir('oasis-context-report-compile-')
  try {
    // Keep the production entry layout and package build/sign command EXACTLY. Only the copied index is a
    // CPU-only probe, not the backend server; no fixtures/user data, database or installed app is copied.
    cpSync(join(backend, 'src'), join(dir, 'src'), { recursive: true })
    symlinkSync(join(backend, 'node_modules'), join(dir, 'node_modules'), 'dir')
    const pkg = JSON.parse(readFileSync(join(backend, 'package.json'), 'utf8'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'context-report-compile-probe', type: 'module', scripts: { build: pkg.scripts.build } }))
    writeFileSync(join(dir, 'src/index.ts'), probe('./agent/context_report_worker_client.ts'))
    mkdirSync(join(dir, 'dist'))
    const built = spawnSync(process.execPath, ['run', 'build'], { cwd: dir, encoding: 'utf8', timeout: 90_000 })
    expect(built.error, built.stderr).toBeUndefined()
    expect(built.status, built.stderr).toBe(0)
    checkProbe(spawnSync(join(dir, 'dist/oasis-code'), [], { cwd: dir, encoding: 'utf8', timeout: 30_000 }), true)
  } finally { removeDir(dir) }
}, 130_000)
