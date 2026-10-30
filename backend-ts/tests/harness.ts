/** The pieces the domain tests build by hand (what the app factory assembles): a temp data directory, the database,
 *  the asset store, the workspace service and a process manager whose runtime runs commands as they are (the OS
 *  confinement is what the Seatbelt tests on macOS verify; here the manager's own mechanics are under test). Real
 *  Git, real files, real processes. */

import type { WatchServiceOptions } from '../src/agent/watches/service.ts'
import type { ComputerClient } from '../src/computer/desktop.ts'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Settings, type HarnessConfig, ModelConfig } from '../src/config.ts'
import { connect, type Conn } from '../src/db/database.ts'
import type { IsolationReport, IsolationRuntime, Sandbox } from '../src/execution/isolation.ts'
import { ProcessManager } from '../src/execution/processes.ts'
import { AssetStore } from '../src/store.ts'
import { lockKeyOf, WorkspaceLocks } from '../src/workspace/locks.ts'
import { WorkspaceService } from '../src/workspace/service.ts'
import { tempDir } from './helpers.ts'

export function git(args: string[], cwd: string): string {
  const env = {
    ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', HOME: cwd,
  }
  const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout.trim()
}

export const BUGGY_CALC = 'def add(a, b):\n    return a - b   # the bug: this should add\n\n\ndef mul(a, b):\n    return a * b\n'
export const CALC_TEST = `import unittest
from calc import add, mul


class CalcTest(unittest.TestCase):
    def test_add(self):
        self.assertEqual(add(2, 3), 5)

    def test_mul(self):
        self.assertEqual(mul(2, 3), 6)


if __name__ == "__main__":
    unittest.main()
`

/** A real Git repository with one reproducible defect and the test that shows it. */
export function buggyRepo(base: string = tempDir('oasis-repo-')): string {
  const src = join(base, 'userrepo')
  mkdirSync(src, { recursive: true })
  git(['init', '-q', '-b', 'main'], src)
  writeFileSync(join(src, 'calc.py'), BUGGY_CALC)
  writeFileSync(join(src, 'test_calc.py'), CALC_TEST)
  writeFileSync(join(src, 'README.md'), '# calc\nRun `python3 -m unittest -v`.\n')
  writeFileSync(join(src, '.gitignore'), '__pycache__/\n*.pyc\n')
  git(['add', '-A'], src)
  git(['commit', '-q', '-m', 'calc with a bug'], src)
  return src
}

export function testConfig(models?: ModelConfig[]): HarnessConfig {
  return {
    models: models ?? [
      new ModelConfig({ id: 'scripted:a', label: 'Scripted A', provider: 'anthropic', model: 'scripted-a', api_key_env: 'OASIS_TEST_KEY_A' }),
      new ModelConfig({ id: 'scripted:b', label: 'Scripted B', provider: 'openai', model: 'scripted-b', api_key_env: 'OASIS_TEST_KEY_B' }),
    ],
    default_model: 'scripted:a', context_window_fallback_tokens: 120_000, protected_paths: ['secrets/**'],
    command_env_passthrough: ['PATH', 'LANG', 'LC_ALL'], checks: [], command_timeout_s: 600, command_output_cap_bytes: 8 * 1024 * 1024,
    // confirmed as on a machine where the person said yes once: a scenario that asks sets it false
    full_access_confirmed: true,
  }
}

export const FAKE_FULL: IsolationReport = {
  runtime: 'fake', enforcement: 'full', filesystem_isolation: true, network_isolation: true, process_tree_kill: true, resource_limits: true,
  runtime_fingerprint: 'fake', diagnostics: ['fake full'],
}

/** Runs the command as it is: no confinement (a test of the process manager, never of the sandbox). */
export class PassthroughRuntime implements IsolationRuntime {
  readonly name = 'passthrough'
  fingerprint(): string { return 'passthrough' }
  command(argv: string[], _box: Sandbox, _profile: string): string[] { return argv }
  async probe(): Promise<IsolationReport> { return { ...FAKE_FULL, runtime: this.name } }
}

/** The host a Full access command of a test runs on: the test process's environment with a HOME of its own (empty:
 *  no startup file of the person's is ever read by a test's login shell) and that HOME's TMPDIR. Every app and process
 *  manager a test builds through this file uses it; a test that needs a host of its own sets `hostEnvironment`. */
export function fixtureHostEnvironment(): Record<string, string | undefined> {
  // the macOS fixture run (tests/full_access_mac) starts the suite in a fixture's own environment: that one is the host
  if (process.env.OASIS_CODE_TEST_HOST === 'process') return { ...process.env }
  const home = tempDir('oasis-test-home-')
  mkdirSync(join(home, 'tmp'), { recursive: true })
  return { ...process.env, HOME: home, TMPDIR: join(home, 'tmp'), ZDOTDIR: home, SHELL: '/bin/zsh' }
}

/** A process manager's host made the fixture's (above). */
export function useFixtureHost<T extends { hostEnvironment: () => Record<string, string | undefined> }>(processes: T): T {
  const env = fixtureHostEnvironment()
  processes.hostEnvironment = () => ({ ...env })
  return processes
}

export interface DomainState {
  settings: Settings
  conn: Conn
  store: AssetStore
  workspaces: WorkspaceService
  processes: ProcessManager
  locks: WorkspaceLocks
  isolation: IsolationReport
  config: HarnessConfig
  close(): Promise<void>
}

export function domainState(opts: { runtime?: IsolationRuntime; report?: IsolationReport; config?: HarnessConfig } = {}): DomainState {
  const root = tempDir('oasis-data-')
  const settings = new Settings({ data_dir: join(root, 'data'), host: '127.0.0.1', port: 0, session_token: 'test-token' })
  mkdirSync(settings.data_dir, { recursive: true })
  const conn = connect(settings.db_path)
  const store = new AssetStore(settings.assets_dir)
  const runtime = opts.runtime ?? new PassthroughRuntime()
  const report = opts.report ?? { ...FAKE_FULL, runtime: runtime.name }
  const workspaces = new WorkspaceService(settings, conn)
  const processes = useFixtureHost(new ProcessManager(settings, conn, store, runtime, report))
  const locks = new WorkspaceLocks(join(settings.data_dir, 'locks'), (id) => lockKeyOf(repo.getWorkspace(conn, id), id))
  return {
    settings, conn, store, workspaces, processes, locks, isolation: report, config: opts.config ?? testConfig(),
    close: async () => { await processes.shutdown(); conn.close(); workspaces.close() },
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// ---- the whole app state (what the API and the runner tests drive) ----------------------------------------

import { buildState, closeState, type AppState } from '../src/api/state.ts'
import * as repo from '../src/db/repo.ts'
import { steps as scriptSteps, ScriptedModel, type Script } from '../src/llm/scripted.ts'
import type { Model, ModelProfile } from '../src/llm/model.ts'
import type { RunEvent } from '../src/agent/runner.ts'
import type { Run } from '@oasis-code/contract'

export { closeState, scriptSteps as steps }
export type { AppState }
export { lastToolReturn, toolReturns, userTexts } from '../src/llm/messages.ts'

export function testSettings(): Settings {
  const root = tempDir('oasis-data-')
  return new Settings({ data_dir: join(root, 'data'), host: '127.0.0.1', port: 0, session_token: 'test-token' })
}

/** probe=false: the isolation report says unavailable (bash refuses); sandbox=true: commands run through the
 *  passthrough runtime with a full report (the manager's mechanics, not the OS confinement). */
export async function appState(opts: { settings?: Settings; config?: HarnessConfig; sandbox?: boolean; models?: Record<string, Model>; watches?: WatchServiceOptions; computer?: ComputerClient } = {}): Promise<AppState> {
  const settings = opts.settings ?? testSettings()
  const state = await buildState(settings, opts.config ?? testConfig(), {
    probe: false, model_overrides: opts.models ?? {}, ...(opts.watches ? { watches: opts.watches } : {}), ...(opts.computer ? { computer: opts.computer } : {}),
    ...(opts.sandbox ? { runtime: new PassthroughRuntime(), isolation: { ...FAKE_FULL, runtime: 'passthrough' } } : {}),
  })
  useFixtureHost(state.processes)
  return state
}

export function scriptedModel(script: Script, modelName = 'scripted', profile?: ModelProfile): ScriptedModel {
  return new ScriptedModel(script, { modelName, profile })
}

export async function openSession(state: AppState, repoPath: string, model = 'scripted:a') {
  const project = await state.workspaces.importProject('calc', repoPath)
  const session = repo.createSession(state.conn, project.id, 'fix add', model)
  const ws = await state.workspaces.createWorkspace(project, session.id)
  repo.setSessionWorkspace(state.conn, session.id, ws.id)
  return { project, session: repo.getSession(state.conn, session.id)!, ws }
}

export async function waitDone(state: AppState, runId: string, timeoutMs = 60_000): Promise<Run> {
  const handle = state.runs.handles.get(runId)!
  await Promise.race([handle.task, new Promise((_, reject) => setTimeout(() => reject(new Error(`run ${runId} did not finish in ${timeoutMs}ms`)), timeoutMs))])
  return repo.getRun(state.conn, runId)!
}

export async function collectEvents(state: AppState, runId: string, opts: { after?: number; until?: (e: RunEvent) => boolean } = {}): Promise<RunEvent[]> {
  const out: RunEvent[] = []
  for await (const item of state.runs.subscribe(runId, { after_seq: opts.after ?? -1 })) {
    out.push(item)
    if (opts.until && opts.until(item)) break
  }
  return out
}

export function setModel(state: AppState, id: string, model: Model): void {
  state.model_overrides.set(id, model)
}
