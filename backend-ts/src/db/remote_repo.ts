/** Host-scoped persistence. No network or filesystem calls; identity_file remains an opaque path. */
import { SshConnectIntentSchema, SshTargetSchema, SshTargetInputSchema, type SshConnectIntent, type SshTarget, type SshTargetInput } from '@oasis-code/contract'
import type { Conn, Row } from './database.ts'
import { newId } from '../ids.ts'
import { nowIso } from '../timebase.ts'

function target(row: Row): SshTarget {
  const { capabilities_json, ...fields } = row
  return SshTargetSchema.parse({ ...fields, capabilities: JSON.parse(String(capabilities_json)) })
}
export function listTargets(conn: Conn): SshTarget[] {
  return conn.all('SELECT * FROM ssh_targets ORDER BY created_at,id').map(target)
}
export function getTarget(conn: Conn, id: string): SshTarget | null {
  const row = conn.get('SELECT * FROM ssh_targets WHERE id=?', [id])
  return row ? target(row) : null
}
export function createTarget(conn: Conn, input: SshTargetInput): SshTarget {
  const value = SshTargetInputSchema.parse(input)
  const id = newId('ssh')
  conn.run('INSERT INTO ssh_targets (id,label,destination,port,identity_file,created_at) VALUES (?,?,?,?,?,?)',
    [id, value.label, value.destination, value.port ?? null, value.identity_file ?? null, nowIso()])
  return getTarget(conn, id)!
}
export function updateTarget(conn: Conn, id: string, patch: Pick<SshTarget, 'state' | 'generation' | 'capabilities' | 'last_error'>): SshTarget {
  const current = getTarget(conn, id)
  if (!current) throw new Error(`SSH target not found: ${id}`)
  const value = SshTargetSchema.parse({ ...current, ...patch })
  conn.run('UPDATE ssh_targets SET state=?,generation=?,capabilities_json=?,last_error=? WHERE id=?',
    [value.state, value.generation, JSON.stringify(value.capabilities), value.last_error, id])
  return getTarget(conn, id)!
}
/** The person's Connect ('connect') or Disconnect ('disconnect'): the only writer of connect_intent. */
export function setIntent(conn: Conn, id: string, intent: SshConnectIntent): void {
  conn.run('UPDATE ssh_targets SET connect_intent=? WHERE id=?', [SshConnectIntentSchema.parse(intent), id])
}
/** The previous process's ready flag cannot prove a live connection in this one. The person's intent is not the
 *  connection's state and is left as it is: a target they left connected is dialed again (RemoteWorkspaceService). */
export function disconnectTargets(conn: Conn): void {
  conn.run("UPDATE ssh_targets SET state='disconnected' WHERE state IN ('ready','connecting')")
  conn.run("UPDATE remote_jobs SET connection_state='disconnected'")
}
