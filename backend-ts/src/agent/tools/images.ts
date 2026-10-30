/** generate_image: an image made, or images of this conversation edited, by the ChatGPT subscription's own image
 *  endpoints — the Codex backend's /images/generations and /images/edits (what the Codex CLI's built-in image tool
 *  calls), signed with the person's Codex sign-in for exactly those two paths (auth/models.ts codexImageSigner).
 *
 *  One request a call: no retry, no other route (no Responses tool, no API key). The session's network gate (and an
 *  order's) is checked before anything is read; the references are this session's own image attachments (by asset id,
 *  or the latest ones in the conversation), never a path or a URL; the credentials are read last. The answer is held
 *  to one image whose bytes are an image (a URL in it is never fetched), kept as the session's attachment and measured
 *  from its bytes — the service picks its own size, and does not say which model made it, so the model is told what
 *  was asked, not what was used. Nothing of the token or the image bytes reaches the thread's events. */

import { z, type ImageAttachment } from '@oasis-code/contract'
import { ATTACHMENT_ROLE, saveAttachment } from '../../api/attachments.ts'
import { NativeAuthError } from '../../auth/errors.ts'
import { CODEX_BASE_URL, CODEX_CLIENT_VERSION, CODEX_ORIGINATOR, codexImageSigner, type GrantSource } from '../../auth/models.ts'
import { tokenManager } from '../../auth/store.ts'
import * as repo from '../../db/repo.ts'
import { assetAttachment, attachmentReader } from '../../llm/attachments.ts'
import type { FetchLike } from '../../llm/http.ts'
import { EXTENSIONS, ImageRefused, imageToolPiece, isImagePiece, MAX_IMAGE_BYTES, measureImage } from '../../llm/images.ts'
import { isRequest, isToolReturn, isUserPrompt, type ModelMessage } from '../../llm/messages.ts'
import { redactSecrets } from '../../llm/redact.ts'
import { PROMPT_TEXT } from '../../prompt_texts.ts'
import { ContentEncodingRefused, safeFetch } from '../../safe_fetch.ts'
import { cacheKeyOf } from '../runner.ts'
import { finish, refused, type Ctx, type Payload } from './common.ts'
import { register } from './registry.ts'
import { networkRefusal } from './web.ts'

const TOOL = 'generate_image'
/** What the Codex CLI's image tool asks for (codex-rs ext/image-generation IMAGE_MODEL); the service does not echo
 *  the model it used. */
export const IMAGE_MODEL = 'gpt-image-2'
export const DEFAULT_SIZE = '1024x640'
export const DEFAULT_QUALITY = 'low'
export const MAX_REFERENCES = 5
/** The answer read at most this far (one image of the attachment limit, base64, with its JSON around it). */
export const MAX_IMAGE_RESPONSE_BYTES = 12 * 1024 * 1024
const MAX_B64 = Math.ceil(MAX_IMAGE_BYTES / 3) * 4
const ASSET_ID = /^[A-Za-z0-9_-]{1,128}$/

/** Tests and a live bootstrap swap these: the transport, the read-only source of the grant, the time limit. */
export const hooks: { fetchImpl: FetchLike; grants: GrantSource | null; timeoutMs: number } = {
  fetchImpl: (input, init) => safeFetch(input, init), grants: null, timeoutMs: 300_000,
}
const DEFAULTS = { ...hooks }
export function setImageHooks(partial: Partial<typeof hooks>): void { Object.assign(hooks, partial) }
export function resetImageHooks(): void { Object.assign(hooks, DEFAULTS) }

/** gpt-image-2's sizes (as the Codex CLI's image skill states them): auto, or WxH in multiples of 16, an edge at most
 *  3840, a ratio at most 3:1, 655,360 to 8,294,400 pixels. Null when allowed. */
export function sizeRefusal(size: string): string | null {
  if (size === 'auto') return null
  const m = /^(\d{2,4})x(\d{2,4})$/.exec(size)
  if (!m) return `size is auto or WIDTHxHEIGHT, not '${size.slice(0, 40)}'`
  const [w, h] = [Number(m[1]), Number(m[2])]
  if (w % 16 || h % 16) return `size ${size}: both sides must be multiples of 16`
  if (Math.max(w, h) > 3840) return `size ${size}: a side is at most 3840`
  if (Math.max(w, h) > 3 * Math.min(w, h)) return `size ${size}: the aspect ratio is at most 3:1`
  if (w * h < 655_360 || w * h > 8_294_400) return `size ${size}: the image has 655,360 to 8,294,400 pixels`
  return null
}

interface Args {
  prompt: string; reference_images: string[] | null; recent_images: number | null
  transparent_background: boolean; size: string | null; quality: 'low' | 'medium' | 'high' | 'auto' | null
}

interface Reference { attachment: ImageAttachment; bytes: Uint8Array }

/** One of this session's image attachments with its bytes, checked against its record; null for anything else. */
function sessionImage(ctx: Ctx, id: string): Reference | null {
  const deps = ctx.deps
  const asset = repo.getAsset(deps.conn, id)
  if (!asset || asset.kind !== 'image' || asset.project_id !== deps.session.project_id || asset.meta.role !== ATTACHMENT_ROLE || asset.meta.session_id !== deps.session.id) return null
  let attachment
  try { attachment = assetAttachment(asset) } catch { return null }
  if ('file_kind' in attachment || 'representation' in attachment) return null
  const bytes = attachmentReader((a) => repo.getAsset(deps.conn, a), (p) => deps.store.read(p), deps.session.project_id, deps.session.id)(attachment)
  return bytes === null ? null : { attachment: attachment as ImageAttachment, bytes }
}

/** The asset ids of the images in the conversation, newest first, each once: the person's attachments and the
 *  images generate_image made — never another tool's (a screenshot, an image file read), which the model names by
 *  asset id when it means one. */
export function recentImageIds(messages: readonly ModelMessage[]): string[] {
  const out: string[] = []
  const add = (id: unknown) => { if (typeof id === 'string' && !out.includes(id)) out.push(id) }
  for (const message of [...messages].reverse()) {
    if (!isRequest(message)) continue
    for (const part of [...message.parts].reverse()) {
      if (isUserPrompt(part) && Array.isArray(part.content)) {
        for (const piece of [...part.content].reverse()) if (isImagePiece(piece)) add(piece.asset_id)
      } else if (isToolReturn(part) && part.tool_name === TOOL && part.content && typeof part.content === 'object' && !Array.isArray(part.content)) {
        const content = part.content as Record<string, unknown>
        if (content.status === 'ok') add(content.asset_id)
      }
    }
  }
  return out
}

/** The references the call names, or the refusal. */
function resolveReferences(ctx: Ctx, args: Args): Reference[] | string {
  let ids: string[] = []
  if (args.recent_images !== null) {
    const recent = recentImageIds(ctx.messages ?? [])
    if (recent.length < args.recent_images) return `recent_images ${args.recent_images}: this conversation has ${recent.length} image${recent.length === 1 ? '' : 's'}`
    ids = recent.slice(0, args.recent_images).reverse()
  } else if (args.reference_images !== null) ids = args.reference_images
  const refs: Reference[] = []
  for (const id of ids) {
    const ref = sessionImage(ctx, id)
    if (ref === null) return `no image ${id} in this conversation`
    refs.push(ref)
  }
  return refs
}

/** The call's own checks, before the gate: nothing read, nothing asked. */
function argumentRefusal(args: Args, size: string): string | null {
  if (!args.prompt.trim()) return 'prompt is empty'
  if (args.reference_images !== null && args.recent_images !== null) return 'give reference_images or recent_images, not both'
  if (args.reference_images !== null) {
    if (args.reference_images.length < 1 || args.reference_images.length > MAX_REFERENCES) return `reference_images takes 1 to ${MAX_REFERENCES} asset ids`
    if (args.reference_images.some((id) => !ASSET_ID.test(id))) return 'reference_images takes asset ids of images in this conversation, not paths or URLs'
    if (new Set(args.reference_images).size !== args.reference_images.length) return 'an asset id is named twice'
  }
  if (args.recent_images !== null && (!Number.isInteger(args.recent_images) || args.recent_images < 1 || args.recent_images > MAX_REFERENCES)) return `recent_images is 1 to ${MAX_REFERENCES}`
  return sizeRefusal(size)
}

/** A failed request, as the model reads it: what happened, said once; never retried. */
function failure(ctx: Ctx, reason: string, extra: Record<string, unknown> = {}): Payload {
  const payload = { status: 'error', reason: redactSecrets(reason).slice(0, 500), ...extra, retried: false }
  return finish(ctx, TOOL, payload, { summary: payload.reason.slice(0, 200), ...('http_status' in extra ? { http_status: extra.http_status } : {}) })
}

/** The body read up to the bound (the rest not read), or null past it. */
async function boundedBody(response: Response, limit: number): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get('content-length') ?? NaN)
  if (Number.isFinite(declared) && declared > limit) { await response.body?.cancel().catch(() => {}); return null }
  const reader = response.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) break
    size += chunk.value.length
    if (size > limit) { await reader.cancel().catch(() => {}); return null }
    chunks.push(chunk.value)
  }
  const out = new Uint8Array(size)
  let at = 0
  for (const c of chunks) { out.set(c, at); at += c.length }
  return out
}

/** Seconds from a Retry-After header (seconds, or an HTTP date), or null. */
function retryAfter(value: string | null): number | null {
  if (!value) return null
  if (/^\d{1,7}$/.test(value.trim())) return Number(value.trim())
  const at = Date.parse(value)
  return Number.isFinite(at) ? Math.max(0, Math.round((at - Date.now()) / 1000)) : null
}

/** The error kinds the image service is known to name (the Codex CLI's usage-limit mapping, the Images API's
 *  errors): only one of these is repeated; the service's own words are not (they may echo what was sent). */
const ERROR_KINDS = new Set(['usage_limit_reached', 'usage_not_included', 'rate_limit_exceeded', 'insufficient_quota', 'invalid_request_error',
  'content_policy_violation', 'moderation_blocked', 'image_generation_user_error', 'server_error', 'invalid_api_key', 'unauthorized'])

function errorFields(status: number, headers: Headers, text: string): { reason: string; extra: Record<string, unknown> } {
  let kind: string | null = null
  let resets: number | null = null
  try {
    const error = (JSON.parse(text) as { error?: Record<string, unknown> }).error
    if (error && typeof error === 'object') {
      for (const key of ['type', 'code'] as const) if (kind === null && typeof error[key] === 'string' && ERROR_KINDS.has(error[key] as string)) kind = error[key] as string
      if (typeof error.resets_at === 'number' && Number.isSafeInteger(Math.trunc(error.resets_at)) && error.resets_at > 0) resets = Math.trunc(error.resets_at)
      else if (typeof error.resets_in_seconds === 'number' && Number.isFinite(error.resets_in_seconds) && error.resets_in_seconds >= 0) resets = Math.trunc(Date.now() / 1000 + error.resets_in_seconds)
    }
  } catch { kind = null }
  const extra: Record<string, unknown> = { http_status: status }
  if (kind !== null) extra.error_type = kind
  const after = retryAfter(headers.get('retry-after'))
  if (after !== null) extra.retry_after_s = after
  if (resets !== null) extra.resets_at = resets
  const named = kind ? ` (${kind})` : ''
  const reason = status === 429 ? `the image service refused the request: HTTP 429, a usage or rate limit${named}; not retried`
    : `the image service answered HTTP ${status}${named}; not retried`
  return { reason, extra }
}

/** The one image of the answer, or why there is none (a URL is not followed). */
function imageOf(body: Uint8Array): { bytes: Uint8Array; reported: Record<string, unknown> } | string {
  let data: unknown
  try { data = JSON.parse(new TextDecoder().decode(body)) } catch { return 'the image service answered with something that is not JSON' }
  const items = data && typeof data === 'object' ? (data as { data?: unknown }).data : undefined
  if (!Array.isArray(items) || items.length === 0) return 'the image service returned no image'
  if (items.length !== 1) return `the image service returned ${items.length} images where one was asked for; none was kept`
  const item = items[0] as Record<string, unknown>
  const b64 = item?.b64_json
  if (typeof b64 !== 'string' || !b64) return typeof item?.url === 'string' ? 'the image service returned a link instead of image data; it was not fetched' : 'the image service returned no image data'
  if (b64.length > MAX_B64) return `the returned image is over the ${MAX_IMAGE_BYTES / 1024 / 1024} MB limit`
  if (b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return 'the returned image data is not valid base64'
  // what the service says it made, only where it is one of the known values (nothing it wrote is repeated otherwise)
  const reported: Record<string, unknown> = {}
  const top = data as Record<string, unknown>
  const known: Record<string, (v: string) => boolean> = {
    size: (v) => v === 'auto' || /^[1-9]\d{1,4}x[1-9]\d{1,4}$/.test(v), quality: (v) => ['low', 'medium', 'high', 'auto'].includes(v),
    background: (v) => ['opaque', 'transparent', 'auto'].includes(v), output_format: (v) => ['png', 'jpeg', 'webp'].includes(v),
  }
  for (const [key, ok] of Object.entries(known)) if (typeof top[key] === 'string' && ok(top[key] as string)) reported[key] = top[key]
  return { bytes: new Uint8Array(Buffer.from(b64, 'base64')), reported }
}

export async function generateImage(ctx: Ctx, args: Args): Promise<Payload> {
  const deps = ctx.deps
  const size = args.size ?? DEFAULT_SIZE
  const quality = args.quality ?? DEFAULT_QUALITY
  const refusedArgs = argumentRefusal(args, size)
  if (refusedArgs !== null) return refused(ctx, TOOL, refusedArgs)
  const prompt = args.prompt.trim()
  const editing = args.reference_images !== null || args.recent_images !== null
  // the gate first: a session or an order without network refuses before anything is read
  const blocked = networkRefusal(ctx, TOOL, { operation: editing ? 'edit' : 'generate', prompt: prompt.slice(0, 200) })
  if (blocked !== null) return blocked
  const refs = editing ? resolveReferences(ctx, args) : []
  if (typeof refs === 'string') return refused(ctx, TOOL, refs)
  const background = args.transparent_background ? 'transparent' : 'opaque'
  const body: Record<string, unknown> = { prompt, model: IMAGE_MODEL, n: 1, size, quality, background }
  if (refs.length) body.images = refs.map((r) => ({ image_url: `data:${r.attachment.media_type};base64,${Buffer.from(r.bytes).toString('base64')}` }))
  const url = new URL(`${CODEX_BASE_URL}/images/${refs.length ? 'edits' : 'generations'}`)
  const thread = cacheKeyOf(deps.session.id)
  const headers = new Headers({
    'content-type': 'application/json', accept: 'application/json', originator: CODEX_ORIGINATOR, version: CODEX_CLIENT_VERSION,
    'user-agent': 'oasis-code/native-auth', 'session-id': thread, 'thread-id': thread, 'x-client-request-id': thread, 'x-codex-image-turn-id': deps.run_id,
  })
  const text = JSON.stringify(body)
  // the credentials last, read through the grant source (a refresh is the token manager's; a test's source is read-only);
  // a run stopped by now reads none and sends nothing
  deps.cancel_signal.throwIfAborted()
  try {
    await codexImageSigner(hooks.grants ?? tokenManager())({ url, headers, body: text })
  } catch (error) {
    if (deps.cancel_signal.aborted) throw error
    // the sign-in's own words are not repeated (a refresh failure may quote what it was sent); not retried
    const signedOut = error instanceof NativeAuthError && /sign in|not signed|no .*login|missing/i.test(error.message)
    return refused(ctx, TOOL, signedOut ? 'the ChatGPT subscription is not signed in; sign in on the Accounts page' : 'the ChatGPT subscription sign-in is not available right now; not retried')
  }
  const timeout = AbortSignal.timeout(hooks.timeoutMs)
  const signal = AbortSignal.any([deps.cancel_signal, timeout])
  const requested = { model: IMAGE_MODEL, size, quality, background, n: 1, ...(refs.length ? { references: refs.map((r) => r.attachment.asset_id) } : {}) }
  let response: Response
  let raw: Uint8Array | null
  try {
    deps.cancel_signal.throwIfAborted()
    response = await hooks.fetchImpl(url.href, { method: 'POST', headers, body: text, signal, redirect: 'error' })
    raw = await boundedBody(response, MAX_IMAGE_RESPONSE_BYTES)
  } catch (error) {
    if (deps.cancel_signal.aborted) throw error
    if (timeout.aborted) return failure(ctx, `the image service did not answer within ${Math.round(hooks.timeoutMs / 1000)} s; not retried`)
    if (error instanceof ContentEncodingRefused) return failure(ctx, `${error.message}; not retried`)
    return failure(ctx, `the request to the image service failed (${(error as Error).name}); not retried`)
  }
  if (deps.cancel_signal.aborted) throw new Error('the run was stopped')
  if (raw === null) return failure(ctx, `the image service's answer is over ${MAX_IMAGE_RESPONSE_BYTES / 1024 / 1024} MB; not read`, { http_status: response.status })
  if (!response.ok) {
    const { reason, extra } = errorFields(response.status, response.headers, new TextDecoder().decode(raw.subarray(0, 64 * 1024)))
    return failure(ctx, reason, extra)
  }
  const image = imageOf(raw)
  if (typeof image === 'string') return failure(ctx, image, { http_status: response.status })
  let attachment: ImageAttachment
  try {
    const measured = measureImage(image.bytes)
    if (deps.cancel_signal.aborted) throw new Error('the run was stopped')
    attachment = saveAttachment({ conn: deps.conn, store: deps.store }, deps.session, image.bytes, `generated-image.${EXTENSIONS[measured.media_type]}`)
  } catch (error) {
    if (error instanceof ImageRefused) return failure(ctx, `the returned image was not kept: ${error.message}`, { http_status: response.status })
    throw error
  }
  const used = refs.map((r) => r.attachment.asset_id)
  const payload: Payload = {
    status: 'ok', operation: refs.length ? 'edit' : 'generate', asset_id: attachment.asset_id, name: attachment.name, media_type: attachment.media_type,
    width: attachment.width, height: attachment.height, bytes: attachment.bytes, requested, actual_model: null,
    ...(Object.keys(image.reported).length ? { reported: image.reported } : {}),
    image: imageToolPiece(attachment, deps.model_cfg.capabilities),
  }
  return finish(ctx, TOOL, payload, {
    summary: prompt.slice(0, 200), generated: true,
    shown: [{ asset_id: attachment.asset_id, width: attachment.width, height: attachment.height, label: attachment.name }],
    ...(used.length ? { references: used } : {}),
    operation: payload.operation, requested_model: IMAGE_MODEL, requested_size: size, requested_quality: quality,
    media_type: attachment.media_type, bytes: attachment.bytes,
  })
}

register({
  name: TOOL, effect: 'network', action: 'network', renderer: 'generic', summary: 'make or edit an image',
  description: PROMPT_TEXT['tool.generate_image'],
  schema: z.object({
    prompt: z.string().describe(PROMPT_TEXT['parameter.generate_image.prompt']),
    reference_images: z.array(z.string()).nullable().default(null).describe(PROMPT_TEXT['parameter.generate_image.reference_images']),
    recent_images: z.number().int().nullable().default(null).describe(PROMPT_TEXT['parameter.generate_image.recent_images']),
    transparent_background: z.boolean().default(false).describe(PROMPT_TEXT['parameter.generate_image.transparent_background']),
    size: z.string().nullable().default(null).describe(PROMPT_TEXT['parameter.generate_image.size']),
    quality: z.enum(['low', 'medium', 'high', 'auto']).nullable().default(null).describe(PROMPT_TEXT['parameter.generate_image.quality']),
  }),
  fn: generateImage,
})
