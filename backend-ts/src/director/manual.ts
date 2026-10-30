/** What a director is told: the connector's own instructions every MCP client receives, and the manual, which the
 *  native director gets as its system instructions with its own notes. */

import { PROMPT_TEXT } from '../prompt_texts.ts'

export const DIRECTOR_MANUAL = PROMPT_TEXT['director.manual']
/** What an MCP client (ChatGPT's connector, the person's phone included) is told: a text of its own, for a chat model
 *  that may be the person's only way to their computer — not the native director's manual. */
export const SERVER_INSTRUCTIONS = PROMPT_TEXT['connector.instructions']
/** The native director's system instructions: the manual, then what differs when the harness holds the conversation,
 *  how it plans an interaction the app created, and what it can start for a message that comes to it first — facts and
 *  limits, the choice of how left to the model. */
export const NATIVE_INSTRUCTIONS = `${DIRECTOR_MANUAL}\n\n${PROMPT_TEXT['director.native']}\n\n${PROMPT_TEXT['director.native_interactions']}\n\n${PROMPT_TEXT['director.native_routing']}`
