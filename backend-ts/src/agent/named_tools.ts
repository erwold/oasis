/** The tools a person named with @ in their message (`@[Computer](tool:computer)`), as a line a model reads beside
 *  the words: the name it reads there and the agent tools it stands for. The line says what the person asked for; the
 *  tools stay under the session's permissions and a work order's surface. */

import { aliasedAgentMentions, MENTION_TOOLS, namedTools } from '@oasis-code/contract'
import { text } from '../prompt_texts.ts'

export function namedToolsNote(userText: string): string | null {
  const named = namedTools(userText)
  if (!named.length) return null
  // the tool's own name, not the token's label: a pasted token's label is any text, and this line is the app's
  return text('context.tools_named', { tools: named.map((t) => `@${MENTION_TOOLS[t.id].label} (${t.tools.join(', ')})`).join('; ') })
}

/** The person's request inside a message the harness writes (a relay's turn, an interaction's step): their words as a
 *  model reads them beside a roster, and the tools they named. */
export function requestLines(userText: string): string {
  const request = text('relay.request', { text: aliasedAgentMentions(userText) })
  const named = namedToolsNote(userText)
  return named === null ? request : `${request}\n${named}`
}
