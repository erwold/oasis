/** The temporary folders a test run made through the shared helpers, removed once every test has run (preload).
 *  Kept free of the application's modules so the preload can import it before it sets the suite's environment.
 *
 *  A stored upload the app made in a test's data directory is sealed (macOS user-immutable, see
 *  workspace/attachment_access.ts sealStoredFile) and cannot be removed as it is: before a folder is removed, the seal
 *  is lifted from exactly those files — regular files named `<sha256>.<ext>` in an `assets/<project>/ref/` folder,
 *  found without following a link — and only inside a folder this test run made. Nothing else is touched; the app
 *  itself never lifts a seal when it closes. */

import { spawnSync } from 'node:child_process'
import { lstatSync, readdirSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

const made = new Set<string>()

export function rememberTempDir(path: string): void {
  made.add(path)
}

export function forgetTempDir(path: string): void {
  made.delete(path)
}

const STORED_UPLOAD = /^[a-f0-9]{64}\.[a-z0-9]{1,8}$/

/** The sealed uploads of the asset stores under a test's own folder (never through a link), unsealed. */
export function unsealTestUploads(root: string): void {
  if (process.platform !== 'darwin') return
  const files: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 12) return
    let names: string[]
    try { names = readdirSync(dir) } catch { return }
    for (const name of names) {
      const path = join(dir, name)
      let st
      try { st = lstatSync(path) } catch { continue }
      if (st.isDirectory()) walk(path, depth + 1)
      else if (st.isFile() && STORED_UPLOAD.test(name) && basename(dirname(path)) === 'ref' && basename(dirname(dirname(dirname(path)))) === 'assets') files.push(path)
    }
  }
  walk(root, 0)
  for (let i = 0; i < files.length; i += 200) {
    const r = spawnSync('/usr/bin/chflags', ['-h', 'nouchg', ...files.slice(i, i + 200)], { encoding: 'utf8', timeout: 30_000 })
    if (r.error || r.status !== 0) throw new Error(`could not unseal the test uploads under ${root}: ${r.error?.message ?? `chflags exit ${r.status}: ${String(r.stderr).trim()}`}`)
  }
}

/** A test's own folder removed, its sealed uploads unsealed first. */
export function removeTestDir(path: string): void {
  unsealTestUploads(path)
  rmSync(path, { recursive: true, force: true })
}

/** Every folder the run made removed; each is tried, and a failure (an unseal or a removal) is not swallowed: it is
 *  thrown, all of them together, once the rest are gone. */
export function removeTempDirs(): void {
  const failed: string[] = []
  for (const path of made) {
    try { removeTestDir(path) } catch (error) { failed.push(`${path}: ${(error as Error).message}`) }
  }
  made.clear()
  if (failed.length) throw new Error(`could not remove ${failed.length} test folder(s):\n${failed.join('\n')}`)
}
