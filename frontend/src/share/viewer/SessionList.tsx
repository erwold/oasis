/** A task's sessions in a share's page, as the app's rail lists them (RailSessionButton: the bots stacked, the title,
 *  a member indented under the task's first session, a dot while one works): a click shows that session here — the
 *  page's own choice, nothing asked of anyone. Drawn only when the share holds more than one session. */

import { useLayoutEffect, useRef, type RefObject } from 'react'
import { cleanTitle } from '../../state/shareHtml'
import { RailSessionButton } from '../../components/RailBots'
import type { BotStill } from '../../components/BotImage'
export { shownSession } from '../team'

export interface ShareSessionEntry { key: string; title: string; bots: readonly string[]; member: boolean; active?: boolean }

export function SessionList({ sessions, selected, onSelect, botStill }: {
  sessions: readonly ShareSessionEntry[]; selected: string | null; onSelect: (key: string) => void
  /** the stills the page carries (the list stands outside any thread's presentation) */
  botStill: BotStill
}) {
  return (
    <div className="sidebar-shell share-rail">
      <aside className="sidebar" data-testid="share-sessions" aria-label="Sessions">
        <div className="rail-scroll">
          {sessions.map((s) => (
            <div key={s.key} className={`rail-session-row${s.member ? ' rail-member' : ''}`} data-member={s.member || undefined}>
              <RailSessionButton title={cleanTitle(s.title)} bots={s.bots} on={s.key === selected} onClick={() => onSelect(s.key)} testId={`share-session-${s.key}`}
                                 dot={s.active ? 'running' : null} dotTestId={`share-session-dot-${s.key}`} botStill={botStill} />
            </div>
          ))}
        </div>
      </aside>
    </div>
  )
}

/** Each session keeps where its thread was scrolled to while another is shown (the page's memory only); `scope`
 *  changing (a live link's new epoch: its keys may name other sessions now) forgets every place. */
export function useKeptScroll(ref: RefObject<HTMLElement | null>, key: string | null, scope = ''): void {
  const kept = useRef<{ scope: string; at: Map<string, number> }>({ scope, at: new Map() })
  if (kept.current.scope !== scope) kept.current = { scope, at: new Map() }
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || key === null) return
    const places = kept.current.at
    el.scrollTop = places.get(key) ?? 0
    const save = () => { places.set(key, el.scrollTop) }
    el.addEventListener('scroll', save, { passive: true })
    return () => el.removeEventListener('scroll', save)
  }, [ref, key, scope])
}
