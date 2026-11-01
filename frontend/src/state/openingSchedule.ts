/** A real task boundary (not Promise.resolve) for unusually costly envelope conversion/ancillary startup.
 * Small openings never call it. Feature detection keeps older webviews on a timer fallback. */
export function yieldOpening(): Promise<void> {
  const scheduler = (globalThis as typeof globalThis & { scheduler?: { yield?: () => Promise<void> } }).scheduler
  return scheduler?.yield ? scheduler.yield() : new Promise(resolve => setTimeout(resolve, 0))
}
