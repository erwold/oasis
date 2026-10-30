/** The live link's page: the app's own thread (ThreadTranscript.tsx, the same blocks as the offline copy's page) drawn
 *  from the latest whole state the link's stream sent — read-only: the share's presentation leaves out every control
 *  that would act (stop, cancel, send, approve, put back, copy …); only folds, pictures opened in place and the palette
 *  stay. The header says where the link stands: connecting, live, reconnecting, paused, or ended (and why). Once ended,
 *  nothing of the session is shown any more. */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react'
import { liveSessionAsV1, type LiveStateFrameV2 } from '@oasis-code/contract'
import { ThreadPresentationContext } from '../../../components/ThreadPresentation'
import { cleanTitle } from '../../../state/shareHtml'
import { shareViewOf, type ShareBlock } from '../../viewModel'
import { Block, Palette, usePalette, type Choice } from '../../viewer/ShareApp'
import { isTaskFrame, type LiveEnd, type LiveEndedReason, type LivePicture, type LiveStore, type LiveView } from '../liveState'
import { runFaces } from '../../team'
import { SessionList, useKeptScroll } from '../../viewer/SessionList'
import { TeamCard } from '../../viewer/TeamCard'
import { LIVE_BOT_STILLS, liveFaces, SHARE_BOT_STILLS } from './faces'

const ENDED: Record<LiveEnd | 'no_capability', string> = {
  revoked: 'Link revoked',
  expired: 'Link expired',
  session_deleted: 'Session deleted',
  unauthorized: 'Link not recognized',
  unreadable: 'Reload to view',
  refused: 'Link unavailable',
  disabled: 'Sharing is off',
  server_closing: 'App stopped',
  busy: 'Busy',
  no_capability: 'Link incomplete',
}
const ENDED_LINE: Record<LiveEnd | 'no_capability', string> = {
  revoked: 'The person who shared this session revoked the link.',
  expired: 'This link has expired.',
  session_deleted: 'The shared session was deleted.',
  unauthorized: 'This link is not known here. Check that it was copied whole.',
  unreadable: 'This page cannot read what the server sent. Reload the page.',
  refused: 'The server does not offer this link.',
  disabled: '',
  server_closing: '',
  busy: '',
  no_capability: 'The link is missing its key (the part after #). Copy the whole link again.',
}
const PAUSED_LINE: Record<LiveEndedReason, string> = {
  disabled: 'Sharing is turned off for now. This page reconnects when it is back.',
  server_closing: 'The app stopped. This page reconnects when it is back.',
  busy: 'The app is sharing too much at once. This page reconnects when it can.',
  revoked: '', expired: '', session_deleted: '',
}

const ACTIVE = new Set(['queued', 'running'])
const EMPTY_PICTURES = new Map()

function status(v: LiveView): { kind: string; label: string; reason: string | null } {
  if (v.ended) return { kind: 'ended', label: ENDED[v.ended], reason: v.ended }
  if (v.paused) return { kind: 'paused', label: ENDED[v.paused], reason: v.paused }
  if (v.phase === 'connected') return { kind: 'connected', label: v.frame && working(v.frame) ? 'Live · working' : 'Live', reason: null }
  if (v.phase === 'reconnecting') return { kind: 'reconnecting', label: 'Reconnecting…', reason: null }
  return { kind: 'connecting', label: 'Connecting…', reason: null }
}

/** a v2 page's bot pictures: the stills its script carries, nothing else */
const liveStill = (bot: string): string | null => SHARE_BOT_STILLS[bot] ?? null

const working = (f: NonNullable<LiveView['frame']>): boolean => (isTaskFrame(f) ? f.snapshot.sessions.some((s) => s.active) : f.snapshot.session.active)

const pictureOf = (pictures: ReadonlyMap<string, LivePicture>) => (resource: string) => { const p = pictures.get(resource); return p?.kind === 'shown' ? { src: p.src, width: p.width, height: p.height } : null }
const pictureMissingOf = (pictures: ReadonlyMap<string, LivePicture>) => (resource: string) => { const p = pictures.get(resource); return p?.kind === 'loading' ? 'loading…' : p?.kind === 'failed' ? p.why : 'not available' }

/** The page's thread from the store (the entry starts it and stops it with the page, outside React's effects): a v2
 *  link's (one session or a task's, each with its Agent Teams card), or a v1 link's as it always was. */
export function LiveShareApp({ store }: { store: LiveStore }) {
  const v = useSyncExternalStore(store.subscribe, store.get)
  const [choice, setChoice] = useState<Choice>('system')
  usePalette(choice)
  if (v.frame && isTaskFrame(v.frame)) return <LiveTask store={store} v={v} frame={v.frame} choice={choice} setChoice={setChoice} />
  return <LiveSession v={v} choice={choice} setChoice={setChoice} />
}

/** A v2 link's page: the task's sessions as the rail lists them (when there are several), the one shown drawn from its
 *  own part of the state — its pictures (the store loads that session's only), its faces and its card, the backend's
 *  bots — and its place in its thread kept while another is shown (forgotten with a new epoch). */
function LiveTask({ store, v, frame, choice, setChoice }: { store: LiveStore; v: LiveView; frame: LiveStateFrameV2; choice: Choice; setChoice: (c: Choice) => void }) {
  const key = v.selected ?? frame.snapshot.current
  const session = frame.snapshot.sessions.find((s) => s.key === key) ?? frame.snapshot.sessions[0]!
  const pictures = v.pictures
  const view = useMemo(() => {
    const part = liveSessionAsV1(frame.snapshot, session.key)!
    return shareViewOf({ snapshot: part, live: true, picture: pictureOf(pictures), pictureMissing: pictureMissingOf(pictures), faces: runFaces(session.runs), bots: SHARE_BOT_STILLS })
  }, [frame, session, pictures])
  const title = cleanTitle(session.title)
  useEffect(() => { document.title = `${title} · live` }, [title])
  const scroll = useRef<HTMLDivElement>(null)
  useKeptScroll(scroll, session.key, frame.epoch)
  // the rail and the card stand outside the thread's presentation: each is given the stills the page carries, and the
  // whole page is under the presentation too — no bot of a v2 page is ever an animation or a path of the app
  return <ThreadPresentationContext.Provider value={view.presentation}><LiveShell title={title} status={status(v)} expiresAt={frame.expires_at} choice={choice} setChoice={setChoice} scrollRef={scroll} scrollKey={`thread:${frame.epoch}:${session.key}`}
                    rail={frame.snapshot.sessions.length > 1 ? <SessionList sessions={frame.snapshot.sessions} selected={session.key} onSelect={(k) => store.select(k)} botStill={liveStill} /> : null}
                    desk={<TeamCard key={`team:${frame.epoch}:${session.key}`} team={session.team} title={title} botStill={liveStill} />}
                    body={<Thread blocks={view.blocks} presentation={view.presentation} truncated={session.stats.items_truncated} />} /></ThreadPresentationContext.Provider>
}

function LiveSession({ v, choice, setChoice }: { v: LiveView; choice: Choice; setChoice: (c: Choice) => void }) {
  const frame = v.frame && !isTaskFrame(v.frame) ? v.frame : null
  const pictures = frame ? v.pictures : EMPTY_PICTURES
  const faces = useMemo(() => (frame ? liveFaces(frame.snapshot.runs) : {}), [frame])
  const view = useMemo(() => (frame ? shareViewOf({
    snapshot: frame.snapshot,
    live: true,
    picture: pictureOf(pictures),
    pictureMissing: pictureMissingOf(pictures),
    faces,
    bots: LIVE_BOT_STILLS,
  }) : null), [frame, pictures, faces])
  const title = frame ? cleanTitle(frame.snapshot.title) : 'Shared session'
  useEffect(() => { document.title = `${title} · live` }, [title])
  const s = status(v)
  return <LiveShell title={title} status={s} expiresAt={frame?.expires_at ?? null} choice={choice} setChoice={setChoice}
                    body={view ? <Thread blocks={view.blocks} presentation={view.presentation} truncated={frame!.snapshot.stats.items_truncated} />
                      : <Waiting line={v.ended ? ENDED_LINE[v.ended] : v.paused ? PAUSED_LINE[v.paused] : 'Waiting for the session…'} kind={s.kind} />} />
}

/** The page for a link without its capability: nothing is asked of the server. */
export function LiveNoCapability() {
  const [choice, setChoice] = useState<Choice>('system')
  usePalette(choice)
  return <LiveShell title="Shared session" status={{ kind: 'ended', label: ENDED.no_capability, reason: 'no_capability' }} expiresAt={null} choice={choice} setChoice={setChoice}
                    body={<Waiting line={ENDED_LINE.no_capability} kind="ended" />} />
}

function LiveShell({ title, status: s, expiresAt, choice, setChoice, body, rail, desk, scrollRef, scrollKey }: {
  title: string; status: { kind: string; label: string; reason: string | null }; expiresAt: string | null; choice: Choice; setChoice: (c: Choice) => void; body: ReactNode
  /** a v2 link's: the task's sessions, the shown one's Agent Teams card, its thread's scroller and the key it is kept by */
  rail?: ReactNode; desk?: ReactNode; scrollRef?: RefObject<HTMLDivElement | null>; scrollKey?: string
}) {
  const until = expiresAt && Number.isFinite(Date.parse(expiresAt)) ? `Link valid until ${new Date(expiresAt).toLocaleString()}` : undefined
  const main = (
    <main className="thread desk-main" data-testid="live-thread">
      <header className="thread-header">
        <span className="thread-title" title={title} data-testid="live-title">{title}</span>
        <span className={`run-state live-status is-${s.kind}${s.kind === 'connected' ? ' live' : ''}`} role="status" title={until}
              data-testid="live-status" data-status={s.kind} data-reason={s.reason ?? undefined}>
          <span className="run-dot" />{s.label}
        </span>
        <span className="share-readonly dim small">read-only</span>
        <span className="thread-spacer" />
        <Palette choice={choice} setChoice={setChoice} />
      </header>
      <div key={scrollKey} className="thread-scroll" data-testid="thread" ref={scrollRef}>{body}</div>
      {desk}
    </main>
  )
  return (
    <div className="app-shell share-shell live-shell" data-testid="live-viewer" data-phase={s.kind} data-ended-reason={s.kind === 'ended' || s.kind === 'paused' ? s.reason ?? undefined : undefined}>
      {desk !== undefined ? <div className="workspace desk">{rail}{main}</div> : main}
    </div>
  )
}

function Thread({ blocks, presentation, truncated }: { blocks: ShareBlock[]; presentation: ReturnType<typeof shareViewOf>['presentation']; truncated: boolean }) {
  const last = blocks.length - 1
  return (
    <ThreadPresentationContext.Provider value={presentation}>
      {blocks.map((block, i) => <Block key={block.key} block={block} latest={i === last} live={block.kind === 'run' && ACTIVE.has(block.run.status)} />)}
      {blocks.length === 0 && <div className="thread-empty" data-testid="live-empty">Nothing to show yet.</div>}
      {truncated && <div className="dim small live-truncated" data-testid="live-truncated">Later entries are not shown: the shared view reached its size limit.</div>}
      <p className="dim small live-note">Live, read-only view made by oasis-code. Redaction is automatic and best-effort.</p>
    </ThreadPresentationContext.Provider>
  )
}

function Waiting({ line, kind }: { line: string; kind: string }) {
  return <div className="thread-empty live-waiting" data-testid={kind === 'ended' ? 'live-ended' : kind === 'paused' ? 'live-paused' : 'live-waiting'}>{line}</div>
}
