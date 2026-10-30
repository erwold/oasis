/** The live link page's stream reader (src/share/live/sse.ts), by the HTML standard's rules: every chunk boundary,
 *  CRLF / LF / CR line ends (a CR at a chunk's end), comments, a BOM, multi-line data, ids, retry, the bounds. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SseParser, SseProtocolError } from '../src/share/live/sse.ts'

const STREAM = '\uFEFF: keep-alive\r\nevent: state\r\nid: e1.1\r\ndata: {"a":1,\r\ndata: "b":2}\r\n\r\n: keep-alive\n\nevent: ended\rdata: {"reason":"revoked"}\r\r'

function all(chunks: string[]) {
  const p = new SseParser()
  const out = chunks.flatMap((c) => p.push(c))
  return { out, p }
}

test('the same messages whatever the chunk boundaries: CRLF, LF and CR, a CR split from its LF, comments counted, the BOM dropped', () => {
  const whole = all([STREAM])
  assert.deepEqual(whole.out, [
    { event: 'state', data: '{"a":1,\n"b":2}', id: 'e1.1' },
    { event: 'ended', data: '{"reason":"revoked"}', id: 'e1.1' },
  ])
  assert.equal(whole.p.comments, 2)
  for (let i = 0; i <= STREAM.length; i++) {
    const split = all([STREAM.slice(0, i), STREAM.slice(i)])
    assert.deepEqual(split.out, whole.out, `split at ${i}`)
  }
  // one character at a time (empty chunks too)
  const chars = all([...STREAM].flatMap((c) => [c, '']))
  assert.deepEqual(chars.out, whole.out)
})

test('a blank line with no data dispatches nothing; an unknown field is ignored; a field without a colon is empty', () => {
  const { out } = all(['event: state\n\n', 'foo: bar\ndata\n\n', 'data:no-space\n\n'])
  assert.deepEqual(out, [{ event: 'message', data: '', id: null }, { event: 'message', data: 'no-space', id: null }])
})

test('id with a NUL is ignored; retry takes digits only; the last id carries over', () => {
  const p = new SseParser()
  const out = p.push('id: one\nretry: 2500\ndata: x\n\nid: t\u0000wo\nretry: soon\ndata: y\n\n')
  assert.deepEqual(out.map((m) => m.id), ['one', 'one'])
  assert.equal(p.retry, 2500)
})

test('a message not closed by a blank line before the end is dropped', () => {
  const p = new SseParser()
  assert.deepEqual(p.push('event: state\ndata: half'), [])
  p.end()
  assert.deepEqual(p.push('data: next\n\n'), [{ event: 'message', data: 'next', id: null }])
})

test('a line or a message past its bound is a protocol error, never buffered on', () => {
  const p = new SseParser({ maxLineChars: 16, maxMessageChars: 1024 })
  assert.throws(() => p.push('data: 0123456789abcdef'), SseProtocolError)
  const q = new SseParser({ maxLineChars: 1024, maxMessageChars: 20 })
  assert.throws(() => q.push('data: 0123456789\ndata: 0123456789\n'), SseProtocolError)
})
