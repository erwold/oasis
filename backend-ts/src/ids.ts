import { randomBytes } from 'node:crypto'

/** `<prefix>_<12 hex chars>`: the harness's own handles (p, s, ws, run, x, snap, cp, a, ap, mr, note, chk, v). */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString('hex')}`
}
