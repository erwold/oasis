import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { useDesk } from '../state/desk'
import type { DeskWindow, ResizeEdge } from '../state/desk'
import { XIcon } from './icons'
import { DeskButtons, DeskFrame } from './DeskFrame'

const RESIZE_EDGES: ResizeEdge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']

/** One card of the desk (carried from oasis components/FloatingWindow.tsx, see NOTICE). Where it sits is the
 *  desk's decision (`x`, `y`, `depth`): the card only draws itself there, glides when the place changes, and
 *  reports the gestures on its title bar and its edges — a press (a drag of the stack starts), a click (the card
 *  comes to the front), a double click (expand). Expanded, it fills the desk. */
export function FloatingWindow({ win, x, y, w, h, depth, collapsed, dragging, resizing, title, icon, meta, actions, closable, onClose,
                                 onTitlePointerDown, onResizePointerDown, children, bodyClass, elRef, testId, accent }: {
  win: DeskWindow
  x: number
  y: number
  w: number
  h: number
  depth: number
  /** a title strip in a column: only the title bar shows */
  collapsed?: boolean
  dragging?: boolean
  /** a resize is on: the size (and the place) follow the hand with no easing */
  resizing?: boolean
  title: ReactNode
  icon?: ReactNode
  meta?: ReactNode
  /** the card's own controls, in the title bar before the window buttons */
  actions?: ReactNode
  closable?: boolean
  onClose?: () => void
  onTitlePointerDown?: (e: ReactPointerEvent<HTMLDivElement>) => void
  /** a press on one of the card's edges or corners */
  onResizePointerDown?: (e: ReactPointerEvent<HTMLDivElement>, edge: ResizeEdge) => void
  bodyClass?: string
  children: ReactNode
  /** the desk moves the element itself while a drag is on (no render per frame) */
  elRef?: (el: HTMLElement | null) => void
  testId?: string
  /** the colour of the agent the card shows: a narrow line at the card's edge (its identity, as on its lane) */
  accent?: string
}) {
  const expanded = useDesk((s) => s.expanded === win.id)
  const focus = useDesk((s) => s.focus)
  const setMin = useDesk((s) => s.setMin)
  const expand = useDesk((s) => s.expand)
  return (
    <DeskFrame kind={win.kind} id={win.id} depth={depth} expanded={expanded} collapsed={collapsed} dragging={dragging} resizing={resizing} accent={accent}
               style={expanded ? undefined : { transform: `translate3d(${x}px, ${y}px, 0)`, width: w, height: h, zIndex: win.z }} elRef={elRef} testId={testId}
               title={title} icon={icon} meta={meta} actions={actions} bodyClass={bodyClass}
               controls={<>
                 <DeskButtons expanded={expanded} onShelve={() => setMin(win.id, true)} onExpand={() => expand(expanded ? null : win.id)} />
                 {closable && <button className="icon-btn" title="Close" onClick={onClose} data-testid="card-close"><XIcon size={12} /></button>}
               </>}
               // a press on the title brings the card forward at once (the drag that may follow leads with it); a press
               // anywhere else waits for the click, so a card moving under the pointer never loses its buttons
               onPointerDown={(e) => { const at = e.target as HTMLElement; if (at.closest('.desk-title') && !at.closest('.icon-btn')) focus(win.id) }}
               onClick={(e) => { if (!(e.target as HTMLElement).closest('.desk-title')) focus(win.id) }}
               onTitlePointerDown={(e) => { if (!expanded && !(e.target as HTMLElement).closest('.icon-btn')) onTitlePointerDown?.(e) }}
               onTitleDoubleClick={() => expand(expanded ? null : win.id)}
               after={!expanded && depth === 0 && !collapsed && onResizePointerDown && RESIZE_EDGES.map((edge) => (
                 <div key={edge} className={`desk-resize desk-resize-${edge}`} onPointerDown={(e) => onResizePointerDown(e, edge)} />
               ))}>
      {children}
    </DeskFrame>
  )
}
