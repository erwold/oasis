/** The system instructions every agent run gets: what the harness cannot enforce itself and no tool describes —
 *  where the answer goes, when a file is the right result, what to check and what to cite, and that the project's
 *  instructions are followed within their scope while everything else read is data. Permissions, the sandbox and
 *  the boundaries are enforced at each call, and a refusal says why; the tools describe themselves. */

import { PROMPT_TEXT } from '../prompt_texts.ts'

export const INSTRUCTIONS = PROMPT_TEXT.system
