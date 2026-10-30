/** A folder edited in place, as the page says it: whether a run's file changes can be undone, and what an undo did. */

import type { UndoResult } from '@oasis-code/contract'

const FINISHED = new Set(['done', 'error', 'cancelled'])

/** Whether a finished run of a folder edited in place changed files with its tools (what an undo takes back). */
export function undoable(run: { status: string }, filesChanged: number, workspaceKind: string | null | undefined): boolean {
  return workspaceKind === 'direct' && FINISHED.has(run.status) && filesChanged > 0
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** What an undo did, in one line: the files put back, the ones removed (the run had made them), and the ones left
 *  alone, each with the server's reason (changed since the run wrote it, cannot be read, a write the harness was
 *  stopped in). Undo covers the file tools' writes only: when it changed anything, the line says the commands' did not
 *  go back. */
export function undoLine(result: UndoResult): string {
  if (result.nothing) return 'Nothing to undo: the run wrote no file with its tools, or its changes were undone already.'
  const parts: string[] = []
  if (result.restored.length) parts.push(`put back ${plural(result.restored.length, 'file')} as before the run`)
  if (result.removed.length) parts.push(`removed ${plural(result.removed.length, 'file')} the run had made`)
  const byReason = new Map<string, string[]>()
  for (const c of result.conflicts) byReason.set(c.reason, [...(byReason.get(c.reason) ?? []), c.path])
  for (const [reason, paths] of byReason) parts.push(`left ${paths.join(', ')} alone (${reason})`)
  if (!parts.length) return 'Nothing left to undo: the run\'s changes were undone already.'
  const line = parts.join('; ')
  const commands = result.restored.length || result.removed.length ? ' What its commands changed is not undone.' : ''
  return line.charAt(0).toUpperCase() + line.slice(1) + '.' + commands
}
