/** UTC, millisecond precision, a trailing Z: `2026-09-26T08:00:00.000Z` (the same text the rows always carried). */
export function nowIso(): string {
  return new Date().toISOString()
}

/** A monotonic clock in seconds (what the runner's budgets and the slots measure with). */
export function monotonic(): number {
  return performance.now() / 1000
}

/** Today's date and the time zone, as the run's first message names them (the runtime's clock, the host's zone). */
export function clock(): { date: string; zone: string } {
  const now = new Date(nowIso())
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
  return { date, zone }
}
