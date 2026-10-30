import { useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api } from '../api/client'
import { callView, commandAccessLabel, commandAccessTitle, type CallView } from '../state/callView'
import { patchOf, viewLines } from '../state/diffs'
import type { ThreadEntry } from '../state/thread'
import { RunScope } from './Media'
import { useSharePresentation, type ShareToolView } from './ThreadPresentation'

type Call = { tool: string; args: unknown; result: unknown; cut: boolean }

/** A call's whole return, asked once per call (a finished call never changes). */
const calls = new Map<string, Promise<Call>>()
function useCall(runId: string, callId: string): { call: Call | null; error: string | null } {
  const [value, setValue] = useState<{ call: Call | null; error: string | null }>({ call: null, error: null })
  useEffect(() => {
    let alive = true
    const key = `${runId}/${callId}`
    let pending = calls.get(key)
    if (!pending) {
      pending = api.toolCall(runId, callId)
      calls.set(key, pending)
      pending.catch(() => calls.delete(key))
    }
    pending.then((call) => { if (alive) setValue({ call, error: null }) }, (e: unknown) => { if (alive) setValue({ call: null, error: e instanceof Error ? e.message : String(e) }) })
    return () => { alive = false }
  }, [runId, callId])
  return value
}

/** An opened tool row: what the call handed its model, shown as what it is — the lines of a file, a folder's entries,
 *  a change, a command's output, a search's results, a page's text — and its JSON a click away. A row of no run
 *  (or a call still running) shows the row's own JSON. */
export function CallDetail({ entry }: { entry: ThreadEntry }) {
  const scope = useContext(RunScope)
  // the share's copy never asks for a call: what the snapshot carried of it, said as what it is
  const shared = useSharePresentation()
  if (shared) return <SharedCallDetail view={entry.toolCallId ? shared.tool(entry.toolCallId) : null} />
  const own = <pre className="activity-detail">{JSON.stringify({ args: entry.args, result: entry.result }, null, 1).slice(0, 6000)}</pre>
  if (!scope || !entry.toolCallId || entry.running) return own
  return <CallBody runId={scope.runId} callId={entry.toolCallId} fallback={own} />
}

function CallBody({ runId, callId, fallback }: { runId: string; callId: string; fallback: ReactNode }) {
  const { call, error } = useCall(runId, callId)
  const [raw, setRaw] = useState(false)
  const view = useMemo(() => (call ? callView(call.tool, call.args, call.result) : null), [call])
  if (error) return fallback
  if (!call || !view) return <div className="tool-detail"><p className="dim small">Reading the call…</p></div>
  const json = <pre className="activity-detail">{JSON.stringify({ args: call.args, result: call.result }, null, 1)}</pre>
  return (
    <div className="tool-detail" data-testid="call-detail" data-view={view.kind}>
      {view.kind === 'raw' || raw ? json : <CallView view={view} />}
      <div className="td-foot">
        {call.cut && <span className="dim small">long output cut here; the run has it whole</span>}
        <span className="spacer" />
        {view.kind !== 'raw' && <button className="td-raw" onClick={() => setRaw(!raw)} data-testid="call-raw">{raw ? 'Formatted' : 'Raw'}</button>}
      </div>
    </div>
  )
}

/** A call in the share's copy, in the tool detail's own markup: its content withheld (a sensitive source), or the
 *  allowlisted summary and fields and a cut preview of what it printed — said to be a preview: the export carries no
 *  complete output, and there is no raw form to switch to — or that the export was made without tool details. */
function SharedCallDetail({ view }: { view: ShareToolView | null }) {
  const details = view?.details ?? null
  return (
    <div className="tool-detail" data-testid="call-detail" data-view="share">
      {view?.withheld ? <p className="dim small" data-testid="call-withheld">Content withheld: a sensitive source (an environment, a credential file); nothing of it is in this export.</p>
        : !details ? <p className="dim small" data-testid="call-no-details">{view?.detailsIncluded ? 'The record kept nothing more of this call.' : 'Tool details were not included in this export.'}</p>
        : <SharedDetails details={details} />}
    </div>
  )
}

/** The allowlisted details the share carries of a call or of an action's command (its summary, its measured fields,
 *  a cut preview of what it printed — said to be a preview), in the tool detail's own markup. */
export function SharedDetails({ details }: { details: NonNullable<ShareToolView['details']> }) {
  return (
    <>
      {details.summary && <p className="small" data-testid="call-summary">{details.summary}</p>}
      {(details.preview !== null || details.fields.length > 0) && (
        <div className="td-term">
          {details.preview !== null && <pre className="td-term-out" data-testid="call-preview">{details.preview}</pre>}
          {details.fields.length > 0 && <div className="td-term-meta" data-testid="call-fields">{details.fields.map((f, i) => <span key={i}>{i > 0 ? ' · ' : ''}{f.name} {String(f.value)}</span>)}</div>}
        </div>
      )}
      {details.preview !== null && (
        <div className="td-foot">
          <span className="dim small" data-testid="call-preview-note">{details.preview_truncated ? 'preview, cut here — this export carries no complete output' : 'preview — this export carries no complete output'}</span>
          <span className="spacer" />
        </div>
      )}
    </>
  )
}

function CallView({ view }: { view: Exclude<CallView, { kind: 'raw' }> }) {
  switch (view.kind) {
    case 'file': return (
      <div className="code-card td-code">
        <div className="code-head"><span className="code-path" title={view.path}>{view.path}</span>
          <span className="dim small">lines {view.from}–{view.to}{view.total !== null ? ` of ${view.total}` : ''}</span></div>
        <div className="code-body"><div className="code-lines">
          {view.lines.map((l) => <div key={l.no} className="cv-line ctx"><span className="cv-no">{l.no}</span><span className="cv-text">{l.text || ' '}</span></div>)}
        </div></div>
      </div>
    )
    case 'directory': return (
      <div className="code-card td-code">
        <div className="code-head"><span className="code-path">{view.path}</span><span className="dim small">{view.files.length} entr{view.files.length === 1 ? 'y' : 'ies'}{view.truncated ? ', more not shown' : ''}</span></div>
        <div className="code-body td-list">{view.files.map((f) => <div key={f} className="td-list-row">{f}</div>)}</div>
      </div>
    )
    case 'change': return <ChangeView path={view.path} diff={view.diff} />
    case 'command': return (
      <div className="td-term">
        <div className="td-term-cmd"><span className="td-term-prompt">$</span>{view.command}</div>
        {view.stdout && <pre className="td-term-out">{view.stdout}</pre>}
        {view.stderr && <pre className="td-term-out err">{view.stderr}</pre>}
        <div className="td-term-meta">{view.status}{view.exit !== null ? ` · exit ${view.exit}` : ''}{view.durationMs !== null ? ` · ${view.durationMs} ms` : ''}{!view.stdout && !view.stderr ? ' · no output' : ''}
          {view.access && commandAccessLabel(view.access) && <span className="td-term-access" data-testid="call-command-access" title={commandAccessTitle(view.access)}> · {commandAccessLabel(view.access)}</span>}</div>
      </div>
    )
    case 'results': return (
      <div className="td-results">
        {view.items.length === 0 && <p className="dim small">No results.</p>}
        {view.items.map((r, i) => (
          <a key={i} className="td-result" href={r.url} target="_blank" rel="noreferrer">
            <span className="td-result-title">{r.title || r.url}</span>
            <span className="td-result-url">{r.url}</span>
            {r.snippet && <span className="td-result-snippet">{r.snippet}</span>}
          </a>
        ))}
      </div>
    )
    case 'page': return (
      <div className="code-card td-code">
        <div className="code-head"><a className="code-path" href={view.url} target="_blank" rel="noreferrer">{view.url}</a></div>
        <pre className="code-body td-page">{view.text}</pre>
      </div>
    )
  }
}

function ChangeView({ path, diff }: { path: string; diff: string }) {
  const lines = useMemo(() => viewLines(patchOf(diff)), [diff])
  return (
    <div className="code-card td-code">
      <div className="code-head"><span className="code-path" title={path}>{path}</span></div>
      <div className="code-body"><div className="code-lines">
        {lines.map((l, i) => l.kind === 'fold'
          ? <div key={i} className="cv-fold">{l.count} unchanged lines</div>
          : <div key={i} className={`cv-line ${l.tone}`}>
              <span className="cv-no">{l.newNo ?? l.oldNo ?? ''}</span>
              <span className="cv-sign">{l.tone === 'add' ? '+' : l.tone === 'del' ? '−' : ''}</span>
              <span className="cv-text">{l.text || ' '}</span>
            </div>)}
      </div></div>
    </div>
  )
}
