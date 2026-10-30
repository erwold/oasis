/** Computer use beyond a plain ok: an action whose answer never came may have happened (unknown, never a refusal),
 *  the desktop's own words on what was done pass through; and an approved computer action — the whole action shown to
 *  the person, the network grant and the run's order checked again when it runs, an "approve once" of the network
 *  bound to its target, the ended run's hold on the page let go after. */

import { afterEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { GrantsSchema, type Session } from '@oasis-code/contract'
import { orderRefusal, parseWorkOrder } from '../src/agent/work_orders.ts'
import type { ComputerClient } from '../src/computer/desktop.ts'
import * as repo from '../src/db/repo.ts'
import { BridgeError } from '../src/llm/chatgpt_web.ts'
import { lastToolReturn, modelResponse, textPart, toolCallPart, type ModelMessage } from '../src/llm/messages.ts'
import * as gate from '../src/policy/gate.ts'
import { applySessionMode } from '../src/policy/modes.ts'
import { appState, buggyRepo, closeState, openSession, scriptedModel, setModel, waitDone, type AppState } from './harness.ts'
import { rec } from './tree_helpers.ts'

let state: AppState | null = null
afterEach(async () => { if (state) await closeState(state); state = null })

type Rec = Record<string, unknown>
const JPEG = readFileSync(join(import.meta.dir, 'fixtures', 'images', 'red-7x5.jpg'))

/** The desktop app as the test plays it: every request kept, each answered by `answer`. */
function fakeComputer(answer: (path: string, body: Rec) => Rec | Error): ComputerClient & { calls: [string, Rec][] } {
  const calls: [string, Rec][] = []
  return {
    calls, downloadsDir: null,
    request: async (path, body) => {
      calls.push([path, body])
      const out = answer(path, body)
      if (out instanceof Error) throw out
      return out
    },
  }
}

const look = (extra: Rec = {}) => ({
  status: 'ok', surface: 'browser', snapshot_id: 'browser-1', url: 'https://example.com/', title: 'Example', loading: false,
  viewport: { width: 1265, height: 800 }, image: { media_type: 'image/jpeg', data_base64: JPEG.toString('base64'), width: 7, height: 5 },
  outline: '- button "Go" [ref=e7]', dialog: null, notes: [], ...extra,
})

/** A run that calls the tools in turn and keeps what each returned. */
function playing(calls: [string, Rec][], box: Rec[]) {
  let n = 0
  return (messages: ModelMessage[]) => {
    if (n > 0) box.push(rec(lastToolReturn(messages, calls[n - 1]![0])))
    const next = calls[n]
    n += 1
    return next ? modelResponse([toolCallPart(next[0], next[1], '')]) : modelResponse([textPart('done')])
  }
}

function setNetwork(st: AppState, session: Session, network: boolean, until: string | null = null): void {
  repo.setSessionGrants(st.conn, session.id, { ...GrantsSchema.parse({ ...repo.getSession(st.conn, session.id)!.grants }), network, network_until: until })
}

/** One fresh run of the session that calls computer_act with `args`; what it returned. */
async function act(st: AppState, session: Session, args: Rec): Promise<Rec> {
  const box: Rec[] = []
  setModel(st, 'scripted:a', scriptedModel(playing([['computer_act', args]], box)))
  await waitDone(st, (await st.runs.start(repo.getSession(st.conn, session.id)!, 'act', { fresh: true })).id)
  return box[0]!
}

/** In a session that asks before changes, a run that proposes `args` (after a look, when `observe` is given); the
 *  pending proposal, the run and what the model was told. */
async function proposed(st: AppState, session: Session, args: Rec, observe: Rec | null = null) {
  const box: Rec[] = []
  setModel(st, 'scripted:a', scriptedModel(playing([...(observe ? [['computer_observe', observe] as [string, Rec]] : []), ['computer_act', args]], box)))
  const run = await waitDone(st, (await st.runs.start(repo.getSession(st.conn, session.id)!, 'act', { fresh: true })).id)
  const gated = box[box.length - 1]!
  expect(gated.status).toBe('action_gated')
  const proposal = gate.listProposals(st.conn, session.project_id, session.id).find((p) => p.status === 'pending')!
  return { proposal, run, gated }
}

// ---- what an action's outcome is, when its answer is not a plain ok ------------------------------------------------

test('test_computer_outcome_unknown: an action whose answer never came (timed out, connection dropped) may have happened — unknown, never refused', async () => {
  let answer: Rec | Error = new BridgeError('the bridge at http://127.0.0.1:1 did not answer POST /computer/act within 90 s', 'timeout', 'http://127.0.0.1:1')
  state = await appState({ computer: fakeComputer(() => answer) })
  const { session } = await openSession(state, buggyRepo())
  const click = { action: 'click', ref: 'e8', snapshot_id: 'browser-2' }
  const timedOut = await act(state, session, click)
  expect(timedOut.status).toBe('unknown')
  expect(String(timedOut.reason)).toContain('may or may not have happened')
  expect(String(timedOut.reason)).toContain('did not answer POST /computer/act')
  answer = new BridgeError('the connection to the bridge dropped before it answered POST /computer/act (socket hang up)', 'lost', 'http://127.0.0.1:1')
  expect((await act(state, session, click)).status).toBe('unknown')
  // nothing reached the app, or the app refused the request: nothing was done
  answer = new BridgeError('the bridge at http://127.0.0.1:1 is not reachable (ECONNREFUSED)', 'unreachable', 'http://127.0.0.1:1')
  expect((await act(state, session, click)).status).toBe('refused')
  answer = new BridgeError('the bridge refused POST /computer/act (400): bad body', 'refused', 'http://127.0.0.1:1', 400)
  expect((await act(state, session, click)).status).toBe('refused')
})

test("test_computer_outcome_statuses: done, look_failed and the desktop's nothing-done statuses reach the model as the app said them", async () => {
  let answer: Rec = {}
  state = await appState({ computer: fakeComputer(() => answer) })
  const { session } = await openSession(state, buggyRepo())
  const click = { action: 'click', ref: 'e8', snapshot_id: 'browser-2' }
  // acted, then the look after it failed: done and look_failed, said as done
  answer = { status: 'ok', action: 'click', done: { clicked: 'e8' }, look_failed: 'Page.getLayoutMetrics did not answer within 15 s' }
  const lookFailed = await act(state, session, click)
  expect([lookFailed.status, rec(lookFailed.done).clicked, lookFailed.look_failed]).toEqual(['ok', 'e8', 'Page.getLayoutMetrics did not answer within 15 s'])
  expect(String(lookFailed.outcome)).toContain('The action was done; the look after it failed')
  // an error that carries done: what was done passes through
  answer = { status: 'error', reason: 'the settle failed', done: { clicked: 'e8' } }
  const erredAfter = await act(state, session, click)
  expect([erredAfter.status, rec(erredAfter.done).clicked, erredAfter.reason, erredAfter.outcome]).toEqual(['error', 'e8', 'the settle failed', undefined])
  // an error that names nothing done: whether it acted is not known
  answer = { status: 'error', reason: 'Input.dispatchMouseEvent failed' }
  const erred = await act(state, session, click)
  expect(erred.status).toBe('error')
  expect(erred.reason).toBe('Input.dispatchMouseEvent failed. Whether the action happened is unknown. Look at the page before acting again.')
  // nothing done: cancelled; unstable and not_actionable with their reason and the fresh look
  answer = { status: 'cancelled', reason: 'the run let go of the page before the action started; nothing was done' }
  expect(await act(state, session, click)).toMatchObject({ status: 'cancelled', reason: 'the run let go of the page before the action started; nothing was done' })
  for (const status of ['unstable', 'not_actionable']) {
    answer = look({ status, reason: `${status}: e8 moved`, snapshot_id: 'browser-9' })
    const refusal = await act(state, session, click)
    expect([refusal.status, refusal.reason, refusal.snapshot_id, refusal.outline, refusal.outcome]).toEqual([status, `${status}: e8 moved`, 'browser-9', '- button "Go" [ref=e7]', undefined])
  }
})

// ---- approvals of computer actions -----------------------------------------------------------------------------------

test('test_computer_approval_release: the approval acts as the ended run and lets the page go after, whatever the answer', async () => {
  const computer = fakeComputer((path, body) => path === '/computer/release' ? { status: 'ok', released: ['browser'] } : look({ action: body.action, done: { clicked: body.ref } }))
  state = await appState({ computer })
  const { session } = await openSession(state, buggyRepo())
  applySessionMode(state.conn, session, 'approve')
  const { proposal, run } = await proposed(state, session, { action: 'click', ref: 'e7', snapshot_id: 'browser-1' })
  computer.calls.length = 0
  const decided = await gate.decideProposal(state, proposal.proposal_asset_id, 'approve')
  expect(rec(decided.result).status).toBe('ok')
  expect(computer.calls).toEqual([
    ['/computer/act', { surface: 'browser', owner: run.id, session: session.id, approval: true, action: 'click', snapshot_id: 'browser-1', ref: 'e7' }],
    ['/computer/release', { owner: run.id }],
  ])
  // an answer that never came: unknown, recorded as such, and the page let go all the same
  const lost = fakeComputer((path) => path === '/computer/release' ? { status: 'ok', released: [] } : new BridgeError('the bridge did not answer POST /computer/act within 90 s', 'timeout', 'http://127.0.0.1:1'))
  state.computer = lost
  const second = await proposed(state, session, { action: 'click', ref: 'e7', snapshot_id: 'browser-1' })
  const unknown = await gate.decideProposal(state, second.proposal.proposal_asset_id, 'approve')
  expect(rec(unknown.result).status).toBe('unknown')
  const row = gate.listProposals(state.conn, session.project_id, session.id).find((p) => p.proposal_asset_id === second.proposal.proposal_asset_id)!
  expect(gate.proposalLine(row)).toContain('whether it happened is unknown')
  expect(lost.calls.map((c) => c[0])).toEqual(['/computer/act', '/computer/release'])
})

test('test_computer_approval_rechecks_grant: an approval waiting while the network grant is turned off or runs out is refused as a fresh call is; nothing reaches the app', async () => {
  const computer = fakeComputer((_path, body) => look({ action: body.action, done: {} }))
  state = await appState({ computer })
  const { session } = await openSession(state, buggyRepo())
  applySessionMode(state.conn, session, 'approve')
  for (const [network, until] of [[false, null], [true, new Date(Date.now() - 60_000).toISOString()]] as const) {
    setNetwork(state, session, true)
    const { proposal } = await proposed(state, session, { action: 'click', ref: 'e7', snapshot_id: 'browser-1' })
    setNetwork(state, session, network, until)
    computer.calls.length = 0
    const decided = await gate.decideProposal(state, proposal.proposal_asset_id, 'approve')
    expect(rec(decided.result)).toMatchObject({ status: 'refused_by_policy', action: 'network', tool: 'computer_act' })
    expect(computer.calls.filter((c) => c[0] === '/computer/act')).toEqual([])
    // the record says nothing was done, and the next run reads it so
    const row = gate.listProposals(state.conn, session.project_id, session.id).find((p) => p.proposal_asset_id === proposal.proposal_asset_id)!
    expect(row.decision!.outcome).toBe('refused')
    expect(gate.proposalLine(row)).toContain('refused when it ran; nothing was done')
    // the network approval it asked for names the action whole, as a fresh call's would
    expect(repo.getApproval(state.conn, String(rec(decided.result).approval_id))!.params).toEqual({ surface: 'browser', action: 'click', snapshot_id: 'browser-1', ref: 'e7' })
  }
})

test("test_computer_approval_rechecks_order: the order of the run that proposed it is checked again — its network off refuses the approval, as it refuses a fresh call", async () => {
  const computer = fakeComputer((_path, body) => look({ action: body.action, done: {} }))
  state = await appState({ computer })
  const { session } = await openSession(state, buggyRepo())
  applySessionMode(state.conn, session, 'approve')
  const { proposal, run } = await proposed(state, session, { action: 'click', ref: 'e7', snapshot_id: 'browser-1' })
  const offline = parseWorkOrder({ prompt: 'act on the page', execution: { commands: true, network: false } })
  // the proposing run as one under an order with the network off
  state.conn.run('UPDATE runs SET work_order_json = ? WHERE id = ?', [JSON.stringify(offline), run.id])
  computer.calls.length = 0
  const decided = await gate.decideProposal(state, proposal.proposal_asset_id, 'approve')
  expect(rec(decided.result)).toMatchObject({ status: 'refused_by_work_order', tool: 'computer_act' })
  expect(String(rec(decided.result).reason)).toContain('Network access is off for this run')
  expect(computer.calls.filter((c) => c[0] === '/computer/act')).toEqual([])
  // the computer tools reach the web whatever their effect: such an order refuses a fresh look or action too
  expect(orderRefusal(offline, 'computer_act', 'state_change', { network: true })).toBe('Network access is off for this run')
  expect(orderRefusal(offline, 'computer_observe', 'read', { network: true })).toBe('Network access is off for this run')
  expect(orderRefusal(offline, 'read_file', 'read', {})).toBeNull()
})

test('test_computer_network_once_bound_to_target: "approve once" lets exactly the action it was asked for through, never another click', async () => {
  const computer = fakeComputer((_path, body) => look({ action: body.action, done: { clicked: body.ref } }))
  state = await appState({ computer })
  const { session } = await openSession(state, buggyRepo())
  setNetwork(state, session, false)
  const asked = await act(state, session, { action: 'click', ref: 'e7', snapshot_id: 'browser-1' })
  expect(asked.status).toBe('refused_by_policy')
  const approval = repo.getApproval(state.conn, String(asked.approval_id))!
  expect(approval.params).toEqual({ surface: 'browser', action: 'click', snapshot_id: 'browser-1', ref: 'e7' })
  state.gate.decide(approval.id, true)
  // another element, a point, another look, other text: none of them is the approved action
  for (const other of [{ action: 'click', ref: 'e9', snapshot_id: 'browser-1' }, { action: 'click', x: 10, y: 20, snapshot_id: 'browser-1' },
    { action: 'click', ref: 'e7', snapshot_id: 'browser-2' }, { action: 'type', ref: 'e7', text: 'x', snapshot_id: 'browser-1' }]) {
    expect((await act(state, session, other)).status).toBe('refused_by_policy')
  }
  expect(computer.calls.filter((c) => c[0] === '/computer/act')).toEqual([])
  expect(repo.getApproval(state.conn, approval.id)!.status).toBe('approved')
  // the approved one goes, once
  expect((await act(state, session, { action: 'click', ref: 'e7', snapshot_id: 'browser-1' })).status).toBe('ok')
  expect(repo.getApproval(state.conn, approval.id)!.status).toBe('consumed')
})

test('test_computer_network_once_then_proposal: with the network off in a session that asks before changes, the action approved once is not asked for again when its proposal runs', async () => {
  const computer = fakeComputer((_path, body) => look({ action: body.action, done: { clicked: body.ref } }))
  state = await appState({ computer })
  const { session } = await openSession(state, buggyRepo())
  applySessionMode(state.conn, session, 'approve')
  setNetwork(state, session, false)
  const asked = await act(state, session, { action: 'click', ref: 'e7', snapshot_id: 'browser-1' })
  state.gate.decide(String(asked.approval_id), true)
  const { proposal } = await proposed(state, session, { action: 'click', ref: 'e7', snapshot_id: 'browser-1' })
  const decided = await gate.decideProposal(state, proposal.proposal_asset_id, 'approve')
  expect(rec(decided.result).status).toBe('ok')
  expect(state.gate.listPending(session.id)).toEqual([])
})

test("test_computer_proposal_label: the person reads the whole action — target, text, keys, look — and a dialog's answer names the dialog the run last saw", async () => {
  const computer = fakeComputer((path) => path === '/computer/observe'
    ? look({ snapshot_id: 'browser-3', dialog: { type: 'confirm', message: 'DELETE record 42 permanently?' }, image: null, outline: '' })
    : look())
  state = await appState({ computer })
  const { session } = await openSession(state, buggyRepo())
  applySessionMode(state.conn, session, 'approve')
  const dialog = await proposed(state, session, { action: 'dialog', accept: true, snapshot_id: 'browser-3' }, {})
  expect(dialog.proposal.label).toBe('computer_act accept the open dialog (the confirm the run last saw: "DELETE record 42 permanently?") on browser, chosen on look browser-3')
  expect(String(dialog.gated.message)).toContain('DELETE record 42 permanently?')
  expect(gate.loadProposal(state.conn, state.store, dialog.proposal.proposal_asset_id).context).toEqual({ dialog: { type: 'confirm', message: 'DELETE record 42 permanently?' } })
  await gate.decideProposal(state, dialog.proposal.proposal_asset_id, 'reject')
  const labels: [Rec, string][] = [
    [{ action: 'type', ref: 'e4', text: 'amount=5000', clear: true, submit: true, snapshot_id: 'browser-3' }, 'computer_act type "amount=5000" into e4 on browser, emptying the field first, then Enter, chosen on look browser-3'],
    [{ action: 'key', keys: 'Meta+Backspace', snapshot_id: 'browser-3' }, 'computer_act press "Meta+Backspace" on browser, chosen on look browser-3'],
    [{ action: 'click', x: 120, y: 340, snapshot_id: 'browser-3' }, 'computer_act click the point 120,340 on browser, chosen on look browser-3'],
    [{ action: 'navigate', url: 'https://example.com/a?b=1' }, 'computer_act navigate to "https://example.com/a?b=1" on browser'],
    // a dialog answered with no look of it in the run: said so
    [{ action: 'dialog', accept: false, snapshot_id: 'browser-3' }, 'computer_act dismiss the open dialog (the run did not see which) on browser, chosen on look browser-3'],
  ]
  for (const [args, label] of labels) {
    const p = await proposed(state, session, args)
    expect(p.proposal.label).toBe(label)
    await gate.decideProposal(state, p.proposal.proposal_asset_id, 'reject')
  }
})

test('test_computer_proposal_names_what_the_look_showed: a ref is shown with its line in the look the action names', async () => {
  const computer = fakeComputer(() => look({ snapshot_id: 'browser-5', outline: '- list\n  - button "Archive item 7" [ref=e12]\n  - button "Delete ALL items" [ref=e13]' }))
  state = await appState({ computer })
  const { session } = await openSession(state, buggyRepo())
  applySessionMode(state.conn, session, 'approve')
  const click = await proposed(state, session, { action: 'click', ref: 'e12', snapshot_id: 'browser-5' }, {})
  expect(click.proposal.label).toBe('computer_act click e12 ("button \\"Archive item 7\\"") on browser, chosen on look browser-5')
  await gate.decideProposal(state, click.proposal.proposal_asset_id, 'reject')
  // a look the run never had: the ref alone
  const unseen = await proposed(state, session, { action: 'click', ref: 'e12', snapshot_id: 'browser-9' })
  expect(unseen.proposal.label).toBe('computer_act click e12 on browser, chosen on look browser-9')
})

test('test_computer_input_without_look_refused_before_proposal: an input action or a dialog answer naming no look is never put to the person', async () => {
  const computer = fakeComputer(() => look())
  state = await appState({ computer })
  const { session } = await openSession(state, buggyRepo())
  applySessionMode(state.conn, session, 'approve')
  for (const args of [{ action: 'click', ref: 'e7' }, { action: 'type', text: 'x' }, { action: 'dialog', accept: true }]) {
    const out = await act(state, session, args)
    expect(out.status).toBe('refused')
    expect(String(out.reason)).toContain('needs the snapshot_id of the look it was chosen on')
  }
  expect(gate.listProposals(state.conn, session.project_id, session.id)).toEqual([])
  expect(computer.calls.filter((c) => c[0] === '/computer/act')).toEqual([])
  // navigation needs no look: proposed as before
  await proposed(state, session, { action: 'navigate', url: 'https://example.com/' })
})

test('test_computer_approval_error_is_failed: an approved action that ends in an error is recorded as failed, never as completed', async () => {
  const computer = fakeComputer((path) => path === '/computer/release' ? { status: 'ok', released: [] } : { status: 'error', reason: 'No node with given id found' })
  state = await appState({ computer })
  const { session } = await openSession(state, buggyRepo())
  applySessionMode(state.conn, session, 'approve')
  const { proposal } = await proposed(state, session, { action: 'click', ref: 'e7', snapshot_id: 'browser-1' })
  const decided = await gate.decideProposal(state, proposal.proposal_asset_id, 'approve')
  expect(rec(decided.result).status).toBe('error')
  const row = gate.listProposals(state.conn, session.project_id, session.id).find((p) => p.proposal_asset_id === proposal.proposal_asset_id)!
  expect(row.decision?.outcome).toBe('failed')
  expect(gate.proposalLine(row)).toContain(': failed.')
  expect(gate.proposalLine(row)).not.toContain('completed')
})

test('test_computer_tabs_network_once_then_first_navigate_proposal: network off, asks before changes, a first navigate — nothing reaches the app until the person lets exactly that action reach the web; then it is bound to the run\'s own tab and proposed, and its approval runs there without asking for the network again', async () => {
  const computer = fakeComputer((path, body) => path === '/computer/release' ? { status: 'ok', released: [] }
    : look({ action: body.action ?? null, tab_id: 'tab-own', tabs: [{ tab_id: 'tab-own', url: 'about:blank', title: '', current: true }] }))
  state = await appState({ computer })
  const { session } = await openSession(state, buggyRepo())
  applySessionMode(state.conn, session, 'approve')
  setNetwork(state, session, false)
  const navigate = { action: 'navigate', url: 'https://example.com/a' }
  // asked for the network first: no look, no tab, nothing at all reaches the app
  const asked = await act(state, session, navigate)
  expect(asked.status).toBe('refused_by_policy')
  expect(computer.calls).toEqual([])
  const approval = repo.getApproval(state.conn, String(asked.approval_id))!
  expect(approval.params).toEqual({ surface: 'browser', action: 'navigate', url: 'https://example.com/a' })
  state.gate.decide(approval.id, true)
  // the same action again: let through for exactly it, bound to the run's own tab by a look without a picture, proposed
  const { proposal, run } = await proposed(state, session, navigate)
  expect(repo.getApproval(state.conn, approval.id)!.status).toBe('consumed')
  expect(computer.calls).toEqual([['/computer/observe', { surface: 'browser', owner: run.id, session: session.id, screenshot: false }], ['/computer/release', { owner: run.id }]])
  const payload = gate.loadProposal(state.conn, state.store, proposal.proposal_asset_id)
  expect(payload.validated_args).toMatchObject({ action: 'navigate', url: 'https://example.com/a', tab_id: 'tab-own' })
  expect(payload.context).toEqual({ network_approved_once: true })
  // another action is not that one: still asked for, never observed for
  computer.calls.length = 0
  expect((await act(state, session, { action: 'navigate', url: 'https://example.com/other' })).status).toBe('refused_by_policy')
  expect(computer.calls).toEqual([])
  // approved: it runs on the bound tab as the ended run, the network not asked for again; the page let go after
  const pendingBefore = state.gate.listPending(session.id).length
  const decided = rec((await gate.decideProposal(state, proposal.proposal_asset_id, 'approve')).result)
  expect([decided.status, decided.tab_id]).toEqual(['ok', 'tab-own'])
  expect(state.gate.listPending(session.id).length).toBe(pendingBefore)
  expect(computer.calls).toEqual([
    ['/computer/act', { surface: 'browser', owner: run.id, session: session.id, approval: true, action: 'navigate', tab_id: 'tab-own', url: 'https://example.com/a' }],
    ['/computer/release', { owner: run.id }],
  ])
})

test('test_computer_tabs_binding_fails_closed: when the run\'s own tab cannot be had for a first navigate (refused, the browser full, no answer), nothing is proposed — no approval can later land on a page the run opens after', async () => {
  let answer: Rec | Error = { status: 'refused', reason: 'the browser has 12 agent tabs open; close one first' }
  const computer = fakeComputer((path) => path === '/computer/release' ? { status: 'ok', released: [] } : answer)
  state = await appState({ computer })
  const { session } = await openSession(state, buggyRepo())
  applySessionMode(state.conn, session, 'approve')
  const navigate = { action: 'navigate', url: 'https://example.com/a' }
  const full = await act(state, session, navigate)
  expect(full.status).toBe('refused')
  expect(String(full.reason)).toContain("This run's own browser tab could not be had for the action (the browser has 12 agent tabs open; close one first); nothing was proposed")
  expect(computer.calls.map((c) => [c[0], c[1].screenshot ?? null])).toEqual([['/computer/observe', false], ['/computer/release', null]])
  answer = new BridgeError('the bridge at http://127.0.0.1:1 did not answer POST /computer/observe within 90 s', 'timeout', 'http://127.0.0.1:1')
  expect((await act(state, session, navigate)).status).toBe('refused')
  answer = new BridgeError('the bridge at http://127.0.0.1:1 is not reachable (ECONNREFUSED)', 'unreachable', 'http://127.0.0.1:1')
  expect(String((await act(state, session, navigate)).reason)).toContain('the oasis-code desktop app is not running')
  answer = { status: 'busy', reason: 'the person is clearing the browser\'s data' }
  expect((await act(state, session, navigate)).status).toBe('busy')
  // no proposal of any of them: nothing an approval could later send to a page the run opens by then
  expect(gate.listProposals(state.conn, session.project_id, session.id)).toEqual([])
  expect(computer.calls.filter((c) => c[0] === '/computer/act')).toEqual([])
  // the app answers again: the run's tab is had, and only then is the action proposed — bound to it
  answer = look({ tab_id: 'tab-later', tabs: [{ tab_id: 'tab-later', url: 'about:blank', title: '', current: true }] })
  const { proposal } = await proposed(state, session, navigate)
  expect(gate.loadProposal(state.conn, state.store, proposal.proposal_asset_id).validated_args).toMatchObject({ tab_id: 'tab-later' })
  expect(gate.listProposals(state.conn, session.project_id, session.id).length).toBe(1)
})
