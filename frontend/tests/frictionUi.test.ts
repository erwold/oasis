/** Regressions for the frontend half of the friction cleanup (2026-10-16): a task's sessions across folders in one
 *  rail group (12), a run waiting for the folder's writer said as waiting — never as thinking — with its blocker (13),
 *  a note's group chosen explicitly and never re-routed to the director (17), a command's actual access when it ran
 *  narrower than asked (8), and a session's extra folders with their access. New helpers are read through module
 *  namespaces so the same file runs (and fails on its assertions) against the code before them. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { InteractionDetail, InteractionNode } from '@oasis-code/contract'
import type { Project, Session } from '../src/api/types'
import * as rail from '../src/state/rail.ts'
import * as thread from '../src/state/thread.ts'
import * as outline from '../src/state/outline.ts'
import * as target from '../src/state/messageTarget.ts'
import * as ix from '../src/state/interaction.ts'
import * as calls from '../src/state/callView.ts'
import * as policy from '../src/state/workspacePolicy.ts'

type Loose = Record<string, unknown>
const fn = <T>(mod: unknown, name: string): T => (mod as Loose)[name] as T

const at = (d: number) => `2026-10-${String(d).padStart(2, '0')}T00:00:00.000Z`
const session = (id: string, projectId: string, active: number, over: Partial<Session> & { task_root_id?: string | null } = {}): Session => ({
  id, project_id: projectId, title: id, title_source: 'auto', workspace_id: null, model: 'm',
  grants: { workspace_write: true, run_commands: true, attached_write: false, network: false, network_until: null, network_reason: null },
  access_mode: 'sandbox', status: 'open', created_at: at(1), updated_at: at(1), last_activity_at: at(active), ...over,
} as Session)
const project = (id: string, path: string | null, sessions: Session[]): Project => ({
  id, name: id, kind: 'direct', source_path: path, base_repo_path: '', base_commit: null, base_branch: null, import_report: {}, default_model: null,
  config: {}, created_at: at(1), updated_at: at(1), sessions,
})

// ---- 12: one task across folders -------------------------------------------------------------------------------

test('12: a session joined to another session\'s task stands under that task, not under its own folder; its folder stays named', () => {
  const groups = rail.railGroups([
    project('app', '/work/app', [session('s_root', 'app', 3), session('s_alone', 'app', 2)]),
    project('docs', '/work/docs', [session('s_docs', 'docs', 5, { task_root_id: 's_root' }), session('s_other', 'docs', 1)]),
  ])
  const docs = groups.find((g) => g.project.id === 'docs')!
  const app = groups.find((g) => g.project.id === 'app')!
  // before: s_docs stood under docs, apart from the task it belongs to
  assert.deepEqual(docs.sessions.map((s) => s.id), ['s_other'])
  const members = (app as unknown as Loose).members as Record<string, { session: Session; project: Project }[]> | undefined
  assert.deepEqual(members?.s_root?.map((m) => [m.session.id, m.project.id]), [['s_docs', 'docs']])
  // the task's latest activity (its member's) orders the task and the folder that holds it
  assert.deepEqual(app.sessions.map((s) => s.id), ['s_root', 's_alone'])
  assert.deepEqual(groups.map((g) => g.project.id), ['app', 'docs'])
})

test('12: a null, self or unknown task root keeps the session where it was (nothing regrouped without the harness\'s word)', () => {
  const groups = rail.railGroups([
    project('a', '/a', [session('s1', 'a', 2, { task_root_id: null }), session('s2', 'a', 3, { task_root_id: 's2' })]),
    project('b', '/b', [session('s3', 'b', 4, { task_root_id: 's_deleted' })]),
  ])
  assert.deepEqual(groups.map((g) => [g.project.id, g.sessions.map((s) => s.id)]), [['b', ['s3']], ['a', ['s2', 's1']]])
  for (const g of groups) assert.deepEqual((g as unknown as Loose).members ?? {}, {})
})

test('12: same-folder members nest under their root too; a member never repeats at the top level', () => {
  const groups = rail.railGroups([project('a', '/a', [session('root', 'a', 1), session('m1', 'a', 6, { task_root_id: 'root' }), session('m2', 'a', 4, { task_root_id: 'root' })])])
  assert.deepEqual(groups[0]!.sessions.map((s) => s.id), ['root'])
  const members = (groups[0] as unknown as Loose).members as Record<string, { session: Session }[]>
  assert.deepEqual(members.root!.map((m) => m.session.id), ['m1', 'm2'])
})

// ---- 13: waiting for the folder's writer ----------------------------------------------------------------------

const queued = (over: Loose = {}) => ({ event: 'run_queued', data: { reason: 'workspace_lock', workspace_id: 'ws_1', blocking_owner: 'run_writer', blocking_kind: 'run', blocking_run_id: 'run_writer', queued_since: at(16), position: 1, ...over }, id: '1' })

test('13: run_queued on the workspace lock reads as waiting for the blocker by kind and id, not a bare reason code', () => {
  const rowOf = (e: ReturnType<typeof queued>) => thread.applyEvent([], 'r2', e)[0]!
  assert.equal(rowOf(queued()).text, 'Waiting for run run_writer')
  assert.equal(rowOf(queued({ blocking_owner: 'command:cmd_9', blocking_kind: 'command', blocking_run_id: undefined })).text, 'Waiting for command cmd_9')
  assert.equal(rowOf(queued({ blocking_owner: 'approval:prop_3', blocking_kind: 'approval', blocking_run_id: undefined })).text, 'Waiting for approval prop_3')
  // the kind read off the holder when the event does not name it
  assert.equal(rowOf(queued({ blocking_kind: undefined, blocking_owner: 'command:cmd_x', blocking_run_id: undefined })).text, 'Waiting for command cmd_x')
  // a run that ended with its background command still writing: the command by its execution id, never the run as running
  assert.equal(rowOf(queued({ blocking_kind: 'command', blocking_owner: 'run_done', blocking_run_id: 'run_done', blocking_execution_ids: ['exec_7', 'exec_8'] })).text, 'Waiting for command exec_7 +1')
  assert.equal(rowOf(queued({ blocking_kind: 'command', blocking_owner: 'run_done', blocking_run_id: 'run_done', blocking_execution_ids: [] })).text, 'Waiting for a command of run_done')
  assert.equal(rowOf(queued({ blocking_kind: 'approval', blocking_owner: 'approval:asset_1', blocking_proposal_id: 'prop_9', blocking_run_id: undefined })).text, 'Waiting for approval prop_9')
  // ChatGPT's own queue keeps its own words
  const chat = thread.applyEvent([], 'r3', { event: 'run_queued', data: { reason: "ChatGPT's page is answering another message; this one goes when it is free", scope: 'chatgpt:web' }, id: '1' })[0]!
  assert.equal(chat.text, "Queued: ChatGPT's page is answering another message; this one goes when it is free")
})

test('13: the live line says what the run waits for (never "thinking…" or "queued for its model"); the lock taken ends it', () => {
  const waiting = { reason: 'workspace_lock', workspace_id: 'ws_1', blocking_owner: 'run_writer', blocking_kind: 'run', blocking_run_id: 'run_writer', queued_since: at(16), position: 2 }
  assert.equal(outline.liveWord('idle', waiting as never), 'Waiting for run run_writer')
  assert.equal(outline.liveWord('thinking', null), 'thinking…')                                   // nothing waited for: unchanged
  const liveWaiting = fn<(run: Loose, entries: unknown[]) => Loose | null>(outline, 'liveWaiting')
  assert.equal(typeof liveWaiting, 'function')
  let rows = thread.applyEvent([], 'r2', queued())
  assert.equal(liveWaiting({ id: 'r2', status: 'running' }, rows)?.blocking_owner, 'run_writer')
  // words the person sent meanwhile (a steer row) do not end the wait
  assert.equal(liveWaiting({ id: 'r2', status: 'queued' }, [...rows, { kind: 'user', runId: 'r2', steer: { id: 'st' } }])?.blocking_kind, 'run')
  rows = thread.applyEvent(rows, 'r2', { event: 'slot_acquired', data: { scope: 'workspace:ws_1' }, id: '2' })
  assert.equal(liveWaiting({ id: 'r2', status: 'queued' }, rows), null)
  rows = thread.applyEvent(rows, 'r2', { event: 'run_started', data: { model: 'm' }, id: '3' })
  assert.equal(liveWaiting({ id: 'r2', status: 'running' }, rows), null)
  // before any event: the run's own record (GET /api/runs/:id waiting), only while it is queued
  assert.equal(liveWaiting({ id: 'r4', status: 'queued', waiting }, [])?.blocking_run_id, 'run_writer')
  assert.equal(liveWaiting({ id: 'r4', status: 'running', waiting }, []), null)
  assert.equal(liveWaiting({ id: 'r4', status: 'queued', waiting: null }, []), null)
  const slot = thread.applyEvent([], 'r2', { event: 'slot_acquired', data: { scope: 'workspace:ws_1' }, id: '9' })[0]!
  assert.equal(slot.text, 'Workspace ws_1 free · started')
})

test('13: the page\'s run record follows run_queued / slot_acquired (status and waiting) without a reload', () => {
  const after = fn<(run: Loose, items: { event: string; data: Loose }[]) => Loose>(outline, 'runAfterQueueEvents')
  assert.equal(typeof after, 'function')
  const run = { id: 'r2', status: 'running', waiting: null }
  const q = after(run, [queued()])
  assert.equal(q.status, 'queued')
  assert.equal((q.waiting as Loose).blocking_owner, 'run_writer')
  const going = after(q, [{ event: 'slot_acquired', data: { scope: 'workspace:ws_1' } }])
  assert.equal(going.status, 'running')
  assert.equal(going.waiting, null)
  assert.equal(after(run, [{ event: 'text_delta', data: { text: 'x' } }]), run)                   // nothing of the queue: the same record
  const tip = fn<(w: Loose) => string>(outline, 'waitingTitle')(q.waiting as Loose)
  assert.match(tip, /ws_1/)
  assert.match(tip, /position 1/)
  const many = outline.waitingOf({ ...queued().data, blocking_kind: 'command', blocking_owner: 'run_done', blocking_execution_ids: ['exec_7', 'exec_8'], blocking_session_id: 's_other' })!
  assert.deepEqual(many.blocking_execution_ids, ['exec_7', 'exec_8'])
  // the same fields nested under `waiting` (a run record as a whole, an event that carries it so) read the same
  assert.equal(outline.waitingOf({ status: 'queued', waiting: queued().data })?.blocking_run_id, 'run_writer')
  assert.equal(outline.waitingOf({ reason: 'ChatGPT is busy', scope: 'chatgpt:web' }), null)
  assert.match(fn<(w: unknown) => string>(outline, 'waitingTitle')(many), /session s_other · commands exec_7, exec_8/)
})

// ---- 17: notes to one of several groups ----------------------------------------------------------------------

const node = (id: string, participant: string, over: Partial<InteractionNode> = {}): InteractionNode => ({
  id, participant, instruction: null, depends_on: [], receives: [], workspace: 'own', status: 'queued', run_id: null, run_ids: [], workspace_id: null, error: null, seq: 1, wave: 1, ...over,
} as InteractionNode)
const group = (id: string, status: InteractionDetail['status'], created_at: string, words = id): InteractionDetail => ({
  workspace_policy: 'legacy', source_turn_id: null, id, session_id: 's', status, user_text: words, controller: 'director', template: null, then: 'stop', revision: 1,
  participants: [{ id: 'A', label: 'Model A', model: 'a' }, { id: 'B', label: 'Model B', model: 'b' }],
  budget: { max_runs: 6, concurrency: 2 }, runs_started: 0, base_checkpoint_id: null, fresh: false, resumes_run_id: null, director_session_id: null, director_turn_id: null,
  reason: null, attachments: [], client_request_id: null, created_at, updated_at: created_at, finished_at: null,
  nodes: [node('a1', 'A')], events: [], notes: [], live: true, in_place: false,
} as unknown as InteractionDetail)

test('17: several groups take notes: every one is a candidate, none chosen for the person', () => {
  const candidates = fn<(all: InteractionDetail[]) => InteractionDetail[]>(ix, 'noteCandidates')
  assert.equal(typeof candidates, 'function')
  const all = [group('ix_a', 'running', at(1)), group('ix_b', 'running', at(2)), group('ix_c', 'cancelled', at(3))]
  assert.deepEqual(candidates(all).map((g) => g.id), ['ix_a', 'ix_b'])
  assert.deepEqual(candidates([group('ix_p', 'waiting', at(1)), group('ix_d', 'done', at(2))]).map((g) => g.id), ['ix_p', 'ix_d'])
  assert.deepEqual(candidates([group('ix_old', 'done', at(1)), group('ix_new', 'done', at(2))]).map((g) => g.id), ['ix_new'])
})

test('17: a note whose group is no longer open is refused as such — never re-routed to the director', () => {
  const gone = target.messageDestination('director', ['ix_b'], 'everyone', 'ix_a')
  assert.notDeepEqual(gone, { kind: 'director' })
  assert.deepEqual(gone, { kind: 'note', interactionId: 'ix_a', to: 'everyone', gone: true })
  // the group still open among several: the note goes to it, whichever is first
  assert.deepEqual(target.messageDestination('director', ['ix_a', 'ix_b'], 'B', 'ix_b'), { kind: 'note', interactionId: 'ix_b', to: 'B' })
  // nothing chosen: the composer's own destination
  assert.deepEqual(target.messageDestination('agent', ['ix_a', 'ix_b'], 'director', null), { kind: 'agent' })
  assert.deepEqual(target.messageDestination('director', ['ix_a', 'ix_b'], 'everyone', null), { kind: 'director' })
})

test('17: a group is named by its words, cut short; two with the same words keep apart by their order', () => {
  const label = fn<(g: InteractionDetail, all: InteractionDetail[]) => string>(ix, 'groupLabel')
  assert.equal(typeof label, 'function')
  const a = group('ix_a', 'running', at(1), 'compare the two parsers and say which is faster on the benchmark'), b = group('ix_b', 'running', at(2), 'review')
  assert.equal(label(a, [a, b]), 'compare the two parsers and…')
  assert.equal(label(b, [a, b]), 'review')
  const same1 = group('ix_1', 'running', at(1), 'go'), same2 = group('ix_2', 'running', at(2), 'go')
  assert.deepEqual([label(same1, [same1, same2]), label(same2, [same1, same2])], ['go (1)', 'go (2)'])
})

// ---- 8: a command's actual access ----------------------------------------------------------------------------

test('8: a command that ran narrower than asked carries what was asked, what ran and why (the reasons as the harness gave them)', () => {
  const view = calls.callView('bash', { command: 'make' }, {
    status: 'succeeded', exit_code: 0, command: 'make', requested_access: 'full', effective_access: 'sandbox',
    access_reasons: [{ code: 'network_off', detail: 'the session has no network grant', next_step: 'grant the network to run it with full access' }],
  }) as Loose
  assert.equal(view.kind, 'command')
  assert.deepEqual(view.access, { requested: 'full', effective: 'sandbox', narrowed: true, restricted: false, restrictions: null, reasons: [{ code: 'network_off', detail: 'the session has no network grant', next_step: 'grant the network to run it with full access' }] })
  const same = calls.callView('bash', { command: 'ls' }, { status: 'succeeded', requested_access: 'full', effective_access: 'full', access_reasons: [] }) as Loose
  assert.deepEqual(same.access, { requested: 'full', effective: 'full', narrowed: false, restricted: false, restrictions: null, reasons: [] })
  const label = fn<(a: unknown) => string | null>(calls, 'commandAccessLabel')
  assert.equal(label(view.access), 'Sandbox')
  assert.equal(label(same.access), null)                                                             // ran as asked: no state shown
  // an older harness says nothing of it: nothing claimed
  assert.equal((calls.callView('bash', { command: 'ls' }, { status: 'succeeded' }) as Loose).access, null)
  const access = fn<(r: unknown) => Loose | null>(calls, 'commandAccess')
  const title = fn<(a: Loose) => string>(calls, 'commandAccessTitle')
  const a = access({ requested_access: 'full', effective_access: 'sandbox', access_reasons: [{ code: 'order_bounds', detail: 'the work order bounds its paths', next_step: null }, 'junk'] })!
  assert.equal(a.narrowed, true)
  assert.equal((a.reasons as unknown[]).length, 1)                                              // a malformed reason is dropped, never shown as words
  assert.equal(title(a), 'Requested Full access · ran in Sandbox\nthe work order bounds its paths')
  // full access with a filesystem restriction chosen for it (read_only): on the host, the restriction enforced — not the sandbox
  const ro = access({ requested_access: 'full', effective_access: 'full', restrictions: { environment: 'host', filesystem: 'restricted', enforced_by: 'seatbelt', write_denied: ['/work/app'], network: true, timeout_s: null, timeout_source: null, output_cap_bytes: null },
    access_reasons: [{ code: 'read_only', detail: 'the command was asked read-only', next_step: 'run it without read_only to write' }] })!
  assert.equal(ro.narrowed, false)
  assert.equal(ro.restricted, true)
  assert.equal(label(ro), 'Full access · files restricted')
  assert.equal(title(ro), 'Full access · files restricted (seatbelt)\nwrite denied: /work/app\nthe command was asked read-only — run it without read_only to write')
  // the same fields from execution_started land on the row (a result that does not repeat them still shows them)
  let rows = thread.applyEvent([], 'r1', { event: 'tool_call', data: { tool: 'bash', tool_call_id: 'c1', summary: 'ls' }, id: '1' })
  rows = thread.applyEvent(rows, 'r1', { event: 'execution_started', data: { tool_call_id: 'c1', execution_id: 'exec_1', command: 'ls', requested_access: 'full', effective_access: 'sandbox', access_reasons: [], restrictions: { environment: 'sandbox' } }, id: '2' })
  assert.equal(access({ ...rows[0]!.detail, ...(rows[0]!.result ?? {}) })?.narrowed, true)
})

// ---- session folders (roots) ---------------------------------------------------------------------------------

test('roots: the harness\'s list read from any of its answers; an access other than read or write is no root', () => {
  const rootsOf = fn<(v: unknown) => { path: string; access: string }[] | null>(policy, 'rootsOf')
  assert.equal(typeof rootsOf, 'function')
  const list = [{ path: '/work/docs', access: 'read' }, { path: '/work/out', access: 'write' }]
  assert.deepEqual(rootsOf(list), list)
  assert.deepEqual(rootsOf({ roots: list }), list)
  assert.deepEqual(rootsOf({ session: { roots: list } }), list)
  // GET /api/sessions/:id/roots: each with when it was added; the page keeps path and access
  assert.deepEqual(rootsOf({ session_id: 's', roots: list.map((r) => ({ ...r, created_at: 't' })), changeable: true, blocked_by: { runs: 0, executions: 0, approvals: 0 } }), list)
  assert.deepEqual(rootsOf({ roots: [{ path: '/x', access: 'admin' }, { path: 'rel', access: 'read' }, { path: '/y', access: 'read' }] }), [{ path: '/y', access: 'read' }])
  assert.equal(rootsOf({ id: 's' }), null)                                                       // says nothing of roots
})

test('integration 13: a run queued behind the harness\'s own step on the folder (a checkpoint, an integration — the lock\'s `operation` holder) is named by that step, not by a raw owner id', () => {
  const w = outline.waitingOf({ reason: 'workspace_lock', workspace_id: 'ws_1', blocking_owner: 'operation:checkpoint:op_9', blocking_kind: 'operation', blocking_run_id: null, blocking_execution_ids: [], queued_since: '2026-10-16T01:00:00Z', position: 1 })
  assert.ok(w)
  assert.equal(outline.waitingLine(w!), 'Waiting for checkpoint')
  // the kind read off the owner when a harness leaves it out
  assert.equal(outline.waitingLine(outline.waitingOf({ blocking_owner: 'operation:integrate:op_2' })!), 'Waiting for integrate')
})
