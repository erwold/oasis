/** The names a share gives a group's participants. The app names them as contract mentions.ts participantNames does:
 *  the label, or — when two share it — the participant's own id (`pt_3f2a9c`, newParticipantId), the one unique thing it
 *  has. That id is the harness's: a share (snapshot V3, live state v2) never carries it. There, a participant whose name
 *  would be such a generated id is its label and its place in the group instead (`Fable 5.1 #2`: the badge the card's
 *  row wears is the same place); every other name — a unique label, a letter alias (`A`), a name the person gave —
 *  stays as the app shows it. Pure; the result still goes through the projection's sanitizer. */

import { participantNames } from '@oasis-code/contract'

/** a participant id the harness generated (newParticipantId) */
const GENERATED_PARTICIPANT_ID = /^pt_[0-9a-f]{6}$/

export const isGeneratedParticipantId = (id: string): boolean => GENERATED_PARTICIPANT_ID.test(id)

export function shareParticipantNames(participants: readonly { id: string; label: string }[]): Map<string, string> {
  const names = participantNames([...participants])
  return new Map(participants.map((p, i) => {
    const name = names.get(p.id) ?? p.label
    return [p.id, GENERATED_PARTICIPANT_ID.test(name) ? `${p.label.trim() || 'Participant'} #${i + 1}` : name]
  }))
}
