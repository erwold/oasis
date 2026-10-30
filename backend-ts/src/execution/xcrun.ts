/** macOS's developer-tool shims (`/usr/bin/python3`, `/usr/bin/git`, `clang`, …) resolve the real tool through
 *  xcrun and keep the answer in a lookup cache in the user's own temp directory (`$DARWIN_USER_TEMP_DIR/xcrun_db`).
 *  A shim that finds no entry for its tool writes the cache — and inside the sandbox that write is refused (the
 *  cache must stay the user's: a sandboxed command that could rewrite it could point the host's `python3` at a binary
 *  of its own), so the shim prints `couldn't create cache file … (errno=Operation not permitted)` on stderr and goes
 *  on. The cure is on the host side: the harness, running as the user, asks xcrun for the tools ahead of time (a
 *  common set at start, and any tool a command's stderr says was cold), which writes the very cache the shims read.
 *  Nothing here touches the sandbox or a command's output. */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

export const XCRUN_TOOLS = [
  'python3', 'python', 'git', 'clang', 'clang++', 'cc', 'c++', 'swift', 'swiftc', 'make', 'ld', 'lldb', 'ar', 'nm', 'otool', 'strip',
  'lipo', 'ranlib', 'libtool', 'dsymutil',
]

const XCRUN = '/usr/bin/xcrun'
const MISS = /^([^\s:]+): error: couldn't create cache file '[^']*xcrun_db[^']*'/gm

/** The tools whose shims reported a cold cache in this stderr, once each, in order. */
export function xcrunCacheMisses(stderr: string): string[] {
  const out: string[] = []
  for (const m of stderr.matchAll(MISS)) if (!out.includes(m[1]!)) out.push(m[1]!)
  return out
}

/** The cache is keyed by the HOME the tool ran under (a different string, even a trailing slash, is another
 *  entry): a command's warmth is the warmth of its sandbox HOME, so the harness gives a workspace's commands one
 *  HOME and warms that. */
export type Finder = (tool: string, home: string) => Promise<void>

/** `xcrun --find <tool>` on the host under the given HOME, its answer discarded: what warms the cache. */
export function hostFind(tool: string, home: string): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(XCRUN, ['--find', tool], { stdio: 'ignore', timeout: 15_000, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home } })
    child.once('exit', () => resolve())
    child.once('error', () => resolve())
  })
}

export class XcrunWarmer {
  readonly enabled: boolean
  /** by HOME: the tools warmed under it */
  readonly warmed = new Map<string, Set<string>>()
  private readonly find: Finder
  private chain: Promise<unknown> = Promise.resolve()

  constructor(opts: { find?: Finder; enabled?: boolean } = {}) {
    this.enabled = opts.enabled ?? (process.platform === 'darwin' && existsSync(XCRUN))
    this.find = opts.find ?? hostFind
  }

  /** Warm, under `home`, the tools not warmed there yet, one after another (the cache is one file); the names
   *  warmed now. */
  warm(tools: string[], home: string): Promise<string[]> {
    if (!this.enabled) return Promise.resolve([])
    let done = this.warmed.get(home)
    if (!done) { done = new Set(); this.warmed.set(home, done) }
    const known = done
    const fresh: string[] = []
    for (const t of tools) if (/^[\w+.-]+$/.test(t) && !known.has(t)) { known.add(t); fresh.push(t) }
    const run = this.chain.then(async () => {
      for (const t of fresh) { try { await this.find(t, home) } catch { /* the shim will say so again */ } }
      return fresh
    })
    this.chain = run.catch(() => undefined)
    return run
  }
}
