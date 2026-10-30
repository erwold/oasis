/** The session share's snapshot as the app's own thread components take it (src/components/ThreadTranscript.tsx):
 *  product `Run`s and `ThreadEntry` rows, director notes, group requests — plus the presentation that tells those
 *  components what the snapshot says where the app would read the harness. Pure: node --test exercises it.
 *
 *  The order is `snapshot.items`' own, never sorted again (the backend keeps each run's items together and orders the
 *  blocks by time). Every item stands once:
 *  - a run's items → one RunTurn: its opening words → the run's words (`user_text`), the attachment pictures right
 *    after them → its image strip; each answer → one `agent` row (the backend already joined a continuation); each
 *    steer → a `user` row with its record (the snapshot's sender label kept); each tool → an `activity` row (its line the
 *    snapshot's sanitized target; never rebuilt from arguments it does not carry); a screenshot or generated picture
 *    right after a tool → that tool's pictures; any other picture → a picture row of its own where it stood; a notice →
 *    a `note` row, `run_failed` → the `error` row the app shows for a failed run (the failure card then names it
 *    without its text again);
 *  - a director exchange → a NoteTurn, the run:null pictures right after it → its question's pictures;
 *  - a group → its request turn, the run:null pictures right after it → its pictures;
 *  - an action (V2) → its own action line (the app's ActionLine), where it stood — of a listed run or not; its run is
 *    never a turn. An older (V1) snapshot's `recorded_action` notice of an action run → a compact action line said from
 *    that run's label (what, who), its text "not carried" — never made up; anything else of an action run → a stray row;
 *  - a group note (V2) → the person's words to the group's members (the app's MemberWords), its state in noteState's words;
 *  - a run a watch woke: its `woken_by_watch` notice opens the turn with the app's wake header instead of a row;
 *  - anything else (an item of no known run, a run:null item elsewhere) → a stray block, drawn as rows, never dropped.
 *  Nothing of usage, cost, receipts or tool results is made up: the run's receipt is empty (no cost line), its usage
 *  empty. Ids are the snapshot's share-local keys. */

import { threadActionLabel, type LiveItem, type LiveRun, type ShareItem, type ShareRun, type ShareSnapshot } from '@oasis-code/contract'
import type { SteerRecord } from '@oasis-code/contract'
import type { ThreadAction } from '../state/outline.ts'
import { noteStateLine } from '../state/interaction.ts'
import type { DirectorNote, Run } from '../api/types'
import type { ThreadEntry } from '../state/thread.ts'
import { SHARE_PICTURE_ROW, type ShareActionView, type ShareNoteView, type ShareOpening, type SharePicture, type SharePresentation, type ShareToolView } from '../components/ThreadPresentation.ts'
import type { ShareDocument, ShareFace, SharePictureData } from './document.ts'

/** An item of either page: the offline snapshot's (V1, V2) or the live state's (its image item names an opaque
 *  resource; `message_open` is an answer still being written). */
export type ShareViewItem = ShareItem | LiveItem
type Item<K extends ShareViewItem['kind']> = Extract<ShareViewItem, { kind: K }>

/** The session id the share's product objects carry: no session's. */
export const SHARE_SESSION = 'share'

export type ShareBlock =
  | { kind: 'run'; key: string; run: Run; entries: ThreadEntry[] }
  | { kind: 'note'; key: string; note: DirectorNote }
  | { kind: 'group'; key: string; item: Item<'group'>; to: string; pictures: string[] }
  | { kind: 'action'; key: string; action: ThreadAction }
  | { kind: 'group_note'; key: string; to: string; text: string; status: Item<'group_note'>['status']; state: string }
  | { kind: 'stray'; key: string; items: ShareViewItem[] }

export interface ShareView { blocks: ShareBlock[]; presentation: SharePresentation }

const ORIGIN_LABEL: Record<Item<'image'>['origin'], string> = { attachment: 'Attached image', screenshot: 'Screenshot', generated: 'Generated image' }
const OMITTED: Record<string, string> = {
  images_off: 'not included in this export', missing: 'missing from the record', damaged: 'damaged in the record', unsupported: 'of a format the export does not carry',
  over_budget: 'over the export\'s size budget',
}
const REJECTED = 'left out: the page could not re-encode it safely, or it was past the page\'s budget'

function productRun(r: ShareRun | LiveRun): Run {
  return {
    id: r.key, session_id: SHARE_SESSION, project_id: '', workspace_id: null, parent_run_id: r.parent, resumes_run_id: null,
    spawned_by: 'human', label: r.label, model: r.model_label, model_config_snapshot: {}, user_text: '', status: r.status,
    usage: {}, budget: {}, error: r.error, created_at: r.started_at ?? '', finished_at: r.finished_at, saved_seq: 0,
    receipt: {}, work_order: null, attachments: [], relay_id: null, relay_step: null, interaction_id: null, interaction_node: null, collab: null,
  }
}

/** An action item as the thread's action line takes it (state/outline.ts ThreadAction): the snapshot's own what, by,
 *  head and outcome — the one reading the app's line is made with (contract/src/actions.ts), never re-derived from a
 *  text the export may have cut — its id the item's share key. */
export function shareAction(item: Item<'action'>): ThreadAction {
  return { id: item.key, at: item.at ?? '', what: item.what, by: item.by, head: item.head ?? '', outcome: item.outcome, text: item.text ?? '' }
}

/** An action item's view: why its text is absent (withheld, or not recorded), and its command's details. */
function actionView(item: Item<'action'>): ShareActionView {
  return { missing: item.withheld !== null ? 'withheld' : item.text === null ? 'unrecorded' : null, details: item.withheld !== null ? null : item.details }
}

function steerRecord(item: Item<'message'>, run: string): SteerRecord {
  const s = item.steer
  return {
    id: item.key, run_id: run, session_id: SHARE_SESSION, text: item.text, client_request_id: '', status: s?.status ?? 'delivered',
    queued_at: item.at ?? '', queued_seq: 0, delivered_at: null, delivered_seq: null, request_index: null,
    reason: (s?.reason ?? null) as SteerRecord['reason'],
    // a record whose sender did not survive stays without one (the row names it by the snapshot's label)
    ...(s && s.by !== 'unrecorded' ? { by: s.by } : {}),
    ...(s?.client ? { client: s.client } : {}),
  }
}

/** What a share's view is made of, whichever page shows it: the offline file's document (its pictures re-encoded in
 *  the file) or the live link's current state (its pictures fetched by key). The snapshot is read by the shape every
 *  version shares; the schemas that checked it are each page's own and stay as strict as they are. */
export interface ShareViewSource {
  snapshot: {
    items: readonly ShareViewItem[]
    runs: readonly (ShareRun | LiveRun)[]
    participants: ShareSnapshot['participants']
    options: Pick<ShareSnapshot['options'], 'include_tool_details'>
  }
  /** the live link's page: a tool still running is drawn running (the offline copy is of a quiescent session) */
  live?: boolean
  /** an image item's picture, by the item's image key, or null (not carried, not yet loaded, or refused) */
  picture(imageKey: string): SharePictureData | null
  /** why a picture the snapshot names is not shown, when the page knows better than the snapshot (loading, refused) */
  pictureMissing?(imageKey: string): string | null
  faces: Readonly<Record<string, ShareFace>>
  bots: Readonly<Record<string, string>>
}

/** The offline file's view: its document's pictures, faces and bots. */
export function shareView(doc: ShareDocument): ShareView {
  return shareViewOf({ snapshot: doc.snapshot, picture: (key) => doc.pictures[key] ?? null, faces: doc.faces, bots: doc.bots })
}

export function shareViewOf(doc: ShareViewSource): ShareView {
  const snapshot = doc.snapshot
  // V1's items are V2's first six kinds: one reading of both (an older snapshot has no action or group note)
  const items: readonly ShareViewItem[] = snapshot.items
  const runs = new Map(snapshot.runs.map((r) => [r.key, r]))
  const participants = new Map(snapshot.participants.map((p) => [p.key, p.label]))
  const images = new Map<string, Item<'image'>>()
  const tools = new Map<string, ShareToolView>()
  const authors = new Map<string, string>()
  const openings = new Map<string, ShareOpening>()
  const notes = new Map<string, ShareNoteView>()
  const actions = new Map<string, ShareActionView>()
  const blocks: ShareBlock[] = []
  const detailsIncluded = snapshot.options.include_tool_details

  // the block being filled and, inside a run's block, what a picture right now would stand under
  let current: ShareBlock | null = null
  let lastTool: ShareToolView | null = null
  let atOpening = false

  const startRun = (item: ShareViewItem, run: ShareRun | LiveRun): Extract<ShareBlock, { kind: 'run' }> => {
    const block = { kind: 'run' as const, key: item.key, run: productRun(run), entries: [] as ThreadEntry[] }
    blocks.push(block)
    current = block
    lastTool = null
    atOpening = true
    return block
  }
  const stray = (item: ShareViewItem) => {
    // what a stray row reads of its item is registered as a turn's row would be (a tool's target and details, a
    // message's author): a stray item is drawn as itself, never as an empty row
    if (item.kind === 'tool') tools.set(item.key, { line: item.target ?? '', withheld: item.withheld !== null, details: item.details, detailsIncluded, pictures: [] })
    if (item.kind === 'message' || item.kind === 'message_open') authors.set(item.key, item.author_label)
    if (item.kind === 'action') actions.set(item.key, actionView(item))
    if (current?.kind === 'stray') current.items.push(item)
    else { current = { kind: 'stray', key: item.key, items: [item] }; blocks.push(current) }
    lastTool = null
    atOpening = false
  }

  const own = (block: ShareBlock) => { blocks.push(block); current = block; lastTool = null; atOpening = false }
  // the runs an older snapshot's action notice already stands for (one line per action run)
  const legacyDrawn = new Set<string>()
  // the runs a V2 action item stands for: their notice, if any, is not a second line
  const actionRuns = new Set(items.flatMap((i) => (i.kind === 'action' ? [i.run] : [])))

  for (const item of items) {
    if (item.kind === 'image') images.set(item.key, item)
    // ---- an action taken beside the agents: its own line, where it stood — even of a run the snapshot does not list
    if (item.kind === 'action') {
      actions.set(item.key, actionView(item))
      own({ kind: 'action', key: item.key, action: shareAction(item) })
      continue
    }
    // ---- run:null items: a director exchange, a group, and the pictures that follow them
    if (item.run === null) {
      if (item.kind === 'director_note') {
        const note: DirectorNote = { id: item.key, session_id: SHARE_SESSION, source: item.source_label, model: item.model_label, question: item.question, answer: item.answer ?? '', turn_id: null, created_at: item.at ?? '' }
        notes.set(item.key, { asker: item.asker, askerLabel: item.asker === 'app' ? 'oasis-code' : 'Person', status: item.status_label, answered: item.answer !== null, pictures: [] })
        current = { kind: 'note', key: item.key, note }
        blocks.push(current)
        lastTool = null
        atOpening = false
        continue
      }
      if (item.kind === 'group') {
        const to = item.participants.map((p) => participants.get(p) ?? p).join(', ')
        current = { kind: 'group', key: item.key, item, to, pictures: [] }
        blocks.push(current)
        lastTool = null
        atOpening = false
        continue
      }
      if (item.kind === 'group_note') {
        // the person's words to a group's members: the app's MemberWords, its state in noteState's own words
        own({ kind: 'group_note', key: item.key, to: item.to ?? 'everyone', text: item.text, status: item.status, state: noteStateLine(item.status, item.delivered_to) })
        continue
      }
      const here = current as ShareBlock | null
      if (item.kind === 'image' && here?.kind === 'note') { notes.get(here.key)!.pictures.push(item.key); continue }
      if (item.kind === 'image' && here?.kind === 'group') { here.pictures.push(item.key); continue }
      stray(item)
      continue
    }
    const run = runs.get(item.run)
    if (!run) { stray(item); continue }
    // ---- an action's run is no turn (the app never draws one): an older snapshot's notice of it is the action's line,
    // said from the run's own label — what and who, nothing more, nothing made up; anything else of it, a stray row
    if (run.request === 'action') {
      if (item.kind === 'notice' && item.code === 'recorded_action' && !actionRuns.has(run.key) && !legacyDrawn.has(run.key)) {
        legacyDrawn.add(run.key)
        actions.set(item.key, { missing: 'not_carried', details: null })
        own({ kind: 'action', key: item.key, action: { id: item.key, at: item.at ?? run.started_at ?? '', ...threadActionLabel(run.label), head: '', outcome: null, text: '' } })
      } else stray(item)
      continue
    }
    // ---- a run's items: one block while they follow each other; an opening words always starts the run's turn
    const opening = item.kind === 'message' && item.source === 'opening'
    let block: Extract<ShareBlock, { kind: 'run' }>
    const open = current as ShareBlock | null
    if (open?.kind === 'run' && open.run.id === run.key && !opening) block = open
    else block = startRun(item, run)
    const row = (entry: ThreadEntry) => { block.entries.push(entry); atOpening = false }
    switch (item.kind) {
      case 'message': {
        if (item.source === 'opening') {
          block.run.user_text = item.text
          openings.set(block.run.id, { author: item.author === 'assistant' ? 'unattributed' : item.author, label: item.author_label })
          atOpening = true
          lastTool = null
        } else if (item.source === 'steer') {
          authors.set(item.key, item.author_label)
          row({ kind: 'user', runId: run.key, eventId: item.key, eventName: `steer_${item.steer?.status ?? 'delivered'}`, steer: steerRecord(item, run.key), text: item.text })
          lastTool = null
        } else {
          authors.set(item.key, item.author_label)
          row({ kind: 'agent', runId: run.key, eventId: item.key, text: item.text, running: false })
          lastTool = null
        }
        break
      }
      case 'message_open': {
        // the answer being written (the live link's page): up to its last completed line, drawn as the app draws a
        // streaming answer
        authors.set(item.key, item.author_label)
        row({ kind: 'agent', runId: run.key, eventId: item.key, text: item.text, running: true })
        lastTool = null
        break
      }
      case 'tool': {
        const view: ShareToolView = { line: item.target ?? '', withheld: item.withheld !== null, details: item.details, detailsIncluded, pictures: [] }
        tools.set(item.key, view)
        row({ kind: 'activity', runId: run.key, eventId: item.key, toolCallId: item.key, tool: item.name, status: item.status, running: doc.live === true && item.status === 'running' })
        lastTool = view
        break
      }
      case 'image': {
        if (atOpening && item.origin === 'attachment') {
          // the person's pictures with their words: the turn's image strip (asset_id is the image item's key)
          block.run.attachments.push({ asset_id: item.key, name: ORIGIN_LABEL[item.origin], media_type: 'image/png', width: 1, height: 1, bytes: 1 } as Run['attachments'][number])
        } else if (lastTool && item.origin !== 'attachment') {
          lastTool.pictures.push({ key: item.key, origin: item.origin })
        } else {
          // a picture with nothing to stand under: its own row, where it stood
          row({ kind: 'note', runId: run.key, eventId: item.key, eventName: SHARE_PICTURE_ROW, text: ORIGIN_LABEL[item.origin] })
          lastTool = null
        }
        break
      }
      case 'notice': {
        // a watch woke the conversation: the turn opens with the app's own line for it (RunTurn's woken header), not a row
        if (item.code === 'woken_by_watch' && block.entries.length === 0 && block.run.spawned_by !== 'wake') {
          block.run.spawned_by = 'wake'
          lastTool = null
          atOpening = false
          break
        }
        row(item.code === 'run_failed'
          ? { kind: 'error', runId: run.key, eventId: item.key, eventName: 'error', text: item.text }
          : { kind: 'note', runId: run.key, eventId: item.key, eventName: item.code, text: item.text })
        lastTool = null
        break
      }
      default: stray(item)
    }
  }

  const picture = (key: string): SharePicture | null => {
    const item = images.get(key)
    if (!item) return null
    const label = ORIGIN_LABEL[item.origin]
    const data = item.image ? doc.picture(item.image) : null
    if (data) return { kind: 'shown', src: data.src, width: data.width, height: data.height, label }
    const missing = item.image && doc.pictureMissing ? doc.pictureMissing(item.image) : null
    if (missing) return { kind: 'omitted', label, why: missing }
    return { kind: 'omitted', label, why: item.omitted ? OMITTED[item.omitted] ?? 'not included' : REJECTED }
  }
  const NO_FACE = { bot: null, enclosed: false }
  const faces = new Map(Object.entries(doc.faces))
  const presentation: SharePresentation = {
    kind: 'share',
    face: (runId) => faces.get(runId) ?? NO_FACE,
    botSrc: (bot) => doc.bots[bot] ?? null,
    picture,
    tool: (key) => tools.get(key) ?? null,
    author: (key) => authors.get(key) ?? null,
    opening: (runId) => openings.get(runId) ?? null,
    note: (key) => notes.get(key) ?? null,
    action: (key) => actions.get(key) ?? null,
  }
  return { blocks, presentation }
}

/** What the export left out or changed, as the closing note says it (counts only). */
export function aboutLines(doc: Pick<ShareDocument, 'page'> & { snapshot: { stats: ShareDocument['snapshot']['stats']; limits: Pick<ShareDocument['snapshot']['limits'], 'max_items' | 'max_total_text_chars'> } }): { redacted: string[]; omitted: string[]; shortened: string[] } {
  const s = doc.snapshot.stats
  const words = (k: string) => k.replace(/_/g, ' ')
  const omitted = Object.entries(s.omitted).filter(([, n]) => n > 0).map(([k, n]) => `${words(k)}: ${n}`)
  if (doc.page.images_rejected) omitted.push(`images the page could not re-encode safely: ${doc.page.images_rejected}`)
  if (doc.page.images_over_page_budget) omitted.push(`images over the page's size budget: ${doc.page.images_over_page_budget}`)
  const shortened = [
    ...(s.truncated_fields ? [`long fields cut: ${s.truncated_fields}`] : []),
    ...(s.items_truncated ? [`later entries left out (limit ${doc.snapshot.limits.max_items} entries / ${doc.snapshot.limits.max_total_text_chars} characters)`] : []),
  ]
  return { redacted: Object.entries(s.redacted).filter(([, n]) => n > 0).map(([k, n]) => `${words(k)}: ${n}`), omitted, shortened }
}
