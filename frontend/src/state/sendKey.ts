/** The key a message is sent with. Sending the same words and images again in the same session — after an error
 *  whose cause is unknown, the answer maybe lost on the way back — reuses it, so the harness answers with the run it
 *  already started instead of starting a second; a changed message is a new one. */

export interface SendKey { sessionId: string; signature: string; key: string }

/** The words carry the agents named and their order (as tokens); the rounds ride beside them. */
export function signatureOf(text: string, imageIds: string[], extra: unknown = null): string {
  return JSON.stringify(extra === null ? [text, imageIds] : [text, imageIds, extra])
}

export function keyFor(previous: SendKey | null, sessionId: string, signature: string, mint: () => string = () => crypto.randomUUID()): SendKey {
  if (previous && previous.sessionId === sessionId && previous.signature === signature) return previous
  return { sessionId, signature, key: mint() }
}

/** Unacknowledged requests are independent by session AND signature (which includes the destination). An accepted
 * response clears only its own key. A failed A, successful B, retry A must not spend the quota twice. */
export function pendingSendKeys() {
  const pending = new Map<string, SendKey>()
  const index = (sessionId: string, signature: string) => JSON.stringify([sessionId, signature])
  return {
    get(sessionId: string, signature: string): SendKey {
      const at = index(sessionId, signature)
      const key = pending.get(at) ?? keyFor(null, sessionId, signature)
      pending.set(at, key)
      return key
    },
    acknowledge(sent: SendKey): void {
      const at = index(sent.sessionId, sent.signature)
      if (pending.get(at)?.key === sent.key) pending.delete(at)
    },
    forgetSession(sessionId: string): void {
      for (const [at, key] of pending) if (key.sessionId === sessionId) pending.delete(at)
    },
  }
}
