import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Project } from '../src/api/types'
import { crumbsOf, folderName, humanBytes, projectForFolder, railGroups, railView, refusalLine, sessionTitle, targetLabel } from '../src/state/rail.ts'

const baseSession = (projectId: string) => ({ project_id: projectId, title: 's', title_source: 'auto' as const, workspace_id: null, model: 'm', grants: { workspace_write: true, run_commands: true, attached_write: false, network: false, network_until: null, network_reason: null }, access_mode: 'sandbox' as const, status: 'open' })
const project = (id: string, updated: string, source: string | null, sessions: { id: string; updated_at: string }[]): Project => ({
  id, name: id, kind: 'snapshot', source_path: source, base_repo_path: '', base_commit: null, base_branch: null, import_report: {}, default_model: null,
  config: {}, created_at: updated, updated_at: updated,
  sessions: sessions.map((s) => ({ id: s.id, project_id: id, title: s.id, title_source: 'auto' as const, workspace_id: null, model: 'm', grants: { workspace_write: true, run_commands: true, attached_write: false, network: false, network_until: null, network_reason: null }, access_mode: 'sandbox' as const, status: 'open', created_at: s.updated_at, updated_at: s.updated_at })),
})

test('a task is titled by its first line, cut at a word', () => {
  assert.equal(sessionTitle('fix the add() bug\nand run the tests'), 'fix the add() bug')
  assert.equal(sessionTitle('   '), 'New task')
  assert.equal(sessionTitle('a'.repeat(80)), `${'a'.repeat(60)}…`)
  assert.equal(sessionTitle('please rename every helper in the utils package so the names say what they do and'), 'please rename every helper in the utils package so the names…')
})

test('a folder chip shows the last path segment', () => {
  assert.equal(folderName('/Users/x/code/wordfreq/'), 'wordfreq')
  assert.equal(folderName('C:\\work\\app'), 'app')
})

test('the rail groups sessions under their project, newest first on both levels', () => {
  const groups = railGroups([
    project('old', '2026-01-01T00:00:00Z', '/a', [{ id: 's1', updated_at: '2026-01-02T00:00:00Z' }, { id: 's2', updated_at: '2026-03-01T00:00:00Z' }]),
    project('new', '2026-02-01T00:00:00Z', '/b', []),
    { ...project('inplace', '2026-01-15T00:00:00Z', '/b', []), kind: 'direct' },
    { ...project('attached', '2026-01-10T00:00:00Z', '/b', []), kind: 'attached' },
  ])
  assert.deepEqual(groups.map((g) => g.project.id), ['old', 'new', 'inplace', 'attached'])   // its newest session is newer than the other projects
  assert.deepEqual(groups[0].sessions.map((s) => s.id), ['s2', 's1'])
  // a new task in a folder joins the project that opened it in place; one that copied it is left as it was
  assert.equal(projectForFolder(groups.map((g) => g.project), '/b/')?.id, 'inplace')
  assert.equal(projectForFolder(groups.map((g) => g.project), '/b', 'attached')?.id, 'attached')
  assert.equal(projectForFolder(groups.map((g) => g.project), '/a'), undefined)                 // only a copy of /a: a new project opens it in place
  assert.equal(projectForFolder(groups.map((g) => g.project), '/c'), undefined)
})

test('the rail orders by the latest activity, not by a record a rename or a restart touched; equal times keep one order', () => {
  const at = (d: number) => `2026-10-${String(d).padStart(2, '0')}T00:00:00.000Z`
  const session = (id: string, made: number, updated: number, active: number) => ({ id, updated_at: at(updated), created_at: at(made), last_activity_at: at(active) })
  const withActivity = (id: string, made: number, updated: number, active: number, sessions: ReturnType<typeof session>[]): Project => {
    const p = project(id, at(made), `/${id}`, [])
    return { ...p, updated_at: at(updated), last_activity_at: at(active), sessions: sessions.map((s) => ({ ...baseSession(id), ...s })) }
  }
  const groups = railGroups([
    // renamed and recovered on the 9th (updated_at), last active on the 3rd
    withActivity('touched', 1, 9, 3, [session('renamed', 1, 9, 3), session('quiet', 1, 2, 2)]),
    withActivity('worked', 1, 4, 5, [session('ran', 2, 4, 5)]),
    // equal activity: the later made first, then the greater id
    withActivity('tie', 1, 1, 4, [session('t-a', 3, 3, 4), session('t-c', 2, 2, 4), session('t-b', 3, 3, 4)]),
  ])
  assert.deepEqual(groups.map((g) => g.project.id), ['worked', 'tie', 'touched'])
  assert.deepEqual(groups[2].sessions.map((s) => s.id), ['renamed', 'quiet'])
  assert.deepEqual(groups[1].sessions.map((s) => s.id), ['t-b', 't-a', 't-c'])
  // the same order however the list came
  assert.deepEqual(railGroups([...groups.map((g) => ({ ...g.project, sessions: [...g.sessions].reverse() }))].reverse()).map((g) => [g.project.id, g.sessions.map((s) => s.id)]),
    groups.map((g) => [g.project.id, g.sessions.map((s) => s.id)]))
})

test('the folder chip names the target', () => {
  assert.equal(targetLabel(null), 'No folder')                                      // a task that needs none
  assert.equal(targetLabel({ kind: 'folder', path: '/x/y/app' }), 'app')
  assert.equal(targetLabel({ kind: 'project', projectId: 'p', name: 'named', path: null }), 'named')
})

test('a path reads as crumbs from the root', () => {
  assert.deepEqual(crumbsOf('/Users/x/code'), [{ name: '/', path: '/' }, { name: 'Users', path: '/Users' }, { name: 'x', path: '/Users/x' }, { name: 'code', path: '/Users/x/code' }])
  assert.deepEqual(crumbsOf('/'), [{ name: '/', path: '/' }])
})

test('an attached folder is labelled so, and the refusal line says what was measured and which limit', () => {
  assert.equal(targetLabel({ kind: 'folder', path: '/Users/x/Downloads' }), 'Downloads')
  assert.equal(targetLabel({ kind: 'folder', path: '/Users/x/Downloads', mode: 'attached' }), 'Downloads (attached, read-only)')
  assert.equal(humanBytes(311 * 1024 ** 3), '311 GB')
  assert.equal(humanBytes(3041), '3 kB')
  const line = refusalLine({ source_path: '/Users/x/Downloads', measured: { bytes: 2.5 * 1024 ** 3, files: 1200, stopped_early: true }, limits: { max_bytes: 2 * 1024 ** 3, max_files: 20000 } })
  assert.equal(line, 'Downloads is at least 2.5 GB in 1,200 files — too big to copy (the snapshot limit is 2.0 GB).')
  const byFiles = refusalLine({ source_path: '/x/stuff', measured: { bytes: 5000, files: 20001, stopped_early: true }, limits: { max_bytes: 2 * 1024 ** 3, max_files: 20000 } })
  assert.equal(byFiles, 'stuff is at least 5 kB in 20,001 files — too big to copy (the snapshot limit is 20,000 files).')
})


test('pins project the fully sorted rail: stable append order, No folder, unpin, activity and legacy answers', () => {
  const projects = [
    project('folder', '2026-01-01', '/code', [{ id: 'a', updated_at: '2026-01-02' }, { id: 'b', updated_at: '2026-01-03' }]),
    { ...project('no-folder', '2026-01-01', null, [{ id: 'c', updated_at: '2026-01-04' }]), config: { no_folder: true } },
    project('empty', '2026-01-01', '/empty', []),
  ]
  const ordinary = (ps: Project[]) => railView(ps).groups.map((g) => [g.project.id, g.tasks.map((t) => [t.session?.id ?? null, t.members.map((m) => m.session.id)])])
  const original = ordinary(projects)
  const a = projects[0]!.sessions![0]!, c = projects[1]!.sessions![0]!
  a.pin_order = 1; c.pin_order = 2
  assert.deepEqual(railView(projects).pinned.map((m) => m.session.id), ['a', 'c'])
  assert.deepEqual(railView(projects).groups.map((g) => g.project.id), railGroups(projects).map((g) => g.project.id))
  assert.deepEqual(railView(projects).groups.flatMap((g) => g.tasks.map((t) => t.session?.id)), ['b'])
  // A new No folder session and activity of a pin cannot steal another pin's place.
  projects[1]!.sessions!.push({ ...c, id: 'new', pin_order: null, updated_at: '2026-12-31' })
  c.last_activity_at = '2027-01-01'
  assert.deepEqual(railView(projects).pinned.map((m) => m.session.id), ['a', 'c'])
  projects[1]!.sessions!.pop(); delete c.last_activity_at
  a.pin_order = null; c.pin_order = null
  assert.deepEqual(ordinary(projects), original)
  // Defensive tie-break for loose wire records, irrespective of input order.
  a.pin_order = 7; c.pin_order = 7
  assert.deepEqual(railView([...projects].reverse()).pinned.map((m) => m.session.id), ['a', 'c'])
  a.status = 'archived'
  assert.deepEqual(railView(projects).pinned.map((m) => m.session.id), ['c'])
})

test('root and intermediate pins preserve cross-project multi-level members, their activity and unique rows', () => {
  const projects = [
    project('root-project', '2026-01-01', '/root', [{ id: 'root', updated_at: '2026-01-01' }, { id: 'other', updated_at: '2026-01-05' }]),
    project('middle-project', '2026-01-01', '/middle', [{ id: 'middle', updated_at: '2026-01-02' }]),
    project('leaf-project', '2026-01-01', null, [{ id: 'leaf', updated_at: '2026-01-10' }]),
  ]
  const root = projects[0]!.sessions![0]!, middle = projects[1]!.sessions![0]!, leaf = projects[2]!.sessions![0]!
  middle.task_root_id = root.id; leaf.task_root_id = middle.id
  const baseline = railGroups(projects)
  for (const pins of [[root], [middle], [leaf], [root, middle], [root, leaf], [root, middle, leaf]]) {
    for (const s of [root, middle, leaf]) s.pin_order = null
    pins.forEach((s, i) => { s.pin_order = i + 1 })
    const view = railView(projects)
    assert.deepEqual(view.groups.map((g) => g.project.id), baseline.map((g) => g.project.id))
    const pinnedIds = new Set(pins.map((s) => s.id))
    for (const [i, group] of view.groups.entries()) {
      const old = baseline[i]!
      const expected = old.sessions.map((s) => ({ id: s.id, session: pinnedIds.has(s.id) ? null : s,
        members: (old.members[s.id] ?? []).filter((m) => !pinnedIds.has(m.session.id)) }))
        .filter((t) => t.session || t.members.length)
      assert.deepEqual(group.tasks, expected)
    }
    const allIds = [...view.pinned.map((m) => m.session.id), ...view.groups.flatMap((g) => g.tasks.flatMap((t) => [...(t.session ? [t.session.id] : []), ...t.members.map((m) => m.session.id)]))]
    assert.equal(new Set(allIds).size, allIds.length)
    assert.deepEqual([...allIds].sort(), ['leaf', 'middle', 'other', 'root'])
    const rootGroup = view.groups.find((g) => g.project.id === 'root-project')!
    if (!pinnedIds.has('leaf')) assert.ok(rootGroup.tasks.find((t) => t.id === 'root')!.members.some((m) => m.session.id === 'leaf'))
  }
})
