/** Opt-in independent Search probe. No app or user database is opened.
 * --dry-run (default): real webSearch + ActionGate with network denied; no credential lookup/network.
 * --live: one request at most, through the same gate and ordinary credential helper, no retries.
 * Only fixed public official-documentation query; no headers, keys, snippets or raw errors are printed.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BudgetSchema, GrantsSchema } from '@oasis-code/contract'
import { connect } from '../src/db/database.ts'
import * as repo from '../src/db/repo.ts'
import type { AgentDeps } from '../src/agent/deps.ts'
import { webSearch } from '../src/agent/tools/web.ts'
import { ActionGate } from '../src/policy/permissions.ts'
import { AssetStore } from '../src/store.ts'
import { saveSearchSettings } from '../src/search/settings.ts'
import type { SearchDependencies } from '../src/search/deepseek.ts'

const QUERY = 'site:api-docs.deepseek.com Search API documentation'
export async function runSearchProbe(live: boolean, injected: Partial<SearchDependencies> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'oasis-search-probe-'))
  const conn = connect(join(root, 'probe.db'))
  try {
    const store = new AssetStore(join(root, 'assets'))
    saveSearchSettings(store, { engine: 'deepseek' })
    const project = repo.createProject(conn, 'Search probe', { source_path: null, base_repo_path: root,
      base_commit: null, base_branch: null, import_report: {} })
    const session = repo.createSession(conn, project.id, 'Search probe', 'probe', GrantsSchema.parse({ network: live }))
    const run = repo.insertRun(conn, { session_id: session.id, project_id: project.id, workspace_id: null,
      model: 'probe', model_config: {}, user_text: QUERY, status: 'running', budget: BudgetSchema.parse({}) })
    // Only the dependencies webSearch needs. Any newly introduced access fails closed rather than
    // silently constructing app/workspace/process services or reaching the person's configuration.
    const values = { conn, store, session, run_id: run.id, gate: new ActionGate(conn), work_order: null,
      tool_calls: 0, cancel_signal: AbortSignal.timeout(30_000), emit: () => {} }
    const deps = new Proxy(values, { get(target, key) {
      if (!(key in target)) throw new Error('Unexpected probe dependency')
      return Reflect.get(target, key)
    } }) as unknown as AgentDeps
    const result = await webSearch({ deps, tool_name: 'web_search', tool_call_id: 'probe-search', retry: 0, messages: [] },
      { query: QUERY, max_results: 3 }, { ...injected, maxAttempts: 1 })
    const rows = Array.isArray(result.results) ? result.results : []
    // Strip query/fragment/userinfo and allow only official documentation URLs in diagnostic output.
    const urls = rows.flatMap((row) => {
      try { const url = new URL(String(row.url)); return url.protocol === 'https:' && url.hostname === 'api-docs.deepseek.com'
        && !url.username && !url.password ? [`${url.origin}${url.pathname}`] : [] } catch { return [] }
    })
    const statuses = new Set(['ok', 'no_results', 'error', 'cancelled', 'refused_by_policy', 'refused_by_work_order'])
    const status = statuses.has(String(result.status)) ? String(result.status) : 'error'
    const usage = result.usage as Record<string, unknown> | undefined
    const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
    const attempts = Array.isArray(result.attempts) ? result.attempts : []
    return { live, engine: 'deepseek', status, result_count: rows.length, urls,
      http_statuses: attempts.map((a) => number(a.http_status)),
      usage: usage ? { successful_requests: number(usage.successful_requests), estimated_cost_usd: number(usage.estimated_cost_usd), estimated_cost_cny: number(usage.estimated_cost_cny) } : null,
      ok: live ? status === 'ok' || status === 'no_results' : status === 'refused_by_policy' }
  } finally { conn.close(); rmSync(root, { recursive: true, force: true }) }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv.length > 1 || argv.some((v) => v !== '--live' && v !== '--dry-run')) throw new Error('Use --dry-run or --live')
  const result = await runSearchProbe(argv[0] === '--live')
  console.log(JSON.stringify(result))
  return result.ok ? 0 : 1
}
if (import.meta.main) main().then((code) => { process.exitCode = code }).catch(() => {
  console.error(JSON.stringify({ ok: false, stage: 'search_probe', category: 'local_or_protocol' })); process.exitCode = 1
})
