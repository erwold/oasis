/** The data the session share's file carries for its viewer (src/share/viewer): the strict snapshot (contract/src/
 *  share.ts) without its images' source bytes, the pictures the page re-encoded itself, and what the app drew that the
 *  snapshot cannot say — strictly cosmetic: the palette it showed and, per share-local run key, the product bot its
 *  turn wore (a NAME of the product's own set, each still picture embedded). No source id, no path, no setting.
 *
 *  checkShareDocument is the one gate both sides pass it through: the builder before it writes the file, the viewer
 *  before it draws anything. */

import { SHARE_BOTS as CONTRACT_BOTS, ShareSnapshotSchema, ShareSnapshotV3Schema, type ShareSnapshot, type ShareSnapshotV3 } from '@oasis-code/contract'

export const SHARE_PAGE_FORMAT = 'oasis-code.session-share.page' as const
export const SHARE_PAGE_VERSION = 2 as const
/** The page of a V3 snapshot (one session or every session of a task, each with its Agent Teams card). */
export const SHARE_PAGE_VERSION_TASK = 3 as const

export const SHARE_THEMES = ['light', 'dark', 'claude'] as const
export type ShareTheme = (typeof SHARE_THEMES)[number]

/** The bots a share may name: the product's set, the director's paper plane, ChatGPT's mark — nothing else. */
export const SHARE_BOTS: readonly string[] = CONTRACT_BOTS

export interface ShareFace { bot: string | null; enclosed: boolean }
export interface SharePictureData { src: string; width: number; height: number }
export interface SharePageOmissions { images_rejected: number; images_over_page_budget: number }

export interface ShareDocument {
  format: typeof SHARE_PAGE_FORMAT
  version: typeof SHARE_PAGE_VERSION
  /** the palette the app showed when it exported (the reader may change it in the page; nothing is stored) */
  theme: ShareTheme
  /** the snapshot, `images` always empty: its pictures are `pictures`, re-encoded by the page. The builder writes the
   *  latest version (V2); a document read back may hold either (the page's own shape is unchanged between them) */
  snapshot: ShareSnapshot
  /** by the snapshot's image key (`img1`): the page's re-encoded picture */
  pictures: Record<string, SharePictureData>
  page: SharePageOmissions
  /** by the snapshot's run key (`r1`): the bot the app drew on that run's turn */
  faces: Record<string, ShareFace>
  /** by bot name: its still picture */
  bots: Record<string, string>
}

/** A raster data URL and nothing else (no SVG, no parameters, base64 only). */
export const RASTER_DATA_URL = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/
const KEY = /^[a-z]{1,3}\d{1,6}$/

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const fail = (why: string): never => { throw new Error(`share document: ${why}`) }
const own = (o: Record<string, unknown>) => Object.keys(o)

/** The document, checked whole: the snapshot by its strict schema (V1 or V2, by its version; any other refused); every picture a raster data URL of a known image
 *  key; every face a run of the snapshot wearing a bot of the product's set; every bot picture a raster data URL. */
export function checkShareDocument(raw: unknown): ShareDocument {
  if (!isRecord(raw)) return fail('not an object')
  const allowed = ['format', 'version', 'theme', 'snapshot', 'pictures', 'page', 'faces', 'bots']
  for (const k of own(raw)) if (!allowed.includes(k)) fail(`unknown field ${k}`)
  if (raw.format !== SHARE_PAGE_FORMAT || raw.version !== SHARE_PAGE_VERSION) fail('format')
  if (!(SHARE_THEMES as readonly unknown[]).includes(raw.theme)) fail('theme')
  const snapshot = ShareSnapshotSchema.parse(raw.snapshot)
  if (snapshot.images.length) fail('the snapshot carries source image bytes')
  const imageKeys = new Set(snapshot.items.flatMap((i) => (i.kind === 'image' && i.image ? [i.image] : [])))
  const runKeys = new Set(snapshot.runs.map((r) => r.key))
  const pictures: Record<string, SharePictureData> = {}
  if (!isRecord(raw.pictures)) fail('pictures')
  for (const [key, p] of Object.entries(raw.pictures as Record<string, unknown>)) {
    if (!KEY.test(key) || !imageKeys.has(key)) fail(`picture ${key} is no image of the snapshot`)
    if (!isRecord(p) || own(p).some((k) => !['src', 'width', 'height'].includes(k))) fail(`picture ${key}`)
    const { src, width, height } = p as Record<string, unknown>
    if (typeof src !== 'string' || !RASTER_DATA_URL.test(src)) fail(`picture ${key} is not a raster data URL`)
    if (!Number.isInteger(width) || !Number.isInteger(height) || (width as number) <= 0 || (height as number) <= 0) fail(`picture ${key} size`)
    pictures[key] = { src: src as string, width: width as number, height: height as number }
  }
  if (!isRecord(raw.page)) fail('page')
  const page = raw.page as Record<string, unknown>
  if (own(page).some((k) => k !== 'images_rejected' && k !== 'images_over_page_budget')) fail('page')
  const count = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : fail('page count'))
  const faces: Record<string, ShareFace> = {}
  if (!isRecord(raw.faces)) fail('faces')
  for (const [key, f] of Object.entries(raw.faces as Record<string, unknown>)) {
    if (!runKeys.has(key)) fail(`face of ${key}: no run of the snapshot`)
    if (!isRecord(f) || own(f).some((k) => k !== 'bot' && k !== 'enclosed')) fail(`face of ${key}`)
    const { bot, enclosed } = f as Record<string, unknown>
    if (bot !== null && (typeof bot !== 'string' || !SHARE_BOTS.includes(bot))) fail(`face of ${key}: not a bot of the product`)
    if (typeof enclosed !== 'boolean') fail(`face of ${key}`)
    faces[key] = { bot: bot as string | null, enclosed: enclosed as boolean }
  }
  const bots: Record<string, string> = {}
  if (!isRecord(raw.bots)) fail('bots')
  for (const [name, src] of Object.entries(raw.bots as Record<string, unknown>)) {
    if (!SHARE_BOTS.includes(name)) fail(`bot ${name} is not of the product`)
    if (typeof src !== 'string' || !RASTER_DATA_URL.test(src)) fail(`bot ${name} is not a raster data URL`)
    bots[name] = src as string
  }
  return {
    format: SHARE_PAGE_FORMAT, version: SHARE_PAGE_VERSION, theme: raw.theme as ShareTheme, snapshot, pictures,
    page: { images_rejected: count(page.images_rejected), images_over_page_budget: count(page.images_over_page_budget) }, faces, bots,
  }
}

/** The page of a V3 snapshot: the snapshot with every image's source bytes emptied (`data_base64: ''` — its key, type
 *  and size stay, so each image item still names an image of ITS session), the page's re-encoded pictures BY SESSION
 *  (a session's picture is found under its own key only: `img1` of one session is never another's), and the still
 *  pictures of the bots it names. The faces are the snapshot's own (each run's `bot`, `enclosed`): nothing of the app's
 *  look but the palette. */
export interface ShareTaskDocument {
  format: typeof SHARE_PAGE_FORMAT
  version: typeof SHARE_PAGE_VERSION_TASK
  theme: ShareTheme
  snapshot: ShareSnapshotV3
  /** by session key, then by that session's image key */
  pictures: Record<string, Record<string, SharePictureData>>
  page: SharePageOmissions
  /** by bot name: its still picture */
  bots: Record<string, string>
}

/** Either page a viewer of today reads. */
export type ShareAnyDocument = ShareDocument | ShareTaskDocument

/** Every bot a V3 snapshot names: its sessions' rail bots, its runs' faces, its teams' rows. */
export function botsNamed(snapshot: ShareSnapshotV3): Set<string> {
  const out = new Set<string>()
  for (const s of snapshot.sessions) {
    for (const b of s.bots) out.add(b)
    for (const r of s.runs) if (r.bot) out.add(r.bot)
    for (const r of s.team.rows) if (r.bot) out.add(r.bot)
  }
  return out
}

function checkPicture(where: string, p: unknown): SharePictureData {
  if (!isRecord(p) || own(p).some((k) => !['src', 'width', 'height'].includes(k))) fail(where)
  const { src, width, height } = p as Record<string, unknown>
  if (typeof src !== 'string' || !RASTER_DATA_URL.test(src)) fail(`${where} is not a raster data URL`)
  if (!Number.isInteger(width) || !Number.isInteger(height) || (width as number) <= 0 || (height as number) <= 0) fail(`${where} size`)
  return { src: src as string, width: width as number, height: height as number }
}

/** A V3 page, checked whole: the snapshot by its strict schema with no source byte left; every picture a raster data
 *  URL of an image an item of ITS session names; every bot a name of the product's set, a raster data URL. */
export function checkShareTaskDocument(raw: unknown): ShareTaskDocument {
  if (!isRecord(raw)) return fail('not an object')
  for (const k of own(raw)) if (!['format', 'version', 'theme', 'snapshot', 'pictures', 'page', 'bots'].includes(k)) fail(`unknown field ${k}`)
  if (raw.format !== SHARE_PAGE_FORMAT || raw.version !== SHARE_PAGE_VERSION_TASK) fail('format')
  if (!(SHARE_THEMES as readonly unknown[]).includes(raw.theme)) fail('theme')
  const snapshot = ShareSnapshotV3Schema.parse(raw.snapshot)
  if (snapshot.sessions.some((s) => s.images.some((i) => i.data_base64 !== ''))) fail('the snapshot carries source image bytes')
  const sessions = new Map(snapshot.sessions.map((s) => [s.key, new Set(s.items.flatMap((i) => (i.kind === 'image' && i.image ? [i.image] : [])))]))
  if (!isRecord(raw.pictures)) fail('pictures')
  const pictures: Record<string, Record<string, SharePictureData>> = {}
  for (const [session, map] of Object.entries(raw.pictures as Record<string, unknown>)) {
    const keys = sessions.get(session)
    if (!keys) fail(`pictures of ${session}: no session of the snapshot`)
    if (!isRecord(map)) fail(`pictures of ${session}`)
    const mine: Record<string, SharePictureData> = {}
    for (const [key, p] of Object.entries(map as Record<string, unknown>)) {
      if (!KEY.test(key) || !keys!.has(key)) fail(`picture ${session}/${key} is no image of its session`)
      mine[key] = checkPicture(`picture ${session}/${key}`, p)
    }
    pictures[session] = mine
  }
  if (!isRecord(raw.page)) fail('page')
  const page = raw.page as Record<string, unknown>
  if (own(page).some((k) => k !== 'images_rejected' && k !== 'images_over_page_budget')) fail('page')
  const count = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : fail('page count'))
  if (!isRecord(raw.bots)) fail('bots')
  const bots: Record<string, string> = {}
  for (const [name, src] of Object.entries(raw.bots as Record<string, unknown>)) {
    if (!SHARE_BOTS.includes(name)) fail(`bot ${name} is not of the product`)
    if (typeof src !== 'string' || !RASTER_DATA_URL.test(src)) fail(`bot ${name} is not a raster data URL`)
    bots[name] = src as string
  }
  return {
    format: SHARE_PAGE_FORMAT, version: SHARE_PAGE_VERSION_TASK, theme: raw.theme as ShareTheme, snapshot, pictures,
    page: { images_rejected: count(page.images_rejected), images_over_page_budget: count(page.images_over_page_budget) }, bots,
  }
}

/** Either page, by its version (the viewer and the builder pass every document through here). */
export function checkShareAnyDocument(raw: unknown): ShareAnyDocument {
  return isRecord(raw) && raw.version === SHARE_PAGE_VERSION_TASK ? checkShareTaskDocument(raw) : checkShareDocument(raw)
}
