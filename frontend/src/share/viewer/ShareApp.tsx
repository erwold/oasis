/** The session share's page: the app's own thread, drawn by the app's own components (ThreadTranscript.tsx) from the
 *  snapshot under the share's presentation — read-only, offline. The shell around it is the app's: the thread's
 *  header (its title; the palette, chosen here and kept nowhere) and its scrolling column; no rail, no composer, no
 *  desk, no live state. A closing note says what the export redacted and left out. */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { shareSessionAsV2 } from '@oasis-code/contract'
import { BotImage } from '../../components/BotImage'
import { SparklesIcon } from '../../components/icons'
import { ActionLine, DirectorGlyph, MemberWords, NoteTurn, RequestTurn, Row, RunTurn, SharedAttachment } from '../../components/ThreadTranscript'
import { SHARE_PICTURE_ROW, ThreadPresentationContext } from '../../components/ThreadPresentation'
import { RunScope } from '../../components/Media'
import { Prose } from '../../components/Prose'
import { CHATGPT_BOT } from '../../state/outline'
import { noteStateLine } from '../../state/interaction'
import { SHARE_THEMES, type ShareAnyDocument, type ShareDocument, type ShareTaskDocument, type ShareTheme } from '../document'
import { aboutLines, SHARE_SESSION, shareAction, shareView, shareViewOf, type ShareBlock, type ShareViewItem } from '../viewModel'
import { cleanTitle } from '../../state/shareHtml'
import { runFaces } from '../team'
import { SessionList, shownSession, useKeptScroll } from './SessionList'
import { TeamCard } from './TeamCard'

export type Choice = ShareTheme | 'system'
const CHOICES: { value: Choice; label: string }[] = [...SHARE_THEMES.map((t) => ({ value: t, label: t === 'claude' ? 'Claude' : t[0]!.toUpperCase() + t.slice(1) })), { value: 'system', label: 'System' }]

/** The palette on the root, as the app keeps it (`data-theme`); System follows the system while it is chosen. */
export function usePalette(choice: Choice): void {
  useEffect(() => {
    const root = document.documentElement
    if (choice !== 'system') { root.dataset.theme = choice; return }
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => { root.dataset.theme = query.matches ? 'dark' : 'light' }
    apply()
    query.addEventListener('change', apply)
    return () => query.removeEventListener('change', apply)
  }, [choice])
}

const STRAY_SCOPE = { sessionId: SHARE_SESSION, workspaceId: null, runId: '' }

/** Items the share could place in no turn (none of a known run, nor after an exchange or a group): each still shown,
 *  drawn as what it is — every kind of item the snapshot may hold has its row here (the switch is exhaustive: a kind
 *  added to the contract fails the build until it is drawn), never an empty row. */
function StrayItems({ items }: { items: ShareViewItem[] }) {
  return (
    <section className="turn-group" data-testid="share-stray">
      <RunScope.Provider value={STRAY_SCOPE}>
        {items.map((item) => <StrayItem key={item.key} item={item} />)}
      </RunScope.Provider>
    </section>
  )
}

function StrayItem({ item }: { item: ShareViewItem }) {
  switch (item.kind) {
    case 'message': return <div className="turn turn-agent"><span className="turn-who">{item.author_label}</span><div className="turn-text prose"><Prose text={item.text} /></div></div>
    case 'message_open': return <div className="turn turn-agent streaming"><span className="turn-who">{item.author_label}</span><div className="turn-text prose"><Prose text={item.text} /></div></div>
    case 'tool': return <Row entry={{ kind: 'activity', eventId: item.key, toolCallId: item.key, tool: item.name, status: item.status }} />
    case 'notice': return <Row entry={{ kind: 'note', eventId: item.key, eventName: item.code, text: item.text }} />
    // the picture itself (or why it is not carried), by its key
    case 'image': return <Row entry={{ kind: 'note', eventId: item.key, eventName: SHARE_PICTURE_ROW }} />
    case 'action': return <ActionLine action={shareAction(item)} />
    case 'group_note': return <MemberWords to={item.to ?? 'everyone'} text={item.text} status={item.status} state={noteStateLine(item.status, item.delivered_to)} />
    // a director exchange and a group always open a block of their own (viewModel.ts); drawn here too, should one stray
    case 'director_note': return <div className="turn turn-agent"><span className="turn-who">{item.source_label}</span><div className="turn-text prose"><Prose text={[item.question, item.answer ?? ''].filter(Boolean).join('\n\n')} /></div></div>
    case 'group': return <div className="turn turn-user"><span className="turn-who director">{item.author_label}</span><div className="turn-text"><Prose text={item.text} /></div></div>
    default: return unreachable(item)
  }
}

const unreachable = (x: never): never => { throw new Error(`share: an item of no known kind ${JSON.stringify(x).slice(0, 80)}`) }

/** One block of the thread; `live`: whether its run is still at work (the live link's page only — the offline copy is
 *  of a quiescent session, every run ended). */
export function Block({ block, latest, live = false }: { block: ShareBlock; latest: boolean; live?: boolean }) {
  switch (block.kind) {
    case 'run': return <RunTurn run={block.run} entries={block.entries} live={live} latest={latest} />
    case 'note': return <NoteTurn note={block.note} latest={latest} />
    case 'group': {
      const g = block.item
      const from: ReactNode = g.author === 'connector' ? <>{g.client === 'ChatGPT' ? <BotImage bot={CHATGPT_BOT} className="turn-bot" /> : <SparklesIcon size={12} />}{g.client ?? g.author_label} </>
        : g.author === 'director' ? <><DirectorGlyph />director </> : null
      return <RequestTurn testId={`group-${g.group}`} head={<>{from}→ {block.to}</>} text={g.text} state={`${g.group_kind} · ${g.status_label}`}
                          images={block.pictures.map((key) => <SharedAttachment key={key} pictureKey={key} />)} />
    }
    case 'action': return <ActionLine action={block.action} />
    case 'group_note': return <MemberWords to={block.to} text={block.text} status={block.status} state={block.state} />
    case 'stray': return <StrayItems items={block.items} />
    default: return unreachable(block)
  }
}

/** The palette buttons: chosen here, kept nowhere. */
export function Palette({ choice, setChoice }: { choice: Choice; setChoice: (c: Choice) => void }) {
  return (
    <span className="share-theme" role="group" aria-label="Palette">
      {CHOICES.map((c) => (
        <button key={c.value} type="button" className={`thread-btn${choice === c.value ? ' active' : ''}`} aria-pressed={choice === c.value}
                onClick={() => setChoice(c.value)} data-testid={`share-theme-${c.value}`}>{c.label}</button>
      ))}
    </span>
  )
}

function About({ doc }: { doc: Parameters<typeof aboutLines>[0] }) {
  const { redacted, omitted, shortened } = aboutLines(doc)
  const list = (title: string, lines: string[]) => (lines.length ? <><b>{title}</b><ul>{lines.map((l) => <li key={l}>{l}</li>)}</ul></> : null)
  return (
    <details className="share-about" data-testid="share-about">
      <summary className="dim small">About this export · a read-only copy made by oasis-code</summary>
      <div className="small">
        <p>Redaction is automatic and best-effort: pictures are not checked, and unknown or encoded secrets may remain. A tool's output is a preview, never complete; thinking, prompts, usage and costs are not carried.</p>
        {list('Redacted', redacted)}{list('Left out', omitted)}{list('Shortened', shortened)}
      </div>
    </details>
  )
}

/** The page: a V3 share (one session or a task's, each with its Agent Teams card) or an older one (one session). */
export function ShareApp({ doc }: { doc: ShareAnyDocument }) {
  return doc.version === 3 ? <TaskShareApp doc={doc} /> : <SessionShareApp doc={doc} />
}

/** A V3 share: the sessions as the rail lists them (when there are several), the one chosen drawn as the app's thread
 *  under its own presentation — its pictures, its faces, its card, none of another session's — and its Agent Teams
 *  card in the desk's corner. Switching keeps each session's place in its thread. */
function TaskShareApp({ doc }: { doc: ShareTaskDocument }) {
  const snap = doc.snapshot
  const [chosen, setChosen] = useState<string | null>(null)
  const [choice, setChoice] = useState<Choice>(doc.theme)
  usePalette(choice)
  const key = shownSession(snap.sessions, chosen, snap.current)!
  const session = snap.sessions.find((s) => s.key === key)!
  const view = useMemo(() => {
    const pictures = doc.pictures[key] ?? {}
    return shareViewOf({ snapshot: shareSessionAsV2(snap, key)!, picture: (k) => pictures[k] ?? null, faces: runFaces(session.runs), bots: doc.bots })
  }, [doc, snap, key, session])
  const scroll = useRef<HTMLDivElement>(null)
  useKeptScroll(scroll, key)
  const title = cleanTitle(session.title)
  const last = view.blocks.length - 1
  return (
    <ThreadPresentationContext.Provider value={view.presentation}>
      <div className="app-shell share-shell">
        <div className="workspace desk">
          {snap.sessions.length > 1 && <SessionList sessions={snap.sessions} selected={key} onSelect={setChosen} botStill={view.presentation.botSrc} />}
          <main className="thread desk-main" data-testid="share-thread" data-session={key}>
            <header className="thread-header">
              <span className="thread-title" title={title}>{title}</span>
              <span className="run-state" data-testid="share-state">read-only copy</span>
              <span className="thread-spacer" />
              <Palette choice={choice} setChoice={setChoice} />
            </header>
            <div key={`thread:${key}`} className="thread-scroll" data-testid="thread" ref={scroll}>
              {view.blocks.map((block, i) => <Block key={block.key} block={block} latest={i === last} />)}
              {view.blocks.length === 0 && <div className="thread-empty">This session has nothing to show.</div>}
              <About doc={doc} />
            </div>
            <TeamCard key={`team:${key}`} team={session.team} title={title} botStill={view.presentation.botSrc} />
          </main>
        </div>
      </div>
    </ThreadPresentationContext.Provider>
  )
}

function SessionShareApp({ doc }: { doc: ShareDocument }) {
  const view = useMemo(() => shareView(doc), [doc])
  const [choice, setChoice] = useState<Choice>(doc.theme)
  usePalette(choice)
  const title = cleanTitle(doc.snapshot.title)
  const last = view.blocks.length - 1
  return (
    <ThreadPresentationContext.Provider value={view.presentation}>
      <div className="app-shell share-shell">
        <main className="thread desk-main" data-testid="share-thread">
          <header className="thread-header">
            <span className="thread-title" title={title}>{title}</span>
            <span className="run-state" data-testid="share-state">read-only copy</span>
            <span className="thread-spacer" />
            <Palette choice={choice} setChoice={setChoice} />
          </header>
          <div className="thread-scroll" data-testid="thread">
            {view.blocks.map((block, i) => <Block key={block.key} block={block} latest={i === last} />)}
            {view.blocks.length === 0 && <div className="thread-empty">This session has nothing to show.</div>}
            <About doc={doc} />
          </div>
        </main>
      </div>
    </ThreadPresentationContext.Provider>
  )
}
