import { RemoteError } from './types.ts'
export const MAX_FRAME = 8 * 1024 * 1024
export const MAGIC = Buffer.from('OSR1')
export function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  if (body.length > MAX_FRAME) throw new RemoteError('frame_too_large', 'RPC frame exceeds budget')
  const head = Buffer.alloc(8); MAGIC.copy(head); head.writeUInt32BE(body.length, 4)
  return Buffer.concat([head, body])
}
/** No resynchronization: a login banner or interactive relay is not an exec transport. */
export class FrameDecoder {
  private buffer = Buffer.alloc(0)
  push(chunk: Uint8Array): unknown[] { const values: unknown[] = []; this.feed(chunk, value => values.push(value)); return values }
  /** Delivers every complete frame before reporting a later malformed one, so a definite
   * response on a long-lived channel is never lost to trailing garbage. */
  feed(chunk: Uint8Array, onValue: (value: unknown) => void): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk)
    while (this.buffer.length >= 8) {
      if (!this.buffer.subarray(0, 4).equals(MAGIC)) throw new RemoteError('unsupported_transport', 'Remote stdout is not the exec protocol')
      const size = this.buffer.readUInt32BE(4)
      if (size > MAX_FRAME) throw new RemoteError('frame_too_large', 'Remote frame exceeds budget')
      if (this.buffer.length < size + 8) break
      let value: unknown
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(this.buffer.subarray(8, size + 8))) }
      catch { throw new RemoteError('protocol_mismatch', 'Invalid protocol JSON/UTF-8') }
      this.buffer = this.buffer.subarray(size + 8)
      onValue(value)
    }
  }
  end(): void { if (this.buffer.length) throw new RemoteError('protocol_mismatch', 'Truncated remote frame') }
}
