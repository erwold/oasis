/** The client half of test_safe_fetch's process-level check, run as its own process (with the suite's preload, so
 *  its network is the loopback only) against the fixture server in another process. Its stdout is one JSON line of
 *  outcomes; its stderr is the test's evidence: Bun's HTTP client writes "Decompression error: …" there from native
 *  code when its own decoder rejects a body, which the `native-control` mode shows happening for the same bytes.
 *
 *  argv: <mode: safe | native-control> <base url of the fixture server> */

import { pinnedFetch } from '../src/agent/tools/web.ts'
import { postJson } from '../src/llm/http.ts'
import { safeFetch } from '../src/safe_fetch.ts'

const [mode, base] = process.argv.slice(2) as [string, string]
const out: Record<string, unknown> = { mode }

async function outcome(name: string, run: () => Promise<Response>): Promise<void> {
  try {
    const response = await run()
    const bytes = new Uint8Array(await response.arrayBuffer())
    out[name] = { ok: true, status: response.status, bytes: bytes.length }
  } catch (error) {
    out[name] = { ok: false, name: (error as Error).name, code: (error as { code?: unknown }).code ?? null, brotli: (error as { brotli?: unknown }).brotli ?? null }
  }
}

if (mode === 'native-control') {
  // the same bytes through fetch's own decoding: the positive control for the stderr evidence
  await outcome('native_br_invalid', () => fetch(`${base}/br-invalid`))
} else {
  await outcome('br_invalid', () => safeFetch(`${base}/br-invalid`))
  await outcome('br_valid', () => safeFetch(`${base}/br`))
  await outcome('br_upper', () => safeFetch(`${base}/br-upper`))
  await outcome('gzip_br', () => safeFetch(`${base}/gzip-br`))
  await outcome('redirect_br_body_manual', () => safeFetch(`${base}/redirect-br-body`, { redirect: 'manual' }))
  await outcome('redirect_br_body_follow', () => safeFetch(`${base}/redirect-br-body`))
  await outcome('caller_decompress_true', () => safeFetch(`${base}/br-invalid`, { decompress: true }))
  await outcome('request_decompress_true', () => safeFetch(new Request(`${base}/br-invalid`, { decompress: true } as RequestInit)))
  await outcome('raw_option_br', () => safeFetch(`${base}/br-invalid`, { decompress: false }))
  await outcome('br_held_open', () => safeFetch(`${base}/br-held`))
  // representative product paths, callers unchanged: fetch_url's pinned transport and the providers' POST
  const port = new URL(base).port
  await outcome('pinned_fetch', () => pinnedFetch(`http://fixture.example.test:${port}/br-invalid`, { address: '127.0.0.1' }))
  await outcome('post_json', () => postJson(`${base}/br-invalid`, {}, {}, 'fixture-model', { maxRetries: 0 }))
}
// what the HTTP client thread writes reaches stderr before this process exits
await Bun.sleep(200)
console.log(JSON.stringify(out))
process.exit(0)
