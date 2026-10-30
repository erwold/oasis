/** Credentials masked out of text the harness keeps or shows: an error a provider or a library wrote may quote a
 *  key, a token or a header. Every error text on its way to the record or the page passes through here. */

// the shapes a credential takes in an error a provider or a library wrote: API keys by their prefixes, bearer and
// basic headers, key=value pairs named like secrets, JWTs
const SECRETS: [RegExp, string][] = [
  [/\b(sk|rk|pk)-(ant-|proj-|live-|test-)?[A-Za-z0-9_-]{8,}/g, '$1-…'],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, 'AIza…'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 …'],
  [/\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|authorization)["']?\s*[:=]\s*["']?)[^\s"',;&]{6,}/gi, '$1…'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, 'eyJ…'],
]

/** The text with every credential-looking run masked (ids of the harness's own, run_…, cp_…, stay readable). */
export function redactSecrets(text: string): string {
  let out = text
  for (const [pattern, replacement] of SECRETS) out = out.replace(pattern, replacement)
  return out
}
