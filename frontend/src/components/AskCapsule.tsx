import type { ReactNode } from 'react'
import { CheckIcon, ChevronDownIcon } from './icons'

/** A row under a capsule's line: a value the person checks (code), or a sentence that says what an answer does (prose). */
export interface AskDetail { label: string; value: string; testId?: string; prose?: boolean }

/** One question that waits on the person, as a capsule over the composer (SSH hosts, Full access): a line — a mark, what
 *  is asked, who asks, the answers, a chevron — and the details under it, open by default when they are what the person
 *  checks before answering. Answered, a moment of its outcome. */
export function AskCapsule({ testId, id, mark, label, from, actions, done, open, onToggle, details, index = 0, title }: {
  testId: string; id: string; mark: ReactNode; label: ReactNode; from?: ReactNode; actions: ReactNode
  done: string | null; open: boolean; onToggle: () => void; details: AskDetail[]; index?: number; title: string
}) {
  const isOpen = done === null && open && details.length > 0
  return (
    <section className={`ask-cap${isOpen ? ' open' : ''}`} style={{ animationDelay: `${index * 80}ms` }} data-testid={testId} data-ask-id={id}
             data-state={done === null ? 'pending' : 'answered'} aria-label={title}>
      <div className="ask-cap-head" onClick={onToggle}>
        <span className={`ask-cap-badge${done !== null ? ' ok' : ''}`}>{done !== null ? <CheckIcon size={13} /> : mark}</span>
        <span className="ask-cap-label">{label}</span>
        {from && <span className="ask-cap-from">{from}</span>}
        {done !== null ? <span className="ask-cap-pill">{done}</span> : <span className="ask-cap-actions" onClick={(e) => e.stopPropagation()}>{actions}</span>}
        {details.length > 0 && <button className="ask-cap-toggle" aria-expanded={isOpen} aria-label="Details" onClick={(e) => { e.stopPropagation(); onToggle() }} data-testid={`${testId}-toggle`}><ChevronDownIcon size={15} /></button>}
      </div>
      <div className="ask-cap-detail" aria-hidden={!isOpen}>
        <div>
          <div className="ask-cap-steps">
            <span className="ask-cap-rail" aria-hidden="true" />
            <div className="ask-cap-rows">
              {details.map((d) => <div key={`${d.label}:${d.value}`} className={`ask-cap-row${d.prose ? ' prose' : ''}`} data-testid={d.testId}><span>{d.label}</span>{d.prose ? <p>{d.value}</p> : <code>{d.value}</code>}</div>)}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

/** A capsule's answer buttons. */
export function AskButton({ primary = false, busy, onClick, testId, children }: { primary?: boolean; busy: boolean; onClick: () => void; testId: string; children: ReactNode }) {
  return <button className={`ask-cap-btn${primary ? ' primary' : ''}`} disabled={busy} onClick={onClick} data-testid={testId}>{children}</button>
}

/** What a capsule's mark shows while the answer is on its way. */
export function AskSpinner() { return <span className="ask-cap-spin" /> }
