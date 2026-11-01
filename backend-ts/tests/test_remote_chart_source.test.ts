/** A chart's file source in an SSH workspace, over a real owned loopback sshd and the real adapter (no pod, no 8399):
 *  present_ui resolves the path on the host (a file not there yet is accepted; private metadata refused); the person's
 *  client reads it through the workspace's own persistent channel with the adapter's read-only files.tail — pages from
 *  an offset, past the 2 MiB a whole-file read takes, anchors, the prefix's CRC; a file renamed over the path has
 *  another identity; a link out of the project is refused; a disconnected target is a 503 and reading resumes after
 *  Connect. Nothing is written to the remote file. */
import { expect, test } from 'bun:test'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { remoteBinding } from '../src/workspace/remote_files.ts'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { crc32 } from 'node:zlib'
import { UiChartSourcePageSchema, type UiChartSourcePage } from '@oasis-code/contract'
import { LoopbackSshd, inspectPid } from './remote/loopback_sshd.ts'
import { Client, json, makeApp } from './api_harness.ts'
import { setModel, waitDone } from './harness.ts'
import { scriptedModel, steps } from '../src/llm/scripted.ts'
import { textPart, toolCallPart } from '../src/llm/messages.ts'
import * as repo from '../src/db/repo.ts'

const chart = (path: string, surface: string) => ({
  version: 1, surface_id: surface, title: 'Remote training', fallback: 'The remote run\'s loss, read from its log.', kind: 'native', root: 'c',
  elements: { c: { type: 'chart', props: { kind: 'line', x_axis: 'number', source: { path, format: 'jsonl', x: 'step', series: [{ id: 'loss', label: 'Loss', column: 'loss' }] } } } },
})
const ok = (p: UiChartSourcePage) => { if (p.status !== 'ok') throw new Error(`not ok: ${JSON.stringify(p)}`); return p }

test('SSH: a chart source is read through the workspace\'s own channel, a page at a time, read-only', async () => {
  const f = await LoopbackSshd.start({ parent: tmpdir() })
  const app = await makeApp(null, { remote_transport: { config_file: f.configFile, known_hosts_file: f.knownHostsFile, rpc_timeout_ms: 10_000 } })
  const c = new Client(app)
  try {
    const host = await json(await c.post('/api/ssh/targets', { label: 'Own fixture', destination: f.alias, identity_file: f.clientKey }), 201)
    const hostPath = `/api/ssh/targets/${host.id}`
    expect((await json(await c.post(`${hostPath}/connect`))).state).toBe('ready')
    const p = await json(await c.post('/api/projects', { mode: 'direct', source_path: f.workspace, target: { kind: 'ssh', target_id: host.id } }))
    const session = await json(await c.post(`/api/projects/${p.id}/sessions`, { title: 'Remote', model: 'scripted:a' }))
    mkdirSync(join(f.workspace, 'logs'))
    const fixtureWs = repo.getWorkspace(app.state.conn, String((session.workspace as { id: string }).id))!
    const execution = repo.insertExecution(app.state.conn, { run_id: null, workspace_id: fixtureWs.id, tool_call_id: null, kind: 'bash', command: 'fixture status', cwd: fixtureWs.path, isolation: {}, network: false })
    repo.startExecution(app.state.conn, execution.id)
    setModel(app.state, 'scripted:a', scriptedModel(steps(
      [toolCallPart('present_ui', chart('logs/train.jsonl', 'train'), 'p1')],
      [toolCallPart('present_ui', chart('logs/big.jsonl', 'big'), 'p0')],
      [toolCallPart('present_ui', { version: 1, surface_id: 'progress', title: 'SSH progress', fallback: 'Remote batch', kind: 'native', root: 'c', elements: { c: { type: 'progress', props: { source: { path: 'logs/train.jsonl', format: 'jsonl', progress: { completed: 'step', execution_id: execution.id } } } } } }, 'pp')],
      [toolCallPart('present_ui', chart('.oasis-remote/root.json', 'private'), 'p2')],
      [toolCallPart('present_ui', chart('logs', 'dir'), 'p3')],
      [textPart('Shown.')],
    )))
    const chat = await json(await c.post(`/api/sessions/${session.id}/chat`, { text: 'Chart the remote training log.' }))
    const run = await waitDone(app.state, String(chat.id))
    expect(run.status, run.error ?? '').toBe('done')
    const surfaces = repo.listUiSurfaces(app.state.conn, String(session.id))
    expect(surfaces.map((s) => s.surface_id).sort()).toEqual(['big', 'progress', 'train'])
    const src = `/api/sessions/${session.id}/ui/${run.id}/train/sources/c`
    const get = async (params: Record<string, string | number>) => UiChartSourcePageSchema.parse(await json(await c.get(src, { revision: 1, ...params })))

    expect(await get({ offset: 0 })).toEqual({ status: 'missing', reason: 'no file at logs/train.jsonl yet' })
    const file = join(f.workspace, 'logs/train.jsonl')
    // past what a whole-file read takes (2 MiB): the adapter's tail reads the page asked for, no whole-file hash
    const line = (i: number) => `{"step":${i},"loss":${(1 / (i + 1)).toFixed(9)},"pad":"${'x'.repeat(40)}"}\n`
    let text = ''
    for (let i = 0; text.length < 3 * 1024 * 1024; i += 1) text += line(i)
    writeFileSync(file, text)
    const size = Buffer.byteLength(text)
    const before = readFileSync(file)
    const first = ok(await get({ offset: 0, limit: 4096 }))
    expect(first.size).toBe(size)
    expect(Buffer.from(first.data, 'base64').toString()).toBe(text.slice(0, 4096))
    expect(Buffer.from(first.head, 'base64').toString()).toBe(text.slice(0, 64))
    const end = ok(await get({ offset: size - 100, verify: 1 }))
    expect(end.eof).toBe(true)
    expect(Buffer.from(end.data, 'base64').toString()).toBe(text.slice(size - 100))
    expect(Buffer.from(end.anchor!, 'base64').toString()).toBe(text.slice(size - 164, size - 100))
    expect(end.crc).toBe(crc32(Buffer.from(text.slice(0, size - 100))))
    expect(readFileSync(file).equals(before)).toBe(true)
    // a prefix past the adapter's slice (64 MiB): hashed in several requests, the same CRC as the whole (sparse: no disk)
    const big = join(f.workspace, 'logs/big.jsonl')
    writeFileSync(big, '')
    truncateSync(big, 70 * 1024 * 1024)
    const files = app.state.workspaces.requireRemoteFiles()
    const ws = repo.getWorkspace(app.state.conn, String((session.workspace as { id: string }).id))!
    const sliced = await files.remote.request(remoteBinding(ws), 'files.tail', { path: 'logs/big.jsonl', byte_offset: 70 * 1024 * 1024, limit: 0, anchor_bytes: 0, verify: true })
    expect(sliced.crc_next).toBe(64 * 1024 * 1024)
    // through the route: the slices chained, one CRC of the whole prefix
    const whole = UiChartSourcePageSchema.parse(await json(await c.get(`/api/sessions/${session.id}/ui/${run.id}/big/sources/c`, { revision: 1, offset: 70 * 1024 * 1024, limit: 1, verify: 1 })))
    expect(ok(whole).crc).toBe(crc32(Buffer.alloc(70 * 1024 * 1024)))
    // appended: the next page; renamed over: another identity
    appendFileSync(file, line(999_999))
    const tail = ok(await get({ offset: size }))
    expect(Buffer.from(tail.data, 'base64').toString()).toBe(line(999_999))
    writeFileSync(join(f.workspace, 'logs/next.jsonl'), line(0))
    renameSync(join(f.workspace, 'logs/next.jsonl'), file)
    const replaced = ok(await get({ offset: 0 }))
    expect(replaced.file_id).not.toBe(first.file_id)
    expect(replaced.size).toBe(Buffer.byteLength(line(0)))
    // disconnected: unavailable (the client asks again); after Connect it reads again
    await c.post(`${hostPath}/disconnect`)
    expect((await c.get(src, { revision: 1, offset: 0 })).status).toBe(503)
    // A known command result is not lost when the final SSH file read fails. Disconnect alone is not failure.
    const progressUrl = `/api/sessions/${session.id}/ui/${run.id}/progress/sources/c`
    const unavailable = await json(await c.get(progressUrl, { revision: 1, offset: 0 }))
    expect(unavailable.status).toBe('unavailable')
    expect((unavailable.execution as { status: string }).status).not.toBe('failed')
    repo.finishExecution(app.state.conn, execution.id, { status: 'failed', exit_code: 7, timed_out: false, cancelled: false, truncated: false, stdout_asset_id: null, stderr_asset_id: null, stdout_bytes: 0, stderr_bytes: 0, duration_ms: 1 })
    expect(await json(await c.get(progressUrl, { revision: 1, offset: 0 }))).toMatchObject({ status: 'unavailable', execution: { status: 'failed', exit_code: 7 } })
    expect((await json(await c.post(`${hostPath}/connect`))).state).toBe('ready')
    expect(ok(await get({ offset: 0 })).size).toBe(Buffer.byteLength(line(0)))
    // a link out of the project is refused by the host's own resolution
    const outside = join(f.root, 'outside.jsonl')
    writeFileSync(outside, line(1))
    const linked = join(f.workspace, 'logs/train.jsonl')
    renameSync(linked, join(f.workspace, 'logs/old.jsonl'))
    symlinkSync(outside, linked)
    const refused = await c.get(src, { revision: 1, offset: 0 })
    expect(refused.status, await refused.clone().text()).toBe(403)
  } finally {
    await app.close()
    await f.close()
    console.log('REMOTE_CHART_OWNED_PIDS', JSON.stringify(f.ledger.map(p => ({ pid: p.pid, label: p.label, ended: inspectPid(p.pid) === null }))))
  }
  expect(existsSync(f.root)).toBe(false)
}, 90_000)
