/** Computer use: an agent looks at a page the desktop app holds and acts on it (desktop/computer.js does the looking
 *  and the input, and keeps who may act on a page now). Two tools: `computer_observe` — a screenshot, the page's
 *  outline (its controls, each with a ref) and a snapshot_id, or the page's text — and `computer_act` — a click, typing,
 *  keys, scrolling, navigation, an upload or a dialog's answer, named against the look it was chosen on, answered with
 *  the look after it. The pages are the agent's own browser and the person's signed-in ChatGPT page.
 *
 *  Both need the session's network grant (and, under a work order, the order's network): a page is the web. An
 *  approval of the network asked for one action is bound to that action's target (its ref or point, text, keys, look).
 *  Looking is a read; acting changes something outside (a form sent, a message posted), so Plan mode refuses it and a
 *  session that asks before changes gets it proposed — its approval checks the grant and the order again when it runs,
 *  and the desktop app refuses it when the look it names is no longer current there.
 *  An action whose answer did not come back (the request timed out, the connection dropped) may have happened: it is
 *  said so (status unknown), never as a refusal.
 *  A screenshot is kept as an image of the session (content-addressed) and handed to the model as an image; page
 *  text and outlines are untrusted data. Files to upload are read through the path policy, as read_file reads. */

import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { COMPUTER_SURFACES, COMPUTER_TAB_ACTIONS, computerActSchema, z, type ComputerActArgs, type ComputerSurface } from '@oasis-code/contract'
import { saveAttachment } from '../../api/attachments.ts'
import type { ComputerClient } from '../../computer/desktop.ts'
import * as crepo from '../../db/collab_repo.ts'
import type { Conn } from '../../db/database.ts'
import * as repo from '../../db/repo.ts'
import { BridgeError } from '../../llm/chatgpt_web.ts'
import { ImageRefused, imageToolPiece, measureImage } from '../../llm/images.ts'
import { toolReturns } from '../../llm/messages.ts'
import { checkActionGate, effectiveControl, effectsFor, GATEABLE_TOOLS, setGateHooks, shouldGate, type ExecutionContext } from '../../policy/gate.ts'
import { ActionGate, networkGranted } from '../../policy/permissions.ts'
import { PROMPT_TEXT, text } from '../../prompt_texts.ts'
import { PathPolicy, PathRefused } from '../../workspace/paths.ts'
import { workspaceAttached } from '../../workspace/service.ts'
import { refreshSession } from '../deps.ts'
import { orderRefusal } from '../work_orders.ts'
import { finish, orderRefused, refused, type Ctx, type Payload } from './common.ts'
import { register } from './registry.ts'
import { networkRefusal, UNTRUSTED } from './web.ts'

type Rec = Record<string, unknown>

const NOT_RUNNING = 'the oasis-code desktop app is not running (or its bridge did not start): the pages computer use acts on live in the app'
// what of the desktop's answer the model reads (the picture goes as an image of its own)
const PASSED = ['surface', 'tab_id', 'action', 'done', 'snapshot_id', 'url', 'title', 'loading', 'viewport', 'scroll', 'dialog', 'outline', 'text', 'offset', 'total_chars', 'next_offset', 'released', 'holder', 'covering', 'reason', 'look_failed', 'console']
/** The actions that answer what a look showed (input, and a dialog's answer): each names that look. */
const NEEDS_LOOK = new Set(['click', 'double_click', 'right_click', 'hover', 'type', 'key', 'scroll', 'select', 'drag', 'upload', 'dialog'])
/** The agent browser's own tab actions (a run opens, selects and closes its own tabs; never on chatgpt). */
const TAB_ACTIONS = new Set<string>(COMPUTER_TAB_ACTIONS)
/** Actions that go to no one tab: release lets go of every page the run holds; tab_new opens a new one. */
const NO_TAB = new Set(['release', 'tab_new'])
/** What of a tab a look lists (the desktop app lists the run's own tabs only; anything else is not passed on). */
const TAB_FIELDS = ['tab_id', 'url', 'title', 'current', 'loading'] as const
/** Fields of a page a refusal must not carry when the tab it names is not one of the run's own. */
const PAGE_FIELDS = ['snapshot_id', 'url', 'title', 'loading', 'viewport', 'scroll', 'dialog', 'outline', 'text', 'offset', 'total_chars', 'next_offset', 'image', 'display_image', 'downloads', 'console', 'notes']
const TAB_REFUSAL = 'tab_id, tab_new, tab_select and tab_close are for the browser surface (the chatgpt surface is one page)'
/** How long past its own seconds a wait's request may take (the look after it). */
const WAIT_SLACK_MS = 60_000

interface ObserveArgs { surface: ComputerSurface; tab_id?: string | null; screenshot: boolean; read_text: boolean; ref: string | null; snapshot_id: string | null; offset: number | null }

/** The short name the person reads on the Browser card for the run's tabs: its participant's own name (an order's or a
 *  group member's label, else its alias in the group), from the session's records — never the page's words, and never
 *  the model's name alone (several runs of one model would read the same: null, and the card shows the run's id).
 *  The identity is always `owner` (the run) and `session`; this is a label only. */
export function ownerLabel(conn: Conn, runId: string | null, modelLabel: string | null = null): string | null {
  if (!runId) return null
  try {
    const meta = crepo.getRunMeta(conn, runId)
    const participant = meta?.participant_id ? crepo.getParticipant(conn, meta.participant_id) : null
    if (participant === null) return null
    const clean = (v: string | null | undefined) => (v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)
    const generic = new Set([clean(modelLabel), clean(participant.model), clean(meta?.model)].filter(Boolean))
    for (const name of [clean(participant.label), clean(participant.alias)]) if (name && !generic.has(name)) return name
    return null
  } catch {
    return null
  }
}

/** Who asks, as the desktop app takes it: the run (`owner`, always the run's own id — never the model's arguments),
 *  its session, and on the browser the run's short label for the person. The chatgpt page's body is as it was. */
function whoAsks(ctx: Ctx, surface: ComputerSurface): Rec {
  const who: Rec = { owner: ctx.deps.run_id, session: ctx.deps.session.id }
  if (surface === 'browser') {
    const label = ownerLabel(ctx.deps.conn, ctx.deps.run_id, ctx.deps.model_cfg.label ?? null)
    if (label !== null) who.owner_label = label
  }
  return who
}

/** Whether a failed request may still have reached the desktop app and been acted on: it was sent, and its answer
 *  never came (timed out, or the connection dropped after the request went). An unreachable app or a refused request
 *  did nothing. */
function mayHaveActed(error: BridgeError): boolean {
  return error.kind === 'timeout' || error.kind === 'lost'
}

/** The desktop app's answer, or the payload that says why there is none (the app not running, its token refused; for
 *  an action, an answer that never came: its outcome unknown). */
async function ask(ctx: Ctx, tool: string, path: '/computer/observe' | '/computer/act', body: Rec, timeoutMs?: number, acting = false): Promise<{ out: Rec } | { payload: Payload }> {
  const computer = ctx.deps.computer
  if (computer === null) return { payload: refused(ctx, tool, NOT_RUNNING) }
  ctx.deps.computer_used = true
  try {
    return { out: await computer.request(path, body, ctx.deps.cancel_signal, timeoutMs) }
  } catch (error) {
    if (ctx.deps.cancel_signal.aborted || !(error instanceof BridgeError)) throw error
    if (acting && mayHaveActed(error)) {
      const reason = text('computer.outcome_unknown', { detail: error.message })
      return { payload: finish(ctx, tool, { status: 'unknown', reason }, { summary: reason.slice(0, 200), surface: body.surface ?? null, action: body.action ?? null }) }
    }
    const reason = error.kind === 'unreachable' ? NOT_RUNNING
      : error.status === 401 ? "the desktop app refused this backend's token (it belongs to another data directory, or another start of the app)"
        : error.message
    return { payload: refused(ctx, tool, reason) }
  }
}

/** What an action names, nothing left null: its surface and kind, its target (ref or point, a drop target), its
 *  text, keys, look and options. The desktop app's body and the network approval's parameters are both this. */
function actionFields(args: ComputerActArgs, files: string[] | null): Rec {
  const body: Rec = { surface: args.surface, action: args.action }
  for (const key of ['tab_id', 'snapshot_id', 'ref', 'x', 'y', 'to_ref', 'to_x', 'to_y', 'text', 'keys', 'dx', 'dy', 'url', 'seconds'] as const) if (args[key] !== null) body[key] = args[key]
  if (args.clear) body.clear = true
  if (args.submit) body.submit = true
  if (args.gone) body.gone = true
  if (args.download) body.download = true
  if (args.action === 'dialog') body.accept = args.accept
  if (files !== null) body.files = files
  return body
}

/** The body of an action as the desktop app takes it: the run that acts and its session (the app clears the browser
 *  when another session takes it, and keeps it across the runs of one session), its label on the browser, and for an
 *  approval's action `approval: true` (the desktop then acts on the page it names or nowhere — never a new tab). */
function actionBody(args: ComputerActArgs, who: Rec, files: string[] | null, approval = false): Rec {
  return { ...actionFields(args, files), ...who, ...(approval && args.surface === 'browser' ? { approval: true } : {}) }
}

/** How long an action's request may take: a wait's own seconds and the look after it. */
function timeoutOf(args: ComputerActArgs): number | undefined {
  if (args.action !== 'wait') return undefined
  return Math.min(300, Math.max(1, args.seconds ?? 30)) * 1000 + WAIT_SLACK_MS
}

/** What the page downloaded, moved from the desktop app's folder into the workspace's temporary folder (the one
 *  read_file and bash reach, and the session's later runs too); a file the app did not put in its own folder is not
 *  touched. */
function takeDownloads(from: string | null, temp: string | null, raw: unknown): Rec[] {
  if (!Array.isArray(raw) || from === null) return []
  const taken: Rec[] = []
  for (const item of raw.slice(0, 20) as Rec[]) {
    const source = typeof item.path === 'string' ? item.path : ''
    const name = typeof item.name === 'string' && item.name ? basename(item.name) : 'download'
    if (!source || relative(resolve(from), resolve(source)).startsWith('..') || isAbsolute(relative(resolve(from), resolve(source)))) continue
    if (temp === null) { taken.push({ name, bytes: item.bytes ?? null, path: null, note: 'no temporary folder to keep it in' }); continue }
    const dir = join(temp, 'downloads')
    mkdirSync(dir, { recursive: true })
    let target = join(dir, name)
    for (let n = 2; existsSync(target); n += 1) target = join(dir, name.replace(/(\.[^.]*)?$/, ` (${n})$1`))
    try {
      try { renameSync(source, target) } catch { copyFileSync(source, target); rmSync(source, { force: true }) }
      taken.push({ name, path: target, bytes: statSync(target).size, ...(typeof item.media_type === 'string' ? { media_type: item.media_type } : {}), ...(typeof item.url === 'string' ? { from_url: item.url } : {}) })
    } catch (error) {
      taken.push({ name, path: null, note: `not taken: ${(error as Error).message}` })
    }
  }
  return taken
}

/** The desktop's answer as the model reads it: the look's fields, the screenshot kept and handed over as an image,
 *  the downloads moved into the workspace's temporary folder, the note that the page is someone else's words. For an
 *  action, what is known of its outcome: done and its look failed, or an error that does not say whether it acted. */
function present(ctx: Ctx, tool: string, out: Rec, what: string, acting = false): Payload {
  const deps = ctx.deps
  out = ownView(out, deps.run_id)
  const payload: Payload = { status: typeof out.status === 'string' ? out.status : 'error' }
  for (const key of PASSED) if (out[key] !== undefined && out[key] !== null && out[key] !== '') payload[key] = out[key]
  if (Array.isArray(out.tabs)) payload.tabs = out.tabs
  if (acting) Object.assign(payload, outcomeOf(out))
  if (Array.isArray(out.notes) && out.notes.length) payload.notes = out.notes
  const downloads = takeDownloads(deps.computer?.downloadsDir ?? null, deps.policy.temp, out.downloads)
  if (downloads.length) payload.downloads = downloads
  let assetId: string | null = null
  const image = out.image && typeof out.image === 'object' ? (out.image as Rec) : null
  if (image && typeof image.data_base64 === 'string') {
    try {
      const attachment = saveAttachment({ conn: deps.conn, store: deps.store }, deps.session, new Uint8Array(Buffer.from(image.data_base64, 'base64')), `${String(out.snapshot_id ?? 'screen')}.jpg`)
      payload.screenshot = imageToolPiece(attachment, deps.model_cfg.capabilities)
      assetId = attachment.asset_id
    } catch (error) {
      if (!(error instanceof ImageRefused)) throw error
      payload.screenshot_missing = error.message
    }
  }
  // This is a second encoding of the same capture, for the person's history view. The model keeps the image
  // above (and its coordinate convention). Store only its asset ID in history so replay retains the sharp view.
  const display = out.display_image && typeof out.display_image === 'object' ? out.display_image as Rec : null
  if (assetId && display && typeof display.data_base64 === 'string' && display.data_base64.length <= Math.ceil(4 * 1024 * 1024 / 3) * 4) {
    try {
      const bytes = new Uint8Array(Buffer.from(display.data_base64, 'base64'))
      const measured = measureImage(bytes)
      if (bytes.length <= 4 * 1024 * 1024 && Math.max(measured.width, measured.height) <= 2560) {
        const attachment = saveAttachment({ conn: deps.conn, store: deps.store }, deps.session, bytes, `${String(out.snapshot_id ?? 'screen')}-display.jpg`)
        payload.screenshot_display_asset_id = attachment.asset_id
      }
    } catch { /* optional display data must not lose the model's screenshot or the action's result */ }
  }
  if (payload.outline !== undefined || payload.text !== undefined || payload.screenshot !== undefined) payload.untrusted = UNTRUSTED
  const page = String(out.title || out.url || '')
  const line = payload.status === 'ok' ? `${what}${page ? ` · ${page}` : ''}` : `${what}: ${payload.status}${out.reason ? ` — ${String(out.reason)}` : ''}`
  return finish(ctx, tool, payload, {
    summary: line.slice(0, 200), surface: out.surface ?? null, action: out.action ?? null, url: out.url ?? null, title: out.title ?? null,
    snapshot_id: out.snapshot_id ?? null, screenshot_asset_id: assetId,
    ...(payload.screenshot_display_asset_id ? { screenshot_display_asset_id: payload.screenshot_display_asset_id } : {}),
  })
}

/** The desktop's answer as this run may see it: its `tabs` list only the run's own tabs, each with what a look lists
 *  of it (a tab another run owns is dropped, should one ever come); an answer whose `tab_id` is not one of those tabs
 *  carries nothing of that page (no picture, outline, text, address or title) — another run's page is never shown. */
function ownView(out: Rec, runId: string): Rec {
  if (!Array.isArray(out.tabs)) return out
  const tabs = (out.tabs as unknown[]).filter((t): t is Rec => !!t && typeof t === 'object' && typeof (t as Rec).tab_id === 'string')
    .filter((t) => t.owner === undefined || t.owner === null || t.owner === runId)
    .map((t) => Object.fromEntries(TAB_FIELDS.filter((k) => t[k] !== undefined).map((k) => [k, t[k]])))
  const view: Rec = { ...out, tabs }
  if (typeof out.tab_id === 'string' && !tabs.some((t) => t.tab_id === out.tab_id)) {
    for (const key of PAGE_FIELDS) delete view[key]
    delete view.tab_id
  }
  return view
}

/** What an action's answer says of its outcome beyond its status, as the fields that say it: acted with the look
 *  after it failed (an outcome beside the look_failed reason), or an error that names nothing done (the desktop says
 *  `done` once its input went out) — whether it acted is unknown, said in its reason. */
function outcomeOf(out: Rec): Rec {
  if (out.status === 'ok' && typeof out.look_failed === 'string' && out.look_failed) return { outcome: text('computer.acted_look_failed') }
  if (out.status === 'error' && (out.done === undefined || out.done === null)) return { reason: `${String(out.reason || 'the action failed')}. ${text('computer.error_unknown')}` }
  return {}
}

export async function computerObserve(ctx: Ctx, args: ObserveArgs): Promise<Payload> {
  const tool = 'computer_observe'
  const blocked = networkRefusal(ctx, tool, { surface: args.surface })
  if (blocked !== null) return blocked
  const tab = args.tab_id ? { tab_id: args.tab_id } : {}
  if (args.tab_id && args.surface !== 'browser') return refused(ctx, tool, TAB_REFUSAL)
  const who = whoAsks(ctx, args.surface)
  const asked = args.read_text
    ? await ask(ctx, tool, '/computer/act', { surface: args.surface, ...who, action: 'read_text', ...tab, ...(args.ref ? { ref: args.ref } : {}), ...(args.snapshot_id ? { snapshot_id: args.snapshot_id } : {}), offset: args.offset ?? 0 })
    : await ask(ctx, tool, '/computer/observe', { surface: args.surface, ...who, ...tab, screenshot: args.screenshot })
  if ('payload' in asked) return asked.payload
  return present(ctx, tool, asked.out, args.read_text ? `read ${args.surface}` : `look at ${args.surface}`)
}

/** The files an upload names, as paths on this machine: each within the work order's scope and the path policy, and a
 *  file; or the refusal. */
function uploadFiles(ctx: Ctx, tool: string, paths: string[]): { files: string[] } | { payload: Payload } {
  if (!paths.length) return { payload: refused(ctx, tool, 'upload needs files') }
  const files: string[] = []
  for (const path of paths) {
    const blocked = orderRefused(ctx, tool, { path })
    if (blocked !== null) return { payload: blocked }
    let real: string
    try {
      ;[, real] = ctx.deps.policy.resolveRead(path)
    } catch (error) {
      if (error instanceof PathRefused) return { payload: refused(ctx, tool, error.message) }
      throw error
    }
    let isFile = false
    try { isFile = statSync(real).isFile() } catch { isFile = false }
    if (!isFile) return { payload: refused(ctx, tool, `'${path}' is not a file`) }
    files.push(real)
  }
  return { files }
}

export async function computerAct(ctx: Ctx, args: ComputerActArgs): Promise<Payload> {
  const tool = 'computer_act'
  if (ctx.deps.workspace.target?.kind === 'ssh' && (args.action === 'upload' || args.download)) return refused(ctx, tool, 'Browser files are local; automatic transfer to or from an SSH workspace is unavailable.', { code: 'capability_unavailable' })
  // refused before anything is asked of the person: the desktop app would refuse it however it was approved
  if (NEEDS_LOOK.has(args.action) && !args.snapshot_id) return refused(ctx, tool, `${args.action} needs the snapshot_id of the look it was chosen on (computer_observe gives one; every action answers with the next)`)
  if (args.surface !== 'browser' && (TAB_ACTIONS.has(args.action) || args.tab_id)) return refused(ctx, tool, TAB_REFUSAL)
  if (args.action === 'tab_select' && !args.tab_id) return refused(ctx, tool, "tab_select needs tab_id: one of this run's tabs (its looks list them)")
  if (args.action === 'tab_new' && args.tab_id) return refused(ctx, tool, 'tab_new opens a new tab; tab_id names one already open (tab_select goes to it)')
  // the tab the action is for, fixed now (the look it names, else the run's latest tab): what is approved is that
  // page's action, never another's
  if (args.surface === 'browser' && args.snapshot_id && !args.tab_id && earlierRunsLook(ctx, args.snapshot_id)) {
    const reason = `snapshot ${args.snapshot_id} is a look an earlier run took; this run has tabs of its own (look again with computer_observe). Nothing was done.`
    return finish(ctx, tool, { status: 'stale', reason }, { summary: reason.slice(0, 200), surface: args.surface, action: args.action })
  }
  args = { ...args, tab_id: boundTab(ctx, args) }
  // the network approval names the whole action: approved once, it lets exactly this target through
  const blocked = networkRefusal(ctx, tool, actionFields(args, args.files))
  if (blocked !== null) return blocked
  // let through with the grant off: the person approved the network for exactly this action, and its proposal says so
  const approvedOnce = !networkGranted(refreshSession(ctx.deps).grants)
  let files: string[] | null = null
  if (args.action === 'upload') {
    const resolved = uploadFiles(ctx, tool, args.files ?? [])
    if ('payload' in resolved) return resolved.payload
    files = resolved.files
  }
  // a session that asks before changes: the action is proposed (with the dialog it answers, when the run's last look
  // at that page showed one), and the desktop app refuses its approval when that look is no longer current there.
  // A browser action for no tab yet (the run's first, a navigate say) is bound to the run's own tab first — the one a
  // look would open — since its approval acts on the page it names or nowhere (it never opens one).
  // When that tab cannot be had (refused, the browser full, the app not answering), nothing is proposed: an approval
  // with no page of its own could land on whatever page the run has by then.
  if (args.surface === 'browser' && args.tab_id === null && !NO_TAB.has(args.action) && !args.snapshot_id && wouldGate(ctx)) {
    const own = await ownTab(ctx, tool)
    if ('payload' in own) return own.payload
    args = { ...args, tab_id: own.tab }
  }
  const gated = await checkActionGate(ctx, tool, args as unknown as Rec, null, proposalContext(ctx, args, approvedOnce))
  if (gated !== null) return gated
  const asked = await ask(ctx, tool, '/computer/act', actionBody(args, whoAsks(ctx, args.surface), files), timeoutOf(args), true)
  if ('payload' in asked) return asked.payload
  const target = args.ref ?? (args.x !== null && args.y !== null ? `${args.x},${args.y}` : args.url ?? args.keys ?? (TAB_ACTIONS.has(args.action) ? args.tab_id ?? '' : ''))
  return present(ctx, tool, asked.out, `${args.action}${target ? ` ${target}` : ''} on ${args.surface}`, true)
}

/** What a proposed action carries beside its arguments: whether the network was let through by an approval of exactly
 *  this action (the grant was off), and for a dialog's answer the dialog the run's latest look at that page showed
 *  (its kind and message), for the person to judge it by. */
function proposalContext(ctx: Ctx, args: ComputerActArgs, approvedOnce: boolean): Rec | null {
  const dialog = args.action === 'dialog' ? lastDialog(ctx, args) : null
  const targets = targetsOf(ctx, args)
  if (!approvedOnce && dialog === null && targets === null) return null
  return { ...(approvedOnce ? { network_approved_once: true } : {}), ...(dialog !== null ? { dialog } : {}), ...(targets !== null ? { targets } : {}) }
}

/** Whether this run's state-changing tool calls are proposed rather than run (a session that asks before changes),
 *  as checkActionGate decides it. */
function wouldGate(ctx: Ctx): boolean {
  const deps = ctx.deps
  if (!GATEABLE_TOOLS.has('computer_act')) return false
  return shouldGate(effectsFor('computer_act'), effectiveControl(deps.conn, deps.session.id, deps.run_id, (deps as { parent_run_id?: string | null }).parent_run_id ?? null))
}

/** The browser tab an action is for, from what this run itself was answered: the tab_id it names; else the tab of
 *  the look it names (that look's own — never a later one); else, for an action naming no look, the tab of the run's
 *  latest browser answer (a closed tab's answer names the run's current tab); null when none says. An earlier run's
 *  answers in the conversation are never this run's tabs: its tabs are its own. */
function boundTab(ctx: Ctx, args: ComputerActArgs): string | null {
  if (args.surface !== 'browser' || NO_TAB.has(args.action)) return args.tab_id
  if (args.tab_id) return args.tab_id
  const answers = browserAnswers(ctx, true)
  if (args.snapshot_id) {
    const look = answers.find((a) => a.snapshot_id === args.snapshot_id)
    return look && typeof look.tab_id === 'string' && look.tab_id ? look.tab_id : null
  }
  return currentTab(answers)
}

/** The run's current tab as its latest answer that says it: an answer naming its tab; or an ok answer listing the
 *  run's tabs with none named (its last tab closed: none is current — never an older answer's tab, which may be the
 *  one closed). A refusal says nothing of it. Null when none says. */
function currentTab(answers: Rec[]): string | null {
  for (const a of answers) {
    if (typeof a.tab_id === 'string' && a.tab_id) return a.tab_id
    if (a.status === 'ok' && Array.isArray(a.tabs)) {
      const current = (a.tabs as Rec[]).find((t) => t && t.current === true && typeof t.tab_id === 'string')
      return current ? String(current.tab_id) : null
    }
  }
  return null
}

/** The answers on the browser surface in the conversation, latest first — with `own`, this run's only: of the
 *  conversation's computer answers, the last as many as this run recorded results of, and each one a call this run
 *  recorded (its tool_call_id among them). A conversation carries earlier runs' answers too; those are never this
 *  run's. */
function browserAnswers(ctx: Ctx, own = false): Rec[] {
  const out: Rec[] = []
  let parts = toolReturns(ctx.messages ?? []).filter((p) => p.tool_name === 'computer_observe' || p.tool_name === 'computer_act')
  if (own) {
    const mine = repo.listEvents(ctx.deps.conn, ctx.deps.run_id)
      .filter((e) => e.event === 'tool_result' && (e.data.tool === 'computer_observe' || e.data.tool === 'computer_act'))
      .map((e) => String(e.data.tool_call_id ?? ''))
    const ids = new Set(mine)
    parts = mine.length ? parts.slice(-mine.length).filter((p) => ids.has(String(p.tool_call_id ?? ''))) : []
  }
  for (const part of [...parts].reverse()) {
    let content: unknown = part.content
    if (typeof content === 'string') { try { content = JSON.parse(content) } catch { continue } }
    if (!content || typeof content !== 'object') continue
    const answer = content as Rec
    if (answer.surface !== undefined && answer.surface !== 'browser') continue
    out.push(answer)
  }
  return out
}

/** The browser look an action was chosen on, exactly: this run's own answer with its snapshot_id, of its tab (when
 *  the action names one, the look must be of that tab). Undefined when there is none — then nothing is described from
 *  any other look (a later one, another tab's, an earlier run's). */
function chosenLook(ctx: Ctx, args: ComputerActArgs): Rec | undefined {
  if (!args.snapshot_id) return undefined
  return browserAnswers(ctx, true).find((l) => l.snapshot_id === args.snapshot_id && (l.surface === undefined || l.surface === 'browser')
    && (!args.tab_id || l.tab_id === args.tab_id))
}

/** Whether the look a snapshot id names is one an earlier run of the conversation took (and this run did not). */
function earlierRunsLook(ctx: Ctx, snapshotId: string): boolean {
  if (browserAnswers(ctx, true).some((a) => a.snapshot_id === snapshotId)) return false
  return browserAnswers(ctx).some((a) => a.snapshot_id === snapshotId)
}

/** The run's own browser tab, by a look without a picture (a read: the one the run's first look would open, its
 *  current one when it has one). A look that is not ok (refused, busy, the browser full) or no answer at all is the
 *  refusal of the action, said so — nothing is proposed. An ok look naming no tab is a desktop app without tabs (one
 *  page, as before tabs): null. The look is the run's use of the page: let go when the run ends. */
async function ownTab(ctx: Ctx, tool: string): Promise<{ tab: string | null } | { payload: Payload }> {
  const computer = ctx.deps.computer
  if (computer === null) return { payload: refused(ctx, tool, NOT_RUNNING) }
  ctx.deps.computer_used = true
  let out: Rec
  try {
    out = await computer.request('/computer/observe', { surface: 'browser', ...whoAsks(ctx, 'browser'), screenshot: false }, ctx.deps.cancel_signal)
  } catch (error) {
    if (ctx.deps.cancel_signal.aborted || !(error instanceof BridgeError)) throw error
    const why = error.kind === 'unreachable' ? NOT_RUNNING : error.status === 401 ? "the desktop app refused this backend's token" : error.message
    return { payload: refused(ctx, tool, `${text('computer.no_own_tab', { reason: why })}`) }
  }
  if (out.status === 'ok') return { tab: typeof out.tab_id === 'string' && out.tab_id ? out.tab_id : null }
  const status = typeof out.status === 'string' && out.status ? out.status : 'error'
  const reason = text('computer.no_own_tab', { reason: String(out.reason || status) })
  return { payload: finish(ctx, tool, { status, reason, ...(typeof out.holder === 'string' ? { holder: out.holder } : {}) }, { summary: reason.slice(0, 200), surface: 'browser', action: null }) }
}

/** The run's answers that looked at the page (a refusal without a look says nothing of it), latest first. */
function looksOf(ctx: Ctx): Rec[] {
  const looks: Rec[] = []
  for (const part of [...toolReturns(ctx.messages ?? [])].reverse()) {
    if (part.tool_name !== 'computer_observe' && part.tool_name !== 'computer_act') continue
    let content: unknown = part.content
    if (typeof content === 'string') { try { content = JSON.parse(content) } catch { continue } }
    if (!content || typeof content !== 'object') continue
    const look = content as Rec
    if (look.snapshot_id === undefined && look.dialog === undefined) continue
    looks.push(look)
  }
  return looks
}

/** The dialog the look the action was chosen on showed: on the browser, the look its snapshot_id names among this run's
 *  own answers (that page's, never another tab's later dialog); on chatgpt (one page), the run's latest look there.
 *  Null when that look showed none, or there is no such look. */
function lastDialog(ctx: Ctx, args: ComputerActArgs): Rec | null {
  const look = args.surface === 'browser' ? chosenLook(ctx, args)
    : looksOf(ctx).find((l) => l.surface === undefined || l.surface === args.surface)
  const dialog = look && look.dialog && typeof look.dialog === 'object' ? (look.dialog as Rec) : null
  if (dialog === null) return null
  return { type: typeof dialog.type === 'string' ? dialog.type : null, message: typeof dialog.message === 'string' ? dialog.message.slice(0, 2000) : null }
}

/** What the refs an action names were in the look it names — `{ e12: 'button "Archive item 7"' }`, its outline's
 *  lines — for the person to judge the action by; null when it names none, or the run has no such look. */
function targetsOf(ctx: Ctx, args: ComputerActArgs): Rec | null {
  const refs = [args.ref, args.to_ref].filter((r): r is string => typeof r === 'string' && r !== '')
  if (!refs.length || !args.snapshot_id) return null
  const look = args.surface === 'browser' ? chosenLook(ctx, args) : looksOf(ctx).find((l) => l.snapshot_id === args.snapshot_id)
  if (!look || typeof look.outline !== 'string') return null
  const targets: Rec = {}
  for (const ref of refs) {
    const line = look.outline.split('\n').find((l) => l.includes(`[ref=${ref}]`))
    if (line) targets[ref] = line.replace(` [ref=${ref}]`, '').replace(/^\s*- /, '').slice(0, 200)
  }
  return Object.keys(targets).length ? targets : null
}

/** The refusal an approved action meets when it runs where a fresh call of it would be refused: the order of the run
 *  that proposed it (its tools, its network, its paths), then the session's network grant as it stands now (an
 *  approval of the network for exactly this action is used, as a fresh call uses it; otherwise one is asked for). */
function refusedAtExecution(conn: Conn, args: ComputerActArgs, ctx: ExecutionContext): Rec | null {
  const tool = 'computer_act'
  const paths = args.action === 'upload' ? args.files ?? [] : []
  const reason = [orderRefusal(ctx.order, tool, 'state_change', { network: true }), ...paths.map((path) => orderRefusal(ctx.order, tool, 'state_change', { path }))].find((r) => r !== null) ?? null
  if (reason !== null) return { status: 'refused_by_work_order', tool, reason: text('refusal.constraint', { reason }) }
  // the network let through by the person's approval of exactly this action stays approved for it
  if (ctx.context?.network_approved_once === true) return null
  const session = repo.getSession(conn, ctx.session.id)
  if (session === null) return { status: 'refused', tool, reason: `session ${ctx.session.id} is gone` }
  const refusal = new ActionGate(conn).check(session, 'network', actionFields(args, args.files), { run_id: ctx.run_id, tool_call_id: ctx.tool_call_id })
  return refusal === null ? null : { ...refusal, tool }
}

// an approved proposal acts through the same desktop app, as the run that proposed it, once the grant and the order
// still allow it; the desktop refuses it when the look it names is no longer current. The run has ended by then, so
// its hold on the page is let go after (another run would otherwise read the page busy until the hold lapses) — and
// what the action downloaded is taken into the workspace's temporary folder before that (letting go drops it).
setGateHooks({ executors: { computer_act: async (host, raw, ctx) => {
  const args = raw as unknown as ComputerActArgs
  if (ctx.workspace.target?.kind === 'ssh' && (args.action === 'upload' || args.download)) return { status: 'refused', code: 'capability_unavailable', reason: 'Browser files are local; remote transfer is unavailable.' }
  const refusal = refusedAtExecution(host.conn, args, ctx)
  if (refusal !== null) return refusal
  let files: string[] | null = null
  if (args.action === 'upload') {
    const policy = PathPolicy.forWorkspace(ctx.workspace.path, ctx.protected, workspaceAttached(ctx.project, ctx.workspace, { writable: false }), { temp: ctx.temp })
    files = (args.files ?? []).map((path) => {
      const [, real] = policy.resolveRead(path)
      if (!statSync(real).isFile()) throw new Error(`'${path}' is not a file`)
      return real
    })
  }
  const computer = (host as { computer?: ComputerClient }).computer
  if (!computer) throw new Error(NOT_RUNNING)
  const owner = ctx.run_id ?? `approval:${ctx.tool_call_id ?? 'unknown'}`
  let out: Rec
  let downloads: Rec[] = []
  try {
    try {
      const who: Rec = { owner, session: ctx.session.id }
      const label = args.surface === 'browser' ? ownerLabel(host.conn, ctx.run_id ?? null) : null
      if (label !== null) who.owner_label = label
      out = await computer.request('/computer/act', actionBody(args, who, files, true), undefined, timeoutOf(args))
    } catch (error) {
      if (!(error instanceof BridgeError) || !mayHaveActed(error)) throw error
      out = { status: 'unknown', reason: text('computer.outcome_unknown', { detail: error.message }) }
    }
    out = ownView(out, owner)
    downloads = takeDownloads(computer.downloadsDir ?? null, ctx.temp, out.downloads)
  } finally {
    const run = ctx.run_id ? repo.getRun(host.conn, ctx.run_id) : null
    if (run === null || run.status !== 'running') {
      try { await computer.request('/computer/release', { owner }) } catch { /* the hold lapses by itself */ }
    }
  }
  // the look after it stays with the app: the approval's record keeps what was done, where the page is and what it
  // downloaded
  return {
    status: typeof out.status === 'string' ? out.status : 'error', surface: args.surface, action: args.action,
    ...(args.surface === 'browser' && (typeof out.tab_id === 'string' || args.tab_id) ? { tab_id: typeof out.tab_id === 'string' ? out.tab_id : args.tab_id } : {}),
    done: out.done ?? null, url: out.url ?? null, title: out.title ?? null,
    ...(out.reason ? { reason: out.reason } : {}), ...(typeof out.look_failed === 'string' && out.look_failed ? { look_failed: out.look_failed } : {}), ...outcomeOf(out),
    ...(downloads.length ? { downloads } : {}),
  }
} } })

const describe = (tool: string) => (key: string) => PROMPT_TEXT[`parameter.${tool}.${key}` as keyof typeof PROMPT_TEXT] as string | undefined

register({
  name: 'computer_observe', effect: 'read', action: 'network', renderer: 'computer', summary: 'look at a page the desktop app holds',
  description: PROMPT_TEXT['tool.computer_observe'],
  schema: z.object({
    surface: z.enum(COMPUTER_SURFACES).default('browser').describe(PROMPT_TEXT['parameter.computer_observe.surface']),
    tab_id: z.string().nullable().default(null).describe(PROMPT_TEXT['parameter.computer_observe.tab_id']),
    screenshot: z.boolean().default(true).describe(PROMPT_TEXT['parameter.computer_observe.screenshot']),
    read_text: z.boolean().default(false).describe(PROMPT_TEXT['parameter.computer_observe.read_text']),
    ref: z.string().nullable().default(null).describe(PROMPT_TEXT['parameter.computer_observe.ref']),
    snapshot_id: z.string().nullable().default(null).describe(PROMPT_TEXT['parameter.computer_observe.snapshot_id']),
    offset: z.number().int().nullable().default(null).describe(PROMPT_TEXT['parameter.computer_observe.offset']),
  }), fn: computerObserve,
})

register({
  name: 'computer_act', effect: 'state_change', action: 'network', renderer: 'computer', summary: 'act on a page the desktop app holds',
  description: PROMPT_TEXT['tool.computer_act'],
  schema: computerActSchema(describe('computer_act')), fn: computerAct,
})
