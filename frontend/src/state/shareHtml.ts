/** The offline session share's file (contract/src/share.ts): ONE self-contained HTML page that draws the app's own
 *  thread — the viewer bundle (src/share/viewer, built by vite.share.config.ts into one script and one stylesheet)
 *  carried inline, and the share's document (src/share/document.ts: the strict snapshot without its images' source
 *  bytes, the page's re-encoded pictures, the cosmetic faces and palette) carried as a JSON data block.
 *
 *  What the file is:
 *  - a Content-Security-Policy first in <head>: default/connect/object/frame/child/worker/media/manifest 'none',
 *    form-action 'none', base-uri 'none'; the one script and the one stylesheet allowed by their sha256 only (no
 *    'unsafe-inline', no 'unsafe-eval'); images `data:` only (the page's re-encoded rasters, the embedded bot stills
 *    and the bundle's own icons); fonts `data:` only (KaTeX's faces, embedded as woff2 — no external source exists);
 *  - the data block is `type="application/json"` (never executed, so outside script-src), every `<`, `>`, `&` and
 *    U+2028/2029 written as a JSON escape: no string of the snapshot can close the block or open markup;
 *  - the bundle carries no `</script`, no `<!--`, and the stylesheet no `</style` (the viewer build escapes them and
 *    this builder refuses one that did not);
 *  - the document passes checkShareDocument here, before it is written, as the viewer passes it again before it draws.
 *
 *  The builder takes no image source bytes (the snapshot's `images` must be empty) and nothing of the dialog's
 *  selection (real run ids). */

import { checkShareAnyDocument, type ShareAnyDocument } from '../share/document.ts'

/** One picture the page re-encoded (metadata dropped): what the file carries instead of the source bytes. */
export interface PreparedShareImage { dataUrl: string; width: number; height: number; bytes: number; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' }

/** What the page itself left out while building (images it could not decode/re-encode safely, or past its budget). */
export interface PageOmissions { images_rejected: number; images_over_page_budget: number }
export const NO_PAGE_OMISSIONS: PageOmissions = { images_rejected: 0, images_over_page_budget: 0 }

/** The viewer as the file carries it: its one script and its one stylesheet (share-viewer-dist/). */
export interface ViewerBundle { js: string; css: string }

// ---------------------------------------------------------------------------------------------------------------------
// sha256 (synchronous, so the CSP hash does not need crypto.subtle — absent on a plain-http remote page)

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

export function sha256(bytes: Uint8Array): Uint8Array {
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
  const bitLen = bytes.length * 8
  const total = Math.ceil((bytes.length + 9) / 64) * 64
  const buf = new Uint8Array(total)
  buf.set(bytes)
  buf[bytes.length] = 0x80
  const view = new DataView(buf.buffer)
  view.setUint32(total - 8, Math.floor(bitLen / 0x100000000))
  view.setUint32(total - 4, bitLen >>> 0)
  const w = new Uint32Array(64)
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4)
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]!, b = w[i - 2]!
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3)
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10)
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, hh] = [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!]
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))
      const ch = (e & f) ^ (~e & g)
      const t1 = (hh + S1 + ch + K[i]! + w[i]!) >>> 0
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) >>> 0
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0
    }
    h[0] = (h[0]! + a) >>> 0; h[1] = (h[1]! + b) >>> 0; h[2] = (h[2]! + c) >>> 0; h[3] = (h[3]! + d) >>> 0
    h[4] = (h[4]! + e) >>> 0; h[5] = (h[5]! + f) >>> 0; h[6] = (h[6]! + g) >>> 0; h[7] = (h[7]! + hh) >>> 0
  }
  const out = new Uint8Array(32)
  const ov = new DataView(out.buffer)
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, h[i]!)
  return out
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

/** The CSP source of an inline block: 'sha256-…' of its exact UTF-8 text. */
export const cspHash = (text: string): string => `'sha256-${bytesToBase64(sha256(new TextEncoder().encode(text)))}'`

// ---------------------------------------------------------------------------------------------------------------------
// text

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"'`]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : c === "'" ? '&#39;' : '&#96;'))
}


/** Every format character (zero-width, joiners, bidi controls, BOM, soft hyphen, tag characters), line/paragraph
 *  separators and controls: what a title, a file name or a search key never keeps. (Prose keeps the backend's
 *  treatment, which preserves legitimate emoji and script joiners.) */
const INVISIBLE = /[\p{Cf}\p{Cc}\u2028\u2029\u115F\u1160\u3164\uFFA0\u034F\u17B4\u17B5\u180B-\u180F\uFE00-\uFE0F\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu

/** A title as the page shows it: NFKC, invisible characters gone, whitespace collapsed, at most 200 characters. */
export function cleanTitle(raw: string): string {
  const t = raw.normalize('NFKC').replace(INVISIBLE, '').replace(/\s+/gu, ' ').trim()
  const cps = Array.from(t)
  return (cps.length > 200 ? `${cps.slice(0, 199).join('').trimEnd()}…` : t) || 'Session'
}

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i

/** The download's name, from the cleaned title only: no invisible character, no path separator or character a file
 *  system refuses, no leading dot, at most 80 characters before `.html`. */
export function shareFileName(title: string): string {
  let base = cleanTitle(title)
    .replace(/[\\/:*?"<>|#%{}^~[\]`'$&@!=+;,]/gu, ' ')
    .replace(/\.{2,}/g, ' ')
    .replace(/\s+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  base = Array.from(base).slice(0, 80).join('').replace(/[-.]+$/g, '')
  if (!base || base === 'Session' || /^\.+$/.test(base)) base = 'session'
  if (RESERVED.test(base)) base = `session-${base}`
  return `${base}.html`
}

/** An ISO time as UTC `YYYY-MM-DD HH:MM UTC` (no locale: the same bytes wherever it is built). */
export function fmtTime(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

// ---------------------------------------------------------------------------------------------------------------------
// the file

/** The bundle's text checked for what would end its inline element early (the viewer build escapes these already). */
export function checkViewerBundle(bundle: ViewerBundle): ViewerBundle {
  if (!bundle.js || !bundle.css) throw new Error('the viewer bundle is missing (npm run build:share)')
  if (/<\/script|<!--/i.test(bundle.js)) throw new Error('the viewer script holds a sequence that would end its element')
  if (/<\/style/i.test(bundle.css)) throw new Error('the viewer stylesheet holds a sequence that would end its element')
  return bundle
}

/** JSON for a data block: no `<`, `>`, `&` or line/paragraph separator stays a character of the HTML text. */
export function dataBlockJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

/** The page's Content-Security-Policy for this bundle. */
export function shareCsp(bundle: ViewerBundle): string {
  return [
    "default-src 'none'", `script-src ${cspHash(bundle.js)}`, `style-src ${cspHash(bundle.css)}`, 'img-src data:', 'font-src data:', "connect-src 'none'",
    "object-src 'none'", "frame-src 'none'", "child-src 'none'", "worker-src 'none'", "media-src 'none'", "manifest-src 'none'",
    "form-action 'none'", "base-uri 'none'",
  ].join('; ')
}

/** The whole file. */
export function buildShareHtml(doc: ShareAnyDocument, viewer: ViewerBundle): string {
  const checked = checkShareAnyDocument(doc)
  const bundle = checkViewerBundle(viewer)
  const title = cleanTitle(checked.snapshot.title)
  return '<!doctype html>\n'
    + `<html lang="en" data-theme="${checked.theme}"><head><meta charset="utf-8">`
    + `<meta http-equiv="Content-Security-Policy" content="${shareCsp(bundle)}">`
    + '<meta name="referrer" content="no-referrer"><meta http-equiv="x-dns-prefetch-control" content="off">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="generator" content="oasis-code session share v2">'
    + `<title>${escapeHtml(title)}</title><style>${bundle.css}</style></head>`
    + '<body><div id="root"><noscript>This file draws the session with its own script; open it in a browser with scripts on.</noscript></div>'
    + `<script type="application/json" id="share-data">${dataBlockJson(checked)}</script>`
    + `<script>${bundle.js}</script></body></html>\n`
}
