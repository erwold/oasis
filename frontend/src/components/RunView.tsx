import { useEffect, useMemo, useRef } from 'react'
import type { RunTreeRow } from '../api/types'
import { entriesPicker, type Lineage } from '../state/lineage'
import { botFor, LIVE_STATUSES, nameOf } from '../state/outline'
import { BotImage, RunBot, useRunPresence } from './BotImage'
import { cardStateWord } from './AgentPresentation'
import { useStore } from '../state/store'
import { revealRun } from './Desk'
import type { ThreadEntry } from '../state/thread'
import { connectorOf, contextTokens, queuedSteers, turnFooter, turnParts } from '../state/turns'
import { WithEntities } from './EntityChip'
import { Prose } from './Prose'
import { NodeAdoptions, NodeHandover, NodeStepFoot, Row, RunLiveLine, SteerRow } from './Thread'
import { RunScope } from './Media'
import { focusStep, useDesk, type FocusPhase } from '../state/desk'
import { ReferenceButtons, RunHandover } from './Relations'
import { interactionTurnOf } from '../state/interaction'
import { useReplay } from '../state/replay'
import { useFollowBottom } from './useFollowBottom'
import { attributionOf } from '../state/attribution'
import { AttributionMark } from './AttributionMark'

/** An agent's own conversation (carried from oasis components/RunDetail.tsx, see NOTICE): its order as the
 *  message it was given, then its stream — prose, tool calls, dispatches — rendered exactly like the session
 *  thread and live while it runs, and, once it ended, what the runner measured beside what it said of itself;
 *  every run that continued it follows in turn. (The person's next request goes from the thread's composer, which
 *  names the agent.) */

export function RunView({ row, kids }: { row: Lineage; kids: RunTreeRow[] }) {
  const models = useStore((s) => s.models)
  const watchChild = useStore((s) => s.watchChild)
  const interactions = useStore((s) => s.interactions)
  const replaying = useReplay((s) => s.active)
  const { ref: logRef, node: logNode, setPinned, onScroll } = useFollowBottom()
  const runIds = row.lineage.map((r) => r.id).join(',')
  // the rows of this card's runs alone (another run's stream draws this card's conversation never)
  const ids = useMemo(() => runIds.split(','), [runIds])
  const pick = useMemo(entriesPicker, [])
  const own = useStore((s) => pick(ids, s.childThreads, s.threads))
  const isThread = useStore((s) => row.lineage.some((r) => s.runs.some((x) => x.id === r.id)))
  const usage = useStore((s) => s.runs.find((r) => r.id === row.latest.id)?.usage)
  useEffect(() => { if (!isThread) row.lineage.forEach((r) => { if (r.spawned_by !== 'human_action') void watchChild(r.id) }) }, [runIds, isThread, watchChild]) // eslint-disable-line react-hooks/exhaustive-deps
  const latest = row.latest
  // the run brought into view by a jump (the thread's summary, the relations, a step's button) — that very run, even
  // when a later one carries the card on; found once its turn is on the card and again once the turns above it are
  // read (a transcript still loading moves it), never on every frame of a stream (state/desk.ts focusStep)
  const focused = useDesk((s) => (s.focused?.windowId === `run:${row.id}` ? s.focused : null))
  const handled = useRef<{ nonce: number; phase: FocusPhase } | null>(null)
  const target = focused ? row.lineage.findIndex((r) => r.id === focused.runId) : -1
  const settled = target >= 0 && row.lineage.slice(0, target + 1).every((r, i) => r.spawned_by === 'human_action' || own[i] !== undefined)
  useEffect(() => {
    const step = focusStep(handled.current, focused, target >= 0, settled)
    if (!step || !focused) return
    const log = logNode.current
    const el = log?.querySelector<HTMLElement>(`[data-run-id="${CSS.escape(focused.runId)}"]`)
    if (!log || !el) return
    const fresh = handled.current?.nonce !== focused.nonce
    handled.current = { nonce: focused.nonce, phase: step }
    setPinned(false)
    // the card's own log scrolls, nothing around it: scrollIntoView would scroll the card's frame too and push its
    // title (the window's drag strip in the desktop app) out of place
    log.scrollTo({ top: log.scrollTop + el.getBoundingClientRect().top - log.getBoundingClientRect().top, behavior: fresh ? 'smooth' : 'auto' })
    // lit once per ask
    if (fresh) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash') }
  }, [focused, target, settled, logNode, setPinned])
  const live = LIVE_STATUSES.has(latest.status)
  const turns = useMemo(() => row.lineage.map((r, i) => {
    const rows = own[i] ?? []
    // a finished run of an agent beside the thread whose stored conversation is being read (the card asked for it as
    // it opened): said so, not taken for one that has none
    const reading = own[i] === undefined && !isThread && !replaying && r.spawned_by !== 'human_action'
    const receipt = r.receipt
    // a run whose stream is gone (an earlier process): its last words stand in for the stream
    const fallback: ThreadEntry[] = !LIVE_STATUSES.has(r.status) && rows.length === 0 && receipt?.final_text
      ? [{ kind: 'agent', text: receipt.final_text, runId: r.id }] : []
    return { run: r, entries: rows.length ? rows : fallback, reading }
  }), [row.lineage, own, isThread, replaying])
  const modelLabel = (m: string | null) => models.find((x) => x.id === m)?.label ?? (m ?? 'no model')
  const bot = botFor(row)
  const receipt = latest.receipt
  const mech = receipt?.mechanical
  const attribution = attributionOf(receipt)
  const human = latest.spawned_by === 'human_action'
  // the agent's current state: its bot and its word in the head (the same reading as its card's)
  const headState = useRunPresence(latest)
  return (
    <div className="thread-scroll run-detail in-card" ref={logRef} data-testid={`agent-view-${row.id}`}
         onScroll={onScroll}>
      <div className="rd-head">
        {bot && <BotImage bot={bot} state={headState} />}
        <span className="rd-name">{nameOf(row)}</span>
        <span>· {human ? 'a person' : modelLabel(latest.model)} · {cardStateWord(latest, headState)}{row.lineage.length > 1 ? ` · ${row.lineage.length} runs` : ''}</span>
        <span className="thread-spacer" />
      </div>
      {turns.map(({ run, entries, reading }, i) => {
        const order = run.work_order
        const who = run.spawned_by === 'wake' ? 'oasis-code · a watch reported' : connectorOf(run) ? `${connectorOf(run)} (connector)` : run.spawned_by === 'human' || run.spawned_by === 'human_action' || !run.spawned_by ? 'you' : `order from ${run.spawned_by.replace(/^run:/, '')}`
        // as it happened, like the session thread: words said between tool calls stand between them
        const parts = turnParts(entries)
        const words = i === 0 && order ? `${order.goal ? `${order.goal}\n\n` : ''}${order.prompt ?? run.user_text}` : run.user_text
        // a group member's step: what the harness handed it and the evidence of its run, its state and Keep — the
        // step's own lines, which stand here since its runs are the group's, not the thread's
        const step = interactionTurnOf(interactions, run)
        const ended = !LIVE_STATUSES.has(run.status)
        return (
          <div key={run.id} className="rd-turn" data-run-id={run.id} data-testid={`card-run-${run.id}`}
               data-interaction={step?.interaction.id} data-node={step?.node.id} data-participant={step?.node.participant}>
            <div className="turn turn-user">
              <span className="turn-who">{who}</span>
              {/* a message without words carried images only (the harness takes no empty message); the thread shows them */}
              {words.trim() ? <div className="turn-text"><WithEntities text={words} /></div> : <div className="turn-text dim">sent images only</div>}
            </div>
            {step && <NodeHandover run={run} turn={step} live={!ended} />}
            <RunHandover runId={run.id} />
            <RunScope.Provider value={{ sessionId: run.session_id, workspaceId: run.workspace_id, runId: run.id }}>
              {parts.map((part, j) => part.kind === 'work'
                ? <div key={j} className="work open"><div className="work-body">{part.entries.map((e, k) => <Row key={e.eventId ?? e.toolCallId ?? k} entry={e} />)}</div></div>
                : part.kind === 'agent'
                ? (
                  <div key={j} className={`turn turn-agent${part.entry.running ? ' streaming' : ''}`}>
                    <span className="turn-who">{bot && <RunBot bot={bot} run={run} className="turn-bot" />}{modelLabel(run.model)}</span>
                    <div className="turn-text prose"><Prose text={part.entry.text ?? ''} /></div>
                  </div>
                )
                : part.kind === 'steer'
                ? <SteerRow key={`steer-${part.entry.steer?.id ?? j}`} entry={part.entry} />
                : <div key={j} className="work open"><div className="work-body"><Row entry={part.entry} /></div></div>)}
              {queuedSteers(entries).map((e) => <SteerRow key={`steer-${e.steer!.id}`} entry={e} />)}
            </RunScope.Provider>
            {LIVE_STATUSES.has(run.status) && (
              <RunLiveLine bot={bot} run={run} entries={entries} />
            )}
            {entries.length === 0 && !LIVE_STATUSES.has(run.status) && <p className="dim small">{reading ? 'Reading the stored conversation…' : 'No stored conversation.'}</p>}
            {ended && run.spawned_by !== 'human_action' && <div className="turn-footer"><ReferenceButtons runId={run.id} status={run.status} />{step && <NodeStepFoot runId={run.id} receipt={run.receipt} turn={step} />}</div>}
            {ended && step && <NodeAdoptions turn={step} />}
          </div>
        )
      })}
      {receipt && mech && !live && (
        <dl className="rd-kv rd-receipt" data-testid="card-receipt">
          <dt>measured</dt><dd>{turnFooter(receipt, { tokens: contextTokens(usage ?? latest.usage), window: models.find((m) => m.id === latest.model)?.context_window ?? null })}{mech.human_action ? ` · action ${mech.human_action}` : ''}
            {mech.refused_calls ? ` · ${mech.refused_calls} refused (order ${mech.blocked_calls ?? 0}, locks ${mech.lock_refusals ?? 0})` : ''}{mech.lock_violations ? ` · ${mech.lock_violations} lock violation(s)` : ''}
          </dd>
          {mech.diff && <><dt>changed</dt><dd data-testid="card-receipt-changed">{attribution.kind === 'unavailable' ? 'not attributable to this run' : `${mech.diff.files ?? '?'} file(s) +${mech.diff.added ?? '?'} −${mech.diff.removed ?? '?'}`}{mech.checkpoints.length ? ` · checkpoints ${mech.checkpoints.join(', ')}` : ''}
            {attribution.kind !== 'exact' && <> <AttributionMark view={attribution} /></>}</dd></>}
          {mech.checks && <><dt>checks</dt><dd>{mech.checks.passed} passed · {mech.checks.failed} failed · {mech.checks.unknown} unknown · {mech.checks.not_run ?? 0} not run</dd></>}
          {mech.acceptance && Object.keys(mech.acceptance).length > 0 && <><dt>acceptance</dt><dd>{Object.entries(mech.acceptance).map(([k, v]) => `${k}: ${v}`).join(' · ')}</dd></>}
          {receipt.error && <><dt>error</dt><dd className="err">{receipt.error}</dd></>}
        </dl>
      )}
      {kids.length > 0 && (
        <div className="rd-kids">
          {kids.map((c) => <button key={c.id} className="thread-btn" onClick={() => revealRun(c.id)}>{nameOf(c)} · {c.status}</button>)}
        </div>
      )}
    </div>
  )
}
