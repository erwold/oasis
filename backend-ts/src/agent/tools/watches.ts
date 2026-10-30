/** The watch tool: an agent sets what it wants to be woken for — a time, a command ending, a line or a number in a
 *  command's output, the output falling silent — and ends its turn; the harness checks it and starts its
 *  conversation's next turn when it reports (see watches/service.ts). One tool: `cancel` ends a watch, and every
 *  answer lists the watches still waiting (no list or cancel tool of its own: the surface stays small). An agent sees
 *  and cancels its own conversation's watches only. The command must be one this run may read (its own, or one of
 *  its session's). */

import { METRIC_OPS, WATCH_KINDS, WATCH_STREAMS, z, type Watch } from '@oasis-code/contract'
import * as repo from '../../db/repo.ts'
import { PROMPT_TEXT, text } from '../../prompt_texts.ts'
import { ownedExecution } from './commands.ts'
import { finish, refused, type Ctx, type Payload } from './common.ts'
import { register } from './registry.ts'
import type { WatchInput } from '../watches/conditions.ts'

const NOT_HERE = 'a UI task\'s run takes no watches'

type WatchArgs = Omit<WatchInput, 'kind'> & { kind?: WatchInput['kind'] | null; note?: string | null; cancel?: string | null }

/** Whether a watch was set in this run's conversation. */
function ours(ctx: Ctx): (watch: Watch) => boolean {
  const conversationOf = ctx.deps.watches!.conversationsOf(ctx.deps.session.id)
  const mine = conversationOf(ctx.deps.run_id)
  return (watch) => watch.session_id === ctx.deps.session.id && conversationOf(watch.run_id) === mine
}

/** The watches of the conversation still waiting, as the agent reads them. */
function waiting(ctx: Ctx): { watch_id: string; summary: string; note: string; expires_at: string }[] {
  const mine = ours(ctx)
  return repo.listWatches(ctx.deps.conn, ctx.deps.session.id).filter((w) => w.status === 'active' && mine(w)).reverse()
    .map((w) => ({ watch_id: w.id, summary: w.summary, note: w.note.slice(0, 200), expires_at: w.expires_at }))
}

export async function watchTool(ctx: Ctx, args: WatchArgs): Promise<Payload> {
  const deps = ctx.deps
  if (!deps.watchable || deps.watches === null) return refused(ctx, 'watch', NOT_HERE)
  const cancel = args.cancel?.trim() || null
  if (cancel !== null) {
    if (args.kind) return refused(ctx, 'watch', 'give kind to set a watch or cancel to end one, not both')
    const watch = repo.getWatch(deps.conn, cancel)
    if (watch === null || !ours(ctx)(watch)) return refused(ctx, 'watch', `unknown watch ${cancel}`)
    const cancelled = deps.watches.cancel(watch.id, 'agent')
    const payload = { status: cancelled ? 'ok' : 'not_waiting', cancelled: watch.id, ...(cancelled ? {} : { ended: watch.ended_reason ?? watch.status }), waiting: waiting(ctx) }
    return finish(ctx, 'watch', payload, { summary: cancelled ? `cancelled ${watch.id}` : `${watch.id} was not waiting`, watch_id: watch.id })
  }
  if (!args.kind) return refused(ctx, 'watch', 'kind is required to set a watch (or cancel to end one)')
  const xid = args.execution_id?.trim() || null
  if (xid !== null && ownedExecution(deps, xid) === null) return refused(ctx, 'watch', `unknown command ${xid}`)
  const { note, ...rest } = args
  const out = deps.watches.register({ session_id: deps.session.id, run_id: deps.run_id, note: note ?? '', input: { ...rest, kind: args.kind } })
  if ('error' in out) return refused(ctx, 'watch', out.error)
  deps.emit('watch_set', { tool_call_id: ctx.tool_call_id, watch_id: out.id, summary: out.summary, expires_at: out.expires_at })
  const payload = {
    status: 'ok', watch_id: out.id, summary: out.summary, expires_at: out.expires_at, repeat: out.repeat, max_fires: out.max_fires,
    message: text('watch.set', { watch_id: out.id, summary: out.summary, expires_at: out.expires_at }), waiting: waiting(ctx),
  }
  return finish(ctx, 'watch', payload, { summary: `watch ${out.id}: ${out.summary}`.slice(0, 200), watch_id: out.id })
}

const opt = <T extends z.ZodType>(t: T, key: keyof typeof PROMPT_TEXT) => t.nullable().default(null).describe(PROMPT_TEXT[key])

register({
  name: 'watch', effect: 'state_change', action: null, renderer: 'generic', summary: 'be woken when a time comes or a command reports',
  description: PROMPT_TEXT['tool.watch'],
  schema: z.object({
    kind: opt(z.enum(WATCH_KINDS), 'parameter.watch.kind'),
    note: opt(z.string(), 'parameter.watch.note'),
    execution_id: opt(z.string(), 'parameter.watch.execution_id'),
    delay_s: opt(z.number(), 'parameter.watch.delay_s'),
    at: opt(z.string(), 'parameter.watch.at'),
    pattern: opt(z.string(), 'parameter.watch.pattern'),
    field: opt(z.string(), 'parameter.watch.field'),
    op: opt(z.enum(METRIC_OPS), 'parameter.watch.op'),
    value: opt(z.number(), 'parameter.watch.value'),
    stream: z.enum(WATCH_STREAMS).default('both').describe(PROMPT_TEXT['parameter.watch.stream']),
    silence_s: opt(z.number(), 'parameter.watch.silence_s'),
    repeat: z.boolean().default(false).describe(PROMPT_TEXT['parameter.watch.repeat']),
    cooldown_s: opt(z.number(), 'parameter.watch.cooldown_s'),
    max_fires: opt(z.number().int(), 'parameter.watch.max_fires'),
    expires_in_s: opt(z.number(), 'parameter.watch.expires_in_s'),
    cancel: opt(z.string(), 'parameter.watch.cancel'),
  }), fn: watchTool,
})
