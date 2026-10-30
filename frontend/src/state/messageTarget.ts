/** One destination decision for the hero, session composer and store. Loading a director does not opt the person
 * back in after ×; the choice a session was given stays with it (composerTargets.ts). Notes are explicit and belong only to the interaction picked. */
import type { ComposerTarget } from './director.ts'

/** `gone`: the note's group no longer takes notes (it ended, it was stopped) — the note is refused as such, never sent
 *  to the director or to another group instead. */
export type MessageDestination = { kind: 'director' } | { kind: 'agent' } | { kind: 'note'; interactionId: string; to: string; gone?: true }
/** `open`: the groups that take notes now (interaction.ts noteCandidates), by id — one, several or none. */
export function messageDestination(target: ComposerTarget, open: string | readonly string[] | null, noteTo: string, noteInteractionId: string | null): MessageDestination {
  if (noteInteractionId && noteTo !== 'director') {
    const ids = open === null ? [] : typeof open === 'string' ? [open] : open
    return ids.includes(noteInteractionId) ? { kind: 'note', interactionId: noteInteractionId, to: noteTo } : { kind: 'note', interactionId: noteInteractionId, to: noteTo, gone: true }
  }
  return { kind: target === 'agent' ? 'agent' : 'director' }
}

/** A delayed director lookup may reveal a bridge, but it must never reverse the person's explicit bypass. */
export function loadedTarget(current: ComposerTarget, discovered: ComposerTarget): ComposerTarget {
  return current === 'agent' ? current : discovered
}
