/** A command's record says what followed its children as it turned out, not as it was hoped: the fork watcher once
 *  its thread reported ready, the lineage tick while it starts and when it did not start. macOS only. */

import { expect, test } from 'bun:test'
import * as repo from '../src/db/repo.ts'
import { buildRuntime } from '../src/execution/isolation.ts'
import type { ForkWatcher } from '../src/execution/lineage.ts'
import { ProcessManager } from '../src/execution/processes.ts'
import { sandboxForWorkspace } from '../src/workspace/sandbox.ts'
import { buggyRepo, domainState, sleep } from './harness.ts'

const darwin = process.platform === 'darwin'

test.skipIf(!darwin)('a command\'s record follows the watcher: starting, then what it turned out to be — ready, or did not start (and the next command says so at once)', async () => {
  const domain = domainState()
  let manager: ProcessManager | null = null
  try {
    const project = await domain.workspaces.importProject('p', buggyRepo())
    const session = repo.createSession(domain.conn, project.id, 's', 'scripted:a')
    const ws = await domain.workspaces.createWorkspace(project, session.id)
    const runtime = buildRuntime()
    const report = await runtime.probe(domain.settings.data_dir)
    const box = sandboxForWorkspace(domain.settings.data_dir, project, ws, { network: false })
    const start = (m: ProcessManager) => m.start({ command: 'sleep 1', cwd: ws.path, sandbox: box, project_id: project.id, workspace_id: ws.id, timeout_s: 10 })
    const lineage = (xid: string) => (repo.getExecution(domain.conn, xid)!.isolation as { lineage?: string }).lineage

    manager = new ProcessManager(domain.settings, domain.conn, domain.store, runtime, report)
    const ok = await start(manager)
    expect(lineage(ok.id)).toBe('tick only (the fork watcher is starting)')
    for (let t = 0; t < 100 && lineage(ok.id) !== 'fork watcher'; t += 1) await sleep(10)
    expect(lineage(ok.id)).toBe('fork watcher')
    await manager.wait(ok.id, 5)
    await manager.shutdown()

    // a thread that fails after it was asked to start (its module not found, as a build without it would say)
    manager = new ProcessManager(domain.settings, domain.conn, domain.store, runtime, report)
    // the watcher's own private steps, reached by cast: it is asked to start, and its thread fails a moment later
    type Steps = { state: ForkWatcher['state']; watch: ForkWatcher['watch']; fail(e: unknown): void; setState(s: ForkWatcher['state']): void }
    const forks = (manager as unknown as { forks: Steps }).forks
    forks.watch = function watch(this: Steps) {
      if (this.state === 'failed') return
      this.setState('starting')
      setTimeout(() => this.fail(new Error('ModuleNotFound (injected)')), 50)
    }
    const failed = await start(manager)
    expect(lineage(failed.id)).toBe('tick only (the fork watcher is starting)')
    await sleep(150)
    expect(lineage(failed.id)).toBe('tick only (the fork watcher did not start)')
    const next = await start(manager)
    expect(lineage(next.id)).toBe('tick only (the fork watcher did not start)')
    await manager.wait(failed.id, 5)
    await manager.wait(next.id, 5)
  } finally {
    await manager?.shutdown()
    await domain.close()
  }
}, 30_000)
