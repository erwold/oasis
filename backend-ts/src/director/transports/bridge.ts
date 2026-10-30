/** The bridge transport: the director is the ChatGPT web app in the person's own signed-in browser (the desktop
 *  shell's bridge window, or anything else that speaks the bridge protocol), so the conversation runs on the
 *  person's ChatGPT plan with whatever the web app offers there (a Pro reasoning tier the API does not sell, say).
 *  The bridge types the message into the conversation and submits it; the answer is the bridge's read of the page
 *  (polled). The tools are the MCP connector's; this transport dispatches nothing itself.
 *
 *  The protocol (JSON over HTTP, `authorization: Bearer <bridge_token>` when a token is set):
 *    GET  {bridge_url}/state                -> { ok, logged_in, generating, conversation: {url, title} | null, model: string | null }
 *    POST {bridge_url}/send                 <- { text, turn_id, new_conversation, conversation_url? (the director's own
 *                                               conversation, for every turn after the first), mention? (the connector,
 *                                               `[$name](app://…)`), model? (a ChatGPT model slug) }
 *                                           -> { accepted: true, conversation?: {url}, message_id?, repeat?, journal_error? }
 *                                            | { accepted: false, reason: 'needs_login' | 'generating' | 'sending' | 'not_sent'
 *                                                | 'unconfirmed' | 'turn_conflict' | 'journal_unusable' | string, detail? }
 *    GET  {bridge_url}/answer?turn_id=…     -> { status: 'generating', progress?: { thinking, text, steps: [{ kind, name, summary }] } }
 *                                            | { status: 'done', text, images?: [{ name, media_type, data_base64 }], model?, conversation? }
 *                                            | { status: 'lost', reason: 'restarted' | 'unconfirmed', detail, conversation? }
 *                                            | { status: 'unknown' }
 *  While the answer forms, its progress reaches the turn's stream as it is polled: the reasoning, the tool calls
 *  and the words. A turn is sent at most once: a send that may have reached the page without a reply saying so (the
 *  connection lost, no sign it went) ends the turn, and what it carried is not sent again under a new turn; an
 *  answer the bridge cannot have (`lost`, or a message it does not know) ends it at once. A turn the bridge still has on
 *  its way (`sending`: the harness restarted while it went) is asked again under its own id until the bridge answers
 *  as that send did; a send the turn gave up on while it was out (cancelled, the harness stopping) may have gone.
 *
 *  A bridge that drives a web product the person is signed in to is the person's own client of that product; the
 *  harness never holds its credentials, and whether such use is within the product's terms is the person's to
 *  check. */

import { routedAgentMentions, type DirectorSession } from '@oasis-code/contract'
import { BridgeError, bridgeImagesOf, bridgeRequest, CHAT_MODEL, CHATGPT_ANSWER_TIMEOUT_S, isLoopbackUrl, nextPiece, SEND_TIMEOUT_MS } from '../../llm/chatgpt_web.ts'
import { bool, num, str, TransportError, type DirectorTransport, type Readiness, type Rec, type TransportDeps, type TurnContext, type TurnOutcome } from './types.ts'

export const BRIDGE_DEFAULTS = { poll_interval_s: 1, poll_timeout_s: CHATGPT_ANSWER_TIMEOUT_S, new_conversation: true, busy_retry_s: 5 }
/** How long a turn the bridge answers `sending` for (it has this very message on its way) is asked again: a send
 *  takes up to SEND_TIMEOUT_MS (uploads first), and a turn that stopped asking sooner lost an answer that came; the
 *  slack covers the request's own round trips and the retry interval. */
export const SENDING_RETRY_FOR_S = SEND_TIMEOUT_MS / 1000 + 30
// the default every bridge director opened before 2026-09-30 kept in its config (nothing lets a person set it): too
// short for the web app's longest thinking, so read as today's default
const FORMER_DEFAULT_TIMEOUT_S = 1800

/** How long a bridge director's turn may wait for its answer. */
export function bridgeAnswerTimeoutS(config: Rec): number {
  const saved = num(config.poll_timeout_s, BRIDGE_DEFAULTS.poll_timeout_s)
  return saved === FORMER_DEFAULT_TIMEOUT_S ? BRIDGE_DEFAULTS.poll_timeout_s : saved
}
/** A ChatGPT app (connector) mention as the web app copies it: `[$oasis-code](app://asdk_app_…)`. */
export const MENTION = /^\[\$?[^\]]{1,80}\]\(app:\/\/[\w-]{1,120}\)$/

/** What of a turn's progress already went to its stream. */
interface Shown { thinking: string; text: string; steps: number }


function describeAbort(signal: AbortSignal): string {
  const reason: unknown = signal.reason
  return reason instanceof Error && reason.message ? `the send was given up (${reason.message})` : 'the send was given up'
}

export class BridgeTransport implements DirectorTransport {
  readonly id = 'bridge' as const
  readonly label = 'the ChatGPT web app through a bridge'

  private readonly shown = new Map<string, Shown>()

  constructor(private readonly deps: TransportDeps) {}

  readiness(): Readiness { return { ready: true, hint: 'needs a bridge: the desktop shell opens one (a signed-in ChatGPT page), or name a bridge_url' } }

  normalizeConfig(config: Rec, model: string | null): { config: Rec; model: string; label: string } {
    const url = str(config.bridge_url).trim().replace(/\/+$/, '')
    if (!url) throw new TransportError('bridge_url is required: the bridge the desktop shell opened, or one that speaks the bridge protocol')
    let parsed: URL
    try { parsed = new URL(url) } catch { throw new TransportError(`bridge_url is not a URL: ${url}`) }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new TransportError('bridge_url must be http(s)')
    const chatModel = str(config.chatgpt_model).trim()
    if (chatModel && !CHAT_MODEL.test(chatModel)) throw new TransportError('chatgpt_model must be a ChatGPT model slug, like gpt-6-pro')
    const mention = str(config.mention).trim()
    if (mention && !MENTION.test(mention)) throw new TransportError('mention must be the connector as ChatGPT copies it, like [$oasis-code](app://asdk_app_…)')
    return {
      config: {
        bridge_url: url, bridge_token: str(config.bridge_token), mention, chatgpt_model: chatModel,
        poll_interval_s: Math.max(1, num(config.poll_interval_s, BRIDGE_DEFAULTS.poll_interval_s)),
        poll_timeout_s: Math.max(10, bridgeAnswerTimeoutS(config)),
        busy_retry_s: Math.max(1, num(config.busy_retry_s, BRIDGE_DEFAULTS.busy_retry_s)),
        new_conversation: bool(config.new_conversation, BRIDGE_DEFAULTS.new_conversation),
      },
      model: model || 'ChatGPT', label: model || 'ChatGPT',
    }
  }

  private async call(director: DirectorSession, method: 'GET' | 'POST', path: string, body?: Rec, timeoutMs?: number, signal?: AbortSignal): Promise<Rec> {
    const saved = str(director.config.bridge_url)
    // the desktop app's own bridge (on the loopback): its token file is the live token and the address it wrote is the
    // live address (the app may have started it on another port since); a bridge elsewhere keeps what its director
    // was opened with
    const loopback = isLoopbackUrl(saved)
    const base = (loopback ? this.deps.localBridgeUrl?.() : null) || saved
    const token = (loopback ? this.deps.localBridgeToken?.() : null) || str(director.config.bridge_token)
    try {
      return await bridgeRequest(this.deps.fetchImpl, base, token || null, method, path, body, signal, timeoutMs)
    } catch (error) {
      if (path === '/send' && signal?.aborted) {
        throw new TransportError(`${describeAbort(signal)}; the ChatGPT page may have taken the message — it is not sent again, look at the ChatGPT card`, 502, { may_have_sent: true })
      }
      if (!(error instanceof BridgeError)) throw error
      if (error.kind === 'unreachable') throw new TransportError(`${error.message}: start it from the director setup in the desktop app, or start the bridge`, 503)
      // a send the bridge may have taken (the connection dropped, or no reply in time): its fate is the page's to show
      if (path === '/send' && (error.kind === 'lost' || error.kind === 'timeout')) {
        throw new TransportError(`${error.message}; the ChatGPT page may have taken the message — it is not sent again, look at the ChatGPT card`, 502, { may_have_sent: true })
      }
      throw new TransportError(error.message, 502)
    }
  }

  async probe(director: DirectorSession): Promise<{ ready: boolean; reason: string | null }> {
    const state = await this.call(director, 'GET', '/state')
    if (state.logged_in === false) return { ready: false, reason: 'ChatGPT is not signed in' }
    return { ready: true, reason: null }
  }

  async send(ctx: TurnContext): Promise<TurnOutcome> {
    const { director, turn } = ctx
    const first = director.external_ref === null
    // the person's words go as they wrote them — an agent they named as its name and route, the chip's words and what
    // start_run takes: the connector names the session to work in (current_session)
    const text = routedAgentMentions(turn.input)
    // every message goes as one the person sent with the model picked and the connector @-mentioned: the conversation
    // runs on that model and can use the connector from its first message
    const mention = str(director.config.mention)
    const chatModel = str(director.config.chatgpt_model)
    // a later turn goes back to the director's own conversation: the one page is shared with ChatGPT's runs as a
    // participant, which open conversations of their own on it
    const own = !first && typeof director.external_ref === 'string' && director.external_ref ? { conversation_url: director.external_ref } : {}
    const body = { text, turn_id: turn.id, new_conversation: first && bool(director.config.new_conversation, true), ...own, ...(mention ? { mention } : {}), ...(chatModel ? { model: chatModel } : {}) }
    // a send uploads its files and waits to see the message go: as long as the ChatGPT route waits for it (a shorter
    // wait read a message still going as a failure while ChatGPT answered it)
    const out = await this.call(director, 'POST', '/send', body, SEND_TIMEOUT_MS, ctx.signal)
    if (out.accepted !== true) {
      const reason = str(out.reason, 'not accepted')
      if (reason === 'needs_login') return { kind: 'needs_login', reason: 'ChatGPT is not signed in: sign in on the ChatGPT card, the message waits' }
      if (reason === 'generating') return { kind: 'busy', reason: 'ChatGPT is still answering an earlier message', retry_in_s: num(director.config.busy_retry_s, BRIDGE_DEFAULTS.busy_retry_s) }
      // the bridge has this very turn on its way (its first request cut by a restart of the harness): asked again until
      // it answers as that send did — sent (a repeat) or with no sign it went — never sent under another turn
      if (reason === 'sending') return { kind: 'busy', reason: 'the bridge is still sending this message to ChatGPT', retry_in_s: num(director.config.busy_retry_s, BRIDGE_DEFAULTS.busy_retry_s), may_have_sent: true, retry_for_s: SENDING_RETRY_FOR_S }
      if (reason === 'page_in_use') return { kind: 'busy', reason: `an agent is using the ChatGPT page (computer use, ${str(out.detail, 'another run')})`, retry_in_s: num(director.config.busy_retry_s, BRIDGE_DEFAULTS.busy_retry_s) }
      if (reason === 'not_sent') throw new TransportError('the ChatGPT page showed no sign that the message went; it is not sent again — look at the ChatGPT card', 502, { may_have_sent: true })
      if (reason === 'unconfirmed') throw new TransportError(`the ChatGPT page was given this message before with no sign that it went; it is not sent again (${str(out.detail)})`, 502, { may_have_sent: true })
      if (reason === 'journal_unusable') throw new TransportError(`the bridge sends nothing while it cannot tell which messages went: ${str(out.detail, 'its turn journal is not usable')}`, 503)
      if (reason === 'turn_conflict') throw new TransportError('the bridge has this turn as another message; it is not sent', 409)
      throw new TransportError(`the bridge did not accept the message: ${reason}`, 502)
    }
    const conversation = out.conversation && typeof out.conversation === 'object' ? (out.conversation as Rec) : null
    const ref = conversation && typeof conversation.url === 'string' ? conversation.url : director.external_ref
    // sent, and not recorded by the bridge: a restart of the app before the answer cannot tell it went
    const unkept = typeof out.journal_error === 'string' ? ` (the bridge could not record it: ${out.journal_error})` : ''
    return { kind: 'pending', external_ref: ref ?? null, note: `sent to ChatGPT; waiting for its answer${unkept}` }
  }

  async poll(ctx: TurnContext): Promise<TurnOutcome | null> {
    const out = await this.call(ctx.director, 'GET', `/answer?turn_id=${encodeURIComponent(ctx.turn.id)}`, undefined, undefined, ctx.signal)
    if (out.status === 'lost' || out.status === 'unknown') {
      this.shown.delete(ctx.turn.id)
      const conversation = out.conversation && typeof out.conversation === 'object' ? str((out.conversation as Rec).url) : ''
      const where = conversation ? ` (${conversation})` : ''
      if (out.status === 'unknown') return { kind: 'lost', reason: `the bridge no longer knows this message (another bridge, or a desktop app that no longer keeps it); its answer, if any, is on the ChatGPT page${where}` }
      return { kind: 'lost', reason: `ChatGPT's answer cannot be read back: ${str(out.detail, 'the desktop app restarted after the message went')}` }
    }
    if (out.status !== 'done') {
      if (out.progress && typeof out.progress === 'object') this.show(ctx, out.progress as Rec)
      return null
    }
    const text = str(out.text).trim()
    if (!text) return null
    this.shown.delete(ctx.turn.id)
    const conversation = out.conversation && typeof out.conversation === 'object' ? (out.conversation as Rec) : null
    return {
      kind: 'answered', text, model: str(out.model) || ctx.director.model, images: bridgeImagesOf(out.images),
      external_ref: conversation && typeof conversation.url === 'string' ? conversation.url : ctx.director.external_ref,
    }
  }

  /** The progress the page shows, as the turn's stream: what is new since the last poll. */
  private show(ctx: TurnContext, progress: Rec): void {
    const was = this.shown.get(ctx.turn.id) ?? { thinking: '', text: '', steps: 0 }
    const thinking = nextPiece(was.thinking, str(progress.thinking))
    if (thinking) ctx.emit('thinking_delta', thinking)
    const steps = Array.isArray(progress.steps) ? (progress.steps as Rec[]) : []
    for (const step of steps.slice(was.steps)) {
      const name = str(step.name, 'tool')
      if (step.kind === 'call') ctx.emit('tool_call', { name, summary: str(step.summary).slice(0, 200) })
      else if (step.kind === 'result') ctx.emit('tool_result', { name, status: str(step.status) === 'finished_successfully' || !step.status ? 'ok' : str(step.status), summary: str(step.summary).slice(0, 200) })
    }
    const text = nextPiece(was.text, str(progress.text))
    if (text) ctx.emit('text_delta', text)
    this.shown.set(ctx.turn.id, { thinking: str(progress.thinking), text: str(progress.text), steps: Math.max(was.steps, steps.length) })
  }
}
