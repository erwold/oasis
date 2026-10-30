import { RemoteIdentity, SshPorts, useExecutionTarget } from './SshTarget'
import { allows, useSsh } from '../state/ssh'
import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api/client'
import type { Receipt } from '../api/types'
import { changeStarts, createdSvg, filePatches, viewLines, type ViewLine } from '../state/diffs'
import { useStore } from '../state/store'
import { receiptOf } from '../state/turns'
import { sourceMount } from '../state/workspacePolicy'
import { attributionOf } from '../state/attribution'
import { AttributionMark } from './AttributionMark'
import { Approvals } from './Approvals'
import { ChevronDownIcon, ChevronRightIcon, RefreshIcon } from './icons'
import { Permissions } from './Permissions'

/** The session's workspace: where it is, what waits for the person, and its changes — a chip per changed file and
 *  the picked file whole, its changes marked, as one run left it or as it stands now. */
export function WorkspaceBody() {
  const target = useExecutionTarget()
  const hosts = useSsh((s) => s.targets)
  const remote = target.kind !== 'local'
  const session = useStore((s) => s.session)
  const workspace = useStore((s) => s.workspace)
  const refresh = useStore((s) => s.refreshEvidence)
  const showToast = useStore((s) => s.showToast)
  if (!session?.workspace) return <p className="dim small">The session has no workspace.</p>
  const ws = session.workspace
  // the person's own folder, edited in place: no branch, no base — the file tools' writes, undoable
  const mount = sourceMount(workspace) ?? sourceMount(ws)
  const inPlace = ws.kind === 'direct' && !mount
  return (
    <div className="ws-body" data-testid="evidence">
      <div className="ev-workspace" title={ws.path}>
        {mount && <p className="dim small" data-testid="workspace-source">Source read-only: {mount.root ?? 'path not reported'} · output folder: {ws.path}. Outputs cannot be adopted back to the source.</p>}
        {remote ? <RemoteIdentity connection /> : inPlace
          ? <span className="dim small" data-testid="in-place">Editing in place · {ws.path}. The agent's file edits are kept and can be undone run by run; what its commands change is not.</span>
          : <span className="dim small">branch {ws.branch} · base {ws.base_commit.slice(0, 10)}</span>}
        <span className="spacer" />
        <button className="icon-btn" disabled={remote && !allows(target, 'direct_files', hosts)} title="Measure the workspace again" onClick={() => void refresh().catch((e) => showToast(e instanceof Error ? e.message : String(e)))} data-testid="workspace-refresh"><RefreshIcon size={13} /></button>
        {workspace && workspace.status.external_changes.length > 0 && <div className="warn small">Changed outside the harness (author unknown): {workspace.status.external_changes.join(', ')}</div>}
        {workspace?.status.unreachable && <div className="warn small" data-testid="unreachable">{workspace.status.unreachable}</div>}
      </div>
      <SshPorts />
      <Permissions />
      <Approvals />
      <Changes workspaceId={ws.id} inPlace={inPlace} />
    </div>
  )
}

type FileCount = { path: string; added: number | null; removed: number | null }

/** The changes: at a run (the files it changed, each as the run left it) or now (every file changed against the base,
 *  as it stands); a chip per file, the picked one whole below. */
function Changes({ workspaceId, inPlace }: { workspaceId: string; inPlace: boolean }) {
  const view = useStore((s) => s.changeView)
  const showChange = useStore((s) => s.showChange)
  const diff = useStore((s) => s.diff)
  const runs = useStore((s) => s.runs)
  const runId = view.run_id
  const run = runId ? runs.find((r) => r.id === runId) : undefined
  const receipt: Receipt | null = run ? receiptOf(run) : null
  const runCounts = useRunCounts(runId)
  // how far the run's changes are its own: partial or unavailable is said, and an unavailable run's empty list is
  // never "changed no file"
  const attribution = attributionOf(receipt)
  const runPaths = receipt?.produced?.files_changed ?? runCounts?.map((f) => f.path) ?? null
  const files: FileCount[] | null = runId
    ? runPaths?.map((p) => runCounts?.find((f) => f.path === p) ?? { path: p, added: null, removed: null }) ?? null
    : diff?.files ?? null
  const path = view.path && files?.some((f) => f.path === view.path) ? view.path : files?.[0]?.path ?? null
  const counts = files?.find((f) => f.path === path) ?? null
  // the file as it stands is read again whenever the workspace's diff is measured again (a tool's write, a run's end)
  const whole = useWholeFile(runId, workspaceId, path, runId ? null : diff)
  // unavailable: no count at all (its run diff is refused, its list is not the run's) — never "0 files"
  const summary = runId && attribution.kind === 'unavailable' ? "This run's changes cannot be told apart"
    : files === null ? '…'
    : runId ? `${files.length} file(s) this run changed, as it left them`
    : inPlace ? `${files.length} file(s) changed by the agent's file tools` : `${files.length} file(s) vs base ${diff?.base_commit.slice(0, 10) ?? ''}`
  return (
    <div className="changes" data-testid="changes">
      <div className="chg-head">
        {runId && (
          <div className="seg small">
            <button className="on" data-testid="scope-run" title="Each file as this run left it">At this run</button>
            <button onClick={() => showChange({ run_id: null, path })} data-testid="scope-now" title="Each file as it stands now">Now</button>
          </div>
        )}
        <span className="dim small chg-summary">{summary}</span>
        {runId && <AttributionMark view={attribution} />}
      </div>
      {!runId && diff && diff.review_flags.length > 0 && <div className="warn small chg-flags">review_required: {diff.review_flags.map((f) => `${f.kind} (${f.path})`).join('; ')}</div>}
      {files && files.length > 0 && (
        <div className="chg-files" data-testid="change-files">
          {files.map((f) => (
            <button key={f.path} type="button" className={`change-chip${f.path === path ? ' on' : ''}`} title={f.path} data-testid="change-file"
                    onClick={() => showChange({ run_id: runId, path: f.path })}>
              <span className="change-name">{f.path}</span>
              {f.added != null && <span className="change-delta add">+{f.added}</span>}
              {(f.removed ?? 0) > 0 && <span className="change-delta del">−{f.removed}</span>}
            </button>
          ))}
        </div>
      )}
      {files && files.length === 0 && !(runId && attribution.kind !== 'exact') && <p className="dim small chg-empty">{runId ? 'This run changed no file.' : inPlace ? "No file changed by the agent's file tools." : 'No changes against the base commit.'}</p>}
      {path && <CodeView key={`${runId ?? 'now'}:${path}`} path={path} counts={counts} whole={whole} />}
    </div>
  )
}

/** The files a run's measured patch holds, with their counts: asked once per run (it never changes). */
const runCountsCache = new Map<string, Promise<FileCount[] | null>>()
function useRunCounts(runId: string | null): FileCount[] | null {
  const [value, setValue] = useState<{ runId: string; files: FileCount[] | null } | null>(null)
  useEffect(() => {
    if (!runId) return
    let alive = true
    let pending = runCountsCache.get(runId)
    if (!pending) {
      pending = api.runDiff(runId).then((d) => d.files, () => { runCountsCache.delete(runId); return null })
      runCountsCache.set(runId, pending)
    }
    void pending.then((files) => { if (alive) setValue({ runId, files }) })
    return () => { alive = false }
  }, [runId])
  return value && value.runId === runId ? value.files : null
}

type Whole = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; patch: string }

/** One file whole around its changes: as the run left it, or as the workspace stands (asked again when `pulse` —
 *  the session's diff — changes). */
function useWholeFile(runId: string | null, workspaceId: string, path: string | null, pulse: unknown): Whole {
  const [value, setValue] = useState<{ key: string; whole: Whole } | null>(null)
  const key = `${runId ?? workspaceId}:${path ?? ''}`
  useEffect(() => {
    if (!path) return
    let alive = true
    const asked = runId ? api.runDiff(runId, { path, full: true }) : api.diff(workspaceId, { path, full: true })
    asked.then((d) => { if (alive) setValue({ key, whole: { state: 'ready', patch: d.patch } }) },
      (e: unknown) => { if (alive) setValue({ key, whole: { state: 'error', message: e instanceof Error ? e.message : String(e) } }) })
    return () => { alive = false }
  }, [key, runId, workspaceId, path, pulse])
  return value && value.key === key ? value.whole : { state: 'loading' }
}

const isChange = (l: ViewLine | undefined): boolean => l !== undefined && l.kind === 'line' && l.tone !== 'ctx'

/** A file whole, as an editor shows it: its line numbers, each added line and removed one marked in place, the
 *  change in view brought into sight; the arrows step from one change to the next. */
function CodeView({ path, counts, whole }: { path: string; counts: FileCount | null; whole: Whole }) {
  const patch = whole.state === 'ready' ? whole.patch : null
  const file = useMemo(() => (patch === null ? null : filePatches(patch).get(path) ?? null), [patch, path])
  const lines = useMemo(() => (file ? viewLines(file) : []), [file])
  const starts = useMemo(() => changeStarts(lines), [lines])
  const [at, setAt] = useState(0)
  const body = useRef<HTMLDivElement>(null)
  const rows = useRef<(HTMLDivElement | null)[]>([])
  useEffect(() => {
    const row = rows.current[starts[at] ?? -1]
    const box = body.current
    if (row && box) box.scrollTop = Math.max(0, row.offsetTop - box.clientHeight / 3)
  }, [at, starts])
  const svg = file ? createdSvg(path, file) : null
  const current = starts[at] ?? -1
  let currentEnd = current
  while (currentEnd >= 0 && isChange(lines[currentEnd])) currentEnd += 1
  return (
    <div className="code-card" data-testid="code-view">
      <div className="code-head">
        <span className="code-path" title={path}>{path}</span>
        {counts?.added != null && <span className="change-delta add">+{counts.added}</span>}
        {counts && (counts.removed ?? 0) > 0 && <span className="change-delta del">−{counts.removed}</span>}
        <span className="spacer" />
        {starts.length > 0 && <>
          <span className="dim small" data-testid="code-change-at">change {at + 1} of {starts.length}</span>
          <button className="icon-btn code-step up" disabled={at === 0} onClick={() => setAt(at - 1)} title="The change before" data-testid="code-prev"><ChevronDownIcon size={13} /></button>
          <button className="icon-btn code-step" disabled={at >= starts.length - 1} onClick={() => setAt(at + 1)} title="The next change" data-testid="code-next"><ChevronDownIcon size={13} /></button>
        </>}
      </div>
      <div className="code-body" ref={body}>
        {whole.state === 'loading' && <p className="dim small code-note">Reading the file…</p>}
        {whole.state === 'error' && <p className="err small code-note">{whole.message}</p>}
        {whole.state === 'ready' && !file && <p className="dim small code-note">No change to this file here.</p>}
        {file?.binary && <p className="dim small code-note">A binary file.</p>}
        {svg && <div className="code-img"><img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`} alt={path} /></div>}
        {file && !file.binary && !svg && (
          <div className="code-lines">
            {lines.map((l, i) => l.kind === 'fold'
              ? <div key={i} className="cv-fold"><ChevronRightIcon size={11} />{l.count} unchanged line{l.count === 1 ? '' : 's'}</div>
              : <div key={i} ref={(el) => { rows.current[i] = el }} className={`cv-line ${l.tone}${i >= current && i < currentEnd ? ' current' : ''}`}>
                  <span className="cv-no">{l.newNo ?? l.oldNo ?? ''}</span>
                  <span className="cv-sign">{l.tone === 'add' ? '+' : l.tone === 'del' ? '−' : ''}</span>
                  <span className="cv-text">{l.text || ' '}</span>
                </div>)}
          </div>
        )}
      </div>
    </div>
  )
}

export function Patch({ text, empty }: { text: string; empty?: string }) {
  if (!text) return <p className="dim small">{empty ?? 'No changes against the base commit.'}</p>
  return <pre className="patch" data-testid="patch">{text.split('\n').map((line, i) => (
    <div key={i} className={line.startsWith('+') && !line.startsWith('+++') ? 'ln add' : line.startsWith('-') && !line.startsWith('---') ? 'ln del' : line.startsWith('@@') ? 'ln hunk' : 'ln'}>{line}</div>
  ))}</pre>
}
