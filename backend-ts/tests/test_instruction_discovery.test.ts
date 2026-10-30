/** What a run is told before it acts, and only when it changes: the subfolders' instruction files are in the first
 *  message (a rule is known before the first change in its folder, however the folder is entered), a folder whose
 *  rules are on their way to the model holds a change until they are read, a rule shown once is not shown again in
 *  a continued conversation unless it changed, the approval mode and an attached folder's writability are part of
 *  the permissions a later run compares, the configuration's protected paths are restrictions too, the temporary
 *  folder is outside an order's read-only and scopes, and a folder listing pages by offset and limit. */

import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Session } from '@oasis-code/contract'
import { modePolicy } from '@oasis-code/contract/modes'
import { parseWorkOrder } from '../src/agent/work_orders.ts'
import * as repo from '../src/db/repo.ts'
import { lastToolReturn, modelResponse, textPart, toolCallPart, toolReturns, userTexts, type ModelMessage } from '../src/llm/messages.ts'
import * as gate from '../src/policy/gate.ts'
import { appState, buggyRepo, closeState, openSession, scriptedModel, setModel, waitDone, type AppState } from './harness.ts'
import { tempDir } from './helpers.ts'

let state: AppState | null = null
afterEach(async () => { if (state) await closeState(state); state = null })

type Call = [string, Record<string, unknown>]
type R = Record<string, unknown>

/** A run that makes the calls in order (each request answers the previous return), recording every request's
 *  user texts and every tool return. */
async function calls(session: Session, sequence: Call[], opts: { order?: R; fresh?: boolean } = {}) {
  const results: R[] = []
  const prompts: string[] = []
  const latest: string[] = []
  let n = 0
  setModel(state!, 'scripted:a', scriptedModel((messages: ModelMessage[]) => {
    prompts.push(userTexts(messages).join('\n---\n'))
    latest.push(userTexts(messages).at(-1) ?? '')
    if (n > 0) results.push(lastToolReturn(messages, sequence[n - 1]![0]) as R)
    const next = sequence[n++]
    return next ? modelResponse([toolCallPart(next[0], next[1], '')]) : modelResponse([textPart('done')])
  }))
  const run = await state!.runs.start(repo.getSession(state!.conn, session.id)!, 'synthetic task', { fresh: opts.fresh ?? true, ...(opts.order ? { work_order: parseWorkOrder({ prompt: 'synthetic task', ...opts.order }) } : {}) })
  const done = await waitDone(state!, run.id)
  return { results, prompts, latest, status: done.status, run_id: run.id }
}

const count = (text: string, word: string) => text.split(word).length - 1

test("a subfolder's rule is in the first message: a first write, a command in the folder, a read and a write in one response, and a cd inside a command all see it before anything happens", async () => {
  for (const kind of ['direct-write', 'bash-cwd', 'same-response-read-write', 'bash-internal-cd']) {
    state = await appState({ sandbox: true })
    const { session, ws } = await openSession(state, buggyRepo())
    mkdirSync(join(ws.path, 'lib'))
    writeFileSync(join(ws.path, 'lib', 'AGENTS.md'), 'QA_LIB_RULE: every new text file here says SAFE.')
    writeFileSync(join(ws.path, 'lib', 'existing.txt'), 'seed')
    const path = join(ws.path, 'lib', 'new.txt')
    const snapshots: { visible: boolean; file: string | null }[] = []
    let n = 0
    setModel(state, 'scripted:a', scriptedModel((messages) => {
      const visible = JSON.stringify(messages).includes('QA_LIB_RULE')
      snapshots.push({ visible, file: existsSync(path) ? readFileSync(path, 'utf8') : null })
      if (n++ > 0) return modelResponse([textPart('done')])
      // the script writes what it knows: UNSAFE without the rule, SAFE with it
      const content = visible ? 'SAFE' : 'UNSAFE'
      if (kind === 'direct-write') return modelResponse([toolCallPart('write_file', { path: 'lib/new.txt', content }, '')])
      if (kind === 'same-response-read-write') return modelResponse([toolCallPart('read_file', { path: 'lib/existing.txt' }, ''), toolCallPart('write_file', { path: 'lib/new.txt', content }, '')])
      return modelResponse([toolCallPart('bash', kind === 'bash-cwd' ? { command: `printf ${content} > new.txt`, cwd: 'lib' } : { command: `cd lib && printf ${content} > new.txt` }, '')])
    }))
    const run = await waitDone(state, (await state.runs.start(session, 'Create lib/new.txt under the folder rules.')).id)
    expect(`${kind}: ${run.status}`).toBe(`${kind}: done`)
    expect(`${kind}: ${snapshots[0]!.visible}`).toBe(`${kind}: true`)                // the rule before the first request
    expect(`${kind}: ${readFileSync(path, 'utf8')}`).toBe(`${kind}: SAFE`)
    expect(snapshots.some((s) => s.file === 'UNSAFE')).toBe(false)
    const manifest = run.manifest as R
    expect(manifest.project_instruction_sources).toContain('lib/AGENTS.md')
    await closeState(state)
    state = null
  }
}, 60_000)

test('a rule that appears during the run holds the first change in its folder until the model has read it, then the change goes through', async () => {
  state = await appState({ sandbox: true })
  const { session, ws } = await openSession(state, buggyRepo())
  // the folder and its rule are made by the run itself: nothing to discover at the start
  const first = await calls(session, [
    ['write_file', { path: 'made/AGENTS.md', content: 'QA_MADE_RULE: files here say SAFE.' }],
    ['write_file', { path: 'made/new.txt', content: 'UNSAFE' }],
  ])
  expect(first.results[0]!.status).toBe('ok')
  expect(first.results[1]!.status).toBe('deferred')                                   // held: the rule is in this message
  expect(String(first.results[1]!.reason)).toContain('Instructions for made/ apply to this change')
  expect(existsSync(join(ws.path, 'made', 'new.txt'))).toBe(false)
  expect(count(first.prompts.at(-1)!, 'QA_MADE_RULE')).toBe(1)                        // shown once, with the deferral
  // the next run of the conversation writes there freely: the rule was read
  const second = await calls(session, [['write_file', { path: 'made/new.txt', content: 'SAFE' }]], { fresh: false })
  expect(second.results[0]!.status).toBe('ok')
  expect(readFileSync(join(ws.path, 'made', 'new.txt'), 'utf8')).toBe('SAFE')
  expect(count(second.prompts.at(-1)!, 'QA_MADE_RULE')).toBe(1)                       // not shown again
  // a command run in a folder whose rule was noted by a read in the same response is held the same way; the read is not
  const returns: R[] = []
  let step = 0
  setModel(state, 'scripted:a', scriptedModel((messages) => {
    if (step === 2) returns.push(lastToolReturn(messages, 'read_file') as R, lastToolReturn(messages, 'bash') as R)
    const responses = [
      [toolCallPart('write_file', { path: 'cmd/AGENTS.md', content: 'QA_CMD_RULE' }, '')],
      [toolCallPart('read_file', { path: 'cmd' }, ''), toolCallPart('bash', { command: 'printf X > out.txt', cwd: 'cmd' }, '')],
      [textPart('done')],
    ]
    return modelResponse(responses[Math.min(step++, 2)]!)
  }))
  await waitDone(state, (await state.runs.start(repo.getSession(state.conn, session.id)!, 'make a rule and act on it', { fresh: false })).id)
  expect(returns[0]!.status).toBe('ok')
  expect(returns[1]!.status).toBe('deferred')
  expect(existsSync(join(ws.path, 'cmd', 'out.txt'))).toBe(false)
}, 30_000)

test('an unchanged folder rule is shown once across continued runs; a rule rewritten during a run is shown again as changed; a rule changed between runs is the delta', async () => {
  state = await appState()
  const { session, ws } = await openSession(state, buggyRepo())
  mkdirSync(join(ws.path, 'lib'))
  writeFileSync(join(ws.path, 'lib', 'AGENTS.md'), 'QA_UNCHANGED_FOLDER_RULE')
  writeFileSync(join(ws.path, 'lib', 'a.txt'), 'seed')
  const occurrences: number[] = []
  for (let i = 0; i < 4; i += 1) {
    const run = await calls(session, [['read_file', { path: 'lib/a.txt' }]], { fresh: i === 0 })
    occurrences.push(count(run.prompts.at(-1)!, 'QA_UNCHANGED_FOLDER_RULE'))
  }
  expect(occurrences).toEqual([1, 1, 1, 1])
  // rewritten between two requests of one run: the model is told, with the new text
  const instruction = join(ws.path, 'lib', 'AGENTS.md')
  const prompts: string[] = []
  let n = 0
  setModel(state, 'scripted:a', scriptedModel((messages) => {
    prompts.push(userTexts(messages).join('\n---\n'))
    if (n === 1) writeFileSync(instruction, 'QA_INRUN_VERSION_TWO')
    return n++ < 2 ? modelResponse([toolCallPart('read_file', { path: 'lib/a.txt' }, '')]) : modelResponse([textPart('done')])
  }))
  await waitDone(state, (await state.runs.start(session, 'read lib twice', { fresh: false })).id)
  expect(prompts.at(-1)!).toContain('QA_INRUN_VERSION_TWO')
  expect(prompts.at(-1)!).toContain('Project instructions changed')
  // changed between runs: the note carries the changed file only, and names a source that is gone
  writeFileSync(instruction, 'QA_VERSION_THREE')
  writeFileSync(join(ws.path, 'AGENTS.md'), 'ROOT_RULE_ONE')
  const withRoot = await calls(session, [['read_file', { path: 'lib/a.txt' }]], { fresh: false })
  expect(withRoot.prompts.at(-1)!).toContain('QA_VERSION_THREE')
  expect(withRoot.prompts.at(-1)!).toContain('ROOT_RULE_ONE')
  const { rmSync } = await import('node:fs')
  rmSync(join(ws.path, 'AGENTS.md'))
  const gone = await calls(session, [['read_file', { path: 'lib/a.txt' }]], { fresh: false })
  const last = gone.prompts.at(-1)!
  expect(last).toContain('Instruction files no longer present: AGENTS.md')
  expect(count(last, 'QA_VERSION_THREE')).toBe(1)                                    // the unchanged file is not repeated
}, 30_000)

test('the approval mode and an attached folder\'s writability are told when they change, and only then; the configuration\'s protected paths are restrictions', async () => {
  state = await appState()
  state.config.protected_paths.push('qa-global/**')
  const { session } = await openSession(state, buggyRepo())
  const first = await calls(session, [])
  expect(first.prompts[0]!).toContain('qa-global/**: read-only.')
  const approval = modePolicy('approve')
  gate.recordRunControl(state.conn, session.id, approval.control.desired_state, approval.control.gate_effects)
  const second = await calls(session, [], { fresh: false })
  expect(second.latest.at(-1)!).toContain('App note: Approval mode: file changes and commands are proposed to the user and run only after approval.')
  gate.recordRunControl(state.conn, session.id, 'run', [])
  const third = await calls(session, [], { fresh: false })
  expect(third.latest.at(-1)!).toContain('App note: No permission is withheld. File restrictions:')   // the change back is told, the state said whole
  expect(third.latest.at(-1)!).not.toContain('Approval mode')
  const fourth = await calls(session, [], { fresh: false })
  expect(fourth.latest.at(-1)!).not.toContain('App note: ')                          // unchanged: nothing repeated
  // a protected path added to the configuration is a change of the restrictions
  state.config.protected_paths.push('qa-later/**')
  const fifth = await calls(session, [['write_file', { path: 'qa-later/x.txt', content: 'no' }]], { fresh: false })
  expect(fifth.latest[0]!).toContain('qa-later/**: read-only.')
  expect(fifth.results[0]!.status).toBe('refused')
  // an attached folder: read-only, then writable, then read-only again — each change told
  const attached = tempDir('oasis-attached-')
  writeFileSync(join(attached, 'note.txt'), 'ORIGINAL')
  const project = await state.workspaces.importProject('attached', attached, { mode: 'attached' })
  const created = repo.createSession(state.conn, project.id, 'attached', 'scripted:a')
  const ws = await state.workspaces.createWorkspace(project, created.id)
  repo.setSessionWorkspace(state.conn, created.id, ws.id)
  repo.setSessionGrants(state.conn, created.id, { ...created.grants, attached_write: false })        // writable by default: start read-only
  const attachedSession = repo.getSession(state.conn, created.id)!
  const a1 = await calls(attachedSession, [])
  expect(a1.prompts[0]!).toContain('(read-only)')
  repo.setSessionGrants(state.conn, attachedSession.id, { ...attachedSession.grants, attached_write: true })
  const a2 = await calls(attachedSession, [], { fresh: false })
  expect(a2.latest.at(-1)!).toMatch(/App note: Attached folder: .* \(writable\)/)
  repo.setSessionGrants(state.conn, attachedSession.id, { ...attachedSession.grants, attached_write: false })
  const a3 = await calls(attachedSession, [], { fresh: false })
  expect(a3.latest.at(-1)!).toMatch(/App note: Attached folder: .* \(read-only\)/)
}, 30_000)

test('the temporary folder is outside an order\'s read-only and scopes: its files are edited and written, the working folder is not', async () => {
  state = await appState({ sandbox: true })
  const { session, ws } = await openSession(state, buggyRepo())
  const before = readFileSync(join(ws.path, 'calc.py'), 'utf8')
  const tmp = state.processes.ensureTemp(ws.id)
  for (const scoped of [false, true]) {
    const edit = join(tmp, `edit-${scoped}.txt`)
    writeFileSync(edit, 'SEED')
    const r = (await calls(session, [
      ['read_file', { path: edit }],
      ['edit_file', { path: edit, old_string: 'SEED', new_string: 'EDITED' }],
      ['write_file', { path: join(tmp, `new-${scoped}.txt`), content: 'TOOL_TMP' }],
      ['read_file', { path: tmp }],
      ['write_file', { path: 'calc.py', content: 'BAD' }],
      ['read_file', { path: 'calc.py' }],
    ], { order: { read_only: true, ...(scoped ? { scope: { read: ['calc.py'], write: ['calc.py'] } } : {}) } })).results
    expect(r.slice(0, 4).map((x) => x.status)).toEqual(['ok', 'ok', 'ok', 'ok'])
    expect(r[4]!.status).toBe('refused_by_work_order')
    expect(r[5]!.status).toBe('ok')
    expect(readFileSync(edit, 'utf8')).toBe('EDITED')
    expect(readFileSync(join(ws.path, 'calc.py'), 'utf8')).toBe(before)
  }
}, 30_000)

test('a folder listing pages by offset and limit without repeating or missing an entry, in the working folder and the temporary folder', async () => {
  state = await appState()
  const { session, ws } = await openSession(state, buggyRepo())
  const tmp = state.processes.ensureTemp(ws.id)
  for (const base of ['workspace', 'tmp']) {
    for (const size of [0, 1, 300, 301, 600, 650]) {
      const rel = `listing-${size}`
      const disk = join(base === 'workspace' ? ws.path : tmp, rel)
      mkdirSync(disk)
      for (let i = 0; i < size; i += 1) writeFileSync(join(disk, `${String(i).padStart(4, '0')}.txt`), 'x')
      const path = base === 'workspace' ? rel : disk
      const { results } = await calls(session, [[...['read_file', { path, offset: 1, limit: 300 }]] as Call, ['read_file', { path, offset: 301, limit: 300 }], ['read_file', { path, offset: 601, limit: 300 }], ['read_file', { path, offset: 1, limit: 100 }], ['read_file', { path, offset: 1, limit: 400 }]])
      const pages = results.slice(0, 3)
      const names = pages.flatMap((r) => r.files as string[])
      expect(`${base}/${size}: ${pages.map((r) => (r.files as string[]).length).join(',')}`).toBe(`${base}/${size}: ${[0, 300, 600].map((o) => Math.max(0, Math.min(300, size - o))).join(',')}`)
      expect(new Set(names).size).toBe(size)
      expect(names.length).toBe(size)
      for (const [i, page] of pages.entries()) {
        if (size > (i + 1) * 300) expect(page.next_offset).toBe((i + 1) * 300 + 1)
        else { expect(page.truncated).toBe(false); expect(page.next_offset).toBeNull() }
      }
      expect((results[3]!.files as string[]).length).toBe(Math.min(100, size))
      expect((results[4]!.files as string[]).length).toBe(Math.min(300, size))         // folder pages are capped at 300, as the parameter says
    }
  }
}, 60_000)

test('over the discovery limit: the first command waits until the named folders\' rules are shown, a cd inside it included; a continued run is not held again', async () => {
  const { MAX_DISCOVERED_FILES } = await import('../src/agent/project_instructions.ts')
  state = await appState({ sandbox: true })
  const { session, ws } = await openSession(state, buggyRepo())
  for (let i = 0; i < MAX_DISCOVERED_FILES; i += 1) {
    mkdirSync(join(ws.path, `a${String(i).padStart(3, '0')}`))
    writeFileSync(join(ws.path, `a${String(i).padStart(3, '0')}`, 'AGENTS.md'), `OTHER_RULE_${i}`)
  }
  mkdirSync(join(ws.path, 'z_target'))
  writeFileSync(join(ws.path, 'z_target', 'AGENTS.md'), 'QA_OVER_CAP_RULE: files here say SAFE.')
  const path = join(ws.path, 'z_target', 'new.txt')
  const seen: { visible: boolean; file: string | null }[] = []
  const returns: R[] = []
  let n = 0
  setModel(state, 'scripted:a', scriptedModel((messages) => {
    const visible = JSON.stringify(messages).includes('QA_OVER_CAP_RULE')
    seen.push({ visible, file: existsSync(path) ? readFileSync(path, 'utf8') : null })
    if (n > 0) returns.push(lastToolReturn(messages, 'bash') as R)
    if (n++ >= 2) return modelResponse([textPart('done')])
    return modelResponse([toolCallPart('bash', { command: `cd z_target && printf ${visible ? 'SAFE' : 'UNSAFE'} > new.txt` }, '')])
  }))
  await waitDone(state, (await state.runs.start(session, 'write z_target/new.txt')).id)
  expect(seen[0]!.visible).toBe(false)                                                // only named at first
  expect(returns[0]!.status).toBe('deferred')                                         // held, nothing ran
  expect(String(returns[0]!.reason)).toContain('z_target/')
  expect(seen[1]).toEqual({ visible: true, file: null })
  expect(returns[1]!.status).toBe('succeeded')
  expect(readFileSync(path, 'utf8')).toBe('SAFE')
  // the next run of the conversation has them: a command runs at once
  const next = await calls(session, [['bash', { command: 'true' }]], { fresh: false })
  expect(next.results[0]!.status).toBe('succeeded')
  expect(count(next.prompts.at(-1)!, 'QA_OVER_CAP_RULE')).toBe(1)
}, 30_000)

test('over the discovery limit, two commands in one response are both held until the rules are read', async () => {
  const { MAX_DISCOVERED_FILES } = await import('../src/agent/project_instructions.ts')
  state = await appState({ sandbox: true })
  const { session, ws } = await openSession(state, buggyRepo())
  for (let i = 0; i < MAX_DISCOVERED_FILES; i += 1) {
    mkdirSync(join(ws.path, `a${String(i).padStart(3, '0')}`))
    writeFileSync(join(ws.path, `a${String(i).padStart(3, '0')}`, 'AGENTS.md'), `OTHER_RULE_${i}`)
  }
  mkdirSync(join(ws.path, 'z_target'))
  writeFileSync(join(ws.path, 'z_target', 'AGENTS.md'), 'QA_OVER_CAP_RULE: files here say SAFE.')
  const path = join(ws.path, 'z_target', 'new.txt')
  let returns: R[] = []
  let n = 0
  setModel(state, 'scripted:a', scriptedModel((messages) => {
    if (n === 1) returns = toolReturns(messages).map((p) => p.content as R)
    const visible = JSON.stringify(messages).includes('QA_OVER_CAP_RULE')
    if (n++ >= 2) return modelResponse([textPart('done')])
    const content = visible ? 'SAFE' : 'UNSAFE'
    return modelResponse([toolCallPart('bash', { command: `cd z_target && printf ${content} > new.txt` }, ''), toolCallPart('bash', { command: `cd z_target && printf ${content} >> new.txt` }, '')])
  }))
  await waitDone(state, (await state.runs.start(session, 'write z_target/new.txt')).id)
  expect(returns.map((r) => r.status)).toEqual(['deferred', 'deferred'])
  expect(readFileSync(path, 'utf8')).toBe('SAFESAFE')                               // only after the rules were read
}, 30_000)

test("a read-only attached folder brings its root's rules only: a subfolder's come when the run reads there, and no command waits for them", async () => {
  state = await appState({ sandbox: true })
  const attached = tempDir('oasis-attached-')
  writeFileSync(join(attached, 'CLAUDE.md'), 'QA_ROOT_RULE: the attached root speaks.')
  mkdirSync(join(attached, 'otherproject', 'src'), { recursive: true })
  writeFileSync(join(attached, 'otherproject', 'AGENTS.md'), 'QA_NESTED_RULE: another project, not this task.')
  writeFileSync(join(attached, 'otherproject', 'src', 'main.ts'), 'export const x = 1')
  const project = await state.workspaces.importProject('attached', attached, { mode: 'attached' })
  const created = repo.createSession(state.conn, project.id, 'attached', 'scripted:a')
  const ws = await state.workspaces.createWorkspace(project, created.id)
  repo.setSessionWorkspace(state.conn, created.id, ws.id)
  repo.setSessionGrants(state.conn, created.id, { ...created.grants, attached_write: false })        // writable by default: made read-only
  const session = repo.getSession(state.conn, created.id)!
  const name = attached.split('/').pop()!
  const run = await calls(session, [['bash', { command: 'true' }], ['read_file', { path: `${name}/otherproject/src/main.ts` }]])
  expect(run.prompts[0]!).toContain('QA_ROOT_RULE')                                    // the root's rules come with the run
  expect(run.prompts[0]!).not.toContain('QA_NESTED_RULE')                              // a subfolder's do not
  expect(run.prompts[0]!).not.toContain('Instruction files also exist in')
  expect(run.results[0]!.status).toBe('succeeded')                                     // no command waits for them: nothing can change there
  expect(count(run.prompts.at(-1)!, 'QA_NESTED_RULE')).toBe(1)                          // read there: shown then, once
}, 30_000)

test('a writable attached folder brings its subfolders\' rules, but not a repository of its own inside it, nor a hidden folder\'s, and not past the byte cap', async () => {
  const { MAX_DISCOVERED_BYTES } = await import('../src/agent/project_instructions.ts')
  state = await appState({ sandbox: true })
  const attached = tempDir('oasis-attached-')
  mkdirSync(join(attached, 'lib'))
  writeFileSync(join(attached, 'lib', 'AGENTS.md'), 'QA_LIB_RULE: this project\'s own folder.')
  mkdirSync(join(attached, 'vendor', 'repo', '.git'), { recursive: true })
  writeFileSync(join(attached, 'vendor', 'repo', 'AGENTS.md'), 'QA_REPO_RULE: a repository of its own.')
  mkdirSync(join(attached, '.omx', 'state'), { recursive: true })
  writeFileSync(join(attached, '.omx', 'state', 'AGENTS.md'), 'QA_HIDDEN_RULE: another tool\'s state.')
  mkdirSync(join(attached, 'm1'))
  mkdirSync(join(attached, 'm2'))
  writeFileSync(join(attached, 'm1', 'AGENTS.md'), `QA_BIG_ONE ${'x'.repeat(Math.floor(MAX_DISCOVERED_BYTES * 0.6))}`)
  writeFileSync(join(attached, 'm2', 'AGENTS.md'), `QA_BIG_TWO ${'y'.repeat(Math.floor(MAX_DISCOVERED_BYTES * 0.6))}`)
  const project = await state.workspaces.importProject('attached', attached, { mode: 'attached' })
  const created = repo.createSession(state.conn, project.id, 'attached', 'scripted:a')
  const ws = await state.workspaces.createWorkspace(project, created.id)
  repo.setSessionWorkspace(state.conn, created.id, ws.id)
  repo.setSessionGrants(state.conn, created.id, { ...repo.getSession(state.conn, created.id)!.grants, attached_write: true })
  const session = repo.getSession(state.conn, created.id)!
  const name = attached.split('/').pop()!
  const run = await calls(session, [])
  const first = run.prompts[0]!
  expect(first).toContain('QA_LIB_RULE')
  expect(first).not.toContain('QA_REPO_RULE')
  expect(first).not.toContain('QA_HIDDEN_RULE')
  expect(first).toContain('QA_BIG_ONE')                                                // the first big file fits the cap
  expect(first).not.toContain('QA_BIG_TWO')                                            // the second does not: named instead
  expect(first).toContain(`Instruction files also exist in: ${name}/m2/`)
}, 30_000)
