import type { ActionProposal } from '../api/types'

/** What the person reads of a permission request's parameters: each one named, the target first (a computer action's
 *  element or point, its text and keys, the look it was chosen on), long values cut where a person still reads them.
 *  An "Approve once" lets exactly these parameters through, so all of them are shown. */
export function approvalFacts(params: Record<string, unknown>): { name: string; value: string }[] {
  const shown = new Set<string>()
  const facts: { name: string; value: string }[] = []
  const add = (name: string, value: string, ...keys: string[]) => { facts.push({ name, value }); for (const k of keys) shown.add(k) }
  const has = (key: string) => params[key] !== undefined && params[key] !== null && params[key] !== ''
  if (has('surface') && has('action')) add('action', `${String(params.action)} on ${String(params.surface)}`, 'surface', 'action')
  if (has('ref')) add('element', String(params.ref), 'ref')
  if (has('x') && has('y')) add('point', `${String(params.x)},${String(params.y)}`, 'x', 'y')
  if (has('to_ref')) add('drop on', String(params.to_ref), 'to_ref')
  if (has('to_x') && has('to_y')) add('drop at', `${String(params.to_x)},${String(params.to_y)}`, 'to_x', 'to_y')
  if (has('snapshot_id')) add('look', String(params.snapshot_id), 'snapshot_id')
  for (const [key, value] of Object.entries(params)) {
    if (shown.has(key) || value === undefined || value === null) continue
    add(key, display(value))
  }
  return facts
}

function display(value: unknown, max = 300): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value)
  return typeof value === 'string' ? JSON.stringify(s.length > max ? `${s.slice(0, max)}…` : s) : s.length > max ? `${s.slice(0, max)}…` : s
}

/** A proposal as its row names it: what the call does (its label), or its tool's name for one made before labels. */
export function proposalTitle(p: Pick<ActionProposal, 'tool_name' | 'label'>): string {
  return p.label || p.tool_name
}
