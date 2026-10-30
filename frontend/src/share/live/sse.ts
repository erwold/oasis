/** The live link page's reading of its event stream (text/event-stream, as the HTML standard defines it), by hand: the
 *  page reads its stream through fetch (the capability goes in a header, never in a URL), so no EventSource parses it.
 *  Pure — node --test exercises it chunk by chunk.
 *
 *  - Lines end at CRLF, LF or CR, also when a chunk ends between the CR and its LF.
 *  - `event`, `data` (joined by LF), `id` (one with a NUL is ignored), `retry` (digits only); any other field is
 *    ignored; a line starting with `:` is a comment (the server's heartbeat), counted, never dispatched.
 *  - A blank line dispatches the message gathered — none when it gathered no data. A leading BOM is dropped.
 *  - A line or a message past its bound is a protocol error (thrown): the connection is dropped, never buffered on. */

export interface SseMessage { event: string; data: string; id: string | null }

export interface SseBounds { maxLineChars: number; maxMessageChars: number }

export const DEFAULT_SSE_BOUNDS: SseBounds = { maxLineChars: 16 * 1024 * 1024, maxMessageChars: 16 * 1024 * 1024 }

export class SseProtocolError extends Error {
  constructor(message: string) { super(`event stream: ${message}`); this.name = 'SseProtocolError' }
}

export class SseParser {
  private line = ''
  private data: string[] = []
  private dataChars = 0
  private event = ''
  private sawData = false
  private started = false
  private pendingCr = false
  /** the last event id the stream set (kept across messages, as the standard has it) */
  lastEventId: string | null = null
  /** the reconnection time the stream asked for, in ms, if any */
  retry: number | null = null
  /** comment lines read (the server's heartbeats) */
  comments = 0
  private readonly bounds: SseBounds

  constructor(bounds: SseBounds = DEFAULT_SSE_BOUNDS) { this.bounds = bounds }

  /** The messages a decoded chunk completes, in order. */
  push(chunk: string): SseMessage[] {
    const out: SseMessage[] = []
    let text = chunk
    if (!this.started && text.length > 0) {
      this.started = true
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    }
    let i = 0
    // a CR that ended the previous chunk: an LF right after it is the same line ending
    if (text.length === 0) return out
    if (this.pendingCr) {
      this.pendingCr = false
      if (text[0] === '\n') i = 1
    }
    while (i < text.length) {
      const cr = text.indexOf('\r', i)
      const lf = text.indexOf('\n', i)
      const end = cr < 0 ? lf : lf < 0 ? cr : Math.min(cr, lf)
      if (end < 0) {
        this.line += text.slice(i)
        if (this.line.length > this.bounds.maxLineChars) throw new SseProtocolError('a line past its bound')
        break
      }
      this.line += text.slice(i, end)
      if (this.line.length > this.bounds.maxLineChars) throw new SseProtocolError('a line past its bound')
      const line = this.line
      this.line = ''
      if (text[end] === '\r') {
        if (end + 1 < text.length) i = text[end + 1] === '\n' ? end + 2 : end + 1
        else { this.pendingCr = true; i = end + 1 }
      } else i = end + 1
      const message = this.take(line)
      if (message) out.push(message)
    }
    return out
  }

  /** The stream ended: a message not closed by a blank line is dropped, as the standard has it. */
  end(): void {
    this.line = ''
    this.reset()
    this.pendingCr = false
  }

  private reset(): void {
    this.data = []
    this.dataChars = 0
    this.event = ''
    this.sawData = false
  }

  private take(line: string): SseMessage | null {
    if (line === '') {
      if (!this.sawData) { this.reset(); return null }
      const message = { event: this.event || 'message', data: this.data.join('\n'), id: this.lastEventId }
      this.reset()
      return message
    }
    if (line.startsWith(':')) { this.comments += 1; return null }
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    let value = colon < 0 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    switch (field) {
      case 'event': this.event = value; break
      case 'data':
        this.dataChars += value.length + 1
        if (this.dataChars > this.bounds.maxMessageChars) throw new SseProtocolError('a message past its bound')
        this.data.push(value)
        this.sawData = true
        break
      case 'id': if (!value.includes('\0')) this.lastEventId = value; break
      case 'retry': if (/^\d+$/.test(value)) this.retry = Number(value); break
      default: break
    }
    return null
  }
}
