/** The one reading of an action row (a run with spawned_by='human_action': a connector's or the person's command,
 *  checkpoint, checks, integration, adoption, an approved proposal), shared by the app's thread (ThreadAction) and the
 *  share snapshot's `action` item, so both say the same what / by / head / outcome.
 *
 *  Pure string functions: no I/O, no ids, nothing allocated beyond the result. */

/** What the label says: `what (by)` — `what` is the action's word (`command`, `checkpoint`, `approved bash`), `by` the
 *  connector's client that took it (`ChatGPT`, `connector`), or null when the person took it by hand (`(by hand)`) or
 *  the label names no one (`approved bash`, `adopt n1`). */
export interface ThreadActionLabel { what: string; by: string | null }

/** What the text says: its first line (` …` added when more body lines follow) and its outcome line (the last line,
 *  when there is more than one and it starts with `→`), else null. */
export interface ThreadActionLines { head: string; outcome: string | null }

export type ThreadActionRecord = ThreadActionLabel & ThreadActionLines

const LABEL = /^(.+?) \((.+)\)$/

/** The label read as the thread reads it. A null label is `action`; an empty label stays empty. */
export function threadActionLabel(label: string | null | undefined): ThreadActionLabel {
  const named = LABEL.exec(label ?? '')
  return { what: named?.[1] ?? label ?? 'action', by: named && named[2] !== 'by hand' ? named[2]! : null }
}

/** The text read as the thread reads it (blank lines skipped). */
export function threadActionLines(text: string): ThreadActionLines {
  const lines = text.split('\n').filter((l) => l.trim())
  const outcome = lines.length > 1 && lines.at(-1)!.startsWith('→') ? lines.at(-1)! : null
  const body = outcome ? lines.slice(0, -1) : lines
  return { head: body.length > 1 ? `${body[0]} …` : body[0] ?? '', outcome }
}

/** Both at once. */
export function threadActionRecord(label: string | null | undefined, text: string): ThreadActionRecord {
  return { ...threadActionLabel(label), ...threadActionLines(text) }
}
