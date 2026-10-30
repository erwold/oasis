/** PKCE (RFC 7636) and state material for the browser OAuth flows. */

import { createHash, randomBytes } from 'node:crypto'

function b64url(raw: Buffer): string {
  return raw.toString('base64url')
}

/** [verifier, S256 challenge]: 32 random bytes, base64url without padding. */
export function generatePkce(): [string, string] {
  const verifier = b64url(randomBytes(32))
  const challenge = b64url(createHash('sha256').update(verifier, 'ascii').digest())
  return [verifier, challenge]
}

export function generateState(): string {
  return randomBytes(16).toString('hex')
}
