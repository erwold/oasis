import { useEffect, useRef, useState } from 'react'
import { chatGptSendingResumer, chatGptStatusOf, sendLogNotice, type ChatGptPlace, type SendLogState } from '../state/desktop'
import { useStore } from '../state/store'
import { usePlacement } from './usePlacement'

/** The ChatGPT card's body: the desktop shell draws the signed-in ChatGPT page over it (usePlacement). Under the
 *  page the body says what shows when the page does not: a page that did not load (and why), or one still loading.
 *  Above the page, outside it, a send log that was damaged says sending is paused, with the way to resume it. */
export function ChatGptPage({ place }: { place: (p: ChatGptPlace) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [journal, setJournal] = useState<SendLogState | null>(null)
  // whether the page loaded and the send log is usable, read every few seconds (the shell keeps a page that did not
  // load off the card)
  useEffect(() => {
    const read = chatGptStatusOf(window as { oasisCodeDesktop?: unknown })
    if (!read) return
    let alive = true
    const tick = () => { void read({ load: false }).then((s) => { if (alive) { setLoadError(s?.load_error ?? null); setJournal(s?.journal ?? null) } }, () => undefined) }
    tick()
    const timer = window.setInterval(tick, 3000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [])
  const shown = usePlacement(ref, place)
  return (
    <>
      <SendLogNotice journal={journal} onChange={setJournal} />
      <div ref={ref} className="chatgpt-page" data-testid="chatgpt-page" data-shown={shown ? 'yes' : 'no'}>
        <p className="chatgpt-page-hint" data-testid="chatgpt-page-hint">
          {loadError ? `The ChatGPT page did not load (${loadError}). It loads again by itself — or reload it with ↻ above.`
            : shown ? 'Loading the ChatGPT page…' : 'The ChatGPT page shows here when nothing covers the card.'}
        </p>
      </div>
    </>
  )
}

/** Sending paused by the send log: what happened and, for a damaged log, "Resume sending" — the messages whose fate
 *  is not known stay unsent, so the person checks the page first. */
function SendLogNotice({ journal, onChange }: { journal: SendLogState | null; onChange: (j: SendLogState) => void }) {
  const resume = chatGptSendingResumer(window as { oasisCodeDesktop?: unknown })
  const showToast = useStore((s) => s.showToast)
  const [busy, setBusy] = useState(false)
  const notice = sendLogNotice(journal)
  if (!notice) return null
  const go = () => {
    if (!resume) return
    setBusy(true)
    void resume().then((out) => {
      if (!out) return
      onChange(out.journal)
      if (!out.resumed) showToast(`Sending did not resume: ${out.reason ?? 'refused'}`)
    }, (error: unknown) => showToast(error instanceof Error ? error.message : String(error))).finally(() => setBusy(false))
  }
  return (
    <div className="chatgpt-journal" role="alert" data-testid="chatgpt-send-log">
      <span>{notice.text}</span>
      {notice.resumable && resume && (
        <button type="button" className="btn tiny" disabled={busy} data-testid="chatgpt-resume-sending"
                title={journal?.state === 'damaged' ? `The damaged log (${journal.file}) is kept; the messages it names are not sent again` : undefined}
                onClick={go}>Resume sending</button>
      )}
    </div>
  )
}
