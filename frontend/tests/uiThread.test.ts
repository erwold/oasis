import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EVENT_NAMES, type UiSurfaceRecord } from '@oasis-code/contract'
import type { RunTreeRow, TranscriptEntry } from '../src/api/types'
import { stateAt } from '../src/state/replayState.ts'
import { applyEvent, fromTranscript, upsertSurface, withKnownSurfaces, withSurfaces, type ThreadEntry } from '../src/state/thread.ts'
import { turnParts } from '../src/state/turns.ts'
import { withPromptInDraft } from '../src/state/uiSurface.ts'
import type { ComposerFields } from '../src/state/composers.ts'
import type { PendingImage } from '../src/state/attachments.ts'
import { calculator, record } from './uiFixtures.ts'

const surfaceEvent = (r: UiSurfaceRecord, id: string) => ({ event: 'ui_surface', data: { surface: r }, id })

test('ui_surface is a run event the contract names (the SSE client subscribes to every one of them)', async () => {
  assert.ok((EVENT_NAMES as readonly string[]).includes('ui_surface'))
  // the client's list is read from its source: importing it would open EventSource machinery
  const { readFileSync } = await import('node:fs')
  const sse = readFileSync(new URL('../src/api/sse.ts', import.meta.url), 'utf8')
  const known = /export const KNOWN_EVENTS = \[([\s\S]*?)\] as const/.exec(sse)![1]!.match(/'([a-z_]+)'/g)!.map((s) => s.slice(1, -1))
  assert.deepEqual([...known].sort(), [...EVENT_NAMES].sort(), 'KNOWN_EVENTS and EVENT_NAMES agree')
})

test('a surface is one row per surface id of its run, updated in place by a later revision; never a work row', () => {
  let t: ThreadEntry[] = []
  t = applyEvent(t, 'r1', { event: 'text_block', data: { text: 'Here is a calculator:' } })
  t = applyEvent(t, 'r1', surfaceEvent(record(), '5'))
  t = applyEvent(t, 'r1', { event: 'tool_call', data: { tool: 'read_file', tool_call_id: 'c1' }, id: '6' })
  t = applyEvent(t, 'r1', surfaceEvent(record({ revision: 2, spec: calculator({ title: 'Price calculator v2' }) as UiSurfaceRecord['spec'] }), '7'))
  const ui = t.filter((e) => e.kind === 'ui')
  assert.equal(ui.length, 1)
  assert.equal(t.indexOf(ui[0]!), 1, 'it stays where it was first presented')
  assert.equal(ui[0]!.surface!.revision, 2)
  // the same event again (a reconnect resending it) and an older revision change nothing
  assert.equal(applyEvent(t, 'r1', surfaceEvent(record({ revision: 2, spec: calculator({ title: 'Price calculator v2' }) as UiSurfaceRecord['spec'] }), '7')).filter((e) => e.kind === 'ui').length, 1)
  assert.equal(applyEvent(t, 'r1', surfaceEvent(record({ revision: 1 }), '5')), t, 'an older revision is not the later word')
  // another surface id is another row
  assert.equal(applyEvent(t, 'r1', surfaceEvent(record({ surface_id: 'chart' }), '8')).filter((e) => e.kind === 'ui').length, 2)
  const parts = turnParts(t)
  assert.deepEqual(parts.map((p) => p.kind), ['agent', 'ui', 'work'], 'the surface is its own part, not folded into the work')
})

test("a surface event the page cannot read, or another run's, is a note — never a surface", () => {
  const t = applyEvent([], 'r1', { event: 'ui_surface', data: { surface: { surface_id: 'x' } }, id: '1' })
  assert.deepEqual(t.map((e) => e.kind), ['note'])
  const other = applyEvent([], 'r1', surfaceEvent(record({ run_id: 'r2' }), '2'))
  assert.deepEqual(other.map((e) => e.kind), ['note'], 'a record of another run does not enter this run')
})

test('the same surface id in two runs of a session: two surfaces', () => {
  const threads = { r1: applyEvent([], 'r1', surfaceEvent(record(), '1')), r2: applyEvent([], 'r2', surfaceEvent(record({ run_id: 'r2', state: { qty: 50 } }), '1')) }
  assert.equal(threads.r1[0]!.surface!.state.qty, 3)
  assert.equal(threads.r2[0]!.surface!.state.qty, 50)
})

test("a finished run read from its transcript, then the session's list: the latest state, in place or at the end", () => {
  const entries = [
    { kind: 'agent', text: 'Here:' },
    { kind: 'ui', surface: record() },
    { kind: 'agent', text: 'Change the quantity.' },
  ] as unknown as TranscriptEntry[]
  const rows = fromTranscript('r1', entries)
  assert.deepEqual(rows.map((e) => e.kind), ['agent', 'ui', 'agent'])
  const later = record({ state: { qty: 8, price: 4 }, updated_at: '2026-10-11T01:00:00.000Z' })
  const hydrated = withSurfaces({ r1: rows }, [later])
  assert.equal(hydrated.r1![1]!.surface!.state.qty, 8, 'the list brings the saved state into the row where it stands')
  // a transcript that keeps no surface: the list places it at the end of its run
  const bare = withSurfaces({ r1: fromTranscript('r1', [{ kind: 'agent', text: 'Here:' }] as TranscriptEntry[]) }, [later])
  assert.deepEqual(bare.r1!.map((e) => e.kind), ['agent', 'ui'])
  // a run not on the page, or one the filter leaves to its stream, takes nothing; an unchanged thread stays the same object
  const threads = { r1: rows }
  assert.equal(withSurfaces(threads, [record({ run_id: 'elsewhere' })]), threads)
  assert.equal(withSurfaces(threads, [later], () => false), threads)
  assert.equal(withSurfaces(threads, [record()]).r1, rows, 'the same word changes nothing')
})

test('upsert: a later state at the same revision replaces the record; an older one does not', () => {
  const t = upsertSurface([], 'r1', record())
  const saved = upsertSurface(t, 'r1', record({ state: { qty: 4, price: 4 }, updated_at: '2026-10-11T00:00:02.000Z' }))
  assert.equal(saved[0]!.surface!.state.qty, 4)
  assert.equal(upsertSurface(saved, 'r1', record()), saved)
})

test('a replay shows each surface as it stood at the moment — nothing later', () => {
  const row = (id: string): RunTreeRow => ({
    id, session_id: 's1', workspace_id: 'w', parent_run_id: null, resumes_run_id: null, spawned_by: 'human', label: null, model: 'm',
    user_text: 'hi', user_text_head: 'hi', status: 'done', usage: {}, error: null, created_at: '2026-10-11T00:00:00.000Z', finished_at: '2026-10-11T00:00:10.000Z',
    receipt: null, work_order: null, depth: 0, live: false, relay_id: null, relay_step: null, interaction_id: null, interaction_node: null,
  } as unknown as RunTreeRow)
  const events = [
    { run_id: 'r1', seq: 1, event: 'run_started', data: { model: 'm' }, t: '2026-10-11T00:00:00.500Z' },
    { run_id: 'r1', seq: 2, event: 'ui_surface', data: { surface: record() }, t: '2026-10-11T00:00:01.000Z' },
    { run_id: 'r1', seq: 3, event: 'ui_surface', data: { surface: record({ revision: 2 }) }, t: '2026-10-11T00:00:05.000Z' },
  ]
  const at = (ms: number) => stateAt({ runs: [row('r1')], events }, Date.parse('2026-10-11T00:00:00.000Z') + ms)
  assert.equal(at(800).threads.r1!.filter((e) => e.kind === 'ui').length, 0)
  assert.equal(at(2000).threads.r1!.find((e) => e.kind === 'ui')!.surface!.revision, 1)
  assert.equal(at(6000).threads.r1!.find((e) => e.kind === 'ui')!.surface!.revision, 2)
})

test("a live run's stream read again from its start (a hard refresh) shows the state saved since, at the surface's own place", () => {
  const saved = record({ state: { qty: 9, price: 4 }, updated_at: '2026-10-11T02:00:00.000Z' })
  const notYet = record({ surface_id: 'later', updated_at: '2026-10-11T02:00:00.000Z' })
  const known = { 'r1/calc': saved, 'r1/later': notYet }
  let t: ThreadEntry[] = applyEvent([], 'r1', { event: 'text_block', data: { text: 'Here:' } })
  const item = surfaceEvent(record(), '3')
  t = withKnownSurfaces(applyEvent(t, 'r1', item), 'r1', item, known)
  assert.deepEqual(t.map((e) => e.kind), ['agent', 'ui'], "a surface the stream has not reached yet does not jump ahead")
  assert.equal(t[1]!.surface!.state.qty, 9)
  const other = { event: 'text_block', data: { text: 'more' } }
  assert.equal(withKnownSurfaces(t, 'r1', other, known), t, 'any other event: the rows as they are')
})

test('a surface event whose record lacks what the contract requires (model, created_at) is a note, never a surface', () => {
  const { created_at: _c, ...partial } = record()
  assert.deepEqual(applyEvent([], 'r1', { event: 'ui_surface', data: { surface: partial }, id: '1' }).map((e) => e.kind), ['note'])
  assert.deepEqual(applyEvent([], 'r1', surfaceEvent(record({ model: null }), '2')).map((e) => e.kind), ['ui'])
})

test("a child run's finished transcript takes the session's surfaces for it, and only them", () => {
  const child = fromTranscript('c1', [{ kind: 'agent', text: 'done' }] as TranscriptEntry[])
  const known = [record({ run_id: 'c1', surface_id: 'chart' }), record({ run_id: 'r1' })]
  const rows = withSurfaces({ c1: child }, known).c1!
  assert.deepEqual(rows.map((e) => [e.kind, e.surface?.surface_id]), [['agent', undefined], ['ui', 'chart']])
})

test("an action's prompt goes to the draft of the surface's own session, even when another session is on show", () => {
  const image = { id: 'img1' } as unknown as PendingImage
  const fields: ComposerFields = {
    draft: 'what I am writing in s2', images: [], relayRounds: 1, orchestration: 'director',
    composers: { s1: { draft: 'Ask @[Claude](agent:claude) first', images: [image], relayRounds: 1, orchestration: 'director' } },
  }
  const patch = withPromptInDraft(fields, 's2', 's1', '[UI action] Order')
  assert.equal(patch.draft, undefined, 'the draft on show (s2) is not touched')
  assert.equal(patch.composers!.s1!.draft, 'Ask @[Claude](agent:claude) first\n\n[UI action] Order')
  assert.deepEqual(patch.composers!.s1!.images, [image], 'its images stay')
  const shown = withPromptInDraft({ ...fields, composers: {} }, 's1', 's1', '[UI action] Order')
  assert.equal(shown.draft, 'what I am writing in s2\n\n[UI action] Order')
  assert.equal(shown.images, undefined, 'only the words change')
})
