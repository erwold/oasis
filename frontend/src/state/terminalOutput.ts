import type { OutputWindow } from '../api/types'

type Stream = 'stdout' | 'stderr'

/** What the terminal shows of a command's log: a log that cannot be read now (a remote command while its host is
 *  away) is said as such — never shown as an empty log — and more to read is marked. */
export function terminalText(out: OutputWindow | null, stream: Stream, otherBytes: number): string {
  if (!out) return 'loading…'
  if (out.available === false) return `(log unavailable${out.connection_state && out.connection_state !== 'connected' ? ` · ${out.connection_state}` : ''})`
  const other: Stream = stream === 'stdout' ? 'stderr' : 'stdout'
  const body = out.text || `(nothing on ${stream}${otherBytes ? `; ${otherBytes} B on ${other}` : ''})`
  return out.eof ? body : `${body}\n…[more in the log]`
}

/** The line beside the streams: how much of the log is shown, and where the command stands — an unknown state is
 *  said as unknown, never as still running. */
export function terminalStatus(out: OutputWindow | null): string {
  if (!out) return ''
  const state = out.status === 'unknown' ? ' · status unknown' : out.running ? ' · still running' : ''
  if (out.available === false) return state.replace(/^ · /, '')
  const size = out.total_bytes === null ? `${out.returned_bytes} bytes` : `${out.returned_bytes} of ${out.total_bytes} bytes`
  return `${size}${out.truncated_at_cap ? ' (log capped at the limit)' : ''}${state}`
}
