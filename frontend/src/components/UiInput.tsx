import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { api } from '../api/client'
import { nameOf } from '../state/outline'
import { useStore } from '../state/store'
import { closedLine, formOf, inputControllers, type InputController, type InputDeps, type UiInputRecord } from '../state/uiInputs'
import { stateOf } from '../state/uiSurface'
import { NativeNode } from './UiSurface'
import { CheckIcon, LayersIcon, ServerIcon, ShieldIcon } from './icons'
import { readAsk } from './SshAsks'
import { AskButton, AskCapsule, AskSpinner, type AskDetail } from './AskCapsule'
import type { ThreadEntry } from '../state/thread'
import './UiSurface.css'

/** What a form's answers are sent with: the API, the store taking the record the harness answered. */
const inputDeps = (): InputDeps => ({
  submit: async (sessionId, inputId, body) => (await api.submitUiInput(sessionId, inputId, body)).input,
  dismiss: async (sessionId, inputId, body) => (await api.dismissUiInput(sessionId, inputId, body)).input,
  adopt: (record) => useStore.getState().adoptInput(record),
})

/** The forms brought into view on this page (each once: a form scrolled away from afterwards stays where it is). */
const revealedInputs = new Set<string>()

/** A form a run waits on (request_input), drawn with the native surface's own elements: the person fills it in and
 *  submits (the values become the waiting call's result and the run goes on) or declines. Only a pending form takes
 *  an answer; one answered or closed shows how it ended (a submitted one with the values sent). The record shown is
 *  the store's latest word on it, else the row's own. A replay shows it read-only. */
export function UiInputBlock({ record: given, who = null }: { record: UiInputRecord; who?: ReactNode }) {
  const latest = useStore((s) => s.uiInputs[given.id])
  const replaying = useStore((s) => s.replaying)
  // a replay shows the form as it stood at that moment; live, the latest word on it
  const record = !replaying && latest && latest.updated_at >= given.updated_at ? latest : given
  const form = useMemo(() => formOf(record), [record.request]) // eslint-disable-line react-hooks/exhaustive-deps
  const controller = useMemo<InputController | null>(() => (replaying ? null : inputControllers.acquire(record, inputDeps())), [record.id, replaying]) // eslint-disable-line react-hooks/exhaustive-deps
  const subscribe = useCallback((cb: () => void) => (controller ? controller.subscribe(cb) : () => undefined), [controller])
  const view = useSyncExternalStore(subscribe, () => controller?.view() ?? null, () => null)
  const pending = record.status === 'pending'
  const open = pending && !replaying && controller !== null
  const titleId = useId()
  const box = useRef<HTMLElement>(null)
  // a form that waits on the person is brought into the thread's view once on this page — the thread may be held where
  // a surface's task was started (state/threadFollow.ts) or scrolled elsewhere: it is the run's question. Its place in
  // the thread is unchanged; only the thread scrolls, and only when the form is not wholly in view above the composer.
  useEffect(() => {
    if (!pending || replaying || revealedInputs.has(record.id)) return
    const el = box.current
    const scroller = el?.closest('.thread-scroll') as HTMLElement | null
    if (!el || !scroller) return
    revealedInputs.add(record.id)
    const view = scroller.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    const dock = parseFloat(getComputedStyle(scroller.parentElement ?? scroller).getPropertyValue('--dock-h')) || 0
    const bottom = view.bottom - dock
    if (r.top >= view.top && r.bottom <= bottom) return
    const room = bottom - view.top
    scroller.scrollBy({ top: r.height < room ? r.top - view.top - (room - r.height) / 2 : r.top - view.top - 8 })
  }, [pending, replaying, record.id])
  const [focusNote, setFocusNote] = useState(false)
  useEffect(() => { if (!pending) setFocusNote(false) }, [pending])

  // a Full access question that waits is a capsule over the composer (FullAccessAsks); the thread keeps its answer
  if (isFullAccessAsk(record)) return open ? null : <FullAccessAsk record={record} />
  if (isSshConnectAsk(record)) return open ? null : <SshConnectAsk record={record} />
  if (!form.ok) {
    return (
      <section ref={box} className="uis uis-form" data-testid="ui-input" data-input-id={record.id} data-status={record.status} data-valid="false" aria-label={record.request.title}>
        <header className="uis-head"><LayersIcon size={12} /><span className="uis-name">{record.request.title}</span></header>
        <div className="uis-fallback"><p className="uis-problem" role="note">This form could not be drawn ({form.reason}).</p></div>
        <InputFooter record={record} open={open} controller={controller} phase={view?.phase ?? null} canSubmit={false} submitLabel="Submit" onSubmit={() => undefined} />
      </section>
    )
  }
  // what the form shows: the person's values while it waits; the values sent once submitted; else its defaults
  const values = pending ? (view?.values ?? stateOf(form.spec, form.request.initial_state ?? {})) : stateOf(form.spec, record.values ?? form.request.initial_state ?? {})
  const sending = view?.phase.kind === 'sending'
  const submit = () => { if (controller) void controller.submit(record, form) }
  return (
    <section ref={box} className={`uis uis-form${pending ? ' pending' : ''}`} aria-labelledby={titleId} data-testid="ui-input" data-input-id={record.id} data-run={record.run_id}
             data-tool-call={record.tool_call_id} data-status={record.status} data-valid="true"
             onKeyDown={(e) => { if (open && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit() } }} onFocus={() => setFocusNote(true)}>
      <header className="uis-head">
        <LayersIcon size={12} />
        <span className="uis-name" id={titleId}>{record.request.title}</span>
        {who && <span className="uis-who">{who}</span>}
        <span className="uis-spacer" />
        {pending && <span className="uis-tag waiting" data-testid="ui-input-waiting">{replaying ? 'waited for an answer' : 'the agent waits for your answer'}</span>}
      </header>
      {form.request.message && <p className="uis-input-message">{form.request.message}</p>}
      <form className="uis-body" onSubmit={(e) => { e.preventDefault(); submit() }} aria-describedby={view?.phase.kind === 'invalid' ? `${titleId}-errors` : undefined}>
        <fieldset className="uis-input-fields" disabled={!open || sending}>
          <NativeNode id={form.spec.root!} depth={1} ctx={{
            elements: form.spec.elements ?? {}, state: values, readOnly: !open || sending,
            setValue: (key, value) => controller?.setValue(form.spec, key, value),
            onAction: () => undefined, actions: [], action: null,
          }} />
        </fieldset>
        {/* the native submit of the form (Enter in a text field, the button below) */}
        <button type="submit" hidden tabIndex={-1} aria-hidden="true" disabled={!open || sending} />
      </form>
      {view?.phase.kind === 'invalid' && (
        <ul className="uis-input-errors" id={`${titleId}-errors`} role="alert" data-testid="ui-input-errors">
          {view.phase.errors.slice(0, 8).map((e, i) => <li key={i}>{e}</li>)}
        </ul>
      )}
      <InputFooter record={record} open={open} controller={controller} phase={view?.phase ?? null} canSubmit submitLabel={form.request.submit_label || 'Submit'} onSubmit={submit}
                   hint={open && focusNote ? '⌘/Ctrl + Enter submits' : null} />
    </section>
  )
}

function InputFooter({ record, open, controller, phase, canSubmit, submitLabel, onSubmit, hint = null }: {
  record: UiInputRecord; open: boolean; controller: InputController | null; phase: ReturnType<InputController['view']>['phase'] | null
  canSubmit: boolean; submitLabel: string; onSubmit: () => void; hint?: string | null
}) {
  const sending = phase?.kind === 'sending'
  if (!open) {
    if (record.status === 'pending') return null
    const ok = record.status === 'submitted'
    return (
      <footer className="uis-foot">
        <span className={`uis-status${ok ? ' ok' : ''}`} role="status" data-testid="ui-input-state" data-state={record.status}>{ok && <CheckIcon size={11} />} {closedLine(record)}</span>
      </footer>
    )
  }
  return (
    <footer className="uis-foot">
      <button type="button" className="thread-btn primary" disabled={!canSubmit || sending} onClick={onSubmit} data-testid="ui-input-submit">
        {sending && phase?.kind === 'sending' && phase.what === 'submit' ? 'Submitting…' : submitLabel}
      </button>
      <button type="button" className="thread-btn" disabled={sending} onClick={() => controller && void controller.dismiss(record)} data-testid="ui-input-dismiss"
              title="Decline: the agent is told you declined and goes on">
        {sending && phase?.kind === 'sending' && phase.what === 'dismiss' ? 'Declining…' : 'Decline'}
      </button>
      <span className="uis-spacer" />
      {phase?.kind === 'sending' && <span className="uis-status" role="status" data-testid="ui-input-state" data-state="sending">Sending…</span>}
      {phase?.kind === 'error' && (
        <span className="uis-status bad" role="alert" data-testid="ui-input-state" data-state="error">
          Not sent ({phase.message}) <button type="button" className="uis-link" onClick={() => (phase.what === 'submit' ? onSubmit() : controller && void controller.dismiss(record))} data-testid="ui-input-retry">Retry</button>
        </span>
      )}
      {phase?.kind === 'invalid' && <span className="uis-status bad" data-testid="ui-input-state" data-state="invalid">Check the fields above</span>}
      {phase?.kind === 'idle' && hint && <span className="uis-status">{hint}</span>}
    </footer>
  )
}

/** The forms runs not in the thread wait on (an agent's child run): over the composer, so a wait is never out of
 *  sight; each is the same form as in that agent's card. Nothing when none waits. */
export function PendingInputs() {
  const inputs = useStore((s) => s.uiInputs)
  const runs = useStore((s) => s.runs)
  const tree = useStore((s) => s.tree)
  const replaying = useStore((s) => s.replaying)
  const waiting = useMemo(() => {
    const thread = new Set(runs.map((r) => r.id))
    return Object.values(inputs).filter((i) => i.status === 'pending' && !thread.has(i.run_id) && !isFullAccessAsk(i) && !isSshConnectAsk(i)).sort((a, b) => a.created_at.localeCompare(b.created_at))
  }, [inputs, runs])
  if (replaying || waiting.length === 0) return null
  return (
    <div className="pending-inputs" data-testid="pending-inputs" aria-label="Forms agents wait on">
      {waiting.map((i) => {
        const row = tree.find((r) => r.id === i.run_id)
        return <UiInputBlock key={i.id} record={i} who={row ? nameOf(row) : 'an agent'} />
      })}
    </div>
  )
}

/** The harness's question before the first Full access command on a machine not confirmed for it (agent/ui_inputs.ts
 *  FULL_ACCESS_ASK): marked by the harness, which an agent's own form cannot be. */
function isFullAccessAsk(record: UiInputRecord): boolean {
  const harness = (record.request as { harness?: unknown }).harness
  return harness === 'full_access' || harness === 'remote_full_access'
}

/** An SSH host's folder asks it (the request's message: the host, then the folder): Full access only — there is no
 *  remote sandbox, a decline refuses the command (tools/commands.ts askFullAccess). */
function isRemoteAsk(record: UiInputRecord): boolean {
  return (record.request as { harness?: unknown }).harness === 'remote_full_access'
}

/** Where the command waited, once answered (or seen in a replay): the question and what was chosen. */
function FullAccessAsk({ record }: { record: UiInputRecord }) {
  const chosen = record.status === 'submitted' ? record.values?.access : null
  return (
    <section className="access-ask" data-testid="full-access-ask" data-input-id={record.id} data-status={record.status} aria-label={record.request.title}>
      <span className="access-ask-q">{record.request.title}</span>
      <span className="dim small" data-testid="full-access-answer">{chosen === 'full' ? 'Full access' : isRemoteAsk(record) && (chosen || record.status === 'dismissed') ? 'Declined' : chosen === 'sandbox' || record.status === 'dismissed' ? 'Sandbox' : closedLine(record)}</span>
    </section>
  )
}

/** The command a Full access question waits for, from its run's thread (the tool call it holds). */
function commandOf(threads: Record<string, ThreadEntry[]>, record: UiInputRecord): string | null {
  const call = (threads[record.run_id] ?? []).find((e) => e.kind === 'activity' && e.toolCallId === record.tool_call_id)
  const command = (call?.args as { command?: unknown } | null | undefined)?.command
  return typeof command === 'string' ? command : null
}

/** The harness's questions of this session's agents, as capsules over the composer: Full access (who asks, the two
 *  answers, the command that waits) and an agent's SSH host (what the yes connects, a new host's keys). Open on what the
 *  person reads before saying yes; answered, a moment of the choice (a Cancel just goes). */
export function HarnessAsks() {
  const inputs = useStore((s) => s.uiInputs)
  const threads = useStore((s) => s.threads)
  const tree = useStore((s) => s.tree)
  const replaying = useStore((s) => s.replaying)
  const showToast = useStore((s) => s.showToast)
  const [busy, setBusy] = useState<string | null>(null)
  const [answered, setAnswered] = useState<{ record: UiInputRecord; word: string }[]>([])
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const pending = useMemo(() => Object.values(inputs).filter((i) => i.status === 'pending' && (isFullAccessAsk(i) || isSshConnectAsk(i))).sort((a, b) => a.created_at.localeCompare(b.created_at)), [inputs])
  if (replaying) return null
  const shown = [...answered.map((a) => a.record), ...pending.filter((p) => !answered.some((a) => a.record.id === p.id))]
  if (!shown.length) return null
  /** values: the submitted answer, with the word shown a moment; null: a Cancel (dismissed, nothing shown) */
  const answer = async (record: UiInputRecord, values: Record<string, string> | null, word: string | null, key: string) => {
    setBusy(record.id)
    try {
      const deps = inputDeps()
      deps.adopt(values ? await deps.submit(record.session_id, record.id, { values, request_id: `${record.id}.${key}` })
        : await deps.dismiss(record.session_id, record.id, { request_id: `${record.id}.${key}` }))
      if (word) {
        setAnswered((rows) => [...rows, { record, word }])
        window.setTimeout(() => setAnswered((rows) => rows.filter((r) => r.record.id !== record.id)), 1200)
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="ask-caps" data-testid="harness-asks">
      {shown.map((record, i) => {
        const done = answered.find((a) => a.record.id === record.id)?.word ?? null
        const row = tree.find((r) => r.id === record.run_id)
        const from = row ? nameOf(row) : undefined
        if (isSshConnectAsk(record)) {
          const read = readAsk({ title: record.request.title, lines: (record.request.message ?? '').split('\n').filter(Boolean) })
          const details = [
            ...read.keys.map((k) => ({ label: `New ${k.type} host key`, value: k.fingerprint, testId: 'ssh-connect-key' })),
            ...(read.identity ? [{ label: 'Key file', value: read.identity }] : []),
            ...(read.name !== read.where ? [{ label: 'Name', value: read.name }] : []),
          ]
          const isOpen = open[record.id] ?? read.keys.length > 0
          return (
            <AskCapsule key={record.id} testId="ssh-connect-capsule" id={record.id} index={i} title={record.request.title} done={done}
                        mark={busy === record.id ? <AskSpinner /> : <ServerIcon size={14} />} label={<>{read.verb} <b>{read.where}</b></>} from={from}
                        open={isOpen} onToggle={() => setOpen((o) => ({ ...o, [record.id]: !isOpen }))} details={details}
                        actions={<>
                          <AskButton primary busy={busy === record.id} onClick={() => void answer(record, { connect: 'yes' }, 'Connected', 'connect')} testId="ssh-connect-allow">Connect</AskButton>
                          <AskButton busy={busy === record.id} onClick={() => void answer(record, null, null, 'decline')} testId="ssh-connect-decline">Cancel</AskButton>
                        </>} />
          )
        }
        const command = commandOf(threads, record)
        const isOpen = open[record.id] ?? true
        if (isRemoteAsk(record)) {
          const [host = '', folder = ''] = (record.request.message ?? '').split('\n')
          return (
            <AskCapsule key={record.id} testId="full-access-capsule" id={record.id} index={i} title={record.request.title} done={done}
                        mark={busy === record.id ? <AskSpinner /> : <ShieldIcon size={14} />} label={<>{record.request.title} <b>{host}</b></>} from={from}
                        open={isOpen} onToggle={() => setOpen((o) => ({ ...o, [record.id]: !isOpen }))}
                        details={[
                          ...(command ? [{ label: 'Command', value: command, testId: 'full-access-command' }] : []),
                          ...(folder ? [{ label: 'Folder', value: folder, testId: 'full-access-folder' }] : []),
                          REMOTE_FULL_ACCESS_CHOICE,
                        ]}
                        actions={<>
                          <AskButton primary busy={busy === record.id} onClick={() => void answer(record, { access: 'full' }, 'Full access', 'full')} testId="full-access-allow">Allow full access</AskButton>
                          <AskButton busy={busy === record.id} onClick={() => void answer(record, null, null, 'decline')} testId="full-access-decline">Decline</AskButton>
                        </>} />
          )
        }
        return (
          <AskCapsule key={record.id} testId="full-access-capsule" id={record.id} index={i} title={record.request.title} done={done}
                      mark={busy === record.id ? <AskSpinner /> : <ShieldIcon size={14} />} label={record.request.title} from={from}
                      open={isOpen} onToggle={() => setOpen((o) => ({ ...o, [record.id]: !isOpen }))}
                      details={[...(command ? [{ label: 'Command', value: command, testId: 'full-access-command' }] : []), ...FULL_ACCESS_CHOICES]}
                      actions={<>
                        <AskButton primary busy={busy === record.id} onClick={() => void answer(record, { access: 'full' }, 'Full access', 'full')} testId="full-access-allow">Allow full access</AskButton>
                        <AskButton busy={busy === record.id} onClick={() => void answer(record, { access: 'sandbox' }, 'Sandbox', 'sandbox')} testId="full-access-sandbox">Use the sandbox</AskButton>
                      </>} />
        )
      })}
    </div>
  )
}

/** What each answer to the Full access question does (agent/ui_inputs.ts fullAccessConfirmed, tools/commands.ts askFullAccess). */
const FULL_ACCESS_CHOICES: AskDetail[] = [
  { label: 'Full access', value: 'Commands run as you, with your files, network and tools. This Mac is not asked again.', testId: 'full-access-scope-full', prose: true },
  { label: 'Sandbox', value: 'This conversation’s commands stay inside its folder. You can switch later.', testId: 'full-access-scope-sandbox', prose: true },
]
/** An SSH host's yes (agent/ui_inputs.ts fullAccessConfirmed: the host, once, whatever its folder); a decline
 *  refuses this command. */
const REMOTE_FULL_ACCESS_CHOICE: AskDetail = { label: 'Full access', value: 'Commands run as you on this host. This host is not asked again. Decline refuses this command.', testId: 'full-access-scope-remote', prose: true }

/** The harness's question before an agent's SSH host is saved or connected (agent/tools/ssh.ts SSH_CONNECT_ASK). */
function isSshConnectAsk(record: UiInputRecord): boolean {
  return (record.request as { harness?: unknown }).harness === 'ssh_connect'
}

/** Where an agent's SSH question was asked, once answered (or seen in a replay): what the yes connected, and which
 *  answer was given. */
function SshConnectAsk({ record }: { record: UiInputRecord }) {
  const lines = (record.request.message ?? '').split('\n').filter(Boolean)
  return (
    <section className="access-ask ssh-ask in-thread" data-testid="ssh-connect-ask" data-input-id={record.id} data-status={record.status} aria-label={record.request.title}>
      <span className="access-ask-q">{record.request.title}{lines.map((l) => <code key={l} className="ssh-ask-line">{l}</code>)}</span>
      <span className="dim small" data-testid="ssh-connect-answer">{record.status === 'submitted' ? 'Connect' : record.status === 'dismissed' ? 'Cancelled' : closedLine(record)}</span>
    </section>
  )
}
