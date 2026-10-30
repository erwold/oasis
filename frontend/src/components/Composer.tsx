import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { resourceTarget } from '../api/ssh'
import { allows, ready, useSsh } from '../state/ssh'
import { SshConnection, useExecutionTarget } from './SshTarget'
import { CHATGPT_WEB_ID, MAX_RELAY_ROUNDS, attachmentRefusal } from '@oasis-code/contract'
import { api } from '../api/client'
import type { ModelEntry } from '../api/types'
import { chatGptRoute, contextLabel, groupByAccount, pickerModels, thinkingLabel, thinkingLevelsFor, thinkingOption, thinkingWord, unavailableHint, type ThinkingLevel } from '../state/accounts'
import { computerAvailable, folderDialog } from '../state/desktop'
import { agentMatches, agentMentionsOf, insertAgent, insertMention, insertTool, participantNames, participantsOf, queryAt, toolsMatching, type Mention, type MentionToolId } from '../state/entities'
import { activeRelay } from '../state/relay'
import { botSrc, CHATGPT_BOT, DIRECTOR_BOT } from '../state/outline'
import { BotImage } from './BotImage'
import { activeInteraction, GROUP_POLICIES, groupLabel, groupPolicyHint, groupPolicyLabel, MAX_CROSS_ROUNDS, type GroupPolicy, type InteractionDetail, noteCandidates, noteLanding, ORCHESTRATIONS, orchestrationChipText, orchestrationHint, orchestrationLabel, type Orchestration } from '../state/interaction'
import { agentImage, agentLogo, toolIcon } from './EntityChip'
import { MentionEditor, type EditorHandle } from './MentionEditor'
import { refusalLine, targetLabel } from '../state/rail'
import { FolderDialog } from './FolderDialog'
import { useStore } from '../state/store'
import { messageDestination } from '../state/messageTarget'
import { enterSends, steerRefusal, steerRoute, steerTarget } from '../state/steer'
import { ContextRing } from './ContextRing'
import { ArrowUpIcon, BracesIcon, BrainIcon, ChevronDownIcon, FileIcon, FolderOpenIcon, PaperclipIcon, SparklesIcon, StopIcon, XIcon } from './icons'
import { ACCEPTED_TYPES, pendingMedia, fileSize, destinationRefusal, pastedTextFile, sendWay, type PendingImage } from '../state/attachments'
import { carriesDraggedImage, IMAGE_DRAG_MIME } from '../state/imageDrag'
import { chatGptAvailable, chatGptSignIn, chatGptStatus, chatGptWarning, type ChatGptWarning } from '../state/chatgpt'
import type { ChatGptStatus } from '../state/desktop'
import { raiseChatGptCard } from './Desk'
import { ReferenceChips } from './Relations'
import { AccessChip } from './AccessChip'
import openaiLogo from '../assets/logo-openai.png'
import { followThread } from '../state/threadFollow'

/** A picker section (after oasis's PickerGroup): the account that gates its entries. */
function PickerGroup({ label, available, children }: { label: string; available: boolean; children: React.ReactNode }) {
  return <div className="picker-group"><div className="picker-group-head"><i className={`picker-dot${available ? ' is-ready' : ''}`} />{label}</div>{children}</div>
}

/** The model routes grouped by account; unavailable credentials are explained rather than silently substituted. */
export function AgentModelPicker({ value, onChange, testId = 'model-picker', title }: { value?: string | null; onChange?: (id: string) => void; testId?: string; title?: string } = {}) {
  const [open, setOpen] = useState(false)
  const models = useStore((s) => s.models)
  const defaultModel = useStore((s) => s.defaultModel)
  const session = useStore((s) => s.session)
  const modelChoice = useStore((s) => s.modelChoice)
  const setModel = useStore((s) => s.setModel)
  const current = value ?? modelChoice ?? session?.model ?? defaultModel ?? ''
  const pick = onChange ?? setModel
  const entry: ModelEntry | undefined = models.find((m) => m.id === current)
  const meta = entry ? (entry.auth === 'oauth' ? (entry.account_label ? `signed in as ${entry.account_label}` : 'subscription')
    : entry.credential_source === 'stored' ? 'saved key' : entry.credential_source === 'env' ? 'env key' : 'no key') : ''
  return (
    <div className="picker">
      <button className="composer-chip" onClick={() => setOpen((v) => !v)} data-testid={testId}
              title={title ?? (entry ? `${entry.provider} · ${entry.configured_model} · ${entry.endpoint} · ${meta} · ${contextLabel(entry.context_window)} · cost ${entry.pricing ? 'estimated' : 'unknown'}` : 'Pick the model')}>
        <BrainIcon size={15} /><span className="picker-current" data-testid="model-current">{entry?.label ?? current ?? 'model'}</span><ChevronDownIcon size={12} />
      </button>
      {open && <>
        <div className="picker-backdrop" onClick={() => setOpen(false)} />
        <div className="picker-popover picker-popover-wide" role="listbox">
          {pickerModels(models, current).length === 0 && <div className="picker-group-head">No route has a credential yet — sign in or save a key on the Accounts page.</div>}
          {groupByAccount(pickerModels(models, current)).map((group) => (
            <PickerGroup key={group.account} label={group.label} available={group.available}>
              {group.models.map((m) => (
                <button key={m.id} role="option" aria-selected={m.id === current}
                        className={`picker-row${m.id === current ? ' selected' : ''}${m.credential === 'unavailable' ? ' disabled' : ''}`}
                        disabled={m.credential === 'unavailable'} data-testid={`model-option-${m.id}`}
                        onClick={() => { pick(m.id); setOpen(false) }}>
                  <span className="picker-label">{m.label}</span>
                  <span className="picker-hint">{m.credential === 'unavailable' ? unavailableHint(m.account, m.credential_hint) : contextLabel(m.context_window)}</span>
                </button>
              ))}
            </PickerGroup>
          ))}
        </div>
      </>}
    </div>
  )
}

/** Use the native folder panel in the desktop shell and the folder dialog in a browser. */
function FolderChip() {
  const [open, setOpen] = useState(false)
  const target = useStore((s) => s.target)
  const setTarget = useStore((s) => s.setTarget)
  const showToast = useStore((s) => s.showToast)
  // a project on an SSH host (picked in the rail) shows its connection; a folder picked here is this machine's
  const executionTarget = resourceTarget(target)
  const remote = executionTarget.kind !== 'local'
  const dialog = folderDialog(window as { oasisCodeDesktop?: unknown })
  const choose = (path: string) => { setTarget({ kind: 'folder', path }); setOpen(false) }
  const click = () => {
    if (dialog) void dialog().then((path) => { if (path) choose(path) }, (e) => showToast(e instanceof Error ? e.message : String(e)))
    else setOpen(true)
  }
  return <>
    <button className="composer-chip composer-folder-chip" onClick={click} data-testid="folder-chip"
            title={target?.kind === 'folder' ? target.path : target?.kind === 'project' ? target.path ?? target.name : 'No folder: the task gets a working folder of its own to write in. Pick a folder to work on your files.'}>
      <FolderOpenIcon size={15} /><span className="picker-current">{targetLabel(target)}</span><ChevronDownIcon size={12} />
    </button>
    {target && <button className="composer-chip composer-chip-clear" onClick={() => setTarget(null)} data-testid="folder-clear" title="Start without a folder" aria-label="Start without a folder"><XIcon size={10} /></button>}
    {remote && <SshConnection target={executionTarget} />}
    {!dialog && <FolderDialog open={open} onClose={() => setOpen(false)} onPick={choose} />}
  </>
}

/** The thinking effort: the composer's own (the next run), or a value the caller holds (a director's setup). */
export function ThinkingChip({ value, onChange }: { value?: ThinkingLevel | null; onChange?: (level: ThinkingLevel | null) => void } = {}) {
  const [open, setOpen] = useState(false)
  const stored = useStore((s) => s.thinking)
  const setStored = useStore((s) => s.setThinking)
  const thinking = value !== undefined ? value : stored
  const setThinking = onChange ?? setStored
  // the levels the model the next run goes to declares (the one the model picker shows); the selector returns the
  // route's own list (a stable reference) and the filtering happens outside it
  const supported = useStore((s) => s.models.find((m) => m.id === (s.modelChoice ?? s.session?.model ?? s.defaultModel))?.supported_thinking)
  const levels = thinkingLevelsFor(supported)
  const choose = (level: ThinkingLevel | null) => { setThinking(level); setOpen(false) }
  return (
    <div className="picker">
      <button className={`composer-chip${thinking ? ' active' : ''}`} onClick={() => setOpen((v) => !v)} data-testid="thinking-chip"
              title="Thinking effort for the next run. A level a provider lacks maps to its nearest; a model without thinking ignores it. The run's records say what was asked and what was sent.">
        <span className="picker-current" data-testid="thinking-current">{thinkingLabel(thinking)}</span><ChevronDownIcon size={12} />
      </button>
      {open && <>
        <div className="picker-backdrop" onClick={() => setOpen(false)} />
        <div className="picker-popover" role="listbox">
          <button role="option" aria-selected={thinking === null} className={`picker-row${thinking === null ? ' selected' : ''}`} onClick={() => choose(null)} data-testid="thinking-option-default">
            <span className="picker-label">Provider's default</span>
          </button>
          {levels.map((level) => (
            <button key={level} role="option" aria-selected={thinking === level} className={`picker-row${thinking === level ? ' selected' : ''}`} onClick={() => choose(level)} data-testid={`thinking-option-${level}`}>
              <span className="picker-label">{thinkingOption(level)}</span>
            </button>
          ))}
        </div>
      </>}
    </div>
  )
}

/** The page's ChatGPT state while the chip is shown (and the sheet is open), or while the @ menu offers ChatGPT: read
 *  now, then every few seconds, so a sign-in or a first @oasis-code on the page clears the warning without a reload.
 *  `load` false (the menu's look) never opens the page: opening it holds the app's window a moment. */
function useChatGptStatus(active: boolean, load: boolean): ChatGptStatus | null {
  const [status, setStatus] = useState<ChatGptStatus | null>(null)
  useEffect(() => {
    if (!active) return
    let alive = true
    const read = () => { void chatGptStatus(window as { oasisCodeDesktop?: unknown }, { load }).then((s) => { if (alive) setStatus(s) }, () => undefined) }
    read()
    const timer = window.setInterval(read, 5000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [active, load])
  return status
}

/** The addressee named in the composer (after the @-mention chips of AI apps): ChatGPT's mark and name; a warning
 *  when the page is not signed in or does not know the oasis-code connector yet — a click opens the page then (and
 *  shows it otherwise); the × (or Backspace before the words) takes the chip away. */
function ChatGptChip({ warning, onOpen, onRemove }: { warning: ChatGptWarning; onOpen: () => void; onRemove: () => void }) {
  const title = warning === 'signin' ? 'ChatGPT is not signed in — click to sign in'
    : warning === 'connector' ? 'ChatGPT does not know the oasis-code connector yet — click, and in ChatGPT type @, pick oasis-code and send a word'
    : 'These words go to ChatGPT on the web — click to see the page'
  return (
    <span className={`chatgpt-chip${warning ? ' warn' : ''}`} data-testid="chatgpt-chip" data-warning={warning ?? ''}>
      <button type="button" className="chatgpt-chip-open" title={title} onClick={onOpen}>
        <img src={openaiLogo} alt="" width={14} height={14} />
        <span>ChatGPT</span>
        {warning && <span className="chatgpt-chip-warn" aria-label={title}>!</span>}
      </button>
      <button type="button" className="chatgpt-chip-remove" aria-label="Send to the agent instead" title="Send to the agent instead" onClick={onRemove} data-testid="chatgpt-chip-remove">
        <XIcon size={10} />
      </button>
    </span>
  )
}

/** The session's own director at the head of the words: they go to it — it answers, and has agents do the work;
 *  the cross sends them to the agent instead. */
function DirectorChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="chatgpt-chip director-chip" data-testid="director-chip">
      <span className="chatgpt-chip-open" title={`These words go to the director (${label}) — it answers, and has agents do the work`}>
        <BotImage bot={DIRECTOR_BOT} size={14} />
        <span>Director</span>
      </span>
      <button type="button" className="chatgpt-chip-remove" aria-label="Send to the agent instead" title="Send to the agent instead" onClick={onRemove} data-testid="director-chip-remove">
        <XIcon size={10} />
      </button>
    </span>
  )
}

/** How the agents named work together (shown once two or more are named): three ways, stacked with what each
 *  means, then the limits — runs in all and at once. The chip says the way and how many runs it makes. `inPlace`: the
 *  session edits its folder in place, so no agent gets a copy of its own. */
function OrchestrationChip({ value, rounds, onChange, onRounds, agents, director, maxRuns, concurrency, onLimits, inPlace, crossRounds = 1, onCrossRounds, policy = 'legacy', onPolicy, projectKind = null }: {
  value: Orchestration; rounds: number; onChange: (mode: Orchestration) => void; onRounds: (rounds: number) => void; agents: number; director: string | null
  maxRuns: number | null; concurrency: number; onLimits: (limits: { max_runs?: number | null; concurrency?: number }) => void; inPlace: boolean
  crossRounds?: number; onCrossRounds?: (rounds: number) => void
  policy?: GroupPolicy; onPolicy?: (policy: GroupPolicy) => void; projectKind?: string | null
}) {
  const [open, setOpen] = useState(false)
  const remote = useExecutionTarget().kind !== 'local'
  const choices = [1, 2, 3].filter((n) => n <= MAX_RELAY_ROUNDS)
  const budgetDefault = Math.max(4, agents * 3)
  const runsMax = maxRuns ?? budgetDefault
  const title = value === 'turns'
    ? `${agents} agents take turns on this message, in the order named; a round is every agent once: ${agents} × ${rounds} = ${agents * rounds} runs.`
    : value === 'discussion' ? `${agents} agents answer alone first, then read each other's answers and respond, ${crossRounds} time${crossRounds === 1 ? '' : 's'}: ${agents} × ${crossRounds + 1} = ${agents * (crossRounds + 1)} runs.`
    : value === 'independent' ? (inPlace
      ? `${agents} agents work alone in this folder, edited in place: no copies, the writers take turns; you compare the answers.`
      : `${agents} agents work alone, each on its own copy of the files from the same starting point; you choose what to keep.`)
    : `The director${director ? ` (${director})` : ''} reads your words once and commits a plan. You see the plan in the thread; the harness runs it.`
  return (
    <div className="picker">
      <button className="composer-chip active" onClick={() => setOpen((v) => !v)} data-testid="rounds-chip" data-policy={value === 'turns' ? undefined : policy}
              title={value === 'turns' ? title : `${title} Files: ${groupPolicyLabel(policy, projectKind)} — ${groupPolicyHint(policy, projectKind)}`}>
        <span className="picker-current" data-testid="orchestration-current">{orchestrationChipText(value, agents, value === 'discussion' ? crossRounds : rounds, runsMax)}</span><ChevronDownIcon size={12} />
      </button>
      {open && <>
        <div className="picker-backdrop" onClick={() => setOpen(false)} />
        <div className="picker-popover picker-popover-wide" role="listbox">
          {ORCHESTRATIONS.map((mode) => (
            <button key={mode} role="option" aria-selected={value === mode} className={`picker-row picker-row-stacked${value === mode ? ' selected' : ''}`} data-testid={`orchestration-option-${mode}`}
                    onClick={() => { onChange(mode); if (mode !== 'turns' && mode !== 'discussion') setOpen(false) }}>
              <span className="picker-label">{orchestrationLabel(mode)}{mode === 'director' && director ? <span className="picker-hint"> · {director}</span> : null}</span>
              <span className="picker-hint">{orchestrationHint(mode, inPlace)}</span>
            </button>
          ))}
          {value === 'turns' && <div className="picker-group-head">Rounds · {agents} × {rounds} = {agents * rounds} runs</div>}
          {value === 'turns' && choices.map((n) => (
            <button key={n} role="option" aria-selected={rounds === n} className={`picker-row${rounds === n ? ' selected' : ''}`} onClick={() => { onRounds(n); setOpen(false) }} data-testid={`rounds-option-${n}`}>
              <span className="picker-label">{n} round{n === 1 ? '' : 's'}</span>
              <span className="picker-hint">Each participant speaks {n === 1 ? 'once' : `${n} times`}.</span>
            </button>
          ))}
          {value === 'discussion' && <div className="picker-group-head">Exchanges · {agents} × {crossRounds + 1} = {agents * (crossRounds + 1)} runs</div>}
          {value === 'discussion' && Array.from({ length: MAX_CROSS_ROUNDS }, (_, i) => i + 1).map((n) => (
            <button key={n} role="option" aria-selected={crossRounds === n} className={`picker-row${crossRounds === n ? ' selected' : ''}`} onClick={() => { onCrossRounds?.(n); setOpen(false) }} data-testid={`cross-rounds-option-${n}`}>
              <span className="picker-label">{n} exchange{n === 1 ? '' : 's'}</span>
              <span className="picker-hint">Each reads the others' answers and responds {n === 1 ? 'once' : `${n} times`}.</span>
            </button>
          ))}
          {value !== 'turns' && <>
            <div className="picker-group-head">Limits · runs in all</div>
            <div className="picker-inline" role="group" aria-label="runs in all">
              {[budgetDefault, 6, 9, 12].filter((n, i, all) => all.indexOf(n) === i).sort((a, b) => a - b).map((n) => (
                <button key={n} role="option" aria-selected={runsMax === n} className={`picker-row picker-row-compact${runsMax === n ? ' selected' : ''}`} onClick={() => onLimits({ max_runs: n === budgetDefault ? null : n })} data-testid={`limit-runs-${n}`}>{n}</button>
              ))}
            </div>
            <div className="picker-group-head">at once</div>
            <div className="picker-inline" role="group" aria-label="runs at once">
              {[1, 2, 3, 4].map((n) => (
                <button key={n} role="option" aria-selected={concurrency === n} className={`picker-row picker-row-compact${concurrency === n ? ' selected' : ''}`} onClick={() => onLimits({ concurrency: n })} data-testid={`limit-concurrency-${n}`}>{n}</button>
              ))}
            </div>
            <div className="picker-group-head">Files</div>
            {GROUP_POLICIES.map((p) => (
              <button key={p} disabled={remote && p === 'isolated'} role="option" aria-selected={policy === p} className={`picker-row picker-row-stacked${policy === p ? ' selected' : ''}`} onClick={() => onPolicy?.(p)} data-testid={`workspace-policy-${p}`}>
                <span className="picker-label">{groupPolicyLabel(p, projectKind)}{p === 'legacy' ? <span className="picker-hint"> · default</span> : null}</span>
                <span className="picker-hint">{groupPolicyHint(p, projectKind)}</span>
              </button>
            ))}
          </>}
        </div>
      </>}
    </div>
  )
}

/** Where the composer's words go while groups (interactions) run: the director, or one recipient of one group. With
 *  several groups the group is chosen first — none is chosen for the person — then everyone or a participant of it. A
 *  group that ended under a note stays named (ended) until the recipient is chosen again. */
function ToChip({ value, groups, all, chosen, gone, hasDirector, onChange }: {
  value: string; groups: InteractionDetail[]; all: InteractionDetail[]; chosen: string | null; gone: boolean; hasDirector: boolean; onChange: (to: string, group?: string) => void
}) {
  const [open, setOpen] = useState(false)
  const several = groups.length > 1
  // the group whose recipients the menu lists: the only one; with several, the one picked in the menu (none at first)
  const [picked, setPicked] = useState<string | null>(null)
  const listed = several ? groups.find((g) => g.id === picked) ?? null : groups[0] ?? null
  const chosenGroup = chosen ? all.find((g) => g.id === chosen) ?? null : null
  const recipient = (g: InteractionDetail | null, id: string) => (id === 'everyone' ? 'everyone' : g ? participantNames(g.participants).get(id) ?? id : id)
  const label = value === 'agent' ? 'the agent' : value === 'director' ? 'the director'
    : `${recipient(chosenGroup, value)}${chosenGroup && (several || gone) ? ` · ${groupLabel(chosenGroup, all)}` : ''}${gone ? ' (ended)' : ''}`
  const toggle = () => { if (!open) setPicked(several && chosen && groups.some((g) => g.id === chosen) ? chosen : null); setOpen((v) => !v) }
  const choose = (to: string, group?: string) => { onChange(to, group); setOpen(false) }
  const names = listed ? participantNames(listed.participants) : new Map<string, string>()
  return (
    <div className="picker">
      <button className={`composer-chip active${gone ? ' to-gone' : ''}`} onClick={toggle} data-testid="to-chip" data-gone={gone || undefined}
              title={gone ? 'The group of this note ended: choose again' : 'Whom these words are for. A note is handed to each recipient at its next run, never into a request in flight.'}>
        <span className="picker-current">To · {label}</span><ChevronDownIcon size={12} />
      </button>
      {open && <>
        <div className="picker-backdrop" onClick={() => setOpen(false)} />
        <div className="picker-popover" role="listbox" data-testid="to-menu">
          {several && !listed && <>
            <div className="picker-group-head">Group</div>
            {groups.map((g) => (
              <button key={g.id} role="option" aria-selected={false} className="picker-row" onClick={() => setPicked(g.id)} data-testid={`to-group-${g.id}`} title={g.user_text}>
                <span className="picker-label">{groupLabel(g, all)}</span><span className="picker-hint">{g.participants.map((p) => participantNames(g.participants).get(p.id) ?? p.label).join(', ')}</span>
              </button>
            ))}
          </>}
          {listed && <>
            {several && <button className="picker-row picker-group-head" onClick={() => setPicked(null)} data-testid="to-groups" title="Other groups">‹ {groupLabel(listed, all)}</button>}
            {[{ id: 'everyone', label: 'Everyone', hint: 'each participant, at its next run' }, ...listed.participants.map((p) => ({ id: p.id, label: names.get(p.id) ?? p.label, hint: names.get(p.id) === p.id ? `${p.label} · at its next run` : 'this participant, at its next run' }))].map((o) => {
              const on = chosen === listed.id && value === o.id
              return (
                <button key={o.id} role="option" aria-selected={on} className={`picker-row${on ? ' selected' : ''}`} onClick={() => choose(o.id, listed.id)} data-testid={`to-option-${o.id}`}>
                  <span className="picker-label">{o.label}</span><span className="picker-hint">{o.hint}</span>
                </button>
              )
            })}
          </>}
          {hasDirector && (
            <button role="option" aria-selected={value === 'director'} className={`picker-row${value === 'director' ? ' selected' : ''}`} onClick={() => choose('director')} data-testid="to-option-director">
              <span className="picker-label">The director</span><span className="picker-hint">a turn of the director; it may change the plan</span>
            </button>
          )}
        </div>
      </>}
    </div>
  )
}

/** The images waiting with the words: a thumbnail each, its state (a failed upload says why), a way to take it out. */
function ComposerImages({ images, onRemove, disabled }: { images: PendingImage[]; onRemove: (id: string) => void; disabled: boolean }) {
  const retry = useStore((s) => s.retryImage)
  const cancelTransfer = useStore((s) => s.cancelTransfer)
  if (!images.length) return null
  return (
    <div className="composer-images" data-testid="composer-images">
      {images.map((image) => (
        <figure key={image.id} className={`composer-image is-${image.state}`} title={image.error ? `${image.name}: ${image.error}` : image.name} data-testid="composer-image">
          {image.url && <img src={image.url} alt={image.name} draggable={false} />}
          <figcaption className="attachment-caption">{image.name}<small>{pendingMedia(image).media_type} · {fileSize(image.file.size)}</small></figcaption>
          {image.error && <span className="attachment-error">{image.error} <button type="button" disabled={disabled} onClick={() => retry(image.id)}>Retry file</button></span>}
          {image.state === 'converting' && <span className="composer-image-state">reading…</span>}
          {image.state === 'uploading' && !image.transfer && <span className="composer-image-state">{sendWay({ name: image.name, type: image.file.type }) === 'reference' ? 'attaching…' : 'uploading…'}</span>}
          {image.transfer && (image.state === 'uploading' || image.transfer.sent > 0) && (
            <span className="composer-transfer" data-testid="composer-transfer" data-sent={image.transfer.sent} data-total={image.transfer.total}>
              <progress max={image.transfer.total || 1} value={image.transfer.sent} />
              <span>{image.state === 'uploading' ? 'uploading' : 'stopped at'} {fileSize(image.transfer.sent)} of {fileSize(image.transfer.total)}</span>
              {image.state === 'uploading' && <button type="button" onClick={() => cancelTransfer(image.id)} data-testid="composer-transfer-cancel">Cancel</button>}
            </span>
          )}
          {image.state === 'dropping' && <span className="composer-image-state" data-testid="composer-dropping">asking the harness to drop the partial upload…</span>}
          {image.state === 'failed' && <span className="composer-image-state">not sent</span>}
          <button className="composer-image-remove" aria-label={`Remove ${image.name}`} disabled={disabled || image.state === 'uploading' || image.state === 'dropping'} onClick={() => onRemove(image.id)}>
            <XIcon size={10} />
          </button>
        </figure>
      ))}
    </div>
  )
}

/** An agent row names a route; with `alias`, a participant already in the words named again (its id); without, a new
 *  participant. A tool row names a tool the agent has (computer use). */
type MentionOption = { kind: 'agent'; m: ModelEntry; alias: string | null } | { kind: 'tool'; id: MentionToolId; label: string } | { kind: 'entity'; m: Mention } | { kind: 'head'; text: string }

const optionKey = (o: MentionOption) => (o.kind === 'head' ? `head:${o.text}` : o.kind === 'tool' ? `tool:${o.id}` : o.kind === 'agent' ? `agent:${o.m.id}${o.alias ? `#${o.alias}` : ''}` : `${o.m.path}::${o.m.symbol ?? ''}`)

/** What a tool's row of the @ menu says: a quiet line beside its name, and the whole of it on hover. */
const TOOL_ROWS: Record<MentionToolId, { desc: string; title: string }> = {
  computer: {
    desc: 'computer use · pages in this app',
    title: "Computer use: the agent looks at and acts on pages this app holds — its own browser (the Browser card) and your signed-in ChatGPT page — under the session's permissions",
  },
}
/** A row the keys skip: a group's heading. */
const pickable = (o: MentionOption) => o.kind !== 'head'

/** A model's own thinking effort, on its row of the @ menu: the level chosen for it, or the composer's (muted) when
 *  none was; a click opens the levels beside it. Every participant on the model runs at it; the menu keeps the editor's
 *  focus (a press here never picks the row). */
function EffortPick({ model, label }: { model: string; label: string }) {
  const own = useStore((s) => s.mentionThinking[model] ?? null)
  const composer = useStore((s) => s.thinking)
  const levels = thinkingLevelsFor(useStore((s) => s.models.find((m) => m.id === model)?.supported_thinking))
  const setOwn = useStore((s) => s.setMentionThinking)
  const [at, setAt] = useState<{ left: number; bottom: number } | null>(null)
  const keep = (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation() }
  const choose = (level: ThinkingLevel | null) => { setOwn(model, level); setAt(null) }
  return <>
    <button type="button" className={`mention-effort${own ? ' chosen' : ''}`} data-testid={`mention-effort-${model}`} onMouseDown={keep}
            title={own ? `${label} thinks at ${thinkingWord(own)} — click to change` : `${label} thinks as the composer says (${thinkingWord(composer)}) — click to choose its own effort`}
            onClick={(e) => {
              e.stopPropagation()
              const rect = e.currentTarget.getBoundingClientRect()
              setAt(at ? null : { left: Math.min(rect.left, window.innerWidth - 176), bottom: window.innerHeight - rect.top + 4 })
            }}>
      <BrainIcon size={12} />{thinkingWord(own ?? composer)}
    </button>
    {at && createPortal(<>
      <div className="picker-backdrop mention-effort-backdrop" onMouseDown={keep} onClick={() => setAt(null)} />
      <div className="picker-popover mention-effort-menu" role="listbox" style={{ left: at.left, bottom: at.bottom }} onMouseDown={keep} data-testid="mention-effort-menu">
        <button role="option" aria-selected={own === null} className={`picker-row${own === null ? ' selected' : ''}`} onClick={() => choose(null)} data-testid="mention-effort-default">
          <span className="picker-label">As the composer ({thinkingWord(composer)})</span>
        </button>
        {levels.map((level) => (
          <button key={level} role="option" aria-selected={own === level} className={`picker-row${own === level ? ' selected' : ''}`} onClick={() => choose(level)} data-testid={`mention-effort-${level}`}>
            <span className="picker-label">{thinkingOption(level)}</span>
          </button>
        ))}
      </div>
    </>, document.body)}
  </>
}

/** The @ menu (after beautiful-ui's Prompt Bar): as wide as the words, one row per option — its mark, its name, a
 *  quiet line — under one highlight that glides to the row picked. ChatGPT's rows (a participant like any other,
 *  typed into the desktop app's page) say whether the page is signed in; when it is not, Connect opens the page.
 *  `chatWarning` is undefined while the state is unknown: not read yet, or the page not open (the menu never opens it). */
function MentionMenu({ options, picked, participants, chatWarning, onHover, onChoose, onConnect }: {
  options: MentionOption[]; picked: number; participants: { id: string; label: string }[]; chatWarning: ChatGptWarning | undefined
  onHover: (i: number) => void; onChoose: (o: MentionOption) => void; onConnect: () => void
}) {
  const named = participants.length
  const list = useRef<HTMLUListElement>(null)
  const [glide, setGlide] = useState<{ top: number; height: number } | null>(null)
  const keys = options.map(optionKey).join('|')
  useLayoutEffect(() => {
    const row = list.current?.querySelector<HTMLElement>(`[data-row="${picked}"]`)
    if (!row) { setGlide(null); return }
    setGlide((g) => (g && g.top === row.offsetTop && g.height === row.offsetHeight ? g : { top: row.offsetTop, height: row.offsetHeight }))
    row.scrollIntoView({ block: 'nearest' })
  }, [picked, keys])
  const row = (o: MentionOption, i: number, testId: string, extra: string, title?: string) => ({
    role: 'option', 'aria-selected': i === picked, 'data-row': i, 'data-testid': testId, title,
    className: `mention-row ${extra}${i === picked ? ' selected' : ''}`,
    onMouseEnter: () => onHover(i),
    onMouseDown: (e: React.MouseEvent) => { e.preventDefault(); onChoose(o) },
  })
  const signedOut = chatWarning === 'signin'
  return (
    <div className="mention-menu">
      <ul ref={list} className="mention-list" role="listbox" data-testid="entity-picker">
        {glide && <li role="presentation" aria-hidden className="mention-glide" style={{ top: glide.top, height: glide.height }} />}
        {options.map((o, i) => {
          if (o.kind === 'head') return <li key={optionKey(o)} role="presentation" className="picker-group-head mention-head">{o.text}</li>
          if (o.kind === 'agent') {
            // a row wears its provider's logo (ChatGPT on the web, its own mark): a participant is given its bot once it
            // runs, by its id (state/outline.ts identityTable)
            const place = o.alias ? participants.findIndex((p) => p.id === o.alias) : named
            const desc = o.alias ? `mention again · ${o.alias}` : named ? 'a new participant · its own conversation' : 'agent'
            // ChatGPT: the person's own page in the desktop app — words in, its answer back; signed in or not
            const chat = o.m.id === CHATGPT_WEB_ID
            const logo = chat ? botSrc(CHATGPT_BOT) : agentLogo(o.m.id, o.m.provider)
            return (
              <li key={optionKey(o)} {...row(o, i, o.alias ? `mention-again-${o.m.id}-${place + 1}` : chat ? 'mention-chatgpt' : `mention-agent-${o.m.id}`, `mention-agent${chat ? ' mention-chatgpt' : ''}`,
                                             chat ? "ChatGPT on the web: your ChatGPT page in this app answers as a participant, with its own abilities, on the words it is handed" : `${o.m.provider} · ${o.m.configured_model} · ${o.m.id}`)}>
                <span className="mention-icon">{chat ? <BotImage bot={CHATGPT_BOT} size={18} /> : logo ? <img src={logo} alt="" width={18} height={18} /> : <SparklesIcon size={13} />}</span>
                <span className="mention-name">{o.m.label}</span>
                <span className="mention-desc">{desc} · {chat ? 'web' : contextLabel(o.m.context_window)}</span>
                {!chat && <EffortPick model={o.m.id} label={o.m.label} />}
                {chat && chatWarning === null && <span className="mention-state" data-testid="mention-chatgpt-connected"><i />Connected</span>}
                {chat && signedOut && <button type="button" className="mention-connect" title="ChatGPT is not signed in — open the page to sign in" data-testid="mention-chatgpt-connect"
                                              onMouseDown={(e) => { e.preventDefault(); e.stopPropagation() }} onClick={(e) => { e.stopPropagation(); onConnect() }}>Connect</button>}
              </li>
            )
          }
          if (o.kind === 'tool') {
            const icon = toolIcon(o.id)
            return (
              <li key={optionKey(o)} {...row(o, i, `mention-tool-${o.id}`, 'mention-tool', TOOL_ROWS[o.id].title)}>
                <span className="mention-icon">{icon ? <img src={icon} alt="" width={18} height={18} /> : <SparklesIcon size={13} />}</span>
                <span className="mention-name">{o.label}</span>
                <span className="mention-desc">{TOOL_ROWS[o.id].desc}</span>
              </li>
            )
          }
          const slash = o.m.path.lastIndexOf('/')
          return (
            <li key={optionKey(o)} {...row(o, i, 'mention-entity', 'mention-entity', o.m.symbol ? `${o.m.path}::${o.m.symbol}` : o.m.path)}>
              <span className="mention-icon">{o.m.symbol ? <BracesIcon size={13} /> : <FileIcon size={13} />}</span>
              <span className="mention-name">{o.m.symbol ?? o.m.path.slice(slash + 1)}</span>
              <span className="mention-desc mention-path">{o.m.symbol ? o.m.path : slash > 0 ? o.m.path.slice(0, slash + 1) : ''}</span>
            </li>
          )
        })}
      </ul>
      <div className="mention-foot">↑↓ to move · Enter to pick · Esc to close{named ? ' · Each participant keeps its own conversation; naming one again is the same participant.' : ''}</div>
    </div>
  )
}

/** One conversation: model, effort and permission mode. Delegation is an agent capability, not a separate mode. */
/** What the thread composer's next message is: the main agent's next message (the default — the conversation goes
 *  on), or a separate task: an agent of its own with a conversation of its own and a workspace of its own, on a card,
 *  summarised in the thread. Two or more agents named are a group (the way chip says how). */
function SendAsChip({ value, onChange, inPlace }: { value: 'main' | 'separate'; onChange: (way: 'main' | 'separate') => void; inPlace: boolean }) {
  const [open, setOpen] = useState(false)
  const choose = (way: 'main' | 'separate') => { onChange(way); setOpen(false) }
  return (
    <div className="picker">
      <button className={`composer-chip${value === 'separate' ? ' active' : ''}`} onClick={() => setOpen((v) => !v)} data-testid="send-as-chip" data-way={value}
              title={value === 'separate' ? 'This message starts a separate task' : 'This message goes to the session\'s main agent'}>
        <span className="picker-current">{value === 'separate' ? 'Separate task' : 'Main agent'}</span><ChevronDownIcon size={12} />
      </button>
      {open && <>
        <div className="picker-backdrop" onClick={() => setOpen(false)} />
        <div className="picker-popover picker-popover-wide" role="listbox">
          <button role="option" aria-selected={value === 'main'} className={`picker-row picker-row-stacked${value === 'main' ? ' selected' : ''}`} onClick={() => choose('main')} data-testid="send-as-main">
            <span className="picker-label">Main agent</span>
            <span className="picker-hint">The session's agent takes it as its next message: one conversation, in this thread.</span>
          </button>
          <button role="option" aria-selected={value === 'separate'} className={`picker-row picker-row-stacked${value === 'separate' ? ' selected' : ''}`} onClick={() => choose('separate')} data-testid="send-as-separate">
            <span className="picker-label">Separate task</span>
            <span className="picker-hint">{inPlace
              ? 'An agent of its own, with a conversation of its own: it writes to an output folder of its own and reads this folder read-only. Shown on a card; the thread lists it with its state.'
              : 'An agent of its own, with a conversation and a copy of the files of its own. Shown on a card; the thread lists it with its state.'} Words only; the main agent's conversation is not handed to it.</span>
          </button>
        </div>
      </>}
    </div>
  )
}

export function Composer({ hero = false, autoFocus = false }: { hero?: boolean; autoFocus?: boolean } = {}) {
  const executionTarget = useExecutionTarget()
  const sshHosts = useSsh((s) => s.targets)
  const remote = executionTarget.kind !== 'local'
  const attachmentsAllowed = allows(executionTarget, 'attachment_placement', sshHosts)
  const session = useStore((s) => s.session)
  const draft = useStore((s) => s.draft)
  const setDraft = useStore((s) => s.setDraft)
  const send = useStore((s) => s.send)
  const startTask = useStore((s) => s.startTask)
  const stop = useStore((s) => s.stop)
  const liveRunId = useStore((s) => s.liveRunId)
  const busy = useStore((s) => s.busy)
  const importRefusal = useStore((s) => s.importRefusal)
  const attachRefused = useStore((s) => s.attachRefused)
  const setImportRefusal = useStore((s) => s.setImportRefusal)
  const showToast = useStore((s) => s.showToast)
  const images = useStore((s) => s.images)
  const addImages = useStore((s) => s.addImages)
  const addDraggedImage = useStore((s) => s.addDraggedImage)
  const removeImage = useStore((s) => s.removeImage)
  const director = useStore((s) => s.director)
  const composerTarget = useStore((s) => s.composerTarget)
  const setComposerTarget = useStore((s) => s.setComposerTarget)
  const setChatGptSheet = useStore((s) => s.setChatGptSheet)
  // A director is the default even before it exists. A note requires an explicit addressee for this interaction.
  const interactions = useStore((s) => s.interactions)
  const interactionLive = activeInteraction(interactions)
  // notes go to a paused interaction too: its participants take them when the person continues it
  const noteGroups = noteCandidates(interactions)
  const ownDirector = director?.director ?? session?.director
  const directorModel = useStore((s) => s.directorModel)
  const setDirectorModel = useStore((s) => s.setDirectorModel)
  const defaultRoute = useStore((s) => s.defaultModel)
  // the native director's model: the open one's, else the one picked for it, else what it would open on (the session's)
  const directorOpen = ownDirector && ownDirector.state !== 'closed' && ownDirector.transport === 'native' ? ownDirector : null
  const directorModelShown = directorOpen?.model ?? directorModel ?? (session?.model && session.model !== CHATGPT_WEB_ID ? session.model : defaultRoute) ?? null
  const noteTo = useStore((s) => s.noteTo)
  const noteInteractionId = useStore((s) => s.noteInteractionId)
  const setNoteTo = useStore((s) => s.setNoteTo)
  const destination = messageDestination(composerTarget, noteGroups.map((ix) => ix.id), noteTo, noteInteractionId)
  const toParticipants = destination.kind === 'note'
  // the group the note was for no longer takes notes: nothing is sent until its recipient is chosen again
  const noteGone = destination.kind === 'note' && destination.gone === true
  // the group the person chose for the note (never one chosen for them)
  const interactionNotable = destination.kind === 'note' && !noteGone ? noteGroups.find((ix) => ix.id === destination.interactionId) ?? null : null
  const notePaused = toParticipants && (interactionNotable?.status === 'waiting' || interactionNotable?.status === 'interrupted')
  const noteRound = toParticipants && interactionNotable?.status === 'done'
  const toChatGpt = destination.kind === 'director' && (composerTarget === 'chatgpt' || ownDirector?.transport === 'bridge')
  const toDirector = destination.kind === 'director' && !toChatGpt
  const toSomeDirector = toChatGpt || toDirector
  const canNameChatGpt = chatGptAvailable(window as { oasisCodeDesktop?: unknown })
  const canUseComputer = computerAvailable(window as { oasisCodeDesktop?: unknown })
  const [at, setAt] = useState<{ start: number; query: string } | null>(null)
  const models = useStore((s) => s.models)
  // ChatGPT on the web is a participant the @ menu offers where the desktop app holds its page
  const chatRoute = chatGptRoute(models, canNameChatGpt)
  const offerChatGpt = !!at && !!chatRoute && agentMatches(at.query, chatRoute)
  // the page's state while the director's chip stands, and while the @ menu offers ChatGPT (its row says whether it is connected)
  const chatStatus = useChatGptStatus(canNameChatGpt && (toChatGpt || offerChatGpt), toChatGpt)
  const warning = chatGptWarning(chatStatus)
  const openChatGpt = () => {
    // not ready (sign in, or teach it the connector): the page in the middle of the window; else its card
    if (warning) setChatGptSheet(true)
    else raiseChatGptCard()
  }
  const [sending, setSending] = useState(false)
  const [dragging, setDragging] = useState(false)
  const editor = useRef<EditorHandle>(null)
  // the chip sits at the start of the first line, the words after it and every next line from the left edge (as a
  // mention in the text would): the first line is indented by the chip's width
  const chipSlot = useRef<HTMLSpanElement>(null)
  const [indent, setIndent] = useState(0)
  useLayoutEffect(() => {
    const el = chipSlot.current
    if (!toSomeDirector || !el) { setIndent(0); return }
    const measure = () => setIndent(el.offsetWidth + 6)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [toSomeDirector])
  const picker = useRef<HTMLInputElement>(null)
  const hasFiles = (e: React.DragEvent) => [...e.dataTransfer.types].includes('Files')
  // an image of the thread dragged here: known by its own type (a browser may list it as Files too, with none in it)
  const hasThreadImage = (e: React.DragEvent) => carriesDraggedImage([...e.dataTransfer.types])
  const [entities, setEntities] = useState<Mention[]>([])
  const [pick, setPick] = useState(0)
  const wsId = session?.workspace?.id
  useEffect(() => {
    if (!at || !wsId) { setEntities([]); return }
    let alive = true
    const timer = window.setTimeout(() => {
      void api.entities(wsId, at.query).then((r) => {
        if (!alive) return
        const symbols = r.symbols.map((s) => ({ path: s.path, symbol: s.name }))
        const paths = r.paths.map((p) => ({ path: p, symbol: null }))
        setEntities((at.query.includes('::') ? symbols : [...paths, ...symbols]).slice(0, 12))
        setPick(0)
      }, () => undefined)
    }, 120)
    return () => { alive = false; window.clearTimeout(timer) }
  }, [at, wsId])
  const modelChoice = useStore((s) => s.modelChoice)
  const defaultModel = useStore((s) => s.defaultModel)
  const relays = useStore((s) => s.relays)
  const relayRounds = useStore((s) => s.relayRounds)
  const setRelayRounds = useStore((s) => s.setRelayRounds)
  const orchestration = useStore((s) => s.orchestration)
  const setOrchestration = useStore((s) => s.setOrchestration)
  const interactionMaxRuns = useStore((s) => s.interactionMaxRuns)
  const interactionConcurrency = useStore((s) => s.interactionConcurrency)
  const setInteractionLimits = useStore((s) => s.setInteractionLimits)
  const crossRounds = useStore((s) => s.crossRounds)
  const setCrossRounds = useStore((s) => s.setCrossRounds)
  const groupPolicy = useStore((s) => s.groupPolicy)
  const setGroupPolicy = useStore((s) => s.setGroupPolicy)
  const projectKind = useStore((s) => s.projects.find((p) => p.id === s.session?.project_id)?.kind ?? (s.session?.workspace?.kind === 'direct' ? 'direct' : null))
  const sendAs = useStore((s) => s.sendAs)
  const setSendAs = useStore((s) => s.setSendAs)
  const sendSeparate = useStore((s) => s.sendSeparate)
  // the @ menu: the participants already in the words, named again; then, under "Add a participant", ChatGPT (in the
  // desktop app) and the catalogue's routes that have a credential — each joining as a new participant with a
  // conversation of its own (a name with spaces searches as typed; to a director — the session's own or ChatGPT — an
  // agent named is one it may have do the work); then the agent's tools a person asks for by name; then the
  // workspace's files and definitions
  const participants = participantsOf(draft)
  const agents = at ? [...(chatRoute ? [chatRoute] : []), ...pickerModels(models, null)].filter((m) => agentMatches(at.query, m)).slice(0, 8) : []
  const again: MentionOption[] = agents.flatMap((m) => participants.filter((p) => p.model === m.id).map((p) => ({ kind: 'agent' as const, m, alias: p.id })))
  const join: MentionOption[] = agents.map((m) => ({ kind: 'agent' as const, m, alias: null }))
  const agentOptions: MentionOption[] = again.length ? [{ kind: 'head' as const, text: 'In this session' }, ...again, { kind: 'head' as const, text: 'Add a participant' }, ...join] : join
  // the tools the agent has that a person may ask for by name (computer use, where the desktop app holds the pages)
  const toolOptions: MentionOption[] = at ? toolsMatching(at.query, { computer: canUseComputer }).map((t) => ({ kind: 'tool' as const, ...t })) : []
  const options: MentionOption[] = [...agentOptions, ...toolOptions, ...entities.map((m) => ({ kind: 'entity' as const, m }))]
  const track = (value: string, caret: number) => setAt(wsId || canNameChatGpt || canUseComputer || models.length ? queryAt(value, caret) : null)
  // the highlighted row: never past the options at hand (they change with every keystroke), never a heading, and
  // the first one again whenever a new query opens
  const picked = (() => {
    let i = Math.min(Math.max(pick, 0), Math.max(0, options.length - 1))
    while (i < options.length - 1 && !pickable(options[i]!)) i += 1
    return i
  })()
  useEffect(() => { setPick(0) }, [at?.start])
  const choose = (option: (typeof options)[number] | undefined) => {
    const ed = editor.current
    if (!at || !ed || !option || option.kind === 'head') return
    const { text: now, caret } = ed.read()
    // the chip (or the file's token) stands where the query was, the caret after it — at once, so the next words typed
    // land after it whatever the frame
    const out = option.kind === 'agent' ? insertAgent(now, at.start, caret, { label: option.m.label, model: option.m.id, alias: option.alias })
      : option.kind === 'tool' ? insertTool(now, at.start, caret, option) : insertMention(now, at.start, caret, option.m)
    setAt(null)
    ed.replace(out.text, out.caret)
  }
  // words for the director go while the agent runs (the director queues them); words for the agent wait for the
  // run — and for a relay or an interaction under way, between two of its runs too
  const relayLive = activeRelay(relays)
  // words for the agent while the session's own run works go into that run's next model request (in-run steering:
  // state/steer.ts) — never a relay's turn, an interaction's node, a UI task's run, an order's or ChatGPT on the web
  const runs = useStore((s) => s.runs)
  const uiTaskRuns = useStore((s) => s.uiTaskRuns)
  const replaying = useStore((s) => s.replaying)
  const steer = useStore((s) => s.steer)
  const liveRun = liveRunId ? runs.find((r) => r.id === liveRunId) : undefined
  const liveTarget = hero ? null : steerTarget({ run: liveRun, activeRun: session?.active_run as { id: string; steerable?: boolean } | null | undefined,
    uiTask: !!(liveRunId && uiTaskRuns[liveRunId]), relayLive: !!relayLive, interactionLive: !!interactionLive, destination: destination.kind, replaying })
  // the very words of a steer whose answer was lost go to that run again with that key (never a new run), live or not
  const pendingSteer = useStore((s) => (session ? s.pendingSteer[session.id] : undefined))
  // a separate task: the composer's message goes to no agent at work (its own agent, beside them all)
  const separate = !hero && sendAs === 'separate' && destination.kind === 'agent' && participants.length < 2
  const steerWay = hero || replaying || separate ? null : steerRoute({ destination: destination.kind, draft, pending: pendingSteer, liveTarget })
  const steerRunId = steerWay?.run_id ?? null
  const steering = steerRunId !== null
  // words for a director go while an agent runs (the director queues them); words for the agent wait for the run —
  // unless they steer it
  const blocked = (!!liveRunId || !!relayLive || !!interactionLive) && !toParticipants && !toSomeDirector && !steering && !separate
  // files and named agents or tools do not join a run under way: said, the draft kept as it is (a plain @ is words)
  const steerProblem = steering ? steerRefusal(draft, images.length) : null
  // images with a model that does not declare image input: said before sending (the harness would refuse), the draft
  // kept — pick another model or take the images out; every agent named must take them
  const named = participants
  const namedRoutes = named.map((a) => models.find((m) => m.id === a.model)).filter((m): m is ModelEntry => !!m)
  const directorLabel = models.find((m) => m.id === (director?.director?.transport === 'native' ? director.director.model : (modelChoice ?? session?.model ?? defaultModel)))?.label ?? null
  const route = namedRoutes[0] ?? models.find((m) => m.id === (modelChoice ?? session?.model ?? defaultModel))
  const destinationError = destinationRefusal(toChatGpt ? 'chatgpt-director' : toSomeDirector ? 'native-director' : toParticipants ? 'participants' : 'agent', images.length)
  // A native director forwards the stored materials; its own model need not read them. Check only explicit
  // participant routes here. Without a known participant, the harness validates the actual dispatch route.
  const attachmentRoutes = toSomeDirector ? namedRoutes : namedRoutes.length ? namedRoutes : route ? [route] : []
  const attachmentError = (separate && images.length ? 'A separate task takes words only: remove the files, or send to the main agent.' : null)
    ?? destinationError ?? attachmentRoutes.map((m) => attachmentRefusal(m.capabilities, images.map(pendingMedia), m.label)).find(Boolean) ?? null
  const imagesRefused = !steering && !!attachmentError
  const hasMessage = !!draft.trim() || images.length > 0
  // an image still being read (a HEIC photo being made a JPEG) holds the send: it goes whole or not at all
  const imagesReading = images.some((i) => i.state === 'converting')
  const remoteBlocked = remote && (!ready(executionTarget, sshHosts) || !allows(executionTarget, 'direct_files', sshHosts) || images.length > 0 || separate || (named.length > 1 && groupPolicy === 'isolated'))
  const canSend = !remoteBlocked && hasMessage && !busy && !sending && !blocked && !imagesRefused && !imagesReading && !steerProblem && !noteGone
  const submit = async () => {
    // the words exactly as the editor holds them: never trimmed
    const words = draft
    if (remoteBlocked || !hasMessage || busy || sending || blocked || imagesRefused || imagesReading || steerProblem) return
    setSending(true)
    if (!hero) followThread()
    try {
      if (hero) await startTask(words)
      else if (separate) await sendSeparate(words)
      else if (steerRunId !== null) await steer(words, steerRunId)
      else await send(words)
    } catch (e) { showToast(e instanceof Error ? e.message : String(e)) } finally { setSending(false) }
  }
  const ringed = (button: ReactNode) => hero ? button : <ContextRing>{button}</ContextRing>
  return (
    <div className={`composer${hero ? ' composer-hero' : ''}${dragging ? ' is-dropping' : ''}`} data-testid={hero ? 'hero-composer' : 'thread-composer'}
         onDragOver={(e) => { if ((hasFiles(e) || hasThreadImage(e)) && !blocked && !steering) { e.preventDefault(); setDragging(true) } }}
         onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false) }}
         onDrop={(e) => {
           if (hasThreadImage(e)) {
             e.preventDefault(); setDragging(false)
             if (!blocked && !sending && !steering) void addDraggedImage(e.dataTransfer.getData(IMAGE_DRAG_MIME))
             return
           }
           if (!hasFiles(e)) return; e.preventDefault(); setDragging(false); if (!blocked && !sending && !steering) addImages([...e.dataTransfer.files])
         }}>
      <ComposerImages images={images} onRemove={removeImage} disabled={sending} />
      {!hero && <ReferenceChips toAgent={destination.kind === 'agent'} />}
      {steerProblem && <p className="composer-notice small" role="status" data-testid="steer-refused">{steerProblem}</p>}
      {imagesRefused && <p className="composer-notice small" role="status" data-testid="images-unsupported">
        {attachmentError}</p>}
      {!toSomeDirector && named.length === 1 && agentMentionsOf(draft).length >= 2 && <p className="composer-notice small" role="status" data-testid="one-participant">
        {named[0]!.label} is named twice as the same participant: one agent will answer. For two agents, pick it under "Add a participant" in the @ menu.</p>}
      {toSomeDirector && (ownDirector?.state === 'closed' || ownDirector?.state === 'paused' || ownDirector?.last_error) && <p className="composer-notice small" role="status" data-testid="director-unavailable">Director: {ownDirector.state}{ownDirector.last_error ? ` · ${ownDirector.last_error}` : ''}. Your draft is kept if sending is refused.</p>}
      <div className="composer-input">
        {at && options.length > 0 && (
          <MentionMenu options={options} picked={picked} participants={participants} chatWarning={chatGptSignIn(chatStatus)}
                       onHover={setPick} onChoose={choose} onConnect={() => { setAt(null); setChatGptSheet(true) }} />
        )}
        {toChatGpt && <span className="chatgpt-chip-slot" ref={chipSlot}><ChatGptChip warning={canNameChatGpt ? warning : null} onOpen={openChatGpt} onRemove={() => { setComposerTarget('agent'); editor.current?.focus() }} /></span>}
        {toDirector && <span className="chatgpt-chip-slot" ref={chipSlot}><DirectorChip label={directorLabel ?? ownDirector?.label ?? ownDirector?.model ?? 'default route'} onRemove={() => { setComposerTarget('agent'); editor.current?.focus() }} /></span>}
        <MentionEditor ref={editor} value={draft} onChange={setDraft} onCaret={track} autoFocus={autoFocus} testId="composer" className={hero ? 'composer-editor-hero' : undefined}
          style={indent ? { textIndent: indent } : undefined} logoFor={(agent) => agentImage(agent, models)}
          placeholder={toChatGpt ? 'Tell ChatGPT what you want — it plans, has the agents do the work and judges what they did…'
            : toDirector ? 'Tell the director what you want — name agents or ask them to work together in your own words…'
            : noteGone ? 'The group of this note ended — choose To again…'
            : toParticipants ? `${noteTo === 'everyone' ? 'A note to every participant' : `A note to ${noteTo}`}, handed at its next run${notePaused ? '; sending continues the interaction' : noteRound ? '; sending starts another round' : ''}…`
            : separate ? 'Describe the separate task — an agent of its own does it in a workspace of its own; the thread lists it with its state…'
            : steering ? 'Add to what the agent is doing — your words go into this run\'s next model request, after the step under way…'
            : blocked ? (relayLive && !liveRunId ? 'The relay hands over to its next agent…' : 'A run is in progress…') : hero ? 'Ask anything, or describe a task — pick a folder below if it works on your files; @ names ChatGPT or an agent…'
            : 'Tell the agent what should happen next — @ names ChatGPT, agents (two or more work together as you say), a file or a definition…'}
          disabled={blocked}
          onPasteFiles={(files) => { if (!blocked && !sending && !steering) addImages(files) }}
          onPasteLongText={(text) => { if (blocked || sending || steering) return false; addImages([pastedTextFile(text, images)]); return true }}
          onKeyDownCapture={(e) => {
            if (e.nativeEvent.isComposing || !at || options.length === 0) return
            if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); let next = (picked + 1) % options.length; while (!pickable(options[next]!) && next !== picked) next = (next + 1) % options.length; setPick(next) }
            else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); let next = (picked - 1 + options.length) % options.length; while (!pickable(options[next]!) && next !== picked) next = (next - 1 + options.length) % options.length; setPick(next) }
            else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); choose(options[picked]) }
            else if (e.key === 'Escape') { e.preventDefault(); setAt(null) }
          }}
          onKeyDown={(e) => {
            if (enterSends({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing })) { e.preventDefault(); void submit() }
            // Backspace before the words takes the chip away (as it would a mention)
            else if (e.key === 'Backspace' && toSomeDirector && editor.current?.read().caret === 0) { e.preventDefault(); setComposerTarget('agent') }
          }} />
      </div>
      {hero && importRefusal && (
        <div className="import-refusal" role="status" data-testid="import-refusal">
          <span className="import-refusal-text">{refusalLine(importRefusal)}</span>
          <button className="thread-btn primary" onClick={() => { void attachRefused().catch((e) => showToast(e instanceof Error ? e.message : String(e))) }} data-testid="attach-folder"
                  title="Copy nothing: the folder is read as it stands and never written; the session works in a scratch of its own">Attach it read-only</button>
          <button className="thread-btn" onClick={() => { setImportRefusal(null); (document.querySelector('[data-testid="folder-chip"]') as HTMLButtonElement | null)?.click() }}>Pick a subfolder</button>
        </div>
      )}
      <div className="composer-row">
        <div className="composer-actions">
          <button className="composer-chip composer-chip-icon" title="Attach files — images 5 MiB, UTF-8 text/code 1 MiB; PDF and MP4/WebM/MOV of any size, by reference (the desktop app names the file where it lies); up to 8"
                  aria-label="Attach files" disabled={!attachmentsAllowed || blocked || sending || steering} onClick={() => picker.current?.click()} data-testid="attach-images"><PaperclipIcon size={15} /></button>
          <input ref={picker} type="file" accept={ACCEPTED_TYPES.join(',')} multiple hidden data-testid="attach-input"
                 onChange={(e) => { addImages([...(e.target.files ?? [])]); e.target.value = '' }} />
          <span className="composer-sep" />
          {hero && <><FolderChip /><span className="composer-sep" /></>}
          {/* ChatGPT picks the agents' models itself (list_models); the pickers are the agent's */}
          {!toSomeDirector && named.length < 2 && <><AgentModelPicker /><span className="composer-sep" /></>}
          {toDirector && <><AgentModelPicker testId="director-model-picker" title="The director's model: it reads your words and has agents do the work" value={directorModelShown}
                                             onChange={(id) => { void setDirectorModel(id).catch((e) => showToast(e instanceof Error ? e.message : String(e))) }} /><span className="composer-sep" /></>}
          {!toSomeDirector && !interactionLive && named.length >= 2 && <><OrchestrationChip value={orchestration} rounds={relayRounds} onChange={setOrchestration} onRounds={setRelayRounds} agents={named.length} director={director?.director?.transport === 'bridge' ? (director.director.label || 'ChatGPT') : directorLabel}
                                                                                          maxRuns={interactionMaxRuns} concurrency={interactionConcurrency} onLimits={setInteractionLimits} inPlace={session?.workspace?.kind === 'direct'}
                                                                                          crossRounds={crossRounds} onCrossRounds={setCrossRounds} policy={groupPolicy} onPolicy={setGroupPolicy} projectKind={projectKind} /><span className="composer-sep" /></>}
          {!hero && !toSomeDirector && !toParticipants && named.length < 2 && <><fieldset className="ssh-inline-fieldset" disabled={remote}><SendAsChip value={sendAs} onChange={setSendAs} inPlace={session?.workspace?.kind === 'direct'} /></fieldset><span className="composer-sep" /></>}
          {(noteGroups.length > 0 || noteGone) && <><ToChip value={toParticipants ? noteTo : toSomeDirector ? 'director' : 'agent'} groups={noteGroups} all={interactions} chosen={destination.kind === 'note' ? destination.interactionId : null} gone={noteGone} hasDirector={true}
                                                           onChange={(to, group) => { try { setNoteTo(to, group) } catch (e) { showToast(e instanceof Error ? e.message : String(e)) } }} /><span className="composer-sep" /></>}
          {!toChatGpt && !toParticipants && <ThinkingChip />}
          {/* where the agent's commands run, for a session in the sandbox only: beside the mode, never part of it */}
          {!hero && <AccessChip />}
          {!toSomeDirector && !toParticipants && <button className="composer-chip" data-testid="restore-director" onClick={() => setNoteTo('director')} title="Route messages through the director again">Director</button>}
          {busy && <span className="composer-busy">{busy}…</span>}
          {!busy && toParticipants && interactionNotable && <span className="composer-busy composer-landing" data-testid="note-landing" title={noteLanding(interactionNotable, noteTo)}>{noteLanding(interactionNotable, noteTo)}</span>}
        </div>
        {/* one button while an agent runs: words in the composer go into its next request, an empty composer stops it */}
        {steering && (hasMessage || !liveRunId) ? (
          ringed(<button className="send-btn" title="Send into the running agent's next model request (a request or tool already under way is not interrupted)" disabled={!canSend} onClick={() => void submit()} data-testid="send" data-steer-run={steerRunId}><ArrowUpIcon size={14} /></button>)
        ) : steering ? (
          ringed(<button className="send-btn stop" title="Stop now" onClick={() => void stop()} data-testid="stop" data-steer-run={steerRunId}><StopIcon size={22} /></button>)
        ) : (liveRunId || relayLive) && !interactionLive && !toSomeDirector && !separate ? (
          ringed(<button className="send-btn stop" title={relayLive ? 'Stop the relay now' : 'Stop now'} onClick={() => void stop()} data-testid="stop"><StopIcon size={22} /></button>)
        ) : (
          ringed(<button className="send-btn" title={hero ? 'Start the task' : toSomeDirector ? 'Send to the director' : toParticipants ? (notePaused ? 'Send the note and continue' : noteRound ? 'Send the note and start another round' : 'Queue the note') : 'Send'} disabled={!canSend} onClick={() => void submit()} data-testid="send"><ArrowUpIcon size={14} /></button>)
        )}
      </div>
    </div>
  )
}
