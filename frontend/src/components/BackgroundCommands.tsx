import type { BackgroundCommand, OutputWindow } from '@oasis-code/contract'
import { useEffect, useState } from 'react'
import { api } from '../api/client'
import { backgroundLabel, backgroundStatus, commandLine, readTail, selectBackgroundCommands } from '../state/backgroundCommands'
import { useStore } from '../state/store'
import { terminalStatus, terminalText } from '../state/terminalOutput'
import { revealRun } from './Desk'
import { ChevronDownIcon, ChevronRightIcon, StopIcon, TerminalIcon } from './icons'

/** How often the one command opened in the list has its output read again (only while it is open). */
const OUTPUT_EVERY_MS = 2000

type Stream = 'stdout' | 'stderr'

/** The thread header's terminal count: the session's commands still running after the runs that started them ended
 *  (SessionDetail.background_commands, read again on the session's own ticker). Pressed, each command with its state,
 *  its latest output on asking, its run's card, and Stop. Nothing when there are none; it never blocks the composer. */
export function BackgroundCommands() {
  const commands = useStore(selectBackgroundCommands)
  const sessionId = useStore((s) => s.session?.id ?? null)
  const replaying = useStore((s) => s.replaying)
  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState<string | null>(null)
  // another session: the list of the place left closes (its commands are not this one's)
  useEffect(() => { setOpen(false); setPicked(null) }, [sessionId])
  const count = commands.length
  useEffect(() => { if (count === 0) { setOpen(false); setPicked(null) } }, [count])
  // Escape closes the list, wherever the focus is
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])
  if (replaying || count === 0) return null
  const label = backgroundLabel(commands)
  return (
    <div className="picker bg-commands">
      <button type="button" className={`icon-btn bg-commands-btn${open ? ' on' : ''}`} aria-label={label} title={label} aria-haspopup="dialog" aria-expanded={open}
              data-testid="background-commands" data-count={count} onClick={() => setOpen((v) => !v)}>
        <TerminalIcon size={13} /><span className="bg-commands-count" aria-hidden="true">{count}</span>
      </button>
      {open && <>
        <div className="picker-backdrop" onClick={() => setOpen(false)} />
        <div className="picker-popover bg-commands-menu" role="dialog" aria-label="Background commands" data-testid="background-commands-menu">
          {commands.map((c) => (
            <BackgroundRow key={c.execution_id} command={c} open={picked === c.execution_id}
                           onToggle={() => setPicked((p) => (p === c.execution_id ? null : c.execution_id))} />
          ))}
        </div>
      </>}
    </div>
  )
}

function BackgroundRow({ command, open, onToggle }: { command: BackgroundCommand; open: boolean; onToggle: () => void }) {
  const stopExecution = useStore((s) => s.stopExecution)
  const showToast = useStore((s) => s.showToast)
  const [stopping, setStopping] = useState(false)
  const stop = async () => {
    setStopping(true)
    try { await stopExecution(command.execution_id) } catch (e) { showToast(e instanceof Error ? e.message : String(e)) } finally { setStopping(false) }
  }
  const running = command.status === 'running'
  return (
    <div className={`bg-command${open ? ' open' : ''}`} data-testid={`background-command-${command.execution_id}`} data-status={command.status}>
      <div className="bg-command-head">
        <button type="button" className="bg-command-line" aria-expanded={open} title={`${command.command}\n${command.execution_id}`}
                onClick={onToggle} data-testid="background-command-output-toggle">
          {open ? <ChevronDownIcon size={11} /> : <ChevronRightIcon size={11} />}
          <code className="bg-command-text">{commandLine(command.command)}</code>
          <span className={`bg-command-status${running ? ' running' : ''}`} data-testid="background-command-status">{backgroundStatus(command.status)}</span>
        </button>
        {command.run_id && <button type="button" className="thread-btn bg-command-act" title="The run that started it: its card, with its terminal" onClick={() => revealRun(command.run_id!)} data-testid="background-command-run">Run</button>}
        <button type="button" className="thread-btn danger bg-command-act" disabled={stopping} title="Stop this command" aria-label={`Stop ${commandLine(command.command, 40)}`}
                onClick={() => void stop()} data-testid="background-command-stop"><StopIcon size={10} />{stopping ? 'Stopping…' : 'Stop'}</button>
      </div>
      {open && <CommandOutput executionId={command.execution_id} />}
    </div>
  )
}

/** The command's latest output, read again while it is open (one command at a time). */
function CommandOutput({ executionId }: { executionId: string }) {
  const [stream, setStream] = useState<Stream>('stdout')
  const [out, setOut] = useState<OutputWindow | null>(null)
  // a read that failed: said in a line, never left at "loading…" (the next read that succeeds clears it)
  const [failed, setFailed] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    // one read at a time: a slow log is never asked again while its last read is still on its way
    let reading = false
    setOut(null)
    setFailed(null)
    const load = () => {
      if (reading) return
      reading = true
      readTail(api.output, executionId, stream)
        .then((o) => { if (alive && o.execution_id === executionId && o.stream === stream) { setOut(o); setFailed(null) } },
          (e: unknown) => { if (alive) setFailed(`Could not read the output: ${e instanceof Error ? e.message : String(e)}`) })
        .finally(() => { reading = false })
    }
    load()
    const timer = window.setInterval(load, OUTPUT_EVERY_MS)
    return () => { alive = false; window.clearInterval(timer) }
  }, [executionId, stream])
  return (
    <div className="bg-command-output" data-testid="background-command-output" data-stream={stream}>
      <div className="seg small">
        {(['stdout', 'stderr'] as Stream[]).map((which) => (
          <button key={which} type="button" className={stream === which ? 'on' : ''} onClick={() => setStream(which)} data-testid={`background-command-${which}`}>{which}</button>
        ))}
        {out && <span className="dim small"> {terminalStatus(out)}</span>}
      </div>
      {failed && !out ? <p className="err small" role="alert" data-testid="background-command-output-error">{failed}</p>
        : <pre className="terminal">{terminalText(out, stream, 0)}</pre>}
      {failed && out && <p className="err small" role="alert" data-testid="background-command-output-error">{failed}</p>}
    </div>
  )
}
