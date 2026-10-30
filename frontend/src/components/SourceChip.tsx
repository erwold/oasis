import { useEffect, useState, type ComponentProps, type CSSProperties } from 'react'
import { linkTarget } from '../state/highlight'
import { STATUS_WORDS, hostOf, markOf, siteIconByHostUrl, siteIconUrl, siteIconsOf, siteOf, type WebSource } from '../state/sources'
import { useStore } from '../state/store'
import { useSharePresentation } from './ThreadPresentation'

/** Whether a site's icon could be had, by its URL: asked once per page load, whatever the number of chips. */
const iconLoads = new Map<string, Promise<boolean>>()
function iconLoad(url: string): Promise<boolean> {
  let load = iconLoads.get(url)
  if (!load) {
    load = new Promise((resolve) => {
      const img = new Image()
      img.onload = () => resolve(img.naturalWidth > 0)
      img.onerror = () => resolve(false)
      img.src = url
    })
    iconLoads.set(url, load)
  }
  return load
}

/** A site's mark: the site's own icon — kept when a run of the session read one of its pages, else asked of the
 *  site itself through the harness (no icon service is asked) — and its letter on a colour drawn from its name until
 *  the icon shows, or when the site has none. */
export function SourceMark({ host, size = 12 }: { host: string; size?: number }) {
  // the share's copy asks no site for its icon: the letter mark only
  const shared = useSharePresentation()
  const sessionId = useStore((s) => (shared ? undefined : s.session?.id))
  const icon = useStore((s) => (shared ? undefined : siteIconsOf(s.threads).get(siteOf(host))))
  const [broken, setBroken] = useState(false)
  const byHost = sessionId && host && !icon ? siteIconByHostUrl(sessionId, host) : null
  const [loaded, setLoaded] = useState<string | null>(null)
  useEffect(() => {
    if (!byHost) return
    let alive = true
    void iconLoad(byHost).then((ok) => { if (alive && ok) setLoaded(byHost) })
    return () => { alive = false }
  }, [byHost])
  if (sessionId && icon && !broken) return <img className="source-mark source-icon" src={siteIconUrl(sessionId, icon)} alt="" aria-hidden width={size} height={size} draggable={false} onError={() => setBroken(true)} data-testid="source-icon" />
  if (byHost && loaded === byHost) return <img className="source-mark source-icon" src={byHost} alt="" aria-hidden width={size} height={size} draggable={false} data-testid="source-icon" />
  const { letter, hue } = markOf(host)
  return <span className="source-mark" aria-hidden style={{ '--mark-hue': hue, width: size, height: size, fontSize: Math.round(size * 0.6) } as CSSProperties}>{letter}</span>
}

/** A link in the agent's words, as a source chip: the site's mark and name, the full address on hover. */
export function SourceLink(props: ComponentProps<'a'>) {
  const href = props.href ?? ''
  const shared = useSharePresentation()
  const target = linkTarget(href)
  // the share's copy opens nothing: a web link is its chip with no address to follow (where it pointed on hover)
  if (shared) {
    if (target !== 'web') return <span className="link-inert" title={href ? `not opened: ${href}` : 'a link that was not kept'} data-testid="link-inert">{props.children}</span>
    const host = hostOf(href)
    return <span className="source-chip" title={href} data-testid="link-inert"><SourceMark host={host} /><span className="source-host">{siteOf(host)}</span></span>
  }
  if (target === 'mail') return <a href={href} target="_blank" rel="noreferrer noopener">{props.children}</a>
  // not a page to open: its words, with where it pointed on hover, and nothing to click
  if (target === 'inert') return <span className="link-inert" title={href ? `not opened: ${href}` : 'a link that was not kept'} data-testid="link-inert">{props.children}</span>
  const text = typeof props.children === 'string' ? props.children : ''
  const host = hostOf(href)
  return (
    <a className="source-chip" href={href} target="_blank" rel="noreferrer noopener" title={text && text !== href ? `${text} · ${href}` : href}>
      <SourceMark host={host} />
      <span className="source-host">{siteOf(host)}</span>
    </a>
  )
}

/** Under an agent turn: the pages it used — folded to the sites' marks and a count; open, one row per page with
 *  how the fetch went (a page it read without trouble says nothing more) and the site. */
export function SourcesRow({ sources }: { sources: WebSource[] }) {
  const [open, setOpen] = useState(false)
  const shared = useSharePresentation()
  const hosts = [...new Set(sources.map((s) => s.host))]
  return (
    <div className={`sources${open ? ' open' : ''}`} data-testid="sources">
      <button type="button" className="sources-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)} title={hosts.map(siteOf).join(', ')}>
        <span className="source-stack">{hosts.slice(0, 4).map((h) => <SourceMark key={h} host={h} size={14} />)}</span>
        <span>{sources.length} source{sources.length === 1 ? '' : 's'}</span>
      </button>
      {open && (
        <ul className="sources-list">
          {sources.map((s) => (
            <li key={s.url}>
              {shared
                // the share's copy: the same row, an anchor with no address (nothing to open)
                ? <a title={s.url} data-testid="link-inert"><SourceMark host={s.host} size={16} /><span className="source-label">{s.label}</span>
                    {s.status !== 'stored' && <span className={`source-status st-${s.status}`}>{STATUS_WORDS[s.status]}</span>}<span className="source-site">{siteOf(s.host)}</span></a>
                : <a href={s.url} target="_blank" rel="noreferrer noopener" title={[s.url, s.purpose, s.assetId].filter(Boolean).join('\n')}>
                    <SourceMark host={s.host} size={16} />
                    <span className="source-label">{s.label}</span>
                    {s.status !== 'stored' && <span className={`source-status st-${s.status}`}>{STATUS_WORDS[s.status]}</span>}
                    <span className="source-site">{siteOf(s.host)}</span>
                  </a>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
