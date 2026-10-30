import { useEffect, useState } from 'react'
import { sshApi, type SshAsk } from '../api/ssh'
import { useSsh } from '../state/ssh'
import { useStore } from '../state/store'
import { AskButton, AskCapsule, AskSpinner } from './AskCapsule'
import { ServerIcon } from './icons'

/** What a question says, read from its words: the verb, where it connects, the name the asker gave, the identity file
 *  and the new host keys (ED25519 first: the one people compare). */
export function readAsk(ask: Pick<SshAsk, 'title' | 'lines'>): { verb: string; where: string; name: string; identity: string | null; keys: { type: string; fingerprint: string }[] } {
  const [where = '', ...rest] = ask.lines
  const named = /^(Connect to|Reconnect to) (.*)\?$/.exec(ask.title)
  const keys: { type: string; fingerprint: string }[] = []
  let identity: string | null = null
  for (const line of rest) {
    const key = /^new host key (\S+)\s+(\S+)$/.exec(line)
    if (key) keys.push({ fingerprint: key[1]!, type: key[2]! })
    else if (line.startsWith('key ')) identity = line.slice(4)
  }
  const rank = (type: string) => (type === 'ED25519' ? 0 : type === 'ECDSA' ? 1 : 2)
  keys.sort((a, b) => rank(a.type) - rank(b.type))
  return { verb: named?.[1] === 'Reconnect to' ? 'Reconnect' : 'Connect', where, name: named?.[2] ?? ask.title, identity, keys }
}

/** A connector's questions to save or connect an SSH host (its call waits on the person's answer), as capsules over the
 *  composer — the start screen's or a session's, wherever the person is (a session may not exist yet when it asks). A
 *  host key never trusted before opens its capsule on the fingerprints: what the person checks before the yes. */
export function SshAsks() {
  const [asks, setAsks] = useState<SshAsk[]>([])
  const [connected, setConnected] = useState<SshAsk[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const showToast = useStore((s) => s.showToast)
  useEffect(() => {
    let alive = true
    const read = () => { if (document.visibilityState !== 'hidden') void sshApi.asks().then((rows) => { if (alive) setAsks(rows) }, () => {}) }
    read()
    const timer = setInterval(read, 2000)
    return () => { alive = false; clearInterval(timer) }
  }, [])
  const shown = [...connected, ...asks.filter((a) => !connected.some((c) => c.id === a.id))]
  if (!shown.length) return null
  const answer = async (ask: SshAsk, connect: boolean) => {
    setBusy(ask.id)
    try {
      const answered = await sshApi.answer(ask.id, connect)
      if (answered.status === 'failed') showToast(answered.error ?? 'Connection failed')
      setAsks((rows) => rows.filter((r) => r.id !== ask.id))
      // the yes is seen land: a moment of Connected, then the capsule goes
      if (answered.status === 'connected') {
        setConnected((rows) => [...rows, ask])
        window.setTimeout(() => setConnected((rows) => rows.filter((r) => r.id !== ask.id)), 1200)
      }
      void useSsh.getState().refresh()
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="ask-caps" data-testid="ssh-asks">
      {shown.map((ask, i) => {
        const read = readAsk(ask)
        const done = connected.some((c) => c.id === ask.id)
        const details = [
          ...read.keys.map((k) => ({ label: `New ${k.type} host key`, value: k.fingerprint, testId: 'ssh-ask-key' })),
          ...(read.identity ? [{ label: 'Key file', value: read.identity }] : []),
          ...(read.name !== read.where ? [{ label: 'Name', value: read.name }] : []),
        ]
        const isOpen = open[ask.id] ?? read.keys.length > 0
        return (
          <AskCapsule key={ask.id} testId="ssh-ask" id={ask.id} index={i} title={ask.title} done={done ? 'Connected' : null}
                      mark={busy === ask.id ? <AskSpinner /> : <ServerIcon size={14} />} label={<>{read.verb} <b>{read.where}</b></>} from={ask.from}
                      open={isOpen} onToggle={() => setOpen((o) => ({ ...o, [ask.id]: !isOpen }))} details={details}
                      actions={<>
                        <AskButton primary busy={busy === ask.id} onClick={() => void answer(ask, true)} testId="ssh-ask-connect">{busy === ask.id ? 'Connecting…' : 'Connect'}</AskButton>
                        <AskButton busy={busy === ask.id} onClick={() => void answer(ask, false)} testId="ssh-ask-decline">Cancel</AskButton>
                      </>} />
        )
      })}
    </div>
  )
}
