/** ChatGPT on the web: the person's own signed-in ChatGPT page the desktop app holds, reached through its bridge —
 *  named with @ as a participant (its runs type into the page; the backend reaches the bridge itself), or, opened
 *  from the page's card or sheet, the session's director (the bridge transport with the oasis-code connector).
 *  Neither needs anything from the person: the bridge's address comes from the app, the connector and the model from
 *  the person's own use of the page. */

import type { DirectorOpenBody } from '../api/types'
import { bridgeConfig, rememberedMention } from './director'
import { chatGptBridge, chatGptConnectorOffer, chatGptStatusOf, type ChatGptStatus } from './desktop'
export { chatGptAvailable, chatGptSignIn, chatGptWarning, startChatGptPage, type ChatGptWarning } from './desktop'

type Scope = { oasisCodeDesktop?: unknown }

/** The page's status; a connector this browser knew before (set by hand once) is offered to the app first. With
 *  `load: false` a page not open yet is left closed (its status says `started: false`). */
export async function chatGptStatus(scope: Scope, opts: { load?: boolean } = {}): Promise<ChatGptStatus | null> {
  const read = chatGptStatusOf(scope)
  if (!read) return null
  const status = await read(opts.load === false ? { load: false } : undefined)
  const known = rememberedMention()
  const offer = chatGptConnectorOffer(scope)
  if (status && !status.connector && known && offer) return { ...status, connector: await offer(known) }
  return status
}

/** The director body for ChatGPT: the app's bridge, the connector and the model the page taught. */
export async function chatGptDirectorBody(scope: Scope): Promise<DirectorOpenBody> {
  const open = chatGptBridge(scope)
  if (!open) throw new Error('ChatGPT is reached through the oasis-code desktop app')
  const at = await open()
  if (!at) throw new Error('the ChatGPT bridge did not start')
  const status = await chatGptStatus(scope)
  return {
    transport: 'bridge', model: 'ChatGPT', label: 'ChatGPT',
    config: { ...bridgeConfig({ url: at.url, token: at.token }), mention: status?.connector ?? '', chatgpt_model: status?.model ?? '' },
  }
}
