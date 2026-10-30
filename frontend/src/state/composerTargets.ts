/** Where a session's words go — its agent, its director, ChatGPT directing it — as the person last chose for that
 *  session: a session opened again (a reload, another session and back, the end of a replay) keeps the choice. With
 *  no choice made, the words go to the agent; a director is the person's to call in. Kept in this browser only. */

import type { ComposerTarget } from './director.ts'

const KEY = 'oasis-code.composerTargets'
const TARGETS: readonly ComposerTarget[] = ['agent', 'director', 'chatgpt']

function read(): Record<string, ComposerTarget> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>
    return Object.fromEntries(Object.entries(raw).filter((e): e is [string, ComposerTarget] => TARGETS.includes(e[1] as ComposerTarget)))
  } catch { return {} }
}

export function rememberedTarget(sessionId: string): ComposerTarget | null {
  return read()[sessionId] ?? null
}

export function rememberTarget(sessionId: string, target: ComposerTarget): void {
  try { localStorage.setItem(KEY, JSON.stringify({ ...read(), [sessionId]: target })) } catch { /* private window: this page only */ }
}

export function forgetTarget(sessionId: string): void {
  const all = read()
  if (!(sessionId in all)) return
  delete all[sessionId]
  try { localStorage.setItem(KEY, JSON.stringify(all)) } catch { /* private window */ }
}
