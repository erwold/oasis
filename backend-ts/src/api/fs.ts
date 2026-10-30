/** The folder browser behind the start screen's folder dialog: the person points the harness at a folder on this
 *  machine the way an Open panel would, without typing a path. Directories only, names only, hidden entries left
 *  out; nothing under the folder is read. */

import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { basename, dirname, join, parse } from 'node:path'
import { Hono } from 'hono'
import { expandUser } from '../config.ts'
import { HttpError, type Api } from './common.ts'

export const MAX_ENTRIES = 20_000

export function favorites(): { label: string; path: string }[] {
  const home = homedir()
  const named: [string, string][] = [
    ['Home', home], ['Desktop', join(home, 'Desktop')], ['Documents', join(home, 'Documents')], ['Downloads', join(home, 'Downloads')],
    [platform() === 'darwin' ? 'Macintosh HD' : 'Root', parse(home).root],
  ]
  return named.filter(([, path]) => isDir(path)).map(([label, path]) => ({ label, path }))
}

function isDir(path: string): boolean {
  try { return statSync(path).isDirectory() } catch { return false }
}

export function listDirs(pathIn: string): Record<string, unknown> {
  let target = pathIn.trim() ? expandUser(pathIn) : homedir()
  try {
    target = realpathSync(target)
  } catch {
    throw new HttpError(400, `${pathIn || target} does not exist`)
  }
  if (!isDir(target)) throw new HttpError(400, `${target} is not a folder`)
  const entries: { name: string; path: string; repository: boolean }[] = []
  let dirents
  try {
    dirents = readdirSync(target, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EACCES' || (error as NodeJS.ErrnoException).code === 'EPERM') throw new HttpError(403, `${target} is not readable`)
    throw error
  }
  for (const entry of dirents) {
    if (entry.name.startsWith('.')) continue
    const child = join(target, entry.name)
    if (!(entry.isDirectory() || (entry.isSymbolicLink() && isDir(child)))) continue
    entries.push({ name: entry.name, path: child, repository: existsSync(join(child, '.git')) })
  }
  entries.sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0))
  const parent = dirname(target) !== target ? dirname(target) : null
  return { path: target, name: basename(target) || target, parent, entries: entries.slice(0, MAX_ENTRIES), truncated: entries.length > MAX_ENTRIES, favorites: favorites() }
}

export function fsRoutes(_api: Api): Hono {
  const app = new Hono()
  app.get('/api/fs/dirs', (c) => c.json(listDirs(c.req.query('path') ?? '')))
  return app
}
