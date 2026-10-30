/** The thread follows its newest rows while the person is at its end (Thread's `pinned`). A run action pressed on a
 *  surface starts a run that joins the thread below that surface: following it there would carry the surface the person
 *  is working in out of view while its task reports back to it. The press holds the thread where it is instead (as
 *  scrolling up would); scrolling back to the end follows again. Sending a message does the opposite: the thread goes
 *  to its end and follows the run it started, wherever the person had scrolled. */

const listeners = new Set<() => void>()

/** Hold the thread where it stands (a surface's run action was pressed). */
export function holdThread(): void {
  for (const listener of [...listeners]) listener()
}

/** Thread listens while mounted; the function returned stops it. */
export function onThreadHold(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

const followers = new Set<() => void>()

/** Take the thread to its end and follow it (the person sent a message). */
export function followThread(): void {
  for (const listener of [...followers]) listener()
}

export function onThreadFollow(listener: () => void): () => void {
  followers.add(listener)
  return () => { followers.delete(listener) }
}
