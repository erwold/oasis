/** A share's names for a group's participants (src/share/names.ts): never a harness-generated participant id. */

import { expect, test } from 'bun:test'
import { participantNames } from '@oasis-code/contract'
import { isGeneratedParticipantId, shareParticipantNames } from '../src/share/names.ts'

test('a name that would be a generated id is the label and its place; every other name is the app\'s', () => {
  const ps = [{ id: 'pt_63b241', label: 'Fable 5.1' }, { id: 'pt_cb9ef2', label: 'Fable 5.1' }, { id: 'pt_57b110', label: 'Critic' }, { id: 'A', label: 'Twin' }, { id: 'B', label: 'Twin' }, { id: 'pt_0a0b0c', label: '  ' }, { id: 'pt_0a0b0d', label: '  ' }]
  // the app: the duplicated labels named by their ids (pt_… and the letters alike)
  expect([...participantNames(ps).values()]).toEqual(['pt_63b241', 'pt_cb9ef2', 'Critic', 'A', 'B', 'pt_0a0b0c', 'pt_0a0b0d'])
  // the share: a generated id never; a letter alias kept (no harness id); a unique label kept
  expect([...shareParticipantNames(ps).values()]).toEqual(['Fable 5.1 #1', 'Fable 5.1 #2', 'Critic', 'A', 'B', 'Participant #6', 'Participant #7'])
  expect(isGeneratedParticipantId('pt_63b241')).toBe(true)
  for (const id of ['A', 'pt_63b2410', 'PT_63B241', 'pt_xyz123', 'reviewer']) expect(isGeneratedParticipantId(id)).toBe(false)
})
