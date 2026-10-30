/** The part of an answer still being written that a live share may show (docs/live-session-share.md §streaming).
 *
 *  The sanitizer reads whole texts: a secret is recognised by what surrounds it (`password: …` to the line's end, a
 *  quoted value to its closing quote, a private key block to its END line, a token of a known shape once all of it is
 *  there). A text cut in the middle of a word would show the start of a secret the rule has not matched yet. So:
 *
 *  1. Only COMPLETED lines are candidates (up to the last newline); the line being written is never shown.
 *  2. A structure that can carry a secret over several lines and is not closed yet withholds everything from the line it
 *     opened on: a private key block (BEGIN without its END), a PuTTY key file (without its Private-MAC line), a triple
 *     quoted literal, a YAML block scalar under a secret-named key whose indented block reaches the end so far.
 *  3. The candidate, sanitized on its own, must be exactly how the sanitized whole text so far begins (the unfinished
 *     tail included). When it is not — a rule reads differently with the tail — the candidate steps back a line at a
 *     time; past a bound, nothing of the open answer is shown.
 *
 *  What this returns is RAW text: the projector sanitizes it with its own sanitizer, as every other string. The checks
 *  here use throwaway sanitizers of the same context (so their counts are not the snapshot's). */

import { secretKey, ShareSanitizer, type SanitizerContext } from '../sanitize.ts'

const PRIVATE_BEGIN = /-----BEGIN[ A-Z0-9]*PRIVATE KEY(?: BLOCK)?-----/g
const PRIVATE_END = /-----END[ A-Z0-9]*PRIVATE KEY(?: BLOCK)?-----/
const PUTTY_BEGIN = /PuTTY-User-Key-File-\d+:/g
const PUTTY_END = /Private-MAC:[^\r\n]*\r?\n/
const TRIPLE = /"""|'''/g
const BLOCK_SCALAR = /^([ \t]*)(?:-[ \t]+)?(["'`]?)([A-Za-z0-9_.-]{1,128})\2[ \t]*:[ \t]*[|>][+-]?[0-9]?[+-]?[ \t]*(?:#.*)?$/
/** how many lines the consistency check steps back before it shows nothing */
const MAX_STEPS = 64

const lineStart = (t: string, i: number): number => t.lastIndexOf('\n', i - 1) + 1

/** Where the shown text must end at the latest because a multi-line structure opened before it is not closed yet. */
export function unclosedFrom(text: string): number {
  let cut = text.length
  for (const m of text.matchAll(PRIVATE_BEGIN)) {
    if (!PRIVATE_END.test(text.slice(m.index + m[0].length))) { cut = Math.min(cut, lineStart(text, m.index)); break }
  }
  for (const m of text.matchAll(PUTTY_BEGIN)) {
    if (!PUTTY_END.test(text.slice(m.index))) { cut = Math.min(cut, lineStart(text, m.index)); break }
  }
  let open: { delim: string; at: number } | null = null
  for (const m of text.matchAll(TRIPLE)) {
    if (open === null) open = { delim: m[0], at: m.index }
    else if (m[0] === open.delim) open = null
  }
  if (open !== null) cut = Math.min(cut, lineStart(text, open.at))
  // a block scalar of a secret-named key whose block has not ended (every later line blank or indented past the key)
  const lines = text.split('\n')
  let offset = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/\r$/, '')
    const m = BLOCK_SCALAR.exec(line)
    if (m !== null && secretKey(m[3]!)) {
      const indent = m[1]!.length
      let closed = false
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j]!.replace(/\r$/, '')
        if (next.trim() !== '' && next.length - next.trimStart().length <= indent) { closed = true; break }
      }
      if (!closed) { cut = Math.min(cut, offset); break }
    }
    offset += lines[i]!.length + 1
  }
  return cut
}

/** The raw prefix of `raw` (an answer being written) that may be shown now; '' when none. */
export function stableOpenText(raw: string, ctx: SanitizerContext): string {
  let end = raw.lastIndexOf('\n') + 1
  if (end <= 0) return ''
  end = Math.min(end, unclosedFrom(raw.slice(0, end)))
  if (end <= 0) return ''
  const whole = new ShareSanitizer(ctx).text(raw)
  for (let step = 0; end > 0 && step < MAX_STEPS; step++) {
    const shown = new ShareSanitizer(ctx).text(raw.slice(0, end))
    if (whole.startsWith(shown)) return raw.slice(0, end)
    end = end >= 2 ? raw.lastIndexOf('\n', end - 2) + 1 : 0
  }
  return ''
}
