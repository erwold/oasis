/** Preloaded into every storage benchmark (run.sh: `bun --preload`): the in-process half of the isolation, the
 *  sandbox profile being the other. No network (the global fetch refuses every request); no process but git, and
 *  git only where PERF_ALLOW_GIT=1; provider keys and the app's own path variables removed. What was refused is
 *  counted and said at exit by category only. */

import childProcess from 'node:child_process'
import { basename } from 'node:path'

const refused: Record<string, number> = {}
const note = (what: string) => { refused[what] = (refused[what] ?? 0) + 1 }

for (const key of Object.keys(process.env)) {
  if (/_API_KEY$|_TOKEN$|^OASIS_CODE_(AUTH_DIR|CONFIG|SESSION_TOKEN|USAGE_PROXY_AUTH_DIR)$/.test(key)) delete process.env[key]
}
if (!process.env.OASIS_CODE_DATA || !process.env.HOME || !process.env.TMPDIR) throw new Error('run through run.sh: HOME, TMPDIR and OASIS_CODE_DATA must name scratch folders')

globalThis.fetch = (() => { note('fetch'); return Promise.reject(new Error('network refused by the benchmark guard')) }) as unknown as typeof fetch

const allowGit = process.env.PERF_ALLOW_GIT === '1'
const gitOk = (bin: unknown) => allowGit && typeof bin === 'string' && basename(bin) === 'git'
for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork'] as const) {
  const original = (childProcess as unknown as Record<string, (...a: unknown[]) => unknown>)[name]!
  ;(childProcess as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
    if ((name === 'spawn' || name === 'spawnSync' || name === 'execFile' || name === 'execFileSync') && gitOk(args[0])) return original.apply(childProcess, args)
    note(`child_process.${name}`)
    throw new Error('process start refused by the benchmark guard')
  }
}
const bunSpawn = Bun.spawn
const bunSpawnSync = Bun.spawnSync
;(Bun as unknown as Record<string, unknown>).spawn = (...args: unknown[]) => {
  const cmd = Array.isArray(args[0]) ? args[0][0] : (args[0] as { cmd?: string[] })?.cmd?.[0]
  if (gitOk(cmd)) return (bunSpawn as (...a: unknown[]) => unknown)(...args)
  note('Bun.spawn'); throw new Error('process start refused by the benchmark guard')
}
;(Bun as unknown as Record<string, unknown>).spawnSync = (...args: unknown[]) => {
  const cmd = Array.isArray(args[0]) ? args[0][0] : (args[0] as { cmd?: string[] })?.cmd?.[0]
  if (gitOk(cmd)) return (bunSpawnSync as (...a: unknown[]) => unknown)(...args)
  note('Bun.spawnSync'); throw new Error('process start refused by the benchmark guard')
}

// the real-copy phase: whatever the production code writes to the console (a migration's warning can name rows) goes
// nowhere, from before the first module loads; only the count per level is kept
const silenced: Record<string, number> = {}
;(globalThis as Record<string, unknown>).__perfSilenced = silenced
if (process.env.PERF_SILENCE_CONSOLE === '1') {
  for (const level of ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'table'] as const) {
    (console as unknown as Record<string, unknown>)[level] = () => { silenced[level] = (silenced[level] ?? 0) + 1 }
  }
}

process.on('exit', () => {
  process.stderr.write(`guard: refused ${JSON.stringify(refused)}\n`)
})
