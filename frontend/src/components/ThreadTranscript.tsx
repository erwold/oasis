/** The thread's turns — shared by the app's Thread (src/components/Thread.tsx) and the session share's offline viewer
 *  (src/share/viewer): one implementation of a run's turn, its rounds of work, its rows, its words, the director's
 *  exchanges. In the app no presentation is set and every component is what it always was; under the share's
 *  presentation (ThreadPresentation.ts) each component draws only the snapshot's own content and leaves out, before it
 *  mounts, every control that would act and every resource that would load. */
import type { Attachment } from '@oasis-code/contract'
import { useExecutionTarget } from './SshTarget'
import { allows, useSsh } from '../state/ssh'
import { attachmentCard } from '../state/attachments'
import { explain } from '../state/diagnosis'
import { chatGptAvailable } from '../state/chatgpt'
import { attachmentUrl } from '../state/attachments'
import { SHARE_PICTURE_ROW, useSharePresentation, type ShareActionView, type ShareNoteView, type SharePresentation, type ShareToolView } from './ThreadPresentation'
import { Fragment, memo, useEffect, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { MAX_RELAY_ROUNDS } from '@oasis-code/contract'
import { api } from '../api/client'
import { continueLabel, participantId, relayIsLatest, relayLine, relayParticipantName, stepState, type Relay, type RelayTurn } from '../state/relay'
import { adoptable, handoverLine, handoverManifest, nodeFacts, nodeState, participantName, type InteractionTurn } from '../state/interaction'
import { createdSvg, filePatches, type FilePatch } from '../state/diffs'
import type { BotState, ThreadAction } from '../state/outline'
import type { DirectorNote, DirectorToolCall, Receipt, Run } from '../api/types'
import { callReferences, callRejected, hasCallReferences, eventRunIds, outcomeReasons, planOf, turnAttachments, type PlanStep } from '../state/director'
import { botColor, botFor, CHATGPT_BOT, DIRECTOR_BOT, liveWaiting, liveWord, memberBot, participantBotOf, waitingTitle, type RunWaiting } from '../state/outline'
import { BotImage, useRunPresence } from './BotImage'
import type { PresenceRun } from '../state/presence'
import { noteLabel, noteQuestion } from '../state/sync'
import { raiseWorkspaceCard, revealRun } from './Desk'
import { jumpToRun, ReferenceButtons, RunHandover } from './Relations'
import { sourcesOf } from '../state/sources'
import { useStore } from '../state/store'
import { commandAccess, commandAccessLabel, commandAccessTitle } from '../state/callView'
import { formingLine, searchLine, type ThreadEntry } from '../state/thread'
import { thinkingParts } from '../state/thinking'
import { computerLine, screenSurface, screenshotAssetId } from '../state/screen'
import { connectorOf, contextTokens, queuedSteers, receiptOf, turnFooter, turnParts } from '../state/turns'
import { steerLabel, steerSender } from '../state/steer'
import { mediaKind, shownImagesOf, type ShownImage } from '../state/media'
import { GeneratedImages, MediaChip, RunScope, ShownImages } from './Media'
import { CallDetail, SharedDetails } from './CallDetail'
import { ComputerScreen } from './ComputerScreen'
import { WithEntities } from './EntityChip'
import { AlarmIcon, ChevronDownIcon, ChevronRightIcon, CheckIcon, CopyIcon, EyeIcon, FileDiffIcon, GlobeIcon, ImageIcon, LayersIcon, RefreshIcon, ShieldIcon, SparklesIcon, TerminalIcon } from './icons'
import { undoable, undoLine } from '../state/inplace'
import { attributionOf, undoRefusal } from '../state/attribution'
import { AttributionMark } from './AttributionMark'
import { useInteractionWorkspace } from './useInteractionWorkspace'
import { InteractionEvidence, type StepRun } from './InteractionEvidence'
import { Prose } from './Prose'
import { SourcesRow } from './SourceChip'
import { UiSurfaceBlock } from './UiSurface'
import { UiInputBlock } from './UiInput'
import { CompactionRow } from './CompactionRow'

const COMMANDS = new Set(['bash', 'bash_output', 'stop_command'])
const WEB = new Set(['web_search', 'fetch_url', 'computer_observe', 'computer_act'])
const refusedStatus = (status: unknown) => String(status ?? '').startsWith('refused') || status === 'blocked'

function ToolGlyph({ tool }: { tool: string | undefined }) {
  if (tool === 'read_file') return <EyeIcon size={12} />
  if (tool === 'write_file' || tool === 'edit_file') return <FileDiffIcon size={12} />
  if (tool && COMMANDS.has(tool)) return <TerminalIcon size={12} />
  if (tool && WEB.has(tool)) return <GlobeIcon size={12} />
  if (tool === 'watch') return <AlarmIcon size={12} />
  return <SparklesIcon size={12} />
}

/** The bot a run's turn wears and whether its part is enclosed in the bot's colour. A participant of a relay or an
 *  interaction wears its own bot over every answer, and so does a follow-up that continues one (a director resuming a
 *  participant's run). One identity everywhere (state/outline.ts): the participant the harness names wears its own
 *  bot — across groups and any renumbering; without one (an older harness) a member wears the bot its handle in its
 *  group picks. The session share reads the same function when it exports (state/shareFaces.ts). */
export function turnFace(run: Pick<Run, 'id' | 'session_id' | 'model' | 'spawned_by' | 'parent_run_id' | 'collab'>, relayTurn: RelayTurn | null, interactionTurn: InteractionTurn | null,
  continues: Pick<InteractionTurn, 'interaction' | 'participant'> | null): { bot: string | null; enclosed: boolean } {
  const stable = run.collab && run.collab.participant_role !== 'main' ? participantBotOf(run.collab.participant_id, run.model) : null
  const groupBot = interactionTurn ? memberBot({ kind: 'interaction', id: interactionTurn.interaction.id }, interactionTurn.node.participant, run.model)
    : relayTurn ? memberBot({ kind: 'relay', id: relayTurn.relay.id }, participantId(relayTurn.relay, relayTurn.step.participant), run.model)
    : continues ? memberBot({ kind: 'interaction', id: continues.interaction.id }, continues.participant.id, run.model) : null
  const bot = stable ?? groupBot ?? botFor({ id: run.id, session_id: run.session_id, model: run.model, spawned_by: run.spawned_by, parent_run_id: run.parent_run_id, work_order: null, collab: run.collab })
  return { bot, enclosed: groupBot !== null || stable !== null }
}

/** The words a group (a relay, an interaction) was started with, once, where it began: who sent them to whom, the
 *  pictures with them, the words (and what each step was told), a copy. The app's interaction request and the
 *  session share's group item draw it alike; the share adds the group's status, and has nothing to copy. */
export function RequestTurn({ testId, head, images, text, extra = null, state = null }: { testId: string; head: ReactNode; images: ReactNode[]; text: string; extra?: ReactNode; state?: string | null }) {
  return (
    <section className="turn-group interaction-group is-request" data-testid={testId}>
      <div className="turn turn-user">
        <span className="turn-who director" data-testid="interaction-request-to">{head}</span>
        {images.length > 0 && <div className="turn-images" data-testid="turn-images">{images}</div>}
        {(text.trim() || extra) && (
          <div className="turn-text">
            <WithEntities text={text} />
            {extra}
          </div>
        )}
        {state && <span className="dim small member-words-state" data-testid="group-state">{state}</span>}
        {text.trim() && <div className="turn-user-actions"><CopyText text={text} label="Copy the message" /></div>}
      </div>
    </section>
  )
}

/** One run as the person reads it: their words, then the agent's work and words in the order they happened (each
 *  stretch of work folded), the words with its bot, and the footer of what the run cost. A relay's turn wears its agent's name and short id; the person's
 *  words stand once, over the first turn; a later turn opens with the harness's handover instead, and the chain's
 *  board stands under the newest turn. Drawn again when its own props or what it reads from the store change: a
 *  delta streaming into one run of the session leaves every other run's turn as it stands. */
export const RunTurn = memo(function RunTurn({ run, entries, live, latest, relayTurn = null, interactionTurn = null, continues = null, from: fromProp = null, saidAbove = false }: { run: Run; entries: ThreadEntry[]; live: boolean; latest: boolean; relayTurn?: RelayTurn | null; interactionTurn?: InteractionTurn | null; continues?: Pick<InteractionTurn, 'interaction' | 'participant'> | null; from?: string | null; saidAbove?: boolean }) {
  const models = useStore((s) => s.models)
  // a run a UI task started (a `run` action pressed on a surface): the surface's prompt, said compactly
  const uiTask = useStore((s) => s.uiTaskRuns[run.id]) ?? entries.find((e) => e.eventName === 'ui_task' && e.task)?.task ?? null
  const [wordsOpen, setWordsOpen] = useState(false)
  const parts = turnParts(entries)
  const lastWork = parts.map((p) => p.kind).lastIndexOf('work')
  // computer use: one window for the turn, under the last stretch of work that used a page
  const screenAt = parts.findLastIndex((p) => p.kind === 'work' && screenSurface(p.entries) !== null)
  const receipt = receiptOf(run)
  const modelLabel = models.find((m) => m.id === run.model)?.label ?? run.model
  // the share's copy: the face the app drew for this run when it was exported (a name of the product's set)
  const shared = useSharePresentation()
  const { bot, enclosed } = shared ? shared.face(run.id) : turnFace(run, relayTurn, interactionTurn, continues)
  // in a conversation of several agents, each one's turn is enclosed by a line in its bot's colour
  const agentColor = enclosed ? botColor(bot) : null
  const pid = relayTurn ? participantId(relayTurn.relay, relayTurn.step.participant) : interactionTurn ? interactionTurn.node.participant : continues ? continues.participant.id : null
  const name = relayTurn ? relayParticipantName(relayTurn.relay, relayTurn.step.participant) : interactionTurn ? participantName(interactionTurn.interaction, interactionTurn.node.participant)
    : continues ? participantName(continues.interaction, continues.participant.id) : modelLabel
  // two participants on one model: the model, then the participant's own id — never a place number
  const who: ReactNode = pid && name === pid ? <>{modelLabel}<span className="turn-id">{pid}</span></> : name
  // the person's words stand once, over the interaction's board — never over a node's run
  const showWords = !relayTurn ? !interactionTurn : relayTurn.first
  // the share's copy: who sent the words that opened the run, as the snapshot names them (a director, a connector's
  // client, a parent agent, words whose sender the record did not keep) — never read from the run's label
  const opening = shared?.opening(run.id) ?? null
  const from = shared ? (opening?.author === 'director' ? opening.label : null) : fromProp
  const openedBy = shared && opening && (opening.author === 'agent' || opening.author === 'unattributed' || (opening.author === 'person' && opening.label !== 'Person')) ? opening.label : null
  // a watch its agent set woke the conversation: the message is oasis-code's, folded like a director's
  const woken = run.spawned_by === 'wake'
  // words an MCP client sent (ChatGPT through the connector): the client's, not the person's own
  const via = shared ? (opening?.author === 'connector' ? opening.label : null) : connectorOf(run)
  const folds = !!from || woken || !!via || !!uiTask || !!openedBy
  // the run's bot as it stands now (this run's own state: a later run of the agent never moves this answer's bot)
  const state = useRunPresence(run)
  const face = bot ? <BotImage bot={bot} state={state} className="turn-bot" /> : null
  // only the turn's latest words (or form, or surface) move with the run's state; what it said before stands still
  const still = bot ? <BotImage bot={bot} className="turn-bot" /> : null
  const lastSaid = parts.findLastIndex((p) => p.kind === 'agent' || p.kind === 'input' || p.kind === 'ui')
  const faceAt = (i: number) => (i === lastSaid ? face : still)
  // one value while the run's ids stand: a new object per draw would draw every image and record of the turn again
  const scope = useMemo(() => ({ sessionId: run.session_id, workspaceId: run.workspace_id, runId: run.id }), [run.session_id, run.workspace_id, run.id])
  return (
    <section className={`turn-group${live ? ' live' : ''}${relayTurn ? ' relay-turn' : ''}${interactionTurn ? ' interaction-turn' : ''}`} data-testid={`run-${run.id}`} data-status={run.status}
             data-relay={relayTurn?.relay.id} data-relay-step={relayTurn?.step.seq} data-relay-participant={relayTurn ? participantId(relayTurn.relay, relayTurn.step.participant) : undefined}
             data-interaction={interactionTurn?.interaction.id} data-node={interactionTurn?.node.id} data-participant={interactionTurn?.node.participant ?? continues?.participant.id}>
      {showWords && <div className="turn turn-user">
        {/* the person's words to the director, handed on unchanged: they and their files stand over its turn */}
        {!saidAbove && run.attachments.length > 0 && (
          <div className="turn-images" data-testid="turn-images">
            {run.attachments.map((a) => (
              <AttachmentCard key={a.asset_id} attachment={a} sessionId={run.session_id} />
            ))}
          </div>
        )}
        {from && <span className="turn-who director" data-testid="run-from-director"><DirectorGlyph />{shared && from.toLowerCase() === 'director' ? 'director' : `${from} · director`} → {continues ? who : modelLabel}</span>}
        {openedBy && <span className="turn-who director" data-testid="run-opened-by"><SparklesIcon size={12} />{openedBy} → {modelLabel}</span>}
        {via && <span className="turn-who director" data-testid="run-via-connector">{via === 'ChatGPT' ? <BotImage bot={CHATGPT_BOT} className="turn-bot" /> : <SparklesIcon size={12} />}{via} → {continues ? who : modelLabel}</span>}
        {woken && <span className="turn-who director" data-testid="run-woken"><AlarmIcon size={12} />oasis-code · a watch reported → {modelLabel}</span>}
        {uiTask && <span className="turn-who director" data-testid="run-ui-task" data-task-id={uiTask.id}><LayersIcon size={12} />a surface · action {uiTask.action_id} on {uiTask.surface_id} → {modelLabel}</span>}
        {!saidAbove && run.user_text.trim() && (woken || uiTask
          ? <div className={`turn-text woken-text${uiTask ? ' ui-task-words' : ''}${!wordsOpen ? ' folded' : ''}`} data-testid={uiTask ? 'run-ui-task-words' : undefined}>{run.user_text}</div>
          : <div className={`turn-text${folds && !wordsOpen && run.user_text.length > NOTE_FOLD_CHARS ? ' folded' : ''}`}><WithEntities text={run.user_text} /></div>)}
        {/* a fold only over words there are to fold (the share's woken turn carries none: the app's wake message is not exported) */}
        {!saidAbove && (((woken || uiTask) && !!run.user_text.trim()) || ((from || via || openedBy) && run.user_text.length > NOTE_FOLD_CHARS)) && <button className="note-fold" onClick={() => setWordsOpen(!wordsOpen)}>{wordsOpen ? 'Fold' : 'Read it whole'}</button>}
        {!saidAbove && run.user_text.trim() && <div className="turn-user-actions"><CopyText text={run.user_text} label="Copy the message" /></div>}
      </div>}
      <RunScope.Provider value={scope}>
      <AgentSpan color={agentColor}>
        {relayTurn && <RelayHandover run={run} turn={relayTurn} live={live} />}
        {interactionTurn && <NodeHandover run={run} turn={interactionTurn} live={live} />}
        {!shared && <RunHandover runId={run.id} />}
        {parts.map((part, i) => part.kind === 'work'
          ? <Fragment key={i}>
              <WorkGroup entries={part.entries} live={live && i === parts.length - 1} opened={latest || live} receipt={!live && i === lastWork ? receipt : null} />
              {!shared && i === screenAt && <ComputerScreen runId={run.id} sessionId={run.session_id} entries={entries} live={live} />}
            </Fragment>
          : part.kind === 'compaction'
          ? <CompactionRow key={`compact-${part.entry.compactionId ?? part.entry.eventId ?? i}`} entry={part.entry} live={live} />
          : part.kind === 'steer'
          ? <SteerRow key={`steer-${part.entry.steer?.id ?? i}`} entry={part.entry} />
          : part.kind === 'input'
          ? (part.entry.input ? <UiInputBlock key={`input-${part.entry.input.id}`} record={part.entry.input}
                                              who={<>{faceAt(i)}{who}</>} /> : null)
          : part.kind === 'ui'
          ? (
            // a surface the agent presented: its own block in the answer, the agent that presented it named on it
            <UiSurfaceBlock key={`ui-${part.entry.surface?.surface_id ?? i}`} entry={part.entry}
                            who={<>{faceAt(i)}{who}</>} />
          )
          : (
            <div key={i} className={`turn turn-agent${part.entry.running ? ' streaming' : ''}`}>
              <span className="turn-who">{faceAt(i)}{(shared && part.entry.eventId ? shared.author(part.entry.eventId) : null) ?? who}</span>
              <div className="turn-text prose"><Prose text={part.entry.text ?? ''} /></div>
            </div>
          ))}
        {/* words sent while the run works and not yet in a request: at the run's tail, over its live line */}
        {queuedSteers(entries).map((e) => <SteerRow key={`steer-${e.steer!.id}`} entry={e} />)}
        {!live && run.status === 'error' && <RunFailure run={run} entries={entries} />}
        {live && <LiveLine bot={bot} state={state} who={pid ? name : null} waiting={liveWaiting(run, entries)} runId={run.id} />}
        {!live && <TurnFooter run={run} entries={entries} receipt={receipt} words={relayTurn ? relayTurn.relay.user_text : interactionTurn ? interactionTurn.interaction.user_text : run.user_text} node={interactionTurn} />}
        {!live && interactionTurn && <NodeAdoptions turn={interactionTurn} />}
      </AgentSpan>
      </RunScope.Provider>
      {relayTurn?.latest && <RelayBoard relay={relayTurn.relay} />}
    </section>
  )
})

/** Words the person sent while the run worked, exactly as sent (plain text, every space and line kept): where they
 *  stand — queued (at the run's tail), delivered (where they went into the run's next model request: after the tool
 *  results before it, before the model's next words), or not delivered (why; the words can go back to the composer,
 *  after what is there — never over it, never sent on their own). */
/** The name ChatGPT's words through the connector go under: the page and the model run there. */
export const CHATGPT_WEB_LABEL = 'ChatGPT Web · GPT6 Astra Pro'

export function SteerRow({ entry }: { entry: ThreadEntry }) {
  const putBack = useStore((s) => s.putBackSteer)
  const session = useStore((s) => s.session)
  const [returned, setReturned] = useState(false)
  const [open, setOpen] = useState(false)
  const director = useStore((s) => s.director?.director)
  // the share's copy: the sender as the snapshot names it (a steer whose record did not survive is named so, never 'you')
  const shared = useSharePresentation()
  const named = shared && entry.eventId ? shared.author(entry.eventId) : null
  const steer = entry.steer
  if (!steer) return null
  // a director's words stand apart from the agent's work and from the person's own: a note at the side, folded
  const byDirector = steer.by === 'director' || steer.by === 'connector'
  // who said them: the connector's client by the name its request carried (ChatGPT with its mark), or the session's
  // director by its name
  const sender = steerSender(steer)
  // ChatGPT's words through the connector: named by the page and the model the person runs there
  const chatgpt = sender.kind === 'connector' && sender.chatgpt
  const who = sender.kind === 'connector' ? <>{sender.chatgpt ? <DirectorGlyph chatgpt /> : <SparklesIcon size={12} />}{chatgpt ? CHATGPT_WEB_LABEL : named ?? sender.name}</>
    : sender.kind === 'director' ? <><DirectorGlyph />{named ?? (director?.label || director?.model || 'director')}</> : (named ?? 'you')
  // a record without its sender (the share's unrecorded words) is named whole by its label
  const when = chatgpt || (shared && steer.by === undefined) ? '' : ' · while it worked'
  return (
    <div className={`turn turn-user steer-row is-${steer.status}${byDirector ? ' by-director' : ''}`} data-testid={`steer-${steer.id}`} data-status={steer.status} data-steer-id={steer.id}>
      <span className="turn-who" data-testid="steer-who">{who}{when}</span>
      {byDirector
        ? <div className={`turn-text steer-text${open ? '' : ' folded'}`} data-testid="steer-text" title={open ? 'Fold' : 'Read it whole'} onClick={() => setOpen((v) => !v)}>{steer.text}</div>
        : <div className="turn-text steer-text" data-testid="steer-text">{steer.text}</div>}
      <span className="steer-state" data-testid="steer-state">{steerLabel(steer)}</span>
      {!shared && steer.status === 'undelivered' && (steer.by ?? 'person') === 'person' && (
        <button className="thread-btn" disabled={returned} data-testid="steer-put-back"
                title="Put these words back in the composer, after what is there; nothing is sent until you send it"
                onClick={() => { putBack(steer.session_id || session?.id || '', steer.text); setReturned(true) }}>{returned ? 'Back in the composer' : 'Put back in the composer'}</button>
      )}
    </div>
  )
}

/** An agent's part of a turn — its handover, its work, its answer, its footer — enclosed by a line in its bot's
 *  colour when the conversation has several agents (the Agent Teams outline brings it into view and lights it);
 *  a turn of the one agent the session talks to stands as it is. */
export function AgentSpan({ color, children }: { color: string | null; children: ReactNode }) {
  if (!color) return <>{children}</>
  return <div className="agent-span" data-testid="agent-span" style={{ ['--agent' as string]: color }}>{children}</div>
}

/** The line that opens an interaction node's run: which participant, by name, which step, after which steps,
 *  reading whose answers, on which copy — and what the harness told it, folded. */
export function NodeHandover({ run, turn, live }: { run: StepRun; turn: InteractionTurn; live: boolean }) {
  const [open, setOpen] = useState(false)
  const { interaction, node } = turn
  // a participant's follow-up (schema v25: a step the person or a director added to continue its conversation): its
  // participant's, said as such — the words are the sender's own, above the run
  const followup = node.kind === 'followup'
  const what = followup ? `follow-up${node.message ? ` · from ${node.message.by === 'person' ? 'you' : node.message.by}` : ''} · carries on its own conversation`
    : `${turn.first ? '' : 'carries on · '}${handoverLine(interaction, node)}`
  return (
    <div className="relay-handover" data-testid="node-handover">
      <button type="button" className={`activity-line relay-line${live ? ' live' : ''}`} onClick={() => setOpen((v) => !v)} title={open ? 'Fold what the harness handed it' : 'Show what the harness handed it'}>
        <LayersIcon size={12} />
        <span className="relay-who">{participantName(interaction, node.participant)}</span>
        <span className="relay-role" data-testid="node-role" data-kind={node.kind ?? 'plan'}>{followup ? 'follow-up' : 'step'} {node.id} · wave {node.wave}</span>
        <span className="line">{what}</span>
        {open ? <ChevronDownIcon size={11} /> : <ChevronRightIcon size={11} />}
      </button>
      {open && <><InteractionEvidence run={run} turn={turn} /><pre className="activity-detail relay-message" data-testid="node-manifest">{handoverManifest(interaction, node, turn.first)}{'\n\n'}{run.user_text}</pre></>}
    </div>
  )
}

/** What the person did with a step's result, under its answer: composed into the working folder, or not and why. */
export function NodeAdoptions({ turn }: { turn: InteractionTurn }) {
  const adopted = turn.interaction.events.filter((e) => e.kind === 'adopted' && e.payload.node === turn.node.id)
  if (!adopted.length) return null
  return (
    <div className="node-adoptions" data-testid="node-adoptions">
      {adopted.map((e) => (
        <div key={e.seq} className={`activity-line${e.payload.applied_to_workspace ? '' : ' gate'}`} data-testid="node-adoption">
          <LayersIcon size={12} />
          <span>{`kept: composed ${e.payload.composed_checkpoint_id ? String(e.payload.composed_checkpoint_id).slice(0, 7) : 'nothing'} · ${e.payload.applied_to_workspace ? 'written to the working folder' : `not written${e.payload.reason ? ` — ${String(e.payload.reason)}` : ''}`}`}</span>
        </div>
      ))}
    </div>
  )
}

/** The line that opens a relay turn: which agent, by name and turn, and — for a turn the harness opened (a later
 *  one, or one run again) — what it was told, folded. */
export function RelayHandover({ run, turn, live }: { run: Run; turn: RelayTurn; live: boolean }) {
  const [open, setOpen] = useState(false)
  const { relay, step } = turn
  const before = relay.steps.slice(0, step.seq).filter((s) => relay.participants[s.participant]).at(-1)
  const what = turn.first && !turn.rerun ? `takes the request first` : turn.rerun ? 'carries on after your decision' : `speaks after ${before ? relayParticipantName(relay, before.participant) : 'the earlier agent'}`
  return (
    <div className="relay-handover" data-testid="relay-handover">
      <button type="button" className={`activity-line relay-line${live ? ' live' : ''}`} onClick={() => setOpen((v) => !v)} title={open ? 'Fold what the harness told it' : 'Show what the harness told it'}>
        <LayersIcon size={12} />
        <span className="relay-who">{relayParticipantName(relay, step.participant)}</span>
        <span className="relay-role">turn {step.seq + 1} of {relay.steps.length}{relay.rounds > 1 ? ` · round ${step.round}` : ''}</span>
        <span className="line">{what}</span>
        {(!turn.first || turn.rerun) && (open ? <ChevronDownIcon size={11} /> : <ChevronRightIcon size={11} />)}
      </button>
      {open && (!turn.first || turn.rerun) && <pre className="activity-detail relay-message">{run.user_text}</pre>}
    </div>
  )
}

/** The chain as it stands, under its newest turn: every participant with the state of its turn, the relay's own
 *  line (running, paused for a decision, interrupted, done, stopped, failed), and what the person can do next. */
export function RelayBoard({ relay }: { relay: Relay }) {
  const continueRelay = useStore((s) => s.continueRelay)
  const showToast = useStore((s) => s.showToast)
  const runs = useStore((s) => s.runs)
  const replaying = useStore((s) => s.replaying)
  const [busy, setBusy] = useState(false)
  // the chain is continued only while it is the latest thing said: the person's later words are never rewound past;
  // and never from the replay, which shows the record
  const latestRunId = runs.length ? runs[runs.length - 1]!.id : null
  const label = replaying ? null : continueLabel(relay, MAX_RELAY_ROUNDS, latestRunId)
  const movedOn = !relayIsLatest(relay, latestRunId) && (relay.status === 'done' || relay.status === 'waiting' || relay.status === 'interrupted')
  const go = async () => {
    setBusy(true)
    try { await continueRelay(relay.id) } catch (e) { showToast(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  const steps = relay.steps.filter((s) => s.round === relay.round)
  return (
    <div className={`relay-board is-${relay.status}`} data-testid="relay-board" data-status={relay.status} data-group={relay.id}>
      <div className="relay-board-steps">
        {steps.map((s) => {
          const p = relay.participants[s.participant]!
          return (
            <span key={s.seq} className={`relay-step is-${s.status}`} data-testid="relay-step" data-step-status={s.status} title={`${p.model} · ${relayParticipantName(relay, s.participant)} · ${participantId(relay, s.participant)}`}>
              <span className="relay-step-n">{s.seq + 1}</span>{p.label}<span className={`pill ${s.status === 'waiting' ? 'stale' : s.status}`}>{stepState(s, p)}</span>
            </span>
          )
        })}
      </div>
      <div className="relay-board-line">
        <span data-testid="relay-line">{relayLine(relay)}{movedOn ? ' · the conversation moved on since; name the agents in a new message to go on' : ''}</span>
      </div>
      {label && <div className="relay-board-actions"><button className="thread-btn primary" disabled={busy} onClick={() => void go()} data-testid="relay-continue">{label}</button></div>}
    </div>
  )
}

/** A run that failed, said plainly under its turn: what happened, what to do, the harness's own words folded. */
export function RunFailure({ run, entries }: { run: Run; entries: ThreadEntry[] }) {
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const setChatGptSheet = useStore((s) => s.setChatGptSheet)
  const models = useStore((s) => s.models)
  const reported = [...entries].reverse().find((e) => e.kind === 'error' && e.eventName === 'error')
  const detail = (reported?.detail ?? {}) as Record<string, unknown>
  const found = explain(typeof detail.kind === 'string' ? detail.kind : null)
  const route = typeof detail.model === 'string' ? (models.find((m) => m.id === detail.model)?.label ?? detail.model) : null
  const status = typeof detail.status_code === 'number' ? ` · HTTP ${detail.status_code}` : ''
  // the share's copy: no way to the accounts or the ChatGPT page; the harness's words once — the error row the snapshot
  // carried says them already, else the run's own error does here
  const shared = useSharePresentation()
  return (
    <div className="run-failure" role="alert" data-testid="failure-card" data-kind={String(detail.kind ?? 'other')}>
      <b>{found.title}</b>
      {found.advice && <span className="run-failure-advice">{found.advice}</span>}
      <div className="run-failure-row">
        {!shared && found.accounts && <button className="thread-btn" onClick={() => setSettingsOpen(true, 'accounts')} data-testid="failure-accounts">Open Accounts</button>}
        {!shared && found.chatgpt && chatGptAvailable(window as { oasisCodeDesktop?: unknown }) && <button className="thread-btn" onClick={() => setChatGptSheet(true)} data-testid="failure-chatgpt">Open ChatGPT</button>}
        {(!shared || (!reported && run.error)) && <details><summary>{route ? `${route}${status}` : `Detail${status}`}</summary><pre className="detail">{String(detail.message ?? run.error ?? '')}</pre></details>}
      </div>
    </div>
  )
}

export const NOTE_FOLD_CHARS = 1200

/** One exchange of the director's own conversation, held outside this program (ChatGPT) and mirrored here: the
 *  person's words there (the chat client hands them over as markdown source, so they render as markdown), labelled
 *  with where they were said, then the director's answer, folded when long unless it is the thread's latest item.
 *  What the director then sends to the agent stands under it as a run. */
/** The person's words a director's note answers — typed here (the session's own director: chips and all) or in the
 *  chat client (markdown source, as it hands them over) — or, for a task event, one quiet line: which runs ended. */
export function NoteQuestion({ note }: { note: DirectorNote }) {
  const shared = useSharePresentation()
  if (shared) return <SharedNoteQuestion note={note} view={shared.note(note.id)} />
  const runs = eventRunIds(note.question)
  if (runs) return <DirectorEvent runIds={runs} />
  if (note.source === 'oasis-code') return <SaidToDirector text={note.question} turnId={note.turn_id} sessionId={note.session_id} />
  return (
    <div className="turn turn-user">
      <span className="turn-who director">{noteLabel(note)} · you</span>
      <div className="turn-text prose"><Prose text={noteQuestion(note.question)} /></div>
      <div className="turn-user-actions"><CopyText text={noteQuestion(note.question)} label="Copy the message" /></div>
    </div>
  )
}

/** The share's copy of a director exchange's question, by the same markup: the harness's own question (a task event,
 *  an interaction's plan) as the director-event line it is in the app, said by the snapshot's fixed words; the
 *  person's words with the pictures they sent (the image items that followed the exchange), named as the snapshot
 *  names them. */
function SharedNoteQuestion({ note, view }: { note: DirectorNote; view: ShareNoteView | null }) {
  if (view?.asker === 'app') return <div className="activity-line director-event" data-testid="director-event"><DirectorGlyph /><span>{note.question}</span></div>
  const own = note.source === 'oasis-code'
  const who = view?.askerLabel ?? 'Person'
  return (
    <div className="turn turn-user">
      {view && view.pictures.length > 0 && (
        <div className="turn-images" data-testid="turn-images">{view.pictures.map((key) => <SharedAttachment key={key} pictureKey={key} />)}</div>
      )}
      <span className="turn-who director">{own ? `${who} → director` : `${noteLabel(note)} · ${who}`}</span>
      {note.question.trim() && (own ? <div className="turn-text"><WithEntities text={note.question} /></div> : <div className="turn-text prose"><Prose text={noteQuestion(note.question)} /></div>)}
      {note.question.trim() && <div className="turn-user-actions"><CopyText text={note.question} label="Copy the message" /></div>}
    </div>
  )
}

/** The person's message to the session's own director: their words, with the files they sent above them. */
export function SaidToDirector({ text, turnId, sessionId }: { text: string; turnId: string | null; sessionId: string }) {
  const turn = useStore((s) => (turnId ? s.director?.turns.find((t) => t.id === turnId) : undefined))
  const interactions = useStore((s) => s.interactions)
  const runs = useStore((s) => s.runs)
  const files = useMemo(() => (turn ? turnAttachments(turn, interactions, runs) : []), [turn, interactions, runs])
  return (
    <div className="turn turn-user">
      {files.length > 0 && (
        <div className="turn-images" data-testid="turn-images">
          {files.map((a) => <AttachmentCard key={a.asset_id} attachment={a} sessionId={sessionId} />)}
        </div>
      )}
      <span className="turn-who director">you → director</span>
      <div className="turn-text"><WithEntities text={text} /></div>
      <div className="turn-user-actions"><CopyText text={text} label="Copy the message" /></div>
    </div>
  )
}

/** The director's mark: the paper plane, or ChatGPT's bot when ChatGPT on the web directs the session (its mark is
 *  still in every state). Still where it names who sent words; a turn of the director's own plays its state. */
export function DirectorGlyph({ chatgpt, state = 'static' }: { chatgpt?: boolean; state?: BotState }) {
  const bridge = useStore((s) => s.director?.director?.transport === 'bridge')
  return <BotImage bot={(chatgpt ?? bridge) ? CHATGPT_BOT : DIRECTOR_BOT} state={state} className="turn-bot" />
}

const ENDED: Partial<Record<Run['status'], string>> = { done: 'finished', error: 'failed', cancelled: 'was stopped' }

/** What woke the director when no one wrote to it: the runs it started ended — one line, never the person's words. */
export function DirectorEvent({ runIds }: { runIds: string[] }) {
  const runs = useStore((s) => s.runs)
  const tree = useStore((s) => s.tree)
  const models = useStore((s) => s.models)
  // the runs that ended: the thread's own, or runs on cards (a separate task: in the tree, not the thread) — each a
  // jump to where it is read
  const said = runIds.map((id) => {
    const run = runs.find((r) => r.id === id) ?? tree.find((r) => r.id === id)
    const who = run ? (run.label || (models.find((m) => m.id === run.model)?.label ?? run.model ?? 'the agent')) : 'a run'
    const onCard = !runs.some((r) => r.id === id)
    return { id, line: `${who} ${run ? (ENDED[run.status as Run['status']] ?? run.status) : 'ended'}`, onCard }
  })
  return (
    <div className="activity-line director-event" data-testid="director-event" title={runIds.join(', ')}>
      <DirectorGlyph /><span>{said.map((s, i) => <Fragment key={s.id}>{i > 0 && ' · '}{s.onCard
        ? <button type="button" className="link-btn" data-testid={`director-event-run-${s.id}`} title="Open its card" onClick={() => revealRun(s.id)}>{s.line}</button>
        : s.line}</Fragment>)} — the director reads the result</span>
    </div>
  )
}

export function NoteTurn({ note, latest, askedAbove = false, label = null }: { note: DirectorNote; latest: boolean; askedAbove?: boolean; label?: string | null }) {
  const [open, setOpen] = useState<boolean | null>(null)
  // the turn that wrote this note: its tool calls stand above the answer, so the director is no black box
  const calls = useStore((s) => (note.turn_id ? s.director?.turns.find((t) => t.id === note.turn_id)?.tool_calls : undefined)) ?? []
  const long = note.answer.length > NOTE_FOLD_CHARS
  const isOpen = open ?? (latest || !long)
  // the share's copy: an exchange that ended without an answer (failed, stopped) says its status as the app's
  // director turn does, instead of an empty answer; its footer keeps the app's room (CopyText draws no button there)
  const shared = useSharePresentation()
  const view = shared ? shared.note(note.id) : null
  const status = shared && view && !view.answered ? view.status : null
  return (
    <section className="turn-group director-note" data-testid={`note-${note.id}`}>
      {/* the share's copy: pictures sent with no words still stand where the words would */}
      {(note.question || (view?.pictures.length ?? 0) > 0) && !askedAbove && <NoteQuestion note={note} />}
      {calls.length > 0 && <DirectorCalls calls={calls} defaultOpen={latest} />}
      <div className="turn turn-agent">
        <span className="turn-who director"><DirectorGlyph chatgpt={note.source === 'chatgpt'} />{[noteLabel(note), 'director', label].filter(Boolean).join(' · ')}</span>
        {status === null && <div className={`turn-text prose${isOpen ? '' : ' folded'}`}><Prose text={note.answer} /></div>}
        {status !== null && <div className="activity-line director-status" data-testid="director-turn-status"><DirectorGlyph /><span>{status}</span></div>}
        <div className="turn-footer turn-foot">
          <CopyText text={note.answer} label="Copy the answer" />
          {long && <button className="note-fold" onClick={() => setOpen(!isOpen)}>{isOpen ? 'Fold' : 'Read it whole'}</button>}
        </div>
      </div>
    </section>
  )
}

/** A button that copies a turn's words as they were written. */
export function CopyText({ text, label }: { text: string; label: string }) {
  const showToast = useStore((s) => s.showToast)
  const [copied, setCopied] = useState(false)
  // the share's copy acts on nothing: no clipboard, no button — only the room the app's button takes (the same box,
  // drawn by the same rule, never shown and never focused), so the words, answers and rounds below stand where the
  // app puts them
  if (useSharePresentation()) return <span className="turn-action share-action-space" aria-hidden="true" data-testid="share-action-space" />
  const copy = () => void navigator.clipboard.writeText(text).then(
    () => { setCopied(true); window.setTimeout(() => setCopied(false), 1500) },
    () => showToast('Copy failed: the window did not allow clipboard access'))
  return <button type="button" className="turn-action" title={copied ? 'Copied' : label} onClick={copy} data-testid="copy-text">{copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}</button>
}

/** What an action line of the share's copy says in place of a text it does not carry (the app always has the text). */
const ACTION_MISSING: Record<NonNullable<ShareActionView['missing']>, { line: string; full: string }> = {
  withheld: { line: 'withheld (sensitive source)', full: 'Content withheld: a sensitive source (an environment, a credential file); nothing of this command or its output is in this export.' },
  not_carried: { line: 'content not carried in this export', full: 'This copy was made by an earlier oasis-code that kept only that this action was taken: its command and outcome were not carried, and nothing here stands in for them.' },
  unrecorded: { line: '', full: 'The record kept no text of this action.' },
}

/** An action taken beside the agents, one line in the thread: who took it, what, its outcome; open: its whole text.
 *  The app's thread and the session share's copy draw it alike (one component, one line): in the copy the person is
 *  "Person" (the copy's reader is not them), a text the export withheld or did not carry is said so, never made up,
 *  and with tool details the command's measures and a cut preview of its output stand under its text. */
export function ActionLine({ action }: { action: ThreadAction }) {
  const [open, setOpen] = useState(false)
  const shared = useSharePresentation()
  const view = shared ? shared.action(action.id) : null
  const missing = view?.missing ? ACTION_MISSING[view.missing] : null
  const who = action.by === 'ChatGPT' ? <><BotImage bot={CHATGPT_BOT} />ChatGPT</> : action.by ?? (shared ? 'Person' : 'you')
  // a time the record does not hold (the copy's `at` may be null) is left out of the title, never "Invalid Date"
  const when = Date.parse(action.at)
  return (
    <div className="action-line-wrap" data-testid={`action-${action.id}`} data-missing={view?.missing ?? undefined}>
      <button type="button" className="activity-line action-line" onClick={() => setOpen((v) => !v)} aria-expanded={open} title={Number.isFinite(when) ? `${action.what} · ${new Date(when).toLocaleString()}` : action.what}>
        {action.what === 'command' ? <TerminalIcon size={12} /> : <LayersIcon size={12} />}
        <span className="action-who">{who}</span>
        <span className="action-head">{action.head || missing?.line || action.what}</span>
        {action.outcome && <span className="action-outcome">{action.outcome}</span>}
      </button>
      {open && (missing
        ? <div className="action-full dim" data-testid="action-missing">{missing.full}</div>
        : <pre className="action-full" data-testid="action-full">{action.text}</pre>)}
      {open && view?.details && <div className="tool-detail" data-testid="action-details" data-view="share"><SharedDetails details={view.details} /></div>}
    </div>
  )
}

/** The person's words to a group's members while it ran, as their turn in the thread: to whom, the words, and —
 *  until every addressee was handed them — where they stand (`state`: noteState's words). The app names the person
 *  "you", the session share's copy "Person"; the copy's copy control keeps only its room. */
export function MemberWords({ to, text, status, state }: { to: string; text: string; status: 'queued' | 'partly' | 'delivered' | 'undelivered'; state: string }) {
  const shared = useSharePresentation()
  return (
    <section className="turn-group" data-testid="interaction-note" data-note-status={status}>
      <div className="turn turn-user">
        <span className="turn-who director">{shared ? 'Person' : 'you'} → {to}</span>
        <div className="turn-text"><WithEntities text={text} /></div>
        {status !== 'delivered' && <span className="dim small member-words-state">{state}</span>}
        <div className="turn-user-actions"><CopyText text={text} label="Copy the message" /></div>
      </div>
    </section>
  )
}

/** The director's tool calls in a turn, folded like an agent's round of work: how many, how many the harness turned
 *  away; open, one row per call — its name and what it asked for — and on a click what it passed (a plan as a
 *  table) and what came back (a rejection's reasons one per line). */
export function DirectorCalls({ calls, defaultOpen, live = false }: { calls: DirectorToolCall[]; defaultOpen: boolean; live?: boolean }) {
  const [open, setOpen] = useState<boolean | null>(null)
  const isOpen = open ?? defaultOpen
  const rejected = calls.filter(callRejected).length
  const last = calls[calls.length - 1]
  return (
    <div className={`work director-work${isOpen ? ' open' : ''}${live ? ' live' : ''}`} data-testid="director-calls">
      <button className="work-head fold" onClick={() => setOpen(!isOpen)} aria-expanded={isOpen} title={isOpen ? "Fold the director's calls" : "Open the director's calls"}>
        {isOpen ? <ChevronDownIcon size={11} /> : <ChevronRightIcon size={11} />}
        <span className="work-summary">director · {calls.length} tool call{calls.length === 1 ? '' : 's'}{live ? ' · running' : ''}</span>
        {rejected > 0 && <span className="work-failed">{rejected} rejected</span>}
        {!isOpen && last && <span className="work-last">{last.name}{last.summary ? ` ${last.summary}` : ''}</span>}
      </button>
      {isOpen && <div className="work-body">{calls.map((c, i) => <DirectorCallRow key={i} call={c} />)}</div>}
    </div>
  )
}

function DirectorCallRow({ call }: { call: DirectorToolCall }) {
  const [open, setOpen] = useState(false)
  // the interaction the call planned: its participants' names for the plan's table
  const planned = useStore((s) => s.interactions.find((ix) => ix.id === call.args?.interaction_id))
  const rejected = callRejected(call)
  const args = call.args ?? null
  const outcome = call.outcome ?? ''
  const plan = planOf(call)
  const detail = args !== null || outcome !== ''
  const reasons = rejected ? outcomeReasons(outcome) : null
  return (
    <div className={`activity row${rejected ? ' refused' : ''}${open ? ' open' : ''}`} data-testid="director-call" data-tool={call.name} data-status={call.status}>
      <button className={`activity-line${detail ? ' expandable' : ''}${call.status === 'running' ? ' running' : ''}`} onClick={() => detail && setOpen((v) => !v)} title={detail ? (open ? 'Hide what it passed and what came back' : 'Show what it passed and what came back') : undefined}>
        <SparklesIcon size={12} />
        <span className="tool">{call.name}</span>
        <span className="line">{call.summary || (rejected ? outcome : '')}</span>
        {rejected && <span className="pill error">{call.status === 'refused' ? 'refused' : 'rejected'}</span>}
        {detail && (open ? <ChevronDownIcon size={11} /> : <ChevronRightIcon size={11} />)}
      </button>
      {open && (
        <div className="call-detail" data-testid="director-call-detail">
          {plan ? <PlanTable steps={plan.steps} then={plan.then} nameOf={(id) => (planned ? participantName(planned, id) : id)} /> : args !== null ? <pre className="activity-detail">{JSON.stringify(args, null, 1).slice(0, 6000)}</pre> : null}
          <CallReferenceList call={call} />
          {reasons ? (
            <div className="call-outcome bad"><b>Rejected by the harness</b>{reasons.lead ? ` · ${reasons.lead}` : ''}{reasons.reasons.length > 0 && <ul>{reasons.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>}</div>
          ) : outcome ? <div className="call-outcome"><b>Came back</b> · {outcome}</div> : null}
        </div>
      )}
    </div>
  )
}

/** The runs a director's call named, as it passed them: those it cites (sources named to the agent — this call put
 *  nothing of them into the message; the agent may still see them another way, a shared folder or its own history)
 *  apart from those whose answers it handed over (put into the message whole); each a jump to that exact run. */
function CallReferenceList({ call }: { call: DirectorToolCall }) {
  const refs = useMemo(() => callReferences(call), [call])
  if (!hasCallReferences(refs)) return null
  const run = (id: string, note: string | null = null) => (
    <button key={id} type="button" className="link-btn" data-testid={`call-ref-${id}`} onClick={() => jumpToRun(id)} title="Go to this run">
      {id.slice(0, 12)}{note ? ` — “${note}”` : ''}
    </button>
  )
  const lists = (cites: { run_id: string; note: string | null }[], receives: string[]) => <>
    {cites.length > 0 && <div className="call-ref is-cite" data-testid="call-cites"><span className="run-handover-kind">cites</span>{cites.map((c) => run(c.run_id, c.note))}<span className="dim small">named as sources; this call sends nothing of them</span></div>}
    {receives.length > 0 && <div className="call-ref is-receive" data-testid="call-receives"><span className="run-handover-kind">hands over</span>{receives.map((id) => run(id))}<span className="dim small">their answers go into the message whole</span></div>}
  </>
  return (
    <div className="call-refs" data-testid="director-call-references">
      {lists(refs.cites, refs.receives)}
      {refs.steps.map((s) => <div key={s.step} className="call-ref-step" data-testid={`call-step-refs-${s.step}`}><span className="dim small">step {s.step}</span>{lists(s.cites, s.receives)}</div>)}
    </div>
  )
}

/** The plan a schedule call passed, a row per step: who, after whom, whose answers it is handed, on which copy, the
 *  director's note for it. */
function PlanTable({ steps, then, nameOf }: { steps: PlanStep[]; then: string; nameOf: (id: string) => string }) {
  const codes = (xs: string[]) => (xs.length ? xs.map((x) => <code key={x}>{x}</code>) : <span className="dim">—</span>)
  return (
    <div className="plan-table" role="region" tabIndex={0} aria-label="The plan it passed">
      <table>
        <thead><tr><th>step</th><th>who</th><th>after</th><th>handed</th><th>files</th><th>note for the step</th></tr></thead>
        <tbody>{steps.map((st) => (
          <tr key={st.id}><td><b>{st.id}</b></td><td title={st.participant}>{nameOf(st.participant)}</td><td>{codes(st.after)}</td><td>{codes(st.receives)}</td><td><code>{st.workspace}</code></td><td className="plan-note">{st.instruction || <span className="dim">—</span>}</td></tr>
        ))}</tbody>
      </table>
      <p className="plan-then">then <code>{then}</code>{then === 'stop' ? ' · you decide after the last step' : ' · the director is asked what comes next'}</p>
    </div>
  )
}

/** Under a run's last words (after oasis's TurnFooter): copy the answer, put the words that led here back in the
 *  composer, open the run's records; the pages it used; what it cost in the provider's own counts. An interaction
 *  step's answer ends with the step's state, what the harness measured of it, and — a candidate — Keep. */
export function TurnFooter(props: { run: Run; entries: ThreadEntry[]; receipt: Receipt | null; words: string; node?: InteractionTurn | null }) {
  return useSharePresentation() ? <SharedTurnFooter run={props.run} entries={props.entries} /> : <LiveTurnFooter {...props} />
}

/** The share's copy of a turn's footer: the pages the answer cited (each inert) and how the run ended — no copy, no
 *  refill, no records, no cite, no undo, no keep; no cost line (the snapshot carries no receipt: unknown is never 0). */
function SharedTurnFooter({ run, entries }: { run: Run; entries: ThreadEntry[] }) {
  const answer = entries.filter((e) => e.kind === 'agent').map((e) => e.text ?? '').join('\n\n')
  const sources = useMemo(() => sourcesOf(entries, answer), [entries, answer])
  return (
    <div className="turn-footer turn-foot">
      {sources.length > 0 && <SourcesRow sources={sources} />}
      {run.status !== 'done' && <span className={`pill ${run.status}`}>{run.status}</span>}
      {run.error && run.status !== 'error' && <span className="err small">{run.error}</span>}
    </div>
  )
}

function LiveTurnFooter({ run, entries, receipt, words, node = null }: { run: Run; entries: ThreadEntry[]; receipt: Receipt | null; words: string; node?: InteractionTurn | null }) {
  const models = useStore((s) => s.models)
  const setDraft = useStore((s) => s.setDraft)
  const openRecords = useStore((s) => s.openRecords)
  const setNotice = useStore((s) => s.setNotice)
  const showToast = useStore((s) => s.showToast)
  const undoRun = useStore((s) => s.undoRun)
  const replaying = useStore((s) => s.replaying)
  const session = useStore((s) => s.session)
  const [copied, setCopied] = useState(false)
  const [undoing, setUndoing] = useState(false)
  // a folder edited in place: the run's file-tool writes are in the folder already, and can be taken back
  const changed = receipt?.produced?.files_changed?.length ?? 0
  const undoTarget = useExecutionTarget()
  const undoHosts = useSsh((s) => s.targets)
  const canUndo = !replaying && allows(undoTarget, 'journal_undo', undoHosts) && undoable(run, changed, session?.workspace?.kind)
  // a run that worked beside a background command (or whose changes cannot be told apart): no automatic undo, said why
  const undoRefused = canUndo ? undoRefusal(receipt) : null
  const undo = async () => {
    setUndoing(true)
    try { setNotice(undoLine(await undoRun(run.id))) } catch (e) { showToast(e instanceof Error ? e.message : String(e)) } finally { setUndoing(false) }
  }
  const answer = entries.filter((e) => e.kind === 'agent').map((e) => e.text ?? '').join('\n\n')
  const sources = useMemo(() => sourcesOf(entries, answer), [entries, answer])
  const copy = async () => {
    try { await navigator.clipboard.writeText(answer); setCopied(true); window.setTimeout(() => setCopied(false), 1500) }
    catch { setNotice('Copy failed: the window did not allow clipboard access') }
  }
  return (
    <div className="turn-footer turn-foot">
      <button className="turn-action" title={copied ? 'Copied' : 'Copy the answer'} disabled={!answer} onClick={() => void copy()}>{copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}</button>
      <button className="turn-action" title="Put the words that led here back in the composer" onClick={() => setDraft(words)}><RefreshIcon size={13} /></button>
      <button className="turn-action" title="The run's records: model identity, budget, every request, the manifest" onClick={() => openRecords(run.id)} data-testid={`records-${run.id}`}><ShieldIcon size={13} /></button>
      <ReferenceButtons runId={run.id} status={run.status} />
      {node && <button className="turn-action" title="The step's card: its conversation, its changes, its terminal, its checks" onClick={() => revealRun(run.id)} data-testid="node-card"><LayersIcon size={13} /></button>}
      {sources.length > 0 && <SourcesRow sources={sources} />}
      {node && node.node.run_id === run.id ? null : run.status !== 'done' && <span className={`pill ${run.status}`}>{run.status}</span>}
      {node && <NodeStepFoot runId={run.id} receipt={receipt} turn={node} />}
      {receipt && <span className="turn-tokens" data-testid="turn-footer" title={node ? 'what the run cost in the provider\'s own counts, then what the harness measured of the step: files, checks, checkpoint' : 'what the run cost in the provider\'s own counts; money is unknown until a price list is configured'}>{turnFooter(receipt, { tokens: contextTokens(run.usage), window: models.find((m) => m.id === run.model)?.context_window ?? null })}{node ? ` · ${nodeFacts(receipt)}` : ''}</span>}
      {canUndo && undoRefused && <button className="thread-btn turn-keep" aria-disabled="true" data-testid="undo-run" data-refused="true" title={undoRefused} aria-label={`Undo file changes (${changed}): ${undoRefused}`}
                                         onClick={() => setNotice(undoRefused)}>Undo file changes ({changed})</button>}
      {canUndo && !undoRefused && <button className="thread-btn turn-keep" disabled={undoing} data-testid="undo-run" title="Put the files this run wrote with its tools back as they were before it (a file changed since is left alone). What its commands changed is not undone."
                          onClick={() => void undo()}>{undoing ? 'Undoing…' : `Undo file changes (${changed})`}</button>}
      {/* a failed run's words are on its failure card above; a run that ended otherwise with an error says it here */}
      {run.error && run.status !== 'error' && <span className="err small">{run.error}</span>}
    </div>
  )
}

/** A step's state under its newest run (an earlier run of the step keeps its own) and — a candidate whose run changed
 *  files — Keep: in the thread's footer and on the participant's card alike. */
export function NodeStepFoot({ runId, receipt, turn }: { runId: string; receipt: Receipt | null; turn: InteractionTurn }) {
  const setNotice = useStore((s) => s.setNotice)
  const showToast = useStore((s) => s.showToast)
  const adoptNode = useStore((s) => s.adoptNode)
  const replaying = useStore((s) => s.replaying)
  const session = useStore((s) => s.session)
  const [adopting, setAdopting] = useState(false)
  const step = turn.node.run_id === runId ? turn.node : null
  const cp = receipt?.produced?.final_checkpoint_id ?? null
  const { workspace } = useInteractionWorkspace(turn.node.workspace_id)
  const canKeep = step !== null && !replaying && (receipt?.produced?.files_changed?.length ?? 0) > 0 && adoptable(turn.interaction, step, session?.workspace?.id ?? null, workspace)
  const keep = async () => {
    if (!step) return
    setAdopting(true)
    try { setNotice(await adoptNode(turn.interaction.id, step.id)) } catch (e) { showToast(e instanceof Error ? e.message : String(e)) } finally { setAdopting(false) }
  }
  if (!step) return null
  return (
    <>
      <span className={`pill ${step.status === 'waiting' ? 'stale' : step.status}`} data-testid="node-state">{nodeState(step)}</span>
      {canKeep && <button className="thread-btn primary turn-keep" disabled={adopting} data-testid="node-adopt" title="Compose this step's final state into the working folder: checked first, written only while the folder still stands at the starting point"
                          onClick={() => void keep()}>{adopting ? 'Adopting…' : `Keep ${participantName(turn.interaction, step.participant)}${cp ? ` · apply ${cp.slice(0, 7)}` : ''}`}</button>}
    </>
  )
}

/** What the agent did between two of its words, folded into one row (after oasis's WorkGroup and beautiful-ui's
 *  Tool Chips): how many tools were called, how many were refused, whether any failed, the last line; open, the
 *  rows; under a finished round's last group, what the round changed. Open by default in the latest or live turn. */
export function WorkGroup({ entries, live, opened, receipt }: { entries: ThreadEntry[]; live: boolean; opened: boolean; receipt: Receipt | null }) {
  const [chosen, setChosen] = useState<boolean | null>(null)
  const open = chosen ?? opened
  const onToggle = () => setChosen(!open)
  const tools = entries.filter((e) => e.kind === 'activity').length
  const refused = entries.filter((e) => e.kind === 'activity' && refusedStatus(e.status)).length
  const gates = entries.filter((e) => e.kind === 'gate').length
  const errors = entries.filter((e) => e.kind === 'error').length
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
  const summary = [plural(tools, 'tool call'), refused ? `${refused} refused` : null, gates ? `${gates} awaiting approval` : null].filter(Boolean).join(' · ')
  const shared = useSharePresentation()
  const last = [...entries].reverse().find((e) => e.kind === 'activity' || e.kind === 'note')
  const lastLine = last ? (last.kind === 'activity' ? `${last.tool} ${rowLine(last, shared)}` : last.text ?? '') : ''
  // what the round generated is its result: shown under the folded round too (open, each under its own row); the
  // share's copy: the generated pictures the snapshot carried after the call, never a result it did not have
  const generated = shared
    ? entries.flatMap((e) => (e.kind === 'activity' && e.toolCallId ? sharedPictures(shared, shared.tool(e.toolCallId), 'generated').shown : []))
    : entries.flatMap((e) => (e.kind === 'activity' && e.tool === 'generate_image' && e.result?.generated === true ? shownImagesOf(e.result) : []))
  return (
    <div className={`work${open ? ' open' : ''}${live ? ' live' : ''}`}>
      <button className="work-head fold" onClick={onToggle} aria-expanded={open} title={open ? 'Fold this round' : 'Open this round'}>
        {open ? <ChevronDownIcon size={11} /> : <ChevronRightIcon size={11} />}
        <span className="work-summary">{summary}{live ? ' · running' : ''}</span>
        {errors > 0 && <span className="work-failed">{plural(errors, 'error')}</span>}
        {!open && lastLine && <span className="work-last">{lastLine}</span>}
      </button>
      {open && <div className="work-body">{entries.map((e, i) => <Row key={e.eventId ?? e.toolCallId ?? i} entry={e} />)}</div>}
      {!open && generated.length > 0 && <GeneratedImages images={generated} />}
      {open && receipt && <WorkChanges receipt={receipt} />}
    </div>
  )
}

/** What a finished round did to the workspace, measured (after beautiful-ui's diff chips): one chip per file the
 *  run changed with its own counts — hovered or focused, the file's patch (a new SVG as its picture); pressed, the
 *  file whole on the Workspace card, as the run left it — the
 *  checkpoints it left, what was refused. Every word here comes from the receipt and its measured patch, none
 *  from the agent. */
function WorkChanges({ receipt }: { receipt: Receipt }) {
  const showChange = useStore((s) => s.showChange)
  const [all, setAll] = useState(false)
  const measured = useRunDiff(receipt.run_id, (receipt.produced?.files_changed ?? []).length > 0)
  const [preview, setPreview] = useState<{ path: string; x: number; top?: number; bottom?: number } | null>(null)
  const files = receipt.produced?.files_changed ?? []
  const m = receipt.mechanical
  const shown = all ? files : files.slice(0, 6)
  // partial or unavailable: said beside the changes; an unavailable run's empty list is never "unchanged"
  const attribution = attributionOf(receipt)
  if (files.length === 0 && m.checkpoints.length === 0 && m.refused_calls === 0 && attribution.kind === 'exact') return null
  const counts = new Map((measured?.files ?? []).map((f) => [f.path, f]))
  const open = (path: string) => (event: React.SyntheticEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const below = rect.bottom + 6 + 320 <= window.innerHeight - 12
    setPreview({ path, x: Math.max(12, Math.min(rect.left, window.innerWidth - 392)), ...(below ? { top: rect.bottom + 6 } : { bottom: window.innerHeight - rect.top + 6 }) })
  }
  const close = (path: string) => () => setPreview((p) => (p?.path === path ? null : p))
  return (
    <div className="work-changes" data-testid="work-changes">
      {shown.map((path) => {
        const c = counts.get(path)
        if (mediaKind(path) !== null) return <MediaChip key={path} path={path} />
        return (
          <button key={path} type="button" className="change-chip" title={path} aria-label={`Show the change to ${path}`} data-testid="change-chip"
                  onMouseEnter={open(path)} onMouseLeave={close(path)} onFocus={open(path)} onBlur={close(path)}
                  onClick={() => { setPreview(null); showChange({ run_id: receipt.run_id, path }); raiseWorkspaceCard() }}>
            <span className="change-name">{path}</span>
            {c && <span className="change-delta add">+{c.added ?? '?'}</span>}
            {c && (c.removed ?? 0) > 0 && <span className="change-delta del">−{c.removed}</span>}
          </button>
        )
      })}
      {files.length > shown.length && <button className="work-more" onClick={() => setAll(true)}>+{files.length - shown.length} more</button>}
      {!measured && attribution.kind !== 'unavailable' && m.diff && (m.diff.added != null || m.diff.removed != null) && <span className="work-note"><span className="change-delta add">+{m.diff.added ?? '?'}</span> <span className="change-delta del">−{m.diff.removed ?? '?'}</span></span>}
      {files.length === 0 && m.checkpoints.length === 0 && attribution.kind === 'exact' && <span className="work-note">read only · workspace unchanged</span>}
      <AttributionMark view={attribution} />
      {m.refused_calls > 0 && <span className="change-chip refused">{m.refused_calls} refused</span>}
      {m.checkpoints.length > 0 && <span className="work-rev" title={m.checkpoints.join(', ')}>→ {m.checkpoints[m.checkpoints.length - 1]}</span>}
      {preview && measured && createPortal(<ChangePreview path={preview.path} measured={measured} style={{ left: preview.x, top: preview.top, bottom: preview.bottom }} />, document.body)}
    </div>
  )
}

type RunDiff = { files: { path: string; added: number | null; removed: number | null }[]; patches: Map<string, FilePatch> }
const runDiffs = new Map<string, Promise<RunDiff | null>>()

/** A finished run's measured patch, asked once per run (it never changes) and cut per file. */
function useRunDiff(runId: string, wanted: boolean): RunDiff | null {
  const [value, setValue] = useState<RunDiff | null>(null)
  useEffect(() => {
    if (!wanted) return
    let alive = true
    let pending = runDiffs.get(runId)
    if (!pending) {
      pending = api.runDiff(runId).then((d) => ({ files: d.files, patches: filePatches(d.patch) }), () => { runDiffs.delete(runId); return null })
      runDiffs.set(runId, pending)
    }
    void pending.then((d) => { if (alive) setValue(d) })
    return () => { alive = false }
  }, [runId, wanted])
  return value
}

const PREVIEW_LINES = 60

function ChangePreview({ path, measured, style }: { path: string; measured: RunDiff; style: React.CSSProperties }) {
  const file = measured.patches.get(path)
  const c = measured.files.find((f) => f.path === path)
  const svg = createdSvg(path, file)
  const lines = (file?.lines ?? []).filter((l) => !(file?.created && l.tone === 'hunk'))
  return (
    <div className="change-preview" style={style} data-testid="change-preview">
      <div className="change-preview-head"><span className="change-preview-name">{path}</span>
        {c && <span><span className="change-delta add">+{c.added ?? '?'}</span>{(c.removed ?? 0) > 0 && <span className="change-delta del"> −{c.removed}</span>}</span>}</div>
      {svg && <div className="change-preview-img"><img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`} alt={path} /></div>}
      {!svg && file?.binary && <p className="change-preview-note">a binary file</p>}
      {!svg && !file?.binary && (
        <div className="change-preview-body">
          {lines.slice(0, PREVIEW_LINES).map((l, i) => (
            <div key={i} className={`pl ${l.tone}`}><span className="pl-sign">{l.tone === 'add' ? '+' : l.tone === 'del' ? '−' : ''}</span><span className="pl-text">{l.text}</span></div>
          ))}
          {lines.length > PREVIEW_LINES && <p className="change-preview-note">{lines.length - PREVIEW_LINES} more lines — the Workspace card has the whole patch</p>}
          {!file && <p className="change-preview-note">no change to this file in the measured patch</p>}
        </div>
      )}
    </div>
  )
}

/** A live run's line under its rows: its bot as it plays now (working while a tool runs, thinking while its model
 *  speaks or is waited for) and the same word the run's card and the outline say. */
export function LiveLine({ bot, state, who, waiting = null, runId }: { bot: string | null; state: BotState; who?: string | null; waiting?: RunWaiting | null; runId?: string }) {
  const cancelRun = useStore((s) => s.cancelRun)
  const stopExecution = useStore((s) => s.stopExecution)
  const showToast = useStore((s) => s.showToast)
  const replaying = useStore((s) => s.replaying)
  // the share's copy (the live link's page): the run's state only — nothing that would stop or cancel it
  const shared = useSharePresentation()
  const word = liveWord(state, waiting)
  const fail = (e: unknown) => showToast(e instanceof Error ? e.message : String(e))
  // the commands holding the folder: stopped by their execution ids (a run that ended may leave one writing)
  const commands = waiting?.blocking_kind === 'command' ? waiting.blocking_execution_ids : []
  return (
    <div className={`activity-line live${waiting ? ' waiting' : ''}`} data-state={waiting ? 'waiting' : state} data-testid="live-line" title={waiting ? waitingTitle(waiting) : undefined}>
      {bot ? <BotImage bot={bot} state={waiting ? 'waiting' : state} className="turn-bot live-bot" /> : <SparklesIcon size={12} />}
      <span>{who ? `${who} ${word}` : word}</span>
      {/* a run waiting for its folder can be given up before it starts */}
      {commands.length > 0 && !replaying && !shared && <button className="thread-btn live-cancel" data-testid="waiting-stop-command" title={commands.join(', ')}
                                                     onClick={() => void Promise.all(commands.map((id) => stopExecution(id))).catch(fail)}>Stop command{commands.length > 1 ? 's' : ''}</button>}
      {waiting && runId && !replaying && !shared && <button className="thread-btn danger live-cancel" data-testid="waiting-cancel" onClick={() => void cancelRun(runId).catch(fail)}>Cancel</button>}
    </div>
  )
}

/** A live run's line where the view holds no state of its own (a card's conversation): its bot's state read here. */
export function RunLiveLine({ bot, run, entries }: { bot: string | null; run: PresenceRun & { waiting?: unknown }; entries: ThreadEntry[] }) {
  return <LiveLine bot={bot} state={useRunPresence(run)} waiting={liveWaiting(run, entries)} runId={run.id} />
}

/** One row of a round: the registry's renderer hint decides the line; a tool nobody designed a row for still gets
 *  the generic one. A row the stream did not change is the same entry and is not drawn again. */
export const Row = memo(function Row({ entry }: { entry: ThreadEntry }) {
  const [open, setOpen] = useState(false)
  const shared = useSharePresentation()
  // the share's copy: a picture the snapshot carried with no call before it to stand under, where it stood
  if (shared && entry.eventName === SHARE_PICTURE_ROW && entry.eventId) return <SharedPictureRow pictureKey={entry.eventId} />
  if (entry.kind === 'thinking') return <ThinkingRow text={entry.text ?? ''} />
  if (entry.steer) return <SteerRow entry={entry} />
  if (entry.kind === 'ui') return <UiSurfaceBlock entry={entry} />
  if (entry.kind === 'input') return entry.input ? <UiInputBlock record={entry.input} /> : null
  if (entry.kind === 'note' || entry.kind === 'system') return <div className={`activity-line row ${entry.kind}`} data-event={entry.eventName}><LayersIcon size={12} /><span>{entry.text}</span></div>
  if (entry.kind === 'error') return <div className="thread-error row error" data-event={entry.eventName}>{entry.text}</div>
  if (entry.kind === 'gate') return <div className="activity-line row gate" data-event="action_gated"><ShieldIcon size={12} /><span>{entry.text} — review it in Workspace → approvals</span></div>
  // the share's copy reads the snapshot's view of the call (its sanitized target, its pictures), never a result
  const view = shared && entry.toolCallId ? shared.tool(entry.toolCallId) : null
  const r = shared ? {} : entry.result ?? {}
  const status = entry.status ?? (entry.running ? 'running' : 'ok')
  const refused = refusedStatus(status)
  // computer use: the look the agent got, kept as an image of the session
  const shots = shared ? sharedPictures(shared, view, 'screenshot') : null
  const made = shared ? sharedPictures(shared, view, 'generated') : null
  const shot = shared ? (shots!.shown[0]?.asset_id ?? null) : screenshotAssetId(r)
  // a command that ran with less access than asked: where it actually ran, the harness's reasons on hover
  const access = !shared && entry.tool === 'bash' ? commandAccess({ ...(entry.detail ?? {}), ...r }) : null
  const accessLabel = access ? commandAccessLabel(access) : null
  return (
    <div className={`activity row activity${entry.running ? ' running' : ''}${refused ? ' refused' : ''}${open ? ' open' : ''}`} data-tool={entry.tool} data-status={status}>
      <button className={`activity-line expandable${entry.running ? ' running' : ''}`} onClick={() => setOpen((v) => !v)} title={open ? 'Hide the record' : 'Show the record'}>
        <ToolGlyph tool={entry.tool} />
        <span className="tool">{entry.tool}</span>
        <span className="line">{rowLine(entry, shared)}</span>
        {shot && <span className="activity-shot-mark" title="a screenshot of the page"><ImageIcon size={11} /></span>}
        {refused && <span className="pill error">refused</span>}
        {access && accessLabel && <span className="pill cancelled" data-testid="command-access" data-access={access.effective ?? undefined} data-restricted={access.restricted || undefined} title={commandAccessTitle(access)}>{accessLabel}</span>}
        {open ? <ChevronDownIcon size={11} /> : <ChevronRightIcon size={11} />}
      </button>
      {open && (shots ? shots.shown.map((p) => <ScreenshotOf key={p.asset_id} assetId={p.asset_id} />) : shot && <ScreenshotOf assetId={shot} />)}
      {made ? <GeneratedImages images={made.shown} /> : entry.tool === 'generate_image' && r.generated === true ? <GeneratedImages images={shownImagesOf(r)} /> : <ShownImages images={shownImagesOf(r)} />}
      {shots && made && [...shots.omitted, ...made.omitted].map((o) => <PictureOmitted key={o.key} line={o.line} />)}
      {!shared && entry.tool === 'open_ssh_session' && typeof r.session_id === 'string' && <OpenedSession sessionId={r.session_id} />}
      {open && <CallDetail entry={entry} />}
    </div>
  )
})

/** The session an agent opened on an SSH host: one click away. */
function OpenedSession({ sessionId }: { sessionId: string }) {
  const openSession = useStore((s) => s.openSession)
  const showToast = useStore((s) => s.showToast)
  return <button className="thread-btn opened-session" onClick={() => void openSession(sessionId).catch((e) => showToast(e instanceof Error ? e.message : String(e)))} data-testid="opened-session">Open session</button>
}

/** A screenshot computer use took, as the agent saw it (opened whole in a tab of its own). */
function ScreenshotOf({ assetId }: { assetId: string }) {
  const sessionId = useStore((s) => s.session?.id ?? null)
  // the share's copy: the page's own re-encoded picture, nothing to open elsewhere
  const shared = useSharePresentation()
  if (shared) {
    const picture = shared.picture(assetId)
    return picture?.kind === 'shown' ? <span className="activity-shot" data-testid="activity-shot"><img src={picture.src} alt="the page as the agent saw it" width={picture.width} height={picture.height} /></span> : null
  }
  if (!sessionId) return null
  const url = attachmentUrl(sessionId, assetId)
  return <a className="activity-shot" href={url} target="_blank" rel="noreferrer" data-testid="activity-shot"><img src={url} alt="the page as the agent saw it" loading="lazy" /></a>
}

function ThinkingRow({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={`thinking row${open ? ' open' : ''}`} onClick={() => setOpen((v) => !v)} title={open ? 'Fold' : 'Read it whole'}>
      {thinkingParts(text).map((p, i) => (p.title ? <span key={i} className="thinking-title">{p.text}</span> : <Fragment key={i}>{p.text}</Fragment>))}
    </div>
  )
}

/** A row's line: in the app, read from the call's arguments and result; in the share's copy, the snapshot's own
 *  sanitized target (the call's arguments and result are not in the snapshot: the line is never rebuilt from them). */
function rowLine(e: ThreadEntry, shared: SharePresentation | null): string {
  if (!shared) return activityLine(e)
  return (e.toolCallId ? shared.tool(e.toolCallId)?.line : null) ?? ''
}

/** The pictures of a call in the share's copy, of one origin: those carried (as the product's image components take
 *  them) and those the export left out (said as a line, never dropped). */
function sharedPictures(shared: SharePresentation, view: ShareToolView | null, origin: 'screenshot' | 'generated'): { shown: ShownImage[]; omitted: { key: string; line: string }[] } {
  const shown: ShownImage[] = []
  const omitted: { key: string; line: string }[] = []
  for (const p of view?.pictures ?? []) {
    if (p.origin !== origin) continue
    const picture = shared.picture(p.key)
    if (picture?.kind === 'shown') shown.push({ asset_id: p.key, width: picture.width, height: picture.height, label: picture.label })
    else if (picture) omitted.push({ key: p.key, line: `${picture.label} — ${picture.why}` })
  }
  return { shown, omitted }
}

function PictureOmitted({ line }: { line: string }) {
  return <div className="activity-line row note" data-event="share_picture_omitted"><ImageIcon size={12} /><span>{line}</span></div>
}

/** A picture of the share's copy on its own row (no call before it): shown as a generated image is, or its line. */
function SharedPictureRow({ pictureKey }: { pictureKey: string }) {
  const shared = useSharePresentation()
  const picture = shared?.picture(pictureKey) ?? null
  if (!picture) return null
  if (picture.kind === 'omitted') return <PictureOmitted line={`${picture.label} — ${picture.why}`} />
  return <GeneratedImages images={[{ asset_id: pictureKey, width: picture.width, height: picture.height, label: picture.label }]} />
}

/** A picture the person sent, in the share's copy (an attachment strip): the page's re-encoded picture, or a card
 *  saying why it is not carried. */
export function SharedAttachment({ pictureKey }: { pictureKey: string }) {
  const shared = useSharePresentation()
  const picture = shared?.picture(pictureKey) ?? null
  if (!picture) return null
  if (picture.kind === 'omitted') return <div className="attachment-card is-local" data-testid="attachment-omitted"><strong>{picture.label}</strong><small>{picture.why}</small></div>
  // the app's image attachment is a link to the picture; here an anchor with no address (the same box, nothing to open)
  return <a data-testid="attachment-image" title={picture.label}><img src={picture.src} alt={picture.label} width={picture.width} height={picture.height} /></a>
}

function activityLine(e: ThreadEntry): string {
  if (e.forming) return formingLine(e)
  const a = (e.args ?? {}) as Record<string, unknown>
  const r = (e.result ?? {}) as Record<string, unknown>
  const s = (v: unknown) => (v == null ? '' : String(v))
  if (refusedStatus(e.status)) return s(r.summary || r.message || r.reason)
  // a call the run's stop or end came before or under: the row says so instead of a result it never had
  const ended = e.status === 'cancelled' || e.status === 'interrupted' ? ` · ${e.status}` : ''
  switch (e.tool) {
    case 'read_file': return `${s(a.path) || '.'}${r.kind === 'image' ? ` · image ${s(r.width)}×${s(r.height)}` : r.lines ? ` · lines ${s(r.lines)}` : r.count != null ? ` · ${s(r.count)} files` : ''}${r.truncated ? ' · more' : ''}${ended}`
    case 'write_file': case 'edit_file': return `${s(r.op) || (e.tool === 'write_file' ? 'write' : 'edit')} ${s(a.path)}${ended}`
    case 'bash': return `${s(a.command)}${r.exit_code != null ? ` · exit ${s(r.exit_code)}` : e.running ? '' : ` · ${s(r.status)}`}${r.duration_ms != null ? ` · ${s(r.duration_ms)} ms` : ''}${r.truncated ? ' · log capped' : ''}`
    case 'bash_output': return `${s(a.execution_id)} ${s(a.stream ?? 'stdout')} @${s(a.offset ?? 0)}`
    case 'stop_command': return `${s(a.execution_id)}${r.stopped != null ? (r.stopped ? ' · stopped' : ' · was not running') : ''}`
    case 'web_search': return `${searchLine(a)}${r.results != null ? ` · ${s(r.results)} result(s)` : ''}${r.engine ? ` · ${s(r.engine)}` : ''}`
    case 'computer_observe': case 'computer_act': return computerLine(a, r)
    case 'request_input': return `${s(a.title)}${r.status ? ` · ${s(r.status)}` : e.running ? ' · waiting for your answer' : ''}${ended}`
    case 'return_ui_result': return `${a.ok === false ? 'reported a failure' : 'sent a result'} to the surface${r.status && r.status !== 'ok' ? ` · ${s(r.status)}` : ''}`
    case 'generate_image': return `${s(a.prompt) || s(e.summary)}${ended}`
    case 'ssh_connect': return `${s(a.name) || s(a.destination) || s(a.target_id)}${r.status ? ` · ${s(r.status)}` : e.running ? ' · waiting for your answer' : ''}${ended}`
    case 'ssh_directories': return `${s(r.path) || s(a.path) || '/'}${Array.isArray(r.directories) ? ` · ${r.directories.length} folder(s)` : ''}${ended}`
    // the live stream's result is the call's summary; a stored transcript's is the whole answer
    case 'open_ssh_session': return `${s(r.summary) || (r.host ? `${s(r.host)}: ${s(r.path)}` : s(a.path))}${ended}`
    case 'forward_port': return `${s(r.summary) || (r.local_url ? `${s(r.remote_port)} → ${s(r.local_url)}` : s(a.remote_port))}${ended}`
    case 'fetch_url': return `${s(a.url)}${r.kind ? ` · ${s(r.kind)}` : ''}${r.bytes != null ? ` · ${s(r.bytes)} B` : ''}${e.status && e.status !== 'ok' ? ` · ${s(e.status)}` : ''}`
    default: return e.summary ?? ''
  }
}

/** An attachment of a message: an image as itself; a file as a card — a download, or, for a file of this computer the
 *  harness reads where it lies, its path as it was attached (a live reference: no download, the harness never serves
 *  a file of this computer). */
export function AttachmentCard({ attachment: a, sessionId }: { attachment: Attachment; sessionId: string }) {
  // the share's copy: the attachment is an image item of the snapshot, by its key
  const shared = useSharePresentation()
  if (shared) return <SharedAttachment pictureKey={a.asset_id} />
  const card = attachmentCard(a, sessionId)
  if (!card.href) {
    return <div className="attachment-card is-local" title={`${a.name} — ${card.location ?? ''}`} data-testid="attachment-local">
      <strong>{a.name}</strong><small>{card.line}</small><code className="attachment-location" data-testid="attachment-location">{card.location}</code>
    </div>
  }
  return <a className={'file_kind' in a ? 'attachment-card' : undefined} href={card.href} target="_blank" rel="noreferrer" title={a.name}>
    {'file_kind' in a ? <><strong>{a.name}</strong><small>{card.line}</small></> : <img src={card.href} alt={a.name} loading="lazy" />}
  </a>
}
