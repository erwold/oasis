/** A session surface (scope `session`): presented once by a run of the thread (its anchor), kept up to date by the
 *  thread's later runs — one block, at the anchor's place, whatever order the page hears things in. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { UiSurfaceRecordSchema, type UiSurfaceRecord } from '@oasis-code/contract'
import type { RunTreeRow, TranscriptEntry } from '../src/api/types'
import { stateAt } from '../src/state/replayState.ts'
import {
  adoptedSurface, applyEvent, crossSurfaceOf, fromTranscript, screenSurfaceEvent, withKnownSurfaces, withSurfaces, type SurfaceHolders, type ThreadEntry,
} from '../src/state/thread.ts'
import {
  admitSessionRecord, isSessionSurface, sessionEventRefusal, sessionWriterRefusal, supersedes, surfaceEventRole, updatedLabel, type RunFacts,
} from '../src/state/uiSurface.ts'
import { record } from './uiFixtures.ts'

const at = (sec: number) => new Date(Date.UTC(2026, 9, 12, 0, 0, sec)).toISOString()

/** The panel as it stands at a revision: anchored at run A, written by `by`. */
const panel = (revision: number, by: string, over: Partial<UiSurfaceRecord> = {}): UiSurfaceRecord =>
  record({ run_id: 'A', surface_id: 'calc', scope: 'session', updated_by_run_id: by, revision, updated_at: at(revision * 10), ...over })

const ev = (r: unknown, id: string) => ({ event: 'ui_surface', data: { surface: r } as Record<string, unknown>, id })
const uiRows = (rows: ThreadEntry[] | undefined) => (rows ?? []).filter((e) => e.kind === 'ui')
const notes = (rows: ThreadEntry[]) => rows.filter((e) => e.kind === 'note')

/** The page's holders (the store's slice), with adoption applied the way the store applies it. */
function page(threads: Record<string, ThreadEntry[]>, streamed: Record<string, unknown> = {}): { h: SurfaceHolders; adopt: (r: UiSurfaceRecord) => boolean } {
  const h: SurfaceHolders = { uiSurfaces: {}, threads, childThreads: {}, streamed, childStreamed: {} }
  return {
    h,
    adopt: (r) => {
      const patch = adoptedSurface(h, r)
      if (!patch) return false
      Object.assign(h, patch)
      return true
    },
  }
}

/** The session as the page's session detail says it, and a run of its main thread as the page's rows say it. */
const SESSION = { id: 's1', workspace_id: 'w' }
const main = (id: string, over: Partial<RunFacts> = {}): RunFacts => ({
  id, session_id: 's1', workspace_id: 'w', parent_run_id: null, work_order: null, relay_id: null, interaction_id: null, spawned_by: 'human', ...over,
})

/** A run's stream event as the store takes it: screened against the run's row (never the event's word), its own rows
 *  by the reducer (with the list's later word), then a session surface it updated into the anchor's rows. */
function hear(p: ReturnType<typeof page>, runId: string, heard: ReturnType<typeof ev>, run: RunFacts | undefined = main(runId)) {
  const item = screenSurfaceEvent(heard, runId, run, SESSION)
  p.h.threads = { ...p.h.threads, [runId]: withKnownSurfaces(applyEvent(p.h.threads[runId] ?? [], runId, item), runId, item, p.h.uiSurfaces) }
  const cross = crossSurfaceOf(runId, item)
  if (cross) p.adopt(cross)
}

test('the fixtures are the protocol: a session record parses, an old record without the fields still does', () => {
  assert.ok(UiSurfaceRecordSchema.safeParse(panel(2, 'B')).success)
  assert.ok(UiSurfaceRecordSchema.safeParse(record()).success)
  assert.equal(isSessionSurface(panel(1, 'A')), true)
  assert.equal(isSessionSurface(record()), false)
})

test("an event's record is shown only as its own run's surface, or as a session surface that very run wrote", () => {
  // a run surface: strictly its own run (as before), the writer — when said — that run
  assert.equal(surfaceEventRole('r1', record()), 'own')
  assert.equal(surfaceEventRole('r1', record({ updated_by_run_id: 'r1', scope: 'run' })), 'own')
  assert.equal(surfaceEventRole('r2', record()), null, "another run's surface")
  assert.equal(surfaceEventRole('r2', record({ updated_by_run_id: 'r2' })), null, 'a run surface is never updated by another run')
  assert.equal(surfaceEventRole('r1', record({ updated_by_run_id: 'r9' })), null, 'its own run, but another writer')
  // a session surface: the anchor's own event, or a later run of the thread that wrote it
  assert.equal(surfaceEventRole('A', panel(1, 'A')), 'own')
  assert.equal(surfaceEventRole('B', panel(2, 'B')), 'cross')
  assert.equal(surfaceEventRole('B', panel(2, 'C')), null, 'B cannot carry what C wrote')
  assert.equal(surfaceEventRole('A', panel(2, 'B')), null, "the anchor's stream cannot carry another run's write")
  assert.equal(surfaceEventRole('B', { ...panel(2, 'B'), created_at: undefined }), null, 'a record the contract refuses')
})

test("a later run's update of the panel: no row and no 'could not read' in its own rows; the anchor's block updated in place", () => {
  const anchorRows = fromTranscript('A', [{ kind: 'agent', text: 'Here is the panel:' }, { kind: 'ui', surface: panel(1, 'A') }] as TranscriptEntry[])
  const p = page({ A: anchorRows, B: [] })
  hear(p, 'B', { event: 'text_block', data: { text: 'Fetched the new price.' }, id: '1' })
  hear(p, 'B', ev(panel(2, 'B'), '2'))
  assert.deepEqual(p.h.threads.B!.map((e) => e.kind), ['agent'], 'the writer run shows its words, never a second copy')
  assert.equal(notes(p.h.threads.B!).length, 0)
  assert.deepEqual(p.h.threads.A!.map((e) => e.kind), ['agent', 'ui'], 'the panel keeps its place under the words before it')
  assert.equal(uiRows(p.h.threads.A)[0]!.surface!.revision, 2)
  assert.equal(uiRows(p.h.threads.A)[0]!.surface!.updated_by_run_id, 'B')
  // a third run (a wake) updates it again: still one block, at A
  p.h.threads.C = []
  hear(p, 'C', ev(panel(3, 'C'), '1'))
  assert.equal(uiRows(p.h.threads.A).length, 1)
  assert.equal(uiRows(p.h.threads.A)[0]!.surface!.revision, 3)
  assert.equal(uiRows(p.h.threads.C).length + uiRows(p.h.threads.B).length, 0)
  // what is not this run's write is said as unreadable, as ever (never shown as the panel)
  const forged = applyEvent([], 'C', ev(panel(4, 'B'), '9'))
  assert.deepEqual(forged.map((e) => e.kind), ['note'])
  assert.equal(crossSurfaceOf('C', ev(panel(4, 'B'), '9')), null)
  assert.equal(uiRows(p.h.threads.A)[0]!.surface!.revision, 3)
})

test('stale and reordered words never roll the panel back: an older revision, an older write, the same write again', () => {
  const p = page({ A: fromTranscript('A', [{ kind: 'ui', surface: panel(1, 'A') }] as TranscriptEntry[]), B: [], C: [] })
  hear(p, 'C', ev(panel(3, 'C'), '1'))
  hear(p, 'B', ev(panel(2, 'B'), '1'))                  // B's event, arriving after C's
  assert.equal(uiRows(p.h.threads.A)[0]!.surface!.revision, 3)
  // the list read before C wrote, answering late
  assert.equal(p.adopt(panel(2, 'B', { updated_at: at(25) })), false)
  assert.equal(uiRows(p.h.threads.A)[0]!.surface!.revision, 3)
  // the person's saved edit at revision 3 (a later write at the same revision) is taken; its own older echo is not
  const saved = panel(3, 'C', { state: { qty: 7, price: 4 }, updated_at: at(31) })
  assert.equal(p.adopt(saved), true)
  assert.equal(uiRows(p.h.threads.A)[0]!.surface!.state.qty, 7)
  hear(p, 'C', ev(panel(3, 'C'), '1'))                  // C's stream read again from its start
  assert.equal(uiRows(p.h.threads.A)[0]!.surface!.state.qty, 7)
  assert.equal(p.adopt(saved), false, 'the very same word: nothing to take')
  // a record of the other scope under the same key is never the later word (a surface never changes scope)
  const runScoped = record({ run_id: 'A', revision: 9, updated_at: at(90) })
  assert.equal(supersedes(runScoped, saved), false)
  assert.equal(p.adopt(runScoped), false)
  assert.equal(uiRows(p.h.threads.A)[0]!.surface!.scope, 'session')
})

test('a reload, or leaving the session and coming back: the anchor shows the latest; streams read again add nothing', () => {
  const latest = panel(4, 'D', { state: { qty: 5, price: 4 }, updated_at: at(45) })
  // transcripts: the anchor keeps the panel where it was presented; a writer run's transcript has none of it
  const threads = {
    A: fromTranscript('A', [{ kind: 'agent', text: 'Panel:' }, { kind: 'ui', surface: latest }] as TranscriptEntry[]),
    B: fromTranscript('B', [{ kind: 'agent', text: 'updated' }, { kind: 'ui', surface: panel(2, 'B') }] as TranscriptEntry[]),
  }
  assert.deepEqual(threads.B.map((e) => e.kind), ['agent'], "a writer run's transcript never shows a second copy")
  // the session's list (in any order with the streams) brings the latest once more: nothing changes
  const p = page(threads)
  assert.equal(p.adopt(latest), true)
  assert.equal(uiRows(p.h.threads.A)[0]!.surface!.revision, 4)
  // a live writer run's stream read again from its start (after=-1): its older events change nothing
  p.h.threads.D = []
  hear(p, 'D', ev(panel(3, 'D'), '1'))
  hear(p, 'D', ev(panel(4, 'D'), '2'))
  assert.equal(uiRows(p.h.threads.A)[0]!.surface!.state.qty, 5)
  assert.equal(uiRows(p.h.threads.A).length, 1)
  assert.equal(notes(p.h.threads.D!).length, 0)
})

test("the anchor's own stream read again from its start shows the panel as it stands now, at its own place", () => {
  const p = page({ A: [] }, { A: true })
  p.adopt(panel(5, 'E'))                                // the list answered first: A's row is not there yet
  assert.equal(uiRows(p.h.threads.A).length, 0, "a streamed run places its own surfaces where it presented them")
  hear(p, 'A', { event: 'text_block', data: { text: 'Here:' }, id: '1' })
  hear(p, 'A', ev(panel(1, 'A'), '2'))
  assert.deepEqual(p.h.threads.A!.map((e) => e.kind), ['agent', 'ui'])
  assert.equal(uiRows(p.h.threads.A)[0]!.surface!.revision, 5)
})

test('a later run whose anchor is not on the page puts nothing anywhere else', () => {
  const p = page({ B: [] })
  hear(p, 'B', ev(panel(2, 'B'), '1'))
  assert.deepEqual(Object.keys(p.h.threads), ['B'])
  assert.equal(uiRows(p.h.threads.B).length, 0)
  assert.equal(p.h.uiSurfaces['A/calc']!.revision, 2, 'held for when the anchor shows')
  // withSurfaces (the list into the threads on the page) places a record only at its own run
  const placed = withSurfaces({ B: [] }, [panel(2, 'B')])
  assert.equal(uiRows(placed.B).length, 0)
})

test('the replay shows the panel at its anchor as it stood at each moment; a run beside the thread never updates it', () => {
  const row = (id: string, spawned_by = 'human'): RunTreeRow => ({
    id, session_id: 's1', workspace_id: 'w', parent_run_id: null, resumes_run_id: null, spawned_by, label: null, model: 'm',
    user_text: 'hi', user_text_head: 'hi', status: 'done', usage: {}, error: null, created_at: at(0), finished_at: at(100),
    receipt: null, work_order: null, depth: 0, live: false, relay_id: null, relay_step: null, interaction_id: null, interaction_node: null,
  } as unknown as RunTreeRow)
  const events = [
    { seq: 1, run_id: 'A', event: 'ui_surface', data: { surface: panel(1, 'A') }, t: at(10) },
    { seq: 2, run_id: 'B', event: 'ui_surface', data: { surface: panel(2, 'B') }, t: at(20) },
    { seq: 3, run_id: 'X', event: 'ui_surface', data: { surface: panel(3, 'X') }, t: at(30) },
  ]
  const runs = [row('A'), row('B', 'wake'), { ...row('X', 'agent'), parent_run_id: 'A' } as RunTreeRow]
  const moment = (sec: number) => stateAt({ runs, events }, Date.parse(at(sec)), [], SESSION)
  assert.equal(uiRows(moment(15).threads.A)[0]!.surface!.revision, 1)
  const later = moment(25)
  assert.equal(uiRows(later.threads.A)[0]!.surface!.revision, 2)
  assert.equal(uiRows(later.threads.B).length, 0)
  assert.equal(notes(later.threads.B!).length, 0)
  const end = moment(40)
  assert.equal(uiRows(end.threads.A)[0]!.surface!.revision, 2, "a child run's write is not the thread's")
  assert.equal(uiRows(end.childThreads.X).length, 0)
})

test('when the panel last changed reads in the person\'s clock; a time that does not read is said as nothing', () => {
  const now = new Date(2026, 9, 12, 18, 0)
  const today = new Date(2026, 9, 12, 14, 5).toISOString()
  assert.match(updatedLabel(today, now, 'en-GB'), /^14:05$/)
  assert.match(updatedLabel(new Date(2026, 9, 10, 9, 30).toISOString(), now, 'en-GB'), /^10 Oct, 09:30$/)
  assert.match(updatedLabel(new Date(2025, 0, 2, 9, 30).toISOString(), now, 'en-GB'), /2025/)
  assert.equal(updatedLabel('not a time', now), '')
})

// ---------------------------------------------------------------- who may present one: the page's check on its own rows

test("the contract's main-thread check, on the page's rows: parent, work order, relay, interaction, spawner, session, workspace", () => {
  for (const spawned_by of ['human', 'wake', 'connector']) assert.equal(sessionWriterRefusal(main('A', { spawned_by }), SESSION), null, spawned_by)
  // an older row without the newer fields reads them as the contract's default (null)
  assert.equal(sessionWriterRefusal({ id: 'A', session_id: 's1', workspace_id: 'w', spawned_by: 'human' }, SESSION), null)
  const refused: [string, RunFacts][] = [
    ['parent', main('X', { parent_run_id: 'A' })],
    ['work order', main('X', { work_order: { scope: [] } })],
    ['relay turn spawned by a human', main('X', { relay_id: 'rel1' })],
    ['interaction node spawned by a human', main('X', { interaction_id: 'int1' })],
    ['a spawner outside THREAD_SPAWNERS', main('X', { spawned_by: 'ui_task' })],
    ['another session', main('X', { session_id: 's2' })],
    ['another workspace (a separate copy)', main('X', { workspace_id: 'w-copy' })],
    ['no workspace', main('X', { workspace_id: null })],
  ]
  for (const [why, run] of refused) assert.notEqual(sessionWriterRefusal(run, SESSION), null, why)
  assert.notEqual(sessionWriterRefusal(undefined, SESSION), null, 'an unknown run')
  assert.notEqual(sessionWriterRefusal(main('A'), null), null, 'an unknown session')
  assert.notEqual(sessionWriterRefusal(main('A'), { id: 's1', workspace_id: null }), null, 'a session without a workspace has no session surfaces')
})

test("a relay turn or interaction node (spawned by a human, no parent, no work order) presents no session surface, own or cross", () => {
  const relay = main('R', { relay_id: 'rel1' })
  const node = main('N', { interaction_id: 'int1' })
  // cross: R claims to have updated A's panel — the anchor is not touched, R's rows say it could not be read
  const p = page({ A: fromTranscript('A', [{ kind: 'ui', surface: panel(1, 'A') }] as TranscriptEntry[]), R: [], N: [] })
  hear(p, 'R', ev(panel(2, 'R'), '1'), relay)
  assert.equal(uiRows(p.h.threads.A)[0]!.surface!.revision, 1)
  assert.equal(p.h.uiSurfaces['A/calc'], undefined, 'nothing adopted')
  assert.deepEqual(p.h.threads.R!.map((e) => e.kind), ['note'])
  // own: N presents a session surface anchored at itself — no row
  hear(p, 'N', ev(record({ run_id: 'N', scope: 'session', updated_by_run_id: 'N' }), '1'), node)
  assert.equal(uiRows(p.h.threads.N).length, 0)
  assert.deepEqual(p.h.threads.N!.map((e) => e.kind), ['note'])
  // the same runs' run surfaces are shown as ever (the check is for session surfaces only)
  hear(p, 'R', ev(record({ run_id: 'R' }), '2'), relay)
  assert.equal(uiRows(p.h.threads.R).length, 1)
  assert.equal(screenSurfaceEvent(ev(record({ run_id: 'N' }), '3'), 'N', node, SESSION).data.surface !== undefined, true)
})

test("a child run's own session record (run_id = the child) is never drawn; the message's own words prove nothing", () => {
  const child = main('X', { parent_run_id: 'A', spawned_by: 'agent' })
  const own = record({ run_id: 'X', scope: 'session', updated_by_run_id: 'X' })
  assert.equal(surfaceEventRole('X', own), 'own', 'by the record alone it would be the child\'s own')
  const rows = applyEvent([], 'X', screenSurfaceEvent(ev(own, '1'), 'X', child, SESSION))
  assert.equal(uiRows(rows).length, 0)
  // an unknown run, a record that names another session, or the event naming a run that is not its own: refused
  assert.notEqual(sessionEventRefusal(panel(2, 'B'), 'B', undefined, SESSION), null)
  assert.notEqual(sessionEventRefusal(panel(2, 'B', { session_id: 's2' }), 'B', main('B'), SESSION), null)
  assert.notEqual(sessionEventRefusal(panel(2, 'B', { session_id: 's2' }), 'B', main('B', { session_id: 's2' }), { id: 's2', workspace_id: 'w2' }), null, 'the run is of s2 but its workspace is not')
  assert.notEqual(sessionEventRefusal(panel(2, 'B'), 'B', main('C'), SESSION), null)
  assert.equal(sessionEventRefusal(panel(2, 'B'), 'B', main('B'), SESSION), null)
  assert.equal(sessionEventRefusal(record({ run_id: 'X' }), 'X', child, SESSION), null, 'a run surface: not this check')
})

test('the replay: a relay turn the old thread rule counts as the thread, an interaction node and another workspace update nothing', () => {
  const row = (id: string, over: Partial<RunTreeRow> = {}): RunTreeRow => ({
    id, session_id: 's1', workspace_id: 'w', parent_run_id: null, resumes_run_id: null, spawned_by: 'human', label: null, model: 'm',
    user_text: 'hi', user_text_head: 'hi', status: 'done', usage: {}, error: null, created_at: at(0), finished_at: at(100),
    receipt: null, work_order: null, depth: 0, live: false, relay_id: null, relay_step: null, interaction_id: null, interaction_node: null, ...over,
  } as unknown as RunTreeRow)
  const runs = [row('A'), row('R', { relay_id: 'rel1' }), row('N', { interaction_id: 'int1' }), row('W', { workspace_id: 'w-copy' }), row('B', { spawned_by: 'wake' })]
  const events = [
    { seq: 1, run_id: 'A', event: 'ui_surface', data: { surface: panel(1, 'A') }, t: at(10) },
    { seq: 2, run_id: 'R', event: 'ui_surface', data: { surface: panel(2, 'R') }, t: at(20) },
    { seq: 3, run_id: 'N', event: 'ui_surface', data: { surface: record({ run_id: 'N', surface_id: 'own', scope: 'session', updated_by_run_id: 'N' }) }, t: at(21) },
    { seq: 4, run_id: 'W', event: 'ui_surface', data: { surface: panel(3, 'W') }, t: at(22) },
    { seq: 5, run_id: 'R', event: 'ui_surface', data: { surface: record({ run_id: 'R', surface_id: 'mine' }) }, t: at(23) },
    { seq: 6, run_id: 'B', event: 'ui_surface', data: { surface: panel(4, 'B') }, t: at(30) },
  ]
  const m = stateAt({ runs, events }, Date.parse(at(25)), [], SESSION)
  assert.ok('R' in m.threads, 'the relay turn is a thread row (the thread classification is unchanged)')
  assert.equal(uiRows(m.threads.A)[0]!.surface!.revision, 1, 'neither R nor W moved the panel')
  assert.equal(uiRows(m.threads.N).length, 0, "N's own session surface is not drawn")
  assert.deepEqual(uiRows(m.threads.R).map((e) => e.surface!.surface_id), ['mine'], "R's run surface still is")
  assert.equal(uiRows(stateAt({ runs, events }, Date.parse(at(35)), [], SESSION).threads.A)[0]!.surface!.revision, 4, 'the main thread run does')
  // without the session's facts no session surface is shown; run surfaces are
  const blind = stateAt({ runs, events }, Date.parse(at(35)))
  assert.equal(uiRows(blind.threads.A).length, 0)
  assert.equal(uiRows(blind.threads.R).length, 1)
})

test("restoring (the session's list, a transcript): the page refuses runs it knows the contract excludes, and takes the harness's word for the rest", () => {
  const rows = [main('A'), main('B', { spawned_by: 'wake' }), main('R', { relay_id: 'rel1' }), main('W', { workspace_id: 'w-copy' })]
  const known = (id: string) => rows.find((r) => r.id === id)
  assert.equal(admitSessionRecord(panel(3, 'B'), known, SESSION), true)
  assert.equal(admitSessionRecord(panel(3, 'Z'), known, SESSION), true, 'a writer the page has no row of: the harness filtered the list')
  assert.equal(admitSessionRecord(panel(3, 'R'), known, SESSION), false, 'a writer it knows as a relay turn')
  assert.equal(admitSessionRecord(panel(3, 'W'), known, SESSION), false, 'a writer it knows in another workspace')
  assert.equal(admitSessionRecord(record({ run_id: 'R', scope: 'session', updated_by_run_id: 'R' }), known, SESSION), false, 'an anchor it knows as a relay turn')
  assert.equal(admitSessionRecord(panel(3, 'B', { session_id: 's2' }), known, SESSION), false, 'another session')
  assert.equal(admitSessionRecord(record({ run_id: 'R' }), known, SESSION), true, "a run surface: the relay turn's own, as ever")
  assert.equal(admitSessionRecord(record({ run_id: 'old' }), known, null), true, 'old run records need no session facts')
  // a transcript: the anchor's panel at its place when it may be; a relay turn's session record never; its run surface yes
  const admit = (r: UiSurfaceRecord) => admitSessionRecord(r, known, SESSION)
  assert.equal(uiRows(fromTranscript('A', [{ kind: 'ui', surface: panel(4, 'B') }] as TranscriptEntry[], admit)).length, 1)
  assert.equal(uiRows(fromTranscript('R', [{ kind: 'ui', surface: record({ run_id: 'R', scope: 'session', updated_by_run_id: 'R' }) }] as TranscriptEntry[], admit)).length, 0)
  assert.equal(uiRows(fromTranscript('R', [{ kind: 'ui', surface: record({ run_id: 'R' }) }] as TranscriptEntry[], admit)).length, 1)
})
