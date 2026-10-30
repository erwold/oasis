/** The share's known folders under every spelling of them (src/share/path_alias.ts): macOS's /tmp, /var and /etc and
 *  their /private real paths, in both directions — a folder stored by its real path (`/private/tmp/…`, as realSource
 *  keeps it) and named in words as `/tmp/…`, and the other way round. Synthetic paths only. */

import { expect, test } from 'bun:test'
import { copyRelativePath, pathAliases, samePlaceAliases, withAliases } from '../src/share/path_alias.ts'
import { ShareSanitizer, type SanitizerContext } from '../src/share/sanitize.ts'
import { sensitivePath, sensitiveTool } from '../src/share/sensitive.ts'

const ctx = (over: Partial<SanitizerContext> = {}): SanitizerContext => ({ token: '', project_dirs: [], data_dirs: [], home_dirs: [], username: null, ...over })
const clean = (text: string, over: Partial<SanitizerContext>) => new ShareSanitizer(ctx(over)).text(text)

test('the aliases: /private/tmp ↔ /tmp, /private/var ↔ /var, /private/etc ↔ /etc — at a path boundary only, nothing else', () => {
  expect(pathAliases('/private/tmp/x/repo_b').sort()).toEqual(['/private/tmp/x/repo_b', '/tmp/x/repo_b'])
  expect(pathAliases('/tmp/x/repo_b').sort()).toEqual(['/private/tmp/x/repo_b', '/tmp/x/repo_b'])
  expect(pathAliases('/var/folders/ab/T/w').sort()).toEqual(['/private/var/folders/ab/T/w', '/var/folders/ab/T/w'])
  expect(pathAliases('/private/etc/app').sort()).toEqual(['/etc/app', '/private/etc/app'])
  // not a boundary, not one of them: only itself
  expect(pathAliases('/private/tmpfoo/x')).toEqual(['/private/tmpfoo/x'])
  expect(pathAliases('/tmpfoo/x')).toEqual(['/tmpfoo/x'])
  expect(pathAliases('/work/acme/repo')).toEqual(['/work/acme/repo'])
  expect(pathAliases('/opt/private/tmp/x')).toEqual(['/opt/private/tmp/x'])
  expect(withAliases(['/tmp/a', '/private/tmp/a', '/work/b'])).toEqual(['/tmp/a', '/private/tmp/a', '/work/b'])
})

test('a folder stored by its real path, named as /tmp in words (and the other way round): project-relative either way', () => {
  // stored canonical (/private/tmp/…), the text's spelling /tmp/… — the case the task share's file showed
  expect(clean('compare with /tmp/oasis-e2e-x/userrepo_b/calc.py', { project_dirs: ['/private/tmp/oasis-e2e-x/userrepo_b'] })).toBe('compare with calc.py')
  // stored as /tmp/… (a system without /private, or a path kept as given), the text's spelling /private/tmp/…
  expect(clean('see /private/tmp/oasis-e2e-x/userrepo/a.py', { project_dirs: ['/tmp/oasis-e2e-x/userrepo'] })).toBe('see a.py')
  // the same under /var (macOS's per-user temp folder) and its real path
  expect(clean('at /var/folders/ab/T/w1/src/m.ts', { project_dirs: ['/private/var/folders/ab/T/w1'] })).toBe('at src/m.ts')
  expect(clean('at /private/var/folders/ab/T/w1/src/m.ts', { project_dirs: ['/var/folders/ab/T/w1'] })).toBe('at src/m.ts')
  // the data folder and a home folder too
  expect(clean('db at /tmp/e2e/data/index.db', { data_dirs: ['/private/tmp/e2e/data'] })).toBe('db at <app-data>/index.db')
  expect(clean('in /private/tmp/h/notes', { home_dirs: ['/tmp/h'] })).toBe('in ~/notes')
  // a path boundary: a longer folder that only starts the same is not the project
  expect(clean('/tmp/oasis-e2e-x/userrepo_b/calc.py', { project_dirs: ['/private/tmp/oasis-e2e-x/userrepo'] })).toBe('/tmp/oasis-e2e-x/userrepo_b/calc.py')
  // longest first under both spellings: a workspace inside the data folder is project-relative, not <app-data>/…
  expect(clean('/tmp/e2e/data/ws/w1/a.py', { data_dirs: ['/private/tmp/e2e/data'], project_dirs: ['/private/tmp/e2e/data/ws/w1'] })).toBe('a.py')
  // an absolute path of no known folder is left as written (no blanket removal)
  expect(clean('see /opt/other/file.txt and /tmp/unrelated/x', { project_dirs: ['/private/tmp/oasis-e2e-x/userrepo_b'] })).toBe('see /opt/other/file.txt and /tmp/unrelated/x')
  const s = new ShareSanitizer(ctx({ project_dirs: ['/private/tmp/x/r'] }))
  s.text('/tmp/x/r/a and /private/tmp/x/r/b')
  expect(s.redacted.path).toBe(2)
})

test('the data folder as a sensitive source under either spelling', () => {
  // a file of no sensitive name: sensitive only as the data folder's
  expect(sensitivePath('/tmp/e2e/data/notes/plain.txt', ['/opt/elsewhere'])).toBe(false)
  expect(sensitivePath('/tmp/e2e/data/notes/plain.txt', ['/private/tmp/e2e/data'])).toBe(true)
  expect(sensitivePath('/private/tmp/e2e/data/notes/plain.txt', ['/tmp/e2e/data'])).toBe(true)
  expect(sensitiveTool('bash', { command: 'cat /tmp/e2e/data/notes/plain.txt' }, ['/private/tmp/e2e/data'])).toBe(true)
  expect(sensitiveTool('bash', { command: 'ls', cwd: '/tmp/e2e/data/notes' }, ['/private/tmp/e2e/data'])).toBe(true)
  expect(sensitivePath('/tmp/e2e/database/x.txt', ['/private/tmp/e2e/data'])).toBe(false)
})

test('a cwd inside a harness-managed copy: its other spelling is the same place on macOS only; never the data folder, a way out or a longer name', () => {
  const W = '/tmp/oasis-x/data/workspaces', D = ['/tmp/oasis-x/data']
  const rel = (cwd: string, root: string, platform: string, workspacesDir = W) => copyRelativePath({ cwd, root, id: 'ws_1', workspacesDir, dataRoots: D, platform })
  expect(samePlaceAliases('/tmp/a', 'darwin').sort()).toEqual(['/private/tmp/a', '/tmp/a'])
  expect(samePlaceAliases('/tmp/a', 'linux')).toEqual(['/tmp/a'])
  for (const platform of ['darwin', 'linux']) {
    // the spelling it is stored under: inside, relative from the root it matched
    expect(rel(`${W}/ws_1`, `${W}/ws_1`, platform)).toBe('.')
    expect(rel(`${W}/ws_1/src/lib`, `${W}/ws_1`, platform)).toBe('src/lib')
    // never inside: a longer name, a way out (`..` resolved), the data folder, a copy not at <workspaces>/<id>
    expect(rel(`${W}/ws_1_evil`, `${W}/ws_1`, platform)).toBeNull()
    expect(rel(`${W}/ws_1/../..`, `${W}/ws_1`, platform)).toBeNull()
    expect(rel(`${W}/ws_1/../ws_2`, `${W}/ws_1`, platform)).toBeNull()
    expect(rel('/tmp/oasis-x/data', `${W}/ws_1`, platform)).toBeNull()
    expect(rel(`${W}/ws_1`, '/tmp/elsewhere/ws_1', platform)).toBeNull()
    // a copy that IS a data folder (under any spelling) is never one
    expect(copyRelativePath({ cwd: '/private/tmp/oasis-x/data', root: '/tmp/oasis-x/data', id: 'data', workspacesDir: '/tmp/oasis-x', dataRoots: D, platform })).toBeNull()
  }
  // the other spelling, both directions: the same place on macOS — the relative path from the spelling it matched
  expect(rel(`/private${W}/ws_1/src`, `${W}/ws_1`, 'darwin')).toBe('src')
  expect(rel(`${W}/ws_1/src`, `/private${W}/ws_1`, 'darwin')).toBe('src')
  expect(rel(`/private${W}/ws_1/src`, `/private${W}/ws_1`, 'darwin', `${W}`)).toBe('src')
  expect(rel(`/private${W}/ws_1_evil`, `${W}/ws_1`, 'darwin')).toBeNull()
  expect(rel(`/private${W}/ws_1/../..`, `${W}/ws_1`, 'darwin')).toBeNull()
  // … and not elsewhere: /tmp and /private/tmp are not promised to be one folder (read whole, not as the copy)
  expect(rel(`/private${W}/ws_1/src`, `${W}/ws_1`, 'linux')).toBeNull()
  expect(rel(`${W}/ws_1/src`, `/private${W}/ws_1`, 'linux')).toBeNull()
  // text masking is not narrowed by the platform: every spelling everywhere
  expect(withAliases(['/tmp/a']).sort()).toEqual(['/private/tmp/a', '/tmp/a'])
})
