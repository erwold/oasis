import { useExecutionTarget } from './SshTarget'
import { useEffect, useRef, useState } from 'react'
import { ACCESS_LABELS, ACCESS_MODES, type AccessMode } from '@oasis-code/contract/modes'
import { blockedHint, sessionAccess } from '../state/access'
import { useStore } from '../state/store'
import { ChevronDownIcon } from './icons'

/** Where the agent's commands run, shown only for an open session in the sandbox (the person chose it at the first
 *  command's question, or an older connector made it so): the way back to Full access. A Full session — every new one —
 *  shows nothing. Changed only while nothing of the session is outstanding; the harness's answer is what shows.
 *  Independent of the session's mode (auto / ask / plan), which it never changes. */
export function AccessChip() {
  const remote = useExecutionTarget().kind !== 'local'
  const [open, setOpen] = useState(false)
  const session = useStore((s) => s.session)
  const access = useStore((s) => s.access)
  const saving = useStore((s) => s.accessSaving)
  const chooseAccess = useStore((s) => s.chooseAccess)
  const loadAccess = useStore((s) => s.loadAccess)
  const current: AccessMode | null = session ? sessionAccess(session) : null
  // what holds the session's access now, as the harness last said it (for this session only)
  const blocked = session && access?.session_id === session.id && !access.switchable ? (blockedHint(access.blocked_by) ?? 'Not now.') : null
  const button = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); setOpen(false); button.current?.focus() } }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])
  // another session: the menu of the place left closes
  useEffect(() => { setOpen(false) }, [session?.id])
  const toggle = () => {
    // opening asks the harness again (a run or a command may have ended since): one read, never a timer
    if (!open) void loadAccess()
    setOpen((v) => !v)
  }
  const choose = (mode: AccessMode) => {
    setOpen(false)
    if (mode === current) return
    void chooseAccess(mode)
  }
  // shown while the session is in the sandbox, and while its menu is open (choosing Full closes it)
  if (current === null || (current === 'full' && !open)) return null
  return (
    <div className="picker">
      <button ref={button} className={`composer-chip access-chip${current === 'full' ? ' access-full' : ''}`} onClick={toggle} data-testid="access-chip" data-access={current}
              aria-haspopup="listbox" aria-expanded={open} aria-label={`Access: ${ACCESS_LABELS[current]}`} title={blocked ?? undefined} disabled={saving}>
        <span className="picker-current" data-testid="access-current">{ACCESS_LABELS[current]}</span><ChevronDownIcon size={12} />
      </button>
      {open && <>
        <div className="picker-backdrop" onClick={() => setOpen(false)} />
        <div className="picker-popover" role="listbox" aria-label="Access" data-testid="access-menu">
          {ACCESS_MODES.map((mode) => {
            const disabled = (remote && mode === 'sandbox') || (mode !== current && (!!blocked || saving))
            return (
              <button key={mode} role="option" aria-selected={current === mode} aria-disabled={disabled || undefined} disabled={disabled}
                      className={`picker-row${current === mode ? ' selected' : ''}${disabled ? ' disabled' : ''}`} title={disabled && blocked ? blocked : undefined}
                      onClick={() => choose(mode)} data-testid={`access-option-${mode}`}>
                <span className="picker-label">{ACCESS_LABELS[mode]}</span>
              </button>
            )
          })}
        </div>
      </>}
    </div>
  )
}
