/** The Seatbelt profile's strings carry a path exactly: a backslash, a quote, a dot, a wildcard character, a
 *  space, a newline or a non-ASCII name in a workspace path keeps the rule on that path and on no sibling. A
 *  backslash once collapsed in the profile's string made the workspace rule match the sibling path without it
 *  (SEC-04); a quote ended the string. Real sandbox-exec, on macOS only. */

import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { globFilters, regexEscape, SeatbeltRuntime, sbplString, type Sandbox } from '../src/execution/isolation.ts'
import { sandboxForWorkspace } from '../src/workspace/sandbox.ts'

test('a profile string doubles backslashes and escapes quotes, nothing else', () => {
  expect(sbplString('/tmp/plain')).toBe('/tmp/plain')
  expect(sbplString('/tmp/back\\slash')).toBe('/tmp/back\\\\slash')
  expect(sbplString('/tmp/dq"uote')).toBe('/tmp/dq\\"uote')
  expect(sbplString('/tmp/a.b (c) [d] *e* $f 中文\n')).toBe('/tmp/a.b (c) [d] *e* $f 中文\n')
  // a regex body's own escapes are doubled the same way, so the matcher gets them
  expect(globFilters('/tmp/back\\slash', '*.txt')).toEqual(['(regex "^/tmp/back\\\\\\\\slash/.*\\\\.txt$")'])
  expect(globFilters('/tmp/dq"uote', 'src')).toEqual(['(subpath "/tmp/dq\\"uote/src")'])
})

/** [own name, a sibling name without the special character] */
const NAMES: [string, string, string][] = [
  ['backslash', 'back\\slash', 'backslash'], ['two backslashes', 'a\\\\b', 'a\\b'], ['backslash n', 'a\\nb', 'anb'], ['quote', 'dq"uote', 'dquote'],
  ['dot', 'a.b', 'axb'], ['star', 'a*b', 'ab'], ['question mark', 'a?b', 'ab'], ['bracket', 'a[b', 'ab'], ['parentheses', 'a(b)c', 'abc'],
  ['dollar', 'a$b', 'ab'], ['caret', 'a^b', 'ab'], ['plus', 'a+b', 'ab'], ['braces', 'a{b}c', 'abc'], ['pipe', 'a|b', 'ab'],
  ['space', 'with space', 'withspace'], ['chinese', '中文工作区', 'zhongwen'], ['newline', 'line\nbreak', 'linebreak'], ['tab', 'a\tb', 'ab'],
]

const ATTEMPT = `const fs = require('node:fs'); const [own, sibling] = process.argv.slice(2); const out = {}
const tries = { own_read: () => fs.readFileSync(own + '/source.txt', 'utf8'), own_write: () => { fs.writeFileSync(own + '/written.txt', 'W'); return 'W' },
  sibling_read: () => fs.readFileSync(sibling + '/source.txt', 'utf8'), sibling_write: () => { fs.writeFileSync(sibling + '/written.txt', 'W'); return 'W' } }
for (const [k, f] of Object.entries(tries)) { try { out[k] = { ok: f() } } catch (e) { out[k] = { code: e.code } } }
console.log(JSON.stringify(out))`

test.skipIf(process.platform !== 'darwin')('a workspace path with a special character: its own reads and writes go through, the sibling without it stays denied', () => {
  const root = realpathSync(mkdtempSync('/private/tmp/oasis-sandbox-paths-'))
  const runtime = new SeatbeltRuntime()
  const script = join(root, 'attempt.cjs')
  writeFileSync(script, ATTEMPT)
  const failures: string[] = []
  try {
    for (const [label, own, sibling] of NAMES) {
      const data = join(root, label.replace(/\W+/g, '-'), 'data')
      const ws = join(data, 'workspaces', own)
      const other = join(data, 'workspaces', sibling)
      const base = join(data, 'base.git')
      for (const dir of [ws, other, base]) mkdirSync(dir, { recursive: true })
      writeFileSync(join(ws, 'source.txt'), 'OWN')
      writeFileSync(join(other, 'source.txt'), 'SIBLING')
      // the workspace's own confinement, as a command of it gets it
      const box = sandboxForWorkspace(data, { kind: 'snapshot', source_path: null, base_repo_path: base }, { path: ws }, { network: false })
      const argv = runtime.command([process.execPath, script, ws, other], box, join(root, `${label.replace(/\W+/g, '-')}.sb`))
      const result = spawnSync(argv[0]!, argv.slice(1), { cwd: ws, encoding: 'utf8', timeout: 10_000 })
      let seen: Record<string, { ok?: string; code?: string }> = {}
      try { seen = JSON.parse(result.stdout.trim()) } catch { seen = {} }
      const expected = { own_read: 'OWN', own_write: 'W', sibling_read: 'EPERM', sibling_write: 'EPERM' }
      const got = { own_read: seen.own_read?.ok ?? seen.own_read?.code, own_write: seen.own_write?.ok ?? seen.own_write?.code, sibling_read: seen.sibling_read?.code ?? seen.sibling_read?.ok, sibling_write: seen.sibling_write?.code ?? seen.sibling_write?.ok }
      if (result.status !== 0 || JSON.stringify(got) !== JSON.stringify(expected) || existsSync(join(other, 'written.txt')) || !existsSync(join(ws, 'written.txt'))) {
        failures.push(`${label}: exit ${result.status} ${JSON.stringify(got)} ${(result.stderr || '').trim().slice(0, 120)}`)
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  expect(failures).toEqual([])
}, 60_000)

test.skipIf(process.platform !== 'darwin')('a work order\'s wildcard scope (a regex rule) holds under a path with a backslash and a quote', () => {
  const root = realpathSync(mkdtempSync('/private/tmp/oasis-sandbox-regex-'))
  const runtime = new SeatbeltRuntime()
  try {
    for (const name of ['back\\slash', 'dq"uote', 'a.b']) {
      const ws = join(root, name.replace(/\W+/g, '-'), name)
      const sibling = join(root, name.replace(/\W+/g, '-'), name.replace(/[\\".]/g, '') || 'sibling')
      mkdirSync(join(ws, 'src'), { recursive: true })
      mkdirSync(join(sibling, 'src'), { recursive: true })
      writeFileSync(join(ws, 'src', 'a.txt'), 'A')
      writeFileSync(join(ws, 'src', 'b.md'), 'B')
      writeFileSync(join(sibling, 'src', 'a.txt'), 'S')
      const box: Sandbox = {
        writable: [ws], write_deny: [], read_deny: [root], read_allow: [ws, sibling], network: false,
        bounds: { root: ws, read_only: false, read: ['src/*.txt'], write: null, protected: [], repository: [] },
      }
      const read = (file: string) => {
        const argv = runtime.command(['/bin/cat', file], box, join(root, 'p.sb'))
        const result = spawnSync(argv[0]!, argv.slice(1), { cwd: ws, encoding: 'utf8', timeout: 10_000 })
        return result.status === 0 ? result.stdout : /not permitted/.test(result.stderr) ? 'denied' : result.stderr
      }
      expect(`${name}: ${read(join(ws, 'src', 'a.txt'))}`).toBe(`${name}: A`)   // the scope's file, read
      expect(read(join(ws, 'src', 'b.md'))).toBe('denied')                          // the same folder's file outside the glob
      expect(read(join(sibling, 'src', 'a.txt'))).toBe('S')                         // the sibling path, readable by the workspace rules, untouched by the order's
      expect(readFileSync(join(root, 'p.sb'), 'utf8')).toContain(`(regex "^${sbplString(regexEscape(ws))}/src/.*\\\\.txt$")`)   // the order's rule, as a plain string
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)
