/** The composers, one per place (a session, or the start screen): each keeps its own words, images and relay rounds
 *  until they are sent or the place is gone, and what is being written for one place never shows under another.
 *  Pure, so node --test exercises it; the store keeps the one on show in its own fields and the rest here. */

import type { PendingImage } from './attachments.ts'
import type { Orchestration } from './interaction.ts'

/** How the agents named work together (once two or more are), and the relay's rounds when they take turns. */
export interface ComposerDraft { draft: string; images: PendingImage[]; relayRounds: number; orchestration: Orchestration }
export const START_COMPOSER = 'start'
export const EMPTY_COMPOSER: ComposerDraft = { draft: '', images: [], relayRounds: 1, orchestration: 'director' }

export interface ComposerFields extends ComposerDraft { composers: Record<string, ComposerDraft> }

/** The composer on show put away under `from`, and the one kept for `to` taken out (an empty one when none);
 *  nothing changes when the place is the same. */
export function switchedComposer(s: ComposerFields, from: string, to: string): Partial<ComposerFields> {
  if (from === to) return {}
  const composers = { ...s.composers, [from]: { draft: s.draft, images: s.images, relayRounds: s.relayRounds, orchestration: s.orchestration } }
  const next = composers[to] ?? EMPTY_COMPOSER
  delete composers[to]
  return { composers, draft: next.draft, images: next.images, relayRounds: next.relayRounds, orchestration: next.orchestration }
}

/** The composer kept for `key` dropped (the images it held are returned so their object URLs can be released). */
export function forgottenComposer(composers: Record<string, ComposerDraft>, key: string): { composers: Record<string, ComposerDraft>; images: PendingImage[] } {
  const rest = { ...composers }
  const gone = rest[key]
  delete rest[key]
  return { composers: rest, images: gone?.images ?? [] }
}

/** The composer of `owner` — the one on show (when `shown` is that place), or the one put away under its key. A
 *  send that comes back after the person moved to another place reads and writes its owner's, never the shown one. */
export function composerOf(s: ComposerFields, shown: string, owner: string): ComposerDraft {
  return shown === owner ? { draft: s.draft, images: s.images, relayRounds: s.relayRounds, orchestration: s.orchestration } : (s.composers[owner] ?? EMPTY_COMPOSER)
}

/** `patch` written to the composer of `owner`: the fields on show, or its slot among the ones put away. */
export function withComposer(s: ComposerFields, shown: string, owner: string, patch: Partial<ComposerDraft>): Partial<ComposerFields> {
  if (shown === owner) return patch
  return { composers: { ...s.composers, [owner]: { ...(s.composers[owner] ?? EMPTY_COMPOSER), ...patch } } }
}
