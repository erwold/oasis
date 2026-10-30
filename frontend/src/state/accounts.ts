/** Pure helpers for the Accounts page (carried from oasis frontend/src/state/accounts.ts). */

import { CHATGPT_WEB_ID } from '@oasis-code/contract'

export const ACCOUNT_LABELS: Record<string, string> = {
  'openai-codex': 'Codex (ChatGPT)',
  anthropic: 'Claude',
  antigravity: 'Antigravity',
  'anthropic-api': 'Anthropic API',
  'openai-api': 'OpenAI API',
  gemini: 'Google Gemini',
  deepseek: 'DeepSeek',
  zhipu: 'Zhipu BigModel',
  'chatgpt-web': 'ChatGPT (desktop app)',
}

export function accountLabel(account: string): string {
  if (ACCOUNT_LABELS[account]) return ACCOUNT_LABELS[account]
  return account.startsWith('env:') ? account.slice(4) : account
}

/** What a greyed model row says instead of its price: what would make it usable. */
export function unavailableHint(account: string, hint: string | null): string {
  if (hint) return hint
  return account === 'openai-codex' || account === 'anthropic' || account === 'antigravity' ? 'sign in' : 'no key'
}

/** How a saved key is shown: a short head only when the key is long enough that it gives nothing
 *  away, then the last four characters — the same rule the backend applies. */
export function maskKey(key: string): string {
  if (key.length < 8) return '••••'
  const head = key.length > 12 ? key.slice(0, 3) : ''
  return `${head}…${key.slice(-4)}`
}

/** A custom provider's id from what the person calls it: lowercase, dashes for anything else. */
export function customProviderId(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^[^a-z]+/, '').slice(0, 32)
}

/** The env name code will read a custom key from, suggested from the name: REPLICATE_API_KEY. */
export function suggestEnvName(label: string): string {
  const stem = label.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^[^A-Z]+/, '')
  return stem ? `${stem}_API_KEY`.slice(0, 64) : ''
}

/** Initials for a provider without a logo. */
export function monogram(label: string): string {
  const words = label.split(/[^A-Za-z0-9]+/).filter(Boolean)
  return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? '?').slice(0, 2)).toUpperCase()
}

export interface ModelGroup<T> { account: string; label: string; available: boolean; models: T[] }

/** Catalogue entries grouped by the account that gates them, in catalogue order. */
export function groupByAccount<T extends { account: string; credential: 'available' | 'unavailable' }>(models: T[]): ModelGroup<T>[] {
  const groups: ModelGroup<T>[] = []
  for (const model of models) {
    let group = groups.find((g) => g.account === model.account)
    if (!group) {
      group = { account: model.account, label: accountLabel(model.account), available: model.credential === 'available', models: [] }
      groups.push(group)
    }
    group.models.push(model)
    group.available = group.available || model.credential === 'available'
  }
  return groups
}

/** A context window as a chip hint: "1m context", "272k context", or "context unknown". */
export function contextLabel(window: number | null | undefined): string {
  if (window == null || !(window > 0)) return 'context unknown'
  if (window >= 1_000_000) return `${(window / 1_000_000).toFixed(window % 1_000_000 === 0 ? 0 : 1).replace(/\.0$/, '')}m context`
  return `${Math.round(window / 1000)}k context`
}

/** The thinking levels a run can be asked for (pydantic-ai's unified levels plus off); null leaves the provider's default. */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type ThinkingLevel = (typeof THINKING_LEVELS)[number]

/** The levels a model's picker offers: those its route declares (`supported_thinking`), else every level (a route
 *  that declares none takes each, mapped to its nearest). */
export function thinkingLevelsFor(supported: readonly string[] | null | undefined): ThinkingLevel[] {
  return supported?.length ? THINKING_LEVELS.filter((level) => supported.includes(level)) : [...THINKING_LEVELS]
}

/** A level as a picker's row names it: Off, Minimal … Extra high. */
export function thinkingOption(level: ThinkingLevel): string {
  return thinkingLabel(level).replace(/^Thinking:? /, '').replace(/^\w/, (c) => c.toUpperCase())
}

/** A short word for a level, where a row has little room: default, off, minimal … xhigh. */
export function thinkingWord(level: ThinkingLevel | null): string {
  return level ?? 'default'
}

/** The thinking line of a run's records: what was asked and, where the route took another level (or none), what was
 *  sent and why. `sent` is undefined on a run recorded before the records kept it; `efforts` is the route's own list
 *  from the run's model config (null: not known, so the route takes every level). Only minimal is raised for the
 *  request's tools (beside the provider's web search), and only on a route that takes minimal; any other change is
 *  the route lacking the level. */
export function thinkingRecord(asked: string | null, sent: string | null | undefined, efforts?: readonly string[] | null): string {
  if (asked === null) return "the provider's default"
  if (sent === undefined || sent === asked) return `asked for ${asked}`
  if (sent === null) return `asked for ${asked} · none sent (the model takes no thinking setting)`
  const forTools = asked === 'minimal' && (efforts == null || efforts.includes('minimal'))
  return `asked for ${asked} · sent as ${sent} (${forTools ? "the nearest the route takes with this request's tools" : 'the nearest the route takes'})`
}

/** Each participant's own effort, by its id, from the effort the person chose for its model in the @ menu; a model
 *  without one (and ChatGPT on the web, whose page keeps its own) runs at the composer's. */
export function participantThinking(participants: { id: string; model: string }[], byModel: Record<string, ThinkingLevel>): Record<string, ThinkingLevel> {
  return Object.fromEntries(participants.filter((p) => p.model !== CHATGPT_WEB_ID && byModel[p.model]).map((p) => [p.id, byModel[p.model]!]))
}

export function thinkingLabel(level: ThinkingLevel | null): string {
  if (level === null) return 'Thinking: default'
  return { off: 'Thinking off', minimal: 'Thinking: minimal', low: 'Thinking: low', medium: 'Thinking: medium', high: 'Thinking: high', xhigh: 'Thinking: extra high', max: 'Thinking: maximum' }[level]
}

/** The routes a picker offers: the ones whose credential is here (a key saved or in the environment, a sign-in),
 *  plus the one currently chosen even when its credential went away, so the chip still explains itself. ChatGPT on
 *  the web is not one of them: it is named with @ where the desktop app holds its page (`chatGptRoute`). */
export function pickerModels<T extends { id: string; credential: 'available' | 'unavailable' }>(models: T[], current: string | null): T[] {
  return models.filter((m) => m.id === current || (m.credential === 'available' && m.id !== CHATGPT_WEB_ID))
}

/** ChatGPT on the web as the @ menu offers it: its catalogue row, where the desktop app holds the page. */
export function chatGptRoute<T extends { id: string }>(models: T[], canName: boolean): T | null {
  return canName ? models.find((m) => m.id === CHATGPT_WEB_ID) ?? null : null
}
