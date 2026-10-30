/** The developer-tool shims' lookup cache (macOS): a shim that finds its tool cold writes the cache, which the
 *  sandbox refuses (and must: the cache is the user's, a command that could rewrite it could redirect the host's
 *  tools), so the shim complains on stderr. The harness warms the cache on the host instead: a common set when the
 *  process manager starts, and any tool a command's stderr names as cold. */

import { afterEach, expect, test } from 'bun:test'
import { XCRUN_TOOLS, XcrunWarmer, xcrunCacheMisses } from '../src/execution/xcrun.ts'
import { buildRuntime } from '../src/execution/isolation.ts'
import { ProcessManager } from '../src/execution/processes.ts'
import { AssetStore } from '../src/store.ts'
import * as repo from '../src/db/repo.ts'
import { sandboxForWorkspace } from '../src/agent/tools/commands.ts'
import { buggyRepo, domainState, PassthroughRuntime, FAKE_FULL, type DomainState } from './harness.ts'

let state: DomainState | null = null
const closers: (() => Promise<void>)[] = []
afterEach(async () => { for (const c of closers.splice(0)) await c(); if (state) await state.close(); state = null })

test("a shim's cold-cache line names its tool; other stderr does not", () => {
  const text = "python3: error: couldn't create cache file '/var/folders/wx/abc/T/xcrun_db-7qC1pzUj' (errno=Operation not permitted)\n"
    + "python3: error: couldn't create cache file '/var/folders/wx/abc/T/xcrun_db-n9Xk7sPd' (errno=Operation not permitted)\n"
    + "Traceback (most recent call last):\n  File \"x.py\", line 1\nValueError: real error\n"
    + "swiftc: error: couldn't create cache file '/var/folders/wx/abc/T/xcrun_db-KlXeqvPW' (errno=Operation not permitted)\n"
  expect(xcrunCacheMisses(text)).toEqual(['python3', 'swiftc'])
  expect(xcrunCacheMisses('ValueError: real error\n')).toEqual([])
  expect(xcrunCacheMisses('')).toEqual([])
})

test('the warmer asks the host once per tool and HOME, in order, and never twice; off when there is no xcrun', async () => {
  const asked: string[] = []
  const warmer = new XcrunWarmer({ enabled: true, find: async (tool, home) => { asked.push(`${home}:${tool}`) } })
  expect(await warmer.warm(['python3', 'git', 'python3'], '/h1')).toEqual(['python3', 'git'])
  expect(await warmer.warm(['git', 'swiftc'], '/h1')).toEqual(['swiftc'])
  expect(await warmer.warm(['../evil', 'a b'], '/h1')).toEqual([])                       // a tool is a name
  expect(await warmer.warm(['git'], '/h2')).toEqual(['git'])                            // another HOME: another entry
  expect(asked).toEqual(['/h1:python3', '/h1:git', '/h1:swiftc', '/h2:git'])
  expect(await new XcrunWarmer({ enabled: false, find: async () => { asked.push('never') } }).warm(['python3'], '/h1')).toEqual([])
  expect(asked).not.toContain('never')
  expect(XCRUN_TOOLS).toContain('python3')
  expect(XCRUN_TOOLS).toContain('git')
})

test("a workspace's first command warms the common set under the workspace's HOME; a command whose stderr says a shim was cold has that tool warmed after it", async () => {
  state = domainState()
  const asked: string[] = []
  const homes = new Set<string>()
  const warmer = new XcrunWarmer({ enabled: true, find: async (tool, home) => { asked.push(tool); homes.add(home) } })
  const processes = new ProcessManager(state.settings, state.conn, state.store, new PassthroughRuntime(), { ...FAKE_FULL, runtime: 'passthrough' }, undefined, warmer)
  closers.push(() => processes.shutdown())
  const project = await state.workspaces.importProject('calc', buggyRepo())
  const session = repo.createSession(state.conn, project.id, 't', 'scripted:a')
  const ws = await state.workspaces.createWorkspace(project, session.id)
  const box = sandboxForWorkspace(state.settings.data_dir, project, ws, { network: false })
  const x = await processes.start({
    command: `sh -c 'echo "footool: error: couldn'"'"'t create cache file '"'"'/var/folders/x/T/xcrun_db-abc'"'"' (errno=Operation not permitted)" >&2; echo done'`,
    cwd: ws.path, sandbox: box, project_id: project.id, workspace_id: ws.id,
  })
  await processes.wait(x.id, 30)
  await new Promise((r) => setTimeout(r, 50))
  expect(asked.slice(0, XCRUN_TOOLS.length)).toEqual(XCRUN_TOOLS)
  expect(asked.at(-1)).toBe('footool')
  expect([...homes]).toEqual([processes.homeFor(ws.id, '')])                              // one HOME for the workspace's commands
  const summary = processes.summary(x.id)
  expect(summary.exit_code).toBe(0)
  expect(String(summary.stderr)).toContain('footool: error')                             // the record is untouched
  // the workspace's next command warms nothing again; another workspace's first one warms its own HOME
  const y = await processes.start({ command: 'echo again', cwd: ws.path, sandbox: box, project_id: project.id, workspace_id: ws.id })
  await processes.wait(y.id, 30)
  expect(asked.length).toBe(XCRUN_TOOLS.length + 1)
  const ws2 = await state.workspaces.createWorkspace(project, repo.createSession(state.conn, project.id, 'u', 'scripted:a').id)
  const z = await processes.start({ command: 'echo other', cwd: ws2.path, sandbox: sandboxForWorkspace(state.settings.data_dir, project, ws2, { network: false }), project_id: project.id, workspace_id: ws2.id })
  await processes.wait(z.id, 30)
  expect(homes.size).toBe(2)
  expect(repo.getExecution(state.conn, z.id)!.isolation.home).toBe(processes.homeFor(ws2.id, ''))
})

test.skipIf(process.platform !== 'darwin')('on macOS a sandboxed python3 and git start quietly once the cache is warm', async () => {
  state = domainState()
  const runtime = buildRuntime()
  const report = await runtime.probe(state.settings.data_dir)
  expect(report.enforcement).toBe('full')
  const processes = new ProcessManager(state.settings, state.conn, state.store, runtime, report)
  closers.push(() => processes.shutdown())
  const project = await state.workspaces.importProject('calc', buggyRepo())
  const session = repo.createSession(state.conn, project.id, 't', 'scripted:a')
  const ws = await state.workspaces.createWorkspace(project, session.id)
  const box = sandboxForWorkspace(state.settings.data_dir, project, ws, { network: false })
  for (const command of ['/usr/bin/python3 -c "print(1)"', 'python3 -c "import sys; print(sys.version_info[0])"', 'git --version']) {
    const x = await processes.start({ command, cwd: ws.path, sandbox: box, project_id: project.id, workspace_id: ws.id })
    await processes.wait(x.id, 60)
    const summary = processes.summary(x.id)
    expect([command, summary.exit_code, String(summary.stderr)]).toEqual([command, 0, ''])
  }
})
