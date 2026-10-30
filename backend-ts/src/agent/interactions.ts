/** The interaction: one message of the person to several agents, run as a graph of nodes. Each node is one run of
 *  one participant on its participant's model, started when every node it depends on has ended, handed — as one
 *  packet per node it receives, part of the message that opens its run — the answer, the tool-call lines and the
 *  measured facts of those nodes, and nothing of the others. A node works on the session's working folder (one node
 *  at a time there, continuing the session's conversation), on its participant's own copy of the files from the
 *  interaction's common starting point, or on the copy another node worked on. Every participant keeps a
 *  conversation of its own across its nodes, only ever appended to.
 *
 *  The plan is data: a fixed template's, or the director's — asked once with the request (a turn of its own
 *  session, with the schedule tool), and again only where the plan says `then: director`. The harness executes the
 *  plan here and persists every step in `interactions` / `interaction_nodes` / `interaction_events`: a node starts
 *  only from the runner's finish hook or a schedule call, after the earlier runs' rows are written; a stop, a
 *  failure, a budget line, a restart or a run that ended waiting for the person's decision ends the harness's own
 *  scheduling — the person continues, or not. What a participant does is the person's request (and the director's
 *  note for the step); no role is assigned here. */

import {
  ACTIVE_INTERACTION_STATUSES, ACTIVE_RUN_STATUSES, aliasedAgentMentions, DEFAULT_INTERACTION_CONCURRENCY, MAX_INTERACTION_CONCURRENCY,
  MAX_INTERACTION_PARTICIPANTS, MAX_INTERACTION_RUNS, newParticipantId, PARTICIPANT_ID, type Budget, type Attachment, type Interaction, type InteractionDetail,
  type InteractionNode, type InteractionNote, type InteractionParticipant, type InteractionTemplate, type InteractionThen, type IntegrationResult, type Run,
  type ScheduleNode, type Session, type DirectorTurn, type DirectorToolSurface,
} from '@oasis-code/contract'
import type { AppState } from '../api/state.ts'
import { credentialState } from '../auth/routing.ts'
import * as repo from '../db/repo.ts'
import type { Conn } from '../db/database.ts'
import * as directorStore from '../director/store.ts'
import { THINKING_LEVELS } from '@oasis-code/contract'
import { findModel } from '../llm/catalog.ts'
import { isChatGptWeb } from '../llm/chatgpt_web.ts'
import { attachmentRefusal } from '@oasis-code/contract'
import { effectiveLocks, listProposals } from '../policy/gate.ts'
import { nowIso } from '../timebase.ts'
import { newId } from '../ids.ts'
import type { ResolvedMention } from '../workspace/entities.ts'
import { GitError } from '../workspace/git.ts'
import { isDirect } from '../workspace/service.ts'
import { withExcludedRepositories } from '../workspace/roots.ts'
import { holderEnds, WorkspaceBusy } from '../workspace/locks.ts'
import { integrate } from '../workspace/integrate.ts'
import { recordHumanRun } from './human_runs.ts'
import { requestLines } from './named_tools.ts'
import { MAX_ANSWER_CHARS, measuredLine, nodePacket } from './peer_packet.ts'
import { budgetLineOf } from './relay.ts'
import { configuredCheckIds, KeyConflict, type InteractionNodeRun } from './runner.ts'
import { surfaceOf, surfaceText } from '../director/surfaces/index.ts'
import { CollabRefused, mainHeadRun, originOf, prepareHandover, type Handover } from './collab.ts'
import { collabText } from './collab_texts.ts'
import * as crepo from '../db/collab_repo.ts'
import type { NewEdge } from '../db/collab_repo.ts'
import type { Citation, Origin, ScheduleNodeV2 } from '@oasis-code/contract'
import { checkCounts } from './work_orders.ts'
import { PROMPT_TEXT, text } from '../prompt_texts.ts'

export class InteractionInvalid extends Error {
  /** code and extra: a machine-readable reason and its fields beside the words (workspace_busy: who holds the folder) */
  constructor(message: string, readonly status = 400, readonly code: string | null = null, readonly extra: Record<string, unknown> | null = null) { super(message); this.name = 'InteractionInvalid' }
}

/** A refusal of the folder's lock as an interaction's: 409 workspace_busy with who holds the folder and how to go on. */
/** The key a note's steer carries in a run: one steer per note and run, the same key again answered with it. */
function noteSteerKey(noteId: string): string { return `note:${noteId}` }

function busyInvalid(busy: WorkspaceBusy): InteractionInvalid {
  return new InteractionInvalid(busy.message, busy.status, busy.code, { ...busy.detail })
}

export interface InteractionStartOptions {
  text: string
  participants: InteractionParticipant[]
  /** a template's plan, a fixed graph, or none: the director is asked */
  plan: { template: InteractionTemplate; cross_rounds?: number } | { nodes: ScheduleNode[]; then: InteractionThen } | null
  /** the route a native director is opened on when the session has no director (null: the session's model) */
  director_model: string | null
  mentions: ResolvedMention[]
  attachments: Attachment[]
  thinking: string | null
  /** the limits every run of the interaction runs under */
  budget: Budget | null
  max_runs: number | null
  concurrency: number | null
  client_request_id: string | null
  workspace_policy?: Interaction['workspace_policy']
  source_turn_id?: string | null
  fresh?: boolean
  resumes_run_id?: string | null
  /** schema v25: who asked for it (the group's origin), and the runs of the session the request refers to (cited on
   *  its first steps; nothing of them handed over) */
  origin?: Origin | null
  cites?: Citation[] | null
  /** the fingerprint of the request's intent: a resend under the key with another intent is refused (KeyConflict) */
  intent_sha?: string | null
}

/** A participant's follow-up (schema v25): the run it continues, the sender's words, what they name. */
export interface FollowupOptions {
  alias: string
  resumes: Run
  text: string
  origin: Origin
  model: string
  thinking: string | null
  attachments: Attachment[]
  client_request_id: string | null
  cites: Citation[]
  receive_run_ids: string[]
  handover: Handover
  expected_head_run_id: string | null
  intent_sha: string | null
  spawned_by: string
  label: string | null
  /** the person's note this follow-up hands (a note to a member whose steps had all ended) */
  note_id?: string | null
}

/** What one received step's packet handed: the exact run, whole or cut at the packet limit. */
interface ReceivedPacket { run_id: string; node: string; packet: 'whole' | 'cut'; answer_chars: number; handed_chars: number }

/** A follow-up node's message as stored (its message_json): the words, who sent them, the run it continues. */
interface FollowupMessage {
  text: string; by: 'person' | 'director' | 'connector' | 'watch'; director_turn_id: string | null; resumes_run_id: string; model: string; cites: Citation[]; origin: Origin
  client_request_id: string | null; intent_sha: string | null; attachments: Attachment[]; thinking: string | null; spawned_by: string; label: string | null
  note_id?: string | null
}

const HEAD_CHARS = 400
const head = (value: unknown, chars = HEAD_CHARS): string => {
  const t = String(value ?? '').trim().replace(/\s+/g, ' ')
  return t.length <= chars ? t : `${t.slice(0, chars)}…`
}
const ENDED = new Set(['done', 'cancelled', 'error'])

/** The nodes a fixed template expands to. */
export function expandTemplate(template: InteractionTemplate, participants: InteractionParticipant[], crossRounds = 1): { nodes: ScheduleNode[]; then: InteractionThen } {
  switch (template) {
    case 'discussion': {
      if (!Number.isInteger(crossRounds) || crossRounds < 1 || crossRounds > 4) throw new InteractionInvalid('cross_rounds must be 1–4')
      const nodes = expandTemplate('independent', participants).nodes
      let previous = [...nodes]
      for (let round = 1; round <= crossRounds; round++) {
        const wave: ScheduleNode[] = participants.map((p, i) => ({
          id: `cross-${round}-${i + 1}`, participant: p.id, instruction: null, workspace: 'own',
          depends_on: previous.map((n) => n.id), receives: previous.filter((n) => n.participant !== p.id).map((n) => n.id),
        }))
        nodes.push(...wave)
        previous = wave
      }
      return { nodes, then: 'stop' }
    }
    case 'independent':
      // a step per participant: an earlier message's letter names it as it did (`a1`), an id by its place (`solo-1`)
      return { nodes: participants.map((p, i) => ({ id: /^[A-Z]$/.test(p.id) ? `${p.id.toLowerCase()}1` : `solo-${i + 1}`, participant: p.id, instruction: null, depends_on: [], receives: [], workspace: 'own' as const })), then: 'stop' }
  }
}

/** The plan checked against the graph it joins: known participants, new ids, edges to known nodes and no cycle,
 *  receives among the steps a node comes after (directly or through the steps it waits for), each named once, a node's copy a node it
 *  comes after, one workspace per participant (a participant naming its own earlier step's copy names its own), the
 *  budget. Returns the problems (none: the plan is sound). */
/** The runs an interaction's budget counts: every run of it but a participant's follow-up's and the runs a step
 *  waiting on its watch went on in (each a message to the participant, like a follow-up). */
export function budgetedRuns(conn: Conn, interactionId: string): number {
  const followups = new Set(repo.listNodes(conn, interactionId).filter((n) => n.kind === 'followup').map((n) => n.id))
  const resumed = new Set(repo.listInteractionEvents(conn, interactionId).filter((e) => e.kind === 'node_resumed').map((e) => String(e.payload.run_id)))
  return repo.listRunsOfInteraction(conn, interactionId).filter((r) => !(r.interaction_node && followups.has(r.interaction_node)) && !resumed.has(r.id)).length
}

export function planProblems(participants: InteractionParticipant[], existing: InteractionNode[], nodes: ScheduleNode[], maxRuns: number): string[] {
  const problems: string[] = []
  const aliases = new Set(participants.map((p) => p.id))
  const known = new Map<string, { participant: string; depends_on: string[]; workspace: string }>()
  for (const n of existing) known.set(n.id, { participant: n.participant, depends_on: n.depends_on, workspace: n.workspace })
  const fresh = new Set<string>()
  for (const n of nodes) {
    if (known.has(n.id) || fresh.has(n.id)) problems.push(`node ${n.id}: the id is taken`)
    fresh.add(n.id)
  }
  const all = new Map(known)
  for (const n of nodes) if (!known.has(n.id)) all.set(n.id, { participant: n.participant, depends_on: n.depends_on, workspace: n.workspace })
  // the steps a node comes after: its dependencies and theirs (a step that waits for a2, which waits for a1, comes
  // after a1 too — the harness starts it only once both have ended)
  const before = new Map<string, Set<string>>()
  const ancestors = (id: string, seen: Set<string> = new Set()): Set<string> => {
    const known = before.get(id)
    if (known) return known
    const out = new Set<string>()
    for (const dep of all.get(id)?.depends_on ?? []) {
      if (seen.has(dep) || !all.has(dep)) continue
      out.add(dep)
      for (const up of ancestors(dep, new Set([...seen, id]))) out.add(up)
    }
    if (!seen.size) before.set(id, out)
    return out
  }
  for (const n of nodes) {
    if (!aliases.has(n.participant)) problems.push(`node ${n.id}: participant ${n.participant} is not one of ${[...aliases].join(', ')}`)
    for (const dep of n.depends_on) {
      if (!all.has(dep)) problems.push(`node ${n.id}: depends_on names no node: ${dep}`)
      if (dep === n.id) problems.push(`node ${n.id}: depends on itself`)
    }
    const after = ancestors(n.id)
    for (const r of n.receives) if (!after.has(r)) problems.push(`node ${n.id}: receives ${r}, a step it does not come after`)
    for (const r of new Set(n.receives.filter((r, i) => n.receives.indexOf(r) !== i))) problems.push(`node ${n.id}: receives ${r} more than once`)
    if (n.workspace !== 'own' && n.workspace !== 'shared') {
      if (!all.has(n.workspace)) problems.push(`node ${n.id}: workspace names no node: ${n.workspace}`)
      else if (!after.has(n.workspace)) problems.push(`node ${n.id}: works on node ${n.workspace}'s copy but does not come after it`)
    }
  }
  // one workspace per participant across its nodes; a node naming its participant's own earlier step works on the
  // same copy as that step (the participant's own, or whatever that step names)
  const kindOf = (id: string, seen: Set<string> = new Set()): string => {
    const n = all.get(id)!
    const target = n.workspace !== 'own' && n.workspace !== 'shared' ? all.get(n.workspace) : undefined
    if (target && target.participant === n.participant && !seen.has(n.workspace)) return kindOf(n.workspace, new Set([...seen, id]))
    return n.workspace
  }
  const byParticipant = new Map<string, Set<string>>()
  for (const [id, n] of all) {
    const set = byParticipant.get(n.participant) ?? new Set<string>()
    set.add(kindOf(id))
    byParticipant.set(n.participant, set)
  }
  for (const [participant, set] of byParticipant) {
    if (set.size > 1) problems.push(`participant ${participant} cannot move between copies: its nodes name ${[...set].join(', ')}`)
  }
  // no cycle: every node reaches its dependencies without coming back to itself
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (id: string, path: string[]): void => {
    const mark = state.get(id)
    if (mark === 'done') return
    if (mark === 'visiting') { problems.push(`a cycle: ${[...path, id].join(' → ')}`); return }
    state.set(id, 'visiting')
    for (const dep of all.get(id)?.depends_on ?? []) if (all.has(dep)) visit(dep, [...path, id])
    state.set(id, 'done')
  }
  for (const id of all.keys()) visit(id, [])
  // a participant's follow-up is a step of the group, not of its plan: never counted against the budget
  const followups = new Set(existing.filter((n) => n.kind === 'followup').map((n) => n.id))
  const planned = [...all.keys()].filter((id) => !followups.has(id)).length
  if (planned > maxRuns) problems.push(`the plan has ${planned} nodes; the budget allows ${maxRuns} runs in all`)
  return [...new Set(problems)]
}

/** The wave each node starts in: 1 for a node that depends on nothing, else one past the latest wave it depends on. */
export function wavesOf(nodes: Pick<InteractionNode, 'id' | 'depends_on'>[]): Map<string, number> {
  const out = new Map<string, number>()
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const visit = (id: string, seen: Set<string>): number => {
    const known = out.get(id)
    if (known !== undefined) return known
    const node = byId.get(id)
    if (node === undefined || seen.has(id)) return 0
    seen.add(id)
    const wave = 1 + Math.max(0, ...node.depends_on.map((dep) => visit(dep, seen)))
    out.set(id, wave)
    return wave
  }
  for (const n of nodes) visit(n.id, new Set())
  return out
}

function projectSource(state: AppState, session: Session, ws: import('@oasis-code/contract').Workspace): boolean {
  return ws.source_mount !== null || repo.getProject(state.conn, session.project_id)?.kind === 'attached'
}

export class InteractionManager {
  /** the process is shutting down: a run that ends now is recorded, nothing starts after it */
  private stopping = false
  /** nodes being started now (their run row not yet written): a tick never starts one twice */
  private readonly starting = new Set<string>()

  constructor(readonly state: AppState) {}

  shutdown(): void { this.stopping = true }

  attachHooks(): void {
    this.state.runs.onRunFinished((runId) => {
      try { this.onRunFinished(runId) } catch (error) { console.warn(`interaction: ${(error as Error).message}`) }
    })
    this.state.director.onTurnFinished((turn) => {
      try { this.onDirectorTurnFinished(turn) } catch (error) { console.warn(`interaction: ${(error as Error).message}`) }
    })
  }

  // -- participants ------------------------------------------------------------------------------------------------

  /** The participants of a message, checked before anything starts: two to six, aliases unique, known routes, a
   *  credential for each, image input on each when images ride along. */
  plan(agents: { model: string; id?: string | null; label?: string | null; thinking?: string | null }[], attachments: Attachment[]): InteractionParticipant[] {
    if (agents.length < 2) throw new InteractionInvalid('an interaction names at least two participants')
    if (agents.length > MAX_INTERACTION_PARTICIPANTS) throw new InteractionInvalid(`an interaction names at most ${MAX_INTERACTION_PARTICIPANTS} participants`)
    const given: string[] = []
    const participants = agents.map((a, i) => {
      if (a.thinking != null && !(THINKING_LEVELS as readonly string[]).includes(a.thinking)) throw new InteractionInvalid(`invalid thinking: ${a.thinking}`)
      const cfg = findModel(this.state.config, a.model)
      const overridden = this.state.model_overrides.has(a.model)
      if (cfg === null && !overridden) throw new InteractionInvalid(`unknown model: ${a.model}`)
      const label = a.label || cfg?.label || a.model
      if (cfg !== null && !overridden) {
        const credential = credentialState(cfg)
        if (credential.status !== 'available') throw new InteractionInvalid(`${label} has no credential here (${credential.hint ?? 'sign in or save a key on the Accounts page'})`)
      }
      const refusal = cfg && attachmentRefusal(cfg.capabilities, attachments, cfg.label || cfg.id)
      if (refusal) throw new InteractionInvalid(refusal)
      const id = a.id || newParticipantId([...agents.map((x) => x.id).filter((x): x is string => !!x), ...given])
      if (!PARTICIPANT_ID.test(id)) throw new InteractionInvalid(`a participant's id is a letter, then letters, digits, _ or -: ${id}`)
      given.push(id)
      return { id, label, model: a.model, ...(a.thinking ? { thinking: a.thinking } : {}) }
    })
    const ids = participants.map((p) => p.id)
    if (new Set(ids).size !== ids.length) throw new InteractionInvalid('two participants share an id')
    return participants
  }

  // -- start ---------------------------------------------------------------------------------------------------------

  /** An interaction under way in the session (planning, running, or its director deciding), if any. */
  active(sessionId: string): Interaction | null {
    return repo.listInteractions(this.state.conn, sessionId).find((ix) => (ACTIVE_INTERACTION_STATUSES as readonly string[]).includes(ix.status)) ?? null
  }

  private readonly starts = new Map<string, { key: string | null; promise: Promise<InteractionDetail> }>()

  /** An interaction found again by its key: the same intent answers with it; another intent (both known: an
   *  interaction recorded before intents has none) is a conflict — never the first request's interaction. */
  checkIntent(interaction: Interaction, key: string, intent: string | null): void {
    if (intent === null) return
    const created = repo.listInteractionEvents(this.state.conn, interaction.id).find((e) => e.kind === 'created')
    const recorded = typeof created?.payload?.intent_sha === 'string' ? created.payload.intent_sha : null
    if (recorded !== null && recorded !== intent) throw new KeyConflict(key, interaction.id)
  }

  async start(session: Session, o: InteractionStartOptions): Promise<InteractionDetail> {
    const held = this.starts.get(session.id)
    if (held) {
      if (o.client_request_id && held.key === o.client_request_id) return held.promise
      throw new InteractionInvalid('an interaction is being started in this session', 409)
    }
    const promise = this.startNow(session, o)
    this.starts.set(session.id, { key: o.client_request_id, promise })
    try { return await promise } finally { this.starts.delete(session.id) }
  }

  private async startNow(session: Session, o: InteractionStartOptions): Promise<InteractionDetail> {
    const conn = this.state.conn
    const prior = o.client_request_id ? repo.interactionForClientRequest(conn, session.id, o.client_request_id) : null
    if (prior) { this.checkIntent(prior, o.client_request_id!, o.intent_sha ?? null); return this.detail(prior) }
    if (o.thinking != null && !(THINKING_LEVELS as readonly string[]).includes(o.thinking)) throw new InteractionInvalid(`invalid thinking: ${o.thinking}`)
    const isolated = o.workspace_policy === 'isolated'
    if (isolated && session.workspace_id && repo.getWorkspace(conn, session.workspace_id)?.target?.kind === 'ssh') throw new InteractionInvalid('Remote isolated workspaces are unavailable; no interaction was started.', 409, 'capability_unavailable')
    if (this.state.relays.activeOf(session.id) !== null) throw new InteractionInvalid(`session ${session.id} has a relay under way; stop it first`, 409)
    if (this.state.runs.activeRunOfSession(session.id) !== null) throw new InteractionInvalid(`session ${session.id} already has an active run`, 409)
    if (session.workspace_id === null) throw new InteractionInvalid('the session has no workspace', 409)
    if (o.resumes_run_id) {
      const previous = repo.getRun(conn, o.resumes_run_id)
      if (previous === null || previous.session_id !== session.id || previous.workspace_id === null) throw new InteractionInvalid(`resumes_run_id is not a run of this session: ${o.resumes_run_id}`)
      if ((ACTIVE_RUN_STATUSES as readonly string[]).includes(previous.status)) throw new InteractionInvalid(`run ${o.resumes_run_id} is still ${previous.status}`, 409)
    }
    const budget = {
      max_runs: Math.min(MAX_INTERACTION_RUNS, o.max_runs ?? Math.max(4, o.participants.length * (o.plan && 'template' in o.plan && o.plan.template === 'discussion' ? 1 + (o.plan.cross_rounds ?? 1) : 3))),
      concurrency: Math.min(MAX_INTERACTION_CONCURRENCY, o.concurrency ?? DEFAULT_INTERACTION_CONCURRENCY),
    }
    // a fixed plan is checked before anything is pinned or opened
    let fixed: { nodes: ScheduleNode[]; then: InteractionThen } | null = null
    let template: string | null = null
    if (o.plan !== null) {
      if ('template' in o.plan) { fixed = expandTemplate(o.plan.template, o.participants, o.plan.cross_rounds); template = o.plan.template }
      else fixed = o.plan
      if (isolated && fixed.nodes.some((n) => n.workspace !== 'own')) throw new InteractionInvalid('isolated interactions only accept own workspaces')
      const problems = planProblems(o.participants, [], fixed.nodes, budget.max_runs)
      if (problems.length) throw new InteractionInvalid(`the plan is not sound: ${problems.join('; ')}`)
    }
    // the director's session: the one open on the session, else a native one on the route named (or the session's)
    let directorSessionId: string | null = o.source_turn_id ? directorStore.getTurn(conn, o.source_turn_id)?.director_session_id ?? null : null
    if (fixed === null) {
      const open = this.state.director.openOf(session.id)
      if (open !== null) directorSessionId = open.id
      else {
        // a session last spoken to on ChatGPT's page has no route of its own a director can run on: the default then
        const named = o.director_model || session.model
        const model = isChatGptWeb(named) ? (this.state.config.default_model ?? named) : named
        try {
          directorSessionId = this.state.director.open(session, { transport: 'native', model, config: {} }).id
        } catch (error) {
          throw new InteractionInvalid(`no director could be opened to plan the interaction: ${(error as Error).message}`, (error as { status?: number }).status === 409 ? 409 : 400)
        }
      }
    }
    // the common starting point of every copy: the session workspace as it stands, pinned now
    const ws = repo.getWorkspace(conn, session.workspace_id)!
    // a folder edited in place has no copies to start from: every step works in it, in turn (each queued as the
    // folder's writer); a source-mounted one reads the folder live: neither pins a base, so neither waits for a writer
    let base = null
    const sourceMounted = isolated && (isDirect(ws) || projectSource(this.state, session, ws))
    if (!isDirect(ws) && !sourceMounted) {
      // pinned as the folder's writer: refused while another holds it (naming it), never pinned under a write
      const owner = `operation:interaction_base:${newId('op')}`
      if (!this.state.locks.tryAcquire(ws.id, owner, { kind: 'operation', operation: 'interaction_base', session_id: session.id })) {
        const busy = this.state.locks.busy(ws.id, 'interaction_base', (h) => `start the interaction ${holderEnds(h)}, or with workspace_policy isolated where the folder allows it`)
        throw busy !== null ? busyInvalid(busy) : new InteractionInvalid('the session workspace has writers waiting for it; start the interaction when they have run', 409, 'workspace_busy')
      }
      try { base = await this.state.workspaces.checkpoint(ws, null, 'base for the interaction') } catch (error) {
        if (error instanceof GitError) throw new InteractionInvalid(`the starting point could not be pinned: ${error.message}`, 409)
        throw error
      } finally {
        this.state.locks.release(ws.id, owner)
      }
    }
    // efforts are the person's (or the caller's): a participant without one runs at the interaction's, else the model's
    const participants = o.participants
    // the common history every root starts from: the main agent's thread head as it stands now (never a participant's
    // own follow-up, an earlier group's step, or a separate task's run)
    const resumes = o.fresh ? null : (o.resumes_run_id ?? mainHeadRun(this.state, session.id, { sourceContinuations: isolated })?.id ?? null)
    if (o.cites?.length) prepareHandover(this.state, session, { cites: o.cites, by: o.origin ?? originOf({ actor: 'person', request: 'message' }) })
    const interaction = repo.insertInteraction(conn, {
      workspace_policy: o.workspace_policy ?? 'legacy', source_turn_id: o.source_turn_id ?? null,
      session_id: session.id, status: fixed === null ? 'planning' : 'running', user_text: o.text, participants,
      controller: fixed === null ? 'director' : 'fixed', template, then: fixed?.then ?? 'stop', budget, run_budget: o.budget ?? {},
      base_checkpoint_id: base?.id ?? null, fresh: o.fresh ?? false, resumes_run_id: resumes, thinking: o.thinking,
      mentions: o.mentions as unknown as Record<string, unknown>[], attachments: o.attachments, director_session_id: directorSessionId, client_request_id: o.client_request_id,
      access_cap: this.state.runs.groupAccessCap(directorSessionId, (o.origin ?? null) as never),
    })
    if (o.source_turn_id) {
      const turn = directorStore.getTurn(conn, o.source_turn_id)
      if (turn) directorStore.updateTurn(conn, turn.id, { dispatched_interaction_ids: [...new Set([...turn.dispatched_interaction_ids, interaction.id])] })
    }
    const createdBy = o.origin?.actor === 'director' ? 'director' : o.origin?.actor === 'connector' ? 'connector' : 'person'
    repo.appendInteractionEvent(conn, interaction.id, 'created', createdBy, { participants: o.participants.map((p) => p.id), controller: interaction.controller, template, base_checkpoint_id: base?.id ?? null,
      ...(o.origin ? { origin: o.origin } : {}), ...(o.cites?.length ? { cites: o.cites } : {}), ...(o.intent_sha ? { intent_sha: o.intent_sha } : {}) })
    if (fixed !== null) {
      // the request's citations go with the steps that start first (they are what the request opens)
      const cited = (o.cites ?? []).map((c) => c.run_id)
      const nodes = cited.length ? fixed.nodes.map((n) => (n.depends_on.length ? n : { ...n, cites: [...new Set([...((n as ScheduleNodeV2).cites ?? []), ...cited])] })) : fixed.nodes
      this.addNodes(interaction, nodes, fixed.then, 'harness')
      await this.tick(interaction.id)
    } else this.askForPlan(repo.getInteraction(conn, interaction.id)!)
    return this.detail(repo.getInteraction(conn, interaction.id)!)
  }

  /** The planning turn: the director reads the request and the roster and calls schedule. */
  private askForPlan(interaction: Interaction): void {
    const images = interaction.attachments.length
    // the director's texts are its surface's (frozen per surface): a director on v2 is never asked in v1's words
    const surface = this.directorSurface(interaction)
    const input = surfaceText(surface, 'director.plan', {
      interaction_id: interaction.id, count: interaction.participants.length,
      participants: interaction.participants.map((p) => `- ${p.id}: ${p.label} (${p.model})`).join('\n'),
      max_runs: interaction.budget.max_runs, concurrency: interaction.budget.concurrency,
      images: images ? surfaceText(surface, 'director.plan_images', { count: images }) : 'none',
      text: aliasedAgentMentions(interaction.user_text),
      // a folder edited in place has no copies: the director is told before it plans with them in mind
      folder: this.inPlace(interaction) ? `${surfaceText(surface, 'director.plan_in_place')}\n` : '',
      // a session still named from the first words asks for a title with the plan
      title: repo.getSession(this.state.conn, interaction.session_id)?.title_source === 'auto' ? `${surfaceText(surface, 'director.plan_title')}\n` : '',
    })
    this.askDirector(interaction, input, 'planning')
  }

  /** The tool surface of the director an interaction asks (its own director session, else the session's open one):
   *  the planning and deciding texts come from that surface's frozen templates. No director: v1's (the texts the
   *  baseline sent). */
  private directorSurface(interaction: Interaction): DirectorToolSurface {
    const conn = this.state.conn
    const own = interaction.director_session_id ? directorStore.getDirectorSession(conn, interaction.director_session_id) : null
    const ds = own ?? directorStore.openDirectorSessionOf(conn, interaction.session_id)
    return ds ? surfaceOf(ds) : 'director.v1'
  }

  private askDirector(interaction: Interaction, input: string, status: 'planning' | 'deciding'): void {
    let turn: DirectorTurn
    try {
      turn = this.state.director.ask(interaction.session_id, input)
    } catch (error) {
      this.finish(interaction, 'waiting', `the director could not be asked: ${(error as Error).message}`)
      return
    }
    repo.updateInteraction(this.state.conn, interaction.id, { status, director_turn_id: turn.id, reason: null })
    repo.appendInteractionEvent(this.state.conn, interaction.id, status === 'planning' ? 'plan_asked' : 'decision_asked', 'harness', { turn_id: turn.id })
  }

  // -- the plan --------------------------------------------------------------------------------------------------------

  /** The director's plan, or more of it: checked against the graph, added under a new revision, started. */
  async schedule(interactionId: string, body: { title?: string; nodes: (ScheduleNode | ScheduleNodeV2)[]; then: InteractionThen; expected_revision?: number | null }, actor: string): Promise<InteractionDetail> {
    const interaction = repo.getInteraction(this.state.conn, interactionId)
    if (interaction === null) throw new InteractionInvalid(`interaction not found: ${interactionId}`, 404)
    // a plan grows while the interaction is planned, runs, decides, waits for the person, or ended well — never one
    // stopped, failed, or cut off by a restart (the person continues that first)
    if (!['planning', 'running', 'deciding', 'waiting', 'done'].includes(interaction.status)) {
      throw new InteractionInvalid(`a ${interaction.status} interaction takes no plan${interaction.reason ? ` (${interaction.reason})` : ''}`, 409)
    }
    // a plan added to an interaction that waits or ended starts it again: beside other groups of the session, as a new
    // interaction may start, but never beside a relay or a thread run (as a new interaction would be held to)
    if (interaction.status === 'waiting' || interaction.status === 'done') {
      if (this.state.relays.activeOf(interaction.session_id) !== null) throw new InteractionInvalid('a relay is under way in this session; it ends first', 409)
      if (this.state.runs.activeRunOfSession(interaction.session_id) !== null) throw new InteractionInvalid(`session ${interaction.session_id} already has an active run`, 409)
    }
    // the runs a step names (v25): exact ended runs of this session, checked before the plan is taken
    const session = repo.getSession(this.state.conn, interaction.session_id)
    if (session !== null) {
      for (const n of body.nodes as ScheduleNodeV2[]) {
        if (n.cites?.length || n.receive_runs?.length) {
          try { prepareHandover(this.state, session, { cites: (n.cites ?? []).map((run_id) => ({ run_id })), receive_run_ids: n.receive_runs ?? [], by: originOf({ actor: actor === 'director' ? 'director' : 'person', request: 'node' }) }) } catch (error) {
            if (error instanceof CollabRefused) throw new InteractionInvalid(`node ${n.id}: ${error.message}`, error.status)
            throw error
          }
        }
      }
    }
    if (body.expected_revision !== null && body.expected_revision !== undefined && body.expected_revision !== interaction.revision) {
      throw new InteractionInvalid(`the plan is at revision ${interaction.revision}, not ${body.expected_revision}; read it again`, 409)
    }
    if (interaction.workspace_policy === 'isolated' && body.nodes.some((n) => n.workspace !== 'own')) throw new InteractionInvalid('isolated interactions only accept own workspaces')
    const existing = repo.listNodes(this.state.conn, interactionId)
    // steps the person asks for grow the budget to fit; the director's plan stays within it
    const budget = actor === 'person' ? this.budgetCovering(interaction, existing.filter((n) => n.kind !== 'followup' && n.status !== 'done' && n.status !== 'running').length + body.nodes.length) : null
    const problems = planProblems(interaction.participants, existing, body.nodes, budget?.max_runs ?? interaction.budget.max_runs)
    if (problems.length) throw new InteractionInvalid(`the plan is not sound: ${problems.join('; ')}`)
    if (budget) this.growBudget(interaction, budget)
    this.addNodes(interaction, body.nodes, body.then, actor)
    // the plan's title names the session while it is still named from the first words (never over the person's)
    const title = body.title?.replace(/\s+/g, ' ').trim()
    if (title && repo.titleSessionByDirector(this.state.conn, interaction.session_id, title)) {
      repo.appendInteractionEvent(this.state.conn, interaction.id, 'titled', actor, { title })
    }
    await this.tick(interaction.id)
    return this.detail(repo.getInteraction(this.state.conn, interactionId)!)
  }

  private growBudget(interaction: Interaction, budget: Interaction['budget']): void {
    repo.updateInteraction(this.state.conn, interaction.id, { budget })
    repo.appendInteractionEvent(this.state.conn, interaction.id, 'budget_grown', 'person', { from: interaction.budget.max_runs, to: budget.max_runs })
  }

  /** The person's own additions — a stopped step run again, steps they ask for — are theirs to spend: the budget
   *  grows to cover the runs already started and every one the plan still holds (`pending`), never past the
   *  ceiling. Null when it covers them already. */
  private budgetCovering(interaction: Interaction, pending: number): Interaction['budget'] | null {
    const needed = budgetedRuns(this.state.conn, interaction.id) + pending
    if (needed <= interaction.budget.max_runs) return null
    if (needed > MAX_INTERACTION_RUNS) throw new InteractionInvalid(`the interaction would need ${needed} runs in all; at most ${MAX_INTERACTION_RUNS}`, 409)
    return { ...interaction.budget, max_runs: needed }
  }

  private addNodes(interaction: Interaction, nodes: (ScheduleNode | ScheduleNodeV2)[], then: InteractionThen, actor: string): void {
    const conn = this.state.conn
    const revision = interaction.revision + 1
    // the request's citations (a director-planned interaction's, kept with its creation) go with the first steps
    const created = revision === 1 ? repo.listInteractionEvents(conn, interaction.id).find((e) => e.kind === 'created') : undefined
    const requestCites = Array.isArray(created?.payload.cites) && interaction.controller === 'director' ? (created!.payload.cites as Citation[]).map((c) => c.run_id) : []
    conn.transaction(() => {
      for (const n of nodes as ScheduleNodeV2[]) {
        const cites = [...new Set([...(n.cites ?? []), ...(n.depends_on.length ? [] : requestCites)])]
        repo.insertNode(conn, { interaction_id: interaction.id, id: n.id, participant: n.participant, instruction: n.instruction?.trim() || null, depends_on: n.depends_on, receives: n.receives, workspace: n.workspace, revision,
          cites, receive_runs: n.receive_runs ?? [] })
      }
      repo.updateInteraction(conn, interaction.id, { status: 'running', then, revision, director_turn_id: null, reason: null, finished_at: null })
      repo.appendInteractionEvent(conn, interaction.id, 'planned', actor, { revision, then, nodes: nodes.map((n) => ({ id: n.id, participant: n.participant, depends_on: n.depends_on, receives: n.receives, workspace: n.workspace })) })
    })
  }

  // -- scheduling ------------------------------------------------------------------------------------------------------

  /** Start every node whose dependencies have ended, within the budget and the concurrency, one node at a time per
   *  workspace; when nothing runs and nothing can start, end the interaction as the plan says or wait for the person. */
  async tick(interactionId: string): Promise<void> {
    if (this.stopping) return
    const conn = this.state.conn
    const interaction = repo.getInteraction(conn, interactionId)
    if (interaction === null || interaction.status !== 'running') return
    const nodes = repo.listNodes(conn, interactionId)
    const byId = new Map(nodes.map((n) => [n.id, n]))
    // a step waiting on its watch keeps its place: its participant goes on in it when the watch reports
    const running = nodes.filter((n) => n.status === 'running' || n.status === 'watching' || this.starting.has(`${interactionId}/${n.id}`))
    const busyWorkspaces = new Set(running.map((n) => n.workspace_id ?? this.resolveWorkspaceId(interaction, nodes, n)).filter((id): id is string => id !== null))
    // a participant speaks once at a time: its conversation is one
    const busyParticipants = new Set(running.map((n) => n.participant))
    let slots = interaction.budget.concurrency - running.length
    const started: InteractionNode[] = []
    for (const node of nodes) {
      if (slots <= 0) break
      if (node.status !== 'queued' || this.starting.has(`${interactionId}/${node.id}`)) continue
      // a follow-up comes after the step it continues once that one ended (it continues that run, however it ended)
      if (!node.depends_on.every((dep) => node.kind === 'followup' ? ENDED.has(byId.get(dep)?.status ?? '') : byId.get(dep)?.status === 'done')) continue
      if (busyParticipants.has(node.participant)) continue
      const fresh = repo.getInteraction(conn, interactionId)!
      if (node.kind !== 'followup' && fresh.runs_started >= fresh.budget.max_runs) {
        this.finish(fresh, 'error', `the interaction reached its budget (${fresh.runs_started} of ${fresh.budget.max_runs} runs); nothing more starts`)
        return
      }
      const wsId = this.resolveWorkspaceId(fresh, nodes, node)
      if (wsId !== null && busyWorkspaces.has(wsId)) continue
      if (wsId !== null) busyWorkspaces.add(wsId)
      busyParticipants.add(node.participant)
      slots -= 1
      this.starting.add(`${interactionId}/${node.id}`)
      started.push(node)
    }
    for (const node of started) {
      try {
        const current = this.readyToStart(interactionId, node.id)
        if (!current) continue
        // a queued node that still names a run is one continue carries on; a fresh node has none
        if (node.run_id !== null) await this.rerunNode(current, node)
        else if (node.kind === 'followup') await this.startFollowup(current, node)
        else await this.startNode(current, node)
      } catch (error) {
        const again = repo.getInteraction(conn, interactionId)
        if (!again || again.status !== 'running' || this.stopping) continue
        repo.updateNode(conn, interactionId, node.id, { status: 'error' })
        repo.appendInteractionEvent(conn, interactionId, 'node_failed', 'harness', { node: node.id, error: (error as Error).message })
        if (again && again.status === 'running') this.finish(again, 'waiting', `step ${node.id} (${node.participant}) could not start: ${(error as Error).message}; continue tries again`)
      } finally {
        this.starting.delete(`${interactionId}/${node.id}`)
      }
    }
    if (started.length) { void this.tick(interactionId); return }
    this.settle(interactionId)
  }

  /** Nothing started this tick: with nothing running, the interaction ends as the plan says, or waits for the person. */
  private settle(interactionId: string): void {
    const conn = this.state.conn
    const interaction = repo.getInteraction(conn, interactionId)
    if (interaction === null || interaction.status !== 'running') return
    const nodes = repo.listNodes(conn, interactionId)
    if (nodes.some((n) => n.status === 'running' || n.status === 'watching' || this.starting.has(`${interactionId}/${n.id}`))) return
    const waiting = nodes.filter((n) => n.status === 'waiting')
    if (waiting.length) {
      const who = waiting.map((n) => `${n.id} (${n.participant})`).join(', ')
      this.finish(interaction, 'waiting', `step ${who} ended waiting for your decision; decide, then continue`)
      return
    }
    const failed = nodes.filter((n) => n.status === 'error' || n.status === 'cancelled')
    const blocked = nodes.filter((n) => n.status === 'queued')
    if (failed.length || blocked.length) {
      const why = failed.length ? `step ${failed.map((n) => `${n.id} (${n.participant})`).join(', ')} did not end well` : `step ${blocked.map((n) => n.id).join(', ')} cannot start`
      this.finish(interaction, 'waiting', `${why}; continue runs the failed step again, or stop the interaction`)
      return
    }
    if (interaction.then === 'director') {
      if (interaction.director_session_id === null) { this.finish(interaction, 'done', null); return }
      const surface = this.directorSurface(interaction)
      const steps = nodes.map((n) => {
        const run = n.run_id ? repo.getRun(conn, n.run_id) : null
        return surfaceText(surface, 'director.decide_step', { node: n.id, speaker: n.participant, run_id: n.run_id ?? 'none', measured: run ? measuredLine(run) : 'no run', head: head(run?.receipt.final_text) || '(no answer)' })
      }).join('\n')
      const input = surfaceText(surface, 'director.decide', { interaction_id: interaction.id, steps, runs_left: Math.max(0, interaction.budget.max_runs - interaction.runs_started) })
      this.askDirector(interaction, input, 'deciding')
      return
    }
    this.finish(interaction, 'done', null)
  }

  /** The workspace a node runs on: the session's (shared), the copy another node worked on, or its participant's own
   *  copy — known once made (null before: the start makes it). */
  private resolveWorkspaceId(interaction: Interaction, nodes: InteractionNode[], node: InteractionNode): string | null {
    if (node.workspace_id) return node.workspace_id
    // a folder edited in place: every step works in the folder (its writers take turns, never on copies)
    if (this.inPlace(interaction)) return repo.getSession(this.state.conn, interaction.session_id)?.workspace_id ?? null
    if (node.workspace === 'shared') return repo.getSession(this.state.conn, interaction.session_id)?.workspace_id ?? null
    if (node.workspace === 'own') return nodes.find((n) => n.participant === node.participant && n.workspace_id !== null && n.workspace === 'own')?.workspace_id ?? null
    return nodes.find((n) => n.id === node.workspace)?.workspace_id ?? null
  }

  /** Whether the interaction's session edits its folder in place (a direct project's). */
  private inPlace(interaction: Interaction): boolean {
    if (interaction.workspace_policy === 'isolated') return false
    const wsId = repo.getSession(this.state.conn, interaction.session_id)?.workspace_id ?? null
    const ws = wsId ? repo.getWorkspace(this.state.conn, wsId) : null
    return ws !== null && isDirect(ws)
  }

  /** The latest run of a participant in the interaction (its own conversation), or null before its first. */
  private ownPreviousRun(nodes: InteractionNode[], participant: string, before: InteractionNode): Run | null {
    const runs = nodes.filter((n) => n.participant === participant && n.id !== before.id && n.run_id !== null)
      .map((n) => repo.getRun(this.state.conn, n.run_id!)).filter((r): r is Run => r !== null && !(ACTIVE_RUN_STATUSES as readonly string[]).includes(r.status))
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
    return runs.at(-1) ?? null
  }

  /** Checked after every preparation await and immediately before the runner's synchronous dispatch boundary. */
  private readyToStart(interactionId: string, nodeId: string): Interaction | null {
    if (this.stopping) return null
    const ix = repo.getInteraction(this.state.conn, interactionId)
    const node = repo.getNode(this.state.conn, interactionId, nodeId)
    if (!ix || ix.status !== 'running' || node?.status !== 'queued') return null
    if (node.kind !== 'followup' && budgetedRuns(this.state.conn, ix.id) >= ix.budget.max_runs) {
      this.finish(ix, 'error', `the interaction reached its budget (${ix.budget.max_runs} runs); nothing more starts`)
      return null
    }
    return ix
  }

  private async startNode(interaction: Interaction, node: InteractionNode): Promise<Run | null> {
    const conn = this.state.conn
    const session = repo.getSession(conn, interaction.session_id)
    if (session === null || session.workspace_id === null) throw new InteractionInvalid(`session not found: ${interaction.session_id}`, 404)
    const project = repo.getProject(conn, session.project_id)!
    const nodes = repo.listNodes(conn, interaction.id)
    const participant = interaction.participants.find((p) => p.id === node.participant)
    if (participant === undefined) throw new InteractionInvalid(`node ${node.id} names no participant of the interaction`)
    const own = this.ownPreviousRun(nodes, node.participant, node)
    // the workspace: the session's, another node's copy, or the participant's own — made now, at its first node
    let wsId = this.resolveWorkspaceId(interaction, nodes, node)
    if (wsId === null) {
      if (node.workspace !== 'own') throw new InteractionInvalid(`node ${node.id}: the copy of node ${node.workspace} is not there`)
      const base = interaction.base_checkpoint_id ? repo.getCheckpoint(conn, interaction.base_checkpoint_id) : null
      const source = repo.getWorkspace(conn, session.workspace_id)!
      if (interaction.workspace_policy === 'isolated' && (isDirect(source) || projectSource(this.state, session, source))) {
        wsId = (await this.state.workspaces.createSourceWorkspace(project, session.id, source)).id
      } else {
        if (base === null) throw new InteractionInvalid('the interaction has no starting point to copy from')
        wsId = (await this.state.workspaces.createWorkspace(project, session.id, { kind: 'child', base_commit: base.commit_sha })).id
      }
    }
    // Retain a prepared scratch for a paused interaction's continue, but never launch after stop/pause/failure.
    repo.updateNode(conn, interaction.id, node.id, { workspace_id: wsId })
    if (!this.readyToStart(interaction.id, node.id)) return null
    // Each isolated root independently deserializes the same history pinned before this group started.
    // Current peers are never selected via latestRunOfSession; later waves continue only their own record.
    const resumes = own !== null && own.workspace_id === wsId ? own.id
      : node.workspace === 'shared' || interaction.workspace_policy === 'isolated' ? interaction.resumes_run_id : null
    const firstOfParticipant = own === null
    const inputs = repo.interactionInputs(conn, interaction.id)
    const source = repo.getWorkspace(conn, session.workspace_id)!
    const target = repo.getWorkspace(conn, wsId)!
    const mentions = (inputs.mentions as unknown as ResolvedMention[]).map((m) => target.source_mount && isDirect(source) ? { ...m, path: `${target.source_mount.name}/${m.path}` } : m)
    // what the conversation the run continues already holds: the participant's earlier steps, answers and all
    const held = new Set<string>()
    for (let id: string | null = resumes; id !== null && !held.has(id);) { held.add(id); id = repo.getRun(conn, id)?.resumes_run_id ?? null }
    const message = this.nodeMessage(interaction, nodes, node, firstOfParticipant, held)
    // what the step names by exact run (v25): its cites (named, nothing handed) and receive_runs (handed whole)
    const named = this.namedHandover(session, node, originOf({ actor: 'scheduler', request: 'node', interaction_id: interaction.id }))
    const turn: InteractionNodeRun = { id: interaction.id, node: node.id, note: message.note, harness_message: message.harness_message }
    const edges: Omit<NewEdge, 'to'>[] = [...this.stepEdges(interaction, nodes, node, wsId, firstOfParticipant), ...named.edges,
      ...message.received.map((r) => ({ kind: 'received', from: { kind: 'run', id: r.run_id }, meta: { via: 'node_receives', packet: r.packet, answer_chars: r.answer_chars, handed_chars: r.handed_chars, node: r.node, content_delivered: true } }))]
    const run = await this.state.runs.start(session, message.text, {
      model_id: participant.model, resumes_run_id: resumes, fresh: resumes === null, workspace_id: wsId, thinking: participant.thinking ?? inputs.thinking, budget: inputs.budget,
      interaction: turn, keep_session_model: true,
      mentions: firstOfParticipant && (node.workspace === 'shared' || interaction.workspace_policy === 'isolated') ? mentions : null,
      attachments: firstOfParticipant ? inputs.attachments : [],
      collab: { origin: originOf({ actor: 'scheduler', request: 'node', interaction_id: interaction.id }), edges, lines: named.lines, handover: named.lines.length || message.received.length ? { received: [...message.received.map((r) => ({ run_id: r.run_id, participant_id: null, who: r.node, chars: r.handed_chars ?? 0 })), ...named.received], cited: named.cited } : null },
    })
    conn.transaction(() => {
      repo.updateNode(conn, interaction.id, node.id, { status: 'running', run_id: run.id, run_ids: [...node.run_ids, run.id], workspace_id: wsId })
      repo.updateInteraction(conn, interaction.id, { runs_started: budgetedRuns(conn, interaction.id) })
      repo.appendInteractionEvent(conn, interaction.id, 'node_started', 'harness', { node: node.id, participant: node.participant, run_id: run.id, workspace_id: wsId })
      if (interaction.source_turn_id) {
        const source = directorStore.getTurn(conn, interaction.source_turn_id)
        if (source) directorStore.updateTurn(conn, source.id, { dispatched_run_ids: [...new Set([...source.dispatched_run_ids, run.id])] })
      }
      this.markNotesDelivered(interaction, node.participant, run.id)
    })
    return run
  }

  /** The message that opens a node's run: the roster (a participant's first run) and the step's note as the run's
   *  context, the person's request as their own part — when nothing is handed on; else one message of the
   *  harness's: the step's note, the director's note for the step, the request (a participant's first run) and one
   *  packet per node received. */
  private nodeMessage(interaction: Interaction, nodes: InteractionNode[], node: InteractionNode, firstOfParticipant: boolean, held: Set<string> = new Set()): { text: string; note: string | null; harness_message: boolean; received: ReceivedPacket[] } {
    const conn = this.state.conn
    const packets: string[] = []
    const received: ReceivedPacket[] = []
    // ChatGPT on the web reads words only: no working copy, no tool to read a result again
    const plain = isChatGptWeb(interaction.participants.find((p) => p.id === node.participant)?.model)
    // a step received whose run the conversation already holds (the participant's own earlier step) is not handed
    // again: its answer is there, as it was written
    const already: string[] = []
    for (const id of node.receives) {
      const dep = nodes.find((n) => n.id === id)
      const run = dep?.run_id ? repo.getRun(conn, dep.run_id) : null
      if (dep === undefined || run === null) continue
      if (held.has(run.id)) { already.push(dep.id); continue }
      const earlier = dep.run_ids.filter((id) => id !== run.id).map((id) => repo.getRun(conn, id)).filter((r): r is Run => r !== null)
      const full = interaction.workspace_policy === 'isolated'
      packets.push(nodePacket(conn, run, { node: dep.id, speaker: dep.participant, plain, earlier, full }))
      // what the packet handed, as it was cut (the exact run, fixed now: a later rerun of that step changes nothing here)
      const answer = typeof run.receipt.final_text === 'string' ? run.receipt.final_text.trim() : ''
      const chars = Array.from(answer).length
      const cut = !full && chars > MAX_ANSWER_CHARS
      received.push({ run_id: run.id, node: dep.id, packet: cut ? 'cut' : 'whole', answer_chars: chars, handed_chars: cut ? MAX_ANSWER_CHARS : chars })
    }
    const session = repo.getSession(conn, interaction.session_id)
    const noFolder = session !== null && repo.getProject(conn, session.project_id)?.config.no_folder === true
    const note = this.nodeNote(nodes, node, already, noFolder, plain, this.inPlace(interaction), !!repo.getWorkspace(conn, repo.getNode(conn, interaction.id, node.id)?.workspace_id ?? '')?.source_mount)
      + (interaction.workspace_policy === 'isolated' ? '\nIsolation: your own output workspace. If a source folder is mounted, it is live read-only, not a snapshot; it may change externally. No participant output is automatically adopted.' : '')
    const instruction = node.instruction ? text('interaction.instruction', { text: node.instruction }) : null
    const roster = firstOfParticipant ? this.roster(interaction, node.participant) : null
    const words = this.queuedNotesFor(interaction, node.participant).map((n) => text('interaction.note_delivered', { to: n.to === 'everyone' ? 'everyone' : n.to, text: n.text }))
    if (!packets.length && !words.length && firstOfParticipant) {
      return { text: interaction.user_text, note: [roster, note, instruction].filter((l): l is string => l !== null).join('\n'), harness_message: false, received }
    }
    const lines = [note]
    if (instruction) lines.push(instruction)
    if (firstOfParticipant) lines.push(requestLines(interaction.user_text))
    lines.push(...packets, ...words)
    return { text: lines.join('\n\n'), note: roster, harness_message: true, received }
  }

  /** The runs a step names by exact id (v25): its cites — one line each, nothing of them handed — and its
   *  receive_runs — each final answer handed whole — checked again as the step starts (they ended when it was added). */
  private namedHandover(session: Session, node: InteractionNode, by: Origin, citeNotes: Citation[] = []): Handover {
    const cites = (node.cites ?? []).map((run_id) => citeNotes.find((c) => c.run_id === run_id) ?? { run_id })
    return prepareHandover(this.state, session, { cites, receive_run_ids: node.receive_runs ?? [], by })
  }

  /** A step's edges into its run (v25): after — the exact run of each step it waited for, as it stands now (a later
   *  rerun of that step changes nothing recorded here); workspace — the copy it works on and where that came from. */
  private stepEdges(interaction: Interaction, nodes: InteractionNode[], node: InteractionNode, wsId: string, firstOfParticipant: boolean): Omit<NewEdge, 'to'>[] {
    const conn = this.state.conn
    const edges: Omit<NewEdge, 'to'>[] = []
    for (const dep of node.depends_on) {
      const d = nodes.find((n) => n.id === dep)
      if (d?.run_id) edges.push({ kind: 'after', from: { kind: 'run', id: d.run_id }, meta: { interaction_id: interaction.id, from_node: dep, to_node: node.id } })
    }
    const session = repo.getSession(conn, interaction.session_id)
    const ws = repo.getWorkspace(conn, wsId)
    if (session?.workspace_id === wsId) edges.push({ kind: 'workspace', from: { kind: 'workspace', id: wsId }, meta: { mode: 'session_folder', workspace_id: wsId, checkpoint_id: null } })
    else if (node.workspace !== 'own' && node.workspace !== 'shared') {
      const other = nodes.find((n) => n.id === node.workspace)?.run_id
      if (other) edges.push({ kind: 'workspace', from: { kind: 'run', id: other }, meta: { mode: 'same_workspace', workspace_id: wsId, checkpoint_id: null } })
    } else if (firstOfParticipant && ws?.source_mount && session?.workspace_id) {
      edges.push({ kind: 'workspace', from: { kind: 'workspace', id: session.workspace_id }, meta: { mode: 'source_mount', workspace_id: wsId, checkpoint_id: null } })
    } else if (firstOfParticipant && interaction.base_checkpoint_id) {
      edges.push({ kind: 'workspace', from: { kind: 'checkpoint', id: interaction.base_checkpoint_id }, meta: { mode: 'checkpoint_copy', workspace_id: wsId, checkpoint_id: interaction.base_checkpoint_id } })
    }
    return edges
  }

  // -- follow-ups (v25) --------------------------------------------------------------------------------------------

  /** A participant's follow-up: a step of the interaction it is a member of (`kind: followup`), continuing the run
   *  named — its conversation, its workspace — not counted in the interaction's budget. Running: the step joins the queue
   *  (the concurrency, one run at a time per participant). Planning or deciding: refused (the director is at work on
   *  the plan). Waiting or ended: only this step starts; the interaction's status, and every other step, stays as it is.
   *  Every check is made before the step is added. */
  async followup(interaction: Interaction, o: FollowupOptions): Promise<{ run: Run | null; node: InteractionNode }> {
    const conn = this.state.conn
    const ix = repo.getInteraction(conn, interaction.id)!
    if (ix.status === 'planning' || ix.status === 'deciding') throw new InteractionInvalid(`the director is ${ix.status === 'planning' ? 'planning' : 'deciding on'} interaction ${ix.id}; a follow-up waits until it is done`, 409)
    const session = repo.getSession(conn, ix.session_id)
    if (session === null || session.status === repo.DELETED_SESSION) throw new InteractionInvalid(`session not found: ${ix.session_id}`, 404)
    const participant = ix.participants.find((p) => p.id === o.alias)
    if (participant === undefined) throw new InteractionInvalid(`no participant ${o.alias} in interaction ${ix.id}`)
    if (o.resumes.session_id !== session.id || o.resumes.workspace_id === null) throw new InteractionInvalid(`run ${o.resumes.id} is not a run of this session`)
    const nodes = repo.listNodes(conn, ix.id)
    // the step it comes after: the one the run is, else (an older follow-up kept no step) the nearest one up its chain
    let after: InteractionNode | null = null
    for (let id: string | null = o.resumes.id, seen = 0; id !== null && seen < 200 && after === null; seen++) {
      const r = repo.getRun(conn, id)
      if (r === null) break
      if (r.interaction_id === ix.id && r.interaction_node) after = nodes.find((n) => n.id === r.interaction_node) ?? null
      id = r.resumes_run_id
    }
    if (after === null) throw new InteractionInvalid(`run ${o.resumes.id} is not one of interaction ${ix.id}'s steps, nor a follow-up of one`, 409)
    if (after.status === 'watching') return this.resumeWatching(ix, after, o)
    // the same key again: the step it added (its run, once started) — another intent under it is refused; checked
    // before the step's other conditions (a resend while the step waits is that step, not a refusal)
    if (o.client_request_id) {
      const same = nodes.find((n) => n.kind === 'followup' && (n.message as unknown as FollowupMessage | null)?.client_request_id === o.client_request_id)
      if (same) {
        const m = same.message as unknown as FollowupMessage
        if (o.intent_sha && m.intent_sha && m.intent_sha !== o.intent_sha) throw new KeyConflict(o.client_request_id, same.run_id ?? `${ix.id}/${same.id}`)
        return { run: same.run_id ? repo.getRun(conn, same.run_id) : null, node: same }
      }
    }
    const live = [...this.state.runs.handles.values()].find((h) => !h.done && h.session_id === session.id && h.participant_id !== null && repo.getRun(conn, h.run_id)?.interaction_id === ix.id && nodes.find((n) => n.run_id === h.run_id)?.participant === o.alias)
    const running = ix.status === 'running'
    if (live && !running) throw new InteractionInvalid(`participant ${o.alias} is running (run ${live.run_id}); a follow-up waits until it ends`, 409)
    // a follow-up is not counted in the group's budget: the budget bounds the plan's steps, a participant's next
    // message is the person's or the director's own call
    const by: FollowupMessage['by'] = o.origin.actor === 'director' ? 'director' : o.origin.actor === 'connector' ? 'connector' : o.origin.actor === 'watch' ? 'watch' : 'person'
    const id = `fu-${nodes.filter((n) => n.kind === 'followup').length + 1}`
    const message: FollowupMessage = {
      text: o.text, by, director_turn_id: o.origin.director_turn_id, resumes_run_id: o.resumes.id, model: o.model, cites: o.cites, origin: o.origin,
      client_request_id: o.client_request_id, intent_sha: o.intent_sha, attachments: o.attachments, thinking: o.thinking, spawned_by: o.spawned_by, label: o.label,
      note_id: o.note_id ?? null,
    }
    conn.transaction(() => {
      repo.insertNode(conn, {
        interaction_id: ix.id, id, participant: o.alias, instruction: null, depends_on: [after!.id], receives: [], workspace: after!.workspace, revision: ix.revision + 1,
        kind: 'followup', message: message as unknown as InteractionNode['message'], cites: o.cites.map((c) => c.run_id), receive_runs: o.receive_run_ids, workspace_id: o.resumes.workspace_id,
      })
      repo.updateInteraction(conn, ix.id, { revision: ix.revision + 1 })
      repo.appendInteractionEvent(conn, ix.id, 'followup_added', by, { node: id, participant: o.alias, resumes_run_id: o.resumes.id, after: after!.id, origin: o.origin })
    })
    const node = repo.getNode(conn, ix.id, id)!
    if (running) {
      await this.tick(ix.id)
      const now = repo.getNode(conn, ix.id, id)!
      return { run: now.run_id ? repo.getRun(conn, now.run_id) : null, node: now }
    }
    // the interaction waits or ended: this step alone starts, and nothing else of the plan
    const key = `${ix.id}/${id}`
    this.starting.add(key)
    try {
      const run = await this.startFollowup(repo.getInteraction(conn, ix.id)!, node, o)
      return { run, node: repo.getNode(conn, ix.id, id)! }
    } catch (error) {
      repo.updateNode(conn, ix.id, id, { status: 'error' })
      repo.appendInteractionEvent(conn, ix.id, 'node_failed', 'harness', { node: id, error: (error as Error).message })
      throw error
    } finally { this.starting.delete(key) }
  }

  /** A follow-up step's run: the sender's own words opening it (the step's app note before them), continuing the run
   *  it names on that run's workspace, as a step of the interaction (its id, its node; not counted in its budget). */
  private async startFollowup(interaction: Interaction, node: InteractionNode, live: FollowupOptions | null = null): Promise<Run | null> {
    const conn = this.state.conn
    const session = repo.getSession(conn, interaction.session_id)!
    const message = node.message as unknown as FollowupMessage
    const previous = repo.getRun(conn, message.resumes_run_id)
    if (previous === null) throw new InteractionInvalid(`run ${message.resumes_run_id} is not in the record`)
    const participant = interaction.participants.find((p) => p.id === node.participant)!
    const inputs = repo.interactionInputs(conn, interaction.id)
    const named = live ? live.handover : this.namedHandover(session, node, message.origin, message.cites)
    const note = collabText('interaction.followup', { node: node.id, interaction_id: interaction.id, me: node.participant, after: node.depends_on.join(', ') || 'none', by: message.by === 'person' ? 'the person' : message.by === 'director' ? 'the director' : message.by === 'watch' ? 'oasis-code (a watch you set)' : 'the connector client' })
    const edges: Omit<NewEdge, 'to'>[] = [
      ...node.depends_on.map((dep) => repo.getNode(conn, interaction.id, dep)?.run_id).filter((id): id is string => !!id)
        .map((runId, i) => ({ kind: 'after', from: { kind: 'run', id: runId }, meta: { interaction_id: interaction.id, from_node: node.depends_on[i] ?? null, to_node: node.id } })),
      { kind: 'workspace', from: { kind: 'run', id: previous.id }, meta: { mode: 'same_workspace', workspace_id: previous.workspace_id, checkpoint_id: null } },
      ...named.edges,
    ]
    const run = await this.state.runs.start(session, message.text, {
      model_id: message.model || participant.model, resumes_run_id: previous.id, workspace_id: previous.workspace_id, thinking: message.thinking ?? participant.thinking ?? inputs.thinking,
      budget: inputs.budget, interaction: { id: interaction.id, node: node.id, note, harness_message: false }, keep_session_model: true, wake: message.by === 'watch',
      attachments: message.attachments ?? [], client_request_id: node.run_ids.length ? null : message.client_request_id ?? null, spawned_by: message.spawned_by ?? (message.by === 'connector' ? 'connector' : 'human'), label: message.label ?? null,
      collab: {
        origin: { ...message.origin, interaction_id: interaction.id }, edges, lines: named.lines,
        handover: named.lines.length ? { received: named.received, cited: named.cited } : null, expected_head_run_id: live?.expected_head_run_id ?? null, intent_sha: node.run_ids.length ? null : message.intent_sha ?? null,
      },
    })
    // a director's follow-up that waited in the queue: its run is that director turn's dispatch (what it awaits, what
    // its end is told to), recorded now that there is a run
    const turnId = message.origin?.actor === 'director' ? message.origin.director_turn_id : null
    const turn = turnId ? directorStore.getTurn(conn, turnId) : null
    if (turn && !turn.dispatched_run_ids.includes(run.id)) directorStore.updateTurn(conn, turn.id, { dispatched_run_ids: [...turn.dispatched_run_ids, run.id] })
    conn.transaction(() => {
      repo.updateNode(conn, interaction.id, node.id, { status: 'running', run_id: run.id, run_ids: [...node.run_ids, run.id], workspace_id: previous.workspace_id })
      repo.updateInteraction(conn, interaction.id, { runs_started: budgetedRuns(conn, interaction.id) })
      repo.appendInteractionEvent(conn, interaction.id, 'node_started', 'harness', { node: node.id, participant: node.participant, run_id: run.id, workspace_id: previous.workspace_id, followup: true })
      const handed = message.note_id ? repo.listInteractionNotes(conn, interaction.id).find((n) => n.id === message.note_id) : undefined
      if (handed) this.deliverNote(interaction, handed, node.participant, run.id)
    })
    return run
  }

  /** The person's notes a participant has not been handed yet: to everyone, or to it. */
  private queuedNotesFor(interaction: Interaction, participant: string): InteractionNote[] {
    return repo.listInteractionNotes(this.state.conn, interaction.id).filter((n) => (n.to === 'everyone' || n.to === participant) && n.delivered[participant] === undefined && n.status !== 'undelivered')
  }

  /** The notes handed in this run recorded as delivered to the participant. */
  private markNotesDelivered(interaction: Interaction, participant: string, runId: string): void {
    for (const n of this.queuedNotesFor(interaction, participant)) this.deliverNote(interaction, n, participant, runId)
  }

  /** A note handed to a step's run in flight, at its next request: recorded as delivered there once the run took it
   *  into its queue; a run that ends without handing it over gives it back (takeBackUnsteeredNotes). */
  private steerNote(interaction: Interaction, noteId: string, participant: string, runId: string): boolean {
    const note = repo.listInteractionNotes(this.state.conn, interaction.id).find((n) => n.id === noteId)
    if (!note) return false
    const words = text('interaction.note_delivered', { to: note.to === 'everyone' ? 'everyone' : note.to, text: note.text })
    if ('refusal' in this.state.runs.steer(runId, words, noteSteerKey(note.id), 'person')) return false
    this.deliverNote(interaction, note, participant, runId)
    return true
  }

  /** The notes the run was handed by steering but ended without passing to its model (stopped, failed, out of room):
   *  queued again for the participant, never left counted as delivered. */
  private takeBackUnsteeredNotes(interaction: Interaction, participant: string, runId: string): void {
    const steers = this.state.runs.steersOf(runId)
    for (const n of repo.listInteractionNotes(this.state.conn, interaction.id)) {
      if (n.delivered[participant] !== runId) continue
      if (steers.find((s) => s.client_request_id === noteSteerKey(n.id))?.status !== 'undelivered') continue
      const delivered = Object.fromEntries(Object.entries(n.delivered).filter(([who]) => who !== participant))
      // an interaction already ended (a stop ends it before its runs) has no run left to hand the words to
      const ended = ['done', 'cancelled', 'error'].includes(repo.getInteraction(this.state.conn, interaction.id)?.status ?? interaction.status)
      repo.updateInteractionNote(this.state.conn, n.id, { delivered, status: Object.keys(delivered).length ? 'partly' : ended ? 'undelivered' : 'queued' })
      repo.appendInteractionEvent(this.state.conn, interaction.id, 'note_returned', 'harness', { note: n.id, to: participant, run_id: runId })
    }
  }

  /** A note recorded as delivered to the participant in the run (delivered whole once every addressee had it). */
  private deliverNote(interaction: Interaction, n: InteractionNote, participant: string, runId: string): void {
    const delivered = { ...n.delivered, [participant]: runId }
    const addressees = n.to === 'everyone' ? interaction.participants.map((p) => p.id) : [n.to]
    const whole = addressees.every((a) => delivered[a] !== undefined)
    repo.updateInteractionNote(this.state.conn, n.id, { delivered, status: whole ? 'delivered' : 'partly' })
    repo.appendInteractionEvent(this.state.conn, interaction.id, 'note_delivered', 'harness', { note: n.id, to: participant, run_id: runId, whole })
    crepo.insertEdge(this.state.conn, interaction.session_id, { kind: 'note', from: { kind: 'note', id: n.id }, to: { kind: 'run', id: runId }, meta: { interaction_id: interaction.id, to: participant } })
  }

  /** The step's app note: which step, after what, handed whose answers, and — where there are files to copy — which
   *  copy it works on (a session with no project folder has none: its steps' own folders start empty, and the line
   *  would only speak of files that are not there; a participant with no files, ChatGPT on the web, is not told). */
  private nodeNote(nodes: InteractionNode[], node: InteractionNode, already: string[] = [], noFolder = false, noFiles = false, inPlace = false, sourceMounted = false): string {
    const copy = sourceMounted ? 'your isolated output folder with a live read-only source mount (source files were not copied)' : node.workspace === 'shared' || inPlace ? text('interaction.copy_shared', {}) : node.workspace === 'own' ? text('interaction.copy_own', {}) : text('interaction.copy_node', { node: node.workspace })
    const handed = node.receives.filter((id) => !already.includes(id))
    const held = already.length ? text('interaction.already_held', { steps: already.join(', '), verb: already.length === 1 ? 'is' : 'are' }) : ''
    const receives = handed.length ? `${handed.join(', ')}${held ? ` (${held})` : ''}`
      : held ? `none new (${held})` : 'none (you work without seeing the other participants)'
    const lines = [text('interaction.node', {
      node: node.id, done: nodes.filter((n) => ENDED.has(n.status)).length, total: nodes.length, me: node.participant,
      after: node.depends_on.length ? node.depends_on.join(', ') : 'nothing (this step starts at once)', receives,
    })]
    if (!noFiles && !(noFolder && node.workspace === 'own')) lines.push(text('interaction.node_copy', { copy }))
    return lines.join('\n')
  }

  private rosterLines(interaction: Interaction): string {
    return interaction.participants.map((p) => `${p.id}: ${p.label} (${p.model})`).join('\n')
  }

  private roster(interaction: Interaction, me: string): string {
    return text('interaction.roster', { participants: this.rosterLines(interaction), me })
  }

  // -- the hooks -----------------------------------------------------------------------------------------------------

  private onRunFinished(runId: string): void {
    const conn = this.state.conn
    const run = repo.getRun(conn, runId)
    if (run === null || run.interaction_id === null || run.interaction_node === null) return
    const interaction = repo.getInteraction(conn, run.interaction_id)
    const node = repo.getNode(conn, run.interaction_id, run.interaction_node)
    if (interaction === null || node === null || node.run_id !== run.id) return
    this.takeBackUnsteeredNotes(interaction, node.participant, run.id)
    const who = `${node.id} (${node.participant})`
    const end = (status: InteractionNode['status'], reason: string | null) => {
      repo.updateNode(conn, interaction.id, node.id, { status })
      repo.appendInteractionEvent(conn, interaction.id, 'node_finished', 'harness', { node: node.id, participant: node.participant, run_id: run.id, status, run_status: run.status, ...(reason ? { reason } : {}) })
    }
    if (interaction.status !== 'running') {
      // stopped (or superseded) while the run went: its end is recorded, nothing follows
      end(run.status === 'done' ? 'done' : run.status === 'cancelled' ? 'cancelled' : 'error', null)
      return
    }
    if (run.status === 'cancelled') {
      if (this.stopping) {
        end('error', 'cut off when the harness shut down')
        this.finish(interaction, 'interrupted', `step ${who} was cut off when the harness shut down; continue to let it carry on from its record`)
        return
      }
      end('cancelled', 'stopped by the person')
      void this.tick(interaction.id)
      return
    }
    if (run.status !== 'done') {
      end('error', run.error ?? run.status)
      void this.tick(interaction.id)
      return
    }
    const line = budgetLineOf(run)
    if (line !== null) {
      end('error', `stopped at its budget line (${line}); its task may be unfinished`)
      void this.tick(interaction.id)
      return
    }
    const session = repo.getSession(conn, interaction.session_id)
    const pending = session === null ? [] : this.pendingDecisions(session, run.id)
    if (pending.length) {
      end('waiting', `${pending.length} proposed action${pending.length === 1 ? '' : 's'} await your decision`)
      void this.tick(interaction.id)
      return
    }
    const watching = this.watchesOf(interaction.session_id, [...node.run_ids, run.id])
    if (watching.length) {
      end('watching', `waits on ${watching.length === 1 ? 'its watch' : `${watching.length} watches`} (${watching.join('; ')})`)
      return
    }
    end('done', null)
    if (this.stopping) return
    void this.tick(interaction.id)
  }

  /** What a step's runs still wait on: their watches that are set, and reports of theirs not yet delivered. */
  private watchesOf(sessionId: string, runIds: string[]): string[] {
    const conn = this.state.conn
    const runs = new Set(runIds)
    const watches = repo.listWatches(conn, sessionId).filter((w) => runs.has(w.run_id))
    const reported = new Set(repo.listPendingWakeEvents(conn, sessionId).map((e) => e.watch_id))
    return watches.filter((w) => w.status === 'active' || reported.has(w.id)).map((w) => w.summary)
  }

  /** A step whose watches all ended without a report to deliver (cancelled, or the report dropped): it is done, with
   *  the answer its last run gave. */
  watchesSettled(sessionId: string): void {
    const conn = this.state.conn
    for (const interaction of repo.listInteractions(conn, sessionId)) {
      for (const node of repo.listNodes(conn, interaction.id)) {
        if (node.status !== 'watching' || this.watchesOf(sessionId, node.run_ids).length) continue
        repo.updateNode(conn, interaction.id, node.id, { status: 'done' })
        repo.appendInteractionEvent(conn, interaction.id, 'node_finished', 'harness', { node: node.id, participant: node.participant, run_id: node.run_id, status: 'done', run_status: 'done', reason: 'its watches ended without a report' })
        if (interaction.status === 'running') void this.tick(interaction.id)
      }
    }
  }

  /** The step goes on in a new run continuing its last one, on its workspace: the message that came (the watch's
   *  report, the director's or the person's words), the step's answer the one this run gives. */
  private async resumeWatching(interaction: Interaction, node: InteractionNode, o: FollowupOptions): Promise<{ run: Run | null; node: InteractionNode }> {
    const conn = this.state.conn
    const session = repo.getSession(conn, interaction.session_id)!
    const previous = repo.getRun(conn, node.run_id!)!
    const participant = interaction.participants.find((p) => p.id === node.participant)!
    const inputs = repo.interactionInputs(conn, interaction.id)
    const by = o.origin.actor === 'director' ? 'the director' : o.origin.actor === 'connector' ? 'the connector client' : o.origin.actor === 'watch' ? 'oasis-code (a watch you set)' : 'the person'
    const note = collabText('interaction.resumed', { node: node.id, interaction_id: interaction.id, by })
    const key = `${interaction.id}/${node.id}`
    this.starting.add(key)
    try {
      const run = await this.state.runs.start(session, o.text, {
        model_id: o.model || participant.model, resumes_run_id: previous.id, workspace_id: previous.workspace_id, thinking: o.thinking ?? participant.thinking ?? inputs.thinking,
        budget: inputs.budget, interaction: { id: interaction.id, node: node.id, note, harness_message: false }, keep_session_model: true, wake: o.origin.actor === 'watch',
        attachments: o.attachments, client_request_id: o.client_request_id, spawned_by: o.spawned_by, label: o.label,
        collab: {
          origin: { ...o.origin, interaction_id: interaction.id },
          edges: [{ kind: 'workspace', from: { kind: 'run', id: previous.id }, meta: { mode: 'same_workspace', workspace_id: previous.workspace_id, checkpoint_id: null } }, ...o.handover.edges],
          lines: o.handover.lines, handover: o.handover.lines.length ? { received: o.handover.received, cited: o.handover.cited } : null,
          expected_head_run_id: o.expected_head_run_id, intent_sha: o.intent_sha,
        },
      })
      const turnId = o.origin.actor === 'director' ? o.origin.director_turn_id : null
      const turn = turnId ? directorStore.getTurn(conn, turnId) : null
      if (turn && !turn.dispatched_run_ids.includes(run.id)) directorStore.updateTurn(conn, turn.id, { dispatched_run_ids: [...turn.dispatched_run_ids, run.id] })
      conn.transaction(() => {
        repo.updateNode(conn, interaction.id, node.id, { status: 'running', run_id: run.id, run_ids: [...node.run_ids, run.id] })
        repo.appendInteractionEvent(conn, interaction.id, 'node_resumed', o.origin.actor === 'watch' ? 'watch' : o.origin.actor === 'director' ? 'director' : o.origin.actor === 'connector' ? 'connector' : 'person', { node: node.id, participant: node.participant, run_id: run.id, resumes_run_id: previous.id })
      })
      return { run, node: repo.getNode(conn, interaction.id, node.id)! }
    } finally { this.starting.delete(key) }
  }

  /** The director's turn about an interaction ended: a planning turn that scheduled nothing, or a decision turn
   *  that added no node, ends the harness's wait — the person's word (waiting), or the interaction's end (done). */
  private onDirectorTurnFinished(turn: DirectorTurn): void {
    const conn = this.state.conn
    const interaction = repo.interactionOfDirectorTurn(conn, turn.id)
    if (interaction === null) return
    if (interaction.status === 'planning') {
      const reason = turn.status === 'done' ? surfaceText(this.directorSurface(interaction), 'director.plan_none') : `the director's turn ${turn.status === 'cancelled' ? 'was cancelled' : 'failed'}${turn.error ? `: ${turn.error}` : ''}; continue asks it again`
      repo.appendInteractionEvent(conn, interaction.id, 'plan_missing', 'director', { turn_id: turn.id, turn_status: turn.status })
      this.finish(interaction, 'waiting', reason)
      return
    }
    if (interaction.status === 'deciding') {
      if (turn.status === 'done') {
        repo.appendInteractionEvent(conn, interaction.id, 'decided', 'director', { turn_id: turn.id, more: false })
        repo.updateInteraction(conn, interaction.id, { director_turn_id: null })
        this.finish(interaction, 'done', null)
      } else {
        this.finish(interaction, 'waiting', `the director's turn ${turn.status === 'cancelled' ? 'was cancelled' : 'failed'}${turn.error ? `: ${turn.error}` : ''}; continue asks it again`)
      }
    }
  }

  // -- the person's controls -------------------------------------------------------------------------------------------

  /** Stop the whole interaction: the stop is written first, then every live run is cancelled; nothing starts after. */
  cancel(interactionId: string): boolean {
    const conn = this.state.conn
    const interaction = repo.getInteraction(conn, interactionId)
    if (interaction === null) return false
    if (!['planning', 'running', 'waiting', 'deciding', 'interrupted'].includes(interaction.status)) return false
    const nodes = repo.listNodes(conn, interactionId)
    const live = nodes.filter((n) => n.run_id && this.state.runs.handles.get(n.run_id) && !this.state.runs.handles.get(n.run_id)!.done)
    this.finish(interaction, 'cancelled', live.length ? `stopped by the person during step ${live.map((n) => `${n.id} (${n.participant})`).join(', ')}` : 'stopped by the person')
    repo.appendInteractionEvent(conn, interactionId, 'stopped', 'person', { live: live.map((n) => n.id) })
    if (interaction.director_turn_id) {
      try { this.state.director.cancelTurn(interaction.director_turn_id) } catch { /* the turn ended meanwhile */ }
    }
    for (const node of live) this.state.runs.cancel(node.run_id!)
    for (const node of nodes.filter((n) => n.status === 'watching')) {
      repo.updateNode(conn, interactionId, node.id, { status: 'cancelled' })
      this.state.watches.withdrawRuns(interaction.session_id, node.run_ids, 'the interaction was stopped')
    }
    return true
  }

  /** The person's words to everyone or to one participant while the interaction runs: a step in flight takes them at
   *  its next request (in-run steering), a step still to come at its start, and a member none of whose steps is still
   *  to come goes on in its own conversation with them. */
  async note(interactionId: string, to: string, textIn: string): Promise<InteractionDetail> {
    const conn = this.state.conn
    const interaction = repo.getInteraction(conn, interactionId)
    if (interaction === null) throw new InteractionInvalid(`interaction not found: ${interactionId}`, 404)
    if (['cancelled', 'error'].includes(interaction.status)) throw new InteractionInvalid(`a ${interaction.status} interaction takes no note; send a new message instead`, 409)
    if (to !== 'everyone' && !interaction.participants.some((p) => p.id === to)) throw new InteractionInvalid(`no participant ${to} in the interaction (${interaction.participants.map((p) => p.id).join(', ')})`)
    const words = textIn.trim()
    if (!words) throw new InteractionInvalid('text is required')
    const note = repo.insertInteractionNote(conn, { interaction_id: interactionId, to, text: words })
    repo.appendInteractionEvent(conn, interactionId, 'note_queued', 'person', { note: note.id, to })
    // while the plan runs, a member none of whose steps is still to come (its step ended, failed or was stopped) has no
    // next run to hand the note at: the note goes on in its own conversation now, as the person's follow-up
    if (interaction.status === 'running') {
      const nodes = repo.listNodes(conn, interactionId)
      for (const alias of to === 'everyone' ? interaction.participants.map((p) => p.id) : [to]) {
        const mine = nodes.filter((n) => n.participant === alias)
        const live = mine.find((n) => n.status === 'running' && n.run_id !== null && this.state.runs.handles.get(n.run_id)?.done === false)
        if (live && this.steerNote(interaction, note.id, alias, live.run_id!)) continue
        if (mine.some((n) => n.status === 'queued' || n.status === 'running' || n.status === 'watching' || this.starting.has(`${interactionId}/${n.id}`))) continue
        const latest = mine.map((n) => (n.run_id ? repo.getRun(conn, n.run_id) : null)).filter((r): r is Run => r !== null).sort((a, b) => a.created_at.localeCompare(b.created_at)).at(-1)
        if (!latest) continue
        await this.followup(repo.getInteraction(conn, interactionId)!, {
          alias, resumes: latest, text: words, origin: originOf({ actor: 'person', request: 'followup', interaction_id: interactionId }), model: '', thinking: null, attachments: [],
          client_request_id: null, cites: [], receive_run_ids: [], handover: { cited: [], received: [], lines: [], edges: [] }, expected_head_run_id: null, intent_sha: null,
          spawned_by: 'human', label: null, note_id: note.id,
        })
      }
    }
    return this.detail(repo.getInteraction(conn, interactionId)!)
  }

  /** The running steps end, nothing new starts; continue goes on with the plan. */
  pause(interactionId: string): InteractionDetail {
    const conn = this.state.conn
    const interaction = repo.getInteraction(conn, interactionId)
    if (interaction === null) throw new InteractionInvalid(`interaction not found: ${interactionId}`, 404)
    if (interaction.status !== 'running') throw new InteractionInvalid(`a ${interaction.status} interaction cannot be paused${interaction.status === 'planning' || interaction.status === 'deciding' ? ' (the director is at work: stop it, or wait)' : ''}`, 409)
    this.finish(interaction, 'waiting', text('interaction.paused', {}))
    repo.appendInteractionEvent(conn, interactionId, 'paused', 'person', {})
    return this.detail(repo.getInteraction(conn, interactionId)!)
  }

  /** Waiting or interrupted interactions are the person's to continue; a new message of theirs supersedes them. */
  supersede(sessionId: string): string[] {
    const out: string[] = []
    for (const interaction of repo.listInteractions(this.state.conn, sessionId)) {
      if (interaction.status !== 'waiting' && interaction.status !== 'interrupted') continue
      this.finish(interaction, 'cancelled', 'superseded by a new message')
      out.push(interaction.id)
    }
    return out
  }

  /** A waiting or interrupted interaction goes on: a node that ended waiting for a decision (now made) or failed runs
   *  again on its own record; a director that planned nothing (or whose decision turn failed) is asked again. */
  async continue(interactionId: string): Promise<InteractionDetail> {
    const conn = this.state.conn
    const interaction = repo.getInteraction(conn, interactionId)
    if (interaction === null) throw new InteractionInvalid(`interaction not found: ${interactionId}`, 404)
    if (interaction.status !== 'waiting' && interaction.status !== 'interrupted') throw new InteractionInvalid(`a ${interaction.status} interaction cannot be continued`, 409)
    const session = repo.getSession(conn, interaction.session_id)
    if (session === null || session.status === repo.DELETED_SESSION) throw new InteractionInvalid(`session not found: ${interaction.session_id}`, 404)
    // a step of this interaction still ending after a pause is its own: it ends and the plan goes on; any other run of
    // the session holds the continue back
    const other = this.state.runs.activeRunsOfSession(session.id).find((h) => h.work_order === null && repo.getRun(conn, h.run_id)?.interaction_id !== interaction.id)
    if (other !== undefined) throw new InteractionInvalid(`session ${session.id} already has an active run`, 409)
    const nodes = repo.listNodes(conn, interactionId)
    repo.appendInteractionEvent(conn, interactionId, 'continued', 'person', {})
    if (!nodes.length) {
      // no plan yet: the director is asked again
      if (interaction.controller !== 'director') throw new InteractionInvalid('the interaction has no plan', 409)
      this.askForPlan(interaction)
      return this.detail(repo.getInteraction(conn, interactionId)!)
    }
    // a node waiting for a decision: refused while the decision is pending; run again once it is made
    for (const node of nodes.filter((n) => n.status === 'waiting' && n.run_id)) {
      const pending = this.pendingDecisions(session, node.run_id!)
      if (pending.length) throw new InteractionInvalid(`step ${node.id} (${node.participant}) still waits for your decision on ${pending.length} proposed action${pending.length === 1 ? '' : 's'}`, 409)
    }
    const again = nodes.filter((n) => n.status === 'waiting' || n.status === 'error' || n.status === 'cancelled')
    const budget = this.budgetCovering(interaction, again.length + nodes.filter((n) => n.status === 'queued').length)
    conn.transaction(() => {
      if (budget) this.growBudget(interaction, budget)
      repo.updateInteraction(conn, interactionId, { status: 'running', reason: null, finished_at: null })
      for (const node of again) {
        // a node whose run has a record keeps its run_id: the scheduler carries that run on (same step, same speaker)
        // within the concurrency, the budget and one run at a time per participant and workspace, like any other start
        const carried = node.run_id !== null && repo.getRun(conn, node.run_id) !== null && (repo.getRunHistory(conn, node.run_id) ?? '[]') !== '[]'
        repo.updateNode(conn, interactionId, node.id, carried ? { status: 'queued' } : { status: 'queued', run_id: null })
      }
    })
    await this.tick(interactionId)
    return this.detail(repo.getInteraction(conn, interactionId)!)
  }

  /** A node run again on its own record (after the person's decision, after a restart): the same step, the same speaker. */
  private async rerunNode(interaction: Interaction, node: InteractionNode): Promise<Run | null> {
    if (!this.readyToStart(interaction.id, node.id)) return null
    const conn = this.state.conn
    const session = repo.getSession(conn, interaction.session_id)!
    const participant = interaction.participants.find((p) => p.id === node.participant)!
    const inputs = repo.interactionInputs(conn, interaction.id)
    const key = `${interaction.id}/${node.id}`
    this.starting.add(key)
    try {
      const words = this.queuedNotesFor(interaction, node.participant).map((n) => text('interaction.note_delivered', { to: n.to === 'everyone' ? 'everyone' : n.to, text: n.text }))
      const run = await this.state.runs.start(session, [text('interaction.continue', { node: node.id, me: node.participant }), ...words].join('\n\n'), {
        model_id: participant.model, resumes_run_id: node.run_id, fresh: false, workspace_id: node.workspace_id, thinking: participant.thinking ?? inputs.thinking, budget: inputs.budget,
        interaction: { id: interaction.id, node: node.id, note: null, harness_message: true }, keep_session_model: true,
        collab: { origin: originOf({ actor: 'scheduler', request: 'node_retry', interaction_id: interaction.id }) },
      })
      conn.transaction(() => {
        repo.updateNode(conn, interaction.id, node.id, { status: 'running', run_id: run.id, run_ids: [...node.run_ids, run.id] })
        repo.updateInteraction(conn, interaction.id, { runs_started: budgetedRuns(conn, interaction.id) })
        repo.appendInteractionEvent(conn, interaction.id, 'node_started', 'harness', { node: node.id, participant: node.participant, run_id: run.id, workspace_id: node.workspace_id, again: true })
        if (interaction.source_turn_id) {
          const source = directorStore.getTurn(conn, interaction.source_turn_id)
          if (source) directorStore.updateTurn(conn, source.id, { dispatched_run_ids: [...new Set([...source.dispatched_run_ids, run.id])] })
        }
        this.markNotesDelivered(interaction, node.participant, run.id)
      })
      return run
    } finally { this.starting.delete(key) }
  }

  /** The final state of a node's own copy composed into the session's working folder: the integration (composed,
   *  checked, written only when the folder still stands at the base), recorded as the person's own action. */
  async adopt(interactionId: string, nodeId: string): Promise<IntegrationResult> {
    const conn = this.state.conn
    const interaction = repo.getInteraction(conn, interactionId)
    if (interaction === null) throw new InteractionInvalid(`interaction not found: ${interactionId}`, 404)
    const node = repo.getNode(conn, interactionId, nodeId)
    if (node === null) throw new InteractionInvalid(`no step ${nodeId} in interaction ${interactionId}`, 404)
    if (node.status !== 'done' || node.run_id === null) throw new InteractionInvalid(`step ${nodeId} has not ended well (${node.status}); nothing to adopt`, 409)
    const session = repo.getSession(conn, interaction.session_id)
    if (session === null || session.workspace_id === null) throw new InteractionInvalid(`session not found: ${interaction.session_id}`, 404)
    if (node.workspace_id === session.workspace_id) throw new InteractionInvalid(`step ${nodeId} worked on the session's working folder; its changes are there already`, 409)
    if (node.workspace_id && repo.getWorkspace(conn, node.workspace_id)?.source_mount) throw new InteractionInvalid('source-mounted outputs cannot be automatically adopted into the original folder', 409)
    const run = repo.getRun(conn, node.run_id)!
    const produced = (run.receipt.produced ?? {}) as { final_checkpoint_id?: string | null }
    const cpId = produced.final_checkpoint_id ?? null
    if (cpId === null) throw new InteractionInvalid(`step ${nodeId} left no file changes to adopt`, 409)
    const ws = repo.getWorkspace(conn, session.workspace_id)!
    const project = repo.getProject(conn, ws.project_id)!
    const protectedPaths = [...this.state.config.protected_paths, ...(((project.config.protected_paths as string[] | undefined) ?? []))]
    const locks = effectiveLocks(conn, session.id, project)
    // composed into the folder as its writer: refused while another holds it (naming it), never written under a write
    const owner = `operation:adopt:${newId('op')}`
    if (!this.state.locks.tryAcquire(ws.id, owner, { kind: 'operation', operation: 'adopt', session_id: session.id })) {
      const busy = this.state.locks.busy(ws.id, 'adopt', (h) => `adopt step ${nodeId} ${holderEnds(h)}`)
      throw busy !== null ? busyInvalid(busy) : new InteractionInvalid('the session workspace has writers waiting for it; adopt when they have run', 409, 'workspace_busy')
    }
    let result: IntegrationResult
    try {
      result = await integrate(this.state, ws, [cpId], { run_id: null, note: `adopted step ${nodeId} (${node.participant}) of ${interactionId}`, protected: protectedPaths, verify: true, locks })
    } finally {
      this.state.locks.release(ws.id, owner)
    }
    recordHumanRun(conn, {
      session_id: ws.session_id, project_id: ws.project_id, workspace_id: ws.id, label: `adopt ${nodeId}`,
      text: `adoption of step ${nodeId} (${node.participant}, checkpoint ${cpId}): ${result.status}` + (result.reason ? ` — ${result.reason}` : ''),
      produced: {
        workspace_id: ws.id, base_commit: result.base_commit, checkpoints: result.composed_checkpoint_id ? [result.composed_checkpoint_id] : [],
        final_checkpoint_id: result.composed_checkpoint_id, tree_sha: result.tree_sha, files_changed: result.files.map((f) => f.path).slice(0, 200), checks: result.checks.map((ch) => String(ch.id)),
      },
      kind: 'integrate', checks: checkCounts(result.checks as { status: string; check_id?: string }[], configuredCheckIds(this.state, project)),
    })
    repo.appendInteractionEvent(conn, interactionId, 'adopted', 'person', { node: nodeId, checkpoint_id: cpId, status: result.status, applied_to_workspace: result.applied_to_workspace, composed_checkpoint_id: result.composed_checkpoint_id, reason: result.reason })
    return result
  }

  // -- startup --------------------------------------------------------------------------------------------------------

  /** Startup, after the runner's own reconcile: a running interaction is interrupted — nothing starts on its own; a
   *  node whose run the restart cut off reads so; a planning or deciding interaction waits for its director's turn,
   *  whose own reconcile ends it (and this manager hears of it). */
  reconcile(): { interrupted: string[] } {
    const conn = this.state.conn
    const interrupted: string[] = []
    for (const interaction of repo.listInteractionsWithStatus(conn, ['running', 'waiting', 'interrupted', 'planning', 'deciding', 'done', 'cancelled', 'error'])) {
      const nodes = repo.listNodes(conn, interaction.id)
      const recorded = repo.listRunsOfInteraction(conn, interaction.id)
      // a node's run inserted before the node recorded it (a restart between the two): recorded now
      for (const run of recorded) {
        const owner = run.interaction_node ? repo.getNode(conn, interaction.id, run.interaction_node) : null
        if (owner && !owner.run_ids.includes(run.id)) {
          repo.updateNode(conn, interaction.id, owner.id, { run_id: run.id, run_ids: [...owner.run_ids, run.id], workspace_id: owner.workspace_id ?? run.workspace_id, status: owner.status === 'queued' ? 'running' : owner.status })
        }
      }
      repo.updateInteraction(conn, interaction.id, { runs_started: budgetedRuns(conn, interaction.id) })
      if (interaction.source_turn_id) {
        const source = directorStore.getTurn(conn, interaction.source_turn_id)
        if (source) directorStore.updateTurn(conn, source.id, {
          dispatched_run_ids: [...new Set([...source.dispatched_run_ids, ...recorded.map((r) => r.id)])],
          dispatched_interaction_ids: [...new Set([...source.dispatched_interaction_ids, interaction.id])],
        })
      }
      const cut: string[] = []
      for (const node of repo.listNodes(conn, interaction.id)) {
        if (node.status !== 'running' || node.run_id === null) continue
        const run = repo.getRun(conn, node.run_id)
        if (run === null) { repo.updateNode(conn, interaction.id, node.id, { status: 'queued', run_id: null }); continue }
        if (run.status === 'done') repo.updateNode(conn, interaction.id, node.id, { status: budgetLineOf(run) !== null ? 'error' : this.watchesOf(interaction.session_id, node.run_ids).length ? 'watching' : 'done' })
        else if (run.status === 'cancelled') repo.updateNode(conn, interaction.id, node.id, { status: 'cancelled' })
        else { repo.updateNode(conn, interaction.id, node.id, { status: 'error' }); cut.push(`${node.id} (${node.participant})`) }
      }
      // Repair paused/interrupted nodes too, without starting or unpausing anything.
      if (interaction.status !== 'running') continue
      const reason = cut.length ? `step ${cut.join(', ')} was cut off by a restart; continue to let it carry on from its record` : 'the harness restarted; continue to go on with the plan'
      this.finish(repo.getInteraction(conn, interaction.id)!, 'interrupted', reason)
      interrupted.push(interaction.id)
    }
    return { interrupted }
  }

  // -- reads -------------------------------------------------------------------------------------------------------

  detail(interaction: Interaction): InteractionDetail {
    const rows = repo.listNodes(this.state.conn, interaction.id)
    const waves = wavesOf(rows)
    const nodes = rows.map((n) => ({ ...n, wave: waves.get(n.id) ?? 1 }))
    const live = nodes.some((n) => n.run_id !== null && this.state.runs.handles.get(n.run_id) !== undefined && !this.state.runs.handles.get(n.run_id)!.done)
    // the nested repositories its starting point left out: the steps' copies do not hold them (said, never an empty folder in silence)
    const base = interaction.base_checkpoint_id ? repo.getCheckpoint(this.state.conn, interaction.base_checkpoint_id) : null
    const excluded = base ? (withExcludedRepositories(this.state.conn, base).excluded_nested_repositories ?? []) : []
    return { ...interaction, nodes, events: repo.listInteractionEvents(this.state.conn, interaction.id), notes: repo.listInteractionNotes(this.state.conn, interaction.id), live, in_place: this.inPlace(interaction), base_excluded_nested_repositories: excluded }
  }

  listDetails(sessionId: string): InteractionDetail[] {
    return repo.listInteractions(this.state.conn, sessionId).map((ix) => this.detail(ix))
  }

  // -- helpers -------------------------------------------------------------------------------------------------------

  private finish(interaction: Interaction, status: Interaction['status'], reason: string | null): void {
    const final = status === 'done' || status === 'cancelled' || status === 'error'
    repo.updateInteraction(this.state.conn, interaction.id, { status, reason, finished_at: final ? nowIso() : null, ...(final ? { director_turn_id: null } : {}) })
    this.state.director.interactionFinished(interaction.id)
    // the words nobody was handed: said so, never left queued for a run that will not come
    if (final) {
      for (const n of repo.listInteractionNotes(this.state.conn, interaction.id)) if (n.status === 'queued') repo.updateInteractionNote(this.state.conn, n.id, { status: 'undelivered' })
    }
  }

  /** The actions of a run that still wait for the person: pending approvals and pending action proposals. */
  pendingDecisions(session: Session, runId: string): { kind: 'approval' | 'proposal'; id: string; action: string }[] {
    const approvals = this.state.gate.listPending(session.id).filter((a) => a.run_id === runId).map((a) => ({ kind: 'approval' as const, id: a.id, action: a.action }))
    const proposals = listProposals(this.state.conn, session.project_id, session.id).filter((p) => p.run_id === runId && p.status === 'pending')
      .map((p) => ({ kind: 'proposal' as const, id: p.proposal_asset_id, action: p.tool_name ?? 'action' }))
    return [...approvals, ...proposals]
  }
}
