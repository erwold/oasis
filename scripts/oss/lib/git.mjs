// Read-only access to a repository's committed objects, for the export and the scans. Every call is a local git
// command with prompts and lazy fetching switched off: nothing here writes the repository, reads the working tree
// or reaches a network (a partial clone that lacks an object fails instead of fetching it).

import { spawnSync } from 'node:child_process'

/** The environment every git call of these scripts runs with: built from scratch, never inherited wholesale, so an
 *  ambient GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE / GIT_OBJECT_DIRECTORY / GIT_CONFIG_* (or any other GIT_* variable)
 *  cannot redirect a call to another repository or inject configuration. Only PATH, HOME, TMPDIR and the locale are
 *  carried over; the system and global git configuration are ignored (no user hook, alias, fsmonitor or signing). */
export function isolatedGitEnv(extra = {}) {
  const env = {}
  for (const k of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'SYSTEMROOT']) if (process.env[k] !== undefined) env[k] = process.env[k]
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_LAZY_FETCH: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
    ...extra,
  }
}

/** Options that keep a git call from running anything configured in the repository it reads. */
export const SAFE_GIT_OPTIONS = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false']

export function git(repo, args, { input = undefined, maxBuffer = 1024 * 1024 * 1024 } = {}) {
  const r = spawnSync('git', ['-C', repo, ...SAFE_GIT_OPTIONS, ...args], { input, maxBuffer, env: isolatedGitEnv() })
  if (r.error) throw new Error(`git ${args[0]}: ${r.error.message}`)
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.toString().trim()}`)
  return r.stdout
}

/** The content of one committed file at a commit (a Buffer), read from the object database; throws when absent. */
export function readCommittedFile(repo, commit, path) {
  return git(repo, ['cat-file', 'blob', `${commit}:${path}`])
}

/** A revision -> its full commit id (throws when it does not name a commit). */
export function resolveCommit(repo, rev) {
  if (typeof rev !== 'string' || !rev || rev.startsWith('-')) throw new Error('name a commit (a revision that does not start with "-")')
  return git(repo, ['rev-parse', '--verify', '--end-of-options', `${rev}^{commit}`]).toString().trim()
}

/** Why a committed path is unsafe to write anywhere, or null. Git itself refuses most of these; a crafted repository
 *  might not, so they are checked again here. */
export function unsafePath(path) {
  if (!path) return 'empty path'
  if (/[\u0000-\u001f\u007f]/.test(path)) return 'control character in path'
  if (path.includes('\\')) return 'backslash in path'
  if (path.startsWith('/')) return 'absolute path'
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return `path segment "${seg}"`
    if (seg.toLowerCase().replace(/[. ]+$/, '') === '.git') return 'a .git path segment'
  }
  return null
}

/** The committed tree of a commit: [{ path, mode, type, sha }] for every entry (recursive, full tree). */
export function listTree(repo, commit) {
  const out = git(repo, ['ls-tree', '-r', '-z', '--full-tree', commit]).toString('utf8').split('\0').filter(Boolean)
  return out.map((line) => {
    const tab = line.indexOf('\t')
    const [mode, type, sha] = line.slice(0, tab).split(' ')
    return { path: line.slice(tab + 1), mode, type, sha }
  })
}

/** The entries of a tree that cannot be exported as plain files, each with the reason: symbolic links (120000),
 *  gitlinks / submodules (160000), any other mode, and unsafe paths. */
export function treeProblems(entries) {
  const problems = []
  for (const e of entries) {
    if (e.mode === '120000') problems.push({ path: e.path, why: 'symbolic link' })
    else if (e.mode === '160000' || e.type === 'commit') problems.push({ path: e.path, why: 'gitlink (submodule)' })
    else if (e.type !== 'blob' || (e.mode !== '100644' && e.mode !== '100755')) problems.push({ path: e.path, why: `entry of mode ${e.mode} / type ${e.type}` })
    const u = unsafePath(e.path)
    if (u) problems.push({ path: JSON.stringify(e.path), why: u })
  }
  return problems
}

/** Paths that would collide on a case-insensitive file system (macOS, Windows), as groups. */
export function caseCollisions(paths) {
  const by = new Map()
  for (const p of paths) {
    const k = p.toLowerCase()
    by.set(k, [...(by.get(k) ?? []), p])
  }
  return [...by.values()].filter((g) => g.length > 1)
}

/** The content of each blob, read from the object database (never the working tree). Throws on any object that is
 *  missing or not a blob. */
export function readBlobs(repo, shas) {
  const out = new Map()
  const list = [...new Set(shas)]
  for (let start = 0; start < list.length; start += 2000) {
    const chunk = list.slice(start, start + 2000)
    const buf = git(repo, ['cat-file', '--batch'], { input: chunk.join('\n') + '\n' })
    let i = 0
    while (i < buf.length) {
      const nl = buf.indexOf(10, i)
      const header = buf.subarray(i, nl).toString('utf8').split(' ')
      if (header[1] !== 'blob') throw new Error(`object ${header[0]}: ${header.slice(1).join(' ')}; stopping`)
      const size = Number(header[2])
      out.set(header[0], buf.subarray(nl + 1, nl + 1 + size))
      i = nl + 1 + size + 1
    }
  }
  for (const s of list) if (!out.has(s)) throw new Error(`object ${s} could not be read; stopping`)
  return out
}
