/** Suite invariants: zero cloud calls (a fetch guard, not a convention), no provider keys, no data directory of
 *  the person's. Every provider mapping takes an injected fetch; the guard makes the global one refuse anything
 *  but the loopback so a forgotten injection fails loudly. The default data directory (and with it the default
 *  credential directory) is a private temp one, so a test that forgets to name its own never reads ~/.oasis-code. */

import { afterAll } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installNetworkGuard } from './network_guard.ts'
import { rememberTempDir, removeTempDirs, removeTestDir } from './temp_dirs.ts'

for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'DEEPSEEK_API_KEY', 'ZHIPU_API_KEY', 'OASIS_CODE_DATA', 'OASIS_CODE_AUTH_DIR', 'OASIS_CODE_CONFIG',
  'OASIS_CODE_SESSION_TOKEN', 'OASIS_CODE_USAGE_PROXY_AUTH_DIR']) {
  delete process.env[key]
}

/** A child process a test starts with this preload runs outside the test runner (afterAll throws there) and may be
 *  killed before it can clean up: its temp root is a folder of the parent run's, which the parent removes. */
const CHILD_TEMP_ROOT = 'OASIS_CODE_TEST_CHILD_TMP'
let underRunner = true
try {
  // bun gives a hook 5 s and applies no timeout from bunfig.toml: unsealing and removing a whole run's folders takes longer
  afterAll(removeRunTemp, 120_000)
} catch {
  underRunner = false
}
if (underRunner) {
  const childRoot = realpathSync(mkdtempSync(join(tmpdir(), 'oasis-test-children-')))
  rememberTempDir(childRoot)
  process.env[CHILD_TEMP_ROOT] = childRoot
} else if (process.env[CHILD_TEMP_ROOT]) {
  process.env.TMPDIR = process.env[CHILD_TEMP_ROOT]
}

const suiteDataDir = realpathSync(mkdtempSync(join(tmpdir(), 'oasis-suite-data-')))
process.env.OASIS_CODE_DATA = suiteDataDir
if (!underRunner) process.on('exit', () => { try { removeTempDirs() } finally { removeTestDir(suiteDataDir) } })

/** What the run made under the temp root goes when the last test has run (bun test emits no 'exit' to a preload);
 *  the application's modules load only then, after this file has set the suite's environment. */
async function removeRunTemp(): Promise<void> {
  // every folder is tried; a failure is thrown (seen), not swallowed, once the others are gone
  let failure: unknown = null
  try { removeTempDirs() } catch (error) { failure = error }
  const { closeOpenGitHomes } = await import('../src/workspace/git.ts')
  closeOpenGitHomes()
  removeTestDir(suiteDataDir)
  if (failure) throw failure
}

const originalFetch = installNetworkGuard()

export { TestNetworkBlocked } from './network_guard.ts'
export { originalFetch, suiteDataDir }
