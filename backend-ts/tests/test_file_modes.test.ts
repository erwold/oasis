/** A file the agent replaces keeps its permission bits: an executable script stays executable, a private file stays
 *  private — through edit_file and write_file as a run uses them. Only the read / write / execute bits are carried
 *  (never setuid, setgid or sticky); a new file gets the default; an explicit mode is exact (the umask does not cut
 *  it); a refused write leaves the bytes and the bits as they were. Plain text files in private folders; nothing is
 *  executed. */

import { afterEach, expect, test } from 'bun:test'
import { chmodSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as repo from '../src/db/repo.ts'
import { modelResponse, textPart, toolCallPart } from '../src/llm/messages.ts'
import { atomicWrite, sha256Hex, WriteConflict } from '../src/store.ts'
import { appState, buggyRepo, closeState, openSession, scriptedModel, setModel, waitDone, type AppState } from './harness.ts'
import { tempDir } from './helpers.ts'

let state: AppState | null = null
afterEach(async () => { if (state) await closeState(state); state = null })

const bits = (path: string) => statSync(path).mode & 0o7777

test('edit_file and write_file keep 0755, 0700 and 0600 of the files they replace; a file they create gets the default', async () => {
  state = await appState()
  const { session, ws } = await openSession(state, buggyRepo())
  const files = { 'run.sh': 0o755, 'own.sh': 0o700, 'private.txt': 0o600 } as const
  for (const [name, mode] of Object.entries(files)) {
    writeFileSync(join(ws.path, name), `line one of ${name}\n`)
    chmodSync(join(ws.path, name), mode)
  }
  let n = 0
  setModel(state, 'scripted:a', scriptedModel(() => {
    n += 1
    if (n === 1) return modelResponse(Object.keys(files).map((f, i) => toolCallPart('read_file', { path: f }, `r${i}`)))
    if (n === 2) return modelResponse([
      toolCallPart('edit_file', { path: 'run.sh', old_string: 'line one', new_string: 'line ONE' }, 'e1'),
      toolCallPart('write_file', { path: 'own.sh', content: 'rewritten\n' }, 'w1'),
      toolCallPart('edit_file', { path: 'private.txt', old_string: 'line one', new_string: 'line ONE' }, 'e2'),
      toolCallPart('write_file', { path: 'new.txt', content: 'new\n' }, 'w2'),
    ])
    return modelResponse([textPart('done')])
  }))
  const run = await waitDone(state, (await state.runs.start(session, 'edit them')).id)
  expect(run.status).toBe('done')
  const results = repo.listEvents(state.conn, run.id).filter((e) => e.event === 'tool_result' && ['e1', 'w1', 'e2', 'w2'].includes(String(e.data.tool_call_id)))
  expect(results.map((e) => e.data.status)).toEqual(['ok', 'ok', 'ok', 'ok'])
  expect(readFileSync(join(ws.path, 'run.sh'), 'utf8')).toBe('line ONE of run.sh\n')
  expect(readFileSync(join(ws.path, 'own.sh'), 'utf8')).toBe('rewritten\n')
  expect(bits(join(ws.path, 'run.sh'))).toBe(0o755)
  expect(bits(join(ws.path, 'own.sh'))).toBe(0o700)
  expect(bits(join(ws.path, 'private.txt'))).toBe(0o600)
  const umask = process.umask()
  expect(bits(join(ws.path, 'new.txt'))).toBe(0o644 & ~umask)                         // new: the default, never executable
})

test('keep_mode carries the rwx bits only; an explicit mode is exact; a refused write leaves bytes and bits', () => {
  const dir = tempDir('oasis-modes-')
  const target = join(dir, 'f.txt')
  writeFileSync(target, 'ONE')
  chmodSync(target, 0o2755)                                                            // setgid on a private test file
  atomicWrite(target, 'TWO', { expect: { sha256: sha256Hex('ONE') }, keep_mode: true })
  expect(bits(target)).toBe(0o755)                                                     // setgid not carried
  atomicWrite(target, 'THREE', { mode: 0o640 })
  expect(bits(target)).toBe(0o640)                                                     // exact, whatever the umask
  chmodSync(target, 0o700)
  writeFileSync(target, 'OTHER')
  expect(() => atomicWrite(target, 'FOUR', { expect: { sha256: sha256Hex('THREE') }, keep_mode: true })).toThrow(WriteConflict)
  expect(readFileSync(target, 'utf8')).toBe('OTHER')
  expect(bits(target)).toBe(0o700)
  // without keep_mode a replacement gets the default, as before
  atomicWrite(target, 'FIVE')
  expect(bits(target)).toBe(0o644 & ~process.umask())
})
