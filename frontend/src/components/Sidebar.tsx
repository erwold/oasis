import { resourceTarget } from '../api/ssh'
import { targetLabel } from '../state/ssh'
import { useSshTargets } from './SshTarget'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { SessionActivity } from '../api/types'
import { openSessionRunningIn } from './BotImage'
import { RAIL_BOTS_SHOWN, RailBots, RailSessionButton } from './RailBots'
import { activityRunning, sessionDot } from '../state/sessionDots'
import { AccountsPanel } from './AccountsPanel'
import { Brand } from './Brand'
import { CopyIcon, FolderOpenIcon, MoreIcon, PanelLeftIcon, PencilIcon, PinIcon, PlusIcon, TrashIcon } from './icons'
import { folderName, railView } from '../state/rail'
import { sessionBots } from '../state/outline'
import { useStore } from '../state/store'

/** The rail is the app's chrome (after oasis's worlds rail): its head carries the mark (and, in the desktop
 *  shell, the traffic lights and the drag strip), then one list — a new task, and every conversation so far, each
 *  a session under the folder it works in, newest first. It can be hidden while a session is open; the thread's
 *  header brings it back. Its right edge drags; the width is remembered per browser. */
export function Sidebar() {
  const sshHosts = useSshTargets()
  const projects = useStore((s) => s.projects)
  const session = useStore((s) => s.session)
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const sidebarWidth = useStore((s) => s.sidebarWidth)
  const setSidebarWidth = useStore((s) => s.setSidebarWidth)
  const toggleSidebar = useStore((s) => s.toggleSidebar)
  const openSession = useStore((s) => s.openSession)
  const closeSession = useStore((s) => s.closeSession)
  const setTarget = useStore((s) => s.setTarget)
  const showToast = useStore((s) => s.showToast)
  const shellRef = useRef<HTMLDivElement>(null)
  const visible = useDocumentVisible()
  useSeenWhileViewing(visible)
  const activity = useStore((s) => s.sessionActivity)
  const startResize = (ev: React.MouseEvent) => {
    ev.preventDefault()
    const left = shellRef.current?.getBoundingClientRect().left ?? 0
    const onMove = (e: MouseEvent) => setSidebarWidth(e.clientX - left)
    const onUp = () => window.removeEventListener('mousemove', onMove)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp, { once: true })
  }
  // the start screen always shows the rail (there is nothing to hide it for); inside a session it can be collapsed
  if (!sidebarOpen && session) return null
  const { pinned, groups } = railView(projects)
  // a project's bots' column is as wide as its tallest stack: its titles start at one place, none further than it must
  const stackOf = (ids: string[]) => Math.max(1, ...ids.map((id) => Math.min(RAIL_BOTS_SHOWN, sessionBots(id, activity?.[id]?.agents).length)))
  const open = (id: string) => { void openSession(id).catch((e) => showToast(e instanceof Error ? e.message : String(e))) }
  return (
    <div className="sidebar-shell" ref={shellRef} style={{ width: sidebarWidth }}>
      <aside className="sidebar" data-testid="rail">
        <div className="rail-head">
          <Brand />
          <span className="rail-spacer" />
          {session && (
            <button className="icon-btn" title="Hide the rail" onClick={toggleSidebar} data-testid="hide-rail"><PanelLeftIcon size={14} /></button>
          )}
        </div>
        <div className="rail-scroll">
          <button className={`nav-item${session ? '' : ' active'}`} onClick={closeSession} data-testid="new-task">
            <PlusIcon size={13} />
            New task
          </button>
          {pinned.length > 0 && <div className="rail-pinned" data-testid="rail-pinned" style={{ ['--rail-bots' as string]: stackOf(pinned.map((m) => m.session.id)) }}>
            {pinned.map(({ session: s, project }) => (
              <SessionRow key={s.id} id={s.id} title={s.title} on={session?.id === s.id} onOpen={() => open(s.id)}
                          activity={activity?.[s.id]} visible={visible} pinned
                          folder={{ name: project.name, path: project.source_path ?? project.name }} />
            ))}
          </div>}
          <div className="sidebar-section">Projects</div>
          {groups.length === 0 && <div className="sidebar-empty">Nothing yet. Say what should happen — pick a folder when it works on your files.</div>}
          {groups.map((group) => { const { project, tasks } = group; return (
            <div className="rail-project" key={project.id} style={{ ['--rail-bots' as string]: stackOf(tasks.flatMap((t) => [...(t.session ? [t.session.id] : []), ...t.members.map((m) => m.session.id)])) }}>
              <button className="nav-item rail-project-head" title={project.source_path ?? (project.config.no_folder === true ? 'tasks that need no folder: each session writes in a working folder of its own' : 'an empty project')}
                      onClick={() => { setTarget({ kind: 'project', target: resourceTarget(project), projectId: project.id, name: project.name, path: project.source_path }); closeSession() }}
                      data-testid={`project-${project.id}`}>
                <FolderOpenIcon size={13} />
                <span className="nav-label">{project.name}{resourceTarget(project).kind !== 'local' && <small className="ssh-rail-target"> · {targetLabel(resourceTarget(project), sshHosts)}</small>}</span>
                <span className="nav-meta">{tasks.reduce((n, t) => n + (t.session ? 1 : 0) + t.members.length, 0) || ''}</span>
              </button>
              {tasks.map(({ id, session: s, members }) => (
                <div key={id} className="rail-task" data-testid={members.length ? `rail-task-${id}` : undefined}>
                  {s && <SessionRow id={s.id} title={s.title} on={session?.id === s.id} onOpen={() => open(s.id)} activity={activity?.[s.id]} visible={visible} />}
                  {/* the task's other sessions, whichever folder they work in: under it, each with its folder */}
                  {members.map((m) => (
                    <SessionRow key={m.session.id} id={m.session.id} title={m.session.title} on={session?.id === m.session.id} onOpen={() => open(m.session.id)}
                                activity={activity?.[m.session.id]} visible={visible}
                                folder={m.project.id === project.id ? null : { name: m.project.source_path ? folderName(m.project.source_path) : m.project.name, path: m.project.source_path ?? m.project.name }} member />
                  ))}
                </div>
              ))}
            </div>
          ) })}
        </div>
        <AccountsPanel />
      </aside>
      <div className="sidebar-resizer" onMouseDown={startResize} title="Drag to resize the rail" />
    </div>
  )
}

function subscribeVisibility(onChange: () => void): () => void {
  document.addEventListener('visibilitychange', onChange)
  return () => document.removeEventListener('visibilitychange', onChange)
}
/** Whether the page is in view (a hidden window, a minimized app: not). */
function useDocumentVisible(): boolean {
  return useSyncExternalStore(subscribeVisibility, () => document.visibilityState !== 'hidden', () => true)
}

/** The open session in a visible window is seen as it goes: its ends as the summary the page holds counts them are
 *  marked seen when it is opened (a green dot clicked goes at once), when the summary counts one more while it is
 *  read, when the window comes back. Only what the page already holds: an end the summary has not counted yet when the
 *  person leaves is theirs to see (green). */
function useSeenWhileViewing(visible: boolean): void {
  const sessionId = useStore((s) => s.session?.id ?? null)
  const ended = useStore((s) => (sessionId ? s.sessionActivity?.[sessionId]?.ended ?? null : null))
  const ready = useStore((s) => s.railSeen.ready)
  const markSessionSeen = useStore((s) => s.markSessionSeen)
  useEffect(() => {
    if (sessionId && visible && ready) markSessionSeen(sessionId, ended)
  }, [sessionId, visible, ready, ended, markSessionSeen])
}

/** A conversation in the rail: a click opens it; its "…" (shown on hover) pins it, renames it in place or deletes it, the
 *  delete asked twice. At its end a small dot (state/sessionDots.ts): blue, breathing, while one of its agents runs;
 *  green once one ended (however it ended) since the person last looked; nothing else — no words beside it (its name is for a
 *  screen reader alone). */
function SessionRow({ id, title, on, onOpen, folder = null, member = false, pinned = false, activity, visible = true }: { id: string; title: string; on: boolean; onOpen: () => void; folder?: { name: string; path: string } | null; member?: boolean; pinned?: boolean; activity?: SessionActivity; visible?: boolean }) {
  // the open session reads its own records (null during a replay: its summary then); every other its summary
  const openRunning = useStore((s) => (on ? openSessionRunningIn(s) : null))
  const seen = useStore((s) => (s.railSeen.ready ? s.railSeen.marks[id] ?? null : undefined))
  const dot = sessionDot({ running: openRunning ?? activityRunning(activity), ended: seen === undefined ? null : activity?.ended, seen, viewing: on && visible })
  const renameSession = useStore((s) => s.renameSession)
  const deleteSession = useStore((s) => s.deleteSession)
  const pinSession = useStore((s) => s.pinSession)
  const showToast = useStore((s) => s.showToast)
  const bots = useMemo(() => sessionBots(id, activity?.agents), [id, activity?.agents])
  const [menu, setMenu] = useState<{ left: number; top: number } | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(title)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { if (editing) input.current?.select() }, [editing])
  const fail = (e: unknown) => showToast(e instanceof Error ? e.message : String(e))
  const close = () => { setMenu(null); setConfirming(false) }
  const commit = () => {
    setEditing(false)
    const next = draft.trim()
    if (next && next !== title) void renameSession(id, next).catch(fail)
  }
  if (editing) {
    return (
      <div className="nav-item rail-session editing">
        <RailBots bots={bots} />
        <input ref={input} className="rail-rename" value={draft} maxLength={200} aria-label="Session title" data-testid={`rename-${id}`}
               onChange={(e) => setDraft(e.target.value)} onBlur={commit}
               onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setDraft(title); setEditing(false) } }} />
      </div>
    )
  }
  return (
    <div className={`rail-session-row${menu ? ' menu-open' : ''}${member ? ' rail-member' : ''}`} data-member={member || undefined}
         onContextMenu={(e) => { e.preventDefault(); setConfirming(false); setMenu({ left: e.clientX, top: e.clientY }) }}>
      <RailSessionButton title={title} tooltip={folder ? `${title}\n${folder.path}` : title} bots={bots} on={on} onClick={onOpen} testId={`session-${id}`} dot={dot} dotTestId={`rail-dot-${id}`} />
      <button className="icon-btn rail-more" title="Session actions" aria-haspopup="menu" data-testid={`session-more-${id}`}
              onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu(menu ? null : { left: r.left, top: r.bottom + 4 }) }}>
        <MoreIcon size={14} />
      </button>
      {menu && <>
        <div className="picker-backdrop" onClick={close} />
        <div className="picker-popover rail-menu" role="menu" style={{ left: menu.left, top: menu.top }}>
          <button role="menuitem" className="picker-row" data-testid="session-pin" onClick={() => { close(); void pinSession(id, !pinned).catch(fail) }}>
            <PinIcon size={14} /><span className="picker-label">{pinned ? 'Unpin' : 'Pin'}</span>
          </button>
          <button role="menuitem" className="picker-row" data-testid="session-rename" onClick={() => { close(); setDraft(title); setEditing(true) }}>
            <PencilIcon size={14} /><span className="picker-label">Rename</span>
          </button>
          <button role="menuitem" className="picker-row" data-testid="session-copy-id" title={id}
                  onClick={() => { close(); void navigator.clipboard.writeText(id).then(() => showToast(`Copied ${id}`), () => showToast(`Could not copy: the ID is ${id}`)) }}>
            <CopyIcon size={14} /><span className="picker-label">Copy ID</span>
          </button>
          <div className="rail-menu-sep" role="separator" />
          <button role="menuitem" className={`picker-row danger${confirming ? ' confirming' : ''}`} data-testid="session-delete"
                  onClick={() => { if (!confirming) { setConfirming(true); return } close(); void deleteSession(id).catch(fail) }}>
            <TrashIcon size={14} /><span className="picker-label">{confirming ? 'Delete — click again' : 'Delete'}</span>
          </button>
        </div>
      </>}
    </div>
  )
}
