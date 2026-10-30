/** The other spellings of a folder the share already knows (its project's, its workspaces', the data folder, a home):
 *  macOS reaches /tmp, /var and /etc through /private (symlinks of the system's), and the app stores a folder by its
 *  real path (workspace/git.ts realSource: `/tmp/x` is kept as `/private/tmp/x`) while words, commands and arguments
 *  say it either way. Each known folder is matched under both spellings, in both directions. Pure string work on
 *  folders the share already holds: no filesystem lookup, and nothing is derived from the text being sanitized. */

import { join, normalize, sep } from 'node:path'

/** the system folders macOS keeps under /private */
const PRIVATE_ROOTS = ['/tmp', '/var', '/etc'] as const

const under = (path: string, root: string): boolean => path === root || path.startsWith(`${root}/`)

/** The folder and its equivalent spelling (`/private/tmp/x` ↔ `/tmp/x`, `/private/var/…` ↔ `/var/…`,
 *  `/private/etc/…` ↔ `/etc/…`); a folder under none of them is only itself. */
export function pathAliases(dir: string): string[] {
  const d = dir.replace(/\/+$/, '')
  const out = new Set<string>([dir])
  for (const root of PRIVATE_ROOTS) {
    if (under(d, `/private${root}`)) out.add(d.slice('/private'.length))
    else if (under(d, root)) out.add(`/private${d}`)
  }
  return [...out]
}

/** Every folder of a list under each of its spellings, without repeats. */
export function withAliases(dirs: readonly string[]): string[] {
  return [...new Set(dirs.flatMap(pathAliases))]
}

/** The spellings under which two paths may be taken as the SAME place: on macOS (`darwin`), where /tmp, /var and /etc
 *  are the system's links into /private, both; anywhere else only the path itself — there /tmp and /private/tmp are not
 *  promised to be one folder. Used where an equivalence grants something (a cwd read as inside a harness-managed copy);
 *  where it only masks or refuses more, withAliases applies everywhere. */
export function samePlaceAliases(dir: string, platform: string = process.platform): string[] {
  return platform === 'darwin' ? pathAliases(dir) : [dir]
}

/** A command's cwd read relative to the harness-managed copy it ran in (share/snapshot.ts cwdForms), or null when it is
 *  not provably inside it: the copy must be exactly `<workspacesDir>/<id>` and never a data folder (under every
 *  spelling: a refusal), and the cwd inside it at a path boundary, `..` resolved — under a spelling of the copy taken as
 *  the same place on this platform (samePlaceAliases), the relative path computed from the spelling it really matched.
 *  Paths are compared as given (normalized, no trailing separator); pure: no filesystem lookup. */
export function copyRelativePath(o: { cwd: string; root: string; id: string; workspacesDir: string; dataRoots: readonly string[]; platform?: string }): string | null {
  const trim = (p: string) => normalize(p).replace(/[\\/]+$/, '')
  const platform = o.platform ?? process.platform
  const roots = samePlaceAliases(trim(o.root), platform)
  const homes = samePlaceAliases(trim(o.workspacesDir), platform)
  if (!roots.some((r) => homes.some((w) => r === join(w, o.id)))) return null
  const data = withAliases(o.dataRoots.map(trim))
  if (withAliases(roots).some((r) => data.includes(r))) return null
  const at = trim(o.cwd)
  const root = roots.find((r) => at === r || at.startsWith(`${r}${sep}`))
  if (root === undefined) return null
  return at === root ? '.' : at.slice(root.length + 1)
}
