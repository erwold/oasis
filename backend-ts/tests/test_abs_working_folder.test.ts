/** An absolute path in the working folder is the relative path it names: a folder edited in place is its own real
 *  path, and an agent told that path (by the person, by a director) reaches it, read and write alike, under the same
 *  protections as its relative form. A snapshot's working folder is its copy: the original's path stays outside. */

import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PathPolicy, PathRefused } from '../src/workspace/paths.ts'

const made: string[] = []
afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }) })
function folder(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'abs-wf-')))
  made.push(d)
  mkdirSync(join(d, 'handoff'))
  writeFileSync(join(d, 'README.md'), 'hello\n')
  writeFileSync(join(d, 'handoff', 'notes.md'), 'notes\n')
  return d
}

test('a folder edited in place: its absolute path and the paths below it read as their relative forms', () => {
  const root = folder()
  const policy = PathPolicy.forWorkspace(root, [], null, { pinned: true })
  expect(policy.resolveRead(join(root, 'README.md'))).toEqual(policy.resolveRead('README.md'))
  expect(policy.resolveRead(join(root, 'handoff', 'notes.md'))).toEqual(policy.resolveRead('handoff/notes.md'))
  expect(policy.resolveRead(root)[0]).toEqual([])                  // the folder itself, as a cwd is given
  expect(policy.resolveWrite(join(root, 'out.md'))).toEqual(policy.resolveWrite('out.md'))
})

test('the same protections as the relative form: .git and protected globs refused, .. refused, a sibling outside', () => {
  const root = folder()
  const policy = PathPolicy.forWorkspace(root, ['secrets/**'], null, { pinned: true })
  expect(() => policy.resolveWrite(join(root, '.git', 'config'))).toThrow()
  expect(() => policy.resolveWrite(join(root, 'secrets', 'k'))).toThrow()
  expect(() => policy.resolveRead(`${root}/../x`)).toThrow(PathRefused)
  expect(() => policy.resolveRead(`${root}-other/README.md`)).toThrow(/outside the allowed folders/)
})

test("a snapshot's copy: the original folder's absolute path is still outside, the copy's own path inside", () => {
  const original = folder()
  const copy = folder()
  const policy = PathPolicy.forWorkspace(copy, [])
  expect(() => policy.resolveRead(join(original, 'README.md'))).toThrow(/outside the allowed folders/)
  expect(policy.resolveRead(join(copy, 'README.md'))).toEqual(policy.resolveRead('README.md'))
})

test('a temporary folder and a session root still take the paths they hold', () => {
  const root = folder()
  const temp = folder()
  const extra = folder()
  const policy = PathPolicy.forWorkspace(root, [], null, { pinned: true, temp, roots: [{ path: extra, access: 'read' } as never] })
  expect(policy.resolveRead(join(temp, 'README.md'))[0][0]).toBe(temp)
  expect(policy.resolveRead(join(extra, 'README.md'))[0][0]).toBe(extra)
})
