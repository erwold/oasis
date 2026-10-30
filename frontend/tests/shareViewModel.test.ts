/** The session share's snapshot → the app's own thread objects (src/share/viewModel.ts): every item stands once, in
 *  the snapshot's own order, attributed as the snapshot says; nothing of usage, receipts or tool results is made up. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ShareItem, ShareSnapshot } from '@oasis-code/contract'
import { SHARE_PICTURE_ROW } from '../src/components/ThreadPresentation.ts'
import { checkShareDocument, SHARE_PAGE_FORMAT, SHARE_PAGE_VERSION, type ShareDocument } from '../src/share/document.ts'
import { noteState } from '../src/state/interaction.ts'
import { shareView, type ShareBlock, type ShareView } from '../src/share/viewModel.ts'
import { actionSnapshot, legacyV1Snapshot, richSnapshot } from './shareFixtures.ts'

const PNG = 'data:image/png;base64,iVBORw0KGgo='
const docOf = (snapshot: ShareSnapshot = richSnapshot()): ShareDocument => ({
  format: SHARE_PAGE_FORMAT, version: SHARE_PAGE_VERSION, theme: 'light', snapshot,
  pictures: Object.fromEntries(['img1', 'img2', 'img3', 'img4', 'img5'].map((k) => [k, { src: PNG, width: 4, height: 3 }])),
  page: { images_rejected: 0, images_over_page_budget: 0 }, faces: { r1: { bot: '05-bubble', enclosed: false } }, bots: {},
})

/** A document of a snapshot as the builder writes it when it carries no pictures and no faces. */
const bare = (snapshot: ShareSnapshot): ShareDocument => ({ ...docOf(snapshot), pictures: {}, faces: {} })

/** The item keys as the view draws them, in drawing order. */
function drawn(view: ShareView, snapshot: ShareSnapshot): string[] {
  const items: readonly ShareItem[] = snapshot.items
  const opening = new Set(items.filter((i) => i.kind === 'message' && i.source === 'opening').map((i) => i.key))
  const keys: string[] = []
  for (const b of view.blocks) {
    if (b.kind === 'run') {
      if (opening.has(b.key)) keys.push(b.key)
      keys.push(...b.run.attachments.map((a) => a.asset_id))
      for (const e of b.entries) {
        keys.push(e.eventId!)
        if (e.kind === 'activity') keys.push(...view.presentation.tool(e.toolCallId!)!.pictures.map((p) => p.key))
      }
    } else if (b.kind === 'note') keys.push(b.key, ...view.presentation.note(b.key)!.pictures)
    else if (b.kind === 'group') keys.push(b.key, ...b.pictures)
    else if (b.kind === 'action' || b.kind === 'group_note') keys.push(b.key)
    else keys.push(...b.items.map((i) => i.key))
  }
  return keys
}

const run = (view: ShareView, id: string) => view.blocks.find((b): b is Extract<ShareBlock, { kind: 'run' }> => b.kind === 'run' && b.run.id === id)!

test('every item stands exactly once, in the snapshot\'s own order (no sorting, no i1/i10 lexicographic trap)', () => {
  const snapshot = richSnapshot()
  const view = shareView(docOf(snapshot))
  assert.deepEqual(drawn(view, snapshot), snapshot.items.map((i) => i.key))
  assert.deepEqual(view.blocks.map((b) => `${b.kind}:${b.key}`), [
    'run:i1', 'note:i14', 'note:i16', 'note:i18', 'note:i19', 'group:i20', 'run:i22', 'run:i27', 'run:i31', 'stray:i33',
  ])
})

test('a run: the opening is its words, the pictures with them its strip; answers, steers, tools, notices its rows', () => {
  const view = shareView(docOf())
  const r1 = run(view, 'r1')
  assert.equal(r1.run.user_text, 'Fix the parser, see the screenshots')
  assert.deepEqual(r1.run.attachments.map((a) => a.asset_id), ['i2', 'i3'])
  assert.deepEqual(r1.entries.map((e) => `${e.kind}:${e.eventId}`), ['activity:i4', 'activity:i5', 'user:i6', 'activity:i7', 'agent:i9', 'user:i10', 'user:i11', 'user:i12', 'user:i13'])
  assert.deepEqual(view.presentation.opening('r1'), { author: 'person', label: 'Person' })
  // one answer → one agent row, its text as the snapshot has it
  assert.ok(r1.entries.find((e) => e.eventId === 'i9')!.text!.startsWith('Done.'))
  assert.equal(view.presentation.author('i9'), 'Model A')
  // the tool's line is the sanitized target; no arguments or result are made up
  const read = r1.entries.find((e) => e.eventId === 'i4')!
  assert.equal(read.args, undefined)
  assert.equal(read.result, undefined)
  assert.equal(view.presentation.tool('i4')!.line, 'src/parser.ts')
  assert.equal(view.presentation.tool('i4')!.details!.preview_truncated, true)
  assert.equal(view.presentation.tool('i5')!.withheld, true)
  assert.deepEqual(view.presentation.tool('i7')!.pictures, [{ key: 'i8', origin: 'screenshot' }])
  // no usage, no receipt, no cost: the footer has nothing to say of them
  assert.deepEqual(r1.run.receipt, {})
  assert.deepEqual(r1.run.usage, {})
  assert.equal(r1.run.model, 'Model A')
  assert.equal(r1.run.session_id, 'share')
})

test('steers keep their sender as the snapshot names it: person, director, connector client, and unrecorded never "you"', () => {
  const view = shareView(docOf())
  const r1 = run(view, 'r1')
  const steer = (key: string) => r1.entries.find((e) => e.eventId === key)!.steer!
  assert.equal(steer('i6').by, 'person')
  assert.equal(steer('i10').by, 'director')
  assert.equal(steer('i11').by, 'connector')
  assert.equal(steer('i11').client, 'ChatGPT')
  assert.equal(steer('i11').status, 'undelivered')
  assert.equal(steer('i12').by, undefined)
  assert.equal(view.presentation.author('i12'), 'Words sent while it worked')
  assert.equal(view.presentation.author('i11'), 'ChatGPT')
  // a queued steer is a row too (the app draws it at its run's tail, where the snapshot also has it)
  assert.equal(run(view, 'r3').entries.find((e) => e.eventId === 'i29')!.steer!.status, 'queued')
})

test('pictures stay where they stood: after their call, with the exchange or group before them, or on a row of their own', () => {
  const view = shareView(docOf())
  assert.deepEqual(view.presentation.tool('i24')!.pictures, [{ key: 'i25', origin: 'generated' }, { key: 'i26', origin: 'generated' }])
  // a generated picture right after an opening has no call to stand under: its own row
  const r3 = run(view, 'r3')
  assert.equal(r3.entries[0]!.eventName, SHARE_PICTURE_ROW)
  assert.equal(r3.entries[0]!.eventId, 'i28')
  assert.deepEqual(view.presentation.note('i14')!.pictures, ['i15'])
  // an image-only exchange keeps its picture (an empty question is the snapshot's own)
  const imageOnly = view.blocks.find((b) => b.key === 'i16')!
  assert.equal(imageOnly.kind === 'note' && imageOnly.note.question, '')
  assert.deepEqual(view.presentation.note('i16')!.pictures, ['i17'])
  const group = view.blocks.find((b) => b.key === 'i20')!
  assert.ok(group.kind === 'group' && group.pictures[0] === 'i21' && group.to === 'Reviewer')
  // shown or why not
  assert.deepEqual(view.presentation.picture('i2'), { kind: 'shown', src: PNG, width: 4, height: 3, label: 'Attached image' })
  assert.deepEqual(view.presentation.picture('i3'), { kind: 'omitted', label: 'Attached image', why: 'over the export\'s size budget' })
  assert.equal((view.presentation.picture('i17') as { why: string }).why, 'not included in this export')
})

test('director exchanges, groups, failures and strays: said as the snapshot says them', () => {
  const view = shareView(docOf())
  assert.deepEqual(view.presentation.note('i18'), { asker: 'person', askerLabel: 'Person', status: 'Failed', answered: false, pictures: [] })
  assert.equal(view.presentation.note('i19')!.asker, 'app')
  assert.deepEqual(view.presentation.opening('r3'), { author: 'agent', label: 'Parent agent' })
  // a failed run: its run_failed notice is the error row the app draws (the failure card then names it once)
  const r4 = run(view, 'r4')
  assert.deepEqual(r4.entries.map((e) => [e.kind, e.eventName, e.text]), [['error', 'error', 'provider said no (synthetic)']])
  assert.equal(r4.run.status, 'error')
  // other notices are note rows by their code
  assert.equal(run(view, 'r2').entries[0]!.eventName, 'context_compacted')
  const stray = view.blocks.at(-1)!
  assert.ok(stray.kind === 'stray' && stray.items[0]!.key === 'i33')
  // faces: as exported, none made up
  assert.deepEqual(view.presentation.face('r1'), { bot: '05-bubble', enclosed: false })
  assert.deepEqual(view.presentation.face('r2'), { bot: null, enclosed: false })
})

test('a run whose items come apart, or a second opening, starts a new turn where it stands — never moved, never merged', () => {
  const base = richSnapshot()
  const items = base.items.filter((i) => ['i1', 'i9', 'i14', 'i15', 'i31'].includes(i.key))
  // r1 again after the exchange: a second stretch of the same run
  items.splice(4, 0, { kind: 'message', key: 'i40', run: 'r1', at: null, author: 'assistant', author_label: 'Model A', source: 'answer', text: 'later', steer: null })
  const snapshot = richSnapshot({ items })
  const view = shareView(docOf(snapshot))
  assert.deepEqual(view.blocks.map((b) => `${b.kind}:${b.key}`), ['run:i1', 'note:i14', 'run:i40', 'run:i31'])
  assert.deepEqual(drawn(view, snapshot), snapshot.items.map((i) => i.key))
  const second = view.blocks[2] as Extract<ShareBlock, { kind: 'run' }>
  assert.equal(second.run.user_text, '')
})

// ---- actions taken beside the agents, the person's words to a group's members, a woken run (V2) ------------------

test('V2: an action is its own line where it stood — its run never a turn, nothing of "0 tool calls" — said as the snapshot says it', () => {
  const snapshot = actionSnapshot()
  const view = shareView(docOf(snapshot))
  assert.deepEqual(view.blocks.map((b) => `${b.kind}:${b.key}`), [
    'run:i1', 'action:i3', 'action:i4', 'action:i5', 'group:i6', 'group_note:i7', 'group_note:i8', 'group_note:i9', 'group_note:i10', 'action:i11', 'action:i12', 'run:i13',
  ])
  // every item once; the woken run's notice is its turn's own header (spawned_by wake), not a row
  assert.deepEqual(drawn(view, snapshot), snapshot.items.map((i) => i.key).filter((k) => k !== 'i13'))
  // no action run is a turn
  const turns = view.blocks.flatMap((b) => (b.kind === 'run' ? [b.run.id] : []))
  assert.deepEqual(turns, ['r1', 'r6'])
  const action = (key: string) => (view.blocks.find((b) => b.key === key) as Extract<ShareBlock, { kind: 'action' }>).action
  // the snapshot's what / by / head / outcome as given (never re-derived from a text the export may have cut)
  assert.deepEqual(action('i3'), { id: 'i3', at: '2026-10-22T03:02:00.000Z', what: 'command', by: 'ChatGPT', head: '$ python3 toy.py --seed 0 …', outcome: '→ exit 0', text: '$ python3 toy.py --seed 0\n  --steps 3\n→ exit 0' })
  assert.deepEqual(view.presentation.action('i3'), { missing: null, details: null })
  assert.deepEqual(action('i4'), { id: 'i4', at: '2026-10-22T03:03:00.000Z', what: 'checkpoint', by: null, head: 'checkpoint [id]: before the sweep', outcome: null, text: 'checkpoint [id]: before the sweep' })
  // withheld: no head, no text, no details; its exit kept
  assert.deepEqual(action('i5'), { id: 'i5', at: '2026-10-22T03:04:00.000Z', what: 'command', by: 'ChatGPT', head: '', outcome: '→ exit 0', text: '' })
  assert.deepEqual(view.presentation.action('i5'), { missing: 'withheld', details: null })
  // an action of a run the snapshot does not list is still its line; a time it does not hold stays empty
  assert.deepEqual(action('i11'), { id: 'i11', at: '', what: 'approved bash', by: null, head: 'approved proposal [id]: applied', outcome: null, text: 'approved proposal [id]: applied' })
  assert.deepEqual(view.presentation.action('i12'), { missing: 'unrecorded', details: null })
  // a woken run opens with the app's own wake header: its notice is no row
  const r6 = run(view, 'r6')
  assert.equal(r6.run.spawned_by, 'wake')
  assert.deepEqual(r6.entries.map((e) => `${e.kind}:${e.eventId}`), ['agent:i14'])
})

test('V2 with tool details: the command carries its measures and cut preview; a withheld one never does', () => {
  const view = shareView(docOf(actionSnapshot({ details: true })))
  assert.deepEqual(view.presentation.action('i3')!.details, { summary: null, fields: [{ name: 'exit_code', value: 0 }, { name: 'duration_ms', value: 812 }], preview: 'step 1 loss 0.9\nstep 2 loss 0.5', preview_truncated: true })
  assert.equal(view.presentation.action('i5')!.details, null)
  assert.equal(view.presentation.action('i4')!.details, null)
})

test('V2: the person\'s words to a group\'s members are their own turn, their state in noteState\'s words', () => {
  const view = shareView(docOf(actionSnapshot()))
  const note = (key: string) => view.blocks.find((b) => b.key === key) as Extract<ShareBlock, { kind: 'group_note' }>
  assert.deepEqual(['i7', 'i8', 'i9', 'i10'].map((k) => [note(k).to, note(k).text, note(k).status, note(k).state]), [
    ['Reviewer', 'look at the seed too', 'delivered', 'delivered to Reviewer'],
    ['everyone', 'keep it short', 'partly', 'delivered to Critic; queued for the rest'],
    ['Critic', 'one more thing', 'queued', 'queued'],
    ['everyone', 'too late', 'undelivered', 'not delivered: the interaction ended first'],
  ])
  // the same words the app's own noteState says for the same note
  assert.equal(noteState({ id: 'n', interaction_id: 'ix', to: 'everyone', text: 'x', status: 'partly', delivered: { b: 'run_b' }, created_at: '', updated_at: '' }, { participants: [] }), 'delivered to b; queued for the rest')
})

test('V1 (an older export) read by this viewer: an action notice is a compact action line from its run\'s label — no turn, no text made up', () => {
  const v1 = legacyV1Snapshot()
  const doc = checkShareDocument(bare(v1))
  assert.equal(doc.snapshot.version, 1)
  const view = shareView(doc)
  assert.deepEqual(view.blocks.map((b) => `${b.kind}:${b.key}`), ['run:i1', 'action:i3', 'action:i4', 'stray:i5'])
  const action = (key: string) => (view.blocks.find((b) => b.key === key) as Extract<ShareBlock, { kind: 'action' }>).action
  assert.deepEqual(action('i3'), { id: 'i3', at: '2026-10-20T03:02:00.000Z', what: 'command', by: 'ChatGPT', head: '', outcome: null, text: '' })
  // the run's own time when the notice has none, else empty (a title never says "Invalid Date")
  assert.deepEqual(action('i4'), { id: 'i4', at: '', what: 'checkpoint', by: null, head: '', outcome: null, text: '' })
  assert.deepEqual(view.presentation.action('i3'), { missing: 'not_carried', details: null })
  // the notice's own words ("of the person") are not drawn as a row of a made-up turn
  assert.ok(!view.blocks.some((b) => b.kind === 'run' && (b.run.id === 'r2' || b.run.id === 'r3')))
  assert.deepEqual(drawn(view, v1), v1.items.map((i) => i.key))
})

test('the document reads V1 and V2 strictly: an unknown version, a V2 item in a V1 snapshot, an unknown field are refused', () => {
  const base = bare(actionSnapshot())
  assert.equal(checkShareDocument(base).snapshot.version, 2)
  assert.throws(() => checkShareDocument({ ...base, snapshot: { ...base.snapshot, version: 3 } }))
  const v1 = legacyV1Snapshot()
  const action = actionSnapshot().items.find((i) => i.kind === 'action')!
  assert.throws(() => checkShareDocument({ ...bare(v1), snapshot: { ...v1, items: [...v1.items, action] } }))
  const note = actionSnapshot().items.find((i) => i.kind === 'group_note')!
  assert.throws(() => checkShareDocument({ ...bare(v1), snapshot: { ...v1, items: [...v1.items, note] } }))
  const withExtra = { ...base.snapshot, items: base.snapshot.items.map((i) => (i.kind === 'action' ? { ...i, command_output: 'x' } : i)) }
  assert.throws(() => checkShareDocument({ ...base, snapshot: withExtra }))
  const badNote = { ...base.snapshot, items: base.snapshot.items.map((i) => (i.kind === 'group_note' ? { ...i, status: 'sent' } : i)) }
  assert.throws(() => checkShareDocument({ ...base, snapshot: badNote }))
  assert.throws(() => checkShareDocument({ ...base, version: 3 }))
})

test('items of no listed run stray as themselves: a tool keeps its target and details, a picture its row, nothing an empty row', () => {
  const base = richSnapshot()
  const items = [
    ...base.items.filter((i) => i.key === 'i1'),
    { kind: 'tool' as const, key: 'i50', run: 'r77', at: null, name: 'read_file', status: 'ok', target: 'src/lost.ts', details: null, withheld: null },
    { kind: 'image' as const, key: 'i51', run: 'r77', at: null, origin: 'screenshot' as const, image: null, omitted: 'missing' as const },
    { kind: 'message' as const, key: 'i52', run: 'r77', at: null, author: 'assistant' as const, author_label: 'Lost agent', source: 'answer' as const, text: 'lost words', steer: null },
  ]
  const snapshot = richSnapshot({ items })
  const view = shareView(docOf(snapshot))
  assert.deepEqual(view.blocks.map((b) => `${b.kind}:${b.key}`), ['run:i1', 'stray:i50'])
  assert.equal(view.presentation.tool('i50')!.line, 'src/lost.ts')
  assert.equal(view.presentation.author('i52'), 'Lost agent')
  assert.deepEqual(drawn(view, snapshot), snapshot.items.map((i) => i.key))
})
