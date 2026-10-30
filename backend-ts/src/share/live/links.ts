/** The live share's links (table share_links, schema v34) and their capabilities.
 *
 *  A capability is HMAC-SHA256(share key, "oasis-code live share v1" ‖ 0 ‖ link id), base64url (43 characters, 256 bits).
 *  The share key is 32 random bytes in `<data dir>/live-share-key` (0600), made the first time a link is made; it is
 *  NOT the app's session token and never derived from it. The table keeps only sha256(capability): the database alone
 *  yields no capability. The person's reveal derives it again from the key and the id — so a link can be copied again
 *  after the dialog closes or the app restarts. Trade-off, said plainly: whoever reads both the key file and the table
 *  (the data directory: which also holds the session token and every session) can derive every live link's capability;
 *  a missing or damaged key file makes every existing link un-revealable and refuses new connections with it (streams
 *  already open end only by revocation, expiry, deletion or the listener turned off), and is never replaced silently
 *  while a link is still active (keyForNewLink): the person revokes those links, then new links are made under a new
 *  key. Deleting the key file is not a revocation mechanism. */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LIVE_CAPABILITY, ShareLinkOptionsSchema, type ShareLink, type ShareLinkOptions, type ShareLinkV2 } from '@oasis-code/contract'
import type { Conn } from '../../db/database.ts'
import { atomicWrite } from '../../store.ts'

export const SHARE_KEY_FILE = 'live-share-key'
const DOMAIN = 'oasis-code live share v1\0'
/** Protocol 2 links' capabilities are derived under a domain of their own: a v2 capability never verifies as a v1 one
 *  (an older build reading a v2 row fails closed), and v1's derivation is unchanged. */
const DOMAIN_V2 = 'oasis-code live share v2\0'
export type LinkProtocol = 1 | 2

export interface LinkRow {
  id: string
  session_id: string
  label: string
  options: ShareLinkOptions
  capability_hash: string
  created_at: string
  expires_at: string
  revoked_at: string | null
  revoked_reason: 'revoked' | 'session_deleted' | null
  /** schema v35: 1 (every older link), 2 (live state v2) */
  protocol: LinkProtocol
  /** schema v35: the task a v2 link shows (fixed when it is made); null for a link of one session */
  task_root_id: string | null
}

export const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex')

export type KeyRead = { key: Buffer } | { missing: true } | { damaged: true }

/** The share key as its file holds it: the key, none (no file), or a file that is not a key (unreadable, wrong size). */
export function readShareKey(dataDir: string): KeyRead {
  const path = join(dataDir, SHARE_KEY_FILE)
  try {
    if (!existsSync(path)) return { missing: true }
    const text = readFileSync(path, 'utf8').trim()
    const key = Buffer.from(text, 'base64url')
    return /^[A-Za-z0-9_-]{43}$/.test(text) && key.length === 32 ? { key } : { damaged: true }
  } catch { return { damaged: true } }
}

/** The share key, or null (none, or damaged): what verification and reveal use. Never makes one. */
export function shareKey(dataDir: string): Buffer | null {
  const read = readShareKey(dataDir)
  return 'key' in read ? read.key : null
}

/** The key a NEW link is made under. A missing or damaged key is replaced only when no link is active anywhere
 *  (every earlier link revoked or expired): replacing it while one is active would turn that link's copy into a
 *  capability nothing matches, silently. Otherwise null — the caller refuses, and says how to recover (revoke the
 *  links that no longer work, then make a new one). */
export function keyForNewLink(dataDir: string, anyActive: () => boolean): Buffer | null {
  const read = readShareKey(dataDir)
  if ('key' in read) return read.key
  if (anyActive()) return null
  const key = randomBytes(32)
  atomicWrite(join(dataDir, SHARE_KEY_FILE), key.toString('base64url') + '\n', { mode: 0o600 })
  return key
}

/** Whether any link of any session is still active (not revoked, not expired). */
export function anyActiveLink(conn: Conn, nowIso: string): boolean {
  return conn.get('SELECT 1 AS x FROM share_links WHERE revoked_at IS NULL AND expires_at > ? LIMIT 1', [nowIso]) !== null
}

export function capabilityOf(key: Buffer, linkId: string, protocol: LinkProtocol = 1): string {
  return createHmac('sha256', key).update((protocol === 2 ? DOMAIN_V2 : DOMAIN) + linkId).digest('base64url')
}

/** True when `presented` is this link's capability (constant time). */
export function capabilityMatches(key: Buffer, linkId: string, presented: string, protocol: LinkProtocol = 1): boolean {
  if (!LIVE_CAPABILITY.test(presented)) return false
  const a = Buffer.from(capabilityOf(key, linkId, protocol))
  const b = Buffer.from(presented)
  return a.length === b.length && timingSafeEqual(a, b)
}

export const newLinkId = (): string => `sl_${randomBytes(16).toString('base64url')}`

/** Options in their one form: ids sorted, without repeats (two links with the same options share one projection). */
export function canonicalOptions(o: ShareLinkOptions): ShareLinkOptions {
  return { include_tool_details: o.include_tool_details, include_images: o.include_images, exclude_run_ids: [...new Set(o.exclude_run_ids)].sort() }
}

function rowOf(r: Record<string, unknown>): LinkRow | null {
  let options: ShareLinkOptions
  try { options = canonicalOptions(ShareLinkOptionsSchema.parse(JSON.parse(String(r.options_json)))) } catch { return null }
  const reason = r.revoked_reason === 'revoked' || r.revoked_reason === 'session_deleted' ? r.revoked_reason : r.revoked_at ? 'revoked' : null
  return {
    id: String(r.id), session_id: String(r.session_id), label: String(r.label ?? ''), options, capability_hash: String(r.capability_hash),
    created_at: String(r.created_at), expires_at: String(r.expires_at), revoked_at: r.revoked_at ? String(r.revoked_at) : null, revoked_reason: reason,
    protocol: Number(r.protocol ?? 1) === 2 ? 2 : 1, task_root_id: typeof r.task_root_id === 'string' && r.task_root_id !== '' ? r.task_root_id : null,
  }
}

export function insertLink(conn: Conn, row: LinkRow): void {
  // options_json keeps v1's three keys only (a v2 link's protocol and task are columns of their own)
  conn.run('INSERT INTO share_links (id, session_id, label, options_json, capability_hash, created_at, expires_at, revoked_at, revoked_reason, protocol, task_root_id) VALUES (?,?,?,?,?,?,?,NULL,NULL,?,?)',
    [row.id, row.session_id, row.label, JSON.stringify(row.options), row.capability_hash, row.created_at, row.expires_at, row.protocol, row.task_root_id])
}

export function getLink(conn: Conn, id: string): LinkRow | null {
  const r = conn.get('SELECT * FROM share_links WHERE id=?', [id])
  return r === null ? null : rowOf(r)
}

export function linkByHash(conn: Conn, hash: string): LinkRow | null {
  const r = conn.get('SELECT * FROM share_links WHERE capability_hash=?', [hash])
  return r === null ? null : rowOf(r)
}

export function linksOfSession(conn: Conn, sessionId: string): LinkRow[] {
  return conn.all('SELECT * FROM share_links WHERE session_id=? ORDER BY created_at DESC, rowid DESC', [sessionId]).map(rowOf).filter((r): r is LinkRow => r !== null)
}

/** Revoke one link (first revocation wins: its time and reason stay). */
export function revokeLink(conn: Conn, id: string, reason: 'revoked' | 'session_deleted', at: string): void {
  conn.run('UPDATE share_links SET revoked_at=?, revoked_reason=? WHERE id=? AND revoked_at IS NULL', [at, reason, id])
}

/** Revoke every link of ONE session (made from it, showing it alone); the ids revoked now. A task link made from it is
 *  not one: it shows its task, which outlives the session it was made from (revokeTaskLinks). */
export function revokeSessionLinks(conn: Conn, sessionId: string, reason: 'revoked' | 'session_deleted', at: string): string[] {
  const ids = conn.all('SELECT id FROM share_links WHERE session_id=? AND task_root_id IS NULL AND revoked_at IS NULL', [sessionId]).map((r) => String(r.id))
  if (ids.length) conn.run('UPDATE share_links SET revoked_at=?, revoked_reason=? WHERE session_id=? AND task_root_id IS NULL AND revoked_at IS NULL', [at, reason, sessionId])
  return ids
}

/** Revoke every link of a task (its last session deleted); the ids revoked now. */
export function revokeTaskLinks(conn: Conn, taskRootId: string, reason: 'revoked' | 'session_deleted', at: string): string[] {
  const ids = conn.all('SELECT id FROM share_links WHERE task_root_id=? AND revoked_at IS NULL', [taskRootId]).map((r) => String(r.id))
  if (ids.length) conn.run('UPDATE share_links SET revoked_at=?, revoked_reason=? WHERE task_root_id=? AND revoked_at IS NULL', [at, reason, taskRootId])
  return ids
}

/** Every link of a task (made from any of its sessions), newest first. */
export function linksOfTask(conn: Conn, taskRootId: string): LinkRow[] {
  return conn.all('SELECT * FROM share_links WHERE task_root_id=? ORDER BY created_at DESC, rowid DESC', [taskRootId]).map(rowOf).filter((r): r is LinkRow => r !== null)
}

export type LinkState = 'active' | 'expired' | 'revoked'
export function stateOf(row: LinkRow, nowMs: number): LinkState {
  if (row.revoked_at !== null) return 'revoked'
  return Date.parse(row.expires_at) <= nowMs ? 'expired' : 'active'
}

/** A link as the v2 list says it: v1's fields, its protocol, its scope, and how many of its sessions are not deleted. */
export function publicLinkV2(row: LinkRow, nowMs: number, viewers: number, members: number): ShareLinkV2 {
  return { ...publicLink(row, nowMs, viewers), protocol: row.protocol, scope: row.task_root_id === null ? 'session' : 'task', members }
}

export function publicLink(row: LinkRow, nowMs: number, viewers: number): ShareLink {
  return {
    id: row.id, session_id: row.session_id, label: row.label, options: row.options, created_at: row.created_at, expires_at: row.expires_at,
    revoked_at: row.revoked_at, revoked_reason: row.revoked_reason, state: stateOf(row, nowMs), viewers,
  }
}
