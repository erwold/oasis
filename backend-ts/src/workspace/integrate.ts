/** Integration: chosen checkpoints composed onto their common base in a separate integration worktree — never in
 *  the workspace that asked. The base is fixed (the checkpoints' workspaces all started from it); each checkpoint's
 *  whole diff against it is applied three-way in order; a conflict stops the composition and names the files; a
 *  change under a protected path refuses it; the composed state is pinned as a checkpoint of the integration
 *  workspace and the project's checks may run on it in a clean checkout. The result reaches the asking workspace
 *  only when that workspace still stands at the base — base drift refuses the write and the composed checkpoint
 *  stays as the deliverable. */

import { CheckConfigSchema, type CheckConfig, type Checkpoint, type IntegrationResult, type LockSpec, type Workspace } from '@oasis-code/contract'
import type { Conn } from '../db/database.ts'
import * as repo from '../db/repo.ts'
import type { ProcessManager } from '../execution/processes.ts'
import { checkTree } from '../policy/locks.ts'
import { runChecks } from '../verify/checks.ts'
import { GitError } from './git.ts'
import { matchesProtected, type WorkspaceService } from './service.ts'

export type { IntegrationResult }

export function integrationResult(status: string, extra: Partial<IntegrationResult> = {}): IntegrationResult {
  return {
    status, base_commit: null, base_tree: null, applied: [], conflicts: [], protected_hits: [], integration_workspace_id: null,
    composed_checkpoint_id: null, composed_commit: null, tree_sha: null, files: [], checks: [], applied_to_workspace: false, reason: null,
    lock_violations: [], ...extra,
  }
}

/** What an integration needs from the app: the shared connection, the workspace service, the processes and the checks config. */
export interface IntegrationHost {
  conn: Conn
  workspaces: WorkspaceService
  processes: ProcessManager
  config: { checks: CheckConfig[] }
}

/** The common base of the checkpoints' workspaces — the same TREE (two children dispatched one after the other
 *  start from two pinned commits of one unchanged state) — as the first one's base commit, or [null, why not]. */
async function baseOf(host: IntegrationHost, sources: Workspace[], checkpoints: Checkpoint[]): Promise<[string | null, string | null, string | null]> {
  const bases: [string, string, string][] = []
  for (const [i, cp] of checkpoints.entries()) {
    const ws = sources[i]!
    bases.push([cp.id, ws.base_commit, await host.workspaces.git.treeOf(host.workspaces.repoOf(ws), ws.base_commit)])
  }
  const trees = new Set(bases.map((b) => b[2]))
  if (trees.size !== 1) {
    return [null, null, 'the checkpoints started from different bases: ' + bases.map(([cp, b, t]) => `${cp} @ ${b.slice(0, 12)} (tree ${t.slice(0, 12)})`).join(', ')]
  }
  return [bases[0]![1], bases[0]![2], null]
}

export async function integrate(host: IntegrationHost, workspace: Workspace, checkpointIds: string[], opts: {
  run_id: string | null; note: string; protected: string[]; verify: boolean; locks?: LockSpec[] | null
}): Promise<IntegrationResult> {
  if (workspace.source_mount || workspace.kind === 'direct') return integrationResult('refused', { reason: 'live-source workspaces cannot receive automatic integration' })
  const project = repo.getProject(host.conn, workspace.project_id)
  if (project === null) return integrationResult('refused', { reason: `project ${workspace.project_id} not found` })
  const checkpoints: Checkpoint[] = []
  const sources: Workspace[] = []
  for (const cpId of checkpointIds) {
    const cp = repo.getCheckpoint(host.conn, cpId)
    const cpWs = cp ? repo.getWorkspace(host.conn, cp.workspace_id) : null
    if (cp === null || cpWs === null || cpWs.project_id !== project.id) return integrationResult('refused', { reason: `unknown checkpoint of this project: ${cpId}` })
    if (cpWs.source_mount) return integrationResult('refused', { reason: 'source-mounted outputs require human selection; automatic integration is disabled' })
    checkpoints.push(cp)
    sources.push(cpWs)
  }
  if (!checkpoints.length) return integrationResult('refused', { reason: 'no checkpoints named' })
  const git = host.workspaces.git
  const [base, baseTree, why] = await baseOf(host, sources, checkpoints)
  if (base === null || baseTree === null) return integrationResult('refused', { reason: why })
  const result = integrationResult('conflict', { base_commit: base, base_tree: baseTree })
  let integrationWs: Workspace
  try {
    // the integration's repository reads the views of exactly the checkpoints it composes
    integrationWs = await host.workspaces.createWorkspace(project, workspace.session_id, { kind: 'integration', base_commit: base, share: checkpoints.map((cp) => cp.commit_sha) })
  } catch (error) {
    if (error instanceof GitError) return integrationResult('refused', { base_commit: base, base_tree: baseTree, reason: `could not open an integration worktree: ${error.message}` })
    throw error
  }
  result.integration_workspace_id = integrationWs.id
  const root = integrationWs.path
  try {
    for (const cp of checkpoints) {
      const patch = (await git.run(['diff-tree', '-r', '-p', '--binary', '--no-color', '--find-renames', base, cp.commit_sha], { cwd: root })).out
      if (!patch.trim()) { result.applied.push(cp.id); continue } // nothing to apply: the checkpoint equals the base
      const applied = await git.run(['apply', '--3way', '--index', '-'], { cwd: root, check: false, input: patch })
      if (applied.code !== 0) {
        const unmerged = (await git.run(['diff', '--name-only', '--diff-filter=U'], { cwd: root, check: false })).out.split(/\s+/).filter(Boolean)
        result.conflicts = unmerged.length ? [...new Set(unmerged)].sort() : [`${cp.id}: ${applied.err.trim().slice(0, 300)}`]
        result.reason = `checkpoint ${cp.id} conflicts with the composition so far`
        return result
      }
      result.applied.push(cp.id)
    }
    host.workspaces.noteWrite(integrationWs)
    const snapshot = await host.workspaces.snapshot(integrationWs)
    const changed = snapshot.changed_paths.map((line) => (line.includes(' ') ? line.slice(line.indexOf(' ') + 1) : line))
    const hits = changed.filter((p) => matchesProtected(p.split(' -> ').at(-1)!, opts.protected)).sort()
    if (hits.length) {
      result.status = 'refused'
      result.protected_hits = hits
      result.reason = 'the composition changes protected paths: ' + hits.join(', ')
      return result
    }
    if (opts.locks?.length) {
      const broken = await checkTree(git, root, baseTree, snapshot.tree_sha, opts.locks)
      if (broken.length) {
        result.status = 'refused'
        result.lock_violations = broken
        result.reason = 'the composition breaks a hard lock: ' + broken.join('; ')
        return result
      }
    }
    const composed = await host.workspaces.checkpoint(integrationWs, opts.run_id, `integration: ${opts.note}`)
    result.composed_checkpoint_id = composed.id
    result.composed_commit = composed.commit_sha
    result.tree_sha = snapshot.tree_sha
    result.files = await git.numstat(root, base, snapshot.tree_sha)
    let unverified: string | null = null
    const configured = ((project.config.checks as unknown[] | undefined) ?? []).map((c) => CheckConfigSchema.parse(c))
    const checks = configured.length ? configured : [...host.config.checks]
    if (!opts.verify) {
      // an integration reaches the workspace only when every required check passed: asked not to run them, the
      // composition is kept as a checkpoint and the workspace is left as it was
      const skipped = checks.filter((c) => c.required).map((c) => c.id)
      if (skipped.length) unverified = `required checks not run (verify was off): ${skipped.join(', ')}`
    } else if (checks.length) {
      const results = await runChecks(host.conn, host.workspaces, host.processes, project, composed, { checks })
      result.checks = results.map((r) => ({ ...r }))
      // a required check that did not pass — failed, or could not be judged — keeps the composition out of the
      // workspace: nothing turns green by default, and an unknown beside a pass is no pass
      const required = new Set(checks.filter((c) => c.required).map((c) => c.id))
      const short = results.filter((r) => required.has(r.check_id) && r.status !== 'pass').map((r) => `${r.check_id} ${r.status}${r.reason ? ` (${r.reason})` : ''}`)
      if (short.length) unverified = short.join(', ')
    }
    result.status = 'integrated'
    if (unverified !== null) {
      result.reason = `the checks did not verify the composition — ${unverified}; the composed checkpoint ${composed.id} stays, nothing was written to the workspace`
      return result
    }
    // the asking workspace takes the composition only while it still stands at the base
    const current = (await git.snapshotTree(workspace.path, workspace.base_commit)).tree_sha
    if (current !== baseTree) {
      result.reason = `base drift: the workspace's tree ${current.slice(0, 12)} left the base ${baseTree.slice(0, 12)}; the composed `
        + `checkpoint ${composed.id} stays, nothing was written to the workspace`
      return result
    }
    const whole = (await git.run(['diff-tree', '-r', '-p', '--binary', '--no-color', '--find-renames', base, composed.commit_sha], { cwd: root })).out
    if (whole.trim()) {
      const landed = await git.run(['apply', '--3way', '-'], { cwd: workspace.path, check: false, input: whole })
      if (landed.code !== 0) {
        result.reason = `the composition could not be written to the workspace: ${landed.err.trim().slice(0, 300)}`
        return result
      }
      host.workspaces.noteWrite(workspace)
    }
    result.applied_to_workspace = true
    return result
  } finally {
    // the tree goes; the integration's repository, with the composed checkpoint, stays
    try {
      await host.workspaces.removeWorkingTree(integrationWs)
    } catch (error) {
      console.warn(`could not remove the integration worktree ${root}: ${(error as Error).message}`)
    }
  }
}
