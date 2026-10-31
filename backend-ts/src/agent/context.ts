import { isFilePiece, isRefPiece } from '../llm/attachments.ts'
import type { FilePiece, RefFilePiece } from '@oasis-code/contract'
/** Token accounting for the working context: tiktoken's o200k_base as a cross-provider estimate (the provider's
 *  own count comes back in usage and is what the records keep and the keeper anchors on), the route's window and
 *  where the figure comes from, and the compaction threshold. The byte-pair merge is quadratic in a piece's
 *  length, so a piece longer than LONG_PIECE (a run of one character, a hash, a base64 blob) is sampled and
 *  extrapolated: an estimate for sizing, never a per-request token count. */

import { getEncoding, type Tiktoken } from 'js-tiktoken'
import { env, type ModelConfig } from '../config.ts'
import { isImagePiece, returnHasImage } from '../llm/images.ts'
import { isRequest, isToolReturn, isUserPrompt, type ModelMessage } from '../llm/messages.ts'

let encoder: Tiktoken | null | undefined
const LONG_PIECE = 128
const SAMPLE = 64
const CHUNK_CHARS = 4000
const PIECES = /\S+|\s+/g

export function encoderOrNull(): Tiktoken | null {
  if (encoder === undefined) {
    try { encoder = getEncoding('o200k_base') } catch { encoder = null }
  }
  return encoder
}

export function countTokens(text: string): number {
  const enc = encoderOrNull()
  if (enc === null) return Math.max(1, Math.floor(Buffer.byteLength(text, 'utf8') / 4))
  let total = 0
  let buffer = ''
  const flush = () => {
    if (buffer) total += enc.encode(buffer, [], []).length
    buffer = ''
  }
  for (const piece of text.match(PIECES) ?? []) {
    if (piece.length > LONG_PIECE) {
      flush()
      const sampled = enc.encode(piece.slice(0, SAMPLE), [], []).length
      total += Math.ceil((sampled * piece.length) / SAMPLE)
      continue
    }
    buffer += piece
    if (buffer.length > CHUNK_CHARS) flush()
  }
  flush()
  return total
}

/** The record of the messages with each request's `instructions` cleared (the provider receives them once while
 *  the record repeats them on every request). */
export function strippedRecord(messages: ModelMessage[]): string {
  const stripped = messages.map((m) => (isRequest(m) && m.instructions ? { ...m, instructions: null } : m))
  return JSON.stringify(stripped)
}

/** What a file piece adds to the estimate beyond its reference's JSON (which the record's text already counts): a
 *  conservative byte-based planning reserve, not a provider token count or a page / duration guarantee. */
export type FileCost = (piece: FilePiece | RefFilePiece) => number

/** The reserve of a file whose bytes travel: its UTF-8 text whole, else a share of its bytes (a legacy native file). */
export function legacyFileCost(piece: FilePiece): number {
  return piece.file_kind === 'text' ? piece.bytes : Math.max(16_000, Math.ceil(piece.bytes / 16))
}

/** The most one natively sent reference is reserved for before the provider has counted a request that carried it
 *  (the keeper anchors on that count afterwards); never a limit on what is sent. */
export const NATIVE_REF_RESERVE_TOKENS = 200_000

/** The reserve of a reference whose bytes this route takes: a share of its bytes, at most NATIVE_REF_RESERVE_TOKENS. */
export function nativeRefCost(piece: RefFilePiece): number {
  return Math.min(NATIVE_REF_RESERVE_TOKENS, Math.max(16_000, Math.ceil(piece.bytes / 16)))
}

/** Without a route: a legacy file as it always was; a reference is its note (its JSON, already counted) — the size of
 *  a file the request does not carry is never counted as tokens. A route that takes a reference natively passes its
 *  own cost (the keeper's `file_cost`). */
export const defaultFileCost: FileCost = (piece) => (isRefPiece(piece) ? 0 : legacyFileCost(piece))

/** A part's text as a request carries it: a tool call's name and arguments, a tool return's name and content, a
 *  prompt's or a response's words (a file or an image piece is costed apart). */
function partText(part: { part_kind: string; tool_name?: unknown; content?: unknown; args?: unknown }): string {
  const name = typeof part.tool_name === 'string' ? `${part.tool_name}\n` : ''
  if (part.part_kind === 'tool-call') return name + (typeof part.args === 'string' ? part.args : JSON.stringify(part.args ?? null))
  const content = part.content ?? ''
  if (Array.isArray(content)) return name + content.filter((c): c is string => typeof c === 'string').join('\n')
  return name + (typeof content === 'string' ? content : JSON.stringify(content))
}

/** Every part's text as the requests carry it, as one text: not the record's JSON, whose ids, timestamps, usage and
 *  escaping the provider never receives (on a long tool-heavy record that JSON counts about twice the wire). */
export function wireText(messages: ModelMessage[]): string {
  return messages.flatMap((m) => m.parts.map((p) => partText(p as never))).join('\n')
}

/** Tokens of the messages' text as the requests carry it (the instructions apart), with the files' reserve. */
export function estimateMessages(messages: ModelMessage[], fileCost: FileCost = defaultFileCost): number {
  let raw: string
  try { raw = wireText(messages) } catch { raw = JSON.stringify(messages.map((m) => String(m))) }
  let files = 0
  for (const m of messages) if (isRequest(m)) for (const p of m.parts) {
    if (isUserPrompt(p) && Array.isArray(p.content)) for (const v of p.content) if (isFilePiece(v) || isRefPiece(v)) files += fileCost(v)
  }
  return countTokens(raw) + files
}

/** What an image costs a provider that takes it, which its reference's JSON does not show. */
export const IMAGE_TOKENS = 1_600

/** How many images the messages carry: in the person's words, or in a tool's return. */
export function imageCount(messages: ModelMessage[]): number {
  let n = 0
  for (const m of messages) {
    if (!isRequest(m)) continue
    for (const p of m.parts) {
      if (isUserPrompt(p) && Array.isArray(p.content)) n += p.content.filter(isImagePiece).length
      else if (isToolReturn(p) && returnHasImage(p.content)) n += Object.values(p.content).filter(isImagePiece).length
    }
  }
  return n
}

// ---- the window and the threshold ---------------------------------------------------------------------------

/** A provider's tokenizer counts more on the same text than o200k_base does on its JSON: what an estimate is
 *  scaled by before it is compared with the window. */
export const ESTIMATE_FACTOR = 1.3
/** Tokens kept free under the window beyond the output reserve: the estimate's error and the provider's own framing. */
export const CONTEXT_MARGIN = 8_000
/** The share of the window a request may fill before the conversation is compacted. */
export const WINDOW_SHARE = 0.97

export interface WindowResolution {
  window: number
  source: string
  /** false when the figure is the configured fallback, not a figure of the route's */
  known: boolean
}

/** The route's context window and where the figure comes from, in order of trust: the OASIS_CODE_CONTEXT_WINDOW_TOKENS
 *  override, the route's configured window (with its own source), else the configured fallback (said as assumed). */
export function resolveWindow(cfg: ModelConfig, fallback: number): WindowResolution {
  const override = env('CONTEXT_WINDOW_TOKENS')
  if (override) {
    const n = Number.parseInt(override, 10)
    if (Number.isFinite(n) && n > 0) return { window: n, source: 'OASIS_CODE_CONTEXT_WINDOW_TOKENS', known: true }
  }
  if (cfg.context_window) return { window: cfg.context_window, source: `configured (${cfg.window_source})`, known: true }
  return { window: fallback, source: `assumed ${fallback.toLocaleString('en-US')} tokens (the route's window is not configured)`, known: false }
}

/** The input size at which the conversation is compacted: WINDOW_SHARE of the window, and never closer to it than
 *  the output reserve plus the margin. */
export function compactionThreshold(window: number, outputReserve: number): number {
  return Math.max(1, Math.min(Math.floor(window * WINDOW_SHARE), window - outputReserve - CONTEXT_MARGIN))
}

export const CONTEXT_ERROR_MARKERS = ['context_length', 'context window', 'maximum context', 'too many tokens', 'prompt is too long', 'exceeds the model', 'input length', 'too long']

/** Whether a provider's refusal is about the request's size. */
export function isContextError(error: unknown): boolean {
  const rawCode = (error as { provider_code?: unknown })?.provider_code
  const code = typeof rawCode === 'string' ? rawCode.toLowerCase() : null
  // Codex's official client names context_length_exceeded. Accept the context_window spelling too;
  // only absent/generic request codes fall back to words. A server/rate/auth code must not become an
  // overflow because its message says "request took too long" or mentions context/token limits.
  if (code && code !== 'invalid_request_error' && code !== 'invalid_prompt') {
    return code === 'context_length_exceeded' || code === 'context_window_exceeded'
  }
  const text = String((error as { message?: string })?.message ?? error).toLowerCase()
  return CONTEXT_ERROR_MARKERS.some((marker) => text.includes(marker))
}
