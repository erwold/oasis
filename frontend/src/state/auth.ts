import type { AuthProvider, LoginSession } from '../api/types.ts'

/** After this long without the loopback callback, the page also offers a paste box. */
export const PASTE_AFTER_MS = 15_000

export function needsAttention(provider: AuthProvider): boolean {
  return provider.status === 'signed_out' || provider.status === 'login_required'
}

export function pollDelay(session: LoginSession | null): number | null {
  if (!session) return null
  if (session.state === 'waiting') return 1000
  if (session.state === 'exchanging') return 500
  return null
}

export function showPasteBox(session: LoginSession | null, startedAt: number, now: number): boolean {
  return session?.state === 'waiting' && (session.paste_only || now - startedAt >= PASTE_AFTER_MS)
}

export function loginHint(session: LoginSession): string {
  switch (session.state) {
    case 'waiting': return session.paste_only
      ? 'The callback port is busy: finish in the browser, then paste the final redirect URL here.'
      : 'Finish in the browser tab that opened. If nothing opened, use the link.'
    case 'exchanging': return 'Saving the sign-in…'
    case 'done': return `Signed in${session.account_label ? ` as ${session.account_label}` : ''}.`
    case 'failed': return session.error ?? 'Sign-in failed.'
    default: return 'Cancelled.'
  }
}
