/** Signals in the OS tests go only to the fixture's own processes. A fixture publishes its pid atomically (a
 *  temporary file renamed into place) as "<pid> <nonce>", the nonce also on its command line; a pid is read only
 *  as a whole integer above 1 that is not this process, and a signal is sent only after the pid's command line
 *  (never its environment) still carries the nonce. A pid 0 or -1 — "the process group", "every process" — can
 *  never reach process.kill from here. */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { sleep } from './harness.ts'

export const newNonce = (): string => `qa${randomBytes(6).toString('hex')}`

/** Python that publishes the calling process's pid with the nonce, atomically. */
export const publishPid = (path: string, nonce: string): string =>
  `open(${JSON.stringify(path + '.tmp')}+str(os.getpid()),'w').write(str(os.getpid())+' ${nonce}\\n'); os.replace(${JSON.stringify(path + '.tmp')}+str(os.getpid()), ${JSON.stringify(path)})`

export function validPid(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number.NaN
  return Number.isInteger(n) && n > 1 && n !== process.pid ? n : null
}

/** The pid a fixture published under `path`, once whole and carrying `nonce`; null when it never came. */
export async function readPid(path: string, nonce: string, timeoutMs = 3000): Promise<number | null> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (existsSync(path)) {
      const m = /^(\d+) (\S+)\n$/.exec(readFileSync(path, 'utf8'))
      if (m && m[2] === nonce) return validPid(Number(m[1]))
    }
    await sleep(5)
  }
  return null
}

/** Whether the pid is still the fixture's process: running (not a zombie) with the nonce on its command line. */
export function ownsPid(pid: number | null, nonce: string): boolean {
  if (validPid(pid) === null) return false
  const out = spawnSync('ps', ['-o', 'stat=,command=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim()
  return out !== '' && !out.startsWith('Z') && out.includes(nonce)
}

/** SIGKILL to the fixture's own process only. */
export function killOwned(pid: number | null, nonce: string): void {
  if (pid !== null && ownsPid(pid, nonce)) { try { process.kill(pid, 'SIGKILL') } catch { /* gone meanwhile */ } }
}
