/** The texts the collaboration model (schema v25) puts in front of an agent: new keys only, each said only in a new
 *  run's opening message (a conversation's earlier messages, and every text of prompt_texts.ts, are never changed).
 *  Each line states a fact of the run it is in: what was handed over, what was only referred to, whose follow-up it is. */

export const COLLAB_TEXT = {
  /** a run of the session the message refers to: named, nothing of it handed over */
  'dispatch.cited': 'App note: the message refers to run {run_id} ({who}){note}. Its content is not in this message; the reference is recorded with this run.',
  /** a run's final answer handed over whole, as a packet of the opening message */
  'dispatch.received': 'Answer of run {run_id} ({who}), handed to this run whole:',
  /** another session's run's final answer handed over whole (schema v29, an explicit cross-session handover): where it
   *  came from, and that no access to that session's files comes with it */
  'dispatch.received_session': 'Answer of run {run_id} ({who}) of session {session_id} ("{title}"), handed to this run whole; no access to that session\'s files comes with it:',
  /** an interaction participant's follow-up: the step it is, whose words follow */
  'interaction.followup': 'App note: step {node} of interaction {interaction_id} is a follow-up to you ({me}), after step {after}. It continues your own conversation on your own workspace. The message below is from {by}.',
  /** a step whose run ended with a watch still set goes on in a run of its own: the same step, its answer this run's */
  'interaction.resumed': 'App note: step {node} of interaction {interaction_id} goes on: your previous run ended with a watch still set, so the step is not finished and its answer is the one this run gives. The message below is from {by}.',
} as const

export type CollabTextKey = keyof typeof COLLAB_TEXT

export function collabText(key: CollabTextKey, vars: Record<string, string | number>): string {
  return COLLAB_TEXT[key].replace(/\{(\w+)\}/g, (_m, name: string) => {
    if (!(name in vars)) throw new Error(`collab text ${key}: no value for {${name}}`)
    return String(vars[name])
  })
}
