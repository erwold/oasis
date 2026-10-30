/** Verification: a small VerificationSpec / CheckResult pair. A check is a configured command run in a clean
 *  verification worktree at an exact snapshot (a checkpoint's commit), where its session's commands run (policy/access.ts):
 *  on the host as the user with Full access (the network as the session grants it, held by the OS when off), in the
 *  sandbox otherwise (network off, as always) — and in the sandbox when no session is bound to it, never Full by
 *  default; its execution records where it ran and why. Its deadline is the check's configured one. Its result carries the
 *  command, the exit code, the duration, the log asset, the parser and its version, the counts it could read, and
 *  pass / fail / unknown. A command that exits 0 with nothing collected is unknown; a parse failure, a timeout, a
 *  missing log are unknown; nothing here turns green by default. Results belong to the snapshot they ran on: a
 *  later snapshot makes them stale. */

import type { CheckConfig, CheckResult, Checkpoint, Project, Session } from '@oasis-code/contract'
import type { Conn } from '../db/database.ts'
import * as repo from '../db/repo.ts'
import { SANDBOX_DEFAULT_TIMEOUT_S, type AccessReport, type ProcessManager } from '../execution/processes.ts'
import { accessDecision, currentRequestCap, reason as accessReason, type AccessDecision } from '../policy/access.ts'
import { networkGranted } from '../policy/permissions.ts'
import { newId } from '../ids.ts'
import { nowIso } from '../timebase.ts'
import { sandboxForWorkspace } from '../workspace/sandbox.ts'
import { policyRoots } from '../workspace/roots.ts'
import type { WorkspaceService } from '../workspace/service.ts'

export const PARSER_VERSION = '1'

const PYTEST_SUMMARY = /=+ (.*?) in [0-9.]+s/
const PYTEST_COUNT = /(\d+) (passed|failed|error|errors|skipped|xfailed|xpassed|deselected|warning|warnings)/g
const NODE_TEST = /^# (tests|pass|fail|skipped|todo|cancelled) (\d+)$/gm

export function parsePytest(text: string): [Record<string, number>, string | null] {
  const counts: Record<string, number> = {}
  let summary: string | null = null
  for (const line of text.split('\n').reverse()) {
    const m = PYTEST_SUMMARY.exec(line)
    if (m) { summary = m[1]!; break }
  }
  if (summary === null) {
    if (/no tests ran|collected 0 items/.test(text)) return [{ collected: 0 }, 'no tests ran']
    return [{}, null]
  }
  PYTEST_COUNT.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = PYTEST_COUNT.exec(summary)) !== null) {
    const key = ({ error: 'errors', warning: 'warnings' } as Record<string, string>)[m[2]!] ?? m[2]!
    counts[key] = (counts[key] ?? 0) + Number.parseInt(m[1]!, 10)
  }
  return [counts, summary]
}

export function parseNodeTest(text: string): [Record<string, number>, string | null] {
  const counts: Record<string, number> = {}
  NODE_TEST.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = NODE_TEST.exec(text)) !== null) counts[m[1]!] = Number.parseInt(m[2]!, 10)
  const summary = Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')
  return [counts, summary || null]
}

/** [status, reason]. */
export function judge(parser: string, exitCode: number | null, timedOut: boolean, counts: Record<string, number>, summary: string | null, truncated: boolean): [string, string] {
  if (timedOut) return ['unknown', 'timed out']
  if (exitCode === null) return ['unknown', 'no exit code (the process was lost or stopped)']
  if (parser === 'exit_code') return exitCode === 0 ? ['pass', 'exit 0'] : ['fail', `exit ${exitCode}`]
  if (parser === 'pytest') {
    if (summary === null) return ['unknown', 'no pytest summary line in the log' + (truncated ? ' (log truncated at the cap)' : '')]
    if (counts.collected === 0 || (!counts.passed && !counts.failed && !counts.errors)) return ['unknown', 'nothing collected or run']
    if (counts.failed || counts.errors) return ['fail', summary]
    if (exitCode !== 0) return ['fail', `exit ${exitCode}: ${summary}`]
    return ['pass', summary]
  }
  if (parser === 'node_test') {
    if (!('tests' in counts)) return ['unknown', 'no node test summary in the log' + (truncated ? ' (log truncated at the cap)' : '')]
    if (counts.tests === 0) return ['unknown', '0 tests']
    if (counts.fail || counts.cancelled) return ['fail', summary || 'failures']
    // tests that were all skipped or todo proved nothing, as pytest's run with nothing passed proves nothing
    if (!counts.pass) return ['unknown', `no test passed: ${summary || 'none ran'}`]
    if (exitCode !== 0) return ['fail', `exit ${exitCode}`]
    return ['pass', summary || 'ok']
  }
  return ['unknown', `unknown parser ${parser}`]
}

export interface VerificationSpec { checks: CheckConfig[] }

/** Where the checks of a checkpoint run, and why: the access of the session they are bound to — the one named, else the
 *  checkpoint's workspace's — narrowed by the run's cap and the request; the sandbox when none is bound (said). */
export function checkAccess(conn: Conn, checkpoint: Pick<Checkpoint, 'workspace_id'>, opts: { run_id?: string | null; session_id?: string | null } = {}): { decision: AccessDecision; network: boolean; session: Session | null } {
  const owner = repo.getWorkspace(conn, checkpoint.workspace_id)
  const sessionId = opts.session_id ?? owner?.session_id ?? null
  const session = sessionId ? repo.getSession(conn, sessionId) : null
  if (session === null) return { decision: { requested: 'sandbox', effective: 'sandbox', reasons: [accessReason('no_session')] }, network: false, session: null }
  const decision = accessDecision({ session, run_cap: opts.run_id ? repo.runAccessCap(conn, opts.run_id) : null, request: currentRequestCap() })
  // the sandbox's checks keep the network off, as they always ran; a Full access check has the session's network
  return { decision, network: decision.effective === 'full' ? networkGranted(session.grants) : false, session }
}

/** Every check of the spec on the checkpoint's exact commit, in a fresh detached worktree that is removed
 *  afterwards. Records one CheckResult per check (unknown when it could not be judged). */
export async function runChecks(conn: Conn, workspaces: WorkspaceService, processes: ProcessManager, project: Project, checkpoint: Checkpoint,
  spec: VerificationSpec, opts: { run_id?: string | null; session_id?: string | null } = {}): Promise<CheckResult[]> {
  const owner = repo.getWorkspace(conn, checkpoint.workspace_id)
  if (!owner || owner.source_mount) throw new Error('verification checkouts are unavailable for source-mounted outputs; commands must run within the original isolated workspace')
  const results: CheckResult[] = []
  if (!spec.checks.length) return results
  const runId = opts.run_id ?? null
  // the checkout reads the view of that checkpoint's commit (and the base's); the checks' commands read the same
  const path = await workspaces.openVerificationWorktree(project, checkpoint.commit_sha)
  try {
    for (const check of spec.checks) {
      // read again for each check: an access changed meanwhile holds for the next one
      const { decision, network, session } = checkAccess(conn, checkpoint, { run_id: runId, session_id: opts.session_id ?? null })
      const full = decision.effective === 'full'
      // the session's folders as its checkpoint's workspace holds them (read-only in an isolated copy)
      const roots = policyRoots(session, owner)
      const report: AccessReport = {
        requested_access: decision.requested, effective_access: decision.effective,
        access_reasons: [...decision.reasons, ...(full && !network ? [accessReason('network_off')] : []), ...(full && roots.some((r) => r.access === 'read') ? [accessReason('read_only_root')] : [])],
      }
      let logAsset: string | null = null
      let counts: Record<string, number> = {}
      let summary: string | null = null
      let exitCode: number | null = null
      let timedOut = false
      let duration: number | null = null
      let truncated = false
      let status: string
      let reason: string
      try {
        // the check's own deadline when it names one; else none with Full access, the sandbox's default in it
        const given = check.timeout_s ?? null
        const deadline = given ?? (full ? null : SANDBOX_DEFAULT_TIMEOUT_S)
        let execution = await processes.start({
          command: check.command, cwd: path, project_id: project.id, run_id: runId, workspace_id: checkpoint.workspace_id,
          kind: 'check', timeout_s: given, ...(given !== null ? { timeout_source: 'check' as const } : {}), access: decision.effective, access_report: report,
          ...(full
            // the session's read-only folders stay unwritten by its checks too (held by the OS on the host)
            ? { host_restrictions: { network, write_deny: roots.filter((r) => r.access === 'read').map((r) => r.path) } }
            : { sandbox: sandboxForWorkspace(workspaces.settings.data_dir, project, { path }, { network: false, roots }) }),
        })
        execution = (await processes.wait(execution.id, deadline === null ? null : deadline + 5)) ?? execution
        exitCode = execution.exit_code
        timedOut = execution.timed_out
        duration = execution.duration_ms
        truncated = execution.truncated
        const text = processes.readOutput(execution.id, 'stdout', 0, 1024 * 1024).text + '\n' + processes.readOutput(execution.id, 'stderr', 0, 1024 * 1024).text
        logAsset = execution.stdout_asset_id || execution.stderr_asset_id
        if (check.parser === 'pytest') [counts, summary] = parsePytest(text)
        else if (check.parser === 'node_test') [counts, summary] = parseNodeTest(text)
        ;[status, reason] = judge(check.parser, exitCode, timedOut, counts, summary, truncated)
      } catch (error) {
        status = 'unknown'
        reason = `could not run: ${(error as Error).message ?? error}`.slice(0, 300)
      }
      const result: CheckResult = {
        id: newId('chk'), run_id: runId, workspace_id: checkpoint.workspace_id, snapshot_id: checkpoint.snapshot_id, check_id: check.id,
        command: check.command, exit_code: exitCode, duration_ms: duration, log_asset_id: logAsset, parser: check.parser,
        parser_version: PARSER_VERSION, counts, status: status as CheckResult['status'], reason, created_at: nowIso(),
      }
      repo.insertCheck(conn, result)
      results.push(result)
    }
  } finally {
    await workspaces.removeVerificationWorktree(project, path)
  }
  return results
}

// -- test weakening: shown separately, never counted as evidence -------------

const WEAKENING: [RegExp, string][] = [
  [/^\+.*\b(pytest\.mark\.(skip|xfail|skipif)|@unittest\.skip|\.skip\(|\.only\(|xit\(|xdescribe\(|test\.skip|it\.skip)\b/, 'skip/xfail/only added'],
  [/^-.*\bassert\b/, 'assertion removed'],
]
const TEST_PATH = /(^|\/)(tests?|__tests__|spec)(\/|$)|(_test|\.test|\.spec|test_)[^/]*\.[a-z]+$/
const CONFIG_PATH = /(pytest\.ini|pyproject\.toml|setup\.cfg|tox\.ini|conftest\.py|jest\.config|vitest\.config|\.github\/workflows\/|\.gitlab-ci|Jenkinsfile|package\.json)$/

export interface ReviewFlag { path: string; kind: string; detail: string }

/** Changes a person must look at before the diff counts as done: deleted test files, skips / only / xfail added,
 *  assertions removed, test collection or CI configuration touched, many snapshots updated. */
export function reviewFlags(patch: string, files: { path?: string; added?: number | null; removed?: number | null }[]): ReviewFlag[] {
  const flags: ReviewFlag[] = []
  for (const f of files) {
    const path = f.path ?? ''
    if (TEST_PATH.test(path) && f.added === 0 && (f.removed ?? 0) > 0) flags.push({ path, kind: 'test_deleted_or_emptied', detail: `-${f.removed} lines, +0` })
    if (CONFIG_PATH.test(path)) flags.push({ path, kind: 'test_or_ci_configuration_changed', detail: 'collection / CI rules may change' })
  }
  const snapshots = files.filter((f) => /__snapshots__\/|\.snap$/.test(f.path ?? ''))
  if (snapshots.length >= 5) flags.push({ path: `${snapshots.length} snapshot files`, kind: 'mass_snapshot_update', detail: 'review the new baselines' })
  let current: string | null = null
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++ b/')) { current = line.slice(6); continue }
    if (current && TEST_PATH.test(current)) {
      for (const [pattern, kind] of WEAKENING) {
        if (pattern.test(line)) { flags.push({ path: current, kind, detail: line.slice(0, 160) }); break }
      }
    }
  }
  return flags
}
