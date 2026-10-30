/** Upload policy and route gates shared by the UI and the harness. A capability is a declaration, not a probe. */
import type { Attachment, FileRefAttachment } from './models.ts'
export const MiB = 1024 * 1024
/** The byte limits of the original upload route (`POST …/attachments`) and of the legacy `utf8-v1` / `native-v1`
 *  references it made. Images and text keep them. The `pdf` / `video` entries bound only that legacy route and the
 *  validation of legacy references: they are NOT a limit on PDF / video attachments, which are `ref-v1` references
 *  of any size (docs/large-file-attachments.md), nor a native threshold (refNativeFor decides that per route). */
export const FILE_LIMITS = { image: 5 * MiB, text: MiB, pdf: 20 * MiB, video: 20 * MiB } as const
export const VIDEO_MEDIA_TYPES = ['video/mp4', 'video/webm', 'video/quicktime'] as const
export const TEXT_EXTENSIONS = ['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'ndjson', 'yaml', 'yml', 'toml', 'xml', 'html', 'htm', 'css', 'scss', 'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'py', 'rb', 'rs', 'go', 'java', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'swift', 'kt', 'sh', 'bash', 'zsh', 'sql', 'graphql', 'tex', 'log', 'ini', 'conf', 'diff', 'patch'] as const
export type AttachmentKind = keyof typeof FILE_LIMITS
export function extensionOf(name: string): string { return name.toLowerCase().split('.').pop() ?? '' }
export function candidateKind(name: string, mime: string): AttachmentKind | null {
  const ext = extensionOf(name)
  if (['png', 'jpg', 'jpeg', 'webp'].includes(ext) || ['image/png', 'image/jpeg', 'image/webp'].includes(mime)) return 'image'
  if (ext === 'pdf' || mime === 'application/pdf') return 'pdf'
  if (['mp4', 'webm', 'mov'].includes(ext) || (VIDEO_MEDIA_TYPES as readonly string[]).includes(mime) || mime === 'video/mov') return 'video'
  if ((TEXT_EXTENSIONS as readonly string[]).includes(ext) || ['README', 'LICENSE', 'Makefile', 'Dockerfile', '.gitignore'].includes(name)) return 'text'
  return null
}
export function attachmentKind(a: Pick<Attachment, 'media_type'>): AttachmentKind {
  return a.media_type.startsWith('image/') ? 'image' : a.media_type === 'application/pdf' ? 'pdf' : a.media_type.startsWith('video/') ? 'video' : 'text'
}
/** Whether a route takes the file itself in a request: an image or a PDF it declares, a video of a MIME it lists. */
export function nativeAttachment(capabilities: Record<string, unknown>, file: Pick<Attachment, 'media_type' | 'name'>): boolean {
  const kind = attachmentKind(file)
  return kind === 'image' ? capabilities.images === true : kind === 'pdf' ? capabilities.pdf === true
    : kind === 'video' ? Array.isArray(capabilities.video) && capabilities.video.includes(file.media_type) : capabilities.text_files !== false
}

/** Why a route cannot be sent these files, or null. A PDF or a video the route does not take itself is never refused
 *  (a `ref-v1` reference included, whatever its size): the request names where it is and the agent opens it with its
 *  commands. Images and text keep their gate. */
export function attachmentRefusal(capabilities: Record<string, unknown>, files: readonly Pick<Attachment, 'media_type' | 'name'>[], label: string): string | null {
  for (const file of files) {
    const kind = attachmentKind(file)
    if (kind === 'pdf' || kind === 'video' || nativeAttachment(capabilities, file)) continue
    return `${label} is not configured to take ${kind === 'image' ? 'images' : 'text files'}: ${file.name}. Choose a compatible route or remove the attachment; the draft is kept.`
  }
  return null
}

// ---- PDF / video references (ref-v1) ---------------------------------------------------------------------------

/** The video names a reference recognizes by extension, and the media type each is given (the harness checks a
 *  bounded head of the bytes too; it never reads a whole file to name it). Native video is still only the MIME types a
 *  route lists in `capabilities.video`; every other one is named by its path. `.ts` is TypeScript here, never video. */
export const REF_VIDEO_EXTENSIONS: Readonly<Record<string, string>> = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', qt: 'video/quicktime', webm: 'video/webm',
  mkv: 'video/x-matroska', avi: 'video/x-msvideo', mpeg: 'video/mpeg', mpg: 'video/mpeg', '3gp': 'video/3gpp',
  wmv: 'video/x-ms-wmv', flv: 'video/x-flv', m2ts: 'video/mp2t', mts: 'video/mp2t', ogv: 'video/ogg',
}

/** Whether a file (by its name, else its declared type) is a PDF or a video — what goes as a `ref-v1` reference: by
 *  path from the desktop app, else by the chunked upload. Null for anything else (images and text keep their route;
 *  other formats are not attachments). A hint for routing; the harness's head check decides. */
export function refKindOf(name: string, mime = ''): { file_kind: 'pdf' | 'video'; media_type: string } | null {
  const ext = extensionOf(name)
  if (ext === 'pdf') return { file_kind: 'pdf', media_type: 'application/pdf' }
  const video = REF_VIDEO_EXTENSIONS[ext]
  if (video) return { file_kind: 'video', media_type: video }
  const declared = mime.split(';')[0]!.trim().toLowerCase()
  if (declared === 'application/pdf') return { file_kind: 'pdf', media_type: declared }
  if (declared === 'video/mov') return { file_kind: 'video', media_type: 'video/quicktime' }
  if (/^video\/[a-z0-9][a-z0-9.+-]*$/.test(declared)) return { file_kind: 'video', media_type: declared }
  return null
}

/** The one line that stands for a reference whose bytes a request does not carry. A pure function of the frozen
 *  fields: the same reference gives the same words on every request, route, run, workspace and day, whether or not
 *  the file is still there (the agent finds out with its commands). The location is JSON-escaped. */
export function refFileNote(ref: Pick<FileRefAttachment, 'name' | 'media_type' | 'bytes' | 'location'>): string {
  return `[attached file (reference v1): ${JSON.stringify(ref.name)}; ${ref.media_type}; ${ref.bytes} bytes; `
    + `its content is not in this message; it is on disk at ${JSON.stringify(ref.location)}, where your commands can read it]`
}

// ---- what one provider request may carry (the limits backend-ts/src/llm/http.ts enforces) ----------------------

/** The hard request bounds a native attachment is judged against: the complete JSON body after base64 and signing
 *  (`request_bytes`), and for the OpenAI API (not the Codex backend) the raw bytes of input files — each strictly
 *  under, and all together at most, 50,000,000. 128 MiB is the application's own bound where the provider's is
 *  unknown. These are the figures http.ts asserts on every request; nothing else is a native threshold. */
export interface RequestLimits { key: 'anthropic' | 'google' | 'openai_api' | 'codex' | 'deepseek' | 'app_cap'; request_bytes: number; file_raw_each_lt?: number; file_raw_total_le?: number; basis: string }
export const APP_REQUEST_CAP_BYTES = 128 * MiB
export const PROVIDER_REQUEST_LIMITS: Readonly<Record<RequestLimits['key'], RequestLimits>> = {
  anthropic: { key: 'anthropic', request_bytes: 32_000_000, basis: 'Anthropic Messages 32 MB' },
  google: { key: 'google', request_bytes: 100_000_000, basis: 'Gemini inline payload 100 MB' },
  openai_api: { key: 'openai_api', request_bytes: APP_REQUEST_CAP_BYTES, file_raw_each_lt: 50_000_000, file_raw_total_le: 50_000_000, basis: 'OpenAI input files: each < 50,000,000 raw bytes, total <= 50,000,000; application cap 128 MiB on the JSON' },
  codex: { key: 'codex', request_bytes: APP_REQUEST_CAP_BYTES, basis: 'application safety cap 128 MiB (Codex provider cap unknown)' },
  deepseek: { key: 'deepseek', request_bytes: 48 * MiB, basis: 'DeepSeek official inline request body limit 48 MiB (checked 2026-10-18)' },
  app_cap: { key: 'app_cap', request_bytes: APP_REQUEST_CAP_BYTES, basis: 'application safety cap 128 MiB (provider request cap unknown)' },
}
/** Which bounds a route's requests meet: its wire protocol, and for OpenAI whether the endpoint is the Codex backend. */
export function requestLimitsFor(route: { protocol?: 'anthropic' | 'google' | 'openai' | null; url?: string | null }): RequestLimits {
  try {
    const url = route.url ? new URL(route.url) : null
    if (url?.hostname === 'api.deepseek.com') return PROVIDER_REQUEST_LIMITS.deepseek
    if (url?.hostname === 'open.bigmodel.cn') return PROVIDER_REQUEST_LIMITS.app_cap
  } catch { /* unknown endpoint: retain the protocol/application bound below */ }
  if (route.protocol === 'anthropic') return PROVIDER_REQUEST_LIMITS.anthropic
  if (route.protocol === 'google') return PROVIDER_REQUEST_LIMITS.google
  if (route.protocol === 'openai') {
    let codex = false
    try { const path = route.url ? new URL(route.url).pathname : ''; codex = path === '/backend-api/codex' || path.startsWith('/backend-api/codex/') } catch { codex = false }
    return codex ? PROVIDER_REQUEST_LIMITS.codex : PROVIDER_REQUEST_LIMITS.openai_api
  }
  return PROVIDER_REQUEST_LIMITS.app_cap
}
/** The base64 length of n bytes (what the bytes weigh inside the JSON). */
export function base64Length(bytes: number): number { return 4 * Math.ceil(bytes / 3) }

/** Whether a reference travels as its bytes on this route: the route takes its kind (PDF, or this video MIME) and the
 *  file alone fits the route's hard bounds. Only the frozen reference and the route decide — never the history's
 *  length or the other attachments (nativeTotalRefusal refuses a request whose natives together exceed the bounds
 *  before it is sent; image planning may already have read images). Local and uploaded references alike. */
export function refNativeFor(capabilities: Record<string, unknown>, limits: RequestLimits, ref: Pick<FileRefAttachment, 'media_type' | 'name' | 'bytes'>): boolean {
  if (!nativeAttachment(capabilities, ref)) return false
  if (base64Length(ref.bytes) >= limits.request_bytes) return false
  if (limits.file_raw_each_lt !== undefined && ref.bytes >= limits.file_raw_each_lt) return false
  if (limits.file_raw_total_le !== undefined && ref.bytes > limits.file_raw_total_le) return false
  return true
}

/** Why the native attachments of one request (every image and file whose bytes it would carry, the history's
 *  included) cannot all go, or null: their base64 alone reaches the request bound, or — OpenAI API — their raw input
 *  file bytes pass the 50,000,000 total. Judged from the supplied byte counts (image planning may already have read
 *  images); the request is not sent and the draft is kept. assertRequestSize still checks the real body after signing. */
export function nativeTotalRefusal(limits: RequestLimits, natives: readonly { bytes: number; input_file: boolean }[], label: string): string | null {
  const encoded = natives.reduce((n, a) => n + base64Length(a.bytes), 0)
  if (natives.length && encoded >= limits.request_bytes) {
    return `${label}: the attachments sent as their bytes would weigh at least ${encoded} bytes encoded; one request may carry at most ${limits.request_bytes} (${limits.basis}). Remove an attachment or choose another route; this request was not sent and the draft is kept.`
  }
  const files = natives.reduce((n, a) => n + (a.input_file ? a.bytes : 0), 0)
  if (limits.file_raw_total_le !== undefined && files > limits.file_raw_total_le) {
    return `${label}: the input files sent as their bytes come to ${files} raw bytes; at most ${limits.file_raw_total_le} (${limits.basis}). Remove an attachment or choose another route; this request was not sent and the draft is kept.`
  }
  return null
}

/** Browser/OS aliases for text/code. This only checks declarations; fatal UTF-8 and signatures are checked server-side. */
export function isTextMime(mime: string): boolean {
  const value = mime.split(';')[0]!.trim().toLowerCase()
  return value.startsWith('text/') || ['application/json', 'application/ld+json', 'application/ndjson', 'application/x-ndjson',
    'application/javascript', 'application/x-javascript', 'application/typescript', 'application/xml', 'application/yaml', 'application/x-yaml',
    'application/toml', 'application/sql', 'application/x-sql', 'application/x-sh', 'application/x-shellscript', 'application/x-python',
    'application/x-httpd-php', 'application/graphql', 'application/x-tex'].includes(value)
}
