/** A session's commands still running after the run that started them ended (SessionDetail.background_commands): the
 *  thread header's terminal count reads them from the session the page holds, which the session's own ticker reads
 *  again (state/store.ts syncSession) — idle or while another run works; no command is polled on its own for it. */

import type { BackgroundCommand, OutputWindow } from '@oasis-code/contract'

/** The one empty list: a session without such commands (or a detail from an older harness) reads this, never a new
 *  array per call — a selector that returned a fresh one would draw its component again on every store change. */
export const NO_BACKGROUND: readonly BackgroundCommand[] = Object.freeze([]) as readonly BackgroundCommand[]

type WithBackground = { id: string; background_commands?: BackgroundCommand[] | null }

/** The store's selector: the stored list itself (stable while the session's detail keeps it), else the empty one. */
export function selectBackgroundCommands(state: { session: WithBackground | null }): readonly BackgroundCommand[] {
  return state.session?.background_commands ?? NO_BACKGROUND
}

/** Whether two lists name the same commands in the same states (what the header shows of them). */
export function sameBackground(a: readonly BackgroundCommand[] | null | undefined, b: readonly BackgroundCommand[] | null | undefined): boolean {
  const x = a ?? NO_BACKGROUND, y = b ?? NO_BACKGROUND
  if (x === y) return true
  if (x.length !== y.length) return false
  for (let i = 0; i < x.length; i += 1) {
    const p = x[i]!, q = y[i]!
    if (p.execution_id !== q.execution_id || p.status !== q.status || p.command !== q.command || p.run_id !== q.run_id
      || p.workspace_id !== q.workspace_id || p.conversation_id !== q.conversation_id) return false
  }
  return true
}

/** Whether a fresh read of the session moved its background commands (one started, ended or changed state). */
export function backgroundChanged(current: WithBackground | null, fresh: WithBackground): boolean {
  if (!current || current.id !== fresh.id) return (fresh.background_commands?.length ?? 0) > 0
  return !sameBackground(current.background_commands, fresh.background_commands)
}

/** The fresh detail, keeping the list the page already holds when it names the same commands in the same states: the
 *  header's selector then returns the very same reference and nothing draws again for a read that moved nothing. */
export function keepBackground<T extends WithBackground>(current: WithBackground | null, fresh: T): T {
  if (!current || current.id !== fresh.id || !current.background_commands || !fresh.background_commands) return fresh
  if (current.background_commands === fresh.background_commands) return fresh
  return sameBackground(current.background_commands, fresh.background_commands) ? { ...fresh, background_commands: current.background_commands } : fresh
}

/** The header button's accessible name and title. */
export function backgroundLabel(commands: readonly BackgroundCommand[]): string {
  const n = commands.length
  const unknown = commands.filter((c) => c.status !== 'running').length
  const base = `${n} background command${n === 1 ? '' : 's'} from earlier runs`
  return unknown > 0 && unknown === n ? `${base}, end not known yet` : unknown > 0 ? `${base} (${unknown} with an end not known yet)` : `${base} still running`
}

/** A command's state in a word: running, or — a remote writer whose end is not known — said as such, never as running. */
export function backgroundStatus(status: string): string {
  if (status === 'running') return 'running'
  if (status === 'unknown') return 'end not known'
  return status
}

/** A command's first line, cut for one row. */
export function commandLine(command: string, max = 80): string {
  const first = command.split('\n', 1)[0]!.trim()
  const more = first.length < command.trim().length
  return first.length > max ? `${first.slice(0, max - 1)}…` : more ? `${first} …` : first
}

/** How much of a command's log the header's list shows: its last bytes. */
export const TAIL_BYTES = 6144

type Output = (executionId: string, stream: string, offset?: number, limit?: number) => Promise<OutputWindow>

/** A command's latest output: its log's last `bytes` (the start, then — when the log is longer — its end, from a line
 *  start). A log that cannot be read now is answered as the harness said it (terminalText says so, never as empty). */
export async function readTail(output: Output, executionId: string, stream: 'stdout' | 'stderr', bytes = TAIL_BYTES): Promise<OutputWindow> {
  const head = await output(executionId, stream, 0, bytes)
  if (head.available === false || head.total_bytes === null || head.total_bytes <= head.returned_bytes) return head
  const tail = await output(executionId, stream, Math.max(0, head.total_bytes - bytes), bytes)
  if (tail.available === false || tail.offset === 0) return tail
  const cut = tail.text.indexOf('\n')
  return { ...tail, text: `…\n${cut >= 0 ? tail.text.slice(cut + 1) : tail.text}` }
}
