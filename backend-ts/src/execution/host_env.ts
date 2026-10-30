/** A Full access command: run as the user, on the host, with what the user's own login and interactive shell sets up —
 *  the shell named by SHELL (else the user's record). The startup files (zprofile / zshrc, bash_profile, config.fish…)
 *  run once, in a login and interactive shell that writes a snapshot and nothing else: the environment (PATH, conda,
 *  nvm, SSH_AUTH_SOCK…) and, for zsh and bash, the functions. Each command then runs in a plain shell (`-c`) from that
 *  environment, with those functions read first, so nothing a startup file prints — an update prompt, a greeting —
 *  reaches a command's output, and no startup file waits on a command's input. A snapshot serves the commands after it
 *  for a while, then is taken again (a startup file the user edits is read again). Aliases are not carried over.
 *
 *  The snapshot is taken only when a Full access command is starting (a gate's approval included), never before: a
 *  plan, a proposal not yet approved or a sandboxed session read no startup file. The snapshot shell has its own
 *  process group, no input and a deadline; whatever it started is stopped with it. A command under restrictions (the
 *  network off, read-only paths) takes no snapshot outside them: it uses a fresh one, else runs in the login and
 *  interactive shell itself inside its restrictions, as before. A snapshot that cannot be taken leaves the command to
 *  run that way too (`-l -i -c`); each command's record says which (shell_start: snapshot | login).
 *
 *  The environment the shells start from is the backend's own (the user's HOME, TMPDIR, SHELL, SSH_AUTH_SOCK, as the
 *  desktop app or the terminal started it), less exactly what belongs to the harness: its access tokens and the keys
 *  it copied from Accounts into its own environment. No other variable of the user's is removed. Nothing here logs an
 *  environment. A shell this build cannot run as a login and interactive shell is refused — the command does not run;
 *  there is no fallback to another environment. */

import { spawn } from 'node:child_process'
import { accessSync, constants as fsConstants, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { userInfo } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import { harnessExportedKeyNames } from '../auth/keys.ts'

/** The harness's own control credentials: never handed to a command. */
export const HARNESS_CONTROL_VARIABLES = ['OASIS_CODE_SESSION_TOKEN', 'OASIS_CODE_DIRECTOR_TOKEN'] as const

/** The shells a Full access command runs in, each taking `-l -i -c <command>` (login, interactive, the command). */
export const LOGIN_SHELLS: ReadonlySet<string> = new Set(['zsh', 'bash', 'fish', 'ksh', 'mksh', 'sh', 'dash'])

/** A Full access command that cannot run as the user's login shell would run it: nothing ran. */
export class HostShellRefused extends Error {
  constructor(message: string) { super(message); this.name = 'HostShellRefused' }
}

/** The user's login shell: SHELL of the environment, else the user's record; an absolute path to an executable file
 *  of a shell in LOGIN_SHELLS, or refused. */
export function loginShellOf(env: Record<string, string | undefined>, record: () => string | null = () => { try { return userInfo().shell } catch { return null } }): string {
  const known = [...LOGIN_SHELLS].join(', ')
  // how to go on, the same for every refusal here: a shell of the list, or the sandbox (its commands run in /bin/sh)
  const next = `To go on: make the account's login shell (chsh -s <path>), or SHELL in the environment oasis-code starts with, the absolute path of one of ${known}; or switch the session to Sandbox access in oasis-code, where commands run in /bin/sh.`
  const shell = (env.SHELL ?? '').trim() || record() || ''
  if (!shell) throw new HostShellRefused(`Full access runs a command in the user's login shell, and none is named (SHELL is not set and the user record has none); nothing ran. ${next}`)
  if (!isAbsolute(shell)) throw new HostShellRefused(`Full access needs the login shell as an absolute path; SHELL is ${JSON.stringify(shell)}; nothing ran. ${next}`)
  const name = basename(shell)
  if (!LOGIN_SHELLS.has(name)) throw new HostShellRefused(`Full access runs commands in a login shell this build knows (${known}); ${shell} is not one; nothing ran. ${next}`)
  try {
    if (!statSync(shell).isFile()) throw new Error('not a file')
    accessSync(shell, fsConstants.X_OK)
  } catch {
    throw new HostShellRefused(`the login shell ${shell} is not an executable file; nothing ran. ${next}`)
  }
  return shell
}

/** The argv of a Full access command: the user's shell as a login and interactive shell, running the command. */
export function loginShellArgv(shell: string, command: string): string[] {
  return [shell, '-l', '-i', '-c', command]
}

/** The environment a Full access command's shell starts from: the host's, less the harness's control credentials, the
 *  keys it exported from Accounts, and the working-directory variables of the backend's own process (the shell sets
 *  its own); plus `extra` (the execution id every command carries). */
export function hostCommandEnv(host: Record<string, string | undefined>, extra: Record<string, string>, exported: readonly string[] = harnessExportedKeyNames()): Record<string, string> {
  const drop = new Set<string>([...HARNESS_CONTROL_VARIABLES, ...exported, 'PWD', 'OLDPWD'])
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(host)) {
    if (value === undefined || drop.has(name)) continue
    env[name] = value
  }
  return { ...env, ...extra }
}


// ---- the login shell's snapshot -------------------------------------------------------------------------------------

/** What the user's login and interactive shell set up, written by it once: its environment, and (zsh, bash) a script of
 *  its functions that a plain shell reads before each command. Aliases are left out: they are the person's shorthand at a
 *  prompt (ls as eza, cat as bat) and change what an agent's commands print and accept. */
export interface LoginSnapshot { shell: string; env: Record<string, string>; script: string | null; taken_at: number }

/** How long a snapshot serves before the startup files are read again. */
export const SNAPSHOT_TTL_MS = 10 * 60_000
/** How long the snapshot shell may take before it is stopped (and the command runs as before). */
export const SNAPSHOT_DEADLINE_MS = 15_000

/** Variables the snapshot shell sets for itself, never handed on: its working folder, its depth, its last argument and
 *  the paths it wrote to. */
const SHELL_OWN = ['PWD', 'OLDPWD', 'SHLVL', '_', 'OASIS_CODE_SNAPSHOT_ENV', 'OASIS_CODE_SNAPSHOT_SCRIPT']

/** The commands the snapshot shell runs: the environment as NUL-separated pairs, and for zsh and bash the functions
 *  as a script (never the aliases). Everything goes to the two files; what the shell prints is never read. */
export function snapshotScript(shell: string): string {
  const env = 'env -0 > "$OASIS_CODE_SNAPSHOT_ENV"'
  switch (basename(shell)) {
    case 'zsh': return `${env}; typeset -f > "$OASIS_CODE_SNAPSHOT_SCRIPT" 2>/dev/null`
    case 'bash': return `${env}; declare -f > "$OASIS_CODE_SNAPSHOT_SCRIPT" 2>/dev/null`
    default: return env
  }
}

/** The pairs `env -0` wrote, less the snapshot shell's own variables. */
export function parseSnapshotEnv(raw: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const pair of raw.split('\0')) {
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    const name = pair.slice(0, eq)
    if (!SHELL_OWN.includes(name)) env[name] = pair.slice(eq + 1)
  }
  return env
}

const quoted = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`

/** The argv of a Full access command from a snapshot: a plain shell (`-c`, no startup file of the user's beyond what
 *  the shell always reads, zshenv), the functions read first, then the command. */
export function snapshotArgv(snapshot: LoginSnapshot, command: string): string[] {
  if (snapshot.script === null) return [snapshot.shell, '-c', command]
  return [snapshot.shell, '-c', `. ${quoted(snapshot.script)} 2>/dev/null\n${command}`]
}

/** The environment a command from a snapshot runs with: the snapshot's, less what belongs to the harness (as
 *  hostCommandEnv), plus `extra`. */
export function snapshotCommandEnv(snapshot: LoginSnapshot, extra: Record<string, string>, exported: readonly string[] = harnessExportedKeyNames()): Record<string, string> {
  return hostCommandEnv(snapshot.env, extra, exported)
}

/** Take a snapshot: the login and interactive shell, from `env`, writing into a folder of its own under `dir`; its
 *  own process group, no input, its output discarded, stopped (with what it started) at the deadline. `wrap` puts the
 *  argv inside the restrictions of the command it is for. Null when no environment came of it. */
export async function takeLoginSnapshot(shell: string, env: Record<string, string>, dir: string, opts: { wrap?: (argv: string[]) => string[]; deadline_ms?: number; now?: () => number } = {}): Promise<LoginSnapshot | null> {
  const folder = mkdtempSync(join(dir, 'login-snapshot-'))
  const envFile = join(folder, 'env'), scriptFile = join(folder, 'script.sh')
  const argv = (opts.wrap ?? ((a: string[]) => a))(loginShellArgv(shell, snapshotScript(shell)))
  try {
    const exit = await new Promise<number | null>((resolve) => {
      let child
      try {
        child = spawn(argv[0]!, argv.slice(1), { cwd: env.HOME || undefined, env: { ...env, OASIS_CODE_SNAPSHOT_ENV: envFile, OASIS_CODE_SNAPSHOT_SCRIPT: scriptFile }, stdio: ['ignore', 'ignore', 'ignore'], detached: true })
      } catch { resolve(null); return }
      const stopGroup = () => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL') } catch { /* gone */ } }
      const timer = setTimeout(() => { stopGroup(); resolve(null) }, opts.deadline_ms ?? SNAPSHOT_DEADLINE_MS)
      child.once('error', () => { clearTimeout(timer); resolve(null) })
      child.once('exit', (code) => { clearTimeout(timer); stopGroup(); resolve(code) })
    })
    if (exit !== 0) return null
    const parsed = parseSnapshotEnv(readFileSync(envFile, 'utf8'))
    if (!Object.keys(parsed).length) return null
    let script: string | null = null
    if (basename(shell) === 'zsh' || basename(shell) === 'bash') {
      // kept beside the commands that read it: the folder lives as long as the snapshot (dropSnapshot)
      try { script = statSync(scriptFile).isFile() ? scriptFile : null } catch { script = null }
    }
    return { shell, env: parsed, script, taken_at: (opts.now ?? Date.now)() }
  } catch {
    return null
  } finally {
    // the environment file is read into memory at once; only the script stays, for the commands that read it
    try { rmSync(envFile, { force: true }) } catch { /* gone */ }
  }
}

/** A snapshot no longer used: its script removed with its folder. */
export function dropSnapshot(snapshot: LoginSnapshot | null): void {
  if (snapshot?.script) { try { rmSync(join(snapshot.script, '..'), { recursive: true, force: true }) } catch { /* gone */ } }
}
