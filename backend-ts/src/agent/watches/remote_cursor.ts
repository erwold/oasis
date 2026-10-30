/** JSON-persistable UTF-8/line state for replaying remote logs without duplicate or split-line matches. */
import { MAX_LINE_CHARS } from './conditions.ts'
export interface RemoteCursorState {
  utf8: string; partial: string; skipping: boolean; holding: boolean | null; silent: boolean; gap: boolean; eof: boolean;
}
export const emptyRemoteCursor = (): RemoteCursorState => ({ utf8: '', partial: '', skipping: false, holding: null, silent: false, gap: false, eof: false })
export function remoteLines(previous: RemoteCursorState, bytes: Buffer, final: boolean): { state: RemoteCursorState; lines: string[] } {
  const state = { ...previous }, merged = Buffer.concat([Buffer.from(state.utf8, 'base64'), bytes])
  let complete = merged.length
  if (!final && merged.length) {
    let start = merged.length - 1
    while (start >= Math.max(0, merged.length - 4) && (merged[start]! & 0xc0) === 0x80) start--
    if (start >= 0) {
      const lead = merged[start]!, need = lead >= 0xc2 && lead <= 0xdf ? 2 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xf0 && lead <= 0xf4 ? 4 : 1
      if (merged.length - start < need) complete = start
    }
  }
  state.eof = final
  state.utf8 = merged.subarray(complete).toString('base64')
  let value = state.partial + new TextDecoder().decode(merged.subarray(0, complete))
  if (state.skipping) {
    const end = /\r\n|\r|\n/.exec(value)
    if (!end) { state.partial = ''; return { state, lines: [] } }
    value = value.slice(end.index! + end[0].length); state.skipping = false
  }
  const lines = value.split(/\r\n|\r|\n/)
  state.partial = lines.pop() ?? ''
  if (state.partial.length > MAX_LINE_CHARS) { lines.push(state.partial.slice(0, MAX_LINE_CHARS)); state.partial = ''; state.skipping = true }
  if (final && state.partial) { lines.push(state.partial); state.partial = '' }
  state.eof = final
  return { state, lines: lines.map(s => s.slice(0, MAX_LINE_CHARS)).filter(s => s.trim().length > 0) }
}
