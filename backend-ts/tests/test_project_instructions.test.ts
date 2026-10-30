/** The project's instructions as a run reads them: the settings' text and the root's files with their source and
 *  scope, an attached folder's root file too, CONTRIBUTING never as an instruction, a cut by bytes that says so,
 *  the same snapshot in the prompt and the manifest, a folder's own file appended when the run enters it, and a
 *  note when the instructions changed under a continued conversation. */
import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { folderInstructions, MAX_INSTRUCTION_BYTES, projectInstructions, truncateBytes } from '../src/agent/project_instructions.ts'
import * as repo from '../src/db/repo.ts'
import { lastToolReturn, modelResponse, textPart, toolCallPart } from '../src/llm/messages.ts'
import { PathPolicy } from '../src/workspace/paths.ts'
import { attachedOf } from '../src/workspace/service.ts'
import { appState, buggyRepo, closeState, openSession, scriptedModel, setModel, userTexts, waitDone, type AppState } from './harness.ts'
import { tempDir } from './helpers.ts'

let state: AppState | null = null
afterEach(async () => { if (state) await closeState(state); state = null })

test('sources and scopes: the settings, the root files in order, an attached folder\'s root; never CONTRIBUTING; cut by bytes', () => {
  const root = tempDir('oasis-instr-')
  mkdirSync(join(root, '.oasis-code'))
  writeFileSync(join(root, '.oasis-code', 'INSTRUCTIONS.md'), 'harness first')
  writeFileSync(join(root, 'AGENTS.md'), 'agents ' + '字'.repeat(30_000))
  writeFileSync(join(root, 'CLAUDE.md'), 'claude')
  writeFileSync(join(root, 'CONTRIBUTING.md'), 'how to contribute')
  const attachedRoot = tempDir('oasis-attached-')
  writeFileSync(join(attachedRoot, 'AGENTS.md'), 'attached rules')
  const { symlinkSync } = require('node:fs') as typeof import('node:fs')
  symlinkSync(attachedRoot, join(root, 'Files'))
  const policy = PathPolicy.forWorkspace(root, [], { name: 'Files', root: attachedRoot })
  const found = projectInstructions(policy, 'the person says')
  expect(found.map((f) => [f.source, f.scope, f.priority])).toEqual([
    ['project settings', 'the whole project', '1'], ['.oasis-code/INSTRUCTIONS.md', 'the working folder', '2'], ['AGENTS.md', 'the working folder', '3'],
    ['CLAUDE.md', 'the working folder', '4'], ['Files/AGENTS.md', 'Files/', '5'],
  ])
  const agents = found[2]!
  expect(agents.truncated).toBe(true)
  expect(Buffer.byteLength(agents.text.split('\n[truncated')[0]!, 'utf8')).toBeLessThanOrEqual(MAX_INSTRUCTION_BYTES)
  expect(agents.text).toEndWith(`[truncated at ${MAX_INSTRUCTION_BYTES} bytes]`)
  expect(agents.text).not.toContain('�')
  expect(truncateBytes('abc', 10)).toEqual({ text: 'abc', truncated: false })
  expect(found.some((f) => f.source.includes('CONTRIBUTING'))).toBe(false)
  // a subfolder's files, from below the root, deeper last; none for the root itself
  mkdirSync(join(root, 'src', 'api'), { recursive: true })
  writeFileSync(join(root, 'src', 'AGENTS.md'), 'src rules')
  writeFileSync(join(root, 'src', 'api', 'CLAUDE.md'), 'api rules')
  expect(folderInstructions(policy, ['src', 'api']).map((f) => [f.source, f.scope])).toEqual([['src/AGENTS.md', 'src/'], ['src/api/CLAUDE.md', 'src/api/']])
  expect(folderInstructions(policy, [])).toEqual([])
  expect(folderInstructions(policy, ['Files']).map((f) => f.source)).toEqual([])            // the attached root's own file is the run's from the start
})

test('the first message shows each source with its scope and the folder rule once, a subfolder\'s file among them; entering the folder adds nothing', async () => {
  state = await appState({ sandbox: true })
  const { session, project, ws } = await openSession(state, buggyRepo())
  writeFileSync(join(ws.path, 'AGENTS.md'), 'ROOT_RULE: keep functions small')
  mkdirSync(join(ws.path, 'lib'))
  writeFileSync(join(ws.path, 'lib', 'CLAUDE.md'), 'LIB_RULE: no prints in lib')
  writeFileSync(join(ws.path, 'lib', 'util.py'), 'x = 1\n')
  repo.updateProject(state.conn, project.id, { config: { instructions: 'SETTINGS_RULE: answer briefly' } })
  const prompts: string[] = []
  let n = 0
  setModel(state, 'scripted:a', scriptedModel((messages) => {
    prompts.push(userTexts(messages).join('\n---\n'))
    const calls = [['read_file', { path: 'lib/util.py' }], ['read_file', { path: 'lib/util.py' }], ['bash', { command: 'true', cwd: 'lib' }]] as const
    const next = calls[n++]
    return next ? modelResponse([toolCallPart(next[0], next[1], '')]) : modelResponse([textPart('done')])
  }))
  const run = await waitDone(state, (await state.runs.start(repo.getSession(state.conn, session.id)!, 'look')).id)
  const first = prompts[0]!
  expect(first).toContain('Project instructions: project settings\nScope: the whole project\nSETTINGS_RULE: answer briefly')
  expect(first).toContain('Project instructions: AGENTS.md\nScope: the working folder\nROOT_RULE: keep functions small')
  // the subfolder's file is known before anything happens in lib/, with its scope, after the roots' files
  expect(first).toContain('Project instructions: AGENTS.md\nScope: the working folder\nROOT_RULE: keep functions small\nProject instructions: lib/CLAUDE.md\nScope: lib/\nLIB_RULE: no prints in lib')
  expect(first.split('Folder instructions apply within their folder. More specific folders take precedence.').length).toBe(2)
  // entering lib/ (two reads, a command run there) adds nothing: once in the whole conversation
  expect(prompts.at(-1)!.split('LIB_RULE').length).toBe(2)
  expect(prompts.at(-1)!.split('Folder instructions apply within their folder').length).toBe(2)
  expect(prompts.at(-1)!).not.toContain('App note:\nProject instructions')
  const manifest = repo.getRun(state.conn, run.id)!.manifest
  expect((manifest.inputs as Record<string, unknown>[]).filter((i) => i.kind === 'instruction_file').map((i) => i.source)).toEqual(['project settings', 'AGENTS.md', 'lib/CLAUDE.md'])
  expect(manifest.project_instruction_sources).toEqual(['project settings', 'AGENTS.md', 'lib/CLAUDE.md'])
  expect(manifest.instructions_shown).toEqual([...(manifest.inputs as Record<string, unknown>[]).filter((i) => i.kind === 'instruction_file').map((i) => ({ source: i.source, sha256: i.sha256 }))])
})

test('a continued conversation is told what changed in the instructions since, and only that', async () => {
  state = await appState()
  const { session, project, ws } = await openSession(state, buggyRepo())
  writeFileSync(join(ws.path, 'AGENTS.md'), 'VERSION_ONE')
  const prompts: string[] = []
  setModel(state, 'scripted:a', scriptedModel((messages) => { prompts.push(userTexts(messages).at(-1)!); return modelResponse([textPart('ok')]) }))
  const s = () => repo.getSession(state!.conn, session.id)!
  await waitDone(state, (await state.runs.start(s(), 'one')).id)
  await waitDone(state, (await state.runs.start(s(), 'two')).id)
  expect(prompts[1]).not.toContain('Project instructions changed')
  repo.updateProject(state.conn, project.id, { config: { instructions: 'NOW_BRIEF' } })
  await waitDone(state, (await state.runs.start(s(), 'three')).id)
  expect(prompts[2]).toContain('App note: Project instructions changed.\nProject instructions: project settings\nScope: the whole project\nNOW_BRIEF')
  expect(prompts[2]).not.toContain('VERSION_ONE')                                          // unchanged: not repeated
  await waitDone(state, (await state.runs.start(s(), 'four')).id)
  expect(prompts[3]).not.toContain('Project instructions changed')
})
