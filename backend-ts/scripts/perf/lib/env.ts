/** Perf harness bootstrap — import FIRST (before any src/ module). Gives the process an isolated data root under the
 *  system temp folder, a private credential directory, no provider keys, and the test suite's loopback-only fetch
 *  guard, so no benchmark can read ~/.oasis-code or reach a real provider. HOME is never touched. Everything made under
 *  the root is removed when the process exits. Audit tooling only: no production logic lives here. */

import { existsSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { installNetworkGuard } from '../../../tests/network_guard.ts'
import { removeTempDirs, removeTestDir } from '../../../tests/temp_dirs.ts'

for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'DEEPSEEK_API_KEY', 'ZHIPU_API_KEY', 'OASIS_CODE_DATA', 'OASIS_CODE_AUTH_DIR',
  'OASIS_CODE_CONFIG', 'OASIS_CODE_SESSION_TOKEN', 'OASIS_CODE_USAGE_PROXY_AUTH_DIR', 'OASIS_CODE_PORT', 'OASIS_CODE_CONTEXT_WINDOW_TOKENS']) {
  delete process.env[key]
}

/** the temp folder as the shell gave it (results go under it unless --out says otherwise) */
export const ORIGINAL_TMPDIR = realpathSync(tmpdir())
/** PERF_FIXED_ROOT=1: a fixed root name (refused if it exists), so paths in prompts — and with them token counts
 *  and hashes — are the same from one process to the next (the fingerprint runs) */
function makeRoot(): string {
  if (process.env.PERF_FIXED_ROOT !== '1') return realpathSync(mkdtempSync(join(ORIGINAL_TMPDIR, 'oasis-perf-')))
  const fixed = join(ORIGINAL_TMPDIR, 'oasis-perf-fixed')
  if (existsSync(fixed)) throw new Error('the fixed perf root exists already (another bench running, or one that did not clean up); nothing was removed')
  mkdirSync(fixed)
  return realpathSync(fixed)
}
export const PERF_ROOT = makeRoot()

const realHomeData = resolve(homedir(), '.oasis-code')
/** refuse to run with a data root that is (or is inside) the person's data directory */
export function assertIsolated(dir: string): void {
  const r = resolve(dir)
  if (r === realHomeData || r.startsWith(realHomeData + sep)) throw new Error(`perf harness refuses data root inside the user's data directory: ${r}`)
}
assertIsolated(PERF_ROOT)

export const PERF_DATA = join(PERF_ROOT, 'data')
export const PERF_AUTH = join(PERF_ROOT, 'auth')
mkdirSync(PERF_DATA, { recursive: true })
mkdirSync(PERF_AUTH, { recursive: true })
mkdirSync(join(PERF_ROOT, 'tmp'), { recursive: true })
process.env.OASIS_CODE_DATA = PERF_DATA
process.env.OASIS_CODE_AUTH_DIR = PERF_AUTH
// the harness's own temp folders (test fixtures' tempDir) land under the root, removed with it
process.env.TMPDIR = join(PERF_ROOT, 'tmp')

export const originalFetch = installNetworkGuard()

let cleaned = false
export function cleanupPerfRoot(): void {
  if (cleaned) return
  cleaned = true
  try { removeTempDirs() } catch (error) { console.error(`perf cleanup: ${(error as Error).message}`) }
  if (process.env.PERF_KEEP_ROOT !== '1' && existsSync(PERF_ROOT)) {
    try { removeTestDir(PERF_ROOT) } catch (error) { console.error(`perf cleanup: ${(error as Error).message}`) }
  }
}
process.on('exit', cleanupPerfRoot)
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { cleanupPerfRoot(); process.exit(130) })
