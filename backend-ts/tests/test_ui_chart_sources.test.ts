/** A chart's file source on the backend: present_ui checks the path as read_file would (a file not there yet is
 *  accepted; a path outside the run's bounds is refused) and stores only the spec; the person's client then reads the
 *  file a page at a time through GET …/sources/:element_id — under the bounds of the run that wrote the surface's
 *  revision, at that revision (another is a 409), bounded per page, with the anchors and the prefix's CRC-32 on
 *  request; a link out of the folder is refused; nothing of the file reaches the model, the tool's answer or the
 *  surface's record. */

import { afterEach, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { localPage } from '../src/agent/ui_chart_sources.ts'
import { UiError } from '../src/agent/ui_surfaces.ts'
import { PathPolicy } from '../src/workspace/paths.ts'
import { join } from 'node:path'
import { crc32 } from 'node:zlib'
import { UI_CHART_SOURCE_LIMITS, UiChartSourcePageSchema, type Session } from '@oasis-code/contract'
import * as repo from '../src/db/repo.ts'
import { dumpWorkOrder, parseWorkOrder } from '../src/agent/work_orders.ts'
import { lastToolReturn, modelResponse, textPart, toolCallPart, type ModelMessage } from '../src/llm/messages.ts'
import { createApp, type App } from '../src/main.ts'
import { Client, json } from './api_harness.ts'
import { buggyRepo, collectEvents, scriptedModel, setModel, testConfig, testSettings } from './harness.ts'

let app: App | null = null
afterEach(async () => { if (app) await app.close(); app = null })

type Rec = Record<string, unknown>
const ok = <T extends { status: string }>(p: T) => { if (p.status !== 'ok') throw new Error(`not ok: ${JSON.stringify(p)}`); return p as Extract<T, { status: 'ok' }> }
const chartSpec = (path: string, surface = 'train'): Rec => ({
  version: 1, surface_id: surface, title: 'Training', fallback: 'Loss and validation loss of the run, read from its log.', kind: 'native', root: 'r',
  elements: {
    r: { type: 'stack', children: ['c', 'inline'] },
    c: { type: 'chart', props: { kind: 'line', x_axis: 'number', label: 'Loss', source: { path, format: 'jsonl', x: 'step', series: [{ id: 'loss', label: 'Loss', column: 'loss' }, { id: 'val', label: 'Val', column: 'val_loss', line_style: 'dashed' }] } } },
    inline: { type: 'chart', props: { kind: 'line', x_axis: 'number', series: [{ id: 'a', label: 'A', data: [{ x: 1, value: 2 }] }] } },
  },
})

async function session(c: Client): Promise<Session> {
  const project = await json(await c.post('/api/projects', { source_path: buggyRepo() }))
  const s = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 't', model: 'scripted:a' }))
  return repo.getSession(app!.state.conn, String(s.id))!
}

/** One run whose model calls present_ui with each spec in turn; the tool's answers. */
async function presenting(s: Session, specs: Rec[]) {
  const answers: Rec[] = []
  let n = 0
  setModel(app!.state, 'scripted:a', scriptedModel((m: ModelMessage[]) => {
    if (n > 0) answers.push(lastToolReturn(m, 'present_ui') as Rec)
    const spec = specs[n]
    n += 1
    return spec ? modelResponse([toolCallPart('present_ui', spec, `p${n}`)]) : modelResponse([textPart('shown')])
  }))
  const run = await app!.state.runs.start(s, 'show the training curve')
  await collectEvents(app!.state, run.id)
  return { run: repo.getRun(app!.state.conn, run.id)!, answers }
}

const sourcePath = (s: Session, runId: string, surface = 'train', el = 'c') => `/api/sessions/${s.id}/ui/${runId}/${surface}/sources/${el}`

test('present_ui takes a file source (missing yet, or in the temporary folder) and refuses a path the run may not read', async () => {
  app = await createApp(testSettings(), testConfig(), { probe: false })
  const c = new Client(app)
  const s = await session(c)
  const ws = repo.getWorkspace(app.state.conn, s.workspace_id!)!
  const temp = app.state.processes.ensureTemp(ws.id)
  mkdirSync(join(ws.path, 'logs'), { recursive: true })
  const { run, answers } = await presenting(s, [
    chartSpec('logs/train.jsonl'),
    chartSpec(join(temp, 'metrics.jsonl'), 'tmp'),
    chartSpec('../outside.jsonl', 'up'),
    chartSpec('/etc/hosts', 'abs'),
    chartSpec('logs', 'dir'),
  ])
  expect(answers.map((a) => a.status)).toEqual(['ok', 'ok', 'invalid', 'invalid', 'invalid'])
  expect(JSON.stringify(answers[2])).toContain("'..' is refused")
  expect(JSON.stringify(answers[4])).toContain('not a regular file')
  // the record holds the spec, never a point
  const rec = repo.getUiSurface(app.state.conn, s.id, run.id, 'train')!
  expect(JSON.stringify(rec.spec)).toContain('"path":"logs/train.jsonl"')
  expect(JSON.stringify(rec.state)).toBe('{}')
})

test('the source route: missing, then pages from an offset (bounded), anchors, the prefix CRC; revision, element and links checked', async () => {
  app = await createApp(testSettings(), testConfig(), { probe: false })
  const c = new Client(app)
  const s = await session(c)
  const ws = repo.getWorkspace(app.state.conn, s.workspace_id!)!
  const { run } = await presenting(s, [chartSpec('logs/train.jsonl')])
  const get = (params: Record<string, string | number>, el = 'c') => c.get(sourcePath(s, run.id, 'train', el), { revision: 1, ...params })

  expect(await json<Rec>(await get({ offset: 0 }))).toEqual({ status: 'missing', reason: 'no file at logs/train.jsonl yet' })
  mkdirSync(join(ws.path, 'logs'), { recursive: true })
  const file = join(ws.path, 'logs/train.jsonl')
  const lines = Array.from({ length: 3000 }, (_, i) => `{"step":${i},"loss":${1 / (i + 1)}${i % 100 === 0 ? `,"val_loss":${2 / (i + 1)}` : ''}}\n`).join('')
  writeFileSync(file, lines)
  const size = Buffer.byteLength(lines)
  const first = UiChartSourcePageSchema.parse(await json(await get({ offset: 0, limit: 1000 })))
  if (first.status !== 'ok') throw new Error('not ok')
  expect(first.size).toBe(size)
  expect(Buffer.from(first.data, 'base64').toString()).toBe(lines.slice(0, 1000))
  expect(first.next_offset).toBe(1000)
  expect(first.eof).toBe(false)
  expect(Buffer.from(first.head, 'base64').toString()).toBe(lines.slice(0, UI_CHART_SOURCE_LIMITS.anchorBytes))
  expect(first.anchor).toBe('')
  expect(first.crc).toBeNull()
  // from an offset, with the prefix's CRC and the anchor before it
  const mid = UiChartSourcePageSchema.parse(await json(await get({ offset: 1000, limit: 500, verify: 1 })))
  if (mid.status !== 'ok') throw new Error('not ok')
  expect(mid.crc).toBe(crc32(Buffer.from(lines.slice(0, 1000))))
  expect(Buffer.from(mid.anchor!, 'base64').toString()).toBe(lines.slice(1000 - UI_CHART_SOURCE_LIMITS.anchorBytes, 1000))
  expect(Buffer.from(mid.data, 'base64').toString()).toBe(lines.slice(1000, 1500))
  // a page is bounded whatever is asked
  expect((await get({ offset: 0, limit: UI_CHART_SOURCE_LIMITS.pageBytes + 1 })).status).toBe(422)
  // appended: the next page has it; past the end (truncated): no anchor, nothing read
  appendFileSync(file, '{"step":3000,"loss":-1}\n')
  const tail = UiChartSourcePageSchema.parse(await json(await get({ offset: size })))
  if (tail.status !== 'ok') throw new Error('not ok')
  expect(Buffer.from(tail.data, 'base64').toString()).toBe('{"step":3000,"loss":-1}\n')
  expect(tail.eof).toBe(true)
  writeFileSync(file, '{"step":0,"loss":1}\n')
  const past = UiChartSourcePageSchema.parse(await json(await get({ offset: size })))
  if (past.status !== 'ok') throw new Error('not ok')
  expect(past.size).toBeLessThan(size)
  expect(past.anchor).toBeNull()
  expect(past.data).toBe('')

  // another revision, an inline chart, an unknown element, another session: refused without reading
  const stale = await c.get(sourcePath(s, run.id), { revision: 2, offset: 0 })
  expect(stale.status).toBe(409)
  expect(((await stale.json()) as Rec).error).toBe('stale_revision')
  expect((await get({ offset: 0 }, 'inline')).status).toBe(404)
  expect((await get({ offset: 0 }, 'nope')).status).toBe(404)
  const other = await session(c)
  expect((await c.get(sourcePath(other, run.id), { revision: 1, offset: 0 })).status).toBe(404)
  // a link that leaves the folder is refused at the read (the path was fine when it was presented)
  rmSync(file)
  symlinkSync('/etc/hosts', file)
  const link = await get({ offset: 0 })
  expect(link.status).toBe(403)
  expect(JSON.stringify(await link.json())).toContain('resolves outside')
  // no token: the route is behind the session token as every other
  expect((await new Client(app, { headers: { origin: 'http://localhost' } }).get(sourcePath(s, run.id), { revision: 1, offset: 0 })).status).toBe(401)
})

test('a session surface is read under the run that wrote its current revision; a later revision naming another file reads that one', async () => {
  app = await createApp(testSettings(), testConfig(), { probe: false })
  const c = new Client(app)
  const s = await session(c)
  const ws = repo.getWorkspace(app.state.conn, s.workspace_id!)!
  writeFileSync(join(ws.path, 'a.jsonl'), '{"step":1,"loss":1}\n')
  writeFileSync(join(ws.path, 'b.jsonl'), '{"step":1,"loss":2}\n{"step":2,"loss":3}\n')
  const first = await presenting(s, [{ ...chartSpec('a.jsonl', 'panel'), scope: 'session', expected_revision: 0 }])
  expect(first.answers[0]!.status).toBe('ok')
  const second = await presenting(s, [{ ...chartSpec('b.jsonl', 'panel'), scope: 'session', expected_revision: 1 }])
  expect(second.answers[0]!.status).toBe('ok')
  const rec = repo.getUiSurface(app.state.conn, s.id, first.run.id, 'panel')!
  expect(rec.updated_by_run_id).toBe(second.run.id)
  // the path names the anchor run (as every route of the surface); the read follows revision 2's spec and writer
  expect((await c.get(sourcePath(s, first.run.id, 'panel'), { revision: 1, offset: 0 })).status).toBe(409)
  const page = UiChartSourcePageSchema.parse(await json(await c.get(sourcePath(s, first.run.id, 'panel'), { revision: 2, offset: 0 })))
  if (page.status !== 'ok') throw new Error('not ok')
  expect(Buffer.from(page.data, 'base64').toString()).toContain('"loss":3')
})

test('the prefix check of a long file reads in chunks that yield: the server goes on answering meanwhile', async () => {
  app = await createApp(testSettings(), testConfig(), { probe: false })
  const c = new Client(app)
  const s = await session(c)
  const ws = repo.getWorkspace(app.state.conn, s.workspace_id!)!
  const { run } = await presenting(s, [chartSpec('big.jsonl')])
  // a sparse file of 256 MiB (no disk written): its prefix read and hashed whole would hold the loop for hundreds of ms
  const file = join(ws.path, 'big.jsonl')
  writeFileSync(file, '')
  truncateSync(file, 256 * 1024 * 1024)
  let maxGap = 0
  let last = performance.now()
  let ticks = 0
  const timer = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now; ticks += 1 }, 1)
  const started = performance.now()
  const page = UiChartSourcePageSchema.parse(await json(await c.get(sourcePath(s, run.id), { revision: 1, offset: 256 * 1024 * 1024, verify: 1 })))
  const took = performance.now() - started
  clearInterval(timer)
  if (page.status !== 'ok') throw new Error('not ok')
  expect(page.crc).toBe(crc32(Buffer.alloc(256 * 1024 * 1024)))
  console.log('PREFIX_CRC_256MIB', JSON.stringify({ took_ms: Math.round(took), max_loop_gap_ms: Math.round(maxGap), ticks }))
  expect(ticks).toBeGreaterThan(10)
  expect(maxGap).toBeLessThan(Math.max(60, took / 4))
}, 60_000)

test('a work order\'s read scope bounds what the path resolves to, at every read: a link from an allowed folder to a blocked one is refused', async () => {
  app = await createApp(testSettings(), testConfig(), { probe: false })
  const c = new Client(app)
  const s = await session(c)
  const ws = repo.getWorkspace(app.state.conn, s.workspace_id!)!
  mkdirSync(join(ws.path, 'allowed'), { recursive: true })
  mkdirSync(join(ws.path, 'blocked'), { recursive: true })
  writeFileSync(join(ws.path, 'blocked/metrics.jsonl'), '{"step":1,"loss":666}\n')
  writeFileSync(join(ws.path, 'allowed/ok.jsonl'), '{"step":1,"loss":1}\n')
  const { run } = await presenting(s, [chartSpec('allowed/metrics.jsonl', 'linked'), chartSpec('allowed/ok.jsonl', 'plain')])
  // the run that wrote the surfaces reads under an order whose read scope is allowed/**
  app.state.conn.run('UPDATE runs SET work_order_json=? WHERE id=?', [JSON.stringify(dumpWorkOrder(parseWorkOrder({ prompt: 'read the metrics', scope: { read: ['allowed/**'] } }))), run.id])
  expect(ok(UiChartSourcePageSchema.parse(await json(await c.get(sourcePath(s, run.id, 'plain'), { revision: 1, offset: 0 })))).size).toBeGreaterThan(0)
  // a link put in after the surface was presented: its name is in scope, its target is not
  symlinkSync('../blocked/metrics.jsonl', join(ws.path, 'allowed/metrics.jsonl'))
  const linked = await c.get(sourcePath(s, run.id, 'linked'), { revision: 1, offset: 0 })
  const body = await linked.text()
  expect(linked.status, body).toBe(403)
  expect(body).toContain('blocked/metrics.jsonl is outside the readable paths')
  expect(body).not.toContain('666')
})

test('a folder on the path swapped for a link between the resolution and the open: the second resolution is checked against the scope', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oasis-chart-race-'))
  try {
    mkdirSync(join(root, 'allowed'))
    mkdirSync(join(root, 'blocked'))
    writeFileSync(join(root, 'allowed/metrics.jsonl'), '{"step":1,"loss":1}\n')
    writeFileSync(join(root, 'blocked/metrics.jsonl'), '{"step":1,"loss":666}\n')
    const order = parseWorkOrder({ prompt: 'read the metrics', scope: { read: ['allowed/**'] } })
    const policy = PathPolicy.forWorkspace(root)
    // the swap happens right after the first resolution returns (what a racing writer could do before the open)
    let calls = 0
    const racing = Object.create(policy) as PathPolicy
    racing.resolveRead = (rel: string) => {
      const out = policy.resolveRead(rel)
      calls += 1
      if (calls === 1) { renameSync(join(root, 'allowed'), join(root, 'allowed.old')); symlinkSync('blocked', join(root, 'allowed')) }
      return out
    }
    const refused = await localPage(racing, order, 'allowed/metrics.jsonl', 0, 1024, false).then(() => null, (e: unknown) => e)
    expect(calls).toBe(2)
    expect(refused).toBeInstanceOf(UiError)
    expect((refused as UiError).status).toBe(403)
    expect((refused as UiError).message).toContain('blocked/metrics.jsonl is outside the readable paths')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('progress-only source uses the same authorization and an owned execution reports crash even without a terminal record', async () => {
  app = await createApp(testSettings(), testConfig(), { probe: false })
  const c = new Client(app); const s = await session(c)
  const ws = repo.getWorkspace(app.state.conn, s.workspace_id!)!
  const execution = repo.insertExecution(app.state.conn, { run_id: null, workspace_id: ws.id, tool_call_id: null, kind: 'bash', command: 'fixture only', cwd: ws.path, isolation: {}, network: false })
  repo.startExecution(app.state.conn, execution.id)
  const spec = (path: string, execution_id = execution.id): Rec => ({
    version: 1, surface_id: 'batch', title: 'Image batch', fallback: 'Image conversion progress', kind: 'native', root: 'p',
    elements: { p: { type: 'progress', props: { source: { path, format: 'jsonl', progress: { completed: 'done', total: 'total', execution_id } } } } },
  })
  const { run, answers } = await presenting(s, [spec('batch.jsonl'), spec('../outside'), spec('batch.jsonl', 'not-owned')])
  expect(answers.map((a) => a.status)).toEqual(['ok', 'invalid', 'invalid'])
  writeFileSync(join(ws.path, 'batch.jsonl'), '{"done":2,"total":8}\n')
  const get = () => c.get(sourcePath(s, run.id, 'batch', 'p'), { revision: 1, offset: 0 })
  expect((await json<Rec>(await get())).execution).toEqual({ status: 'running', exit_code: null })
  repo.finishExecution(app.state.conn, execution.id, { status: 'failed', exit_code: 7, timed_out: false, cancelled: false, truncated: false, stdout_asset_id: null, stderr_asset_id: null, stdout_bytes: 0, stderr_bytes: 0, duration_ms: 100 })
  expect((await json<Rec>(await get())).execution).toEqual({ status: 'failed', exit_code: 7 })
  rmSync(join(ws.path, 'batch.jsonl'))
  expect(await json<Rec>(await get())).toMatchObject({ status: 'missing', execution: { status: 'failed', exit_code: 7 } })
})

test('share v2/v3 samples progress before projection: full partial-record history, timestamp, redaction and excluded writers', async () => {
  app = await createApp(testSettings(), testConfig(), { probe: false })
  const c = new Client(app); const s = await session(c)
  const ws = repo.getWorkspace(app.state.conn, s.workspace_id!)!
  const file = join(ws.path, 'batch.jsonl')
  const log = 'batch checkpoint written'
  // The total is not in the tail: only replay of the partial-update stream can recover it.
  writeFileSync(file, '{"done":1,"total":80,"rate":2}\n' + '{"padding":"unused"}\n'.repeat(60_000) + JSON.stringify({ done: 23, log, status: 'running' }) + '\n{half')
  const spec: Rec = { version: 1, surface_id: 'batch', title: 'Batch card', fallback: 'Image batch progress', kind: 'native', root: 'p',
    elements: { p: { type: 'progress', props: { source: { path: 'batch.jsonl', format: 'jsonl', progress: { completed: 'done', total: 'total', rate: 'rate', status: 'status', log: 'log' } } } } } }
  const { run } = await presenting(s, [{ ...spec, scope: 'session', expected_revision: 0 }])
  for (const version of ['', '/v3']) {
    const share = await json<Rec>(await c.post(`/api/sessions/${s.id}/share-snapshot${version}`, { include_tool_details: false }))
    const text = JSON.stringify(share.snapshot)
    expect(text).toContain('progress snapshot')
    expect(text).toContain('23 / 80')
    expect(text).not.toContain(log)
    expect(text).not.toContain('batch.jsonl')
    expect(text).not.toContain(ws.path)
    expect(text).not.toContain(run.id)
  }
  const detailed = await json<Rec>(await c.post(`/api/sessions/${s.id}/share-snapshot`, { include_tool_details: true }))
  expect(JSON.stringify(detailed.snapshot)).toContain(log)
  const skipped = await json<Rec>(await c.post(`/api/sessions/${s.id}/share-snapshot`, { exclude_run_ids: [run.id] }))
  expect(JSON.stringify(skipped.snapshot)).not.toContain('progress snapshot')
  const { run: writer } = await presenting(s, [{ ...spec, scope: 'session', expected_revision: 1 }])
  const updated = await json<any>(await c.post(`/api/sessions/${s.id}/share-snapshot`, {}))
  const progressRows = updated.snapshot.items.filter((i: Rec) => typeof i.target === 'string' && i.target.includes('progress snapshot'))
  expect(progressRows).toHaveLength(1)
  expect(progressRows[0].run).toBe(updated.selection.runs.find((r: Rec) => r.run_id === writer.id).key)
  const hiddenWriter = await json<Rec>(await c.post(`/api/sessions/${s.id}/share-snapshot`, { exclude_run_ids: [writer.id] }))
  expect(JSON.stringify(hiddenWriter.snapshot)).not.toContain('progress snapshot')
})

test('share progress never exports logs from unknown or sensitive executions even through an ordinary source path', async () => {
  app = await createApp(testSettings(), testConfig(), { probe: false })
  const c = new Client(app); const s = await session(c)
  const ws = repo.getWorkspace(app.state.conn, s.workspace_id!)!
  const e = repo.insertExecution(app.state.conn, { run_id: null, workspace_id: ws.id, tool_call_id: null, kind: 'bash', command: 'fixture only', cwd: ws.path, isolation: {}, network: false })
  writeFileSync(join(ws.path, 'ordinary.jsonl'), '{"done":7,"log":"sensitive-command-canary"}\n')
  const { run } = await presenting(s, [{ version: 1, surface_id: 'safe_name', title: 'Batch', fallback: 'Batch', kind: 'native', root: 'p', elements: {
    p: { type: 'progress', props: { source: { path: 'ordinary.jsonl', format: 'jsonl', progress: { completed: 'done', log: 'log', execution_id: e.id } } } },
  } }])
  const share = async () => JSON.stringify((await json<Rec>(await c.post(`/api/sessions/${s.id}/share-snapshot`, { include_tool_details: true }))).snapshot)
  expect(await share()).not.toContain('sensitive-command-canary') // ownership is not provenance
  const seq = repo.listEvents(app.state.conn, run.id).at(-1)!.seq
  repo.insertEvent(app.state.conn, run.id, seq + 1, 'tool_call', { tool: 'bash', tool_call_id: 'sensitive_fixture', command: 'cat .env' })
  repo.insertEvent(app.state.conn, run.id, seq + 2, 'tool_result', { tool: 'bash', tool_call_id: 'sensitive_fixture', execution_id: e.id, status: 'ok' })
  const text = await share()
  expect(text).not.toContain('sensitive-command-canary')
  expect(text).not.toContain('progress snapshot')
  expect(text).not.toContain(e.id)
})

test('share classifies the opened canonical file, not only the benign symlink name; normal absolute workspace sources remain shareable', async () => {
  app = await createApp(testSettings(), testConfig(), { probe: false })
  const c = new Client(app); const s = await session(c)
  const ws = repo.getWorkspace(app.state.conn, s.workspace_id!)!
  writeFileSync(join(ws.path, '.env'), '{"done":9876,"log":"SYMLINK_SECRET_CANARY"}\n')
  symlinkSync(join(ws.path, '.env'), join(ws.path, 'ordinary.jsonl'))
  const spec = (path: string): Rec => ({ version: 1, surface_id: 'canonical', title: 'Batch', fallback: 'Batch progress', kind: 'native', root: 'p', elements: {
    p: { type: 'progress', props: { source: { path, format: 'jsonl', progress: { completed: 'done', log: 'log' } } } },
  } })
  await presenting(s, [spec('ordinary.jsonl')])
  const shared = await json<Rec>(await c.post(`/api/sessions/${s.id}/share-snapshot`, { include_tool_details: true }))
  expect(JSON.stringify(shared.snapshot)).not.toContain('SYMLINK_SECRET_CANARY')
  expect(JSON.stringify(shared.snapshot)).not.toContain('9876')
  writeFileSync(join(ws.path, 'normal.jsonl'), '{"done":3,"log":"normal-log"}\n')
  await presenting(s, [spec(join(ws.path, 'normal.jsonl'))])
  const normal = await json<Rec>(await c.post(`/api/sessions/${s.id}/share-snapshot`, { include_tool_details: true }))
  expect(JSON.stringify(normal.snapshot)).toContain('normal-log')
  expect(JSON.stringify(normal.snapshot)).not.toContain(ws.path)
})

test('share reports truncated recent logs and does not attach snapshots to superseded revisions', async () => {
  app = await createApp(testSettings(), testConfig(), { probe: false })
  const c = new Client(app); const s = await session(c)
  const ws = repo.getWorkspace(app.state.conn, s.workspace_id!)!
  writeFileSync(join(ws.path, 'trim.jsonl'), Array.from({ length: 7 }, (_, i) => JSON.stringify({ done: i, log: 'z'.repeat(2500) })).join('\n') + '\n')
  const spec: Rec = { version: 1, surface_id: 'trim', title: 'Batch', fallback: 'Batch', kind: 'native', root: 'p', elements: {
    p: { type: 'progress', props: { source: { path: 'trim.jsonl', format: 'jsonl', progress: { completed: 'done', log: 'log' } } } },
  } }
  await presenting(s, [spec, spec])
  const share = await json<any>(await c.post(`/api/sessions/${s.id}/share-snapshot`, { include_tool_details: true }))
  const snapshots = share.snapshot.items.filter((i: Rec) => typeof i.target === 'string' && i.target.includes('progress snapshot'))
  expect(snapshots).toHaveLength(1)
  expect(snapshots[0].details.preview_truncated).toBe(true)
})

test('a proven human command may share its progress; sampling cap leaves explicit not_sampled entries', async () => {
  const { recordHumanRun } = await import('../src/agent/human_runs.ts')
  app = await createApp(testSettings(), testConfig(), { probe: false })
  const c = new Client(app); const s = await session(c)
  const ws = repo.getWorkspace(app.state.conn, s.workspace_id!)!
  const e = repo.insertExecution(app.state.conn, { run_id: null, workspace_id: ws.id, tool_call_id: null, kind: 'command', command: 'printf fixture', cwd: ws.path, isolation: {}, network: false })
  repo.finishExecution(app.state.conn, e.id, { status: 'succeeded', exit_code: 0, cancelled: false, timed_out: false, truncated: false, stdout_asset_id: null, stderr_asset_id: null, stdout_bytes: 0, stderr_bytes: 0, duration_ms: 1 })
  recordHumanRun(app.state.conn, { session_id: s.id, project_id: s.project_id, workspace_id: ws.id, label: 'command (connector)', kind: 'command', text: '$ printf fixture\n→ exit 0', produced: { workspace_id: ws.id, executions: [e.id] } })
  writeFileSync(join(ws.path, 'human.jsonl'), '{"done":4,"log":"human-command-progress"}\n')
  const children = Array.from({ length: 21 }, (_, i) => `p${i}`)
  await presenting(s, [{ version: 1, surface_id: 'human', title: 'Human batch', fallback: 'Batch', kind: 'native', root: 'r', elements: {
    r: { type: 'stack', children }, ...Object.fromEntries(children.map((id) => [id, { type: 'progress', props: { source: { path: 'human.jsonl', format: 'jsonl', progress: { completed: 'done', log: 'log', execution_id: e.id } } } }])),
  } }])
  const { sampleShareProgress } = await import('../src/share/progress.ts')
  const samples = [...(await sampleShareProgress(app.state, [s.id], [])).values()].flat()
  expect(samples).toHaveLength(21)
  expect(samples[20]!.availability).toBe('not_sampled')
  const shared = await json<Rec>(await c.post(`/api/sessions/${s.id}/share-snapshot`, { include_tool_details: true }))
  expect(JSON.stringify(shared.snapshot)).toContain('human-command-progress')
  expect(JSON.stringify(shared.snapshot)).not.toContain(e.id)
})
