import { RemoteIdentity } from './SshTarget'
import { hostFor, useSsh } from '../state/ssh'
import { CHATGPT_WEB_ID } from '@oasis-code/contract'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { api } from '../api/client'
import type { CheckResult, DiffResponse, Execution, OutputWindow, RunTreeRow } from '../api/types'
import { TAIL_H, cardKeptOnUndock, maxDepthFor, cardsAtRest, cardsOverflowing, fitDesk, nearestCorner, placeDock, placeStack, placeTail, resizeFrom, settleReveals, useDesk, type Keepout } from '../state/desk'
import type { Corner, DeskWindow, Placed, ResizeEdge } from '../state/desk'
import { anyEntry, cardIdForRun, commandPulse, foldAgents, isThreadRow, keepUnchanged } from '../state/lineage'
import type { Lineage } from '../state/lineage'
import { botClock, botColor, botFor, isActionRow, LIVE_STATUSES, nameOf } from '../state/outline'
import { BotImage, useRunPresence } from './BotImage'
import type { BotState } from '../state/outline'
import { useReplay } from '../state/replay'
import { runOfRow } from '../state/replayState'
import { useStore } from '../state/store'
import { browserPlacer, chatGptPlacer, usesAgentBrowser } from '../state/desktop'
import openaiLogo from '../assets/logo-openai.png'
import { AgentOutline } from './AgentOutline'
import { BrowserMeta, BrowserPage, ClearBrowserDataButton } from './BrowserPage'
import { ChatGptPage } from './ChatGptPage'
import { DirectButton, directedByChatGpt, ReloadButton } from './ChatGptSheet'
import { FloatingWindow } from './FloatingWindow'
import { teamsMeta } from './DeskFrame'
import { cardStateWord, subAgentCounts } from './AgentPresentation'
import { AgentCardStrip } from './AgentPresentationView'
import { FileDiffIcon, GlobeIcon, LayersIcon, StackCascadeIcon, StackColumnIcon, StackGridIcon } from './icons'
import { RunRecords } from './RunRecords'
import { RunView } from './RunView'
import { terminalStatus, terminalText } from '../state/terminalOutput'
import { Patch, WorkspaceBody } from './Workspace'

/** The desk layer over the thread (carried from oasis components/Desk.tsx, see NOTICE). Every agent's card and
 *  the workspace card are cards in one stack in a corner (the front card whole, the ones behind a column of title
 *  strips, a cascade, or a grid); the agent graph is a dock in another corner. A run's card shows the agent's own
 *  conversation, and beside it what its worktree holds — the changes, the terminal, the checks — and its records.
 *  Clicking a card brings it to the front; dragging a card carries the whole stack to another corner, where it
 *  snaps and glides into place; dragging the graph does the same for the dock. */

const CLICK_SLOP = 4
const FOLLOW = 0.3
const FOLLOW_FALLOFF = 0.84
const transformOf = (x: number, y: number, lifted: boolean) => `translate3d(${x}px, ${y}px, 0)${lifted ? ' scale(1.025)' : ''}`

/** The desk's way to show an agent: its card, taken back from the shelf if need be, at the front. `runId` is any run
 *  of the agent — a later step or a follow-up is on the card its first run opened (cardIdForRun), never a card of its
 *  own; the run itself is brought into view on the card. */
export function raiseAgentCard(runId: string): void {
  revealRun(runId)
}

/** Every jump to a run's card goes here (the thread's dispatch summaries, a step's card button, Compare, the
 *  relations, the outline): the card that carries the run comes off the shelf, to the front, the run in view. A run
 *  not in the tree yet (just dispatched) waits: the tree is read now and the card shows as soon as it exists. */
export function revealRun(runId: string): boolean {
  const tree = useStore.getState().tree
  const windowId = cardIdForRun(foldAgents(tree), runId)
  const desk = useDesk.getState()
  if (windowId) { desk.reveal(windowId, runId); return true }
  desk.waitReveal(runId, Date.now())
  void useStore.getState().loadTree()
  return false
}

/** The thread's own agent: the session's main participant (schema v25); an older row without one, a run of the
 *  thread. A relay's turns are the thread's too, but each speaker is an agent of its own: its card rests like any. */
const isOwnAgent = (row: Lineage): boolean => (row.collab ? row.collab.participant_role === 'main' : isThreadRow(row))

/** The desk's way to show the ChatGPT director's page: its card (there while the session's director is on the
 *  bridge), taken back from the shelf, at the front. */
export function raiseChatGptCard(): void {
  const desk = useDesk.getState()
  if (!desk.windows.chatgpt) desk.ensure('chatgpt', 'chatgpt')
  if (desk.windows.chatgpt?.min) desk.setMin('chatgpt', false)
  desk.focus('chatgpt')
}

export function raiseWorkspaceCard(): void {
  const desk = useDesk.getState()
  if (!desk.windows.workspace) desk.ensure('workspace', 'workspace')
  if (desk.windows.workspace?.min) desk.setMin('workspace', false)
  desk.focus('workspace')
}

function Bot({ bot, state, size = 18 }: { bot: string | null; state: BotState; size?: number }) {
  if (!bot) return <span className="desk-bot" style={{ width: size, height: size }} />
  return <BotImage bot={bot} state={state} className="desk-bot" size={size} />
}

const NO_ENTRIES: never[] = []

/** Where an agent card reads its run's records, its worktree's changes and checks and its commands' output: the
 *  harness's API by default; a caller may hand its own (the same calls, the same answers), kept stable across draws. */
export type CardDataSource = Pick<typeof api, 'run' | 'output' | 'diff' | 'workspace'>

/** An agent's bot where its card is listed (the shelf's chip, its list): its current run's state (useRunPresence —
 *  read for that run alone, so a chip draws again when its own state changes, not on every row of every run). */
function CardBot({ row, size }: { row: Lineage; size: number }) {
  return <Bot bot={botFor(row)} state={useRunPresence(row.latest)} size={size} />
}

/** Whether an agent of the session used the agent's browser: each run's answer kept for its rows (lineage.ts anyEntry) */
const usedAgentBrowser = anyEntry(usesAgentBrowser)

interface Drag {
  what: 'stack' | 'graph' | 'resize-card' | 'resize-graph'
  startX: number; startY: number; dx: number; dy: number; moved: boolean; w0: number; h0: number; edge: ResizeEdge
}

const RESIZE_CURSOR: Record<ResizeEdge, string> = {
  n: 'resizing-ns', s: 'resizing-ns', e: 'resizing-ew', w: 'resizing-ew', ne: 'resizing-nesw', sw: 'resizing-nesw', nw: 'resizing-nwse', se: 'resizing-nwse',
}

type Tab = 'thread' | 'changes' | 'terminal' | 'checks' | 'records'
const TABS: Tab[] = ['thread', 'changes', 'terminal', 'checks', 'records']
// during a replay a card shows what the record says at the cursor; the worktree's changes, terminal and checks are
// live and wait for the live view
const REPLAY_TABS: Tab[] = ['thread', 'records']

/** A card's title: a participant's is its own id (the card holds every step it ran; its model is the line under the
 *  title); any other agent's, its order's label or the person's first line. */
function cardTitle(row: Lineage): string {
  return row.participant_alias || nameOf(row)
}

/** An agent's card. It draws again when what it shows changes — its row, its place, its own run's state — never for
 *  another agent's stream or a tree read again unchanged (every prop is kept stable by the desk). Its body is drawn
 *  once the card is first shown whole (the front card, a cascade's or a grid's, expanded) and then kept: a title
 *  strip in a column never drew its body visibly, and a stored conversation is read when the card opens on it
 *  (RunView), not for every finished agent of the session. */
export const RunCard = memo(function RunCard({ win, row, kids, place, dragging, resizing, onTitlePointerDown, onResizePointerDown, elRef, subAgents = 0, dataSource = api }: {
  win: DeskWindow; row: Lineage; kids: RunTreeRow[]; place: Placed; dragging: boolean; resizing: boolean
  /** the desk's clock for the row (botClock): kept for the memo; the bot reads its own state (useRunPresence) */
  clock?: number
  /** the agents this card's agent started over its whole lineage, each once (subAgentCounts) */
  subAgents?: number
  dataSource?: CardDataSource
  onTitlePointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void
  onResizePointerDown: (e: ReactPointerEvent<HTMLDivElement>, edge: ResizeEdge) => void
  elRef: (el: HTMLElement | null) => void
}) {
  const label = useStore((s) => s.models.find((m) => m.id === row.model)?.label)
  const cancelRun = useStore((s) => s.cancelRun)
  const forget = useDesk((s) => s.forget)
  const replaying = useReplay((s) => s.active)
  const [chosen, setTab] = useState<Tab>('thread')
  // a jump to one of this card's runs shows the card's conversation, where the run is brought into view
  const focused = useDesk((s) => (s.focused?.windowId === win.id ? s.focused : null))
  useEffect(() => { if (focused) setTab('thread') }, [focused])
  const tabs = replaying ? REPLAY_TABS : TABS
  const tab = tabs.includes(chosen) ? chosen : 'thread'
  const latest = row.latest
  const bot = botFor(row)
  const state = useRunPresence(latest)
  const live = LIVE_STATUSES.has(row.status)
  const model = label ?? row.model?.replace(/^[a-z]+:/, '') ?? ''
  const expanded = useDesk((s) => s.expanded === win.id)
  const whole = !place.collapsed || expanded
  const [opened, setOpened] = useState(whole)
  if (whole && !opened) setOpened(true)
  // a child's records during a replay: the row as it stood at the cursor, never the live row's
  const stored = useStore((s) => s.runs.find((r) => r.id === latest.id))
  const record = stored ?? (replaying ? runOfRow(latest) : undefined)
  // the state word first, in its tone (a dot carries it); the model and the runs after it, quieter
  const meta = (
    <span className={`desk-state s-${row.status}`} data-state={state}>
      <i className="desk-dot" aria-hidden /><span className="desk-word">{cardStateWord(latest, state)}</span>
      {model ? <span className="desk-sub">{`\u00a0· ${model}`}</span> : null}{row.lineage.length > 1 ? <span className="desk-sub">{`\u00a0· ×${row.lineage.length}`}</span> : null}
    </span>
  )
  // a replay shows the record: nothing on a card stops, continues or starts real work
  const actions = live && !replaying ? <button className="thread-btn danger" onClick={() => void cancelRun(latest.id)} data-testid="card-stop">Stop</button> : undefined
  return (
    <FloatingWindow win={win} x={place.x} y={place.y} w={place.w} h={place.h} depth={place.depth} collapsed={place.collapsed} dragging={dragging} resizing={resizing}
                    title={cardTitle(row)} icon={<Bot bot={bot} state={state} />} meta={meta} actions={actions} accent={bot ? botColor(bot) : undefined}
                    closable={!live} onClose={() => forget(win.id)} bodyClass="rv" onTitlePointerDown={onTitlePointerDown} onResizePointerDown={onResizePointerDown}
                    elRef={elRef} testId={`card-${row.id}`}>
      {opened && (
        <>
          <AgentCardStrip row={row} state={state} agents={subAgents} />
          <div className="seg card-tabs">
            {tabs.map((t) => (
              <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)} data-testid={`card-tab-${t}`}>{t}</button>
            ))}
          </div>
          <div className="card-view">
            {tab === 'thread' && <RunView row={row} kids={kids} />}
            {tab === 'changes' && (latest.workspace_id ? <ChangesView workspaceId={latest.workspace_id} runId={latest.id} data={dataSource} /> : <p className="dim small">No worktree.</p>)}
            {tab === 'terminal' && <TerminalView runId={latest.id} data={dataSource} />}
            {tab === 'checks' && (latest.workspace_id ? <ChecksView workspaceId={latest.workspace_id} runId={latest.id} data={dataSource} /> : <p className="dim small">No worktree.</p>)}
            {tab === 'records' && (record ? <RunRecords run={record} dataSource={dataSource} /> : <RecordsOf runId={latest.id} data={dataSource} />)}
          </div>
        </>
      )}
    </FloatingWindow>
  )
})

/** A child's records: the run row read from the API (the thread's own runs are in the store already). */
function RecordsOf({ runId, data }: { runId: string; data: CardDataSource }) {
  const [run, setRun] = useState<Parameters<typeof RunRecords>[0]['run'] | null>(null)
  useEffect(() => {
    let alive = true
    void data.run(runId).then((d) => { if (alive) setRun(d) }, () => { if (alive) setRun(null) })
    return () => { alive = false }
  }, [runId, data])
  if (!run) return <p className="dim small">loading the run's records…</p>
  return <RunRecords run={run} dataSource={data} />
}

/** The card's own reads of its worktree refresh when the run's rows change (a tool finished, the run ended), not
 *  on a clock: a snapshot of a big tree is real work for the backend. */
function useRunPulse(runId: string): number {
  const rows = useStore((s) => s.childThreads[runId] ?? s.threads[runId] ?? NO_ENTRIES)
  const finished = rows.filter((e) => e.kind === 'activity' && !e.running).length
  const live = useStore((s) => LIVE_STATUSES.has(s.tree.find((r) => r.id === runId)?.status ?? 'done'))
  return finished * 2 + (live ? 1 : 0)
}

function ChangesView({ workspaceId, runId, data }: { workspaceId: string; runId: string; data: CardDataSource }) {
  const [diff, setDiff] = useState<DiffResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pulse = useRunPulse(runId)
  useEffect(() => {
    let alive = true
    const timer = window.setTimeout(() => data.diff(workspaceId).then((d) => { if (alive) setDiff(d) }, (e) => { if (alive) setError(String(e)) }), 400)
    return () => { alive = false; window.clearTimeout(timer) }
  }, [workspaceId, pulse, data])
  const [one, setOne] = useState<{ path: string; patch: string | null } | null>(null)
  const [allRows, setAllRows] = useState(false)
  if (error) return <p className="err small">{error}</p>
  if (!diff) return <p className="dim small">Measuring the diff…</p>
  // a file's own diff, asked for by its path (a whole diff too large comes in part)
  const open = (path: string) => {
    setOne({ path, patch: null })
    void data.diff(workspaceId, { path }).then((d) => setOne((o) => (o?.path === path ? { path, patch: d.patch } : o)), (e) => setError(String(e)))
  }
  const rows = allRows ? diff.files : diff.files.slice(0, SHOWN_FILE_ROWS)
  return (
    <div data-testid="card-changes">
      <RemoteIdentity />
      <p className="dim small">{diff.files.length} file(s) against base {diff.base_commit.slice(0, 10)} · tree {diff.tree_sha.slice(0, 10)}</p>
      {rows.map((f) => <button type="button" key={f.path} className="file-row" onClick={() => open(f.path)} title="Its own diff"><FileDiffIcon size={12} /><code>{f.path}</code><span className="add">+{f.added ?? '?'}</span><span className="del">−{f.removed ?? '?'}</span></button>)}
      {rows.length < diff.files.length && <button type="button" className="link-btn small" onClick={() => setAllRows(true)}>and {diff.files.length - rows.length} more files</button>}
      {diff.review_flags.length > 0 && <p className="warn small">review_required: {diff.review_flags.map((f) => `${f.kind} (${f.path})`).join('; ')}</p>}
      {one ? (
        <>
          <p className="dim small"><code>{one.path}</code> · <button type="button" className="link-btn" onClick={() => setOne(null)}>all files</button></p>
          {one.patch === null ? <p className="dim small">Measuring the diff…</p> : one.patch ? <Patch text={one.patch} /> : <p className="dim small">No change against the base.</p>}
        </>
      ) : (
        <>
          {diff.patch_cut && <p className="dim small" data-testid="patch-cut">The diff is {Math.round(diff.patch_cut.chars / 1_000_000) || '<1'} MB: shown for the first {diff.patch_cut.shown_files} of {diff.patch_cut.total_files} files. Click a file for its own diff.</p>}
          {diff.patch ? <Patch text={diff.patch} /> : <p className="dim small">No change against the base.</p>}
        </>
      )}
    </div>
  )
}

/** The file rows listed at once; the rest on asking (a workspace with thousands of new files lists them in a click). */
const SHOWN_FILE_ROWS = 300

type Stream = 'stdout' | 'stderr'

/** A run's commands and what they wrote — either stream, chosen; the one with the bytes when only one has any
 *  (a test runner writes its report on stderr), so a command never looks silent while its log is full. */
function TerminalView({ runId, data }: { runId: string; data: CardDataSource }) {
  const [executions, setExecutions] = useState<Execution[]>([])
  const [pick, setPick] = useState<string | null>(null)
  const [chosen, setStream] = useState<Stream | null>(null)
  const [out, setOut] = useState<OutputWindow | null>(null)
  // the run's commands are read again when a command call ended or the run did — each read is the run's whole record
  // (its requests and every execution), so never after every other tool call
  const commands = useStore((s) => commandPulse(s.childThreads[runId] ?? s.threads[runId] ?? NO_ENTRIES))
  const live = useStore((s) => LIVE_STATUSES.has(s.tree.find((r) => r.id === runId)?.status ?? 'done'))
  const pulse = commands * 2 + (live ? 1 : 0)
  // a command is running when its row still is: only then does the log get polled
  const commandRunning = useStore((s) => (s.childThreads[runId] ?? s.threads[runId] ?? NO_ENTRIES).some((e) => e.kind === 'activity' && e.tool === 'bash' && e.running))
  useEffect(() => {
    let alive = true
    void data.run(runId).then((d) => { if (alive) setExecutions(d.executions) }, () => undefined)
    return () => { alive = false }
  }, [runId, pulse, commandRunning, data])
  const current = pick ?? executions.at(-1)?.id ?? null
  const execution = executions.find((x) => x.id === current)
  const stream: Stream = chosen ?? (execution && execution.stdout_bytes === 0 && execution.stderr_bytes > 0 ? 'stderr' : 'stdout')
  useEffect(() => {
    if (!current) return
    let alive = true
    setOut(null)
    const load = () => data.output(current, stream, 0, 65536).then((o) => { if (alive && o.execution_id === current && o.stream === stream) setOut(o) }, () => undefined)
    void load()
    const timer = commandRunning ? window.setInterval(load, 1500) : null
    return () => { alive = false; if (timer) window.clearInterval(timer) }
  }, [current, stream, commandRunning, pulse, data])
  if (executions.length === 0) return <p className="dim small">This run ran no command.</p>
  const other: Stream = stream === 'stdout' ? 'stderr' : 'stdout'
  const otherBytes = execution ? (other === 'stdout' ? execution.stdout_bytes : execution.stderr_bytes) : 0
  const bytes = (which: Stream) => (execution ? (which === 'stdout' ? execution.stdout_bytes : execution.stderr_bytes) : null)
  return (
    <div data-testid="card-terminal" data-stream={stream}>
      <select value={current ?? ''} onChange={(e) => { setPick(e.target.value); setStream(null) }}>
        {executions.map((x) => <option key={x.id} value={x.id}>{x.command.slice(0, 60)} · {x.status}{x.exit_code != null ? ` · exit ${x.exit_code}` : ''}</option>)}
      </select>
      <div className="seg small">
        {(['stdout', 'stderr'] as Stream[]).map((which) => (
          <button key={which} className={stream === which ? 'on' : ''} onClick={() => setStream(which)} data-testid={`card-terminal-${which}`}>{which}{bytes(which) !== null ? ` · ${bytes(which)} B` : ''}</button>
        ))}
        {out && <span className="dim small" data-testid="card-terminal-status"> {terminalStatus(out)}</span>}
      </div>
      <pre className="terminal">{terminalText(out, stream, otherBytes)}</pre>
    </div>
  )
}

function ChecksView({ workspaceId, runId, data }: { workspaceId: string; runId: string; data: CardDataSource }) {
  const [checks, setChecks] = useState<CheckResult[] | null>(null)
  useEffect(() => {
    let alive = true
    void data.workspace(workspaceId).then((w) => { if (alive) setChecks(w.checks) }, () => { if (alive) setChecks([]) })
    return () => { alive = false }
  }, [workspaceId, data])
  if (!checks) return <p className="dim small">Loading the checks…</p>
  if (checks.length === 0) return <p className="dim small">No check ran on this worktree.</p>
  return (
    <div data-testid="card-checks">
      {checks.map((c) => (
        <div key={c.id} className="file-row"><code>{c.check_id}</code><span className={`pill ${c.status}`}>{c.status}</span>
          <span className="dim small">{c.reason}{c.stale ? ' · stale' : ''}{c.run_id === runId ? ' · by this run' : ''}</span></div>
      ))}
    </div>
  )
}

/** `dataSource`: where the agent cards read their records, changes, checks and output (the API by default); hand a
 *  stable one (a module constant, a memo) — a new one per draw reads everything again. Drawn again when that or what
 *  it reads changes, never only because the thread around it drew again (a stream's every flush). */
export const Desk = memo(function Desk({ dataSource = api }: { dataSource?: CardDataSource } = {}) {
  const session = useStore((s) => s.session)
  // the tree read again keeps every run that did not change, and the whole tree when none did (nothing below is
  // folded again for a tree that came back the same: every event of every run reads it)
  const read = useStore((s) => s.tree)
  const keptTree = useRef<RunTreeRow[] | null>(null)
  const tree = useMemo(() => (keptTree.current = keepUnchanged(keptTree.current, read)), [read])
  // one card per agent: a participant's steps (a relay's turns, an interaction's nodes) are one card, its thread every
  // step. A tree read again keeps every agent whose rows did not change, so its card does not draw again
  const keptRows = useRef<Lineage[] | null>(null)
  const rows = useMemo(() => (keptRows.current = keepUnchanged(keptRows.current, foldAgents(tree))), [tree])
  const treeOf = useStore((s) => s.treeOf)
  const agentCount = useMemo(() => rows.filter((r) => !isActionRow(r)).length, [rows])
  // the agents each card's agent started, over its whole lineage, each counted once
  const subAgents = useMemo(() => subAgentCounts(rows, tree), [rows, tree])
  // each card's children (the runs it ordered, its buttons), kept per card while they did not change
  const keptKids = useRef(new Map<string, RunTreeRow[]>())
  const kidsOf = useMemo(() => {
    const next = new Map<string, RunTreeRow[]>()
    for (const r of tree) {
      if (!r.parent_run_id) continue
      const kids = next.get(r.parent_run_id)
      if (kids) kids.push(r); else next.set(r.parent_run_id, [r])
    }
    for (const [id, kids] of next) next.set(id, keepUnchanged(keptKids.current.get(id) ?? null, kids))
    keptKids.current = next
    return next
  }, [tree])
  const watchChild = useStore((s) => s.watchChild)
  const windows = useDesk((s) => s.windows)
  const ensure = useDesk((s) => s.ensure)
  const forget = useDesk((s) => s.forget)
  // the desktop app draws the ChatGPT page on a card of its own while ChatGPT directs the session (its director is on
  // the bridge) or answers in it (a run of ChatGPT on the web)
  const placeChatGpt = useMemo(() => chatGptPlacer(window as { oasisCodeDesktop?: unknown }), [])
  const directing = useStore((s) => directedByChatGpt(s.session?.director))
  const chatGptSpeaks = rows.some((r) => r.model === CHATGPT_WEB_ID)
  // the page shows in one place at a time: the sheet in the middle of the window takes it from the card
  const sheetOpen = useStore((s) => s.chatGptSheet)
  const chatGptCard = !!placeChatGpt && (directing || chatGptSpeaks)
  // the agent's browser (computer use) on a card of its own once an agent of the session used it: the person watches
  // it work, and can take the page over (the agent waits while they use it)
  const placeBrowser = useMemo(() => browserPlacer(window as { oasisCodeDesktop?: unknown }), [])
  const browserUsed = useStore((s) => usedAgentBrowser(s.childThreads, s.threads))
  const preview = useSsh((s) => s.preview)
  const sshHosts = useSsh((s) => s.targets)
  const previewHost = preview ? hostFor({ kind: 'ssh', target_id: preview.target_id }, sshHosts) : undefined
  const forwarded = preview?.session_id === session?.id && previewHost?.state === 'ready' && previewHost.generation === preview?.generation
  const browserCard = !!placeBrowser && (browserUsed || forwarded)
  const setMin = useDesk((s) => s.setMin)
  const focusCard = useDesk((s) => s.focus)
  const openDesk = useDesk((s) => s.openSession)
  const stackCorner = useDesk((s) => s.stackCorner)
  const graphCorner = useDesk((s) => s.graphCorner)
  const stackMode = useDesk((s) => s.stackMode)
  const setStackMode = useDesk((s) => s.setStackMode)
  const card = useDesk((s) => s.card)
  const graphSize = useDesk((s) => s.graph)
  const setStackCorner = useDesk((s) => s.setStackCorner)
  const setGraphCorner = useDesk((s) => s.setGraphCorner)
  const setCardSize = useDesk((s) => s.setCardSize)
  const setGraphSize = useDesk((s) => s.setGraphSize)
  const replaying = useReplay((s) => s.active)
  const replayCursor = useReplay((s) => s.cursor)
  const expandedId = useDesk((s) => s.expanded)
  const layerRef = useRef<HTMLDivElement>(null)
  const [bounds, setBounds] = useState<{ width: number; height: number; keep: Keepout | null }>({ width: 1200, height: 800, keep: null })
  const [realNow, setNow] = useState(() => Date.now())
  const [drag, setDrag] = useState<Drag | null>(null)
  const [shelfOpen, setShelfOpen] = useState(false)
  const dragRef = useRef<Drag | null>(null)
  const cardEls = useRef(new Map<string, HTMLElement>())
  const frame = useRef<number | null>(null)
  const orderRef = useRef<string[]>([])
  const placeById = useRef(new Map<string, Placed>())
  const now = replaying ? replayCursor : realNow
  // one ref callback per card for the desk's life: a new one on every draw would draw every card again
  const refs = useRef(new Map<string, (el: HTMLElement | null) => void>())
  const refFor = (id: string) => {
    let ref = refs.current.get(id)
    if (!ref) { ref = (el) => { if (el) cardEls.current.set(id, el); else cardEls.current.delete(id) }; refs.current.set(id, ref) }
    return ref
  }

  useLayoutEffect(() => {
    const el = layerRef.current
    if (!el) return
    // the desk reaches the window's bottom; the composer (the dock's box, bottom left) is what a card beside it clears.
    // The dock stays while what it holds changes (the composer, the replay bar), so it is the dock that is watched and
    // its box is read afresh each time
    const dock = el.parentElement?.querySelector<HTMLElement>('.composer-dock') ?? null
    const apply = () => {
      const layer = el.getBoundingClientRect()
      // the composer (or the replay bar): not the jump-to-bottom button floating over it
      const box = dock?.querySelector(':scope > :not(.jump-bottom)')?.getBoundingClientRect()
      const keep = box && box.width > 0 ? { right: Math.round(box.right - layer.left), h: Math.round(layer.bottom - box.top) } : null
      setBounds({ width: el.clientWidth, height: el.clientHeight, keep })
    }
    apply()
    const observer = new ResizeObserver(apply)
    observer.observe(el)
    if (dock) observer.observe(dock)
    return () => observer.disconnect()
  }, [])
  useEffect(() => { openDesk(session?.id ?? null) }, [session?.id, openDesk])
  const ticking = !replaying && rows.some((r) => LIVE_STATUSES.has(r.status) || (r.finished_at && now - Date.parse(r.finished_at) < 45_000))
  useEffect(() => {
    if (!ticking) return
    // a hidden page draws nothing on the clock; back in view, at once
    const tick = () => { if (!document.hidden) setNow(Date.now()) }
    const timer = window.setInterval(tick, 1000)
    document.addEventListener('visibilitychange', tick)
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', tick) }
  }, [ticking])
  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows])
  // the docks exist once the session is open; every agent (a lineage with a model) but the thread's own gets a card (the
  // thread shows that one's work; a jump to it, from the board or the outline, makes its card), the stream of each of
  // its runs still at work watched (a finished run's stored conversation is read by its card's thread when it shows,
  // RunView — never for every finished agent at once); a run window with no agent in this session is dropped
  useEffect(() => {
    if (!session) return
    ensure('workspace', 'workspace')
    ensure('graph', 'graph')
    if (chatGptCard) ensure('chatgpt', 'chatgpt')
    else if (useDesk.getState().windows.chatgpt) forget('chatgpt')
    if (browserCard) ensure('browser', 'browser')
    else if (useDesk.getState().windows.browser) forget('browser')
    const ordered = [...rows].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
    for (const row of ordered) {
      if (!row.model || row.spawned_by === 'human_action' || row.spawned_by === 'plan') continue     // a plan's own rows are no runs
      if (!isThreadRow(row) && !replaying) row.lineage.forEach((r) => { if (LIVE_STATUSES.has(r.status)) void watchChild(r.id) })
      if (!isOwnAgent(row)) ensure(`run:${row.id}`, 'run', row.id)
    }
    // a tree being read again (the session reopened, a replay left) has no rows yet: no card is dropped for that
    if (!replaying && treeOf !== session.id) return
    for (const w of Object.values(useDesk.getState().windows)) if (w.kind === 'run' && (!w.runId || !byId.has(w.runId))) forget(w.id)
  }, [session, rows, byId, ensure, forget, watchChild, replaying, chatGptCard, browserCard, treeOf])
  // a jump that came before its card (a run just dispatched): shown once the tree has it
  const pendingReveal = useDesk((s) => s.pendingReveal)
  useEffect(() => {
    if (!session || !Object.keys(pendingReveal).length) return
    const { show, expired } = settleReveals(pendingReveal, (runId) => cardIdForRun(rows, runId), Date.now())
    for (const { windowId, runId } of show) useDesk.getState().reveal(windowId, runId)
    if (expired.length) useDesk.getState().dropPending(expired)
  }, [session, rows, pendingReveal])
  // as a session opens (once: a card the person takes back stays, an agent that ends meanwhile keeps its card), every
  // finished agent but the thread's own is put on the shelf — the cards in view are the agents still at work — and
  // the thread's own card, made by a jump the last time the session was open, is put away. The
  // session as it opened is its first tree answer, even an empty one: a run that first shows finished after it (one
  // quicker than the next tree read) ended while the person watched, and keeps its card
  const restedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!session || replaying || treeOf !== session.id || restedFor.current === session.id) return
    restedFor.current = session.id
    const resting = (runId: string) => { const row = byId.get(runId); return !!row && !LIVE_STATUSES.has(row.status) && !isOwnAgent(row) }
    const { windows: open, revealed } = useDesk.getState()
    cardsAtRest(open, resting, revealed).forEach((id) => setMin(id, true))
    for (const w of Object.values(open)) {
      const row = w.kind === 'run' && w.runId ? byId.get(w.runId) : undefined
      if (row && isOwnAgent(row) && !(w.id in revealed)) forget(w.id)
    }
  }, [session, treeOf, byId, replaying, setMin, forget])
  const stack = useMemo(() => Object.values(windows)
    .filter((w) => !w.min && (w.kind === 'workspace' || (w.kind === 'chatgpt' && chatGptCard) || (w.kind === 'browser' && browserCard) || (w.kind === 'run' && !!w.runId && byId.has(w.runId))))
    .sort((a, b) => b.z - a.z), [windows, byId, chatGptCard, browserCard])
  // the sizes and corners as this desk can show them: the person's own on a wide desk; on a narrow one the card and
  // the dock cut to the desk, one above the other (the dock's corner moved to the stack's other end)
  const dockShown = !!windows.graph && !windows.graph.min
  const fit = useMemo(() => fitDesk(card, graphSize, stackCorner, graphCorner, stackMode, bounds.width, bounds.height, bounds.keep, stack.length, dockShown), [card, graphSize, stackCorner, graphCorner, stackMode, bounds, stack.length, dockShown])
  const shownCard = fit.card, shownGraph = fit.graph, shownGraphCorner = fit.graphCorner
  const maxDepth = fit.maxDepth
  // the dock put away frees its height for the card to be dragged into, without moving the card: the size it was
  // shown at beside the dock becomes the person's own
  const dockedCard = useRef<{ w: number; h: number } | null>(null)
  useLayoutEffect(() => {
    if (dockShown) { dockedCard.current = shownCard; return }
    const kept = cardKeptOnUndock(dockedCard.current, card)
    dockedCard.current = null
    if (kept) setCardSize(kept)
  }, [dockShown, shownCard, card, setCardSize])
  useEffect(() => {
    if (stack.length <= maxDepth + 1) return
    const resting = (w: DeskWindow) => {
      if (w.kind !== 'run' || !w.runId) return false
      const row = byId.get(w.runId)
      return !!row && !LIVE_STATUSES.has(row.status) && !isOwnAgent(row)
    }
    cardsOverflowing(stack, resting, maxDepth, fit.narrow).forEach((w) => setMin(w.id, true))
  }, [stack, byId, setMin, maxDepth, fit.narrow])
  const places = useMemo(() => placeStack(stack.length, stackCorner, shownCard, bounds.width, bounds.height, stackMode, bounds.keep), [stack.length, stackCorner, shownCard, bounds, stackMode])
  const graphPlace = placeDock(shownGraphCorner, shownGraph, bounds.width, bounds.height, bounds.keep)
  useLayoutEffect(() => {
    orderRef.current = stack.map((w) => w.id)
    placeById.current = new Map(stack.map((w, i) => [w.id, places[i]]))
  }, [stack, places])

  // dragging: the pointer leads and the cards follow it as a spring — the front card closest, each card behind a
  // little later — moved on the elements themselves, frame by frame; on release the stack (or the graph) glides
  // into the nearest corner
  const startDrag = (what: Drag['what'], e: ReactPointerEvent<HTMLDivElement>, w0 = 0, h0 = 0, edge: ResizeEdge = 'se') => {
    e.preventDefault()
    const begin: Drag = { what, startX: e.clientX, startY: e.clientY, dx: 0, dy: 0, moved: false, w0, h0, edge }
    dragRef.current = begin
    setDrag(begin)
    if (what === 'resize-card' || what === 'resize-graph') document.body.classList.add(RESIZE_CURSOR[edge])
    type Moving = { id: string; el: HTMLElement; x: number; y: number; sx: number; sy: number; k: number }
    let moving: Moving[] | null = null
    const gather = (): Moving[] => {
      if (moving) return moving
      moving = []
      if (what === 'stack') {
        orderRef.current.forEach((id, i) => {
          const el = cardEls.current.get(id), p = placeById.current.get(id)
          if (el && p) moving!.push({ id, el, x: p.x, y: p.y, sx: 0, sy: 0, k: FOLLOW * FOLLOW_FALLOFF ** i })
        })
      } else if (what === 'graph') {
        const el = cardEls.current.get('graph')
        if (el) moving.push({ id: 'graph', el, x: graphPlace.x, y: graphPlace.y, sx: 0, sy: 0, k: FOLLOW })
      }
      return moving
    }
    const tick = () => {
      const d = dragRef.current
      if (!d) return
      let settled = true
      for (const m of gather()) {
        m.sx += (d.dx - m.sx) * m.k
        m.sy += (d.dy - m.sy) * m.k
        if (Math.abs(d.dx - m.sx) > 0.3 || Math.abs(d.dy - m.sy) > 0.3) settled = false
        m.el.style.transform = transformOf(m.x + m.sx, m.y + m.sy, true)
      }
      frame.current = settled ? null : requestAnimationFrame(tick)
    }
    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current
      if (!d) return
      const dx = ev.clientX - d.startX, dy = ev.clientY - d.startY
      const next = { ...d, dx, dy, moved: d.moved || Math.abs(dx) > CLICK_SLOP || Math.abs(dy) > CLICK_SLOP }
      dragRef.current = next
      if (next.what === 'resize-card') setCardSize(resizeFrom(next.edge, stackCorner, { w: next.w0, h: next.h0 }, dx, dy))
      else if (next.what === 'resize-graph') setGraphSize(resizeFrom(next.edge, graphCorner, { w: next.w0, h: next.h0 }, dx, dy))
      else if (frame.current == null) frame.current = requestAnimationFrame(tick)
    }
    const onUp = () => {
      const d = dragRef.current
      dragRef.current = null
      if (frame.current != null) { cancelAnimationFrame(frame.current); frame.current = null }
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      document.body.classList.remove(...Object.values(RESIZE_CURSOR))
      setDrag(null)
      if (!d) return
      if (d.what === 'stack' || d.what === 'graph') {
        const held = gather()
        if (!d.moved) { held.forEach((m) => { m.el.style.transform = transformOf(m.x, m.y, false) }); return }
        const box = layerRef.current?.getBoundingClientRect()
        const width = box?.width ?? bounds.width, height = box?.height ?? bounds.height
        const lead = held[0]
        const anchor = d.what === 'stack' ? { x: (lead?.x ?? 0) + (lead?.sx ?? d.dx), y: (lead?.y ?? 0) + (lead?.sy ?? d.dy), w: shownCard.w, h: shownCard.h }
          : { x: graphPlace.x + (lead?.sx ?? d.dx), y: graphPlace.y + (lead?.sy ?? d.dy), w: shownGraph.w, h: shownGraph.h }
        const corner: Corner = nearestCorner(anchor.x + anchor.w / 2, anchor.y + anchor.h / 2, width, height)
        // the two never share a corner: the one already there takes the corner the mover left
        const { stackCorner: sc, graphCorner: gc } = useDesk.getState()
        let nextStack = sc, nextGraph = gc
        if (d.what === 'stack') { nextStack = corner; if (corner === gc) nextGraph = sc } else { nextGraph = corner; if (corner === sc) nextStack = gc }
        const order = orderRef.current
        const nextFit = fitDesk(card, graphSize, nextStack, nextGraph, stackMode, width, height, bounds.keep, order.length, dockShown)
        const stackPlaces = placeStack(order.length, nextStack, nextFit.card, width, height, stackMode, bounds.keep)
        order.forEach((id, i) => { const el = cardEls.current.get(id); if (el && stackPlaces[i]) el.style.transform = transformOf(stackPlaces[i].x, stackPlaces[i].y, false) })
        const dock = placeDock(nextFit.graphCorner, nextFit.graph, width, height, bounds.keep)
        const graphEl = cardEls.current.get('graph')
        if (graphEl) graphEl.style.transform = transformOf(dock.x, dock.y, false)
        if (nextStack !== sc) setStackCorner(nextStack)
        if (nextGraph !== gc) setGraphCorner(nextGraph)
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // the cards' gestures, one function each for the desk's life (a card draws again only for what it shows), calling the
  // drag as the latest draw defines it
  const gesture = useRef({ startDrag, shownCard })
  useLayoutEffect(() => { gesture.current = { startDrag, shownCard } })
  const onStackTitle = useCallback((e: ReactPointerEvent<HTMLDivElement>) => gesture.current.startDrag('stack', e), [])
  const onCardResize = useCallback((e: ReactPointerEvent<HTMLDivElement>, edge: ResizeEdge) => {
    const { startDrag: drag, shownCard: size } = gesture.current
    drag('resize-card', e, size.w, size.h, edge)
  }, [])

  if (!session) return null
  const shelved = Object.values(windows).filter((w) => w.min && (w.kind !== 'run' || (!!w.runId && byId.has(w.runId)))).sort((a, b) => b.z - a.z)
  const live = rows.filter((r) => LIVE_STATUSES.has(r.status)).length
  const graphWin = windows.graph
  const tail = placeTail(stack.length, stackCorner, shownCard, bounds.width, bounds.height, stackMode, bounds.keep)
  const onRight = stackCorner === 'tr' || stackCorner === 'br'
  const onBottom = stackCorner === 'br' || stackCorner === 'bl'
  const tailTransform = onBottom ? `translate3d(${tail.x}px, ${tail.y + TAIL_H}px, 0) translateY(-100%)` : `translate3d(${tail.x}px, ${tail.y}px, 0)`
  const iconOf = (w: DeskWindow, size = 16) => {
    if (w.kind === 'graph') return <LayersIcon size={size - 3} />
    if (w.kind === 'workspace') return <FileDiffIcon size={size - 3} />
    if (w.kind === 'chatgpt') return <img className="desk-logo" src={openaiLogo} alt="" width={size - 2} height={size - 2} />
    if (w.kind === 'browser') return <GlobeIcon size={size - 3} />
    const row = w.runId ? byId.get(w.runId) : undefined
    return row ? <CardBot row={row} size={size} /> : <Bot bot={null} state="static" size={size} />
  }
  const labelOf = (w: DeskWindow) => {
    if (w.kind === 'graph') return 'Agent Teams'
    if (w.kind === 'workspace') return 'Workspace'
    if (w.kind === 'chatgpt') return 'ChatGPT'
    if (w.kind === 'browser') return 'Browser'
    const row = byId.get(w.runId ?? '')
    return row ? cardTitle(row) : w.id
  }
  const takeBack = (w: DeskWindow) => { setMin(w.id, false); focusCard(w.id); setShelfOpen(false) }
  return (
    <div className={`desk-layer${expandedId ? ' has-expanded' : ''}`} ref={layerRef} data-testid="desk">
      {(stack.length > 0 || shelved.length > 0) && (
        <div className={`desk-tail${onRight ? ' right' : ' left'}${onBottom ? ' bottom' : ' top'}${shelfOpen ? ' open' : ''}${drag?.what === 'resize-card' ? ' resizing' : ''}`}
             style={{ transform: tailTransform, width: places[0]?.w ?? shownCard.w, zIndex: shelfOpen ? 900 : 1 }}>
          <div className="desk-tail-row">
            {shelved.length > 0 && (
              <button className="desk-tail-chip" title={`${shelved.length} card${shelved.length === 1 ? '' : 's'} put away — click to list`} onClick={() => setShelfOpen((o) => !o)} data-testid="desk-shelf">
                <span className="desk-tail-faces">{shelved.slice(0, 3).map((w) => <span key={w.id} className="desk-tail-face">{iconOf(w, 16)}</span>)}</span>
                <span>+{shelved.length}</span>
              </button>
            )}
            <div className="desk-stack-modes">
              <button className={`icon-btn${stackMode === 'column' ? ' on' : ''}`} title="Stack the cards in a column" onClick={() => setStackMode('column')}><StackColumnIcon size={14} /></button>
              <button className={`icon-btn${stackMode === 'cascade' ? ' on' : ''}`} title="Cascade the cards toward the centre" onClick={() => setStackMode('cascade')}><StackCascadeIcon size={14} /></button>
              <button className={`icon-btn${stackMode === 'grid' ? ' on' : ''}`} title="Tile every card across the desk" onClick={() => setStackMode('grid')}><StackGridIcon size={14} /></button>
            </div>
          </div>
          {shelfOpen && shelved.length > 0 && (
            <div className="desk-tail-list">
              {shelved.map((w) => <button key={w.id} className="desk-chip" title={labelOf(w)} onClick={() => takeBack(w)}>{iconOf(w, 16)}<span>{labelOf(w)}</span></button>)}
            </div>
          )}
        </div>
      )}
      {graphWin && !graphWin.min && (
        <FloatingWindow win={graphWin} x={graphPlace.x} y={graphPlace.y} elRef={refFor('graph')} w={shownGraph.w} h={shownGraph.h} depth={0}
                        dragging={drag?.what === 'graph'} resizing={drag?.what === 'resize-graph'} title="Agent Teams" icon={<LayersIcon size={13} />}
                        meta={<span className="desk-state">{teamsMeta(agentCount, live)}</span>} bodyClass="graph-body" testId="graph-dock"
                        onTitlePointerDown={(e) => startDrag('graph', e)} onResizePointerDown={(e, edge) => startDrag('resize-graph', e, graphSize.w, graphSize.h, edge)}>
          <AgentOutline />
        </FloatingWindow>
      )}
      {stack.map((w, i) => {
        // in a column or a cascade every card past the deepest place stands on that place, under the card there (the
        // stack is drawn by z): never seen, never drawn — a session of 300 live agents draws 9 cards, not 300
        if (stackMode !== 'grid' && i > maxDepthFor(stackMode)) return null
        const place = places[i]
        const dragging = drag?.what === 'stack'
        const resizing = drag?.what === 'resize-card'
        if (w.kind === 'workspace') {
          return (
            <FloatingWindow key={w.id} win={w} x={place.x} y={place.y} w={place.w} h={place.h} depth={place.depth} dragging={dragging} resizing={resizing}
                            collapsed={place.collapsed} elRef={refFor(w.id)} title="Workspace" icon={<FileDiffIcon size={13} />}
                            meta={<span className="desk-state">{session.workspace?.branch ?? ''}</span>} bodyClass="workspace-body" testId="card-workspace"
                            onTitlePointerDown={(e) => startDrag('stack', e)} onResizePointerDown={(e, edge) => startDrag('resize-card', e, shownCard.w, shownCard.h, edge)}>
              {replaying ? <p className="dim small workspace-replay-note" data-testid="workspace-replay-note">The replay shows the record; the workspace is live. Back to live to see it.</p> : <WorkspaceBody />}
            </FloatingWindow>
          )
        }
        if (w.kind === 'chatgpt') {
          if (!placeChatGpt) return null
          return (
            <FloatingWindow key={w.id} win={w} x={place.x} y={place.y} w={place.w} h={place.h} depth={place.depth} dragging={dragging} resizing={resizing}
                            collapsed={place.collapsed} elRef={refFor(w.id)} title="ChatGPT" icon={iconOf(w, 14)}
                            meta={<span className="desk-state">{directing ? 'director' : 'participant'}</span>} actions={<><ReloadButton /><DirectButton /></>} bodyClass="chatgpt-body" testId="card-chatgpt"
                            onTitlePointerDown={(e) => startDrag('stack', e)} onResizePointerDown={(e, edge) => startDrag('resize-card', e, shownCard.w, shownCard.h, edge)}>
              {sheetOpen ? <p className="chatgpt-page-hint">The ChatGPT page is open in the middle of the window.</p> : <ChatGptPage place={placeChatGpt} />}
            </FloatingWindow>
          )
        }
        if (w.kind === 'browser') {
          if (!placeBrowser) return null
          return (
            <FloatingWindow key={w.id} win={w} x={place.x} y={place.y} w={place.w} h={place.h} depth={place.depth} dragging={dragging} resizing={resizing}
                            collapsed={place.collapsed} elRef={refFor(w.id)} title="Browser" icon={iconOf(w, 14)}
                            meta={<><BrowserMeta />{forwarded && <RemoteIdentity />}</>} actions={<ClearBrowserDataButton />} bodyClass="chatgpt-body browser-body" testId="card-browser"
                            onTitlePointerDown={(e) => startDrag('stack', e)} onResizePointerDown={(e, edge) => startDrag('resize-card', e, shownCard.w, shownCard.h, edge)}>
              <BrowserPage place={placeBrowser} />
            </FloatingWindow>
          )
        }
        const row = w.runId ? byId.get(w.runId) : undefined
        if (!row) return null
        return (
          <RunCard key={w.id} win={w} row={row} kids={kidsOf.get(row.id) ?? NO_ENTRIES} place={place} dragging={dragging} resizing={resizing} clock={botClock(row, now)} elRef={refFor(w.id)}
                   onTitlePointerDown={onStackTitle} onResizePointerDown={onCardResize} subAgents={subAgents.get(row.id) ?? 0} dataSource={dataSource} />
        )
      })}
    </div>
  )
})
