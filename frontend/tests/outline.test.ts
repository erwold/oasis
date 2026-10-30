import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RunTreeRow } from '../src/api/types'
import { threadActionRecord } from '@oasis-code/contract'
import { BOT_HEX, BOTS, CHATGPT_BOT, INK_DARK, INK_LIGHT, botFor, botSrc, botState, buildTree, busyOf, liveWord, dependencyEdges, durationOf, glyphFor, glyphTitle, inkOn, isActionRow, nameOf, selectionChain, waitsLabel, waitsNames, threadActions } from '../src/state/outline.ts'

const row = (id: string, over: Partial<RunTreeRow> = {}): RunTreeRow => ({
  id, session_id: 's', parent_run_id: null, resumes_run_id: null, spawned_by: 'human', label: null, model: 'm', status: 'done', live: false,
  created_at: '2026-09-26T10:00:00.000Z', finished_at: '2026-09-26T10:01:30.000Z', workspace_id: 'ws', user_text: 'go', user_text_head: 'go',
  work_order: null, receipt: null, error: null, usage: {}, depth: 0, relay_id: null, relay_step: null, interaction_id: null, interaction_node: null, plan_node_id: null, participant_id: null, participant_alias: null, participant_index: null, participant_name: null, depends_on: [], scheduled_by: null, kind: 'run', ...over,
})

test("the thread's runs wear the session's bot; every other run its own, stable; a person action wears none", () => {
  const first = botFor(row('r1'))
  assert.match(first ?? '', /^\d\d-[a-z]+$/)
  assert.equal(botFor(row('r2')), first)                                            // the same session, the same agent continuing
  assert.notEqual(botFor(row('r1', { session_id: 'another' })), first)
  const child = row('c1', { parent_run_id: 'r1', spawned_by: 'run:r1' })
  assert.match(botFor(child) ?? '', /^\d\d-[a-z]+$/)
  assert.equal(botFor(child), botFor({ ...child }))
  assert.notEqual(botFor(child), botFor(row('c2', { parent_run_id: 'r1', spawned_by: 'run:r1' })))
  assert.match(botFor(row('o1', { work_order: {} as RunTreeRow['work_order'] })) ?? '', /^\d\d-[a-z]+$/)
  assert.equal(botFor(row('h1', { spawned_by: 'human_action', model: null })), null)
})

test('the bot states and the glyph follow the run and what it measured', () => {
  const now = Date.parse('2026-09-26T10:01:40.000Z')
  assert.equal(botState(row('a', { status: 'queued' }), false, now), 'waiting')                     // in line: waiting, never idle
  assert.equal(botState(row('a', { status: 'running' }), true, now), 'working')
  assert.equal(botState(row('a', { status: 'running' }), false, now), 'thinking')
  assert.equal(botState(row('a'), false, now), 'done')
  assert.equal(botState(row('a'), false, now + 60_000), 'static')
  assert.equal(botState(row('a', { status: 'error' }), false, now), 'blocked')
  assert.equal(botState(row('a', { status: 'error' }), false, now + 29_000), 'blocked')               // 39 s after its end
  assert.equal(botState(row('a', { status: 'error' }), false, now + 31_000), 'static')                // 41 s after
  // the person's stop: back to idle, neither done nor blocked; the app quitting is no one's stop: blocked
  assert.equal(botState(row('a', { status: 'cancelled' }), false, now), 'idle')
  assert.equal(botState(row('a', { status: 'cancelled', receipt: { interrupted: true } as never }), false, now), 'blocked')
  // a done run whose answer its provider's filter stopped: blocked, not done
  assert.equal(botState(row('a', { receipt: { mechanical: { answer_end: { reason: 'content_filter', attempts: 0 } } } as never }), false, now), 'blocked')
  // the end said by the receipt alone (a record the stream patched before the row came back) still plays
  assert.equal(botState({ status: 'done', finished_at: null, receipt: { finished_at: '2026-09-26T10:01:30.000Z' } }, false, now), 'done')
  assert.equal(glyphFor(row('a')), 'done')
  assert.equal(glyphFor(row('a', { receipt: { mechanical: { checks: { passed: 1, failed: 1, unknown: 0, not_run: 0 } } } as never })), 'bad')   // a measured failure
  assert.equal(glyphFor(row('a', { receipt: { mechanical: { lock_violations: 1 } } as never })), 'bad')
  assert.equal(glyphFor(row('a', { receipt: { mechanical: { checks: { passed: 0, failed: 0, unknown: 1, not_run: 2 } } } as never })), 'done')   // unknown or not run is no failure
  assert.equal(glyphFor(row('a', { status: 'cancelled' })), 'err')
  assert.equal(glyphFor(row('a', { status: 'running' })), null)
  // a command that exited with an error (an agent's probe, a try) leaves the run done, said apart from a failure
  const probed = row('a', { receipt: { mechanical: { failed_executions: 2 } } as never })
  assert.equal(glyphFor(probed), 'warn')
  assert.equal(glyphTitle(probed, 'warn'), 'Done · 2 commands exited with an error')
  const judged = row('a', { receipt: { mechanical: { failed_executions: 1, checks: { passed: 0, failed: 1, unknown: 0, not_run: 0 } } } as never })
  assert.equal(glyphFor(judged), 'bad')
  assert.equal(glyphTitle(judged, 'bad'), 'Done · 1 check failed')
  assert.equal(glyphTitle(row('a', { status: 'cancelled' }), 'err'), 'Stopped')
  assert.equal(glyphTitle(row('a'), 'done'), 'Done')
  assert.equal(nameOf(row('a', { label: '盘点' })), '盘点')
  assert.equal(durationOf(row('a'), now), '2m')
})

test('the tree nests by parent and the selection lights ancestors and the subtree only', () => {
  const rows = [row('r1'), row('c1', { parent_run_id: 'r1' }), row('g1', { parent_run_id: 'c1' }), row('c2', { parent_run_id: 'r1' }), row('r2')]
  const roots = buildTree(rows)
  assert.deepEqual(roots.map((n) => n.row.id), ['r1', 'r2'])
  assert.deepEqual(roots[0].children.map((n) => [n.row.id, n.depth]), [['c1', 1], ['c2', 1]])
  assert.equal(roots[0].children[0].children[0].depth, 2)
  assert.deepEqual([...selectionChain(rows, 'c1')].sort(), ['c1', 'g1', 'r1'])
  assert.deepEqual([...selectionChain(rows, null)], [])
})

test("the brand chip's text on each bot's colour is white or near-black, whichever reads, and always readable", () => {
  assert.equal(inkOn('#000000'), INK_LIGHT)
  assert.equal(inkOn('#ffffff'), INK_DARK)
  assert.equal(inkOn(BOT_HEX['08-prompt']), INK_DARK)
  assert.equal(inkOn(BOT_HEX['02-terminal']), INK_LIGHT)
  const lum = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    .reduce((sum, c, k) => sum + c * [0.2126, 0.7152, 0.0722][k]!, 0)
  for (const [bot, hex] of Object.entries(BOT_HEX)) {
    const [a, b] = [lum(hex), lum(inkOn(hex))].sort((x, y) => y - x)
    assert.ok((a! + 0.05) / (b! + 0.05) >= 3, `${bot}: contrast ${((a! + 0.05) / (b! + 0.05)).toFixed(2)}`)
  }
})

test("a participant's rows wear one bot across its steps; two participants on one model read apart; a plan row wears the director's, a decision none", () => {
  const a1 = row('run_a1', { participant_alias: 'pt_3f2a9c', participant_id: 'ix:pt_3f2a9c', participant_index: 0, plan_node_id: 'ix:a1' })
  const a2 = row('run_a2', { participant_alias: 'pt_3f2a9c', participant_id: 'ix:pt_3f2a9c', participant_index: 0, plan_node_id: 'ix:a2', resumes_run_id: 'run_a1' })
  const b1 = row('run_b1', { participant_alias: 'pt_8c1d4e', participant_id: 'ix:pt_8c1d4e', participant_index: 1, plan_node_id: 'ix:b1' })
  assert.ok(BOTS.includes(botFor(a1) as typeof BOTS[number]))
  assert.equal(botFor(a2), botFor(a1))
  assert.notEqual(botFor(b1), botFor(a1))
  assert.equal(botFor(row('ix_1', { kind: 'plan', model: 'd', spawned_by: 'plan' })), 'director')
  assert.equal(botFor(row('ix_1:decide', { kind: 'decision', model: null, spawned_by: 'plan' })), null)
  assert.equal(botState(row('ix_1', { kind: 'plan', status: 'waiting', finished_at: null }), false, 0), 'idle')
})

test("the tree nests a plan's nodes under the plan that scheduled them; the selection lights the rows a dependency joins to the selected one; what a row waits for is named by the participant's place", () => {
  const rows = [
    row('ix_1', { kind: 'plan', spawned_by: 'plan', status: 'waiting' }),
    row('run_a1', { scheduled_by: 'ix_1', participant_alias: 'pt_3f2a9c', participant_index: 0 }),
    row('run_b1', { scheduled_by: 'ix_1', participant_alias: 'pt_8c1d4e', participant_index: 1, status: 'running' }),
    row('ix_1:a2', { scheduled_by: 'ix_1', spawned_by: 'plan', status: 'queued', participant_alias: 'pt_3f2a9c', participant_index: 0, depends_on: ['run_a1', 'run_b1'] }),
    row('ix_1:decide', { kind: 'decision', scheduled_by: 'ix_1', spawned_by: 'plan', model: null, status: 'queued', depends_on: ['ix_1:a2'] }),
    row('r_other'),
  ]
  const roots = buildTree(rows)
  assert.deepEqual(roots.map((n) => n.row.id), ['ix_1', 'r_other'])
  assert.deepEqual(roots[0].children.map((n) => [n.row.id, n.depth]), [['run_a1', 1], ['run_b1', 1], ['ix_1:a2', 1], ['ix_1:decide', 1]])
  assert.deepEqual([...selectionChain(rows, 'run_b1')].sort(), ['ix_1', 'ix_1:a2', 'run_b1'])                          // its plan, and the step that waits for it
  assert.deepEqual([...selectionChain(rows, 'ix_1:a2')].sort(), ['ix_1', 'ix_1:a2', 'ix_1:decide', 'run_a1', 'run_b1'])
  const byId = new Map(rows.map((r) => [r.id, r]))
  assert.deepEqual(waitsNames(rows[3], byId), ['#1', '#2'])                                                           // the badges their bots wear
  assert.equal(waitsLabel(rows[3], byId), 'waits #1, #2')
  assert.equal(waitsLabel(rows[4], byId, 'after'), 'after #1')
  assert.equal(waitsLabel(row('x', { depends_on: ['run_9b1e07a2c5d4'] }), byId), 'waits 9b1e07')                        // no participant: the id's short form
  assert.deepEqual(dependencyEdges(rows), [{ from: 'run_a1', to: 'ix_1:a2', k: 0 }, { from: 'run_b1', to: 'ix_1:a2', k: 1 }, { from: 'ix_1:a2', to: 'ix_1:decide', k: 0 }])
  assert.deepEqual(dependencyEdges(rows.filter((r) => r.id !== 'run_b1')), [{ from: 'run_a1', to: 'ix_1:a2', k: 0 }, { from: 'ix_1:a2', to: 'ix_1:decide', k: 0 }])   // a folded end draws nothing
})

test('ChatGPT on the web wears its own mark, not a bot: as a participant, as a run, still in every state', () => {
  assert.equal(botFor({ id: 'r1', session_id: 's', model: 'chatgpt:web', spawned_by: 'human', parent_run_id: null, work_order: null }), CHATGPT_BOT)
  assert.equal(botSrc(CHATGPT_BOT, 'working'), '/bots/icons/chatgpt.png')
  assert.equal(botSrc('02-terminal', 'working'), '/bots/anim/working/02-terminal.webp')
  assert.equal(botSrc('02-terminal'), '/bots/icons/02-terminal.png')
})

test("a live run's bot works while a tool runs and thinks otherwise; the line says the same word", () => {
  assert.equal(busyOf([]), false)
  assert.equal(busyOf([{ kind: 'activity', running: false }, { kind: 'activity', running: true }]), true)
  // every open call counts (several run at once), not only the latest row; a call still being written runs nothing
  assert.equal(busyOf([{ kind: 'activity', running: true }, { kind: 'activity', running: false }]), true)
  assert.equal(busyOf([{ kind: 'activity', running: true, forming: { id: 't', chars: 9 } }]), false)
  assert.equal(busyOf([{ kind: 'activity', running: false }, { kind: 'note' }]), false)
  const running = { status: 'running' as const, finished_at: null }
  assert.equal(liveWord(botState(running, true, 0)), 'working…')
  assert.equal(liveWord(botState(running, false, 0)), 'thinking…')
  assert.equal(liveWord(botState({ status: 'queued' as const, finished_at: null }, false, 0)), 'queued for its model')
  assert.equal(liveWord('blocked'), 'waiting for you')
})

test("the main agent is named by its place, not by the connector that sent its message; an action is no agent", () => {
  const main = { id: 'run_m', label: 'ChatGPT', user_text_head: 'carry on', collab: { participant_role: 'main' } as RunTreeRow['collab'] }
  assert.equal(nameOf(main), 'Main agent')
  assert.equal(nameOf({ id: 'run_t', label: 'review', user_text_head: 'look', collab: { participant_role: 'separate' } as RunTreeRow['collab'] }), 'review')
  assert.equal(nameOf({ id: 'run_o', label: null, user_text_head: 'an older row', collab: null }), 'an older row')
  assert.equal(isActionRow({ spawned_by: 'human_action' }), true)
  assert.equal(isActionRow({ spawned_by: 'connector' }), false)
})

test("a connector's run is named by its first line, not by the connector's name it carries; an order's label stays", () => {
  assert.equal(nameOf({ id: 'run_c', label: 'ChatGPT', user_text_head: 'review the candidate', spawned_by: 'connector', work_order: null }), 'review the candidate')
  assert.equal(nameOf({ id: 'run_o', label: 'reviewer', user_text_head: 'review the candidate', spawned_by: 'connector', work_order: { label: 'reviewer' } as RunTreeRow['work_order'] }), 'reviewer')
  assert.equal(nameOf({ id: 'run_h', label: 'mine', user_text_head: 'do it', spawned_by: 'human', work_order: null }), 'mine')
})

test("an action beside the agents, as the thread lists it: who took it, what, its first line and its outcome, in time order", () => {
  const row = (id: string, label: string | null, at: string, user_text: string, spawned_by = 'human_action') => ({ id, spawned_by, label, created_at: at, user_text })
  const actions = threadActions([
    row('r2', 'checkpoint (by hand)', '2026-10-15T10:02:00Z', 'checkpoint cp_1: before the sweep'),
    row('r1', 'command (ChatGPT)', '2026-10-15T10:01:00Z', '$ python3 toy.py --seed 0\n→ exit 0'),
    row('r3', 'command (ChatGPT)', '2026-10-15T10:03:00Z', '$ cat <<EOF > a.py\nprint(1)\nEOF\n→ running (x_1)'),
    row('r4', null, '2026-10-15T10:04:00Z', 'hello', 'human'),
  ])
  assert.deepEqual(actions.map((a) => [a.id, a.what, a.by, a.head, a.outcome]), [
    ['r1', 'command', 'ChatGPT', '$ python3 toy.py --seed 0', '→ exit 0'],
    ['r2', 'checkpoint', null, 'checkpoint cp_1: before the sweep', null],
    ['r3', 'command', 'ChatGPT', '$ cat <<EOF > a.py …', '→ running (x_1)'],
  ])
  assert.equal(actions[2]!.text, '$ cat <<EOF > a.py\nprint(1)\nEOF\n→ running (x_1)')
})

test("the thread's action line reads with the contract's one parser (the share's action item is made with it): the same values as before", () => {
  // the reading the thread had before the parser moved to contract/src/actions.ts, kept here as the reference
  const before = (r: { id: string; label: string | null; created_at: string; user_text: string }) => {
    const named = /^(.+?) \((.+)\)$/.exec(r.label ?? '')
    const lines = r.user_text.split('\n').filter((l) => l.trim())
    const outcome = lines.length > 1 && lines.at(-1)!.startsWith('→') ? lines.at(-1)! : null
    const body = outcome ? lines.slice(0, -1) : lines
    return { id: r.id, at: r.created_at, what: named?.[1] ?? r.label ?? 'action', by: named && named[2] !== 'by hand' ? named[2]! : null, head: body.length > 1 ? `${body[0]} …` : body[0] ?? '', outcome, text: r.user_text }
  }
  const rows = [
    ['command (ChatGPT)', '$ git status\n→ exit 0'], ['command (connector)', '$ a\n\n  \nb\n→ running (x_9)'], ['checkpoint (by hand)', 'checkpoint cp_1: note'],
    [null, ''], ['', 'x'], ['approved bash', 'approved proposal p_1: applied'], ['adopt n1', '→ only an outcome'], ['integration (by hand (old))', 'a\n→ b\n→ c'],
    ['command (ChatGPT)', '\n\n$ cat a.py\n'], ['(x)', 'one line'],
  ] as const
  const tree = rows.map(([label, user_text], i) => ({ id: `run_${i}`, spawned_by: 'human_action', label, created_at: `2026-10-15T10:0${i}:00Z`, user_text }))
  const actions = threadActions(tree)
  assert.deepEqual(actions, tree.map(before))
  for (const a of actions) {
    const r = tree.find((t) => t.id === a.id)!
    assert.deepEqual({ what: a.what, by: a.by, head: a.head, outcome: a.outcome }, threadActionRecord(r.label, r.user_text))
  }
})
