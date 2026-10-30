/** Pictures and clips of a run's working folder, as the thread shows them: which paths are media, where their bytes
 *  are read from (the workspace's media route: the page's cookie authorizes it, byte ranges let a player seek). */

export type MediaKind = 'image' | 'video'

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif'])
const VIDEO = new Set(['mp4', 'm4v', 'mov', 'webm'])

/** 'image' or 'video' for a path of the working folder by its extension; null for anything else, and for an address
 *  that is not a relative path (a web link, an anchor, an absolute path, another scheme). */
export function mediaKind(path: string): MediaKind | null {
  const clean = path.trim().split(/[?#]/)[0] ?? ''
  if (!clean || /^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith('/') || clean.startsWith('#')) return null
  const ext = clean.split('.').pop()?.toLowerCase() ?? ''
  return IMAGE.has(ext) ? 'image' : VIDEO.has(ext) ? 'video' : null
}

/** A path as the workspace names it: a leading `./` dropped, percent-escapes (a link's spaces) read back. */
export function workspacePath(path: string): string {
  let clean = path.trim().split(/[?#]/)[0] ?? ''
  try { clean = decodeURIComponent(clean) } catch { /* not escaped */ }
  return clean.replace(/^\.\//, '')
}

/** The URL a picture or clip of the workspace is read from. */
export function mediaUrl(workspaceId: string, path: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/media?path=${encodeURIComponent(workspacePath(path))}`
}

/** An image a tool handed the model, as its result records it (an attachment of the session). */
export interface ShownImage { asset_id: string; width: number; height: number; label: string | null }

/** The images a tool result names, or none (an older record, a tool that shows none). */
export function shownImagesOf(result: Record<string, unknown> | undefined): ShownImage[] {
  const shown = result?.shown
  if (!Array.isArray(shown)) return []
  return shown.filter((s): s is ShownImage => !!s && typeof s === 'object' && typeof (s as ShownImage).asset_id === 'string')
}
