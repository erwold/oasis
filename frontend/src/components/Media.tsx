import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { attachmentUrl } from '../state/attachments'
import { beginImageDrag, downloadNameOf, endImageDrag, IMAGE_DRAG_MIME } from '../state/imageDrag'
import { mediaKind, mediaUrl, workspacePath, type MediaKind, type ShownImage } from '../state/media'
import { DownloadIcon, ImageIcon, XIcon } from './icons'
import { useSharePresentation, type SharePresentation } from './ThreadPresentation'

/** Where a session image is read: the harness's attachment route, or — in the session share's copy — the page's own
 *  re-encoded picture of that image item (null: not carried; nothing is drawn for it here). */
function imageUrl(shared: SharePresentation | null, sessionId: string, assetId: string): string | null {
  if (!shared) return attachmentUrl(sessionId, assetId)
  const picture = shared.picture(assetId)
  return picture?.kind === 'shown' ? picture.src : null
}

/** The run a piece of the thread belongs to: its session (whose attachments the tools' images are) and its working
 *  folder (whose pictures and clips the answer names). Set once per run turn. */
export const RunScope = createContext<{ sessionId: string; workspaceId: string | null; runId: string } | null>(null)

/** The viewer's frame: the name, the download and the close above the picture or the clip. */
export function ViewerFrame({ url, kind, label, download, onClose, onError }: { url: string; kind: MediaKind; label: string; download: string | null; onClose: () => void; onError?: () => void }) {
  return (
    <div className="media-viewer-frame" onClick={(event) => event.stopPropagation()}>
      <div className="media-viewer-head"><span className="media-viewer-name">{label}</span>
        {download !== null && <a className="media-viewer-close" href={url} download={download} aria-label="Download" title="Download" data-testid="media-viewer-download"><DownloadIcon size={13} /></a>}
        <button type="button" className="media-viewer-close" aria-label="Close" onClick={onClose}><XIcon size={13} /></button></div>
      {kind === 'image' ? <img src={url} alt={label} onError={onError} /> : <video src={url} controls autoPlay playsInline onError={onError} />}
    </div>
  )
}

/** A picture or a clip opened over the app: the whole of it, a clip with its controls; Esc or a click outside closes. */
function Viewer({ url, kind, label, download, onClose, onError }: { url: string; kind: MediaKind; label: string; download?: string | null; onClose: () => void; onError?: () => void }) {
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])
  return createPortal(
    <div className="media-viewer" role="dialog" aria-label={label} onClick={onClose} data-testid="media-viewer">
      <ViewerFrame url={url} kind={kind} label={label} download={download === null ? null : download ?? (label.split('/').pop() || 'download')} onClose={onClose} onError={onError} />
    </div>,
    document.body,
  )
}

/** A drag of an image of the session: recorded as this page's drag, carrying its ids and the drag's nonce (the
 *  composer takes nothing else, and reads the rest from the harness); forgotten when the drag ends. */
const dragImage = (sessionId: string, assetId: string) => ({
  onDragStart: (event: React.DragEvent) => {
    event.dataTransfer.setData(IMAGE_DRAG_MIME, beginImageDrag(sessionId, assetId))
    event.dataTransfer.effectAllowed = 'copy'
  },
  onDragEnd: () => endImageDrag(),
})

/** The images a tool handed the model, under its row: thumbnails, each opening whole, each draggable into the composer. */
export function ShownImages({ images }: { images: ShownImage[] }) {
  const scope = useContext(RunScope)
  const shared = useSharePresentation()
  const [open, setOpen] = useState<ShownImage | null>(null)
  if (!scope || images.length === 0) return null
  const openUrl = open ? imageUrl(shared, scope.sessionId, open.asset_id) : null
  return (
    <div className="shown-images" data-testid="shown-images">
      {images.map((image) => {
        const url = imageUrl(shared, scope.sessionId, image.asset_id)
        if (url === null) return null
        return (
          <button key={image.asset_id} type="button" className="shown-image" title={`${image.label ?? ''} · ${image.width}×${image.height}`} onClick={() => setOpen(image)}>
            <img src={url} alt={image.label ?? ''} loading="lazy" draggable={!shared} {...(shared ? {} : dragImage(scope.sessionId, image.asset_id))} />
          </button>
        )
      })}
      {open && openUrl && <Viewer url={openUrl} kind="image" label={open.label ?? open.asset_id} download={shared ? null : downloadNameOf(open)} onClose={() => setOpen(null)} />}
    </div>
  )
}

/** The images the harness generated, under the call's row: each shown large, opening whole, with its download, and
 *  draggable into the composer. */
export function GeneratedImages({ images }: { images: ShownImage[] }) {
  const scope = useContext(RunScope)
  // the share's copy: the page's own pictures, opened whole in place — no download, no drag into a composer
  const shared = useSharePresentation()
  const [open, setOpen] = useState<ShownImage | null>(null)
  if (!scope || images.length === 0) return null
  const openUrl = open ? imageUrl(shared, scope.sessionId, open.asset_id) : null
  return (
    <div className="generated-images">
      {images.map((image) => {
        const url = imageUrl(shared, scope.sessionId, image.asset_id)
        if (url === null) return null
        const name = downloadNameOf(image)
        return (
          <figure key={image.asset_id} className="generated-image" data-testid="generated-image" data-asset-id={image.asset_id}>
            <button type="button" className="generated-image-open" aria-label={shared ? image.label ?? 'image' : name} onClick={() => setOpen(image)}>
              <img src={url} alt={image.label ?? ''} width={image.width || undefined} height={image.height || undefined} loading="lazy"
                   draggable={!shared} {...(shared ? {} : dragImage(scope.sessionId, image.asset_id))} />
            </button>
            {!shared && <a className="generated-image-download" href={url} download={name} aria-label="Download" title="Download" data-testid="generated-image-download"><DownloadIcon size={13} /></a>}
          </figure>
        )
      })}
      {open && openUrl && <Viewer url={openUrl} kind="image" label={open.label ?? open.asset_id} download={shared ? null : downloadNameOf(open)} onClose={() => setOpen(null)} />}
    </div>
  )
}

/** A picture or clip of the working folder named in the thread: a chip that shows it on hover (a clip plays, muted)
 *  and opens it whole on a click (a clip with its sound and controls). Anything else, no working folder, or a file the
 *  workspace does not give back (none there, or more than one by that name) is the words as they were. */
export function MediaChip({ path, children }: { path: string; children?: ReactNode }) {
  const scope = useContext(RunScope)
  // the share's copy has no working folder to read: the words as they were
  const shared = useSharePresentation()
  const kind = mediaKind(path)
  const [hover, setHover] = useState<{ x: number; top?: number; bottom?: number } | null>(null)
  const [open, setOpen] = useState(false)
  const [missing, setMissing] = useState(false)
  if (shared || !scope?.workspaceId || kind === null || missing) return <>{children ?? path}</>
  const url = mediaUrl(scope.workspaceId, path)
  const gone = () => { setHover(null); setOpen(false); setMissing(true) }
  const name = workspacePath(path)
  const show = (event: React.SyntheticEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const below = rect.bottom + 8 + 280 <= window.innerHeight - 12
    setHover({ x: Math.max(12, Math.min(rect.left, window.innerWidth - 372)), ...(below ? { top: rect.bottom + 8 } : { bottom: window.innerHeight - rect.top + 8 }) })
  }
  return (
    <>
      <button type="button" className="media-chip" title={`${name} — click to open`} onMouseEnter={show} onMouseLeave={() => setHover(null)}
              onFocus={show} onBlur={() => setHover(null)} onClick={() => { setHover(null); setOpen(true) }} data-testid="media-chip">
        <ImageIcon size={12} /><span className="media-chip-name">{children ?? name}</span>{kind === 'video' && <span className="media-chip-kind">video</span>}
      </button>
      {hover && createPortal(
        <div className="media-hover" style={{ left: hover.x, top: hover.top, bottom: hover.bottom }} data-testid="media-hover">
          {kind === 'image' ? <img src={url} alt={name} onError={gone} /> : <video src={url} muted autoPlay loop playsInline onError={gone} />}
        </div>, document.body)}
      {open && <Viewer url={url} kind={kind} label={name} onClose={() => setOpen(false)} onError={gone} />}
    </>
  )
}

/** A picture of the working folder written into the answer as an image: shown, and opened whole on a click. */
export function WorkspaceImage({ path, alt }: { path: string; alt: string }) {
  const scope = useContext(RunScope)
  const shared = useSharePresentation()
  const [open, setOpen] = useState(false)
  const kind = mediaKind(path)
  if (shared || !scope?.workspaceId || kind === null) return alt ? <span className="prose-img-missing" title={path}>{alt}</span> : null
  if (kind === 'video') return <MediaChip path={path}>{alt || undefined}</MediaChip>
  const url = mediaUrl(scope.workspaceId, path)
  return (
    <>
      <button type="button" className="prose-img-link" title={`${alt || workspacePath(path)} — click to open`} onClick={() => setOpen(true)} data-testid="workspace-image">
        <img className="prose-img" src={url} alt={alt} loading="lazy" />
      </button>
      {open && <Viewer url={url} kind="image" label={alt || workspacePath(path)} onClose={() => setOpen(false)} />}
    </>
  )
}
