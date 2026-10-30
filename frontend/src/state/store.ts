import { resourceTarget, sessionTarget, taskTarget, type TargetRef } from '../api/ssh'
import { allows, requireRemote, sameTarget } from './ssh'
import { handshake } from './handshake'
import { mentionsOf, participantsOf } from './entities'
import { activeRelay, relaysChanged, relayTurnOf, type Relay } from './relay'
import { activeInteractions, adoptable, nextRound, noteCandidates, interactionsBehind, interactionsChanged, interactionTurnOf, type GroupPolicy, type InteractionDetail, type Orchestration } from './interaction'
import { watchesChanged } from './watches'
import { isThreadRow } from './lineage'
import type { UndoResult } from '@oasis-code/contract'
import { destinationRefusal, admit, fileRefOf, MAX_IMAGES, prepareAttachment, removeWaitingFile, sendAttachment, uploadAttachments, nameOf, type PendingImage, type SendWays } from './attachments'
import { measureImage, readDraggedImage, readyFromDragged, takeDraggedImage, type DraggedImage } from './imageDrag'
import { ChunkedUploadError, dropUpload, uploadInChunks } from './chunkedUpload'
import { localAttacher } from './desktop'
import { composerOf as composerOfPlace, forgottenComposer, START_COMPOSER, switchedComposer, withComposer as withComposerOfPlace, type ComposerDraft } from './composers'
import { pendingSendKeys, signatureOf } from './sendKey'
import { projectForFolder, sessionTitle, targetLabel, type TaskTarget } from './rail'
import { readSeen, seenAfterLook, seenAfterSummary, writeSeen, type SeenState } from './sessionDots'
import { participantThinking, type ThinkingLevel } from './accounts'
import { create } from 'zustand'
import { CHATGPT_WEB_ID, isQueuedFollowup, MAX_CITATIONS, MAX_RECEIVED_RUNS, type QueuedFollowup } from '@oasis-code/contract'
import { ApiError, api } from '../api/client'
import { closeSessionStream, openSessionStream, subscribeDirectorTurn, subscribeRunEvents } from '../api/sse'
import { createRefresher } from './refresher'
import type {
  ActionProposal, Approval, BuildInfo, DiffResponse, DirectorDetail, DirectorLiveTurn, DirectorNote, DirectorOpenBody, DirectorUpdateBody, ImportRefusal,
  ModelEntry, Project, Run, RunControl, RunTreeRow, SessionActivity, SessionDetail, SSEItem, WorkspaceDetail,
} from '../api/types'
import { directorTarget, targetOf, type ComposerTarget } from './director'
import { forgetTarget, rememberedTarget, rememberTarget } from './composerTargets'
import { sourceMount, taskFieldsChanged } from './workspacePolicy'
import { loadedTarget, messageDestination } from './messageTarget'
import { chatGptDirectorBody, startChatGptPage } from './chatgpt'
import { besideChanged, hasChanges, joinNewRuns, sessionDelta } from './sync'
import { identityTable, runAfterQueueEvents, setIdentities } from './outline'
import { endedRecord, mergeTree, treeAfter } from './presence'
import { frameBatch } from './frameBatch'
import { adoptedSurface, applyEvent, crossSurfaceOf, fromTranscript, screenSurfaceEvent, withKnownSurfaces, withSurfaces, type ThreadEntry } from './thread'
import { admitSessionRecord, isSurfaceRecord, placeOnce, withPromptInDraft, type RunFacts, type SessionFacts, type ActionSnapshot, type UiState, type UiSurfaceRecord } from './uiSurface'
import { UiTaskRecordSchema, type SteerResponse, type UiActionResponse, type UiInputRecord, type UiTaskRecord } from '@oasis-code/contract'
import { inputSupersedes, isInputRecord, upsertInput } from './uiInputs'
import { surfaceTasks } from './uiTasks'
import { activeRunMoved, adoptSteers, isSteerRecord, putBackDraft, readPendingSteers, steerErrorText, steerNotTaken, steerRefusal, writePendingSteers, type PendingSteer } from './steer'
import { keyFor } from './sendKey'
import { EMPTY_COLLAB, answerOf, openCollab, reduceCollab, wantsReload, type CollabState } from './collabSync'
import type { CollaborationGraph } from '@oasis-code/contract'
import type { AccessMode, HarnessMode } from '@oasis-code/contract/modes'
import type { SettingsTab } from './settings'
import { accessActivityKey, accessStateOf, blockedHint, blockersOf, sessionAccess, type AccessState } from './access'
import { backgroundChanged, keepBackground } from './backgroundCommands'

/** What the Workspace card's code view shows: a file's change, as one run left it (`run_id`) or as the session stands
 *  (null); no file picked yet: the first. */
export interface ChangeView { run_id: string | null; path: string | null }

let openTicket = 0
let directorTicket = 0
let composerTargetRevision = 0
const draftRevisions = new Map<string, number>()
let refreshTicket = 0
let surfaceTicket = 0

/** A session surface's record is shown only when the runs the page knows of it may present one (uiSurface.ts: the page's
 *  check, the harness's word for a run the page does not know). `runs`: the page's rows — the session's runs, the tree. */
const admitWith = (runs: ReadonlyArray<RunFacts>, session: SessionFacts | null | undefined) =>
  (record: UiSurfaceRecord): boolean => admitSessionRecord(record, (id) => runs.find((r) => r.id === id), session)
let inputTicket = 0
let taskTicket = 0
/** the receipts whose prompt this page placed in a draft: a retry answered with the same receipt places it once */
const placedReceipts = new Set<string>()
/** one refresh of the workspace at a time; a request that lands while one is running is served once after it */
let refreshing: Promise<void> | null = null
// finished children whose stored conversation is being read, and those read already: a finished run's record does not
// change, and the desk asks again on every change of the tree
const transcriptsReading = new Set<string>()
const transcriptsRead = new Set<string>()
let refreshAgain = false
const STORAGE = { sidebarWidth: 'oasis-code.sidebarWidth' }
const RAIL_MIN = 200
const RAIL_MAX = 420

function readSidebarWidth(): number {
  try {
    const stored = Number(localStorage.getItem(STORAGE.sidebarWidth))
    if (Number.isFinite(stored) && stored >= RAIL_MIN && stored <= RAIL_MAX) return stored
  } catch { /* no storage */ }
  return 260
}
/** events after which the session's run tree has changed */
const TREE_EVENTS = new Set(['run_continued', 'run_finished', 'integration'])
/** a run waiting for its folder, then going on: the tree's rows (and their bots) are read again */
const QUEUE_EVENTS = new Set(['run_queued', 'slot_acquired'])
const LIVE_STATUSES = new Set(['queued', 'running'])
/** how many finished runs' transcripts one opening of a session reads at once (each opening its own; a session with
 *  hundreds of turns was read one after another) */
const OPENING_TRANSCRIPT_READS = 8
/** how often the page asks the harness whether another client (the director endpoint) changed the open session
 *  or added a session to the rail */
const SYNC_MS = 3000
const PROJECTS_EVERY_TICKS = 4
// what this page changed of the open session since a sync began (a rename): a sync that was already on its way does
// not put the old title back
let sessionEdits = 0
// the page's own changes of the open session's grants and mode (Permissions: Turn on, Switch to Auto): moved when one
// leaves and when its answer comes, with the ones still on their way by the opening they were asked in (a change of a
// session left, or of an earlier opening of this one, holds back nothing of the current one). A read that left before
// such a change, or lands while one is on its way, may have been answered before the change was made: it says nothing
// of the grants or the control (the change's own answer does); the rest of what it read is taken
let grantsGen = 0
const grantsPending = new Map<number, number>()
// the grants changes asked (in order) and the latest whose answer the page took: an earlier one answered late never
// puts back what a later one changed
let grantsAsked = 0
let grantsTaken = 0
/** what the page had changed when a read or change of the open session left */
interface Edits { title: number; grants: number }
const editsNow = (): Edits => ({ title: sessionEdits, grants: grantsGen })
/** a change of the open session's grants or mode made since the read left, or on its way now */
const grantsMoved = (edits: Edits): boolean => edits.grants !== grantsGen || (grantsPending.get(openTicket) ?? 0) > 0
/** The session as the harness answered, with the title this page gave it since the request left (if it did) and,
 *  unless the answer is that of the page's own grants change, the grants it changed meanwhile. */
function adoptSession(answered: SessionDetail, edits: Edits, current: SessionDetail | null, ownChange = false): SessionDetail {
  if (!current || current.id !== answered.id) return answered
  let adopted = answered
  if (edits.title !== sessionEdits) adopted = { ...adopted, title: current.title }
  if (!ownChange && grantsMoved(edits)) adopted = { ...adopted, grants: current.grants }
  // the background commands as the page holds them when the answer names the same ones: the header's count keeps its
  // reference (nothing draws again for a read that moved nothing)
  return keepBackground(current, adopted)
}
/** A change of the open session's grants or mode, asked of the harness: its answer, if it still belongs to the session
 *  shown in the opening it was asked in (another session opened, or this one left and opened again, moves it) and no
 *  later change's answer was taken already; null otherwise. A refusal is the caller's only while the session is shown. */
async function grantsChange<T>(get: () => State, sessionId: string, ask: () => Promise<T>): Promise<{ value: T; edits: Edits } | null> {
  const opening = openTicket
  const asked = ++grantsAsked
  const edits = editsNow()
  const here = () => opening === openTicket && get().session?.id === sessionId
  grantsGen += 1
  grantsPending.set(opening, (grantsPending.get(opening) ?? 0) + 1)
  try {
    const value = await ask()
    if (!here() || asked < grantsTaken) return null
    grantsTaken = asked
    return { value, edits }
  } catch (e) {
    // a refusal of a session left says nothing to the one shown
    if (here()) throw e
    return null
  } finally {
    if (opening === openTicket) grantsGen += 1
    const left = (grantsPending.get(opening) ?? 1) - 1
    if (left > 0) grantsPending.set(opening, left)
    else grantsPending.delete(opening)
  }
}
// the place an access read or change belongs to (a session opened or left moves it) and the latest read asked for
let accessEpoch = 0
let accessRead = 0
/** for a test: what an access read or change of the page belongs to, moved on */
export function resetAccessEpoch(): void {
  accessEpoch += 1
}
let syncing = false
// a read asked for while one was under way (a group's step ended meanwhile): made once that one is in
let syncAgain = false

export interface SendOptions { fresh?: boolean; resumes_run_id?: string | null; budget?: Record<string, number> }
/** A hero send carries its origin through creation/navigation; it never borrows the newly visible composer's state. */
type SendOrigin = Pick<State, 'session' | 'director' | 'composerTarget' | 'modelChoice' | 'directorModel' | 'thinking' | 'mentionThinking' | 'orchestration' | 'relayRounds' | 'interactionMaxRuns' | 'interactionConcurrency' | 'images'> & Partial<Pick<State, 'crossRounds' | 'groupPolicy'>> & { draftRevision?: number }

/** A message to a participant's card: the participant (null: an older harness, which continues the run itself), the
 *  run its conversation stands at (the head the person saw), the words and the model. */
export interface References { cites: { run_id: string }[]; receive: string[] }
const NO_REFERENCES: References = { cites: [], receive: [] }
/** The references as a body carries them (nothing when there are none: an older body is unchanged). */
const referenceBody = (r: References, receive = true) => ({ ...(r.cites.length ? { cites: r.cites } : {}), ...(receive && r.receive.length ? { receive_run_ids: r.receive } : {}) })
export interface ParticipantSend { participantId: string | null; headRunId: string; text: string; model?: string | null; thinking?: ThinkingLevel | null }

interface State {
  build: BuildInfo | null
  buildMismatch: string | null
  /** the page is older than the UI the backend serves: reload (nothing is blocked) */
  staleUi: string | null
  models: ModelEntry[]
  defaultModel: string | null
  projects: Project[]
  /** every session's agents now and how many of their runs ended (GET /api/session-activity; null: not read yet) */
  sessionActivity: Record<string, SessionActivity> | null
  /** what the person saw of each session (state/sessionDots.ts): the rail's green dot is an end after it */
  railSeen: SeenState
  session: SessionDetail | null
  runs: Run[]
  /** the notes a director outside this program posted into the session (its conversation, mirrored) */
  notes: DirectorNote[]
  threads: Record<string, ThreadEntry[]>
  liveRunId: string | null
  /** the session's relays: one message to several agents who take turns on it (the harness schedules the turns) */
  relays: Relay[]
  /** how many rounds the next relay runs (a round: every agent named once, in order) */
  relayRounds: number
  /** the session's interactions: one message to several agents run as a graph of nodes, with their nodes */
  interactions: InteractionDetail[]
  /** how the agents named in the next message work together: the director plans it, each alone, or turns */
  orchestration: Orchestration
  /** the next interaction's limits: runs in all, and at once */
  interactionMaxRuns: number | null
  interactionConcurrency: number
  /** where the composer's words go while an interaction runs: everyone, one participant, or the director */
  noteTo: string
  noteInteractionId: string | null
  /** a replay writes the thread; the live stream and the composer wait */
  replaying: boolean
  workspace: WorkspaceDetail | null
  diff: DiffResponse | null
  changeView: ChangeView
  /** the run whose records page replaces the thread */
  recordsRunId: string | null
  toast: string | null
  modelChoice: string | null
  /** the model the person picked for a native director not opened yet: it opens on it with the first message */
  directorModel: string | null
  disposers: Record<string, () => void>
  /** the session's run tree (every run: the thread's, children, orders a person dispatched, human actions) */
  tree: RunTreeRow[]
  /** the session whose tree has been read since it opened (its first answer, empty or not, is the session as it opened) */
  treeOf: string | null
  /** the rows of runs that are not the thread's own, fed by their own streams (live) or transcripts (finished) */
  childThreads: Record<string, ThreadEntry[]>
  childDisposers: Record<string, () => void>
  /** the rail beside the surfaces: shown, and how wide (remembered per browser) */
  sidebarOpen: boolean
  sidebarWidth: number
  /** the composer's words, kept here so a turn's "ask again" can put them back */
  draft: string
  /** the images waiting in the composer with the words (uploaded to the session when they are sent) */
  images: PendingImage[]
  /** the composers of the places not on show (the sessions left open, the start screen), each keeping its own
   *  words, images and rounds until they are sent or the place is gone; never shown under another */
  composers: Record<string, ComposerDraft>
  /** a quiet message (not an error) and what the app is busy with, in words */
  notice: string | null
  busy: string | null
  /** how hard the model thinks on the next run; null = the provider's default */
  thinking: ThinkingLevel | null
  /** the effort chosen for a model in the @ menu, by its route id: a participant on it runs at that, not at `thinking` */
  mentionThinking: Record<string, ThinkingLevel>
  /** where the start screen's next task goes */
  target: TaskTarget | null
  /** the harness refused to copy the chosen folder (too big): what it measured, until the person attaches it or picks another */
  importRefusal: ImportRefusal | null
  /** the Settings dialog (the rail's launcher, or a failed run's "Open Accounts") and the tab it shows */
  settingsOpen: boolean
  settingsTab: SettingsTab
  /** the session's run control (what its mode set) and the actions proposed for the person's approval */
  control: RunControl | null
  proposals: ActionProposal[]
  /** the open session's access as the harness last said it (whether it can change now, what holds it); null: not read yet */
  access: AccessState | null
  /** a change of the open session's access is on its way (the chip waits for the harness's word; nothing is shown before) */
  accessSaving: boolean
  /** the director session of the open session (the harness holding a conversation with an outside director), its turns and the transports */
  director: DirectorDetail | null
  /** the session's Intelligent UI surfaces as the harness last said them (by run and surface id): what a thread read
   *  later (a finished child's transcript, a run another client started) takes in */
  uiSurfaces: Record<string, UiSurfaceRecord>
  /** request_input's forms of the session's runs as the harness last said them (by input id): pending ones are
   *  listed after a refresh; streams say the rest */
  uiInputs: Record<string, UiInputRecord>
  /** the UI tasks of the session by their agent run's id: such a run is a task's (started from a surface) */
  uiTaskRuns: Record<string, UiTaskRecord>
  /** the director turn streaming now: its text and tool calls so far */
  directorLive: DirectorLiveTurn | null
  directorDisposer: (() => void) | null
  /** the start screen's choice: a director to open with the new session, which then takes the first words */
  /** the ChatGPT page in the middle of the window (signing in, or a look at it) */
  chatGptSheet: boolean
  /** where the composer's words go: the session's agent, or the director */
  composerTarget: ComposerTarget
  /** the session's collaboration graph as the harness served it (state/collabSync.ts); an older harness: none, the
   *  page projects one from its rows (state/collab.ts) */
  collab: CollabState
  /** how a discussion's participants exchange: rounds of reading each other's answers and responding (1–4) */
  crossRounds: number
  /** where the next group's steps work (the interaction body's workspace_policy): the session's own rule (legacy, the
   *  composer's default) or each step isolated (the directors' rule); captured with the message, part of its key */
  groupPolicy: GroupPolicy
  setGroupPolicy: (policy: GroupPolicy) => void
  /** what the thread composer's next message is: a message to the session's main agent (the default), or a separate
   *  task — its own participant, conversation, workspace and card, summarised in the thread */
  sendAs: 'main' | 'separate'
  setSendAs: (way: 'main' | 'separate') => void
  /** the runs the next message refers to: cited (named to the agent; nothing of them sent) and handed over (their
   *  final answers sent whole in the message) — two lists, never one; offered only by a harness that records them */
  references: References
  /** a run cited by the next message, or not any more (a run handed over is not also cited: the later choice wins) */
  toggleReference: (runId: string, kind: 'cite' | 'receive') => void
  clearReferences: () => void
  setCrossRounds: (rounds: number) => void
  /** read the session's collaboration graph (again: with the revision held, a 304 when nothing moved) */
  loadCollab: () => Promise<void>
  /** loadCollab's one read (refresher.ts calls it; the signal aborts it when the session is left) */
  readCollab: (sessionId: string, signal: AbortSignal) => Promise<void>
  /** the draft as a separate task (POST /work-orders, workspace_policy isolated); the run it started. A harness
   *  without the route, or a refusal, keeps the draft and says why — never sent another way instead */
  sendSeparate: (text: string) => Promise<Run | null>
  /** a follow-up on a participant's card: its next message (POST /participants/:id/messages, the head it saw, a key
   *  a retry reuses); an older harness continues the run through /runs/:id/resume */
  /** a follow-up of a participant's head: the Run it started, or the interaction step it waits as (no run yet) */
  continueParticipant: (send: ParticipantSend) => Promise<Run | QueuedFollowup>
  /** read the open session's access (GET /sessions/:id/access): on opening it, on opening the chip, when its activity moves */
  loadAccess: () => Promise<void>
  /** change the open session's access (PUT /sessions/:id/access): only the harness's answer is shown; a refusal (409:
   *  a run, a command or an approval outstanding) keeps the access as it was and says what holds it. true: changed */
  chooseAccess: (mode: AccessMode) => Promise<boolean>

  boot: () => Promise<void>
  loadTree: () => Promise<void>
  /** loadTree's one read (refresher.ts calls it; the signal aborts it when the session is left) */
  readTree: (sessionId: string, signal: AbortSignal) => Promise<void>
  watchChild: (runId: string) => Promise<void>
  /** a run the session's stream heard of first: the tree and the session are read for it (coalesced) */
  discoverRun: (runId: string) => void
  resumeRun: (runId: string, text: string, model?: string | null) => Promise<void>
  cancelRun: (runId: string) => Promise<void>
  /** stop a command by its execution id (one holding the folder a run waits for); false: it was not running */
  stopExecution: (executionId: string) => Promise<boolean>
  loadModels: () => Promise<void>
  loadProjects: () => Promise<void>
  /** every session's activity read again (one read at a time: one asked meanwhile follows it); the session in view as
   *  the answer lands (open, the window visible) is seen up to it — no other */
  loadSessionActivity: () => Promise<void>
  /** the person sees the session with `ended` ends (the rail's green dot goes) */
  markSessionSeen: (sessionId: string, ended: number | null) => void
  createProject: (body: { target?: TargetRef; name?: string; source_path?: string; instructions?: string; mode?: 'snapshot' | 'attached' | 'direct'; no_folder?: boolean; client_request_id?: string }) => Promise<Project>
  /** the refused folder, attached read-only instead: the task starts again with the same words */
  attachRefused: () => Promise<void>
  setImportRefusal: (refusal: ImportRefusal | null) => void
  openSession: (id: string, opts?: { target?: ComposerTarget }) => Promise<void>
  /** back to the start screen; the next task starts in the same project unless the person picks another */
  closeSession: () => void
  renameSession: (id: string, title: string) => Promise<void>
  /** the session leaves the rail (the open one closes to the start screen); the harness refuses one with a run under way */
  deleteSession: (id: string) => Promise<void>
  /** the start screen's send: the project (made from the folder unless one exists), a session titled by the
   *  words, then the words as its first run */
  startTask: (text: string) => Promise<void>
  send: (text: string, opts?: SendOptions, origin?: SendOrigin) => Promise<void>
  /** the words, exactly as written, into the live run's next model request (never a new run): the draft leaves the
   *  composer only once the harness took them; a refusal or a lost answer keeps it (and its key, for a safe resend) */
  steer: (text: string, runId: string) => Promise<void>
  /** a steer record the harness answered with (a send's answer, a list read again): into its run's rows */
  adoptSteer: (record: unknown) => void
  /** a steer record heard by any road (the stream, a list, a transcript): an unconfirmed send of it is confirmed */
  confirmSteer: (record: unknown) => void
  /** the unconfirmed steers, by session (state/steer.ts PendingSteer; mirrored in the page's storage) */
  pendingSteer: Record<string, PendingSteer>
  /** a steer that never reached its run, its words back in the session's composer after what is there */
  putBackSteer: (sessionId: string, text: string) => void
  /** stop the live run — and, when it is a relay's turn, the whole chain */
  stop: (interactionId?: string) => Promise<void>
  setRelayRounds: (rounds: number) => void
  setOrchestration: (mode: Orchestration) => void
  setInteractionLimits: (limits: { max_runs?: number | null; concurrency?: number }) => void
  /** whom a note goes to: the director, or a recipient of one group — named with the group (`interactionId`); with
   *  one group open it may be left out, with several it may not (no group is chosen for the person) */
  setNoteTo: (to: string, interactionId?: string) => void
  /** the person's words to everyone or one participant (queued, handed at its next run); a paused interaction then
   *  continues, a finished one starts another round */
  noteInteraction: (interactionId: string, to: string, text: string) => Promise<void>
  /** the running steps end, nothing new starts; continue goes on */
  pauseInteraction: (interactionId: string) => Promise<void>
  /** one more step by a participant, handed the answers of every step that ended (the person's "ask A to synthesize") */
  askSynthesis: (interactionId: string, participant: string) => Promise<void>
  /** resume a waiting or interrupted relay, or give a finished one more rounds */
  continueRelay: (relayId: string, rounds?: number | null) => Promise<void>
  /** the person cancels a watch the session's agent set: it wakes no one after */
  cancelWatch: (watchId: string) => Promise<void>
  /** a run's file changes undone, in a folder edited in place: what went back, and what was left alone */
  undoRun: (runId: string) => Promise<UndoResult>
  /** resume a waiting or interrupted interaction */
  continueInteraction: (interactionId: string) => Promise<void>
  /** a node's final state composed into the session's folder; what came of it, in the integration's own words */
  adoptNode: (interactionId: string, nodeId: string) => Promise<string>
  /** ask the harness for the open session again and take in what another client changed: new notes, runs it
   *  started (a live one is watched), runs that ended while nothing here watched them */
  syncSession: () => Promise<void>
  /** the ticker behind syncSession (and the rail's projects, less often); returns what stops it */
  startSync: () => () => void
  watchRun: (run: Run, after?: number | null) => void
  refreshEvidence: () => Promise<void>
  /** the file whose change the Workspace card shows (a run's, or the session's with run_id null) */
  showChange: (view: ChangeView) => void
  openRecords: (id: string | null) => void
  setModel: (id: string | null) => void
  /** the native director's model: an open director's is changed; one not opened yet opens on it */
  setDirectorModel: (id: string) => Promise<void>
  setGrants: (body: Record<string, unknown>) => Promise<void>
  /** the open session's mode, changed (Permissions: Switch to Auto): its grants and control, as the harness answers */
  setMode: (mode: HarnessMode) => Promise<void>
  /** the open session's mode read again (the Permissions panel shown): its grants and control */
  loadMode: () => Promise<void>
  decide: (approval: Approval, approve: boolean) => Promise<void>
  showToast: (text: string | null) => void
  setNotice: (text: string | null) => void
  toggleSidebar: () => void
  setSidebarWidth: (width: number) => void
  setDraft: (draft: string) => void
  /** files dropped, pasted or chosen: the acceptable ones join the composer, the others are named in a toast */
  retryImage: (id: string) => void
  addImages: (files: File[]) => void
  /** an image of the thread dropped on the composer (what its drag carries, as text): read from the harness, it joins
   *  the composer it was dropped on — already uploaded when it is that session's own */
  addDraggedImage: (raw: string) => Promise<void>
  removeImage: (id: string) => void
  /** the person stops a file's chunked upload under way (the harness is asked to drop it; the send fails, the draft stays) */
  cancelTransfer: (id: string) => void
  setThinking: (level: ThinkingLevel | null) => void
  setMentionThinking: (model: string, level: ThinkingLevel | null) => void
  setTarget: (target: TaskTarget | null) => void
  /** open Settings (at a tab, else where it was last) or close it */
  setSettingsOpen: (open: boolean, tab?: SettingsTab) => void
  setSettingsTab: (tab: SettingsTab) => void
  refreshGate: () => Promise<void>
  decideProposal: (id: string, decision: 'approve' | 'reject') => Promise<string>
  /** the director session: read it (and follow its live turn), open one, change it, close it, write to it */
  loadDirector: () => Promise<void>
  openDirector: (body: DirectorOpenBody) => Promise<void>
  setChatGptSheet: (open: boolean) => void
  /** ChatGPT on the web as the session's director (the bridge transport, with the oasis-code connector): the words
   *  go to it from now on; a director the session had is closed first */
  directWithChatGpt: () => Promise<void>
  updateDirector: (body: DirectorUpdateBody) => Promise<void>
  closeDirector: () => Promise<void>
  sayToDirector: (text: string, opts?: SendOptions, origin?: SendOrigin) => Promise<void>
  cancelDirectorTurn: (turnId: string) => Promise<void>
  setComposerTarget: (target: ComposerTarget) => void
  watchDirectorTurn: (turnId: string) => void
  /** the session's surfaces from the harness (a hard refresh, a run that ended unwatched): into the threads on the page */
  loadSurfaces: () => Promise<void>
  /** a surface record the harness answered with: into its run's rows (in place; a live run's new surface is its
   *  stream's to place) — only while its session is the one open and no replay holds the thread */
  adoptSurface: (record: UiSurfaceRecord) => void
  /** the person's state of a surface saved at the revision they edited (the request names the surface's own session) */
  saveSurfaceState: (target: Pick<UiSurfaceRecord, 'session_id' | 'run_id' | 'surface_id'>, revision: number, state: UiState) => Promise<UiSurfaceRecord>
  /** a press of an action, as it was pressed, prepared by the harness into a prompt (it runs nothing, starts or resumes
   *  no run); the replay refuses a new one */
  prepareSurfaceAction: (snapshot: ActionSnapshot) => Promise<UiActionResponse>
  /** a prepared prompt into the draft of the session it came from (on show or put away), after what is there — once
   *  per receipt; never sent. False when that receipt was placed already. */
  placeActionPrompt: (sessionId: string, receiptId: string, prompt: string) => boolean
  /** words added to the draft of a session's composer (the one on show, or the one put away), after what is there */
  appendDraft: (sessionId: string, text: string) => void
  /** the session's pending forms from the harness (a hard refresh, a session opened again): into their runs' rows */
  loadInputs: () => Promise<void>
  /** a form's record the harness said (an event, a list, an answer): kept, and into its run's rows */
  adoptInput: (record: unknown) => void
  /** the session's UI tasks (which runs are tasks'), from the harness */
  loadTaskRuns: () => Promise<void>
  /** a task record the harness said: its run is marked as the task's, and the surface's tasks hear it */
  adoptTaskRun: (record: unknown) => void
}

/** Each waiting image uploaded to the session (once: a retry sends only what failed or belongs to another session);
 *  the ids in the composer's order. A failure marks that image with the harness's reason and throws, so the words
 *  and the images stay in the composer. */
// the key of the message last sent and not yet taken: a resend of the very same message reuses it

function prepareImages(added: PendingImage[], owner: string, get: () => State, set: (partial: Partial<State>) => void): void {
    const mark = (id: string, patch: Partial<PendingImage>) => set(withComposer(get(), owner, { images: composerOf(get(), owner).images.map((i) => (i.id === id ? { ...i, ...patch } : i)) }))
    for (const image of added) {
      void (async () => {
        try {
          const patch = await prepareAttachment(image, api.imageToJpeg, () => composerOf(get(), owner).images.some((i) => i.id === image.id))
          if (patch) mark(image.id, patch)
        } catch (e) {
          mark(image.id, { state: 'failed', error: e instanceof ApiError ? e.detail : e instanceof Error ? e.message : String(e) })
        }
      })()
    }
}

/** A dropped image of the thread read from the harness into the waiting entry `id` of the composer of `owner` —
 *  wherever the person has gone since; an entry removed meanwhile stays removed. */
async function readDropped(id: string, ref: DraggedImage, owner: string, get: () => State, set: (partial: Partial<State>) => void): Promise<void> {
  const present = () => composerOf(get(), owner).images.some((i) => i.id === id)
  const mark = (patch: Partial<PendingImage>) => set(withComposer(get(), owner, { images: composerOf(get(), owner).images.map((i) => (i.id === id ? { ...i, ...patch } : i)) }))
  try {
    const read = await readDraggedImage(ref, { fetch: (input, init) => fetch(input, init), measure: measureImage })
    if (!present()) return
    mark(readyFromDragged(ref, read, owner, URL.createObjectURL(read.file)))
  } catch (e) {
    if (present()) mark({ state: 'failed', error: e instanceof Error ? e.message : String(e) })
  }
}

const pendingSends = pendingSendKeys()
const steerStorage = () => { try { return globalThis.localStorage ?? null } catch { return null } }
/** the session activity read under way, and whether one more was asked meanwhile */
let activityReading = false
let activityAgain = false
/** the session the person has in view now: open, in a visible window (null: none, or the window is hidden) */
function sessionInView(get: () => State): string | null {
  const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
  return hidden ? null : get().session?.id ?? null
}
/** how often the rail's activity is read: every tick while the page is in view, every fourth while it is hidden */
const ACTIVITY_HIDDEN_EVERY_TICKS = 4
function setPendingSteer(get: () => State, set: (partial: Partial<State>) => void, sessionId: string, value: PendingSteer | null, onlyKey?: string): void {
  const current = get().pendingSteer[sessionId]
  if (value === null && (!current || (onlyKey !== undefined && current.key !== onlyKey))) return
  const next = { ...get().pendingSteer }
  if (value === null) delete next[sessionId]
  else next[sessionId] = value
  set({ pendingSteer: next })
  writePendingSteers(steerStorage(), next)
}
const pendingStarts = pendingSendKeys()

async function uploadPending(sessionId: string, submitted: PendingImage[], get: () => State, set: (partial: Partial<State>) => void): Promise<string[]> {
  // Upload the accepted payload, not whatever the next draft contains after navigation/awaits.
  let frozen = submitted.map((i) => ({ ...i }))
  const mark = (id: string, patch: Partial<PendingImage>) => {
    const sent = frozen.find((i) => i.id === id)!
    frozen = frozen.map((i) => i.id === id ? { ...i, ...patch } : i)
    set(withComposer(get(), sessionId, { images: composerOf(get(), sessionId).images.map((i) => i.id === id && i.file === sent.file ? { ...i, ...patch } : i) }))
  }
  // a PDF or a video: the desktop app's file where it lies, else a chunked upload (resumed when a send before began
  // one in this session); an image or a text: the one-request upload, as always
  const ways = (pending: PendingImage): SendWays => ({
    local: localAttacher(globalThis as { oasisCodeDesktop?: unknown }, sessionId),
    upload: (file, name) => api.uploadAttachment(sessionId, file, name),
    chunked: async (file, name) => {
      const controller = new AbortController()
      transfers.set(pending.id, controller)
      const resume = pending.transfer?.session_id === sessionId ? pending.transfer : null
      try {
        const answer = await uploadInChunks(file, { name, type: file.type }, api.uploads(sessionId), {
          resume, signal: controller.signal,
          onStart: (s) => mark(pending.id, { transfer: { session_id: sessionId, ...s, sent: 0, total: file.size } }),
          onProgress: (sent, total) => {
            const transfer = frozen.find((i) => i.id === pending.id)?.transfer
            if (transfer) mark(pending.id, { transfer: { ...transfer, sent, total } })
          },
        })
        const ref = fileRefOf(answer, 'upload')
        if (!ref) throw new Error('the harness answered something other than a reference to the uploaded file')
        return ref
      } catch (error) {
        // only an interrupted upload is gone on with, and a cancelled one the harness did not confirm it dropped is
        // kept (removing the file asks again); a dropped, refused or lost one starts over
        if (error instanceof ChunkedUploadError && error.kind !== 'interrupted' && !(error.kind === 'cancelled' && !error.dropped)) mark(pending.id, { transfer: null })
        throw error
      } finally { transfers.delete(pending.id) }
    },
  })
  return uploadAttachments(sessionId, () => frozen, (_file, _name, pending) => sendAttachment(pending, ways(pending)), mark)
}

/** The chunked uploads under way, by the waiting file's id: the person's Cancel aborts one. */
const transfers = new Map<string, AbortController>()

const composerKeyOf = (s: Pick<State, 'session'>): string => s.session?.id ?? START_COMPOSER

const composerOf = (s: State, owner: string): ComposerDraft => composerOfPlace(s, composerKeyOf(s), owner)
const withComposer = (s: State, owner: string, patch: Partial<ComposerDraft>): Partial<State> => withComposerOfPlace(s, composerKeyOf(s), owner, patch)


/** Only the acknowledged message leaves its owner's composer, even after navigation or new typing. */
function clearSentComposer(owner: string, text: string, images: PendingImage[], get: () => State, set: (partial: Partial<State>) => void, revision?: number): void {
  const current = composerOf(get(), owner)
  const sent = new Map(images.map((i) => [i.id, i.file]))
  for (const image of current.images) if (sent.get(image.id) === image.file && image.url) URL.revokeObjectURL(image.url)
  set(withComposer(get(), owner, { draft: current.draft === text && (revision === undefined || revision === (draftRevisions.get(owner) ?? 0)) ? '' : current.draft, images: current.images.filter((i) => sent.get(i.id) !== i.file) }))
}


/** The tree and the graph, read again as the runs move: per session, one read at a time, at most one a second. */
const treeRefresh = createRefresher({ load: (sessionId, signal) => useStore.getState().readTree(sessionId, signal) })
const collabRefresh = createRefresher({ load: (sessionId, signal) => useStore.getState().readCollab(sessionId, signal) })
/** Both reads let go (a session opened or closed): the one under way is aborted, the next ask reads at once. */
/** The open session's activity moved (a run started or ended, a proposal came or was decided): the harness is asked
 *  once whether its access can change now — never on a timer (opening the access chip asks too). */
function watchAccessActivity(): void {
  useStore.subscribe((now, before) => {
    if (!now.session || before.session?.id !== now.session.id) return
    if (accessActivityKey(now) !== accessActivityKey(before)) void now.loadAccess()
  })
}
export function resetRefreshes(): void {
  treeRefresh.reset()
  collabRefresh.reset()
}

export const useStore = create<State>((set, get) => ({
  build: null, buildMismatch: null, staleUi: null, models: [], defaultModel: null, projects: [], sessionActivity: null, railSeen: readSeen(steerStorage()), session: null, runs: [], notes: [], threads: {},
  liveRunId: null, relays: [], relayRounds: 1, interactions: [], orchestration: 'director', interactionMaxRuns: null, interactionConcurrency: 2, noteTo: 'director', noteInteractionId: null, replaying: false, workspace: null, diff: null, changeView: { run_id: null, path: null }, recordsRunId: null, toast: null,
  modelChoice: null, directorModel: null, disposers: {}, tree: [], treeOf: null, childThreads: {}, childDisposers: {},
  sidebarOpen: true, sidebarWidth: readSidebarWidth(), draft: '', images: [], composers: {}, notice: null, busy: null, thinking: null, mentionThinking: {}, target: null, importRefusal: null, settingsOpen: false, settingsTab: 'accounts',
  control: null, proposals: [],
  access: null, accessSaving: false,
  director: null, directorLive: null, directorDisposer: null, composerTarget: 'agent', chatGptSheet: false, uiSurfaces: {}, uiInputs: {}, uiTaskRuns: {},
  pendingSteer: readPendingSteers(steerStorage()),
  collab: EMPTY_COLLAB, crossRounds: 1, groupPolicy: 'legacy', sendAs: 'main', references: NO_REFERENCES,

  boot: async () => {
    try {
      const build = await api.build()
      const { block: mismatch, stale } = handshake(build, __OASIS_CODE_BUILD__)
      set({ build, buildMismatch: mismatch, staleUi: stale })
      if (mismatch) return
      await get().loadModels()
      await get().loadProjects()
      void get().loadSessionActivity().catch(() => undefined)
    } catch (e) {
      set({ toast: e instanceof Error ? e.message : String(e) })
    }
  },

  loadModels: async () => {
    const models = await api.models()
    set({ models: models.models, defaultModel: models.default })
  },

  loadProjects: async () => { set({ projects: await api.projects() }) },

  loadSessionActivity: async () => {
    // one read at a time, never two overlapping: one asked meanwhile goes once this one is back
    if (activityReading) { activityAgain = true; return }
    activityReading = true
    try {
      for (;;) {
        activityAgain = false
        const { sessions } = await api.sessionActivity()
        // the first summary lays what was seen; a session gone loses its mark. Only the session in view as the answer
        // lands (open, the window visible) is seen up to it — never one that was in view when the read was asked: the
        // person may have left it since, and an end after that is theirs to see
        let railSeen = seenAfterSummary(get().railSeen, sessions)
        const viewing = sessionInView(get)
        if (viewing) railSeen = seenAfterLook(railSeen, viewing, sessions[viewing]?.ended)
        if (railSeen !== get().railSeen) writeSeen(steerStorage(), railSeen)
        set({ sessionActivity: sessions, railSeen })
        if (!activityAgain) break
      }
    } finally {
      activityReading = false
    }
  },

  markSessionSeen: (sessionId, ended) => {
    const railSeen = seenAfterLook(get().railSeen, sessionId, ended)
    if (railSeen === get().railSeen) return
    writeSeen(steerStorage(), railSeen)
    set({ railSeen })
  },

  createProject: async (body) => {
    const project = await api.createProject(body)
    await get().loadProjects()
    return project
  },

  openSession: async (id, opts) => {
    const opening = ++openTicket
    // the session left is read from its summary from now on: asked now (its answer sees only what is in view then)
    if (get().session && get().session?.id !== id) void get().loadSessionActivity().catch(() => undefined)
    ++directorTicket
    ++accessEpoch
    set({ busy: null, access: null, accessSaving: false })
    for (const dispose of Object.values(get().disposers)) dispose()
    const session = await api.session(id)
    // a live run's rows come from its stream (watched below), never from a transcript it would then repeat
    const targets = session.runs.filter((run) => !(LIVE_STATUSES.has(run.status) || (session.active_run && run.id === session.active_run.id)))
    // every other run's transcript: one read per run of the list (a run listed twice is read twice), at most
    // OPENING_TRANSCRIPT_READS of this opening's on their way at once; one that fails (or whose answer cannot be read)
    // is an empty thread, and the rest go on. Nothing is shown until all are back; the threads keep the list's order
    const read: ThreadEntry[][] = new Array(targets.length)
    let next = 0
    const reader = async () => {
      while (next < targets.length) {
        const i = next++
        const run = targets[i]!
        try {
          const t = await api.transcript(run.id)
          read[i] = fromTranscript(run.id, t.entries, admitWith(session.runs, session), t.steers ?? [])
        } catch { read[i] = [] }
      }
    }
    if (targets.length) await Promise.all(Array.from({ length: Math.min(OPENING_TRANSCRIPT_READS, targets.length) }, reader))
    const threads: Record<string, ThreadEntry[]> = {}
    targets.forEach((run, i) => { threads[run.id] = read[i]! })
    if (opening !== openTicket) return
    if (opts?.target) rememberTarget(id, opts.target)
    setIdentities(null)
    for (const dispose of Object.values(get().childDisposers)) dispose()
    get().directorDisposer?.()
    resetRefreshes()
    // every run of the session on one connection, from the cursor this detail names (an older harness names none:
    // each run is read from its own stream); a run it hears first is looked for in the tree and the session
    if (typeof session.event_cursor === 'number') openSessionStream(id, session.event_cursor, (runId) => get().discoverRun(runId))
    else closeSessionStream()
    set({ session, runs: session.runs, notes: session.director_notes ?? [], threads, liveRunId: null, relays: session.relays ?? [], interactions: session.interactions ?? [], recordsRunId: null, disposers: {}, modelChoice: null, directorModel: null, diff: null, workspace: null, changeView: { run_id: null, path: null }, uiSurfaces: {}, uiInputs: {}, uiTaskRuns: {},
          tree: [], treeOf: null, childThreads: {}, childDisposers: {}, control: null, proposals: [], director: null, directorLive: null, directorDisposer: null, composerTarget: opts?.target ?? rememberedTarget(id) ?? targetOf(session.director), noteTo: 'director', noteInteractionId: null,
          collab: openCollab(id), sendAs: 'main', references: NO_REFERENCES,
          // the composer of the place left is put away; this session's own comes out
          ...switchedComposer(get(), composerKeyOf(get()), id) })
    // an unconfirmed steer the session's records hold already: taken
    for (const rows of Object.values(threads)) for (const e of rows) if (e.steer) get().confirmSteer(e.steer)
    void get().loadTree()
    void get().loadCollab()
    void get().refreshGate()
    void get().loadAccess()
    void get().loadSurfaces()
    void get().loadInputs()
    void get().loadTaskRuns()
    void get().loadDirector()
    // every live run of the thread is watched: an interaction's nodes run side by side
    for (const run of session.runs) if (LIVE_STATUSES.has(run.status)) get().watchRun(run, -1)
    await get().refreshEvidence()
  },

  closeSession: () => {
    ++openTicket
    ++directorTicket
    ++accessEpoch
    set({ access: null, accessSaving: false })
    for (const dispose of Object.values(get().disposers)) dispose()
    for (const dispose of Object.values(get().childDisposers)) dispose()
    get().directorDisposer?.()
    closeSessionStream()
    resetRefreshes()
    // the session left is read from its summary from now on: asked now (its answer sees only what is in view then)
    if (get().session) void get().loadSessionActivity().catch(() => undefined)
    const { session, projects } = get()
    const project = session ? projects.find((p) => p.id === session.project_id) : undefined
    setIdentities(null)
    set({ busy: null, session: null, runs: [], notes: [], threads: {}, liveRunId: null, relays: [], interactions: [], recordsRunId: null, disposers: {}, diff: null, workspace: null, changeView: { run_id: null, path: null }, uiSurfaces: {}, uiInputs: {}, uiTaskRuns: {},
          tree: [], treeOf: null, childThreads: {}, childDisposers: {}, sidebarOpen: true, director: null, directorLive: null, directorDisposer: null, composerTarget: 'agent', noteTo: 'director', noteInteractionId: null,
          collab: EMPTY_COLLAB, sendAs: 'main', references: NO_REFERENCES,
          target: project ? { kind: 'project', projectId: project.id, name: project.name, path: project.source_path } : get().target,
          ...switchedComposer(get(), composerKeyOf(get()), START_COMPOSER) })
  },

  renameSession: async (id, title) => {
    sessionEdits += 1
    const detail = await api.renameSession(id, title)
    if (get().session?.id === id) set({ session: { ...get().session!, title: detail.title } })
    await get().loadProjects()
  },

  deleteSession: async (id) => {
    await api.deleteSession(id)
    pendingSends.forgetSession(id)
    setPendingSteer(get, set, id, null)
    forgetTarget(id)
    if (get().session?.id === id) get().closeSession()
    const forgotten = forgottenComposer(get().composers, id)
    for (const image of forgotten.images) URL.revokeObjectURL(image.url)
    set({ composers: forgotten.composers })
    await get().loadProjects()
  },

  startTask: async (text) => {
    const state = get()
    if (state.session) throw new Error('Start a new task from the start screen; the current draft is kept.')
    const navigation = openTicket
    const original = { ...composerOf(state, START_COMPOSER), images: [...state.images] }
    const { composerTarget, modelChoice, thinking, target, projects, mentionThinking, interactionMaxRuns, interactionConcurrency } = state
    const executionTarget = taskTarget(target, projects)
    requireRemote(executionTarget)
    if (executionTarget.kind !== 'local') {
      if (!target?.path || !target.path.startsWith('/')) throw new Error('SSH: Project folder')
      if (original.images.length || (target.kind === 'folder' && target.mode)) throw new Error('SSH: Unsupported')
      if (participantsOf(text).length > 1 && state.groupPolicy === 'isolated') throw new Error('SSH: Unsupported')
    }
    const refusal = destinationRefusal(composerTarget === 'chatgpt' ? 'chatgpt-director' : composerTarget === 'director' ? 'native-director' : 'agent', original.images.length)
    if (refusal) throw new Error(refusal)
    const start = pendingStarts.get(START_COMPOSER, signatureOf(text, original.images.map((i) => i.id), [target, composerTarget, modelChoice, thinking, mentionThinking, original.orchestration, original.relayRounds, interactionMaxRuns, interactionConcurrency]))
    const stillHere = () => openTicket === navigation && get().session === null
    const busy = (line: string) => { if (stillHere()) set({ busy: line }) }
    try {
      let project: Project | undefined
      if (!target) {
        busy('opening a conversation')
        project = await get().createProject({ no_folder: true, client_request_id: `${start.key}/project` })
      } else if (target.kind === 'project') project = projects.find((p) => p.id === target.projectId)
      else if (target.kind === 'folder') project = projectForFolder(projects, target.path, target.mode === 'attached' ? 'attached' : 'direct', executionTarget)
      if (!project && target?.path) {
        const attached = target.kind === 'folder' && target.mode === 'attached'
        busy(attached ? `attaching ${targetLabel(target)}` : `opening ${targetLabel(target)} in place`)
        if (stillHere()) set({ importRefusal: null })
        try {
          project = await get().createProject({ source_path: target.path, ...(executionTarget.kind === 'ssh' ? { target: executionTarget } : {}), mode: attached ? 'attached' : 'direct', client_request_id: `${start.key}/project` })
        } catch (e) {
          if (e instanceof ApiError && e.status === 413 && e.body?.refusal === 'snapshot_too_large') {
            if (stillHere()) set({ importRefusal: e.body as unknown as ImportRefusal })
            return
          }
          throw e
        }
      }
      if (!project) throw new Error('the project for this task could not be opened')
      if (executionTarget.kind !== 'local' && project.kind !== 'direct') throw new Error('SSH: Unsupported')
      if (!sameTarget(resourceTarget(project), executionTarget)) throw new Error('SSH: Unknown target')
      busy(project.kind === 'direct' ? 'opening the folder' : 'opening a worktree for the session')
      const session = await api.createSession(project.id, { title: sessionTitle(text), model: modelChoice ?? undefined, client_request_id: `${start.key}/session` })
      if (!sameTarget(sessionTarget(session, [project]), executionTarget)) throw new Error('SSH: Unknown target')
      // Transfer only the captured start draft. A different session (or newly typed start draft) is untouched.
      const waiting = composerOf(get(), START_COMPOSER)
      const sentIds = new Set(original.images.map((i) => i.id))
      set(withComposer(get(), START_COMPOSER, { draft: waiting.draft === text ? '' : waiting.draft, images: waiting.images.filter((i) => !sentIds.has(i.id)) }))
      set(withComposer(get(), session.id, { ...original, draft: text }))
      pendingStarts.acknowledge(start) // the session exists; a failed message retries there, not by creating another
      const draftRevision = draftRevisions.get(session.id) ?? 0
      const origin: SendOrigin = { images: original.images.map((i) => ({ ...i })), draftRevision, session, director: null, composerTarget, modelChoice, directorModel: state.directorModel, thinking, mentionThinking, orchestration: original.orchestration, relayRounds: original.relayRounds, interactionMaxRuns, interactionConcurrency, crossRounds: state.crossRounds, groupPolicy: state.groupPolicy }
      await get().loadProjects()
      if (stillHere()) {
        await get().openSession(session.id, { target: composerTarget })
        if (get().session?.id === session.id) set({ modelChoice, thinking })
      }
      // Navigation never redirects this accepted send to the visible session. Its own draft survives a refusal.
      await get().send(text, undefined, origin)
    } finally {
      if (stillHere()) set({ busy: null })
    }
  },

  attachRefused: async () => {
    const { importRefusal, target, draft } = get()
    if (!importRefusal || !target || target.kind !== 'folder') return
    if (resourceTarget(target).kind !== 'local') throw new Error('SSH: Unsupported')
    set({ target: { kind: 'folder', path: target.path, mode: 'attached' }, importRefusal: null })
    if (draft.trim() || get().images.length) await get().startTask(draft)
  },
  setImportRefusal: (refusal) => set({ importRefusal: refusal }),

  send: async (text, opts, origin) => {
    const captured: SendOrigin = origin ?? { ...get(), images: get().images.map((i) => ({ ...i })), draftRevision: draftRevisions.get(composerKeyOf(get())) ?? 0 }
    const { session, modelChoice, thinking, composerTarget } = captured
    const { noteTo, noteInteractionId } = get()
    if (!session) return
    const executionTarget = sessionTarget(session, get().projects)
    requireRemote(executionTarget)
    if (executionTarget.kind !== 'local' && (captured.images.length || (participantsOf(text).length > 1 && (captured.groupPolicy ?? get().groupPolicy) === 'isolated'))) throw new Error('SSH: Unsupported')
    if (get().replaying) throw new Error('the replay shows the record; go back to live to send a message')
    const destination = messageDestination(composerTarget, origin ? null : noteCandidates(get().interactions).map((ix) => ix.id), noteTo, noteInteractionId)
    // the group the note was for takes none now: refused as such — never sent to the director or another group instead
    if (destination.kind === 'note' && destination.gone) throw new Error('The group this note was for no longer takes notes: choose its recipient again (To). The draft is kept.')
    const pending = get().references
    if ((destination.kind === 'director' || destination.kind === 'note') && (pending.cites.length || pending.receive.length)) {
      throw new Error(`Cited and handed-over runs go with a message to an agent, a group or a separate task — ${destination.kind === 'director' ? 'the director takes none (it names runs itself)' : 'a note takes none'}. Take them back (×) or send to an agent. The draft is kept.`)
    }
    if (destination.kind === 'director') return get().sayToDirector(text, opts, captured)
    if (destination.kind === 'note') return get().noteInteraction(destination.interactionId, destination.to, text)
    const mentions = mentionsOf(text)
    // the agents named with @, by their letters: one is this run's model; two or more work together as the composer
    // says — the director plans it or each works alone (an interaction), or they take turns (a relay, over the rounds
    // chosen); the key's signature carries them (the words hold the tokens), the way and the rounds
    const participants = participantsOf(text)
    const original = { images: captured.images }
    const orchestration = participants.length >= 2 ? captured.orchestration : null
    const crossRounds = orchestration === 'discussion' ? (captured.crossRounds ?? get().crossRounds) : undefined
    // a group's policy as it was when the message was written: a retry never sends it under another
    const groupPolicy = orchestration !== null && orchestration !== 'turns' ? (captured.groupPolicy ?? get().groupPolicy) : null
    const rounds = orchestration === 'turns' ? captured.relayRounds : crossRounds
    const own = participantThinking(participants, captured.mentionThinking)
    const ownThinking = Object.keys(own).length ? { participant_thinking: own } : {}
    // the references go only to a harness that records them (an older one would drop them without a word)
    const refs = session.id === get().session?.id ? get().references : NO_REFERENCES
    const referenced = refs.cites.length || refs.receive.length ? [refs] : []
    // references go with the message or the message does not go: never sent without them in silence
    if (referenced.length && get().collab.status !== 'graph') throw new Error('This harness does not record cited or handed-over runs right now: take them back (×), or wait until it does. The draft is kept.')
    if (refs.receive.length && orchestration !== null && orchestration !== 'turns') throw new Error('A group takes cited runs only: handed-over answers go with a message to one agent, a relay or a separate task. Take them back (×) or send it another way. The draft is kept.')
    const sending = pendingSends.get(session.id, signatureOf(text, original.images.map((i) => i.id), ['agent', modelChoice, thinking, own, opts, orchestration, rounds ?? null, ...(groupPolicy ? [groupPolicy] : []), ...referenced]))
    // ChatGPT named (or the thread's own model): its page in the desktop app is started before the run types into it
    if (participants.some((p) => p.model === CHATGPT_WEB_ID) || (!participants.length && (modelChoice ?? session.model) === CHATGPT_WEB_ID)) await startChatGptPage(window as { oasisCodeDesktop?: unknown })
    const attachments = await uploadPending(session.id, original.images, get, set)
    let run: Run | null = null
    try {
      if (orchestration !== null && orchestration !== 'turns') {
        const director = captured.director?.director ?? session.director ?? null
        const interaction = await api.startInteraction(session.id, {
          text, thinking, ...ownThinking, ...(mentions.length ? { mentions } : {}), ...(attachments.length ? { attachments } : {}), fresh: opts?.fresh ?? false,
          plan: orchestration === 'independent' ? { template: 'independent' } : orchestration === 'discussion' ? { template: 'discussion', cross_rounds: crossRounds ?? 1 } : null,
          // the policy said, not left to the route's default: the composer's groups keep the session folder's own rule
          // (a folder edited in place: in place; a worktree: a copy per step) — a separate task is the isolated way
          workspace_policy: groupPolicy ?? 'legacy',
          // an interaction's first steps cite what the message cites; handing answers over is a step's (receives)
          ...referenceBody(refs, false),
          ...(captured.interactionMaxRuns ? { max_runs: captured.interactionMaxRuns } : {}), concurrency: captured.interactionConcurrency,
          // the director: the session's open one; else a native one on the model chosen for the next run
          ...(orchestration === 'director' && !director ? { director_model: modelChoice ?? session.model } : {}),
          client_request_id: sending.key,
        })
        pendingSends.acknowledge(sending)
        clearSentComposer(session.id, text, original.images, get, set, captured.draftRevision)
        if (get().session?.id !== session.id) return
        if (referenced.length) set({ references: NO_REFERENCES })
        set({ interactions: get().interactions.some((ix) => ix.id === interaction.id) ? get().interactions.map((ix) => (ix.id === interaction.id ? interaction : ix)) : [...get().interactions, interaction] })
        // the runs it started (or its director's turn) come with the session; read it now rather than on the next tick
        await get().syncSession()
        if (interaction.director_session_id) void get().loadDirector()
        return
      }
      const relayRounds = orchestration === 'turns' ? rounds : undefined
      run = await api.chat(session.id, { text, model: modelChoice ?? undefined, fresh: opts?.fresh, thinking, ...ownThinking, ...(mentions.length ? { mentions } : {}),
        ...(attachments.length ? { attachments } : {}), ...(participants.length ? { agents: participants.map((p) => ({ model: p.model })) } : {}), ...(relayRounds ? { rounds: relayRounds } : {}), ...referenceBody(refs), client_request_id: sending.key })
    } catch (e) {
      // A failure, including an ambiguous 409, never discards another request's retry key.
      throw e
    }
    pendingSends.acknowledge(sending)
    clearSentComposer(session.id, text, original.images, get, set, captured.draftRevision)
    // the run joins the page only while its session is the one on show (opened again later, it comes with the session)
    if (get().session?.id !== session.id) return
    if (referenced.length) set({ references: NO_REFERENCES })
    // a resend answered with the run the first send started: it is on the page already (or joins it once)
    const known = get().runs.some((r) => r.id === run!.id)
    set({ runs: known ? get().runs : [...get().runs, run], threads: known ? get().threads : { ...get().threads, [run.id]: [] } })
    if (!known) get().watchRun(run, -1)
    // the relay's plan comes with the session; read it now rather than on the next tick
    if (run.relay_id) void get().syncSession()
  },

  steer: async (text, runId) => {
    const session = get().session
    if (!session) return
    if (get().replaying) throw new Error('the replay shows the record; go back to live to send a message')
    // files and named agents or tools do not join a run under way: said, and the draft stays as it is
    const refusal = steerRefusal(text, get().images.length)
    if (refusal) throw new Error(refusal)
    const revision = draftRevisions.get(session.id) ?? 0
    // the same words to the same run reuse the unconfirmed key (the harness answers with the record it took, even once
    // the run ended); other words get a key of their own. The route is kept before the request leaves: an answer lost
    // on the way back leaves the words bound to this run and key — across a session switch and a reload
    const held = get().pendingSteer[session.id]
    const key = held && held.run_id === runId && held.text === text ? held.key : keyFor(null, session.id, signatureOf(text, [], ['steer', runId])).key
    setPendingSteer(get, set, session.id, { session_id: session.id, run_id: runId, key, text })
    let answer: SteerResponse
    try {
      answer = await api.steer(runId, { text, client_request_id: key })
    } catch (e) {
      // the harness answered and did not take it (a 409, a spent key…): released — the next send is the person's own
      // (a new run, or a new key); a lost answer keeps the route for the retry
      if (steerNotTaken(e)) setPendingSteer(get, set, session.id, null, key)
      throw new Error(steerErrorText(e))
    }
    setPendingSteer(get, set, session.id, null, key)
    // only the words that were taken leave the composer they were written in — not words typed meanwhile
    clearSentComposer(session.id, text, [], get, set, revision)
    if (get().session?.id !== session.id) return
    const record = answer.steer
    // the run's stream places the steer where its words go; the answer places it only while it is queued, or when no
    // stream here hears the run
    if (isSteerRecord(record) && (record.status === 'queued' || !get().disposers[record.run_id])) get().adoptSteer(record)
  },

  adoptSteer: (record) => {
    if (!isSteerRecord(record) || (record.session_id !== '' && get().session?.id !== record.session_id)) return
    const rows = get().threads[record.run_id]
    if (rows === undefined) return
    const next = adoptSteers(rows, record.run_id, [record])
    if (next !== rows) set({ threads: { ...get().threads, [record.run_id]: next } })
    get().confirmSteer(record)
  },

  confirmSteer: (record) => {
    if (!isSteerRecord(record) || !record.client_request_id) return
    const held = get().pendingSteer[record.session_id]
    // the very steer this composer sent: its run, its key and its words (a record under the key with other words is
    // never taken for it)
    if (!held || held.key !== record.client_request_id || held.run_id !== record.run_id || held.text !== record.text) return
    setPendingSteer(get, set, record.session_id, null, held.key)
    // taken: its words leave the composer they were written in — unless the person changed them since
    if (composerOf(get(), record.session_id).draft === held.text) set(withComposer(get(), record.session_id, { draft: '' }))
  },

  putBackSteer: (sessionId, text) => {
    const current = composerOf(get(), sessionId)
    draftRevisions.set(sessionId, (draftRevisions.get(sessionId) ?? 0) + 1)
    set(withComposer(get(), sessionId, { draft: putBackDraft(current.draft, text) }))
  },

  stop: async (interactionId) => {
    if (get().replaying) throw new Error('the replay shows the record; go back to live to stop a run')
    const id = get().liveRunId
    const live = id ? get().runs.find((r) => r.id === id) : undefined
    // the header's stop with no thread run and several groups under way: every one of them stops
    const under = activeInteractions(get().interactions)
    if (!interactionId && !live && under.length > 1) {
      await Promise.all(under.map((ix) => api.cancelInteraction(ix.id)))
      void get().syncSession()
      return
    }
    // an interaction under way: the whole of it stops (every live run, the director's planning, what was to come)
    const interaction = interactionId ? get().interactions.find((ix) => ix.id === interactionId) : live?.interaction_id ? get().interactions.find((ix) => ix.id === live.interaction_id) : under[0] ?? null
    if (interaction && ['planning', 'running', 'waiting', 'deciding', 'interrupted'].includes(interaction.status)) {
      await api.cancelInteraction(interaction.id)
      void get().syncSession()
      return
    }
    const relay = live?.relay_id ? get().relays.find((r) => r.id === live.relay_id) : activeRelay(get().relays)
    if (relay && (relay.status === 'running' || relay.status === 'waiting' || relay.status === 'interrupted')) {
      await api.cancelRelay(relay.id)
      void get().syncSession()
      return
    }
    if (id) await api.cancel(id)
  },

  setRelayRounds: (rounds) => set({ relayRounds: rounds }),
  setOrchestration: (mode) => set({ orchestration: mode }),
  setInteractionLimits: (limits) => set({ ...(limits.max_runs !== undefined ? { interactionMaxRuns: limits.max_runs } : {}), ...(limits.concurrency !== undefined ? { interactionConcurrency: limits.concurrency } : {}) }),
  setNoteTo: (to, interactionId) => {
    const sid = get().session?.id
    let group: string | null = null
    if (to !== 'director') {
      // the group named, or the only one open; several open and none named: nothing is chosen for the person
      const open = noteCandidates(get().interactions)
      group = interactionId ?? (open.length === 1 ? open[0]!.id : null)
      if (!group) throw new Error(open.length ? 'Choose the group first: several take notes.' : 'No group takes notes now.')
      if (!open.some((ix) => ix.id === group)) throw new Error('That group no longer takes notes.')
    }
    const target = to === 'director' ? directorTarget(get().director?.director ?? get().session?.director) : null
    if (target) { ++composerTargetRevision; if (sid) rememberTarget(sid, target) }
    set({ noteTo: to, noteInteractionId: group, ...(target ? { composerTarget: target } : {}) })
  },

  noteInteraction: async (interactionId, to, text) => {
    if (get().images.length) throw new Error('Participant notes take words only; remove attachments or send a new agent message. The draft is kept.')
    if (get().replaying) throw new Error('the replay shows the record; go back to live to write to the participants')
    const sid = get().session?.id
    if (!sid) return
    const interaction = await api.noteInteraction(interactionId, to, text)
    clearSentComposer(sid, text, [], get, set)
    if (get().session?.id !== sid) return
    set({ interactions: get().interactions.map((ix) => (ix.id === interaction.id ? interaction : ix)) })
    // a note to a paused interaction goes on with it, one to a finished one starts another round: the steps that
    // run next take the note
    if (interaction.status === 'waiting' || interaction.status === 'interrupted') await get().continueInteraction(interaction.id)
    else if (interaction.status === 'done') {
      const grown = await api.addInteractionSteps(interaction.id, { nodes: nextRound(interaction, to), then: 'stop' })
      set({ interactions: get().interactions.map((ix) => (ix.id === grown.id ? grown : ix)) })
      await get().syncSession()
    }
  },

  pauseInteraction: async (interactionId) => {
    const interaction = await api.pauseInteraction(interactionId)
    set({ interactions: get().interactions.map((ix) => (ix.id === interaction.id ? interaction : ix)) })
    await get().syncSession()
  },

  askSynthesis: async (interactionId, participant) => {
    if (get().replaying) throw new Error('the replay shows the record; go back to live to ask for a synthesis')
    const current = get().interactions.find((ix) => ix.id === interactionId)
    if (!current) return
    const ended = current.nodes.filter((n) => n.status === 'done').map((n) => n.id)
    const taken = new Set(current.nodes.map((n) => n.id))
    // named by the participant's place (`synth-1`), not its id: the step's name is read in the thread
    const place = current.participants.findIndex((p) => p.id === participant) + 1
    let id = `synth-${place}`
    for (let i = 2; taken.has(id); i += 1) id = `synth-${place}-${i}`
    const own = current.nodes.find((n) => n.participant === participant)
    const interaction = await api.addInteractionSteps(interactionId, { nodes: [{ id, participant, depends_on: ended, receives: ended, workspace: own?.workspace ?? 'own', instruction: "Synthesize: read every answer you were handed and give the user one result — what to keep, what to drop, and why. Write it in the user's language." }], then: 'stop' })
    set({ interactions: get().interactions.map((ix) => (ix.id === interaction.id ? interaction : ix)) })
    await get().syncSession()
  },

  continueInteraction: async (interactionId) => {
    if (get().replaying) throw new Error('the replay shows the record; go back to live to continue an interaction')
    const interaction = await api.continueInteraction(interactionId)
    set({ interactions: get().interactions.map((ix) => (ix.id === interaction.id ? interaction : ix)) })
    await get().syncSession()
    if (interaction.director_session_id) void get().loadDirector()
  },

  adoptNode: async (interactionId, nodeId) => {
    if (get().replaying) throw new Error('the replay shows the record; go back to live to adopt a result')
    const originSession = get().session
    const interaction = get().interactions.find((ix) => ix.id === interactionId)
    const node = interaction?.nodes.find((n) => n.id === nodeId)
    if (!interaction || !node) throw new Error('This result cannot be written back to the session folder.')
    const workspace = node.workspace_id ? await api.workspace(node.workspace_id) : null
    if (sourceMount(workspace)) throw new Error('This source is read-only. Outputs remain in their separate folder; Keep cannot write them back.')
    if (!workspace || !adoptable(interaction, node, originSession?.workspace?.id ?? null, workspace)) throw new Error('This result cannot be written back to the session folder.')
    const result = await api.adoptNode(interactionId, nodeId)
    if (get().session?.id === originSession?.id) {
      await get().syncSession()
      await get().refreshEvidence()
    }
    if (result.applied_to_workspace) return `Step ${nodeId} adopted: ${result.files.length} file(s) written to the working folder.`
    return `Step ${nodeId} composed but not written: ${result.reason ?? result.status}`
  },

  undoRun: async (runId) => {
    requireRemote(sessionTarget(get().session, get().projects), 'journal_undo')
    const result = await api.undoRun(runId)
    void get().refreshEvidence()
    return result
  },

  cancelWatch: async (watchId) => {
    await api.cancelWatch(watchId)
    await get().syncSession()
  },

  continueRelay: async (relayId, rounds) => {
    if (get().replaying) throw new Error('the replay shows the record; go back to live to continue a relay')
    const relay = await api.continueRelay(relayId, rounds ?? null)
    set({ relays: get().relays.map((r) => (r.id === relay.id ? relay : r)) })
    await get().syncSession()
  },

  syncSession: async () => {
    const session = get().session
    if (!session || get().replaying) return
    if (syncing) { syncAgain = true; return }
    syncing = true
    syncAgain = false
    const edits = editsNow()
    // the read belongs to this opening of the session: one left (or left and opened again) takes nothing of it
    const opening = openTicket
    const here = () => opening === openTicket && get().session?.id === session.id
    try {
      const answered = await api.session(session.id)
      if (!here()) return
      const fresh = adoptSession(answered, edits, get().session)
      const delta = sessionDelta({ runs: get().runs, notes: get().notes }, fresh)
      const beside = besideChanged(get().session, fresh)
      // the folders or the task changed elsewhere: taken in
      const foldersMoved = taskFieldsChanged(get().session, fresh)
      // a title the harness gave meanwhile (the director's, with its plan): the header and the rail take it
      if (fresh.title !== get().session?.title) {
        set({ session: { ...get().session!, title: fresh.title, title_source: fresh.title_source } })
        void get().loadProjects()
      }
      if (beside) void get().loadTree()
      // the relays and the interactions move on their own (the harness starts the next run, a run ends waiting, the
      // director plans): taken in as they stand
      // the outline's plan rows follow them (a node started, a placeholder became a run, the decision came due)
      const relaysMoved = relaysChanged(get().relays, fresh.relays ?? [])
      const interactionsMoved = interactionsChanged(get().interactions, fresh.interactions ?? [])
      if (relaysMoved) set({ relays: fresh.relays ?? [] })
      if (interactionsMoved) set({ interactions: fresh.interactions ?? [] })
      if ((relaysMoved || interactionsMoved) && !beside) void get().loadTree()
      // the collaboration graph: read again when the detail names another revision (or, from a harness that serves
      // the graph without naming revisions, when anything moved); a failed read is retried on the tick
      if (wantsReload(get().collab, fresh.collaboration_revision, beside || relaysMoved || interactionsMoved || hasChanges(delta))) void get().loadCollab()
      if (!hasChanges(delta)) {
        // a watch set, reported, ended or cancelled moves nothing else: the strip over the composer takes it
        // the active run's steerable word moves the composer (words into the run, or not)
        // a command of an earlier run started, ended or changed state in the background: the header's count takes it
        if (beside || foldersMoved || !!fresh.director !== !!get().session?.director || watchesChanged(get().session, fresh) || activeRunMoved(get().session?.active_run, fresh.active_run)
          || backgroundChanged(get().session, fresh)) set({ session: { ...fresh } })
        return
      }
      const read: Record<string, ThreadEntry[]> = {}
      for (const run of delta.newRuns) {
        if (LIVE_STATUSES.has(run.status)) { read[run.id] = []; continue }
        try {
          const t = await api.transcript(run.id)
          read[run.id] = fromTranscript(run.id, t.entries, admitWith([...fresh.runs, ...get().tree], fresh), t.steers ?? [])
        } catch { read[run.id] = [] }
      }
      if (!here()) return
      // a run this page streams is the stream's to update; one nothing here watches takes the harness's word
      const watched = get().disposers
      const known = get().runs.map((r) => (watched[r.id] ? r : delta.changedRuns.find((c) => c.id === r.id) ?? r))
      const { runs, threads, added } = joinNewRuns({ runs: known, threads: get().threads }, delta.newRuns, read)
      // a rename or a grants or mode change made while the transcripts were read stands: the answer is taken against
      // the session as it is now
      set({ runs, notes: [...get().notes, ...delta.newNotes], threads, session: adoptSession(answered, edits, get().session) })
      for (const run of added) if (LIVE_STATUSES.has(run.status)) get().watchRun(run, -1)
      if (delta.newRuns.length > 0 || delta.changedRuns.length > 0) {
        void get().loadTree()
        void get().refreshEvidence()
        // a run that ended with nothing here watching it: its surfaces come with the session's list
        void get().loadSurfaces()
        void get().loadInputs()
        void get().loadTaskRuns()
      }
    } catch { /* the next tick asks again */ } finally {
      syncing = false
      if (syncAgain) void get().syncSession()
    }
    // the director session moves on its own (a turn ends, a run wakes it): the page reads it on the same ticker
    if (get().session?.id === session.id && (get().director?.director || get().session?.director)) void get().loadDirector()
  },

  startSync: () => {
    let ticks = 0
    const timer = window.setInterval(() => {
      ticks += 1
      void get().syncSession()
      if (ticks % PROJECTS_EVERY_TICKS === 0 && !get().busy) void get().loadProjects().catch(() => undefined)
      // the rail's dots: every few seconds while the page is in view (one batched read, never two at once), seldom
      // while it is hidden
      const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
      if (!hidden || ticks % ACTIVITY_HIDDEN_EVERY_TICKS === 0) void get().loadSessionActivity().catch(() => undefined)
      // a form a run asks for where no stream here hears it (a run of another client's, a stream between reconnects)
      if (ticks % PROJECTS_EVERY_TICKS === 0) void get().loadInputs()
    }, SYNC_MS)
    // back in view: the dots as they stand now (and the open session seen), not at the next tick
    const onVisible = () => { if (document.visibilityState !== 'hidden') void get().loadSessionActivity().catch(() => undefined) }
    document.addEventListener('visibilitychange', onVisible)
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible) }
  },

  watchRun: (run, after = -1) => {
    const disposers = { ...get().disposers }
    disposers[run.id]?.()
    set({ liveRunId: run.id })
    const batch = frameBatch<SSEItem>((heard) => {
      // a session surface only from a run that may present one, as the page's rows know the run (never the event's word)
      const items = heard.map((h) => screenSurfaceEvent(h, run.id, get().runs.find((r) => r.id === run.id) ?? run, get().session))
      const threads = get().threads
      let rows = threads[run.id] ?? []
      for (const item of items) rows = withKnownSurfaces(applyEvent(rows, run.id, item), run.id, item, get().uiSurfaces)
      set({ threads: { ...threads, [run.id]: rows } })
      for (const item of items) {
        // a session surface this run updated: at the row of the run that first presented it (never a second copy here);
        // an older word (a stream read again from its start) changes nothing there
        const cross = crossSurfaceOf(run.id, item)
        if (cross) get().adoptSurface(cross)
        if (item.event === 'ui_input') get().adoptInput(item.data.input)
        if (item.event === 'ui_task') get().adoptTaskRun(item.data.task)
        if (item.event.startsWith('steer_')) get().confirmSteer(item.data.steer)
      }
      // waiting for what holds the folder (run_queued), then going on (slot_acquired, run_started): the run's record says it
      const row = get().runs.find((r) => r.id === run.id)
      if (row) {
        const moved = runAfterQueueEvents(row as Run & { waiting?: unknown }, items)
        if (moved !== row) set({ runs: get().runs.map((r) => (r.id === run.id ? moved : r)) })
      }
      // the tree's row too (the desk, the outline, the lanes read it): in line, going on or ended now, not when the
      // tree is read again
      const tree = treeAfter(get().tree, run.id, items)
      if (tree !== get().tree) set({ tree })
      const finished = items.find((item) => item.event === 'run_finished')
      if (finished) {
        const ended = endedRecord(finished.data)
        set({ runs: get().runs.map((r) => (r.id === run.id ? { ...r, ...ended, receipt: (ended.receipt as Run['receipt'] | undefined) ?? r.receipt, finished_at: r.finished_at ?? ended.finished_at } as Run : r)) })
        // a relay's turn (or an interaction's node) ended: the next run's row exists already (the harness started it
        // before saying so) — read it now
        if (run.relay_id || run.interaction_id || relayTurnOf(get().relays, run) || interactionTurnOf(get().interactions, run)) void get().syncSession()
        // the rail's summary of this session moves (one more end — seen if the session is still in view as it lands)
        void get().loadSessionActivity().catch(() => undefined)
      }
      // a run ended or went on: the relations (its summary's state, a handover written) are read again
      if (items.some((item) => TREE_EVENTS.has(item.event))) void get().loadCollab()
      const happened = (names: string[]) => items.some((item) => names.includes(item.event))
      if (happened(['checkpoint', 'tool_result', 'run_finished'])) void get().refreshEvidence()
      if (happened(['action_gated', 'run_finished'])) void get().refreshGate()
      if (items.some((item) => TREE_EVENTS.has(item.event) || QUEUE_EVENTS.has(item.event))) void get().loadTree()
    })
    const onClose = () => {
      batch.flush()
      if (get().liveRunId === run.id) set({ liveRunId: null })
      // a steer still queued when the stream ended: the harness's list says how it ended (never left as queued)
      if ((get().threads[run.id] ?? []).some((e) => e.steer?.status === 'queued')) {
        void api.steers(run.id).then((r) => { for (const record of r.steers ?? []) get().adoptSteer(record) }).catch(() => undefined)
      }
      void api.run(run.id).then((detail) => set({ runs: get().runs.map((r) => (r.id === run.id ? { ...r, ...detail } : r)) })).catch(() => undefined)
      void get().refreshEvidence()
    }
    const close = subscribeRunEvents(run.id, batch.push, onClose, after)
    disposers[run.id] = () => { batch.cancel(); close() }
    set({ disposers })
  },

  // one read at a time per session, at most one a second; an ask resolves once a read begun after it is applied
  loadTree: async () => {
    const session = get().session
    if (!session) return
    await treeRefresh.run(session.id)
  },

  readTree: async (sessionId, signal) => {
    const session = get().session
    if (session?.id !== sessionId) return
    try {
      const { runs } = await api.tree(session.id, signal)
      if (signal.aborted || get().session?.id !== session.id) return
      // every view's bots from one table of the session's stable participants (state/outline.ts)
      setIdentities(identityTable(runs, session.id))
      // a row whose end the page heard on its stream stays ended: this answer may have been read before that end
      set({ tree: mergeTree(get().treeOf === session.id ? get().tree : [], runs), treeOf: session.id })
      // a group step's run the page's record of its group does not know yet: the record is read now, not on the tick
      if (interactionsBehind(get().interactions, runs)) void get().syncSession()
      // every live run that is not the thread's own gets its own stream (its bot state and its card read it)
      for (const row of runs) {
        const thread = isThreadRow(row)
        if (row.spawned_by === 'plan') continue                                        // a plan's own row: no run, no stream
        if (!thread && LIVE_STATUSES.has(row.status) && !get().childDisposers[row.id]) void get().watchChild(row.id)
      }
    } catch { /* the next event retries */ }
  },

  discoverRun: (runId) => {
    if (get().runs.some((r) => r.id === runId) || get().tree.some((r) => r.id === runId)) return
    // a run the page did not know (another client's, a group's next step, a separate task): its row now, not on the tick
    void get().loadTree()
    void get().syncSession()
  },

  watchChild: async (runId) => {
    // a run the thread already follows (a run of the session's conversation the tree reads as dispatched — a
    // director's order): its rows are the thread's; a second stream would only open an empty copy of them first
    if (get().childDisposers[runId] || get().disposers[runId] || get().replaying) return
    const row = get().tree.find((r) => r.id === runId)
    if (row && !LIVE_STATUSES.has(row.status)) {
      if (transcriptsReading.has(runId) || (transcriptsRead.has(runId) && get().childThreads[runId])) return
      transcriptsReading.add(runId)
      try {
        const t = await api.transcript(runId)
        // with the surfaces the session's list brought for it (their latest state)
        const rows = withSurfaces({ [runId]: fromTranscript(runId, t.entries, admitWith([...get().runs, ...get().tree], get().session), t.steers ?? []) }, Object.values(get().uiSurfaces))[runId]!
        set({ childThreads: { ...get().childThreads, [runId]: rows } })
        transcriptsRead.add(runId)
      } catch { /* shown empty */ } finally { transcriptsReading.delete(runId) }
      return
    }
    const batch = frameBatch<SSEItem>((heard) => {
      // a run beside the thread: the contract never lets it present a session surface (its row says why; unknown: none)
      const items = heard.map((h) => screenSurfaceEvent(h, runId, get().tree.find((r) => r.id === runId), get().session))
      const threads = get().childThreads
      let rows = threads[runId] ?? []
      for (const item of items) rows = withKnownSurfaces(applyEvent(rows, runId, item), runId, item, get().uiSurfaces)
      set({ childThreads: { ...threads, [runId]: rows } })
      for (const item of items) {
        if (item.event === 'ui_input') get().adoptInput(item.data.input)
        if (item.event === 'ui_task') get().adoptTaskRun(item.data.task)
      }
      // its row says what its stream said at once — in line, going on, ended — as the thread's own runs' do (its bot,
      // its card and its lane read the row; the tree read again agrees)
      const tree = treeAfter(get().tree, runId, items)
      if (tree !== get().tree) set({ tree })
      if (items.some((item) => item.event === 'action_gated' || item.event === 'run_finished')) void get().refreshGate()
      if (items.some((item) => TREE_EVENTS.has(item.event) || QUEUE_EVENTS.has(item.event))) { void get().loadTree(); void get().loadCollab() }
      // a group's step (or a relay's turn) ended beside the thread: the harness started the next ones before saying
      // so — read them now, as a turn of the thread's own does
      const row = get().tree.find((r) => r.id === runId)
      if (items.some((item) => item.event === 'run_finished') && (row?.interaction_id || row?.relay_id)) void get().syncSession()
    })
    const onClose = () => {
      batch.flush()
      const rest = { ...get().childDisposers }
      delete rest[runId]
      set({ childDisposers: rest })
      void get().loadTree()
    }
    const close = subscribeRunEvents(runId, batch.push, onClose, -1)
    set({ childThreads: { ...get().childThreads, [runId]: [] } })
    set({ childDisposers: { ...get().childDisposers, [runId]: () => { batch.cancel(); close() } } })
  },

  resumeRun: async (runId, text, model) => {
    await get().continueParticipant({ participantId: null, headRunId: runId, text, model })
  },

  continueParticipant: async ({ participantId, headRunId, text, model, thinking }) => {
    if (get().replaying) throw new Error('the replay shows the record; go back to live to continue an agent')
    const session = get().session
    if (!session) throw new Error('no session is open')
    const effort = thinking === undefined ? get().thinking : thinking
    // the same words to the same participant at the same head reuse the key (a lost answer starts no second run);
    // other words, another head or another model are a new message
    const sending = pendingSends.get(session.id, signatureOf(text, [], ['participant', participantId ?? null, headRunId, model ?? null, effort ?? null]))
    let answer: Run | QueuedFollowup
    try {
      if (participantId && get().collab.status === 'graph') {
        answer = await api.participantMessage(participantId, { text, model: model ?? null, thinking: effort ?? null, attachments: [], expected_head_run_id: headRunId, client_request_id: sending.key })
      } else {
        // an older harness: the run itself is continued (its own resume route, which keeps its order; it cannot keep a
        // group member inside its group)
        answer = await api.resume(headRunId, { text, thinking: effort, ...(model ? { model } : {}), client_request_id: sending.key })
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // the conversation moved on meanwhile (another message, a live run): the card is read again, the words stay
        void get().loadTree()
        void get().loadCollab()
        throw new Error(`${e.detail} — the card was read again; your words are kept.`)
      }
      throw e
    }
    // taken: a run, or a step of the participant's group that waits in its queue — either way the harness holds the
    // words under this key (the same key again answers with that step, or its run once started)
    pendingSends.acknowledge(sending)
    if (get().session?.id !== session.id) return answer
    await get().loadTree()
    void get().loadCollab()
    // a queued step has no run yet: nothing to watch; the tree and the graph show its run when the queue starts it
    if (!isQueuedFollowup(answer) && !get().runs.some((r) => r.id === answer.id)) void get().watchChild(answer.id)
    return answer
  },

  sendSeparate: async (text) => {
    if (sessionTarget(get().session, get().projects).kind !== 'local') throw new Error('SSH: Unsupported')
    const session = get().session
    if (!session) return null
    if (get().replaying) throw new Error('the replay shows the record; go back to live to send a message')
    const { modelChoice, thinking, images } = get()
    // the work-order route carries words only: files stay in the composer, said
    if (images.length) throw new Error('A separate task takes words only: the separate-task route carries no files. Remove the files, or send to the main agent. The draft is kept.')
    if (participantsOf(text).length) throw new Error('A separate task is one agent: name no participants (pick its model in the model menu). The draft is kept.')
    const revision = draftRevisions.get(session.id) ?? 0
    const refs = get().references
    const referenced = refs.cites.length || refs.receive.length ? [refs] : []
    if (referenced.length && get().collab.status !== 'graph') throw new Error('This harness does not record cited or handed-over runs right now: take them back (×), or wait until it does. The draft is kept.')
    const sending = pendingSends.get(session.id, signatureOf(text, [], ['separate', modelChoice, thinking, 'isolated', ...referenced]))
    const first = text.trim().split('\n')[0] ?? ''
    const label = first.length > 60 ? `${first.slice(0, 57)}…` : first
    let run: Run
    try {
      run = await api.workOrder(session.id, {
        work_order: { prompt: text, label: label || null, ...(modelChoice ? { model: modelChoice } : {}) },
        thinking, client_request_id: sending.key, workspace_policy: 'isolated', ...referenceBody(refs),
      })
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 405 || e.status === 501)) {
        throw new Error(`This harness does not take separate tasks (${e.status}). Nothing was sent; the draft is kept.`)
      }
      throw e
    }
    pendingSends.acknowledge(sending)
    clearSentComposer(session.id, text, [], get, set, revision)
    if (get().session?.id !== session.id) return run
    // the default stays the main agent: the next message goes on in the thread unless the person picks again
    set({ sendAs: 'main', ...(referenced.length ? { references: NO_REFERENCES } : {}) })
    await get().loadTree()
    void get().loadCollab()
    void get().watchChild(run.id)
    return run
  },

  setSendAs: (way) => set({ sendAs: way }),
  toggleReference: (runId, kind) => {
    const r = get().references
    const cited = r.cites.some((c) => c.run_id === runId), handed = r.receive.includes(runId)
    const cites = r.cites.filter((c) => c.run_id !== runId)
    const receive = r.receive.filter((id) => id !== runId)
    if (kind === 'cite' && !cited) cites.push({ run_id: runId })
    if (kind === 'receive' && !handed) receive.push(runId)
    set({ references: { cites: cites.slice(0, MAX_CITATIONS), receive: receive.slice(0, MAX_RECEIVED_RUNS) } })
  },
  clearReferences: () => set({ references: NO_REFERENCES }),
  setGroupPolicy: (policy) => set({ groupPolicy: policy }),
  setCrossRounds: (rounds) => set({ crossRounds: Math.max(1, Math.min(4, Math.round(rounds))) }),

  // like the tree: one read at a time per session, at most one a second
  loadCollab: async () => {
    const session = get().session
    if (!session || get().replaying) return
    const sid = session.id
    if (get().collab.sessionId !== sid) set({ collab: openCollab(sid) })
    if (get().collab.status === 'legacy') return
    await collabRefresh.run(sid)
  },

  readCollab: async (sid, signal) => {
    if (get().session?.id !== sid || get().replaying || get().collab.status === 'legacy') return
    const held = get().collab.graph ? get().collab.revision : null
    let result: { ok: true; value: CollaborationGraph | { unchanged: true } } | { ok: false; status: number | null; message: string }
    try { result = { ok: true, value: await api.collaboration(sid, held, signal) } }
    catch (e) { result = { ok: false, status: e instanceof ApiError ? e.status : null, message: e instanceof ApiError ? e.detail : e instanceof Error ? e.message : String(e) } }
    // an answer for a session left (its read aborted) is dropped
    if (signal.aborted || get().session?.id !== sid || get().replaying) return
    const { state, tell } = reduceCollab(get().collab, sid, answerOf(result))
    set({ collab: state, ...(tell ? { toast: tell } : {}) })
  },

  cancelRun: async (runId) => {
    if (get().replaying) throw new Error('the replay shows the record; go back to live to stop a run')
    await api.cancel(runId)
    await get().loadTree()
  },

  stopExecution: async (executionId) => {
    if (get().replaying) throw new Error('the replay shows the record; go back to live to stop a command')
    const { stopped } = await api.stopExecution(executionId)
    void get().loadTree()
    // a background command stopped leaves the header's count at the session's next read: asked now, not at the tick
    if (get().session?.background_commands?.some((c) => c.execution_id === executionId)) void get().syncSession()
    return stopped
  },

  refreshEvidence: async () => {
    // a snapshot of the worktree costs real time on a big tree: refreshes that arrive while one runs (every tool
    // result, a checkpoint, the run's end) fold into a single trailing one instead of stacking up on the backend
    if (refreshing) { refreshAgain = true; return refreshing }
    const once = async () => {
      const session = get().session
      if (!session?.workspace) return
      const ticket = ++refreshTicket
      const opening = openTicket
      const edits = editsNow()
      try {
        const [workspace, diff, answered] = await Promise.all([api.workspace(session.workspace.id), api.diff(session.workspace.id), api.session(session.id)])
        if (ticket !== refreshTicket || opening !== openTicket || get().session?.id !== session.id) return
        set({ workspace, diff, session: adoptSession(answered, edits, get().session) })
      } catch (e) {
        // a failure of a session left (or of an earlier opening of this one) says nothing to the one shown
        if (ticket === refreshTicket && opening === openTicket && get().session?.id === session.id) set({ toast: e instanceof Error ? e.message : String(e) })
      }
    }
    refreshing = (async () => {
      try {
        await once()
        while (refreshAgain) { refreshAgain = false; await once() }
      } finally { refreshing = null }
    })()
    return refreshing
  },

  showChange: (view) => set({ changeView: view }),
  openRecords: (id) => set({ recordsRunId: id }),
  setModel: (id) => set({ modelChoice: id }),

  setDirectorModel: async (id) => {
    const ds = get().director?.director ?? get().session?.director
    if (ds && ds.state !== 'closed' && ds.transport === 'native') await get().updateDirector({ model: id })
    else set({ directorModel: id })
  },
  setGrants: async (body) => {
    const session = get().session
    if (!session) return
    const answer = await grantsChange(get, session.id, () => api.setGrants(session.id, body))
    if (answer) set({ session: adoptSession(answer.value, answer.edits, get().session, true) })
  },
  setMode: async (mode) => {
    const session = get().session
    if (!session) return
    const answer = await grantsChange(get, session.id, () => api.setSessionMode(session.id, mode))
    if (answer) set({ session: adoptSession(answer.value.session, answer.edits, get().session, true), control: answer.value.control })
  },
  loadMode: async () => {
    const session = get().session
    if (!session) return
    const opening = openTicket
    const edits = editsNow()
    const result = await api.sessionMode(session.id)
    // a read of a session left (or of an earlier opening of this one) says nothing
    if (opening !== openTicket || get().session?.id !== session.id) return
    // the control a change made here since the read left answered stands (none yet: the read's is taken)
    set({ session: adoptSession(result.session, edits, get().session), ...(grantsMoved(edits) && get().control ? {} : { control: result.control }) })
  },
  loadAccess: async () => {
    const sid = get().session?.id
    if (!sid || get().accessSaving) return
    const epoch = accessEpoch
    const read = ++accessRead
    const edits = editsNow()
    try {
      const answer = await api.sessionAccess(sid)
      // a read overtaken (the session left, a later read, a change on its way) says nothing
      if (epoch !== accessEpoch || read !== accessRead || get().accessSaving || get().session?.id !== sid) return
      const access = accessStateOf(sid, answer)
      if (!access) return
      // the session's own word comes with it (its mode beside it is the harness's too, never this page's guess)
      const fresh = answer.session && answer.session.id === sid ? adoptSession(answer.session, edits, get().session) : get().session!
      set({ access, session: { ...fresh, access_mode: access.access_mode } })
    } catch { /* an older harness without the route: the chip shows the session's word; a change is asked when made */ }
  },
  chooseAccess: async (mode) => {
    if (mode === 'sandbox' && sessionTarget(get().session, get().projects).kind !== 'local') { get().showToast('SSH: Sandbox unavailable'); return false }
    const session = get().session
    if (!session || get().accessSaving) return false
    if (mode === sessionAccess(session)) return true
    if (get().session?.id !== session.id) return false
    const epoch = accessEpoch
    ++accessRead
    const edits = editsNow()
    set({ accessSaving: true })
    try {
      const answer = await api.setSessionAccess(session.id, mode)
      if (epoch !== accessEpoch || get().session?.id !== session.id) return false
      const access = accessStateOf(session.id, answer)
      const fresh = answer.session && answer.session.id === session.id ? adoptSession(answer.session, edits, get().session) : get().session!
      set({ session: access ? { ...fresh, access_mode: access.access_mode } : fresh, ...(access ? { access } : {}) })
      return sessionAccess(get().session) === mode
    } catch (e) {
      if (epoch !== accessEpoch || get().session?.id !== session.id) return false
      // refused (409: a run, a command or an approval of the session outstanding): the access stays as it was
      const blocked = e instanceof ApiError && e.status === 409 ? blockersOf(e.body) : null
      if (blocked) set({ access: { session_id: session.id, access_mode: sessionAccess(get().session), switchable: false, blocked_by: blocked } })
      get().showToast(blockedHint(blocked) ?? (e instanceof Error ? e.message : String(e)))
      return false
    } finally {
      if (epoch === accessEpoch) set({ accessSaving: false })
    }
  },
  decide: async (approval, approve) => {
    await api.decide(approval.id, approve)
    await get().refreshEvidence()
  },
  showToast: (text) => set({ toast: text }),
  setNotice: (text) => set({ notice: text }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarWidth: (width) => {
    const clamped = Math.round(Math.min(RAIL_MAX, Math.max(RAIL_MIN, width)))
    try { localStorage.setItem(STORAGE.sidebarWidth, String(clamped)) } catch { /* no storage */ }
    set({ sidebarWidth: clamped })
  },
  setDraft: (draft) => { const owner = composerKeyOf(get()); draftRevisions.set(owner, (draftRevisions.get(owner) ?? 0) + 1); set({ draft }) },
  addImages: (files) => {
    const state = get(), target = state.session ? sessionTarget(state.session, state.projects) : taskTarget(state.target, state.projects)
    if (!allows(target, 'attachment_placement')) { get().showToast('SSH: Unsupported'); return }
    const current = get().images
    const { accepted, refused } = admit(current.length, files)
    const added: PendingImage[] = accepted.map((file, i) => ({
      id: `file_${crypto.randomUUID()}`, file, url: '', name: nameOf(file, current.length + i),
      state: 'converting', error: null, uploaded: null,
    }))
    if (added.length) set({ images: [...current, ...added] })
    if (refused.length) get().showToast(refused.join(' · '))
    // each joins as its bytes say: a HEIC photo (whatever its name) is made a JPEG first, any other image stands as
    // it is — in the composer it was added to, wherever the person has gone since
    const owner = composerKeyOf(get())
    prepareImages(added, owner, get, set)
  },
  addDraggedImage: async (raw) => {
    // only a drag this page began on its own image, taken once; any other drag of the type reads nothing
    const ref = takeDraggedImage(raw)
    if (ref === null) return
    if (get().images.length >= MAX_IMAGES) { get().showToast(`a message carries at most ${MAX_IMAGES} attachments`); return }
    const id = `file_${crypto.randomUUID()}`
    // waiting while it is read (nothing is sent meanwhile), in the composer it was dropped on
    const waiting: PendingImage = { id, file: new File([], `${ref.asset_id}.png`), url: '', name: `${ref.asset_id}.png`, state: 'converting', error: null, uploaded: null, dragged: ref }
    set({ images: [...get().images, waiting] })
    await readDropped(id, ref, composerKeyOf(get()), get, set)
  },
  retryImage: (id) => {
    const state = get(), target = state.session ? sessionTarget(state.session, state.projects) : taskTarget(state.target, state.projects)
    if (!allows(target, 'attachment_placement')) { get().showToast('SSH: Unsupported'); return }
    const image = get().images.find((i) => i.id === id)
    if (!image || image.state !== 'failed') return
    if (image.dragged) {
      set({ images: get().images.map((i) => i.id === id ? { ...i, state: 'converting', error: null } : i) })
      void readDropped(id, image.dragged, composerKeyOf(get()), get, set)
      return
    }
    set({ images: get().images.map((i) => i.id === id ? { ...i, state: 'converting', error: null } : i) })
    prepareImages([image], composerKeyOf(get()), get, set)
  },
  removeImage: (id) => {
    const image = get().images.find((i) => i.id === id)
    if (!image || image.state === 'dropping') return
    // under way: stopped as a Cancel is (the upload asks the harness to drop it and says how that went); the file stays
    const under = transfers.get(id)
    if (under) { under.abort(); return }
    // an interrupted chunked upload the harness may still hold: the file leaves only once the harness confirms it
    // dropped what arrived; until then it stays, saying so, and removing it again asks again
    const owner = composerKeyOf(get())
    const mark = (patch: Partial<PendingImage>) => set(withComposer(get(), owner, { images: composerOf(get(), owner).images.map((i) => (i.id === id && i.file === image.file ? { ...i, ...patch } : i)) }))
    const remove = () => {
      if (image.url) URL.revokeObjectURL(image.url)
      set(withComposer(get(), owner, { images: composerOf(get(), owner).images.filter((i) => !(i.id === id && i.file === image.file)) }))
    }
    void removeWaitingFile(image, (sessionId, uploadId) => dropUpload(api.uploads(sessionId), uploadId), mark, remove)
  },
  cancelTransfer: (id) => { transfers.get(id)?.abort() },
  setThinking: (level) => set({ thinking: level }),
  setMentionThinking: (model, level) => {
    const next = { ...get().mentionThinking }
    if (level === null) delete next[model]
    else next[model] = level
    set({ mentionThinking: next })
  },
  setTarget: (target) => set({ target, importRefusal: null }),
  // the launcher lives in the rail: a collapsed rail opens with it
  setSettingsOpen: (open, tab) => set(open ? { settingsOpen: true, sidebarOpen: true, ...(tab ? { settingsTab: tab } : {}) } : { settingsOpen: false }),
  setSettingsTab: (tab) => set({ settingsTab: tab }),
  refreshGate: async () => {
    const sid = get().session?.id
    if (!sid) return
    const opening = openTicket
    const edits = editsNow()
    try {
      const [c, p] = await Promise.all([api.control(sid), api.proposals(sid)])
      if (get().session?.id !== sid || opening !== openTicket) return
      // a mode changed here since the read left: its answer's control stands
      set({ ...(grantsMoved(edits) && get().control ? {} : { control: c.control }), proposals: p.proposals })
    } catch (e) {
      // a failure of a session left (or of an earlier opening of this one) says nothing to the one shown
      if (get().session?.id === sid && opening === openTicket) set({ toast: e instanceof Error ? e.message : String(e) })
    }
  },
  decideProposal: async (id, decision) => {
    const r = await api.decideProposal(id, decision)
    await get().refreshGate()
    await get().refreshEvidence()
    return String(r.result?.status ?? r.status)
  },

  loadDirector: async () => {
    const sid = get().session?.id
    if (!sid) return
    const ticket = ++directorTicket
    const opening = openTicket
    let detail: DirectorDetail
    try { detail = await api.director(sid) } catch { return }
    if (get().session?.id !== sid || ticket !== directorTicket || opening !== openTicket) return
    const ds = detail.director
    const patch: Partial<State> = { director: detail }
    // a director the page learns of now (an interaction opened it): the words go to it from here, as when the session
    // opens with one; a person who took its chip away keeps the agent until the next open
    if (ds) patch.composerTarget = loadedTarget(get().composerTarget, targetOf(ds))
    // a turn with the director now: its stream (once); its text so far comes with the detail when nothing here watches it
    const live = ds?.current_turn_id ? detail.turns.find((t) => t.id === ds.current_turn_id) : undefined
    const watching = get().directorLive?.turn_id
    if (live && (live.status === 'generating' || live.status === 'awaiting_answer')) {
      if (watching !== live.id) {
        if (detail.live && detail.live.turn_id === live.id) patch.directorLive = detail.live
        set(patch)
        get().watchDirectorTurn(live.id)
        return
      }
    } else if (watching && !detail.turns.some((t) => t.id === watching && (t.status === 'generating' || t.status === 'awaiting_answer'))) {
      get().directorDisposer?.()
      patch.directorLive = null
      patch.directorDisposer = null
    }
    set(patch)
  },

  setChatGptSheet: (open) => set({ chatGptSheet: open }),

  directWithChatGpt: async () => {
    const sid = get().session?.id
    if (!sid) return
    const targetRevision = ++composerTargetRevision
    const opening = openTicket
    const sameOpening = () => get().session?.id === sid && opening === openTicket
    const ds = get().director?.director ?? get().session?.director ?? null
    if (ds && ds.state !== 'closed' && ds.transport === 'bridge') { set({ composerTarget: 'chatgpt', noteTo: 'director', noteInteractionId: null }); return }
    ++directorTicket
    if (ds && ds.state !== 'closed') {
      await api.closeDirector(sid)
      if (sameOpening()) {
        get().directorDisposer?.()
        const closed = { ...ds, state: 'closed' as const }
        set({ director: get().director ? { ...get().director!, director: closed } : null, directorLive: null, directorDisposer: null, session: { ...get().session!, director: closed } })
      }
    }
    const body = await chatGptDirectorBody(window as { oasisCodeDesktop?: unknown })
    // The desktop handshake can take time. It configures only the originating session, never the newly visible one.
    const detail = await api.openDirector(sid, body)
    if (!sameOpening()) return
    if (targetRevision === composerTargetRevision) rememberTarget(sid, targetOf(detail.director))
    set({ director: detail, ...(targetRevision === composerTargetRevision ? { composerTarget: targetOf(detail.director), noteTo: 'director', noteInteractionId: null } : {}), session: { ...get().session!, director: detail.director } })
  },

  openDirector: async (body) => {
    const sid = get().session?.id
    if (!sid) return
    const targetRevision = ++composerTargetRevision
    const opening = openTicket
    ++directorTicket
    const detail = await api.openDirector(sid, body)
    if (get().session?.id !== sid || opening !== openTicket) return
    if (targetRevision === composerTargetRevision) rememberTarget(sid, targetOf(detail.director))
    set({ director: detail, ...(targetRevision === composerTargetRevision ? { composerTarget: targetOf(detail.director), noteTo: 'director', noteInteractionId: null } : {}), session: { ...get().session!, director: detail.director } })
  },

  updateDirector: async (body) => {
    const sid = get().session?.id
    if (!sid) return
    const detail = await api.updateDirector(sid, body)
    if (get().session?.id === sid) set({ director: detail })
  },

  closeDirector: async () => {
    const sid = get().session?.id
    if (!sid) return
    const opening = openTicket
    ++directorTicket
    await api.closeDirector(sid)
    if (get().session?.id !== sid || opening !== openTicket) return
    get().directorDisposer?.()
    const ds = get().director?.director ?? get().session?.director
    const closed = ds ? { ...ds, state: 'closed' as const } : null
    set({ director: get().director ? { ...get().director!, director: closed } : null, directorLive: null, directorDisposer: null, session: { ...get().session!, director: closed } })
    void get().loadDirector()
  },

  sayToDirector: async (text, opts, origin) => {
    const remoteTarget = sessionTarget(origin?.session ?? get().session, get().projects)
    requireRemote(remoteTarget)
    if (remoteTarget.kind !== 'local' && (origin?.images ?? get().images).length) throw new Error('SSH: Unsupported')
    const captured: SendOrigin = origin ?? { ...get(), images: get().images.map((i) => ({ ...i })), draftRevision: draftRevisions.get(composerKeyOf(get())) ?? 0 }
    const { session, director, composerTarget, thinking, modelChoice, mentionThinking } = captured
    if (!session) return
    if (get().replaying) throw new Error('the replay shows the record; go back to live to send a message')
    const ds = director?.director ?? session.director
    // Neither a lookup nor a refusal may change a bridge to native, or send to an agent instead.
    if (ds?.state === 'closed' || ds?.state === 'paused') throw new Error(`The director is ${ds.state}. Reopen or resume it, or explicitly choose the agent. The draft is kept.`)
    const refusal = destinationRefusal(ds?.transport === 'bridge' || composerTarget === 'chatgpt' ? 'chatgpt-director' : 'native-director', captured.images.length)
    if (refusal) throw new Error(refusal)
    const sid = session.id
    // no director yet and the person picked its model: it opens on that model (else the session's), then takes the words
    const pickedModel = captured.directorModel ?? null
    if (!ds && pickedModel && composerTarget !== 'chatgpt') await api.openDirector(sid, { transport: 'native', model: pickedModel, config: {} })
    const original = { images: captured.images }
    const envelope = { text, model: modelChoice ?? undefined, thinking, mentions: mentionsOf(text), participant_thinking: participantThinking(participantsOf(text), mentionThinking), ...opts }
    const sending = pendingSends.get(sid, signatureOf(text, original.images.map((i) => i.id), ['director', envelope]))
    const attachments = await uploadPending(sid, original.images, get, set)
    // A lost response reuses the same key. No fallback endpoint, including on a 409.
    await api.sayToDirector(sid, { ...envelope, attachments, client_request_id: sending.key })
    pendingSends.acknowledge(sending)
    clearSentComposer(sid, text, original.images, get, set, captured.draftRevision)
    if (get().session?.id !== sid) return
    await get().loadDirector()
    await get().syncSession()
  },

  cancelDirectorTurn: async (turnId) => {
    await api.cancelDirectorTurn(turnId)
    await get().loadDirector()
  },

  setComposerTarget: (target) => {
    ++composerTargetRevision
    const sid = get().session?.id
    if (sid) rememberTarget(sid, target)
    set({ composerTarget: target, noteTo: 'director', noteInteractionId: null })
  },

  loadSurfaces: async () => {
    const session = get().session
    if (!session || get().replaying) return
    const ticket = ++surfaceTicket
    let surfaces: UiSurfaceRecord[]
    // a harness without surfaces (an older build) answers nothing here: the threads stay as they are
    try { surfaces = (await api.uiSurfaces(session.id)).surfaces } catch { return }
    if (ticket !== surfaceTicket || get().session?.id !== session.id || get().replaying || !Array.isArray(surfaces)) return
    for (const record of surfaces) get().adoptSurface(record)
  },

  adoptSurface: (record) => {
    const s = get()
    if (!isSurfaceRecord(record) || !s.session || record.session_id !== s.session.id || s.replaying) return
    // a session surface whose anchor or writer the page knows as a run that may not present one is not shown
    if (!admitWith([...s.runs, ...s.tree], s.session)(record)) return
    // into its run's rows in place (a session surface: the anchor's, whichever run wrote it); a run streaming here
    // places its own new surfaces (where it presented them)
    const patch = adoptedSurface({ uiSurfaces: s.uiSurfaces, threads: s.threads, childThreads: s.childThreads, streamed: s.disposers, childStreamed: s.childDisposers }, record)
    if (patch) set(patch)
  },

  saveSurfaceState: async (target, revision, state) => {
    const { surface } = await api.saveUiState(target.session_id, target.run_id, target.surface_id, { revision, state })
    get().adoptSurface(surface)
    return surface
  },

  prepareSurfaceAction: async (snapshot) => {
    if (get().replaying) throw new Error('the replay shows the record; go back to live to use a surface')
    const prepared = await api.prepareUiAction(snapshot.session_id, snapshot.run_id, snapshot.surface_id,
      { revision: snapshot.revision, action_id: snapshot.action_id, state: snapshot.state, request_id: snapshot.request_id })
    get().adoptSurface(prepared.surface)
    return prepared
  },

  placeActionPrompt: (sessionId, receiptId, prompt) => placeOnce(placedReceipts, receiptId, () => get().appendDraft(sessionId, prompt)),

  appendDraft: (sessionId, text) => {
    const s = get()
    set(withPromptInDraft(s, composerKeyOf(s), sessionId, text))
  },

  loadInputs: async () => {
    const session = get().session
    if (!session || get().replaying) return
    const ticket = ++inputTicket
    let inputs: unknown[]
    try { inputs = (await api.uiInputs(session.id, { status: 'pending' })).inputs } catch { return }
    if (ticket !== inputTicket || get().session?.id !== session.id || get().replaying || !Array.isArray(inputs)) return
    for (const record of inputs) get().adoptInput(record)
    // a form held here as pending that the list no longer has was answered or closed meanwhile: its record says how
    const listed = new Set(inputs.map((r) => (r as { id?: unknown }).id))
    for (const held of Object.values(get().uiInputs)) {
      if (held.status !== 'pending' || listed.has(held.id)) continue
      void api.uiInput(session.id, held.id).then(({ input }) => get().adoptInput(input), () => undefined)
    }
  },

  adoptInput: (record) => {
    const s = get()
    if (!isInputRecord(record) || !s.session || record.session_id !== s.session.id || s.replaying) return
    if (!inputSupersedes(record, s.uiInputs[record.id])) return
    // into the rows of its run wherever they are on the page (the thread's, an agent card's); a run not on the page
    // shows it where pending forms of other runs stand
    // a run streaming here places its own new forms (where it asked for them); one it has is updated in place
    const into = (rows: ThreadEntry[] | undefined, live: boolean): ThreadEntry[] | undefined => {
      if (!rows) return rows
      if (live && !rows.some((e) => e.kind === 'input' && e.input?.id === record.id)) return rows
      return upsertInput(rows, record.run_id, record)
    }
    const thread = s.threads[record.run_id]
    const child = s.childThreads[record.run_id]
    const t = into(thread, !!s.disposers[record.run_id])
    const c = into(child, !!s.childDisposers[record.run_id])
    set({
      uiInputs: { ...s.uiInputs, [record.id]: record },
      ...(t && t !== thread ? { threads: { ...s.threads, [record.run_id]: t } } : {}),
      ...(c && c !== child ? { childThreads: { ...s.childThreads, [record.run_id]: c } } : {}),
    })
  },

  loadTaskRuns: async () => {
    const session = get().session
    if (!session || get().replaying) return
    const ticket = ++taskTicket
    let tasks: unknown[]
    try { tasks = (await api.uiTasks(session.id)).tasks } catch { return }
    if (ticket !== taskTicket || get().session?.id !== session.id || !Array.isArray(tasks)) return
    for (const t of tasks) get().adoptTaskRun(t)
  },

  adoptTaskRun: (record) => {
    const parsed = UiTaskRecordSchema.safeParse(record)
    const s = get()
    if (!parsed.success || !s.session || parsed.data.session_id !== s.session.id) return
    const task = parsed.data
    // the surface that started it hears it too (a record from the thread's own stream is as good as its own)
    surfaceTasks.peek({ session_id: task.session_id, run_id: task.surface_run_id, surface_id: task.surface_id })?.adopt(task)
    if (!task.agent_run_id) return
    const held = s.uiTaskRuns[task.agent_run_id]
    if (held && !(task.updated_at > held.updated_at)) return
    set({ uiTaskRuns: { ...s.uiTaskRuns, [task.agent_run_id]: task } })
  },

  watchDirectorTurn: (turnId) => {
    get().directorDisposer?.()
    const current = get().directorLive
    set({ directorLive: current && current.turn_id === turnId ? current : { turn_id: turnId, text: '', thinking: '', tool_calls: [] } })
    const onEvent = (item: SSEItem) => {
      const live = get().directorLive
      if (!live || live.turn_id !== turnId) return
      const d = item.data
      if (item.event === 'text_delta') set({ directorLive: { ...live, text: d.start === true ? String(d.text ?? '') : live.text + String(d.text ?? '') } })
      else if (item.event === 'thinking_delta') set({ directorLive: { ...live, thinking: d.start === true ? String(d.text ?? '') : live.thinking + String(d.text ?? '') } })
      else if (item.event === 'tool_call') {
        // the call as it goes out: what it asked for, the arguments it passed (the plan, for a schedule call)
        const args = d.args && typeof d.args === 'object' && !Array.isArray(d.args) ? (d.args as Record<string, unknown>) : null
        set({ directorLive: { ...live, tool_calls: [...live.tool_calls, { name: String(d.name ?? ''), summary: String(d.summary ?? ''), status: 'running', args, outcome: '' }] } })
      } else if (item.event === 'tool_result') {
        const calls = [...live.tool_calls]
        const at = calls.map((c) => c.name === String(d.name ?? '') && c.status === 'running').lastIndexOf(true)
        // what came back: the transport's own account, else its summary line
        if (at >= 0) calls[at] = { ...calls[at]!, status: String(d.status ?? 'ok'), outcome: typeof d.outcome === 'string' ? d.outcome : String(d.summary ?? '') }
        set({ directorLive: { ...live, tool_calls: calls } })
      } else if (item.event === 'turn_finished') {
        // the note the turn wrote arrives with the session; the turn row's end with the director detail
        void get().syncSession()
        void get().loadDirector()
      }
    }
    const onClose = () => {
      if (get().directorLive?.turn_id === turnId) set({ directorLive: null, directorDisposer: null })
      void get().loadDirector()
    }
    set({ directorDisposer: subscribeDirectorTurn(turnId, onEvent, onClose, -1) })
  },
}))

watchAccessActivity()
