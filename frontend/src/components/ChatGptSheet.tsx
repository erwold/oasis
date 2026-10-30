import { useEffect, useState } from 'react'
import { chatGptPlacer, chatGptReloader } from '../state/desktop'
import { chatGptStatus, chatGptWarning } from '../state/chatgpt'
import { useStore } from '../state/store'
import type { DirectorSession } from '../api/types'
import { ChatGptPage } from './ChatGptPage'
import { RefreshIcon, XIcon } from './icons'
import openaiLogo from '../assets/logo-openai.png'

/** The ChatGPT page in the middle of the window: to sign in, to @-mention oasis-code once when ChatGPT directs the
 *  session (the app learns the connector from that message), or to look at the conversation where there is no card
 *  for it (the start screen). It says what is missing and closes by itself once nothing is. In a session it offers
 *  ChatGPT as the session's director (`DirectButton`). */
export function ChatGptSheet() {
  const open = useStore((s) => s.chatGptSheet)
  const setOpen = useStore((s) => s.setChatGptSheet)
  const directing = useStore((s) => directedByChatGpt(s.session?.director))
  // read when shown: the shell's bridge is the same function every time, so the page's placement stays put
  const place = open ? chatGptPlacer(window as { oasisCodeDesktop?: unknown }) : null
  const [warning, setWarning] = useState<ReturnType<typeof chatGptWarning>>(null)
  useEffect(() => {
    if (!open) return
    let alive = true
    let warned = false
    const read = () => {
      void chatGptStatus(window as { oasisCodeDesktop?: unknown }).then((s) => {
        if (!alive) return
        // the connector matters to ChatGPT directing (it reaches the harness through it); a participant needs none
        const found = chatGptWarning(s)
        const next = found === 'connector' && !directing ? null : found
        setWarning(next)
        // opened for what was missing: gone once it is not (signed in, the connector learnt)
        if (next) warned = true
        else if (warned) setOpen(false)
      }, () => undefined)
    }
    read()
    const timer = window.setInterval(read, 3000)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => { alive = false; window.clearInterval(timer); window.removeEventListener('keydown', onKey) }
  }, [open, setOpen, directing])
  if (!open || !place) return null
  const say = warning === 'signin' ? 'Sign in to ChatGPT here. oasis-code sends your words to this page as you write them.'
    : warning === 'connector' ? 'Once, so oasis-code knows the connector: type @ here, pick oasis-code, and send any word.'
    : 'Your ChatGPT, as oasis-code uses it.'
  return (
    <div className="chatgpt-sheet-backdrop" data-testid="chatgpt-sheet">
      <section className="chatgpt-sheet" role="dialog" aria-label="ChatGPT">
        <header className="chatgpt-sheet-head">
          <img src={openaiLogo} alt="" width={16} height={16} />
          <span className="chatgpt-sheet-title">ChatGPT</span>
          <span className={`chatgpt-sheet-say${warning ? ' warn' : ''}`} data-testid="chatgpt-sheet-say">{say}</span>
          <ReloadButton />
          <DirectButton />
          <button className="icon-btn" title="Close" onClick={() => setOpen(false)} data-testid="chatgpt-sheet-close"><XIcon size={13} /></button>
        </header>
        <div className="chatgpt-sheet-body"><ChatGptPage place={place} /></div>
      </section>
    </div>
  )
}

/** Whether ChatGPT directs the session (its director is the bridge, open). */
export function directedByChatGpt(director: Pick<DirectorSession, 'transport' | 'state'> | null | undefined): boolean {
  return !!director && director.transport === 'bridge' && director.state !== 'closed'
}

/** ChatGPT as the session's director, one click away where its page shows (this sheet, the desk's ChatGPT card): the
 *  words then go to ChatGPT with the oasis-code connector, and it has agents do the work. Offered only to a session
 *  with no director — never in place of one that directs already (its plans and its turns stay its own). */
export function DirectButton() {
  const session = useStore((s) => s.session)
  const directWithChatGpt = useStore((s) => s.directWithChatGpt)
  const showToast = useStore((s) => s.showToast)
  const [busy, setBusy] = useState(false)
  if (!session || (session.director && session.director.state !== 'closed')) return null
  return (
    <button type="button" className="icon-btn desk-text-btn" disabled={busy} data-testid="chatgpt-direct"
            title="Let ChatGPT direct this session: your words then go to it with the oasis-code connector, and it has agents do the work"
            onClick={() => { setBusy(true); void directWithChatGpt().catch((e) => showToast(e instanceof Error ? e.message : String(e))).finally(() => setBusy(false)) }}>
      Direct
    </button>
  )
}

/** The ChatGPT page loaded again (one that did not load retries by itself too); none outside the desktop app. */
export function ReloadButton() {
  const reload = chatGptReloader(window as { oasisCodeDesktop?: unknown })
  if (!reload) return null
  return (
    <button type="button" className="icon-btn" title="Reload the ChatGPT page" aria-label="Reload the ChatGPT page" data-testid="chatgpt-reload" onClick={() => { void reload() }}>
      <RefreshIcon size={12} />
    </button>
  )
}
