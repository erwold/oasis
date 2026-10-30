import { useCallback, useEffect, useRef, useState } from 'react'
import { resourceTarget } from '../api/ssh'
import { api } from '../api/client'
import type { DirListing } from '../api/types'
import { crumbsOf, folderName } from '../state/rail'
import { useStore } from '../state/store'
import { ChevronRightIcon, FolderOpenIcon, GitBranchIcon, XIcon } from './icons'

/** The folder dialog of a plain browser (the desktop shell shows the system's Open panel instead): the machine's
 *  folders as an Open panel lists them — the favourites down the left, the path as crumbs across the top, the
 *  subfolders of the folder in view (repositories marked), and Open for the folder in view. This machine's folders
 *  only: a folder on an SSH host is opened by an agent (open_ssh_session). */
export function FolderDialog({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (path: string) => void }) {
  const ticket = useRef(0)
  const dialog = useRef<HTMLDialogElement>(null)
  const projects = useStore((s) => s.projects)
  const [listing, setListing] = useState<DirListing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const go = useCallback(async (path?: string) => {
    const asked = ++ticket.current
    setLoading(true); setError(null); setListing(null)
    try {
      const next = await api.dirs(path)
      if (asked === ticket.current) setListing(next)
    } catch (e) { if (asked === ticket.current) setError(e instanceof Error ? e.message : String(e)) }
    finally { if (asked === ticket.current) setLoading(false) }
  }, [])
  useEffect(() => {
    const el = dialog.current
    if (!el) return
    if (open) { if (!el.open) el.showModal(); void go() }
    if (!open && el.open) el.close()
    return () => { ++ticket.current }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const canPick = !!listing && !loading && !error
  const crumbs = listing ? crumbsOf(listing.path) : []
  const recent = projects.filter((p) => p.source_path && resourceTarget(p).kind === 'local').slice(0, 6)
  return (
    <dialog ref={dialog} className="fs-dialog" aria-label="Choose a folder" data-testid="folder-dialog"
            onCancel={(e) => { e.preventDefault(); onClose() }} onClose={onClose}>
      <div className="fs-head">
        <span className="fs-crumbs" data-testid="fs-crumbs">
          {crumbs.map((c, i) => (
            <span key={c.path} className="fs-crumb-wrap">
              {i > 0 && <ChevronRightIcon size={11} />}
              <button className={`fs-crumb${i === crumbs.length - 1 ? ' current' : ''}`} onClick={() => void go(c.path)} data-testid={`fs-crumb-${c.name}`}>{c.name}</button>
            </span>
          ))}
        </span>
        <button className="icon-btn" title="Close" onClick={onClose}><XIcon size={13} /></button>
      </div>
      <div className="fs-body">
        <aside className="fs-side">
          <div className="fs-side-title">Favourites</div>
          {(listing?.favorites ?? []).map((f) => (
            <button key={f.path} className={`fs-side-row${listing?.path === f.path ? ' active' : ''}`} onClick={() => void go(f.path)} data-testid={`fs-fav-${f.label.replace(/\s+/g, '-').toLowerCase()}`}>
              <FolderOpenIcon size={13} />{f.label}
            </button>
          ))}
          {recent.length > 0 && <div className="fs-side-title">Recent</div>}
          {recent.map((p) => (
            <button key={p.id} className="fs-side-row" title={p.source_path!} onClick={() => void go(p.source_path!)}>
              <GitBranchIcon size={13} />{folderName(p.source_path!)}
            </button>
          ))}
        </aside>
        <div className="fs-list" data-testid="fs-list">
          {error && <p className="err small">{error}</p>}
          {listing && listing.entries.length === 0 && !error && <p className="dim small fs-empty">No folders inside.</p>}
          {listing?.entries.map((e) => (
            <button key={e.path} className="fs-row" onClick={() => void go(e.path)} onDoubleClick={() => onPick(e.path)} title={e.path} data-testid={`fs-dir-${e.name}`}>
              <FolderOpenIcon size={14} />
              <span className="fs-row-name">{e.name}</span>
              {e.repository && <span className="fs-tag">repository</span>}
              <ChevronRightIcon size={12} />
            </button>
          ))}
          {listing?.truncated && <p className="dim small">Only the first {listing.entries.length} folders are listed.</p>}
        </div>
      </div>
      <div className="fs-foot">
        <span className="fs-foot-path" title={listing?.path ?? ''}>{loading ? 'Reading…' : listing?.path ?? ''}</span>
        <span className="spacer" />
        <button className="thread-btn" onClick={onClose}>Cancel</button>
        <button className="thread-btn primary" disabled={!canPick} onClick={() => canPick && listing && onPick(listing.path)} data-testid="fs-open">
          Open {listing ? folderName(listing.path) : ''}
        </button>
      </div>
    </dialog>
  )
}
