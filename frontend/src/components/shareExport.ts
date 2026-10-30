/** What the app hands the session share when it exports (ShareDialog.tsx): the cosmetic look the snapshot cannot say
 *  — the palette it shows now, and the bot each run's turn wears in this thread, by the same identity logic the thread
 *  draws with (ThreadTranscript.tsx turnFace) — and the file's fixed parts: the viewer bundle (loaded only when a share
 *  is built) and a product bot's still picture, read from the app's own `/bots/icons/` and embedded as a data URL.
 *  The run ids stay here: generateShare maps them to the share's keys through the response's selection. */

import { useStore } from '../state/store'
import { relayTurnOf } from '../state/relay'
import { continuedParticipant, interactionTurnOf } from '../state/interaction'
import { botFor, botSrc, participantBotOf } from '../state/outline'
import { SHARE_BOTS, SHARE_THEMES, type ShareFace, type ShareTheme } from '../share/document'
import { bytesToBase64 } from '../state/shareHtml'
import type { ShareAssets, ShareLook } from '../state/share'
import type { ViewerBundle } from '../state/shareHtml'
import { turnFace } from './ThreadTranscript'

/** The palette on the page's root now (System already resolved there), or light. */
export function currentTheme(): ShareTheme {
  const t = document.documentElement.dataset.theme
  return (SHARE_THEMES as readonly string[]).includes(t ?? '') ? (t as ShareTheme) : 'light'
}

/** The look of the open session, read once when the share is built. A thread run's face is the one its turn wears;
 *  a run on a card only (a child, a separate task) the one its card wears. A run the page does not hold: no face. */
export function shareLook(): ShareLook {
  const s = useStore.getState()
  const theme = currentTheme()
  return {
    theme,
    faceOf: (runId: string): ShareFace | null => {
      const run = s.runs.find((r) => r.id === runId)
      if (run) return turnFace(run, relayTurnOf(s.relays, run), interactionTurnOf(s.interactions, run), continuedParticipant(s.interactions, s.runs, run))
      const row = s.tree.find((r) => r.id === runId)
      if (!row) return null
      const stable = row.collab && row.collab.participant_role !== 'main' ? participantBotOf(row.collab.participant_id, row.model) : null
      return { bot: botFor(row), enclosed: stable !== null }
    },
  }
}

/** A still picture embedded as it is when it is small; a larger one drawn at most this many pixels on its longest
 *  side (the thread shows bots at 16 px; this keeps them sharp at 6×) and encoded as PNG. */
const KEEP_BOT_BYTES = 64 * 1024
const BOT_SIDE = 96

async function botPicture(name: string, signal: AbortSignal): Promise<string | null> {
  if (!SHARE_BOTS.includes(name)) return null
  const response = await fetch(botSrc(name), { signal })
  if (!response.ok) return null
  const blob = await response.blob()
  if (blob.size <= KEEP_BOT_BYTES) return `data:image/png;base64,${bytesToBase64(new Uint8Array(await blob.arrayBuffer()))}`
  const bitmap = await createImageBitmap(blob)
  try {
    const scale = Math.min(1, BOT_SIDE / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/png')
  } finally { bitmap.close() }
}

export const shareAssets: ShareAssets = {
  viewer: async (): Promise<ViewerBundle> => (await import('../share/viewerBundle')).VIEWER_BUNDLE,
  bot: botPicture,
}
