/** Safe diagnostics for standard providers whose API keys need not have recognizable prefixes.
 * Keep only status and an allowlisted diagnosis; never return the upstream text/body to a log or UI. */
import { ModelAPIError, ModelHTTPError, PROVIDER_CONTEXT_WORDS, PROVIDER_MODEL_GONE_WORDS, PROVIDER_RATE_LIMIT_WORDS, providerErrorText, providerQuotaExhausted } from '../model.ts'

export function safeProviderHttpError(error: ModelHTTPError, provider: string, model: string): ModelHTTPError {
  // The display message serializes the body and can include request echoes.
  const text = providerErrorText(error.body)
  const reason = providerQuotaExhausted(error.status_code, error.body) ? 'quota exceeded'
    : PROVIDER_CONTEXT_WORDS.test(text) ? 'context window exceeded'
    : PROVIDER_MODEL_GONE_WORDS.test(text) ? 'model not available'
    : 'request rejected; check standard API credentials, limits and request parameters'
  return new ModelHTTPError(error.status_code, model, { error: { message: `${provider} ${reason}` } })
}

/** HTTP 200 may still carry a provider failure in SSE. Map only known diagnoses to
 * fixed safe errors; never retain upstream text, code, body or a cause chain. The
 * synthetic status is a recovery classification, not the transport's HTTP status. */
export function safeProviderStreamError(raw: unknown, provider: 'deepseek' | 'zhipu', model: string): Error {
  const text = providerErrorText(raw)
  let status: number, reason: string
  // SSE has no failure HTTP status; use a neutral failure status to test explicit exhaustion.
  if (providerQuotaExhausted(400, text)) { status = 402; reason = 'quota exceeded' }
  else if (PROVIDER_RATE_LIMIT_WORDS.test(text)) { status = 429; reason = 'rate limit exceeded' }
  else if (PROVIDER_CONTEXT_WORDS.test(text)) { status = 400; reason = 'context window exceeded' }
  else if (PROVIDER_MODEL_GONE_WORDS.test(text)) { status = 404; reason = 'model not available' }
  else return new ModelAPIError(model, `${provider} stream failed`)
  return new ModelHTTPError(status, model, { error: { message: `${provider} ${reason}` } })
}
