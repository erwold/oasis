/** The director session as the page reads it (pure, so node --test exercises it): what the composer's target chip
 *  says, what the header's state line says, which turns the thread shows live (the ones no note has closed yet),
 *  and how the desktop shell's ChatGPT bridge becomes a bridge transport's config. */

import type { Attachment, DirectorNote, DirectorSession, DirectorTransport, DirectorTurn, DirectorToolCall, InteractionDetail, Run } from '@oasis-code/contract'

/** Whom the composer's words are for: the agent (a run), the session's own director (a model of this harness: a
 *  turn it answers, having agents do the work), or ChatGPT on the web directing the session (opened from its page's
 *  card or sheet, or over the API; @ChatGPT in the words is a participant, not this). */
export type ComposerTarget = 'agent' | 'director' | 'chatgpt'

/** Whom a session's words go to when it opens and the person chose nothing for it (composerTargets.ts keeps a choice):
 *  the director it has open — ChatGPT's page, or its own — else the agent; a director is the person's to call in. */
export function targetOf(director: Pick<DirectorSession, 'transport' | 'state'> | null | undefined): ComposerTarget {
  if (!director || director.state === 'closed') return 'agent'
  return director.transport === 'bridge' ? 'chatgpt' : 'director'
}

/** Whom the words go to when the person calls the director in: ChatGPT's page when it directs the session, else the
 *  session's own director (opened on the first message when there is none yet). */
export function directorTarget(director: Pick<DirectorSession, 'transport' | 'state'> | null | undefined): ComposerTarget {
  return director && director.state !== 'closed' && director.transport === 'bridge' ? 'chatgpt' : 'director'
}

export const TRANSPORT_LABELS: Record<DirectorTransport, string> = {
  native: 'a model of this harness', bridge: 'ChatGPT (web app)',
}

export function transportLabel(id: DirectorTransport): string {
  return TRANSPORT_LABELS[id] ?? id
}

/** The header's line about the director: idle, thinking, waiting for runs, needs a sign-in, paused. */
export function directorStateLine(ds: Pick<DirectorSession, 'state' | 'last_error'> | null, live: { tool_calls: Pick<DirectorToolCall, 'name' | 'summary' | 'status'>[] } | null, activeRuns = 0): string | null {
  if (!ds) return null
  switch (ds.state) {
    case 'generating': {
      const running = live?.tool_calls.find((c) => c.status === 'running')
      return running ? `director: ${running.name}…` : 'director: thinking…'
    }
    case 'waiting_for_tasks': return activeRuns > 0 ? `director: waiting for ${activeRuns} run${activeRuns === 1 ? '' : 's'}` : 'director: waiting for runs'
    case 'needs_login': return 'director: sign in to ChatGPT on its card'
    case 'paused': return 'director: paused'
    case 'closed': return null
    default: return ds.last_error ? `director: idle (last turn failed: ${ds.last_error.slice(0, 80)})` : 'director: idle'
  }
}

/** The turns the thread shows on its own: those no note closed yet (queued, with the director, or failed). A turn
 *  that ended well stands in the thread as its note. */
export function openTurns(turns: DirectorTurn[], notes: DirectorNote[]): DirectorTurn[] {
  const closed = new Set(notes.map((n) => n.turn_id).filter((id): id is string => !!id))
  return turns.filter((t) => t.status !== 'done' && !closed.has(t.id) && t.note_id === null)
}

/** What a turn's row says under it. */
export function turnStatusLine(turn: Pick<DirectorTurn, 'status' | 'error' | 'kind'>, transport: DirectorTransport): string {
  switch (turn.status) {
    case 'queued': return 'queued — the director takes it next'
    case 'generating': return transport === 'native' ? 'the director is thinking…' : 'sending to the director…'
    case 'awaiting_answer': return transport === 'bridge' ? 'sent to ChatGPT — waiting for its answer' : 'sent — waiting for the answer through the connector'
    case 'error': return `failed: ${turn.error ?? 'unknown error'}`
    case 'cancelled': return 'cancelled'
    default: return ''
  }
}

/** The runs a task event is about — a note's question (`oasis-code task event:` then `- run run_… finished: …`) or a
 *  task-event turn's words (`App note: Runs finished: run_…, run_….`) — or null for words someone wrote. */
export function eventRunIds(text: string): string[] | null {
  const head = text.startsWith('oasis-code task event') ? text : /^App note: Runs finished: [^\n]*/.exec(text)?.[0]
  if (head === undefined) return null
  return [...new Set([...head.matchAll(/\brun_[0-9a-f]+\b/g)].map((m) => m[0]))]
}

/** A task-event turn's question as the thread shows it: the first lines of the event block, never the whole message. */
export function turnQuestion(turn: Pick<DirectorTurn, 'kind' | 'input'>): string {
  if (turn.kind === 'user') return turn.input
  // the harness's own question about an interaction: its first line names what it asked (the plan, what comes next)
  if (turn.kind === 'interaction') return /every step of the plan ended/.test(turn.input) ? 'oasis-code asks what comes next in the interaction' : 'oasis-code asks for the interaction\'s plan'
  const lines = turn.input.split('\n').filter((l) => l.startsWith('- run ') || /^\d+ runs? finished/.test(l))
  return `oasis-code task event${lines.length ? `\n${lines.join('\n')}` : ''}`
}

/** The bridge the desktop shell opened, as the bridge transport's config. */
export function bridgeConfig(bridge: { url: string; token?: string | null }): Record<string, unknown> {
  return { bridge_url: bridge.url, ...(bridge.token ? { bridge_token: bridge.token } : {}) }
}

const MENTION_KEY = 'oasis-code.connectorMention'

/** The connector mention this browser was given by hand before the app learnt it from the page: offered to the app
 *  once (it keeps it only when it knows none). */
export function rememberedMention(): string {
  try { return localStorage.getItem(MENTION_KEY) ?? '' } catch { return '' }
}

/** The notes whose question the note before them already asked (a director that mirrored an interim answer and then
 *  the final one to the same message): the thread shows that question once. Runs between them do not matter. */
export function repeatedQuestions(notes: Pick<DirectorNote, 'id' | 'question' | 'created_at'>[]): Set<string> {
  const out = new Set<string>()
  const ordered = [...notes].sort((a, b) => a.created_at.localeCompare(b.created_at))
  for (let i = 1; i < ordered.length; i += 1) {
    const q = ordered[i]!.question.trim()
    if (q && q === ordered[i - 1]!.question.trim()) out.add(ordered[i]!.id)
  }
  return out
}

/** A director call the harness turned away (an error or a refusal): the director read why and acted on it. */
export const callRejected = (call: Pick<DirectorToolCall, 'status'>): boolean => call.status === 'error' || call.status === 'refused'

/** A rejection's reasons, one per line: the harness says "…: the plan is not sound: a; b; c". */
export function outcomeReasons(outcome: string): { lead: string; reasons: string[] } {
  const at = outcome.indexOf('not sound: ')
  if (at < 0) return { lead: outcome, reasons: [] }
  const lead = outcome.slice(0, at + 'not sound'.length)
  return { lead, reasons: outcome.slice(at + 'not sound: '.length).split('; ').map((r) => r.trim()).filter(Boolean) }
}

/** One step of the plan a schedule call passed, as the thread shows it. */
export interface PlanStep { id: string; participant: string; after: string[]; receives: string[]; workspace: string; instruction: string }

/** The plan a schedule call passed (its arguments), as rows; null for any other call or one whose arguments were not kept. */
export function planOf(call: Pick<DirectorToolCall, 'name'> & { args?: Record<string, unknown> | null }): { steps: PlanStep[]; then: string } | null {
  if (call.name !== 'schedule' || !call.args || !Array.isArray(call.args.nodes)) return null
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : [])
  const steps = (call.args.nodes as Record<string, unknown>[]).map((n) => ({
    id: String(n?.id ?? '?'), participant: String(n?.participant ?? '?'), after: list(n?.depends_on), receives: list(n?.receives),
    workspace: String(n?.workspace ?? 'own'), instruction: typeof n?.instruction === 'string' ? n.instruction : '',
  }))
  return { steps, then: String(call.args.then ?? 'stop') }
}

/** The files the person sent with their words to the director, in their order. The turn keeps only their ids; what
 *  each one is comes from what the turn started (its interactions, else their runs or its own runs). One no started
 *  work carries is left out. */
export function turnAttachments(turn: Pick<DirectorTurn, 'envelope' | 'dispatched_interaction_ids' | 'dispatched_run_ids'>, interactions: Pick<InteractionDetail, 'id' | 'attachments'>[], runs: Pick<Run, 'id' | 'interaction_id' | 'attachments'>[]): Attachment[] {
  const ids = turn.envelope?.attachments ?? []
  if (!ids.length) return []
  const ixIds = new Set(turn.dispatched_interaction_ids)
  const runIds = new Set(turn.dispatched_run_ids)
  const known = new Map<string, Attachment>()
  const learn = (list: Attachment[] | undefined) => { for (const a of list ?? []) if (!known.has(a.asset_id)) known.set(a.asset_id, a) }
  for (const ix of interactions) if (ixIds.has(ix.id)) learn(ix.attachments)
  for (const run of runs) if (runIds.has(run.id) || (run.interaction_id && ixIds.has(run.interaction_id))) learn(run.attachments)
  return ids.map((id) => known.get(id)).filter((a): a is Attachment => !!a)
}

/** The person's own words to the director, by what its turns started with them unchanged (a run's or an
 *  interaction's id): the thread shows them once, over the turn, not again over what they started. */
export function wordsSaidToDirector(turns: (Pick<DirectorTurn, 'kind'> & Partial<Pick<DirectorTurn, 'envelope' | 'dispatched_interaction_ids' | 'dispatched_run_ids'>>)[]): Map<string, string> {
  const words = new Map<string, string>()
  for (const t of turns) {
    if (t.kind !== 'user' || !t.envelope) continue
    for (const id of [...(t.dispatched_interaction_ids ?? []), ...(t.dispatched_run_ids ?? [])]) words.set(id, t.envelope.text)
  }
  return words
}

/** What a director's tool call named of earlier runs, read from the arguments it passed (start_run, start_relay,
 *  start_interaction: `cites`, `receive_run_ids`; a plan's steps — schedule's or start_interaction's `nodes` —:
 *  `cites`, `receive_runs`, or `receive_run_ids`), each list apart: cited runs are named to the agent as sources and
 *  nothing of them is put into its message by this call; handed-over runs' answers are put into the message whole.
 *  The fields are optional and of any shape a client sent: only run ids (`run_…`) are taken, notes kept, the rest
 *  ignored — the call's record itself is never changed. */
export interface CallReferences {
  cites: { run_id: string; note: string | null }[]
  receives: string[]
  steps: { step: string; cites: { run_id: string; note: string | null }[]; receives: string[] }[]
}
const RUN = /^run_[A-Za-z0-9]{1,64}$/
function citedRuns(value: unknown): { run_id: string; note: string | null }[] {
  if (!Array.isArray(value)) return []
  const out: { run_id: string; note: string | null }[] = []
  for (const v of value) {
    if (typeof v === 'string' && RUN.test(v)) out.push({ run_id: v, note: null })
    else if (v && typeof v === 'object' && typeof (v as { run_id?: unknown }).run_id === 'string' && RUN.test((v as { run_id: string }).run_id)) {
      const note = (v as { note?: unknown }).note
      out.push({ run_id: (v as { run_id: string }).run_id, note: typeof note === 'string' && note.trim() ? note : null })
    }
  }
  return out
}
const runIds = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && RUN.test(v)) : [])
export function callReferences(call: { args?: Record<string, unknown> | null }): CallReferences {
  const args = call.args && typeof call.args === 'object' && !Array.isArray(call.args) ? call.args : {}
  const steps = (Array.isArray(args.nodes) ? args.nodes : []).flatMap((n: unknown) => {
    if (!n || typeof n !== 'object') return []
    const node = n as Record<string, unknown>
    const cites = citedRuns(node.cites)
    const receives = [...new Set([...runIds(node.receive_runs), ...runIds(node.receive_run_ids)])]
    return cites.length || receives.length ? [{ step: typeof node.id === 'string' ? node.id : '?', cites, receives }] : []
  })
  return { cites: citedRuns(args.cites), receives: runIds(args.receive_run_ids), steps }
}
export const hasCallReferences = (r: CallReferences) => r.cites.length > 0 || r.receives.length > 0 || r.steps.length > 0
