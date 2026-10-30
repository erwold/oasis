/** The session share's generation, apart from React: ask the harness for the strict snapshot, check it against the
 *  contract, re-encode its pictures (state/shareImages.ts), build the one HTML file (state/shareHtml.ts) and measure
 *  it. What the dialog previews and what it downloads are the `html` and `bytes` of ONE BuiltShare: the preview's
 *  srcdoc is `html`, the download is `bytes` = UTF-8 of that same string.
 *
 *  The response's `selection` (real run ids, for the exclude choice) stays in the dialog: it never reaches the
 *  builder. The snapshot's source image bytes are dropped once re-encoded: the BuiltShare does not hold them. */

import {
  SHARE_ACTIVE_CODE, SHARE_TOO_LARGE_CODE, ShareSnapshotRequestSchema, ShareSnapshotResponseSchema, ShareSnapshotV2Schema, ShareSnapshotV3RequestSchema, ShareSnapshotV3ResponseSchema,
  shareSessionAsV2, threadActionLabel, type ShareItem, type ShareSnapshot, type ShareSnapshotRequest, type ShareSnapshotV3Request, type ShareStats,
} from '@oasis-code/contract'
import { buildShareHtml, NO_PAGE_OMISSIONS, sha256, shareFileName, type PageOmissions, type ViewerBundle } from './shareHtml.ts'
import { prepareShareImages, type ImageCodec } from './shareImages.ts'
import { botsNamed, RASTER_DATA_URL, SHARE_BOTS, SHARE_PAGE_FORMAT, SHARE_PAGE_VERSION, SHARE_PAGE_VERSION_TASK, type ShareDocument, type ShareFace, type ShareTaskDocument, type ShareTheme } from '../share/document.ts'
import { runFaces } from '../share/team.ts'
import { CHATGPT_BOT, DIRECTOR_BOT } from './outline.ts'

export interface ShareOptions { tools: boolean; images: boolean; excluded: readonly string[]; /** every session of the task (V3) */ task?: boolean }
export const DEFAULT_SHARE_OPTIONS: ShareOptions = { tools: false, images: false, excluded: [], task: false }

/** One run the dialog may leave out (the harness's id — the dialog's only, never written into the file); `session`:
 *  the share key of its session (a V3 share). */
export interface ShareRunChoice { run_id: string; label: string; status: 'done' | 'cancelled' | 'error'; session?: string }

export interface BuiltShare {
  /** what the preview shows and what downloads (as `bytes`) */
  html: string
  bytes: Uint8Array
  /** sha-256 of `bytes`, hex: what the dialog reports so a downloaded copy can be compared */
  sha256: string
  fileName: string
  /** the options it was built with (a change makes it stale) */
  key: string
  stats: ShareStats
  page: PageOmissions
  images: number
  imageBytes: number
  runs: ShareRunChoice[]
  /** what each part of the file weighs (UTF-8 bytes as written): the viewer's script and stylesheet, the data block,
   *  the pictures and the bot stills inside it */
  parts: { viewerJs: number; viewerCss: number; data: number; pictures: number; bots: number }
  /** runs of the snapshot whose face the app could not say (drawn without a bot rather than with a made-up one) */
  facesMissing: number
}

/** What the app drew that the snapshot cannot say, captured when it exports — strictly cosmetic: its palette, and the
 *  bot each run's turn wore, by the harness's run id (mapped here to the share's keys through the response's
 *  selection; the run ids never reach the file). */
export interface ShareLook {
  theme: ShareTheme
  faceOf(runId: string): ShareFace | null
}

/** Where the file's fixed parts come from: the viewer bundle, and a product bot's still picture (a data URL). */
export interface ShareAssets {
  viewer(): Promise<ViewerBundle>
  bot(name: string, signal: AbortSignal): Promise<string | null>
}

/** The product bots a snapshot's page may draw: the runs' faces, the director's paper plane where a director speaks,
 *  ChatGPT's mark where ChatGPT is named — said for each place the page draws the mark (an action ChatGPT took, an
 *  older snapshot's action run labelled for it, a connector's words, a group it started), so an export whose only
 *  ChatGPT is an action still carries the mark: the file never loads it. */
export function botsWanted(snapshot: ShareSnapshot, faces: Record<string, ShareFace>): string[] {
  const wanted = new Set<string>()
  for (const f of Object.values(faces)) if (f.bot) wanted.add(f.bot)
  const director = snapshot.items.some((i) => i.kind === 'director_note' || (i.kind === 'group' && i.author === 'director')
    || (i.kind === 'message' && (i.author === 'director' || i.steer?.by === 'director')))
  if (director) wanted.add(DIRECTOR_BOT)
  const items: readonly ShareItem[] = snapshot.items
  const chatgpt = items.some((i) => (i.kind === 'action' && i.by === 'ChatGPT') || (i.kind === 'group' && i.client === 'ChatGPT')
    || (i.kind === 'message' && (i.steer?.client === 'ChatGPT' || (i.author === 'connector' && i.author_label === 'ChatGPT'))))
    || snapshot.runs.some((r) => r.client === 'ChatGPT' || (r.request === 'action' && threadActionLabel(r.label).by === 'ChatGPT'))
  if (chatgpt || /chatgpt/i.test(JSON.stringify(items))) wanted.add(CHATGPT_BOT)
  return [...wanted].filter((b) => SHARE_BOTS.includes(b)).sort()
}

/** A task with more sessions than one share holds (413 share_too_large): refused whole, never cut. */
export class ShareTooLargeError extends Error {
  constructor(detail: string) { super(detail); this.name = 'ShareTooLargeError' }
}

/** Work under way: the harness exports a quiescent session only (409 session_active). */
export class ShareBusyError extends Error {
  readonly reasons: string[]
  constructor(detail: string, reasons: string[]) { super(detail); this.name = 'ShareBusyError'; this.reasons = reasons }
}

export const optionsKey = (o: ShareOptions): string => JSON.stringify([o.tools, o.images, [...o.excluded].sort(), o.task === true])

export function shareRequest(o: ShareOptions): ShareSnapshotRequest {
  return ShareSnapshotRequestSchema.parse({ include_tool_details: o.tools, include_images: o.images, exclude_run_ids: [...o.excluded] })
}

/** A refusal the fetcher threw, as the dialog says it: a ShareBusyError for 409 session_active, else itself. */
export function shareError(e: unknown): unknown {
  const err = e as { status?: unknown; body?: unknown; detail?: unknown } | null
  if (err && err.status === 409 && typeof err.body === 'object' && err.body !== null && (err.body as { code?: unknown }).code === SHARE_ACTIVE_CODE) {
    const reasons = (err.body as { reasons?: unknown }).reasons
    return new ShareBusyError(typeof err.detail === 'string' ? err.detail : 'work is under way', Array.isArray(reasons) ? reasons.filter((r): r is string => typeof r === 'string').slice(0, 10) : [])
  }
  if (err && err.status === 413 && typeof err.body === 'object' && err.body !== null && (err.body as { code?: unknown }).code === SHARE_TOO_LARGE_CODE) {
    return new ShareTooLargeError(typeof err.detail === 'string' && err.detail ? err.detail : 'this task has too many sessions to share at once')
  }
  return e
}

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

export async function generateShare<D>(
  fetchSnapshot: (body: ShareSnapshotRequest, signal: AbortSignal) => Promise<unknown>,
  options: ShareOptions,
  codec: ImageCodec<D>,
  signal: AbortSignal,
  look: ShareLook,
  assets: ShareAssets,
): Promise<BuiltShare> {
  const body = shareRequest(options)
  let raw: unknown
  try { raw = await fetchSnapshot(body, signal) } catch (e) { throw shareError(e) }
  if (signal.aborted) throw signal.reason
  const response = ShareSnapshotResponseSchema.parse(raw)
  raw = null
  const snapshot = ShareSnapshotV2Schema.parse(response.snapshot)
  if (snapshot.options.include_images !== options.images || snapshot.options.include_tool_details !== options.tools) throw new Error('the snapshot does not match the options asked')
  const runs: ShareRunChoice[] = response.selection.runs.map((r) => ({ run_id: r.run_id, label: r.label, status: r.status }))
  const prepared = options.images && snapshot.images.length
    ? await prepareShareImages(snapshot.images, codec, signal)
    : { images: new Map(), omissions: NO_PAGE_OMISSIONS, bytes: 0 }
  if (signal.aborted) throw signal.reason
  // the faces by share key: only runs of the snapshot, only bots of the product's set
  const keyOf = new Map(response.selection.runs.map((r) => [r.key, r.run_id]))
  const faces: Record<string, ShareFace> = {}
  let facesMissing = 0
  for (const r of snapshot.runs) {
    // an action's run has no turn to wear a face (its line names who took it): no face, and none missing
    if (r.request === 'action') continue
    const runId = keyOf.get(r.key)
    const face = runId ? look.faceOf(runId) : null
    if (face && (face.bot === null || SHARE_BOTS.includes(face.bot))) faces[r.key] = { bot: face.bot, enclosed: face.enclosed }
    else facesMissing++
  }
  const bots: Record<string, string> = {}
  for (const name of botsWanted(snapshot, faces)) {
    const src = await assets.bot(name, signal)
    if (signal.aborted) throw signal.reason
    if (src && RASTER_DATA_URL.test(src)) bots[name] = src
  }
  const viewer = await assets.viewer()
  if (signal.aborted) throw signal.reason
  const pictures: ShareDocument['pictures'] = {}
  for (const [key, img] of prepared.images) pictures[key] = { src: img.dataUrl, width: img.width, height: img.height }
  // the source bytes end here: the document holds the snapshot without them, and nothing below keeps them
  const doc: ShareDocument = {
    format: SHARE_PAGE_FORMAT, version: SHARE_PAGE_VERSION, theme: look.theme, snapshot: { ...snapshot, images: [] }, pictures,
    page: prepared.omissions, faces, bots,
  }
  const html = buildShareHtml(doc, viewer)
  const bytes = new TextEncoder().encode(html)
  const size = (t: string) => new TextEncoder().encode(t).byteLength
  return {
    html, bytes, sha256: hex(sha256(bytes)), fileName: shareFileName(snapshot.title), key: optionsKey(options),
    stats: snapshot.stats, page: prepared.omissions, images: prepared.images.size, imageBytes: prepared.bytes, runs,
    parts: {
      viewerJs: size(viewer.js), viewerCss: size(viewer.css), data: size(html.slice(html.indexOf('id="share-data">'), html.lastIndexOf('</script><script>'))),
      pictures: Object.values(pictures).reduce((n, p) => n + p.src.length, 0), bots: Object.values(bots).reduce((n, b) => n + b.length, 0),
    },
    facesMissing,
  }
}

export function taskShareRequest(o: ShareOptions): ShareSnapshotV3Request {
  return ShareSnapshotV3RequestSchema.parse({ include_tool_details: o.tools, include_images: o.images, exclude_run_ids: [...o.excluded], include_task_sessions: o.task === true })
}

/** The V3 share (its route answers V3 whether one session or the task's): every session's pictures re-encoded under
 *  the page's one budget and kept BY SESSION; the faces, the cards and the rail's bots are the snapshot's own (the
 *  backend computed them, contract bots.ts) — only the palette is the app's; the bot stills of every bot it names. */
export async function generateTaskShare<D>(
  fetchSnapshot: (body: ShareSnapshotV3Request, signal: AbortSignal) => Promise<unknown>,
  options: ShareOptions,
  codec: ImageCodec<D>,
  signal: AbortSignal,
  theme: ShareTheme,
  assets: ShareAssets,
): Promise<BuiltShare> {
  const body = taskShareRequest(options)
  let raw: unknown
  try { raw = await fetchSnapshot(body, signal) } catch (e) { throw shareError(e) }
  if (signal.aborted) throw signal.reason
  const response = ShareSnapshotV3ResponseSchema.parse(raw)
  raw = null
  const snapshot = response.snapshot
  const o = snapshot.options
  if (o.include_images !== options.images || o.include_tool_details !== options.tools || o.include_task_sessions !== (options.task === true)) throw new Error('the snapshot does not match the options asked')
  const runs: ShareRunChoice[] = response.selection.runs.map((r) => ({ run_id: r.run_id, label: r.label, status: r.status, session: r.session }))
  // every session's pictures, the current one first, under one budget; kept by session (never one session's key for another's)
  const pictures: ShareTaskDocument['pictures'] = {}
  const omissions: PageOmissions = { ...NO_PAGE_OMISSIONS }
  let imageBytes = 0, imageCount = 0
  const order = [...snapshot.sessions].sort((a, b) => Number(b.current) - Number(a.current))
  for (const session of order) {
    if (!options.images || !session.images.length) continue
    const prepared = await prepareShareImages(session.images, codec, signal, imageBytes)
    if (signal.aborted) throw signal.reason
    imageBytes += prepared.bytes
    omissions.images_rejected += prepared.omissions.images_rejected
    omissions.images_over_page_budget += prepared.omissions.images_over_page_budget
    if (prepared.images.size) pictures[session.key] = Object.fromEntries([...prepared.images].map(([k, img]) => [k, { src: img.dataUrl, width: img.width, height: img.height }]))
    imageCount += prepared.images.size
  }
  // the bots it names, and the director's and ChatGPT's marks where a session's words name them
  const wanted = botsNamed(snapshot)
  for (const session of snapshot.sessions) for (const b of botsWanted(shareSessionAsV2(snapshot, session.key)!, runFaces(session.runs))) wanted.add(b)
  const bots: Record<string, string> = {}
  for (const name of [...wanted].filter((b) => SHARE_BOTS.includes(b)).sort()) {
    const src = await assets.bot(name, signal)
    if (signal.aborted) throw signal.reason
    if (src && RASTER_DATA_URL.test(src)) bots[name] = src
  }
  const viewer = await assets.viewer()
  if (signal.aborted) throw signal.reason
  // the source bytes end here: each image keeps its key, type and size (its session's items name it), never its bytes
  const doc: ShareTaskDocument = {
    format: SHARE_PAGE_FORMAT, version: SHARE_PAGE_VERSION_TASK, theme,
    snapshot: { ...snapshot, sessions: snapshot.sessions.map((s) => ({ ...s, images: s.images.map((i) => ({ ...i, data_base64: '' })) })) },
    pictures, page: omissions, bots,
  }
  const html = buildShareHtml(doc, viewer)
  const bytes = new TextEncoder().encode(html)
  const size = (t: string) => new TextEncoder().encode(t).byteLength
  return {
    html, bytes, sha256: hex(sha256(bytes)), fileName: shareFileName(snapshot.title), key: optionsKey(options),
    stats: snapshot.stats, page: omissions, images: imageCount, imageBytes, runs,
    parts: {
      viewerJs: size(viewer.js), viewerCss: size(viewer.css), data: size(html.slice(html.indexOf('id="share-data">'), html.lastIndexOf('</script><script>'))),
      pictures: Object.values(pictures).reduce((n, m) => n + Object.values(m).reduce((k, p) => k + p.src.length, 0), 0), bots: Object.values(bots).reduce((n, b) => n + b.length, 0),
    },
    facesMissing: 0,
  }
}

/** The counts the dialog shows, from the snapshot's stats and what the page left out. */
export function shareCounts(b: Pick<BuiltShare, 'stats' | 'page'>): { redacted: number; omitted: number; lines: string[] } {
  const redacted = Object.values(b.stats.redacted).reduce((a, n) => a + n, 0)
  const omitted = Object.values(b.stats.omitted).reduce((a, n) => a + n, 0) + b.page.images_rejected + b.page.images_over_page_budget
  const lines = [
    ...Object.entries(b.stats.redacted).filter(([, n]) => n > 0).map(([k, n]) => `redacted ${k.replace(/_/g, ' ')}: ${n}`),
    ...Object.entries(b.stats.omitted).filter(([, n]) => n > 0).map(([k, n]) => `left out ${k.replace(/_/g, ' ')}: ${n}`),
    ...(b.page.images_rejected ? [`images the page rejected: ${b.page.images_rejected}`] : []),
    ...(b.page.images_over_page_budget ? [`images over the page budget: ${b.page.images_over_page_budget}`] : []),
    ...(b.stats.truncated_fields ? [`long fields cut: ${b.stats.truncated_fields}`] : []),
    ...(b.stats.items_truncated ? ['later entries left out (limit)'] : []),
  ]
  return { redacted, omitted, lines }
}

export function fileSizeLabel(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}
