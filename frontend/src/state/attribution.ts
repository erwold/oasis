/** How far a run's measured changes are its own (receipt.mechanical.diff.attribution): exact, partial — a background
 *  command of an earlier run of the conversation was writing too, or some of the run's paths do not chain — or
 *  unavailable: no reliable baseline, so nothing is claimed as the run's, which is never the same as "no change". The
 *  receipt's surfaces (the thread's round, the card's receipt, the Workspace card, a step's facts) and the undo button
 *  say it from here. A receipt without the field (an older record) is exact, as it always was read. */

import type { Attribution } from '@oasis-code/contract'

const NONE: readonly string[] = Object.freeze([]) as readonly string[]

export interface AttributionView {
  kind: Attribution
  /** paths a tool of the run wrote whose change is not counted as the run's (another write came between its writes) */
  excluded: readonly string[]
  /** background commands still running while this run worked (an earlier run's, or one this run left running) */
  background: readonly string[]
}

const EXACT: AttributionView = Object.freeze({ kind: 'exact', excluded: NONE, background: NONE }) as AttributionView

type DiffFields = { attribution?: Attribution | null; unattributed_paths?: string[] | null; background_execution_ids?: string[] | null }
type ReceiptLike = { mechanical?: { diff?: DiffFields | null } | null } | null | undefined

/** The view of a receipt's (or a run diff answer's) attribution fields. */
export function attributionOf(receipt: ReceiptLike): AttributionView {
  return attributionOfDiff(receipt?.mechanical?.diff)
}

export function attributionOfDiff(diff: DiffFields | null | undefined): AttributionView {
  if (!diff) return EXACT
  const excluded = diff.unattributed_paths?.length ? diff.unattributed_paths : NONE
  const background = diff.background_execution_ids?.length ? diff.background_execution_ids : NONE
  const kind: Attribution = diff.attribution ?? (excluded.length || background.length ? 'partial' : 'exact')
  if (kind === 'exact' && excluded === NONE && background === NONE) return EXACT
  return { kind, excluded, background }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** The short mark beside the changes: nothing for exact. */
export function attributionWord(view: AttributionView): string | null {
  return view.kind === 'partial' ? 'partial' : view.kind === 'unavailable' ? 'not attributable' : null
}

/** The mark's details (its title): why, and the paths left out. */
export function attributionDetail(view: AttributionView): string {
  if (view.kind === 'exact') return ''
  const lines: string[] = []
  if (view.kind === 'unavailable') {
    lines.push(view.background.length
      ? `${plural(view.background.length, 'background command')} ${view.background.length === 1 ? 'was' : 'were'} writing while this run worked: no change is claimed as this run's. This is not the same as no change.`
      : "No reliable baseline for this run: no change is claimed as this run's. This is not the same as no change.")
  } else {
    lines.push(view.background.length
      ? `Partial: the changes this run's own tools made. ${plural(view.background.length, 'background command')} ${view.background.length === 1 ? 'was' : 'were'} writing too; what ${view.background.length === 1 ? 'it' : 'they'} wrote is not shown as this run's.`
      : "Partial: some of this run's changes cannot be told apart from another writer's.")
  }
  if (view.excluded.length) lines.push(`Not counted (written between this run's own writes): ${view.excluded.join(', ')}`)
  if (view.background.length) lines.push(`Background: ${view.background.join(', ')}`)
  return lines.join('\n')
}

/** Why the run's file changes cannot be undone automatically (null: they can, as before). A run that worked beside a
 *  background command, or whose changes are unavailable, is refused: what to put back cannot be
 *  known — a command may have written the same file between. A run with only some paths unchained stays undoable: the
 *  harness leaves those paths alone itself and says so. */
export function undoRefusal(receipt: ReceiptLike): string | null {
  const view = attributionOf(receipt)
  if (view.background.length) return `No automatic undo: ${view.background.length === 1 ? 'a background command was' : 'background commands were'} writing in the folder while this run worked, so what to put back cannot be known. Undo these changes by hand.`
  if (view.kind === 'unavailable') return "No automatic undo: this run's own changes cannot be told apart."
  return null
}
