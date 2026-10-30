/** A turn's footer (carried from oasis state/turns.ts, see NOTICE): what the run cost in requests, tool calls and
 *  tokens, how much of its input the provider served from the prompt cache, and money — unknown is a word. */

import { CONNECTOR_SPAWNER } from '@oasis-code/contract'
import type { Receipt, Run } from '../api/types'
import { costText, formatTokens, uncountedNote, uncountedRequests, type ThreadEntry } from './thread.ts'

/** The share of the run's input the provider read from its cache, 0..1 (null when nothing was cached or nothing sent). */
export function cachedShare(usage: Record<string, number | null | undefined>): number | null {
  const input = Number(usage.input_tokens ?? 0)
  const cached = Number(usage.cache_read_tokens ?? 0)
  return input > 0 && cached > 0 ? Math.min(1, cached / input) : null
}

/** What the prompt cache did for the run, in words: the share read from it ("75% cached"); none read but some
 *  written ("0% cached, 75k written to cache": the cache had expired — Anthropic's lives 5 minutes — or the prefix
 *  changed, and the next request reads it); null when the provider reported no cache at all. */
export function cacheNote(usage: Record<string, number | null | undefined>): string | null {
  const share = cachedShare(usage)
  if (share !== null) return `${Math.round(share * 100)}% cached`
  const written = Number(usage.cache_write_tokens ?? 0)
  return Number(usage.input_tokens ?? 0) > 0 && written > 0 ? `0% cached, ${formatTokens(written)} written to cache` : null
}

/** A run's input and output tokens in words — "12k input / 800 output tokens", with the requests left uncounted —
 *  or "tokens not reported" when the provider counted none of them (unknown is never 0). */
export function tokenCountsText(usage: Record<string, unknown>): string {
  const count = (key: string) => (typeof usage[key] === 'number' ? (usage[key] as number) : null)
  const input = count('input_tokens')
  const output = count('output_tokens')
  if (input === null && output === null) return 'tokens not reported'
  const uncounted = uncountedRequests(usage)
  const said = (n: number | null) => (n === null ? 'unknown' : formatTokens(n))
  return `${said(input)} input / ${said(output)} output tokens${uncounted > 0 ? ` (${uncountedNote(uncounted, count('requests'))})` : ''}`
}

/** The run's context at its last request, as the provider counted it (the harness's context anchor; an outline row
 *  carries it as context_tokens), or null when the run recorded none. */
export function contextTokens(usage: Record<string, unknown>): number | null {
  const anchor = usage.context_anchor
  const tokens = anchor !== null && typeof anchor === 'object' ? (anchor as Record<string, unknown>).input_tokens : usage.context_tokens
  return typeof tokens === 'number' && tokens > 0 ? tokens : null
}

/** The footer: requests, tools, the context the run stood at of the model's window (`context`: what the provider
 *  counted at its last request; a run that recorded none reads its summed input instead) and how much of the input
 *  was read from the cache, output, money. */
export function turnFooter(receipt: Receipt, context: { tokens: number | null; window: number | null } = { tokens: null, window: null }): string {
  const m = receipt.mechanical
  const input = Number(m.usage.input_tokens ?? 0)
  const cached = cacheNote(m.usage)
  // a route that reports no count (ChatGPT on the web) says so, never 0 in / 0 out
  const counted = typeof m.usage.input_tokens === 'number' || typeof m.usage.output_tokens === 'number'
  // totals over the counted requests only: a run partly counted says how many were not, so its totals do not read as whole
  const uncounted = uncountedRequests(m.usage)
  const out = `${formatTokens(Number(m.usage.output_tokens ?? 0))} out${uncounted > 0 ? ` (${uncountedNote(uncounted, m.requests)})` : ''}`
  const parts = [`${m.requests} request${m.requests === 1 ? '' : 's'}`, `${m.tool_calls} tool${m.tool_calls === 1 ? '' : 's'}`,
    !counted ? 'tokens not reported'
      : context.tokens !== null ? `context ${formatTokens(context.tokens)}${context.window ? ` / ${formatTokens(context.window)}` : ''}${cached !== null ? ` (${cached})` : ''} · ${out}`
      : `${formatTokens(input)} in${cached !== null ? ` (${cached})` : ''} / ${out}`]
  parts.push(`cost ${costText(m, m.cost_status, m.cost_source, { uncounted, requests: m.requests })}`)
  return parts.join(' · ')
}

/** A run's receipt once it has one (a live run carries an empty object). */
export function receiptOf(run: Pick<Run, 'receipt'>): Receipt | null {
  return 'mechanical' in run.receipt ? (run.receipt as Receipt) : null
}

export type TurnPart = { kind: 'work'; entries: ThreadEntry[] } | { kind: 'agent'; entry: ThreadEntry } | { kind: 'ui'; entry: ThreadEntry } | { kind: 'input'; entry: ThreadEntry }
  | { kind: 'steer'; entry: ThreadEntry }

/** The steers of a run still queued: they stand at the run's tail (under its work, over its live line), not in its flow. */
export function queuedSteers(entries: ThreadEntry[]): ThreadEntry[] {
  return entries.filter((e) => e.kind === 'user' && e.steer?.status === 'queued')
}

/** A turn as it happened: each stretch of work between the agent's words its own group, the words where they were
 *  said — a word said between tool calls stands between them, and the calls after it come after it. A surface the
 *  agent presented stands as its own block where it was first presented, like its words: never folded into the work;
 *  so does a form the run waits on (request_input). */
export function turnParts(entries: ThreadEntry[]): TurnPart[] {
  const parts: TurnPart[] = []
  for (const entry of entries) {
    const last = parts[parts.length - 1]
    // words the person sent while the run worked: where they went into a request (or where the run ended without them);
    // a queued one waits at the tail (queuedSteers)
    if (entry.kind === 'user') { if (entry.steer && entry.steer.status !== 'queued') parts.push({ kind: 'steer', entry }); continue }
    if (entry.kind === 'agent') parts.push({ kind: 'agent', entry })
    else if (entry.kind === 'ui') parts.push({ kind: 'ui', entry })
    else if (entry.kind === 'input') parts.push({ kind: 'input', entry })
    else if (last?.kind === 'work') last.entries.push(entry)
    else parts.push({ kind: 'work', entries: [entry] })
  }
  return parts
}

/** The MCP client a run came through (ChatGPT, say: the connector names it in the run's label), or null for the
 *  person's own words. */
export function connectorOf(run: Pick<Run, 'spawned_by' | 'label'>): string | null {
  return run.spawned_by === CONNECTOR_SPAWNER ? run.label || 'MCP client' : null
}
