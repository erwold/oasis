/** What an opened tool row shows, from the call as its model saw it (GET /api/runs/:id/calls/:call): a file read
 *  as numbered lines, a folder as its entries, a write or an edit as its change, a command as its output, a search
 *  as its results, anything else as its JSON. Pure, so node --test reads it. */

import { ACCESS_LABELS } from '@oasis-code/contract/modes'

export type CallView =
  | { kind: 'file'; path: string; from: number; to: number; total: number | null; lines: { no: number; text: string }[] }
  | { kind: 'directory'; path: string; files: string[]; truncated: boolean }
  | { kind: 'change'; path: string; diff: string }
  | { kind: 'command'; command: string; exit: number | null; status: string; durationMs: number | null; stdout: string; stderr: string; access: CommandAccess | null }
  | { kind: 'results'; title: string; items: { title: string; url: string; snippet: string }[] }
  | { kind: 'page'; url: string; text: string }
  | { kind: 'raw' }

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {})
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null)

/** Where a command actually ran, as its result (or its execution_started) says it: requested_access and
 *  effective_access (full | sandbox), access_reasons (the harness's code, detail and next step each), restrictions.
 *  `narrowed`: it ran in the sandbox where full access was asked; `restricted`: it ran on the host (full access) with a
 *  filesystem restriction chosen for it (environment host, filesystem restricted) — no sandbox. Null when the result
 *  says nothing of it (an older harness): nothing is claimed. */
export interface CommandRestrictions {
  environment: string | null; filesystem: string | null; enforced_by: string | null; write_denied: string[]; network: string | boolean | null
  timeout_s: number | null; timeout_source: string | null; output_cap_bytes: number | null
}
export interface CommandAccess {
  requested: string | null; effective: string | null; narrowed: boolean; restricted: boolean; restrictions: CommandRestrictions | null
  reasons: { code: string; detail: string; next_step: string | null }[]
}
export function accessWord(access: string | null): string { return access ? (ACCESS_LABELS as Record<string, string>)[access] ?? access : 'unknown' }
function restrictionsOf(value: unknown): CommandRestrictions | null {
  const r = rec(value)
  if (!Object.keys(r).length) return null
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  return {
    environment: str(r.environment) || null, filesystem: str(r.filesystem) || null, enforced_by: str(r.enforced_by) || null,
    write_denied: Array.isArray(r.write_denied) ? r.write_denied.filter((x): x is string => typeof x === 'string') : [],
    network: typeof r.network === 'boolean' || typeof r.network === 'string' ? r.network : null,
    timeout_s: n(r.timeout_s), timeout_source: str(r.timeout_source) || null, output_cap_bytes: n(r.output_cap_bytes),
  }
}
export function commandAccess(result: unknown): CommandAccess | null {
  const r = rec(result)
  const requested = str(r.requested_access) || null, effective = str(r.effective_access) || null
  if (!requested && !effective) return null
  const reasons = (Array.isArray(r.access_reasons) ? r.access_reasons : []).flatMap((x) => {
    const o = rec(x)
    return typeof o.code === 'string' && typeof o.detail === 'string' ? [{ code: o.code, detail: o.detail, next_step: typeof o.next_step === 'string' && o.next_step ? o.next_step : null }] : []
  })
  const restrictions = restrictionsOf(r.restrictions)
  const narrowed = !!requested && !!effective && requested !== effective
  return { requested, effective, narrowed, restricted: !narrowed && effective === 'full' && restrictions?.filesystem === 'restricted', restrictions, reasons }
}
/** The short state of a command that did not run with all it asked: where it ran (Sandbox), or Full access with its
 *  files restricted. Null when it ran as asked. */
export function commandAccessLabel(a: CommandAccess): string | null {
  if (a.narrowed) return accessWord(a.effective)
  if (a.restricted) return `${accessWord(a.effective)} · files restricted`
  return null
}
/** Its tooltip: what was asked and what ran (and what enforced a restriction), the paths denied, then each reason
 *  and how to go on. */
export function commandAccessTitle(a: CommandAccess): string {
  const x = a.restrictions
  const head = a.restricted ? `${accessWord(a.effective)} · files restricted${x?.enforced_by ? ` (${x.enforced_by})` : ''}` : `Requested ${accessWord(a.requested)} · ran in ${accessWord(a.effective)}`
  const network = x && (x.network === false || x.network === 'off' || x.network === 'denied') ? 'network off' : null
  return [head, x?.write_denied.length ? `write denied: ${x.write_denied.join(', ')}` : null, a.restricted ? network : null,
    ...a.reasons.map((r) => (r.next_step ? `${r.detail} — ${r.next_step}` : r.detail))].filter((l): l is string => !!l).join('\n')
}

/** The numbered lines of a file read (`<n>\t<line>` each); a line without its number keeps the count going. */
export function numberedLines(content: string, from = 1): { no: number; text: string }[] {
  if (!content) return []
  let next = from
  return content.split('\n').map((line) => {
    const m = /^(\d+)\t(.*)$/s.exec(line)
    const no = m ? Number(m[1]) : next
    next = no + 1
    return { no, text: m ? m[2]! : line }
  })
}

export function callView(tool: string, args: unknown, result: unknown): CallView {
  const a = rec(args), r = rec(result)
  // a call turned away (refused, blocked, deferred) or that reached nothing says so in its own words: the JSON
  if (/^refused|^blocked$|^deferred$|^unreachable$|^error$/.test(str(r.status))) return { kind: 'raw' }
  if (tool === 'read_file' && typeof r.content === 'string') {
    const from = num(r.from_line) ?? 1
    return { kind: 'file', path: str(r.path) || str(a.path), from, to: num(r.to_line) ?? from, total: num(r.total_lines), lines: numberedLines(r.content, from) }
  }
  if (tool === 'read_file' && r.kind === 'directory' && Array.isArray(r.files)) return { kind: 'directory', path: str(r.path) || '.', files: r.files.map(String), truncated: r.truncated === true }
  if ((tool === 'write_file' || tool === 'edit_file') && typeof r.diff === 'string') return { kind: 'change', path: str(r.path) || str(a.path), diff: r.diff }
  if (tool === 'bash') {
    return { kind: 'command', command: str(r.command) || str(a.command), exit: num(r.exit_code), status: str(r.status), durationMs: num(r.duration_ms), stdout: str(r.stdout), stderr: str(r.stderr), access: commandAccess(r) }
  }
  if (tool === 'web_search' && Array.isArray(r.results)) {
    return { kind: 'results', title: str(a.query) || str(r.query), items: r.results.map((x) => { const i = rec(x); return { title: str(i.title), url: str(i.url), snippet: str(i.snippet) } }) }
  }
  if (tool === 'fetch_url' && typeof r.text === 'string') return { kind: 'page', url: str(r.final_url) || str(r.url) || str(a.url), text: r.text }
  return { kind: 'raw' }
}
