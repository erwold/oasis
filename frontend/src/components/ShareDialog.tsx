import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api/client'
import { browserCodec } from '../state/shareImages'
import { fileSizeLabel, generateTaskShare, optionsKey, shareCounts, ShareBusyError, type BuiltShare, type ShareRunChoice } from '../state/share'
import { DownloadIcon, XIcon } from './icons'
import { currentTheme, shareAssets } from './shareExport'
import { ShareLivePanel } from './ShareLivePanel'

export type ShareMode = 'html' | 'live'

type Phase = { kind: 'loading' } | { kind: 'ready' } | { kind: 'busy'; reasons: string[] } | { kind: 'error'; message: string }

/** The session share's dialog, of two kinds the person picks at its top:
 *  - HTML: the options (tool details, images, runs left out), the file as it will download in a sandboxed preview
 *    (srcdoc = the built HTML, `allow-scripts` only: an opaque origin, no bridge, no app API), what was redacted and
 *    left out, the measured size, and Download — of exactly the bytes previewed. Changing an option regenerates; until
 *    the new file is built the old one is gone and Download is disabled. A newer generation, closing or another session
 *    aborts the one under way. A session at work cannot be exported: it says so, with Retry (the file is made only
 *    when HTML is first shown — a dialog opened on a live link asks nothing of the offline export).
 *  - Live link: ShareLivePanel.tsx (a working session can be shared).
 *  Closing the dialog revokes nothing. */
export function ShareDialog({ sessionId, initialMode = 'html', onClose, onOpenSettings }: { sessionId: string; initialMode?: ShareMode; onClose: () => void; onOpenSettings: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [mode, setMode] = useState<ShareMode>(initialMode)
  // the offline file is made once HTML is first shown, and kept while the other side is shown
  const [htmlWanted, setHtmlWanted] = useState(initialMode === 'html')
  const choose = (m: ShareMode) => { setMode(m); if (m === 'html') setHtmlWanted(true) }
  const [tools, setTools] = useState(false)
  const [images, setImages] = useState(false)
  const [excluded, setExcluded] = useState<string[]>([])
  // every session of the task (off by default): the run list is this session's alone, so it goes (and what it left out
  // with it — nothing stays left out that the dialog no longer shows)
  const [task, setTask] = useState(false)
  const chooseTask = (on: boolean) => { setTask(on); setExcluded([]) }
  const [runs, setRuns] = useState<ShareRunChoice[]>([])
  const [built, setBuilt] = useState<BuiltShare | null>(null)
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const options = useMemo(() => ({ tools, images, excluded, task }), [tools, images, excluded, task])
  const key = optionsKey(options)

  useEffect(() => {
    const el = dialog.current
    if (el && !el.open) el.showModal()
    return () => { if (el?.open) el.close() }
  }, [])

  useEffect(() => {
    if (!htmlWanted) return
    const controller = new AbortController()
    setBuilt(null)
    setPhase({ kind: 'loading' })
    generateTaskShare((body, signal) => api.shareSnapshotV3(sessionId, body, signal), options, browserCodec, controller.signal, currentTheme(), shareAssets).then((next) => {
      if (controller.signal.aborted) return
      setRuns(next.runs)
      setBuilt(next)
      setPhase({ kind: 'ready' })
    }, (e: unknown) => {
      if (controller.signal.aborted) return
      if (e instanceof ShareBusyError) setPhase({ kind: 'busy', reasons: e.reasons })
      else setPhase({ kind: 'error', message: e instanceof Error ? e.message : String(e) })
    })
    return () => controller.abort(new DOMException('superseded', 'AbortError'))
  }, [sessionId, key, attempt, htmlWanted]) // eslint-disable-line react-hooks/exhaustive-deps

  const current = built && built.key === key && phase.kind === 'ready' ? built : null
  const counts = current ? shareCounts(current) : null

  const download = () => {
    if (!current) return
    const url = URL.createObjectURL(new Blob([current.bytes as BlobPart], { type: 'text/html;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = current.fileName
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    a.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }

  const toggleRun = (id: string) => setExcluded((ex) => (ex.includes(id) ? ex.filter((x) => x !== id) : [...ex, id]))
  const included = runs.length - excluded.filter((id) => runs.some((r) => r.run_id === id)).length

  return (
    <dialog ref={dialog} className={`share-dialog is-${mode}`} aria-labelledby="share-title" data-testid="share-dialog" data-phase={phase.kind} data-mode={mode}
            onCancel={(e) => { e.preventDefault(); onClose() }}>
      <div className="share-head">
        <span id="share-title" className="share-title">Share</span>
        <span className="share-modes" role="group" aria-label="Share as">
          <button type="button" className={`thread-btn${mode === 'html' ? ' active' : ''}`} aria-pressed={mode === 'html'} onClick={() => choose('html')} data-testid="share-mode-html">HTML file</button>
          <button type="button" className={`thread-btn${mode === 'live' ? ' active' : ''}`} aria-pressed={mode === 'live'} onClick={() => choose('live')} data-testid="share-mode-live">Live link</button>
        </span>
        {mode === 'html' && <>
        <label className="share-opt" title="Tools' short results and a cut output preview, redacted">
          <input type="checkbox" checked={tools} onChange={(e) => setTools(e.target.checked)} data-testid="share-tools" /> Tool details
        </label>
        <label className="share-opt" title="The session's own pictures, re-encoded without metadata. What they show is not redacted.">
          <input type="checkbox" checked={images} onChange={(e) => setImages(e.target.checked)} data-testid="share-images" /> Images
          {images && <span className="share-cue" data-testid="share-images-cue">pixels not redacted</span>}
        </label>
        <label className="share-opt">
          <input type="checkbox" checked={task} onChange={(e) => chooseTask(e.target.checked)} data-testid="share-task" /> 包含这个任务下的所有会话
        </label>
        {!task && runs.length > 1 && (
          <details className="share-runs" data-testid="share-runs">
            <summary>Runs {included}/{runs.length}</summary>
            <div className="share-runs-list">
              {runs.map((r) => (
                <label key={r.run_id} className="share-run">
                  <input type="checkbox" checked={!excluded.includes(r.run_id)} onChange={() => toggleRun(r.run_id)} data-testid="share-run" />
                  <span className="share-run-label" title={r.label}>{r.label}</span><span className={`share-run-status ${r.status}`}>{r.status}</span>
                </label>
              ))}
            </div>
          </details>
        )}
        </>}
        <span className="thread-spacer" />
        <button type="button" className="icon-btn" aria-label="Close" title="Close" onClick={onClose} data-testid={mode === 'live' ? 'live-share-close' : 'share-close'}><XIcon size={13} /></button>
      </div>
      {mode === 'live' ? <div className="share-body share-live-body"><ShareLivePanel sessionId={sessionId} onOpenSettings={onOpenSettings} /></div> : <>
      <div className="share-body">
        {current ? (
          <iframe key={current.sha256} className="share-preview" title="Preview of the file to download" sandbox="allow-scripts" referrerPolicy="no-referrer"
                  srcDoc={current.html} data-testid="share-preview" />
        ) : (
          <div className="share-state" role="status" data-testid="share-state">
            {phase.kind === 'loading' ? 'Building…'
              : phase.kind === 'busy' ? <span title={phase.reasons.join('\n') || undefined} data-testid="share-busy">Work is under way. Export once the session is idle, or share a <button type="button" className="link-btn" onClick={() => choose('live')} data-testid="share-busy-live">live link</button>. <button type="button" className="thread-btn" onClick={() => setAttempt((n) => n + 1)} data-testid="share-retry">Retry</button></span>
              : phase.kind === 'error' ? <span data-testid="share-error">Couldn’t build the file: {phase.message} <button type="button" className="thread-btn" onClick={() => setAttempt((n) => n + 1)} data-testid="share-retry">Retry</button></span>
              : null}
          </div>
        )}
      </div>
      <div className="share-foot">
        {current && counts ? (
          <span className="share-facts" title={counts.lines.join('\n') || 'Nothing redacted or left out'} data-testid="share-counts"
                data-redacted={counts.redacted} data-omitted={counts.omitted}>
            {counts.redacted} redacted · {counts.omitted} left out{current.images ? ` · ${current.images} image${current.images > 1 ? 's' : ''}` : ''}
          </span>
        ) : <span className="share-facts" />}
        <span className="thread-spacer" />
        {current && <span className="share-size" data-testid="share-size" data-bytes={current.bytes.byteLength} data-sha256={current.sha256} title={`${current.fileName}\nSHA-256 ${current.sha256}`}>{fileSizeLabel(current.bytes.byteLength)}</span>}
        <button type="button" className="thread-btn primary" disabled={!current} onClick={download} data-testid="share-download"><DownloadIcon size={12} /> Download</button>
      </div>
      </>}
    </dialog>
  )
}
