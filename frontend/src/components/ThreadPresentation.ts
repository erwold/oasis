/** How the thread's own components are drawn: live in the app (no presentation: every component as it always was), or
 *  as the read-only offline copy of a session share (src/share/viewer). The share's presentation is the one boundary
 *  the components consult BEFORE they mount anything: with it, a component draws only what the snapshot carries, from
 *  the snapshot's own fields and the page's prepared pictures, and leaves out every control that would act (send,
 *  retry, stop, approve, undo, continue, accounts, records, copy, download, drag) — nothing is hidden by CSS, nothing
 *  fetched: a link is inert, an image of the words is its alt text, a tool's detail is the snapshot's preview. Only
 *  local folds and the theme stay interactive. */

import { createContext, useContext } from 'react'

/** A picture the export carries (a `data:` URL the page re-encoded itself), or why it does not carry it. */
export type SharePicture =
  | { kind: 'shown'; src: string; width: number; height: number; label: string }
  | { kind: 'omitted'; why: string; label: string }

/** What the snapshot says of one tool call: its sanitized target (the row's line), its allowlisted details, whether its
 *  content was withheld, and the pictures it showed (image items that followed it), in order. */
export interface ShareToolView {
  line: string
  withheld: boolean
  details: {
    summary: string | null
    fields: { name: string; value: string | number | boolean }[]
    preview: string | null
    preview_truncated: boolean
  } | null
  /** whether the export was made with tool details at all (a call without them says so) */
  detailsIncluded: boolean
  pictures: { key: string; origin: 'attachment' | 'screenshot' | 'generated' }[]
}

/** How a run's turn opens when its words were not the person's (who sent them, as the snapshot names them). */
export interface ShareOpening { author: 'person' | 'director' | 'connector' | 'agent' | 'unattributed'; label: string }

/** What the snapshot says of an action line beyond the line itself (state/outline.ts ThreadAction): why its whole text
 *  is absent — withheld (a sensitive source: nothing of the command is carried), not carried (an older snapshot kept
 *  only the action's label), unrecorded (the record kept no text) — and, with tool details, the command's allowlisted
 *  measures and a cut preview of its output, shown under the command. */
export interface ShareActionView {
  missing: 'withheld' | 'not_carried' | 'unrecorded' | null
  details: ShareToolView['details']
}

/** A director exchange as the snapshot says it. */
export interface ShareNoteView { asker: 'person' | 'app'; askerLabel: string; status: string; answered: boolean; pictures: string[] }

export interface SharePresentation {
  readonly kind: 'share'
  /** the still bot a run's turn wears (a name of the product's set) and whether its part is enclosed in its colour */
  face(runId: string): { bot: string | null; enclosed: boolean }
  /** the embedded still picture of a product bot, or null (the bot is then not drawn) */
  botSrc(bot: string): string | null
  /** an image item's picture */
  picture(key: string): SharePicture | null
  tool(key: string): ShareToolView | null
  /** the snapshot's label of an item's author (an answer, a steer) */
  author(key: string): string | null
  opening(runId: string): ShareOpening | null
  note(key: string): ShareNoteView | null
  /** an action line's view, by its share key */
  action(key: string): ShareActionView | null
}

/** The eventName of a share row that stands for a picture with no call before it to stand under (src/share/viewModel.ts). */
export const SHARE_PICTURE_ROW = 'share_picture'

export const ThreadPresentationContext = createContext<SharePresentation | null>(null)

/** The share's presentation, or null in the app. */
export function useSharePresentation(): SharePresentation | null {
  return useContext(ThreadPresentationContext)
}
