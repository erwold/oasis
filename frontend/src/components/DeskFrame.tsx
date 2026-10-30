import type { CSSProperties, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import type { DeskKind } from '../state/desk'
import { MaximizeIcon, MinusIcon } from './icons'

export const RestoreIcon = ({ size = 12 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3" />
  </svg>
)

/** A desk card as it is drawn (FloatingWindow.tsx's look, apart from the desk): its frame, its title bar — icon, name,
 *  meta, its own actions, the window buttons — and its body. Pure: where it sits, what its gestures do and which of
 *  its buttons it has are its caller's. The app's FloatingWindow wires it to the desk; a share's page draws its one
 *  card (the Agent Teams outline) with it, still, its buttons acting on the page alone. */
export function DeskFrame({ kind, id, depth, expanded = false, collapsed = false, dragging = false, resizing = false, accent, style, elRef, testId,
                            title, icon, meta, actions, controls, bodyClass, children, after, onPointerDown, onClick, onTitlePointerDown, onTitleDoubleClick }: {
  kind: DeskKind
  id: string
  depth: number
  expanded?: boolean
  /** only the title bar shows */
  collapsed?: boolean
  dragging?: boolean
  resizing?: boolean
  /** the colour of the agent the card shows: a narrow line at the card's edge */
  accent?: string
  /** where it sits and how big it is (none: the page's stylesheet places it) */
  style?: CSSProperties
  elRef?: (el: HTMLElement | null) => void
  testId?: string
  title: ReactNode
  icon?: ReactNode
  meta?: ReactNode
  /** the card's own controls, in the title bar before the window buttons */
  actions?: ReactNode
  /** the window buttons, last in the title bar */
  controls?: ReactNode
  bodyClass?: string
  children: ReactNode
  /** drawn after the body (the resize edges) */
  after?: ReactNode
  onPointerDown?: (e: ReactPointerEvent<HTMLElement>) => void
  onClick?: (e: ReactMouseEvent<HTMLElement>) => void
  onTitlePointerDown?: (e: ReactPointerEvent<HTMLDivElement>) => void
  onTitleDoubleClick?: () => void
}) {
  const tone = accent ? { ['--c' as string]: accent } : undefined
  return (
    <section ref={elRef}
             className={`desk-win kind-${kind}${expanded ? ' expanded' : ''}${dragging ? ' dragging' : ''}${resizing ? ' resizing' : ''}${depth > 0 ? ' behind' : ' front'}${collapsed && !expanded ? ' collapsed' : ''}${accent ? ' has-accent' : ''}`}
             style={tone || style ? { ...style, ...tone } : undefined} data-depth={depth} data-id={id} data-testid={testId}
             onPointerDown={onPointerDown} onClick={onClick}>
      <div className="desk-title" onPointerDown={onTitlePointerDown} onDoubleClick={onTitleDoubleClick}>
        {icon && <span className="desk-icon">{icon}</span>}
        <span className="desk-name">{title}</span>
        {meta && <span className="desk-meta">{meta}</span>}
        <span className="desk-spacer" />
        {actions && <span className="desk-actions">{actions}</span>}
        {controls}
      </div>
      <div className={`desk-body${bodyClass ? ` ${bodyClass}` : ''}`}>{children}</div>
      {after}
    </section>
  )
}

/** The window buttons every card has: put it away (Shelve), and fill the desk with it or give it back its place. */
export function DeskButtons({ expanded, onShelve, onExpand }: { expanded: boolean; onShelve: () => void; onExpand: () => void }) {
  return (
    <>
      <button className="icon-btn" title="Shelve" onClick={onShelve} data-testid="card-shelve"><MinusIcon size={12} /></button>
      <button className="icon-btn" title={expanded ? 'Restore' : 'Expand'} onClick={onExpand} data-testid="card-expand">
        {expanded ? <RestoreIcon size={12} /> : <MaximizeIcon size={12} />}
      </button>
    </>
  )
}

/** What the Agent Teams card's title says beside its name: how many agents, how many of them live. */
export const teamsMeta = (agents: number, live: number): string => `${agents} agent${agents === 1 ? '' : 's'}${live ? ` · ${live} live` : ''}`
