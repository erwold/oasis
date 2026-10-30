/** The session as other clients change it. The director endpoint lets a conversation held elsewhere (ChatGPT)
 *  post notes into a session and start runs in it; the page learns of them by asking the harness for the session
 *  again and taking the difference. Pure, so node --test exercises it. */

import type { DirectorNote, Run } from '../api/types'

/** A thread item: a run, a director's note, or — when the note's question was asked before what the director did
 *  meanwhile — the question on its own (`asked`, at the time it was asked; the note then shows only the answer). */
export type ThreadItem = { kind: 'run'; run: Run } | { kind: 'note'; note: DirectorNote; split?: boolean; at: string } | { kind: 'asked'; note: DirectorNote; at: string }

/** The thread's items in one order by time: a note posted before the run it led to stands before it; at the same
 *  moment the note comes first (the director wrote before the harness ran). A note answers its question when the
 *  director is done, so a question asked earlier (`askedAt`: the note's turn began, by note id) stands at its own
 *  time, before the runs the director started to answer it (the person's first words stood after them). An answer
 *  written while a run its turn started (`dispatched`, by note id) was still working stands before that run — it
 *  says what it handed on, the run's work follows; one written after its runs ended stands after them. */
export function threadItems(runs: Run[], notes: DirectorNote[], askedAt: Record<string, string> = {}, dispatched: Record<string, string[]> = {}): ThreadItem[] {
  const items: ThreadItem[] = runs.map((run) => ({ kind: 'run', run }) as ThreadItem)
  const byId = new Map(runs.map((r) => [r.id, r]))
  for (const note of notes) {
    const working = (dispatched[note.id] ?? []).map((id) => byId.get(id)).filter((r): r is Run => !!r && (!r.finished_at || r.finished_at > note.created_at))
    const at = [note.created_at, ...working.map((r) => r.created_at)].sort()[0]!
    const asked = askedAt[note.id]
    const split = !!note.question && !!asked && asked < at
    if (split) items.push({ kind: 'asked', note, at: asked })
    items.push({ kind: 'note', note, split, at })
  }
  const at = (item: ThreadItem) => (item.kind === 'run' ? item.run.created_at : item.at)
  const rank = (item: ThreadItem) => (item.kind === 'run' ? 1 : 0)
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => at(a.item).localeCompare(at(b.item)) || rank(a.item) - rank(b.item) || a.index - b.index)
    .map(({ item }) => item)
}

export interface SessionDelta {
  /** runs the page did not know (another client started them), in the harness's order */
  newRuns: Run[]
  /** notes the page did not know */
  newNotes: DirectorNote[]
  /** runs the page knew whose status, receipt or error moved while no stream of the page was watching them */
  changedRuns: Run[]
}

/** What changed between the session as the page holds it and as the harness answers now. */
export function sessionDelta(known: { runs: Run[]; notes: DirectorNote[] }, fresh: { runs: Run[]; director_notes?: DirectorNote[] }): SessionDelta {
  const runIds = new Set(known.runs.map((r) => r.id))
  const noteIds = new Set(known.notes.map((n) => n.id))
  const byId = new Map(known.runs.map((r) => [r.id, r]))
  const newRuns = fresh.runs.filter((r) => !runIds.has(r.id))
  const newNotes = (fresh.director_notes ?? []).filter((n) => !noteIds.has(n.id))
  const changedRuns = fresh.runs.filter((r) => {
    const mine = byId.get(r.id)
    return mine !== undefined && (mine.status !== r.status || mine.error !== r.error || JSON.stringify(mine.receipt ?? null) !== JSON.stringify(r.receipt ?? null))
  })
  return { newRuns, newNotes, changedRuns }
}

interface Beside { active_children?: { id: string }[]; run_count?: number }

/** Whether the runs beside the thread (order runs, which the session's thread does not list) moved: one was added
 *  (a director dispatched it, however quickly it ended), or one started or ended — the run tree is read again then. */
export function besideChanged(known: Beside | null, fresh: Beside): boolean {
  const ids = (s: Beside | null) => (s?.active_children ?? []).map((c) => c.id).sort().join(',')
  return ids(known) !== ids(fresh) || (known?.run_count ?? 0) !== (fresh.run_count ?? 0)
}

/** The new runs of a sync joined to the page as it stands once their transcripts are read, not as it stood when the
 *  read began: the page's streams went on meanwhile (a relay's first turn can finish its stream while the next turn's
 *  transcript is read), so a thread a stream filled stays the stream's, and a run the page took in meanwhile (its own
 *  send answered) is not taken in twice. `added` are the runs that joined. */
export function joinNewRuns<T>(page: { runs: Run[]; threads: Record<string, T[]> }, newRuns: Run[], read: Record<string, T[]>): { runs: Run[]; threads: Record<string, T[]>; added: Run[] } {
  const known = new Set(page.runs.map((r) => r.id))
  const added = newRuns.filter((r) => !known.has(r.id))
  const threads = { ...page.threads }
  for (const run of added) threads[run.id] = read[run.id] ?? []
  return { runs: [...page.runs, ...added], threads, added }
}

export function hasChanges(delta: SessionDelta): boolean {
  return delta.newRuns.length > 0 || delta.newNotes.length > 0 || delta.changedRuns.length > 0
}

/** The person's words as they typed them: a chat client's own markup for an app mention (`[@name](plugin://…)`,
 *  ChatGPT's) becomes the `@name` the person saw. */
export function noteQuestion(question: string): string {
  return question.replace(/\[(@[^\]]+)\]\(plugin:\/\/[^)]*\)/g, '$1').trim()
}

/** What a note's label says: by which model, and where it was said when that was outside this program (empty for
 *  a note of the session's own director with no model recorded). */
export function noteLabel(note: Pick<DirectorNote, 'source' | 'model'>): string {
  if (note.source === 'oasis-code') return note.model
  const source = note.source === 'chatgpt' ? 'ChatGPT' : note.source
  return note.model ? `${source} · ${note.model}` : source
}
