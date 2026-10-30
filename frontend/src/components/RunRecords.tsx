import { useEffect, useState } from 'react'
import { api } from '../api/client'
import type { Run, RunDetailResponse } from '../api/types'
import { thinkingRecord } from '../state/accounts'
import { costText, formatTokens, reportedTokens, uncountedNote, uncountedRequests } from '../state/thread'

/** One run's records: its model identity (configured vs reported), the budget, the receipt the harness measured,
 *  every provider request, the manifest. Oasis has no such page; it stays as the thread footer's records and a
 *  card's tab. */
/** `dataSource`: where the run's detail is read (the API by default; a desk card hands its own) — kept stable. */
export function RunRecords({ run, onBack, dataSource = api }: { run: Run; onBack?: () => void; dataSource?: Pick<typeof api, 'run'> }) {
  const [detail, setDetail] = useState<RunDetailResponse | null>(null)
  const [manifestOpen, setManifestOpen] = useState(false)
  useEffect(() => {
    let alive = true
    void dataSource.run(run.id).then((d) => { if (alive) setDetail(d) }, () => { if (alive) setDetail(null) })
    return () => { alive = false }
  }, [run.id, run.status, dataSource])
  const receipt = detail && 'mechanical' in detail.receipt ? detail.receipt : null
  const snap = (detail?.model_config_snapshot ?? {}) as Record<string, unknown>
  const budget = Object.fromEntries(Object.entries(run.budget).filter(([, v]) => v != null))
  const uncounted = receipt ? uncountedRequests(receipt.mechanical.usage) : 0
  if (!detail) {
    return <div className="thread-scroll run-records" data-testid="run-detail" data-loading="true"><div className="rd-head">{onBack && <button className="thread-btn" onClick={onBack} data-testid="records-back">← thread</button>}<span className="rd-name">{run.id}</span></div><p className="dim">loading the run's records…</p></div>
  }
  return (
    <div className="thread-scroll run-records" data-testid="run-detail">
      <div className="rd-head">{onBack && <button className="thread-btn" onClick={onBack} data-testid="records-back">← thread</button>}<span className="rd-name">{run.id}</span><span className="pill">{run.status}</span></div>
      <dl className="kv">
        <dt>model</dt><dd>{run.model} · configured <code>{String(snap.model ?? 'unknown')}</code> at <code>{String(snap.endpoint ?? 'unknown')}</code>
          {receipt && receipt.mechanical.provider_models.length > 0 && <> · reported <code>{receipt.mechanical.provider_models.join(', ')}</code></>}
          {receipt && receipt.mechanical.provider_models.length === 0 && <> · reported <em>unknown</em></>}</dd>
        <dt>thinking</dt><dd>{thinkingRecord(snap.thinking == null ? null : String(snap.thinking), snap.thinking_sent === undefined ? undefined : snap.thinking_sent == null ? null : String(snap.thinking_sent), Array.isArray(snap.reasoning_efforts) ? snap.reasoning_efforts.map(String) : null)}</dd>
        <dt>budget</dt><dd>{Object.keys(budget).length ? JSON.stringify(budget) : 'none set'}{receipt?.mechanical.budget_reached ? ` · reached: ${receipt.mechanical.budget_reached}` : ''}{receipt?.mechanical.budget_exceeded ? ` · exceeded: ${receipt.mechanical.budget_exceeded}` : ''}</dd>
        {receipt && <>
          <dt>measured</dt><dd>{receipt.mechanical.requests} requests · {receipt.mechanical.tool_calls} tool calls · {receipt.mechanical.refused_calls} refused · {receipt.mechanical.gated_calls} gated · {receipt.mechanical.segments} segment(s)</dd>
          <dt>tokens</dt><dd>{receipt.mechanical.usage.input_tokens == null && receipt.mechanical.usage.output_tokens == null ? <em>not reported</em>
            : <>{formatTokens(Number(receipt.mechanical.usage.input_tokens ?? 0))} in ({formatTokens(Number(receipt.mechanical.usage.cache_read_tokens ?? 0))} cached) · {formatTokens(Number(receipt.mechanical.usage.output_tokens ?? 0))} out
              {uncounted > 0 && <> · <em>{uncountedNote(uncounted, receipt.mechanical.requests)}</em></>}</>}</dd>
          <dt>cost</dt><dd>{costText(receipt.mechanical, receipt.mechanical.cost_status, receipt.mechanical.cost_source, { uncounted, requests: receipt.mechanical.requests })}</dd>
          <dt>produced</dt><dd>{receipt.mechanical.checkpoints.length} checkpoint(s) {receipt.mechanical.checkpoints.join(', ')} · {receipt.mechanical.executions.length} execution(s) {receipt.mechanical.executions.map((x) => `${x.id} exit ${x.exit_code ?? '?'} (${x.status})`).join('; ')}</dd>
        </>}
        {run.error && <><dt>error</dt><dd className="err">{run.error}</dd></>}
      </dl>
      {detail && detail.requests.length > 0 && (
        <table className="table"><thead><tr><th>#</th><th>reported model</th><th>in</th><th>cached</th><th>out</th><th>ms</th><th>cost</th><th>status</th></tr></thead>
          <tbody>{detail.requests.map((r) => (
            <tr key={r.id}><td>{r.seq}</td><td>{r.provider_reported_model ?? <em>unknown</em>}</td>{tokenCells(reportedTokens(r))}<td>{r.latency_ms ?? '?'}</td><td>{costText(r, r.cost_status, r.cost_source, { uncounted: reportedTokens(r) === null ? 1 : 0, requests: 1 })}</td><td>{r.status}{r.error ? ` · ${r.error}` : ''}</td></tr>
          ))}</tbody></table>
      )}
      <button className="thread-btn" onClick={() => setManifestOpen((v) => !v)}>{manifestOpen ? 'Hide manifest' : 'Manifest'}</button>
      {manifestOpen && <pre className="detail">{JSON.stringify(detail?.manifest ?? {}, null, 1)}</pre>}
    </div>
  )
}

/** A request's in, cached and out cells: unknown where the provider reported no count. */
function tokenCells(tokens: { input: number; output: number; cached: number } | null) {
  if (tokens === null) return <><td><em>unknown</em></td><td><em>unknown</em></td><td><em>unknown</em></td></>
  return <><td>{tokens.input}</td><td>{tokens.cached}</td><td>{tokens.output}</td></>
}
