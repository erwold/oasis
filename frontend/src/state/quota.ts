import type { AccountUsage, QuotaWindow } from '../api/types.ts'

export function remainingPercent(used: number | null): number | null {
  return used === null || !Number.isFinite(used) || used < 0 ? null : Math.max(0, 100 - used)
}

export function percentLabel(value: number): string {
  return `${Math.round(value * 10) / 10}%`
}

export function resetPending(window: QuotaWindow, now: number): boolean {
  return window.resets_at !== null && Date.parse(window.resets_at) <= now
}

export function resetCountdown(resetAt: string | null, now: number): string {
  if (!resetAt || !Number.isFinite(Date.parse(resetAt))) return 'Reset time not reported'
  let seconds = Math.ceil((Date.parse(resetAt) - now) / 1000)
  if (seconds <= 0) return 'Waiting for provider reset'
  const days = Math.floor(seconds / 86400)
  seconds %= 86400
  const hours = Math.floor(seconds / 3600)
  seconds %= 3600
  const minutes = Math.floor(seconds / 60)
  seconds %= 60
  if (days) return `Resets in ${days}d ${hours}h`
  if (hours) return `Resets in ${hours}h ${minutes}m`
  return `Resets in ${minutes}m ${seconds}s`
}

export function quotaSummary(account: AccountUsage, now: number): string {
  if (account.status === 'login_required') return account.error === 'proxy_expired' ? 'Token expired' : 'Sign in'
  if (account.status === 'stale') return 'Out of date'
  if (account.status !== 'ok') return 'Unavailable'
  if (account.windows.some((w) => resetPending(w, now))) return 'Reset pending'
  const values = account.windows.map((w) => remainingPercent(w.used_percent)).filter((n): n is number => n !== null)
  return values.length ? `${percentLabel(Math.min(...values))} left` : 'Not reported'
}

/** A proxy (CLIProxyAPI) account repeats the subscription the person signed in to here; it is
 *  hidden unless asked for. A provider with no harness sign-in keeps its proxy entry. */
export function visibleAccounts(accounts: AccountUsage[], showProxy: boolean): AccountUsage[] {
  if (showProxy) return accounts
  const signedIn = new Set(accounts.filter((a) => a.source === 'harness').map((a) => a.provider))
  return accounts.filter((a) => a.source !== 'proxy' || !signedIn.has(a.provider))
}

/** The rail's rows: Antigravity stands beside Codex and Claude only once it is signed in — its models do not yet
 *  get the same footing, so a signed-out Antigravity neither takes a row nor lights the attention dot. */
export function railAccounts(accounts: AccountUsage[], showProxy: boolean): AccountUsage[] {
  return visibleAccounts(accounts, showProxy).filter((a) => a.provider !== 'antigravity' || a.status !== 'login_required')
}

export function hiddenProxyCount(accounts: AccountUsage[]): number {
  return accounts.length - visibleAccounts(accounts, false).length
}
