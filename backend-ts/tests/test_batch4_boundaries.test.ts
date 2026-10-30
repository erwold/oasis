/** Batch 4's boundaries: an image cut after its size header is refused (the complete one is taken); tool calls that
 *  reuse an id each get their own id and return; a request budget closes at the request that reaches it; a
 *  sandboxed grandchild whose intermediate lived a few milliseconds is stopped with its command, while a sandboxed
 *  orphan of something else, standing elsewhere, is left alone. */

import { afterEach, expect, test } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as repo from '../src/db/repo.ts'
import { buildRuntime } from '../src/execution/isolation.ts'
import { ProcessManager } from '../src/execution/processes.ts'
import { ImageRefused, measureImage } from '../src/llm/images.ts'
import { isToolCall, isToolReturn, loadValue, modelResponse, textPart, toolCallPart, userTexts } from '../src/llm/messages.ts'
import { sandboxForWorkspace } from '../src/workspace/sandbox.ts'
import { killOwned, newNonce, ownsPid, publishPid, readPid } from './owned_pids.ts'
import { tempDir } from './helpers.ts'
import { appState, buggyRepo, closeState, domainState, openSession, scriptedModel, setModel, sleep, waitDone, type AppState } from './harness.ts'

let state: AppState | null = null
afterEach(async () => { if (state) await closeState(state); state = null })

const fixture = (name: string) => new Uint8Array(readFileSync(join(import.meta.dir, 'fixtures/images', name)))

test('an image cut after its size header is refused; the complete file is taken', () => {
  for (const [name, header] of [['red-7x5.png', 33], ['red-7x5.jpg', 200], ['red-7x5-lossy.webp', 30], ['red-7x5-lossless.webp', 25]] as const) {
    const whole = fixture(name)
    expect(measureImage(whole).width).toBe(7)
    const cut = whole.subarray(0, Math.min(header, whole.length - 1))
    expect(() => measureImage(cut)).toThrow(ImageRefused)
    expect(() => measureImage(whole.subarray(0, whole.length - 2))).toThrow(/incomplete or damaged/)
  }
})

test('two tool calls under one id each get their own id: both effects, each with its own return', async () => {
  state = await appState()
  const { session, ws } = await openSession(state, buggyRepo())
  let n = 0
  setModel(state, 'scripted:a', scriptedModel(() => (n++ === 0
    ? modelResponse([toolCallPart('write_file', { path: 'first.txt', content: 'FIRST' }, 'same-id'), toolCallPart('write_file', { path: 'second.txt', content: 'SECOND' }, 'same-id')])
    : modelResponse([textPart('done')]))))
  const run = await waitDone(state, (await state.runs.start(session, 'write two')).id)
  expect(readFileSync(join(ws.path, 'first.txt'), 'utf8')).toBe('FIRST')
  expect(readFileSync(join(ws.path, 'second.txt'), 'utf8')).toBe('SECOND')
  const history = loadValue(JSON.parse(repo.getRunHistory(state.conn, run.id)!))
  const calls = history.flatMap((m) => (m.kind === 'response' ? m.parts.filter(isToolCall).map((p) => p.tool_call_id) : []))
  const returns = history.flatMap((m) => (m.kind === 'request' ? m.parts.filter(isToolReturn).map((p) => p.tool_call_id) : []))
  expect(calls).toEqual(['same-id', 'same-id_2'])
  expect(returns).toEqual(calls)
  expect(repo.listEvents(state.conn, run.id).filter((e) => e.event === 'tool_result').map((e) => e.data.tool_call_id)).toEqual(calls)
})

test('a request budget closes at the request that reaches it: three requests that may use tools, then the report-only closing request', async () => {
  state = await appState()
  const { session } = await openSession(state, buggyRepo())
  const surfaces: number[] = []
  setModel(state, 'scripted:a', scriptedModel((messages, info) => {
    surfaces.push(info.function_tools.length)
    // the closing request keeps the tools described (the cache prefix) and says none may run
    const closing = userTexts(messages).some((t) => t.includes('No tools are available'))
    return closing ? modelResponse([textPart('closing report')]) : modelResponse([toolCallPart('read_file', { path: 'calc.py' }, `r${surfaces.length}`)])
  }))
  const run = await waitDone(state, (await state.runs.start(session, 'loop', { budget: { requests: 3 } })).id)
  expect(surfaces.length).toBe(4)                                                // not the segment length first
  expect(surfaces.at(-1)).toBe(surfaces[0])
  expect(repo.listEvents(state.conn, run.id).filter((e) => e.event === 'tool_result')).toHaveLength(3)
  expect(run.receipt.final_text).toBe('closing report')
  expect((run.receipt.mechanical as Record<string, unknown>).budget_reached).toBe('requests 3 of 3')
})

test.skipIf(process.platform !== 'darwin')('two commands of one workspace: a grandchild of A through a brief intermediate, gone out of the folder, is A\'s — stopping B leaves it, stopping A ends it; a sandboxed orphan of something else is left alone', async () => {
  const domain = domainState()
  const elsewhere = tempDir('oasis-elsewhere-')
  const nonce = newNonce()
  let ours: number | null = null
  let theirs: number | null = null
  let manager: ProcessManager | null = null
  try {
    const project = await domain.workspaces.importProject('p', buggyRepo())
    const session = repo.createSession(domain.conn, project.id, 's', 'scripted:a')
    const ws = await domain.workspaces.createWorkspace(project, session.id)
    const runtime = buildRuntime()
    manager = new ProcessManager(domain.settings, domain.conn, domain.store, runtime, await runtime.probe(domain.settings.data_dir))
    const box = sandboxForWorkspace(domain.settings.data_dir, project, ws, { network: false })
    // A waits for a go file, then forks an intermediate that forks G and exits 20 ms later; G leaves for / and lives on.
    // (An intermediate that exits the instant it has forked can outrun the fork watcher: the stated limit, not asserted here.)
    const marker = join(ws.path, 'g.pid')
    writeFileSync(join(ws.path, 'a.py'), `import os,sys,time\nwhile not os.path.exists('go'): time.sleep(0.01)\nif os.fork()==0:\n    os.setsid()\n    if os.fork()==0:\n        os.chdir('/')\n        ${publishPid(marker, nonce)}\n        time.sleep(6)\n    time.sleep(0.02)\n    os._exit(0)\ntime.sleep(8)\n`)
    const a = await manager.start({ command: `exec /usr/bin/env -i PATH=/usr/bin:/bin python3 a.py ${nonce}`, cwd: ws.path, sandbox: box, project_id: project.id, workspace_id: ws.id, timeout_s: 10 })
    const b = await manager.start({ command: 'sleep 8', cwd: ws.path, sandbox: box, project_id: project.id, workspace_id: ws.id, timeout_s: 10 })
    await sleep(100)
    writeFileSync(join(ws.path, 'go'), '')                                  // A's intermediate is made after B started
    ours = await readPid(marker, nonce)
    expect(ours).not.toBeNull()
    const theirsMarker = join(elsewhere, 'g.pid')
    writeFileSync(join(elsewhere, 'df.py'), `import os,sys,time\nif os.fork()==0:\n    os.setsid()\n    if os.fork()==0:\n        ${publishPid(theirsMarker, nonce)}\n        time.sleep(4)\n    os._exit(0)\n`)
    spawnSync('sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/python3', 'df.py', nonce], { cwd: elsewhere, stdio: 'ignore' })
    theirs = await readPid(theirsMarker, nonce)
    expect(theirs).not.toBeNull()
    await sleep(80)
    manager.stop(b.id)
    await manager.wait(b.id, 3)
    await sleep(100)
    expect(ownsPid(ours, nonce)).toBe(true)                                  // not B's
    manager.stop(a.id)
    await manager.wait(a.id, 3)
    await sleep(100)
    expect(ownsPid(ours, nonce)).toBe(false)                                 // A's, however it left
    expect(manager.summary(a.id).stray_processes_killed).toBeGreaterThanOrEqual(1)
    expect(ownsPid(theirs, nonce)).toBe(true)                                // nobody's here: untouched
  } finally {
    killOwned(ours, nonce)
    killOwned(theirs, nonce)
    await manager?.shutdown()
    await domain.close()
  }
}, 30_000)
