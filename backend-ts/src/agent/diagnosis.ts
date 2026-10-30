/** What a failed run tells the person: which kind of failure it was — finer than the runner's recovery classes
 *  (a stall and a dropped connection recover alike but read differently; a spent quota is not a moment's rate
 *  limit) — with the provider's status, and the message with anything that looks like a credential masked. The
 *  runner's own recovery keeps `classifyError`; this is what the page shows and what the record keeps. */

import { ChatGptWebError } from '../llm/chatgpt_web.ts'
import { LongDecodeInterrupted, ModelHTTPError, PROVIDER_MODEL_GONE_WORDS } from '../llm/model.ts'
import { classifyError, providerStatusError, transientTransportError } from './runner.ts'

export type DiagnosisKind =
  | 'auth' | 'quota' | 'rate_limit' | 'context_overflow' | 'model_unavailable' | 'bad_request' | 'outage' | 'timeout'
  | 'disconnect' | 'budget' | 'cancelled' | 'incomplete' | 'other'
  // a remote effect (an SSH write or command start) whose outcome is unknown stopped the run
  | 'remote_unknown'
  // ChatGPT on the web: its page signed out, the page not there, the page not taking the message
  | 'chatgpt_signin' | 'chatgpt_unreachable' | 'chatgpt_refused'

export interface Diagnosis { kind: DiagnosisKind; status_code: number | null }

const MODEL_GONE = PROVIDER_MODEL_GONE_WORDS
/** The refusal a long decode's failure facts name, in words the readings below (and the runner's) take for it. */
const REASON_WORDS: Record<string, string> = { quota: 'quota exceeded', model_unavailable: 'model not found', context_overflow: 'prompt is too long' }

export function diagnose(error: unknown): Diagnosis {
  if (error instanceof ChatGptWebError) return { kind: error.kind === 'timeout' ? 'timeout' : `chatgpt_${error.kind}`, status_code: null }
  // a long decode whose resumes from its checkpoint were spent: a dropped connection to the person (it is no transport
  // error to the runner, which must not send the whole request again)
  if (error instanceof LongDecodeInterrupted) {
    // what ended it, when that is the provider's refusal (a key, a quota, a request it will not take): read as such;
    // a drop, a stall or the provider's passing failure reads as the dropped connection it ended as
    // read from its facts alone (a status and the refusal named): the failure's own words are not kept
    const failure = error.detail.failure
    const found = failure && failure.status_code !== null
      ? diagnose(new ModelHTTPError(failure.status_code, error.model_name, { error: { message: failure.reason ? REASON_WORDS[failure.reason] : '' } }))
      : null
    return found && !['disconnect', 'timeout', 'outage', 'rate_limit', 'other'].includes(found.kind) ? found : { kind: 'disconnect', status_code: found?.status_code ?? null }
  }
  const status = providerStatusError(error)
  const code = status ? status[0] : null
  const message = status ? status[1] : String((error as Error)?.message ?? error)
  const base = classifyError(error)
  if (base === 'transport') return { kind: transientTransportError(error) === 'TimeoutException' ? 'timeout' : 'disconnect', status_code: code }
  if (base === 'quota') return { kind: 'quota', status_code: code }
  if (code === 404 || (base === 'bad_request' && MODEL_GONE.test(message))) return { kind: 'model_unavailable', status_code: code }
  const known: Record<string, DiagnosisKind> = {
    auth: 'auth', rate_limit: 'rate_limit', context_overflow: 'context_overflow', bad_request: 'bad_request', outage: 'outage', cancelled: 'cancelled',
  }
  return { kind: known[base] ?? 'other', status_code: code }
}
