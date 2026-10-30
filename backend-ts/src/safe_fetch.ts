/** The one door the backend's outbound HTTP goes through while the runtime's Brotli decoder carries CVE-2026-111497
 *  (an out-of-bounds write in google/brotli's decoder, fixed upstream by 0ed4268a). Verified affected: the Bun this
 *  was written against, 1.4.0 (revision 34cbb9a40), whose bundled Brotli lacks that fix; oven-sh/bun#46352 reports
 *  the same for every release through 1.4.3 (docs/brotli-cve-2026-111497.md). Bun's fetch decodes
 *  `Content-Encoding: br` natively, and does so as the response arrives — before the caller sees its headers, whether
 *  or not the body is ever read — so neither leaving `br` out of Accept-Encoding nor looking at the header afterwards
 *  keeps attacker bytes away from it.
 *
 *  What this does instead: every request is made with Bun's `decompress: false` in fetch's own second argument (a
 *  Request object's copy of the flag is dropped by Bun, and the flag is set last, so neither the caller's init nor its
 *  Request can turn native decoding back on). The body then arrives exactly as sent, and this module reads the
 *  Content-Encoding itself: none or `identity` is passed on as it came; exactly one of `gzip`, `x-gzip` or `deflate`
 *  (zlib-wrapped or raw, as Bun's own decoder takes it) is decoded here, streaming, by the zlib inflater; `br`
 *  anywhere in the header is refused, and so is any other coding or any list of codings — a ContentEncodingRefused
 *  error, the raw body cancelled, nothing of it decoded. A response that has no body to decode (HEAD, 1xx, 204, 205,
 *  304) is passed on as it came. The request asks for `gzip, deflate` only.
 *
 *  A caller that passes `decompress: false` gets the gzip / deflate bytes undecoded with their header (the raw
 *  option); Brotli and unknown codings are refused for it too. Bun only: under another runtime the flag would be
 *  ignored and that runtime's fetch would decode, so this refuses to run there. */

export const ACCEPT_ENCODING = 'gzip, deflate'
export const CVE = 'CVE-2026-111497'

/** fetch's init (Bun's own options — `tls`, `timeout`, `verbose`, … — ride along untouched), plus the raw option. */
export type SafeFetchInit = RequestInit & { decompress?: boolean }

/** A response whose Content-Encoding this client will not decode: Brotli (the decoder's flaw) or a coding it does
 *  not know. Nothing of the body was decoded; the raw body was cancelled. */
export class ContentEncodingRefused extends Error {
  readonly code = 'ERR_CONTENT_ENCODING_REFUSED'
  constructor(readonly encoding: string, readonly origin: string, readonly brotli: boolean) {
    super(brotli
      ? `the response from ${origin} is Content-Encoding: ${encoding}, refused before any of it was decoded: Brotli is not decoded while the runtime's Brotli decoder carries ${CVE} (only gzip and deflate were asked for)`
      : `the response from ${origin} is Content-Encoding: ${encoding}, which this client does not decode (it decodes gzip and deflate); refused undecoded`)
    this.name = 'ContentEncodingRefused'
  }
}

/** Statuses whose responses carry no body (and HEAD's never does): nothing to decode, nothing refused. */
const NO_BODY_STATUSES = new Set([101, 103, 204, 205, 304])
const DECODED = new Set(['gzip', 'x-gzip', 'deflate'])

/** Throws unless this is Bun: elsewhere `decompress: false` means nothing and the runtime's fetch decodes on its own. */
export function assertBunRuntime(versions: Record<string, string | undefined> = process.versions): void {
  if (!versions.bun) throw new Error(`safeFetch runs on Bun only: another runtime's fetch would decode the response itself (${CVE})`)
}

/** The codings a Content-Encoding header lists, lowercased and trimmed, empty entries left out. */
export function contentCodings(header: string | null): string[] {
  return (header ?? '').split(',').map((c) => c.trim().toLowerCase()).filter(Boolean)
}

/** What a Content-Encoding header asks of this client: pass the body on, decode it as gzip or deflate, or refuse it
 *  (Brotli or anything else). */
export function codingPlan(header: string | null): { kind: 'identity' } | { kind: 'decode'; coding: 'gzip' | 'deflate' } | { kind: 'refuse'; brotli: boolean } {
  const codings = contentCodings(header)
  if (codings.includes('br')) return { kind: 'refuse', brotli: true }
  if (codings.length === 0 || (codings.length === 1 && codings[0] === 'identity')) return { kind: 'identity' }
  if (codings.length === 1 && DECODED.has(codings[0]!)) return { kind: 'decode', coding: codings[0] === 'deflate' ? 'deflate' : 'gzip' }
  return { kind: 'refuse', brotli: false }
}

/** Whether two bytes open a zlib stream (RFC 1950: method 8, check bits): HTTP's `deflate` as it should be sent;
 *  anything else under that name is raw deflate (RFC 1951), which servers send too and Bun decodes as well. */
export function zlibHeader(b0: number, b1: number): boolean {
  return (b0 & 0x0f) === 8 && (b0 >> 4) <= 7 && ((b0 << 8) | b1) % 31 === 0
}

function concat(pieces: Uint8Array[], size: number): Uint8Array {
  if (pieces.length === 1) return pieces[0]!
  const out = new Uint8Array(size)
  let at = 0
  for (const p of pieces) { out.set(p, at); at += p.length }
  return out
}

/** The decoded stream of a gzip or deflate body: started by the first read (the response is handed on before any of
 *  its body is read, as fetch's own is), one piece out per read, the raw body's errors (an abort, a reset) passed on as
 *  they are. An empty body is an empty stream. Every way it ends lets the raw body go: a consumer's cancel (even while
 *  the first bytes are awaited: no inflater is made after it), the inflater's failure on bytes that are not gzip /
 *  deflate, or the raw body's own failure — the connection is never left held open behind an error already seen. */
export function inflating(raw: ReadableStream<Uint8Array>, coding: 'gzip' | 'deflate'): ReadableStream<Uint8Array> {
  const source = raw.getReader()
  let output: ReadableStreamDefaultReader<Uint8Array> | null = null
  let started = false
  let cancelled = false
  const dropSource = (reason: unknown) => { source.cancel(reason).catch(() => {}) }
  /** Reads the first bytes and makes the inflater (into `output`), or leaves `output` null for an empty body or a
   *  stream cancelled meanwhile. */
  const begin = async (): Promise<void> => {
    // deflate's first two bytes say zlib or raw; an empty body has nothing to inflate
    const head: Uint8Array[] = []
    let size = 0
    while (size < 2) {
      const piece = await source.read()
      if (cancelled) return
      if (piece.done) break
      if (piece.value.length) { head.push(piece.value); size += piece.value.length }
    }
    if (size === 0) return
    const first = concat(head, size)
    const format = coding === 'gzip' ? 'gzip' : size >= 2 && zlibHeader(first[0]!, first[1]!) ? 'deflate' : 'deflate-raw'
    const inflater = new DecompressionStream(format)
    const writer = inflater.writable.getWriter()
    // set before anything else can run, so a cancel from here on reaches it
    output = inflater.readable.getReader() as unknown as ReadableStreamDefaultReader<Uint8Array>
    void (async () => {
      try {
        await writer.write(first as Uint8Array<ArrayBuffer>)
        for (;;) {
          const piece = await source.read()
          if (piece.done) break
          await writer.write(piece.value as Uint8Array<ArrayBuffer>)
        }
        await writer.close()
      } catch (error) {
        // the inflater refused the bytes, the raw body failed, or the stream was cancelled: the decoded side ends with
        // that error (a reader waiting on it sees it) and the raw body is let go
        await writer.abort(error).catch(() => {})
        dropSource(error)
      }
    })()
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!started) { started = true; await begin() }
        if (cancelled) return
        if (output === null) { controller.close(); return }
        const piece = await output.read()
        if (cancelled) return
        if (piece.done) controller.close()
        else controller.enqueue(piece.value)
      } catch (error) {
        dropSource(error)
        throw error
      }
    },
    cancel(reason) {
      // nothing awaited: a peer that never answers cannot hold the canceller
      cancelled = true
      dropSource(reason)
      output?.cancel(reason).catch(() => {})
    },
  }, { highWaterMark: 0 })
}

/** A response's origin for an error message (never its path or query, which may carry what is not a log's). */
function originOf(url: string): string {
  try { return new URL(url).origin } catch { return 'the server' }
}

/** `response` as the caller may read it: as it came, decoded here, or refused (see the module's comment). */
export function screenResponse(response: Response, opts: { method?: string; raw?: boolean } = {}): Response {
  if ((opts.method ?? 'GET').toUpperCase() === 'HEAD' || NO_BODY_STATUSES.has(response.status) || response.body === null) return response
  const header = response.headers.get('content-encoding')
  const plan = codingPlan(header)
  if (plan.kind === 'identity') return response
  if (plan.kind === 'refuse') {
    // nothing was decoded (decompress: false); the bytes are dropped without waiting on the peer
    response.body.cancel().catch(() => {})
    const refusal = new ContentEncodingRefused(String(header).replace(/[^\x20-\x7e]/g, '?').slice(0, 100), originOf(response.url), plan.brotli)
    // a Brotli refusal is never silent, even where a caller treats the request as optional and swallows its error (a
    // site icon): one line with the origin only — no path, query, header, body or credential
    if (plan.brotli) console.warn(`${refusal.name}: ${CVE}: a Brotli-encoded response from ${refusal.origin} was refused undecoded`)
    throw refusal
  }
  if (opts.raw) return response
  const decoded = new Response(inflating(response.body, plan.coding), { status: response.status, statusText: response.statusText, headers: response.headers }) as unknown as Response
  return withMeta(decoded, response.url, response.redirected)
}

/** A constructed response that says where it came from as fetch's own does (its url, whether it was redirected),
 *  and keeps saying so when cloned. Configurable, as a caller may restate the url (web.ts pinnedFetch does). */
function withMeta(response: Response, url: string, redirected: boolean): Response {
  const clone = response.clone.bind(response) as () => Response
  Object.defineProperties(response, {
    url: { value: url, configurable: true },
    redirected: { value: redirected, configurable: true },
    clone: { value: () => withMeta(clone(), response.url, response.redirected), configurable: true },
  })
  return response
}

/** A fetch-shaped transport that hands its init on to Bun's own fetch unchanged (fetch itself, or a fetch captured
 *  before a wrapper took the global's place). */
export type NativeTransport = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/** One request through `transport`, its decoding off and the body's coding screened once (the module's comment). */
async function fetchThrough(transport: NativeTransport, input: string | URL | Request, init: SafeFetchInit): Promise<Response> {
  assertBunRuntime()
  const { decompress, ...rest } = init
  // init's headers replace a Request's, as fetch's do; without them the Request's own are kept
  const headers = new Headers(rest.headers !== undefined ? rest.headers : input instanceof Request ? input.headers : undefined)
  headers.set('accept-encoding', ACCEPT_ENCODING)
  const method = rest.method ?? (input instanceof Request ? input.method : 'GET')
  // decompress: false last, in fetch's own second argument: the only place Bun reads it, and nothing after it
  const response = await transport(input, { ...rest, headers, decompress: false } as RequestInit)
  return screenResponse(response, { method, raw: decompress === false })
}

/** fetch, with the runtime's own decoding off for every request and the body's coding screened here (the module's
 *  comment). The global fetch is read at each call. `init.decompress === false` asks for gzip / deflate bodies
 *  undecoded. */
export function safeFetch(input: string | URL | Request, init: SafeFetchInit = {}): Promise<Response> {
  return fetchThrough((i, o) => globalThis.fetch(i, o), input, init)
}

/** safeFetch over a transport the caller captured: for code that puts its own wrapper in the global fetch's place
 *  and must still reach Bun's fetch underneath (scripts/argon_probe.ts meters and budgets every request that way;
 *  safeFetch itself would read the wrapper and go round in it). The transport must hand its init on to Bun's fetch
 *  unchanged — `decompress: false` means nothing to anything else. Screened and decoded once, here. */
export function safeFetchVia(transport: NativeTransport): (input: string | URL | Request, init?: SafeFetchInit) => Promise<Response> {
  return (input, init = {}) => fetchThrough(transport, input, init)
}
