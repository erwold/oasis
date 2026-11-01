import type { CollaborationGraph } from '@oasis-code/contract'
import { RemoteIdentity } from './SshTarget'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { activeRelay, relayHeaderLine, relayTurnOf } from '../state/relay'
import { activeInteractions, interactionAskOf, boardLine, interactionWay, usageLine, continueInteractionLabel, interactionHeaderLine, interactionItems, groupStatusLine, interactionReason, interactionTurnOf, continuedParticipant, nodeInstructions, noteState, participantName, type InteractionDetail, type InteractionItem } from '../state/interaction'
import type { DirectorLiveTurn, DirectorTransport, DirectorTurn, Run } from '../api/types'
import { directorStateLine, eventRunIds, openTurns, turnQuestion, wordsSaidToDirector, turnStatusLine, repeatedQuestions } from '../state/director'
import { CHATGPT_BOT, liveWaiting, threadActions, waitingLine, waitingTitle, type ThreadAction } from '../state/outline'
import { BotImage, useDirectorPresence } from './BotImage'
import { threadItems } from '../state/sync'
import { raiseWorkspaceCard, revealRun } from './Desk'
import { useAgents, useCollabView } from './useCollab'
import { useReplay } from '../state/replay'
import { useStore } from '../state/store'
import { runConnections } from '../state/runConnections'
import { type ThreadEntry } from '../state/thread'
import { Composer } from './Composer'
import { BackgroundCommands } from './BackgroundCommands'
import { SshAsks } from './SshAsks'
import { Desk } from './Desk'
import { WithEntities } from './EntityChip'
import { AlarmIcon, ArrowDownIcon, ChevronDownIcon, ChevronRightIcon, PanelLeftIcon, ShareIcon, SparklesIcon, StopIcon, XIcon } from './icons'
import { reportRuns, undeliveredReports, waitingWatches, watchLabel, watchOwners } from '../state/watches'
import { ReplayBar } from './ReplayBar'
import { ShareDialog, type ShareMode } from './ShareDialog'
import { useInteractionWorkspace } from './useInteractionWorkspace'
import { InteractionStrip } from './InteractionStrip'
import { RelationsGraph } from './RelationsGraph'
import { laneStatus } from './AgentPresentation'
import { agentsLine, boardAgents, scopeToAgents } from '../state/relationsGraph'
import { isolationLine, protectsSource } from '../state/workspacePolicy'
import { RunRecords } from './RunRecords'
import { Prose } from './Prose'
import { HarnessAsks, PendingInputs } from './UiInput'
import { followThread, onThreadFollow, onThreadHold } from '../state/threadFollow'
import { useFollowBottom } from './useFollowBottom'
import { inexpensiveTranscript } from '../state/transcriptCost'
import { DeferredTranscript } from './DeferredTranscript'
import { ActionLine, AttachmentCard, MemberWords, RequestTurn, DirectorCalls, DirectorEvent, DirectorGlyph, NoteTurn, NoteQuestion, RunTurn, SaidToDirector } from './ThreadTranscript'
export { LiveLine, NodeAdoptions, NodeHandover, NodeStepFoot, Row, RunLiveLine, SteerRow, WorkGroup } from './ThreadTranscript'

const LIVE = new Set(['queued', 'running'])
// one empty list for a run with no rows yet: a new one per draw would draw its turn again every time
const NO_ENTRIES: ThreadEntry[] = []
// sorts after every time a thread item stands at
const BOARD_AT = '\uffff'

/** The thread (after oasis's AgentThread): one continuous conversation where the person and the agent work on
 *  the code — the words, the rounds of work folded between them, what the harness measured, the person's
 *  decisions. The composer floats over its tail. */
export function Thread() {
  const session = useStore((s) => s.session)
  const sessionId = session?.id ?? null
  const runs = useStore((s) => s.runs)
  const notes = useStore((s) => s.notes)
  const threads = useStore((s) => s.threads)
  const liveRunId = useStore((s) => s.liveRunId)
  const recordsRunId = useStore((s) => s.recordsRunId)
  const openRecords = useStore((s) => s.openRecords)
  const replaying = useStore((s) => s.replaying)
  const director = useStore((s) => s.director)
  const directorLive = useStore((s) => s.directorLive)
  const relays = useStore((s) => s.relays)
  const interactions = useStore((s) => s.interactions)
  const view = useCollabView()
  // every agent of the session, the main one first, as one board at the bottom of the thread
  const agents = useMemo(() => (view?.graph ? scopeToAgents(view.graph) : null), [view])
  const tree = useStore((s) => s.tree)
  const actions = useMemo(() => threadActions(tree), [tree])
  // the runs and the director's notes (a conversation held elsewhere, mirrored) in one order by time; the director
  // turns no note closed yet (queued, with the director, failed) among them by their time; the agents' board last
  const items = useMemo(() => {
    // a note's question stands where it was asked: when its turn began; its answer before the runs the turn started
    // that were still working when it was written
    const askedAt: Record<string, string> = {}
    const dispatched: Record<string, string[]> = {}
    for (const t of director?.turns ?? []) if (t.note_id) { askedAt[t.note_id] = t.created_at; dispatched[t.note_id] = t.dispatched_run_ids }
    type Item = ReturnType<typeof threadItems>[number] | { kind: 'turn'; turn: DirectorTurn; asked: 'plan' | 'decision' | null; at: string } | InteractionItem | { kind: 'agents_board'; graph: CollaborationGraph; at: string } | { kind: 'action'; action: ThreadAction; at: string }
    // an interaction's request, its director's answers and its board are its own items; the notes of its turns
    // leave the conversation's list
    const own = interactionItems(interactions, runs, notes, director?.turns ?? [])
    const base: Item[] = threadItems(runs, notes.filter((n) => !own.noteIds.has(n.id)), askedAt, dispatched)
    // a turn an interaction asked stands where its answer will (under the interaction's request, for its plan)
    const pending: Item[] = openTurns(director?.turns ?? [], notes).map((turn) => {
      const ask = turn.kind === 'interaction' ? interactionAskOf(interactions, turn.id) : null
      return { kind: 'turn' as const, turn, asked: ask?.asked ?? null, at: ask?.at ?? turn.created_at }
    })
    // the actions taken beside the agents (a connector's command, a checkpoint): a line each, at their time
    const taken: Item[] = actions.map((action) => ({ kind: 'action' as const, action, at: action.at }))
    const board: Item[] = agents && agents.runs.length ? [{ kind: 'agents_board', graph: agents, at: BOARD_AT }] : []
    // the newest group's state and controls stand right under the board that draws its runs; an older group's where it ran
    const newest = [...interactions].sort((a, b) => a.created_at.localeCompare(b.created_at)).at(-1)?.id
    const groups: Item[] = own.items.map((item) => (board.length && item.kind === 'interaction_board' && item.interaction.id === newest ? { ...item, at: `${BOARD_AT}~` } : item))
    if (!pending.length && !groups.length && !board.length && !taken.length) return base
    const at = (item: Item) => (item.kind === 'run' ? item.run.created_at : item.at)
    return [...base, ...pending, ...groups, ...board, ...taken].sort((a, b) => at(a).localeCompare(at(b)))
  }, [runs, notes, director, interactions, agents, actions])
  const repeated = useMemo(() => repeatedQuestions(notes), [notes])
  // the runs the session's own director started: their words are the director's, said so over them
  const fromDirector = useMemo(() => new Set((director?.turns ?? []).flatMap((t) => t.dispatched_run_ids)), [director])
  const saidToDirector = useMemo(() => wordsSaidToDirector(director?.turns ?? []), [director])
  const directorName = director?.director?.label || director?.director?.model || 'director'
  // One immutable set of element props for a complete transcript. A background render may yield between turns,
  // but its commit never mixes two sessions or publishes only a prefix of the conversation.
  const transcript = useMemo(() => <>
    {items.map((item, i) => item.kind === 'run' ? (
      <RunTurn key={item.run.id} run={item.run} entries={threads[item.run.id] ?? NO_ENTRIES} live={item.run.id === liveRunId || LIVE.has(item.run.status)} latest={i === items.length - 1}
               from={fromDirector.has(item.run.id) ? directorName : null} saidAbove={saidToDirector.get(item.run.id) === item.run.user_text}
               relayTurn={relayTurnOf(relays, item.run)} interactionTurn={interactionTurnOf(interactions, item.run)} continues={continuedParticipant(interactions, runs, item.run)} />
    ) : item.kind === 'interaction_request' ? (
      <InteractionRequest key={`request-${item.interaction.id}`} interaction={item.interaction} runs={runs} />
    ) : item.kind === 'interaction_words' ? (
      <MemberWords key={`words-${item.note.id}`} to={item.note.to === 'everyone' ? 'everyone' : participantName(item.interaction, item.note.to)} text={item.note.text} status={item.note.status} state={noteState(item.note, item.interaction)} />
    ) : item.kind === 'interaction_note' ? (
      <NoteTurn key={item.note.id} note={item.note} latest={i === items.length - 1} askedAbove label={item.asked === 'plan' ? 'the plan' : 'what comes next'} />
    ) : item.kind === 'interaction_board' ? (
      <InteractionBoard key={`board-${item.interaction.id}`} interaction={item.interaction} />
    ) : item.kind === 'action' ? (
      <ActionLine key={`action-${item.action.id}`} action={item.action} />
    ) : item.kind === 'agents_board' ? (
      <AgentsBoard key="agents-board" graph={item.graph} source={view?.source ?? 'legacy'} />
    ) : item.kind === 'note' ? (
      <NoteTurn key={item.note.id} note={item.note} latest={i === items.length - 1} askedAbove={item.split || repeated.has(item.note.id)} />
    ) : item.kind === 'asked' ? (
      repeated.has(item.note.id) ? null : <section key={`asked-${item.note.id}`} className="turn-group director-note" data-testid={`asked-${item.note.id}`}><NoteQuestion note={item.note} /></section>
    ) : (
      <DirectorTurnItem key={item.turn.id} turn={item.turn} live={directorLive?.turn_id === item.turn.id ? directorLive : null} transport={director?.director?.transport ?? 'native'} label={director?.director?.label || director?.director?.model || 'director'}
                        asked={item.asked} />
    ))}
    {items.length === 0 && <div className="thread-empty">{session?.workspace?.kind === 'direct'
      ? "Say what should happen in the folder. The agent works in it directly; what it did shows here, what its file tools changed on the Workspace card, each run's changes undoable."
      : 'Say what should happen in the code. The agent reads, changes, runs and verifies inside its own worktree; what it did shows here, what it changed on the Workspace card.'}</div>}
  </>, [items, threads, liveRunId, fromDirector, directorName, saidToDirector, relays, interactions, runs, view?.source, repeated, directorLive, director, session?.workspace?.kind])
  const dockRef = useRef<HTMLDivElement>(null)
  const { ref: scroller, pinned, setPinned, onScroll, initialFollow } = useFollowBottom()
  // Reset a new opening before it can receive navigation; later queued focus may then hold it.
  useLayoutEffect(() => setPinned(true), [sessionId, setPinned])
  // a surface's run action pressed: the thread stays where the person works (state/threadFollow.ts)
  useEffect(() => onThreadHold(() => setPinned(false)), [setPinned])
  useEffect(() => onThreadFollow(() => setPinned(true)), [setPinned])
  // the composer floats over the thread: the thread keeps the dock's height clear at its bottom
  useEffect(() => {
    const dock = dockRef.current, main = dock?.parentElement
    if (!dock || !main) return
    const apply = () => main.style.setProperty('--dock-h', `${dock.offsetHeight}px`)
    apply()
    const observer = new ResizeObserver(apply)
    observer.observe(dock)
    return () => observer.disconnect()
  }, [session?.id])
  if (!session) return null
  const records = runs.find((r) => r.id === recordsRunId)
  return (
    <main className="thread desk-main">
      <ThreadHeader />
      {records ? <RunRecords run={records} onBack={() => openRecords(null)} /> : (
        <DeferredTranscript key={session.id} sessionId={session.id} scrollerRef={scroller} onScroll={onScroll} onInitialFollow={initialFollow}
                            immediate={inexpensiveTranscript(runs, threads, actions.length === 0 && notes.length === 0 && !director?.turns.length && interactions.length === 0 && !agents?.runs.length) || replaying || liveRunId !== null || directorLive !== null || runs.some((r) => LIVE.has(r.status))}>{transcript}</DeferredTranscript>
      )}
      <div className="composer-dock" ref={dockRef}>
        {!records && !pinned && <button type="button" className="jump-bottom" aria-label="Scroll to bottom" title="Scroll to bottom" data-testid="jump-bottom" onClick={followThread}><ArrowDownIcon size={15} /></button>}
        {!replaying && <HarnessAsks />}
        {!replaying && <SshAsks />}
        {!replaying && <PendingInputs />}
        {!replaying && <WatchStrip />}
        {replaying ? <ReplayBar /> : <Composer />}
      </div>
      <Desk />
    </main>
  )
}

/** Run state is separate from permission mode. A review policy is not a paused or disconnected run. */
function ThreadHeader() {
  const session = useStore((s) => s.session)
  const liveRunId = useStore((s) => s.liveRunId)
  const runs = useStore((s) => s.runs)
  const threads = useStore((s) => s.threads)
  const proposals = useStore((s) => s.proposals)
  const tree = useStore((s) => s.tree)
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const toggleSidebar = useStore((s) => s.toggleSidebar)
  const stop = useStore((s) => s.stop)
  const showToast = useStore((s) => s.showToast)
  const replaying = useStore((s) => s.replaying)
  const startReplay = useReplay((s) => s.start)
  const loadingReplay = useReplay((s) => s.loading)
  const director = useStore((s) => s.director)
  const directorLive = useStore((s) => s.directorLive)
  const relays = useStore((s) => s.relays)
  const interactions = useStore((s) => s.interactions)
  const connection = useSyncExternalStore(runConnections.subscribe, () => runConnections.snapshot(liveRunId), () => 'closed' as const)
  // the share dialog, by the session it was opened for: another session closes it (its generation is aborted)
  const [sharing, setSharing] = useState<{ id: string; mode: ShareMode } | null>(null)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const sessionId = session?.id ?? null
  useEffect(() => { setSharing(null) }, [sessionId])
  // the live runs that are not the main agent's (schema v25 lists every live run with its participant): shown, never
  // the thread's own state — the thread's composer, stop and steer stay with the main agent
  const elsewhere = (session?.active_runs ?? []).filter((r) => r.participant_role !== 'main' && r.surface !== 'thread')
  if (!session) return null
  const live = tree.find((r) => r.id === liveRunId)
  // the thread's run waiting for what holds its folder: said by what it waits for, never as running or thinking
  const liveRow = runs.find((r) => r.id === liveRunId)
  const waiting = liveRow ? liveWaiting(liveRow, threads[liveRow.id] ?? []) : null
  const planned = interactions.find((ix) => ix.status === 'running' && ix.controller === 'director')
  const directorLine = planned && director?.director && director.director.state !== 'generating' ? `director · plan committed · asleep until ${planned.then === 'director' ? 'the last step' : 'a decision'}` : directorStateLine(director?.director ?? null, directorLive, tree.filter((r) => !r.parent_run_id && LIVE.has(r.status)).length)
  const pending = proposals.filter((p) => p.status === 'pending').length + session.pending_approvals.length
  // a relay or an interaction under way is busy between two of its runs too: the next one starts from the harness, not from here
  const relay = activeRelay(relays)
  const under = activeInteractions(interactions)
  const interaction = under[0] ?? null
  const state = under.length > 1 ? `running · ${under.length} interactions` : interaction ? `running · interaction · ${interactionHeaderLine(interaction)}`
    : liveRunId
    ? (connection === 'reconnecting' ? 'reconnecting — the run may still be active' : waiting ? waitingLine(waiting) : live?.status === 'queued' ? 'queued for its model' : relay ? `running · ${relayHeaderLine(relay)}` : 'running')
    : relay ? `relay · ${relayHeaderLine(relay)}`
    : pending > 0 ? `${pending} approval request${pending > 1 ? 's' : ''}` : 'idle'
  const busy = !!liveRunId || !!relay || !!interaction
  // the HTML file is of a quiescent session only (the harness answers 409 otherwise): while work is under way the share
  // opens on a live link (the HTML side then says it waits, with Retry); idle, on the HTML file — either can be chosen
  const shareBusy = busy || elsewhere.length > 0 || (session.active_runs ?? []).length > 0 || director?.director?.state === 'generating'
  const stays = session.workspace?.kind === 'direct' ? 'the folder keeps what was written so far' : 'the worktree stays at its last state'
  return (
    <header className={`thread-header${sidebarOpen ? '' : ' rail-hidden'}`}>
      {!sidebarOpen && <button className="icon-btn header-rail" title="Show the rail" onClick={toggleSidebar} data-testid="show-rail"><PanelLeftIcon size={14} /></button>}
      <span className="thread-title" title={session.title}>{session.title}</span>
      <RemoteIdentity connection />
      <span className={`run-state${busy ? ' live' : ''}${waiting ? ' waiting' : ''}`} data-testid="thread-state" data-connection={connection} data-waiting={waiting ? 'true' : undefined} title={waiting ? waitingTitle(waiting) : undefined} role="status"><span className="run-dot" />{state}</span>
      {elsewhere.length > 0 && <button type="button" className="run-state live elsewhere" data-testid="active-elsewhere" title={elsewhere.map((r) => `${r.label ?? r.model ?? r.id} · ${r.status}`).join('\n')}
                                       onClick={() => revealRun(elsewhere[0]!.id)}><span className="run-dot" />{elsewhere.length} running beside the thread</button>}
      {directorLine && <span className={`run-state director-state${director?.director?.state === 'generating' ? ' live' : ''}${director?.director?.state === 'needs_login' || director?.director?.state === 'paused' ? ' waiting' : ''}`} data-testid="director-state" role="status"><span className="run-dot" />{directorLine}</span>}
      {/* the session's commands still running after their runs ended: a count; the composer stays free beside them */}
      <BackgroundCommands />
      <span className="thread-spacer" />
      {pending > 0 && <button className="thread-btn" onClick={raiseWorkspaceCard} data-testid="review-approvals">Review {pending}</button>}
      {busy && !replaying && <button className="thread-btn danger" title={under.length > 1 ? `Stop the ${under.length} interactions: their live runs are cancelled, nothing starts after; the copies stay at their last state` : interaction ? 'Stop the interaction: its live runs are cancelled, nothing starts after; the copies stay at their last state' : relay ? `Stop the relay: its live turn is cancelled, no later turn starts; ${stays}` : `Cancel now; ${stays}`} onClick={() => void stop().catch((e) => showToast(e instanceof Error ? e.message : String(e)))} data-testid="stop"><StopIcon size={11} /> Stop now</button>}
      {!busy && !replaying && <button className="thread-btn" disabled={loadingReplay} onClick={() => void startReplay(session.id)} title="Play this session back from its persisted events" data-testid="replay">Replay</button>}
      {!replaying && <button type="button" className="icon-btn share-btn" aria-label="Share" title="Share — an HTML file or a live link"
                             onClick={() => setSharing({ id: session.id, mode: shareBusy ? 'live' : 'html' })} data-testid="share-open" data-busy={shareBusy ? 'true' : 'false'}><ShareIcon size={13} /></button>}
      {sharing?.id === session.id && <ShareDialog key={session.id} sessionId={session.id} initialMode={sharing.mode} onClose={() => setSharing(null)}
                                                  onOpenSettings={() => { setSharing(null); setSettingsOpen(true, 'connections') }} />}
    </header>
  )
}

/** What the session's agent is waiting for, over the composer: each watch waiting (a time, a command's end, a line
 *  or a number in its output, silence) with its note on hover and a cancel; reports that wait for the conversation to
 *  be free. Nothing when nothing waits. */
const listed = (names: string[]): string => names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0] ?? ''

function WatchStrip() {
  const session = useStore((s) => s.session)
  const cancelWatch = useStore((s) => s.cancelWatch)
  const showToast = useStore((s) => s.showToast)
  const [, setTick] = useState(0)
  const tree = useStore((s) => s.tree)
  const waiting = waitingWatches(session)
  const undelivered = undeliveredReports(session)
  const waiters = watchOwners(waiting.map((w) => w.run_id), tree)
  const reported = watchOwners(reportRuns(undelivered, session), tree)
  // a timer's "in 12 min" moves on its own
  useEffect(() => {
    if (!waiting.some((w) => w.spec.kind === 'timer')) return
    const timer = window.setInterval(() => setTick((n) => n + 1), 30_000)
    return () => window.clearInterval(timer)
  }, [waiting.length])
  if (!waiting.length && !undelivered.length) return null
  return (
    <div className="watch-strip" data-testid="watch-strip" role="status">
      <AlarmIcon size={12} />
      <span className="watch-strip-head">{waiting.length ? `${waiters.length ? `${listed(waiters)} ${waiters.length > 1 ? 'are' : 'is'} waiting` : 'Waiting'} for ${waiting.length === 1 ? 'a watch' : `${waiting.length} watches`}` : 'Watches'}</span>
      {waiting.map((w) => (
        <span key={w.id} className="watch-chip" title={`${w.summary}\nWhen it reports: ${w.note}\nExpires ${new Date(w.expires_at).toLocaleString()}`} data-testid={`watch-${w.id}`}>
          <span className="watch-chip-text">{watchLabel(w)}</span>
          <button className="watch-chip-x" title="Cancel this watch: it wakes no one after" aria-label="Cancel watch"
                  onClick={() => void cancelWatch(w.id).catch((e) => showToast(e instanceof Error ? e.message : String(e)))} data-testid={`cancel-watch-${w.id}`}><XIcon size={10} /></button>
        </span>
      ))}
      {undelivered.length > 0 && <span className="watch-strip-note" data-testid="watch-undelivered">{undelivered.length} report{undelivered.length > 1 ? 's' : ''}{reported.length ? ` for ${listed(reported)} wait until ${reported.length > 1 ? 'they are' : 'it is'} free` : ' wait for the conversation to be free'}</span>}
    </div>
  )
}


/** The person's words and images, once, where the interaction began (a node's run shows neither). The images are
 *  the interaction's own; a detail from a build that did not carry them shows the ones its first run was handed. */
function InteractionRequest({ interaction, runs }: { interaction: InteractionDetail; runs: Run[] }) {
  const view = useCollabView()
  // who sent the task, as a run's message names its sender: a connector's client, a director; the person, unnamed
  const origin = view?.graph?.groups.find((g) => g.id === interaction.id)?.origin ?? null
  const from = origin?.actor === 'connector'
    ? <>{origin.client === 'ChatGPT' ? <BotImage bot={CHATGPT_BOT} className="turn-bot" /> : <SparklesIcon size={12} />}{origin.client ?? 'connector'} </>
    : origin?.actor === 'director' ? <><DirectorGlyph />director </> : null
  const images = interaction.attachments?.length ? interaction.attachments : (runs.find((r) => r.interaction_id === interaction.id && r.attachments.length)?.attachments ?? [])
  const instructions = nodeInstructions(interaction)
  return (
    <RequestTurn testId={`interaction-request-${interaction.id}`} head={<>{from}→ {interaction.participants.map((p) => p.id).join(', ')}</>} text={interaction.user_text}
                 images={images.map((a) => <AttachmentCard key={a.asset_id} attachment={a} sessionId={interaction.session_id} />)}
                 extra={instructions.length > 0 ? (
                   <div className="node-instructions" data-testid="node-instructions">
                     {instructions.map((i) => (
                       <div key={i.node} className="node-instruction" data-testid={`node-instruction-${i.node}`}>
                         <span className="node-instruction-who">{i.who}</span>
                         <span className="node-instruction-text"><WithEntities text={i.text} /></span>
                       </div>
                     ))}
                   </div>
                 ) : null} />
  )
}

/** Every agent of the session but the main one on one timeline, a lane each, with what passed between them: beside
 *  each name where its latest run stands (a click: its card); over it the board's line. */
export function AgentsBoard({ graph, source }: { graph: CollaborationGraph; source: 'graph' | 'legacy' }) {
  const agents = useAgents()
  const tree = useStore((s) => s.tree)
  // the freshest state the page knows of each latest run (a card's stream or a tree read may be newer than the graph)
  const members = useMemo(() => {
    const statusOf = new Map<string, (typeof tree)[number]['status']>()
    for (const r of tree) if (!statusOf.has(r.id)) statusOf.set(r.id, r.status)
    return boardAgents(graph).map((m) => {
      const now = statusOf.get(m.latest.id)
      return { ...m, status: now && now !== 'waiting' ? now : m.latest.status }
    })
  }, [graph, tree])
  const live = members.some((m) => m.latest.live || m.status === 'running' || m.status === 'queued')
  const laneState = useMemo(() => new Map(members.map((m) => [m.participant.id, { status: laneStatus(m.status, !!m.latest.live), run_id: m.latest.id }])), [members])
  return (
    <section className={`turn-group agents-board${live ? ' live' : ''}`} data-testid="agents-board" data-source={source}>
      <div className="relay-board dispatch-board">
        <div className="ab-head"><span className="ab-label">Agents</span><span className="dispatch-count" data-testid="agents-line">{agentsLine(members.map((m) => ({ latest: { status: m.status, live: m.latest.live } })))}</span></div>
        <RelationsGraph graph={graph} agents={agents} onOpen={revealRun} testId="agents-relations" laneState={laneState} />
      </div>
    </section>
  )
}

/** Under the interaction's newest run: the notes the person sent while it ran, its own line (its state, the steps
 *  done, the way, the wave, the limits, the runs and tokens, the revision) and what the person can do next. Each
 *  step's state stands under its own answer. */
function InteractionBoard({ interaction }: { interaction: InteractionDetail }) {
  const continueInteraction = useStore((s) => s.continueInteraction)
  const pauseInteraction = useStore((s) => s.pauseInteraction)
  const askSynthesis = useStore((s) => s.askSynthesis)
  const cancelRun = useStore((s) => s.cancelRun)
  const showToast = useStore((s) => s.showToast)
  const stop = useStore((s) => s.stop)
  const replaying = useStore((s) => s.replaying)
  const session = useStore((s) => s.session)
  const runs = useStore((s) => s.runs)
  const [busy, setBusy] = useState<string | null>(null)
  const label = replaying ? null : continueInteractionLabel(interaction)
  const active = interaction.status === 'planning' || interaction.status === 'running' || interaction.status === 'deciding'
  const ended = interaction.status === 'done' || interaction.status === 'waiting' || interaction.status === 'cancelled' || interaction.status === 'error' || interaction.status === 'interrupted'
  const go = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what)
    try { await fn() } catch (e) { showToast(e instanceof Error ? e.message : String(e)) } finally { setBusy(null) }
  }
  const wsId = session?.workspace?.id ?? null
  // the candidates: steps that ended well on a copy of their own
  const candidates = interaction.nodes.filter((n) => n.status === 'done' && n.run_id && n.workspace_id !== wsId)
  const { workspace: firstWorkspace } = useInteractionWorkspace(interaction.nodes.find((n) => n.workspace_id)?.workspace_id)
  const working = interaction.nodes.filter((n) => n.status === 'running' && n.run_id)
  const synth = (interaction.status === 'done' || interaction.status === 'waiting') && interaction.nodes.some((n) => n.status === 'done')
  return (
    <section className={`turn-group interaction-group is-${interaction.status}`} data-testid={`interaction-${interaction.id}`} data-status={interaction.status} data-group={interaction.id}>
      <div className={`relay-board interaction-board is-${interaction.status}`} data-testid="interaction-board" data-status={interaction.status}>
        {isolationLine(interaction, firstWorkspace) && <p className="dim small" data-testid="interaction-boundary">{isolationLine(interaction, firstWorkspace)}</p>}
        {!interaction.nodes.some((n) => n.run_id) && <InteractionStrip interaction={interaction} />}
        {/* one line of where the group stands; the reason in full, the plan's numbers and the usage on hover */}
        <div className="ix-meta" data-testid="interaction-line" title={[interactionReason(interaction), interaction.nodes.length ? `${boardLine(interaction)}\n${interactionWay(interaction)} · ${usageLine(interaction, runs)}` : null].filter(Boolean).join('\n')}>
          <span className="ix-meta-state">{groupStatusLine(interaction)}</span>
        </div>
        {!replaying && (label || active || (ended && candidates.length > 1) || synth) && (
          <div className="relay-board-actions">
            {label && <button className="thread-btn primary" disabled={busy !== null} onClick={() => void go('continue', () => continueInteraction(interaction.id))} data-testid="interaction-continue">{label}</button>}
            {interaction.status === 'running' && working.length > 0 && <button className="thread-btn" disabled={busy !== null} onClick={() => void go('pause', () => pauseInteraction(interaction.id))} data-testid="interaction-pause" title="The steps under way end; nothing new starts until you continue">Pause after this wave</button>}
            {working.map((n) => (
              <button key={n.id} className="thread-btn" disabled={busy !== null} data-testid={`node-stop-${n.id}`} title={`Stop ${participantName(interaction, n.participant)}'s run of step ${n.id}; the steps that depend on it wait for you`}
                      onClick={() => void go(`stop-${n.id}`, () => cancelRun(n.run_id!))}>Stop {participantName(interaction, n.participant)}</button>
            ))}
            {ended && candidates.length > 1 && <button className="thread-btn" disabled={busy !== null} data-testid="interaction-compare" title="Every candidate's card: its changes, its checks, its conversation"
                                                       onClick={() => { for (const n of candidates) if (n.run_id) revealRun(n.run_id) }}>{protectsSource(firstWorkspace) ? 'Compare outputs' : 'Compare diffs'}</button>}
            {synth && interaction.participants.map((p) => (
              <button key={p.id} className="thread-btn" disabled={busy !== null} data-testid={`interaction-synth-${p.id}`} title={`One more run: ${participantName(interaction, p.id)} reads every answer and gives you one result`}
                      onClick={() => void go(`synth-${p.id}`, () => askSynthesis(interaction.id, p.id))}>Ask {participantName(interaction, p.id)} to synthesize · 1 run</button>
            ))}
            {(active || interaction.status === 'waiting' || interaction.status === 'interrupted') && <button className="thread-btn danger" disabled={busy !== null} onClick={() => void go('stop', () => stop(interaction.id))} data-testid="interaction-stop">Stop the group</button>}
          </div>
        )}
      </div>
    </section>
  )
}



/** A director turn the thread shows on its own — queued, with the director now (its words as they stream, the tools it
 *  calls), or failed. A turn that ended well is its note. */
function DirectorTurnItem({ turn, live, transport, label, asked = null }: { turn: DirectorTurn; live: DirectorLiveTurn | null; transport: DirectorTransport; label: string; asked?: 'plan' | 'decision' | null }) {
  const cancelDirectorTurn = useStore((s) => s.cancelDirectorTurn)
  const setDraft = useStore((s) => s.setDraft)
  const showToast = useStore((s) => s.showToast)
  const text = live?.text || turn.output
  const calls = live?.tool_calls.length ? live.tool_calls : turn.tool_calls
  const active = turn.status === 'generating' || turn.status === 'awaiting_answer'
  // the director's bot as this turn stands: in line, with its model (or a tool of it running), waiting for the page's
  // answer, a sign-in it needs; failed or stopped, for a moment
  const state = useDirectorPresence(turn, live?.tool_calls)
  return (
    <section className={`turn-group director-note director-turn${active ? ' live' : ''}`} data-testid={`turn-${turn.id}`} data-status={turn.status}>
      {/* an interaction's question is oasis-code's own, not the person's words: the request above says what they asked */}
      {asked ? null : turn.kind === 'task_event' ? <DirectorEvent runIds={eventRunIds(turn.input) ?? []} />
        : turn.kind === 'user' && transport === 'native' ? <SaidToDirector text={turn.input} turnId={turn.id} sessionId={turn.session_id} />
        : <div className="turn turn-user"><span className="turn-who director">{turn.kind === 'user' ? 'you' : 'oasis-code'} → {label}</span><div className="turn-text prose"><Prose text={turnQuestion(turn)} /></div></div>}
      <div className="turn turn-agent">
        <span className="turn-who director"><DirectorGlyph state={state} />{label} · director{asked ? ` · ${asked === 'plan' ? 'the plan' : 'what comes next'}` : ''}</span>
        {live?.thinking && <DirectorThinking text={live.thinking} active={active} />}
        {calls.length > 0 && <DirectorCalls calls={calls} defaultOpen live={active} />}
        {text && <div className={`turn-text prose${active ? ' streaming' : ''}`}><Prose text={text} /></div>}
        <div className={`activity-line director-status ${turn.status}`} data-testid="director-turn-status">
          <DirectorGlyph state={state} /><span>{turnStatusLine(turn, transport)}</span>
          {(active || turn.status === 'queued') && <button className="thread-btn danger" onClick={() => void cancelDirectorTurn(turn.id).catch((e) => showToast(e instanceof Error ? e.message : String(e)))} data-testid="director-turn-cancel">Cancel</button>}
          {(turn.status === 'error' || turn.status === 'cancelled') && turn.kind === 'user' && <button className="thread-btn" onClick={() => setDraft(turn.input)} title="Put the words back in the composer">Ask again</button>}
        </div>
      </div>
    </section>
  )
}



/** The director's reasoning as it forms (the ChatGPT page's thoughts): its latest lines while it thinks, the whole
 *  on a click. */
function DirectorThinking({ text, active }: { text: string; active: boolean }) {
  const [open, setOpen] = useState(false)
  const tail = useRef<HTMLDivElement>(null)
  useEffect(() => { if (!open && tail.current) tail.current.scrollTop = tail.current.scrollHeight }, [text, open])
  return (
    <div className={`director-thinking${open ? ' open' : ''}${active ? ' live' : ''}`} data-testid="director-thinking">
      <button type="button" className="director-thinking-head" onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronDownIcon size={11} /> : <ChevronRightIcon size={11} />}{active ? 'Thinking…' : 'Thought'}
      </button>
      <div className="director-thinking-text" ref={tail}>{text}</div>
    </div>
  )
}

