/** A loopback HTTP server, run as its own process by test_safe_fetch, that answers with chosen Content-Encodings and
 *  bytes: synthetic payloads only, compressed here (an encoder, never a decoder). It prints one JSON line — its port
 *  and the exact bytes of its encoded bodies — then serves until killed. A held-open body records when the client let
 *  it go (`GET /__released` lists them), the server-side evidence that a raw body was cancelled. */

import { brotliCompressSync, deflateRawSync, deflateSync, gzipSync } from 'node:zlib'

const PLAIN = 'synthetic plaintext for the Content-Encoding fixture; '.repeat(40)
const plain = Buffer.from(PLAIN)
const GZIP = gzipSync(plain)
const DEFLATE = deflateSync(plain)
const DEFLATE_RAW = deflateRawSync(plain)
const BR = brotliCompressSync(plain)
/** Bytes a Brotli decoder rejects at once (an invalid window size): a decoder that ran on them reports an error. */
const BR_INVALID = Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00, 0x01, 0x02, 0x03])
/** A gzip header followed by bytes no inflater takes. */
const GZIP_MALFORMED = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0xff, 0xff, 0xff, 0xff])
const MULTI = Buffer.concat([gzipSync(plain.subarray(0, 700)), gzipSync(plain.subarray(700))])

const released: string[] = []
const hits: Record<string, number> = {}

/** A body that sends `first` and then nothing, never ending: what the client does with it is recorded. */
function heldOpen(path: string, req: Request, first: Uint8Array | null): ReadableStream<Uint8Array> {
  req.signal.addEventListener('abort', () => released.push(`${path} aborted`))
  return new ReadableStream<Uint8Array>({
    start(controller) { if (first) controller.enqueue(first) },
    pull() { return new Promise(() => {}) },
    cancel() { released.push(`${path} cancelled`) },
  })
}

const encoded = (body: Uint8Array, encoding: string, extra: Record<string, string> = {}) =>
  new Response(body, { headers: { 'content-encoding': encoding, 'content-type': 'text/plain', ...extra } })

const server = Bun.serve({
  hostname: '127.0.0.1', port: 0, idleTimeout: 0,
  fetch(req) {
    const path = new URL(req.url).pathname
    hits[path] = (hits[path] ?? 0) + 1
    switch (path) {
      case '/__released': return Response.json(released)
      case '/__hits': return Response.json(hits)
      case '/identity': return new Response(PLAIN, { headers: { 'content-type': 'text/plain' } })
      case '/identity-named': return encoded(plain, 'identity')
      case '/gzip': return encoded(GZIP, 'gzip')
      case '/x-gzip': return encoded(GZIP, 'x-gzip')
      case '/gzip-spaced': return encoded(GZIP, '  GZip ')
      case '/deflate': return encoded(DEFLATE, 'deflate')
      case '/deflate-raw': return encoded(DEFLATE_RAW, 'deflate')
      case '/gzip-empty': return encoded(new Uint8Array(0), 'gzip')
      case '/gzip-multi': return encoded(MULTI, 'gzip')
      case '/br': return encoded(BR, 'br')
      case '/br-invalid': return encoded(BR_INVALID, 'br')
      case '/br-upper': return encoded(BR_INVALID, 'BR')
      case '/gzip-br': return encoded(BR_INVALID, 'gzip, br')
      case '/identity-gzip': return encoded(GZIP, 'identity, gzip')
      case '/zstd': return encoded(Buffer.from('not zstd at all'), 'zstd')
      case '/compress': return encoded(Buffer.from('not compress'), 'compress')
      case '/json-gzip': return encoded(gzipSync(Buffer.from(JSON.stringify({ ok: true, words: PLAIN.slice(0, 40) }))), 'gzip', { 'content-type': 'application/json' })
      case '/sse-gzip': return encoded(gzipSync(Buffer.from('data: {"n":1}\n\ndata: {"n":2}\n\n')), 'gzip', { 'content-type': 'text/event-stream' })
      case '/nocontent': return new Response(null, { status: 204, headers: { 'content-encoding': 'br' } })
      case '/redirect-gzip': return new Response(null, { status: 302, headers: { location: '/gzip' } })
      case '/redirect-br-body': return new Response(BR_INVALID, { status: 302, headers: { location: '/gzip', 'content-encoding': 'br' } })
      case '/headers': return Response.json(Object.fromEntries(req.headers))
      case '/br-held': return new Response(heldOpen(path, req, BR_INVALID), { headers: { 'content-encoding': 'br' } })
      case '/gzip-malformed-held': return new Response(heldOpen(path, req, GZIP_MALFORMED), { headers: { 'content-encoding': 'gzip' } })
      // a zlib header, then a deflate block of the reserved type 11: no inflater takes it
      case '/deflate-malformed-held': return new Response(heldOpen(path, req, new Uint8Array([0x78, 0x9c, 0xff, 0xff, 0xff, 0xff])), { headers: { 'content-encoding': 'deflate' } })
      // one byte (gzip's first magic byte) so the headers go out, then nothing: the client waits for its second byte
      case '/gzip-silent-held': return new Response(heldOpen(path, req, new Uint8Array([0x1f])), { headers: { 'content-encoding': 'gzip' } })
      case '/gzip-partial-held': return new Response(heldOpen(path, req, GZIP.subarray(0, Math.floor(GZIP.length / 2))), { headers: { 'content-encoding': 'gzip' } })
      default: return new Response('no such fixture', { status: 404 })
    }
  },
})

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64')
console.log(JSON.stringify({ port: server.port, plain: PLAIN, gzip: b64(GZIP), deflate: b64(DEFLATE), br: b64(BR), br_invalid: b64(BR_INVALID) }))
