/** Account-gated, memory-only logical model catalog. Upstream effort variants never become duplicate UI rows. */
import { createHash } from 'node:crypto'
import { ModelConfig } from '../config.ts'
import { safeFetch } from '../safe_fetch.ts'
import type { FetchLike } from './http.ts'
import { control, isRecord } from './oauth_antigravity.ts'
import { credentialStore, tokenManager, onDefaultAuthDirChange, type OAuthCredential } from './store.ts'

export const REFERENCE = 'CLIProxyAPI 911f49cbd49f4fe2516979754a7488a3fd14fe64 internal/registry/models/models.json (protocol observation; not official or live-probed)'
export const DAILY_GEMINI_SOURCE = 'Official Antigravity client model configuration and authenticated Daily catalog observed 2026-10-19; per-effort upstream IDs; see docs/antigravity-oauth.md for wire and live evidence'
export type AntigravityEffort = 'low' | 'medium' | 'high'
export interface AntigravityModelDefinition {
  label: string
  window: number | null
  family: 'gemini' | 'claude' | 'gpt-oss'
  thinking: 'level' | 'flash-budget' | 'gpt-budget'
  defaultEffort: AntigravityEffort
  upstream: Partial<Record<AntigravityEffort, string>>
  images: boolean | 'unknown'
}
const variants = (prefix: string): Record<AntigravityEffort, string> => ({ low: prefix + '-low', medium: prefix + '-medium', high: prefix + '-high' })
/** These keys are stable public identities, including the three routes shipped before effort variants were known. */
export const SUPPORTED_MODELS: Record<string, AntigravityModelDefinition> = {
  'gemini-3.8-flash-tiered': { label: 'Gemini 3.8 Flash', window: null, family: 'gemini', thinking: 'flash-budget', defaultEffort: 'medium', upstream: variants('gemini-3.8-flash'), images: 'unknown' },
  'claude-opus-5-5-high': { label: 'Claude Opus 5.5', window: 1000000, family: 'claude', thinking: 'level', defaultEffort: 'medium', upstream: variants('claude-opus-5-5'), images: true },
  'claude-sonnet-5-5-high': { label: 'Claude Sonnet 5.5', window: 1000000, family: 'claude', thinking: 'level', defaultEffort: 'medium', upstream: variants('claude-sonnet-5-5'), images: true },
  'gemini-4-argon': { label: 'Gemini 4 Argon', window: null, family: 'gemini', thinking: 'level', defaultEffort: 'low', upstream: variants('gemini-4-argon'), images: 'unknown' },
  'gpt-oss-120b-medium': { label: 'GPT-OSS 120B', window: null, family: 'gpt-oss', thinking: 'gpt-budget', defaultEffort: 'medium', upstream: { medium: 'gpt-oss-120b-medium' }, images: 'unknown' },
}
export const ANTIGRAVITY_EFFORTS: readonly AntigravityEffort[] = ['low', 'medium', 'high']
export function resolveAntigravityModel(id: string, requested: unknown = null): { id: string; model: AntigravityModelDefinition; effort: AntigravityEffort; upstreamId: string } {
  const model = Object.hasOwn(SUPPORTED_MODELS, id) ? SUPPORTED_MODELS[id] : undefined
  if (!model) throw new Error('unsupported Antigravity text/tool model')
  const effort = requested === null || requested === undefined ? model.defaultEffort : requested
  if (typeof effort !== 'string' || !ANTIGRAVITY_EFFORTS.includes(effort as AntigravityEffort) || !Object.hasOwn(model.upstream, effort)) throw new Error('unsupported Antigravity thinking effort')
  return { id, model, effort: effort as AntigravityEffort, upstreamId: model.upstream[effort as AntigravityEffort]! }
}
export function availableAntigravityModels(models: Record<string, unknown>) {
  return Object.entries(SUPPORTED_MODELS).flatMap(([id, model]) => {
    const efforts = ANTIGRAVITY_EFFORTS.filter(e => {
      const upstream = model.upstream[e]
      return upstream !== undefined && Object.hasOwn(models, upstream) && isRecord(models[upstream])
    })
    return efforts.length ? [{ id, model, efforts, metadata: efforts.map(e => models[model.upstream[e]!] as Record<string, unknown>) }] : []
  })
}
/** Model, fixed endpoint and this authorization generation are all part of a replay's owner. No token is exposed. */
export function authorizationKey(grant: OAuthCredential): string {
  return createHash('sha256').update(JSON.stringify([grant.account_id, grant.project_id, grant.authorization_id, grant.authorized_at_ms, grant.authorization_id === null && grant.authorized_at_ms === null ? grant.refresh : null])).digest('hex')
}
export const ANTIGRAVITY_DEFAULT_OUTPUT = 8192
export const ANTIGRAVITY_LOCAL_OUTPUT_LIMIT = 65536
export const positiveCatalogCount = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
/** Local adapter ceiling and observed account ceiling are separate; neither raises the other. */
export function antigravityOutputLimit(metadata: Record<string, unknown> = {}): number {
  return Math.min(ANTIGRAVITY_LOCAL_OUTPUT_LIMIT, positiveCatalogCount(metadata.maxOutputTokens) ?? positiveCatalogCount(metadata.outputTokenLimit) ?? ANTIGRAVITY_LOCAL_OUTPUT_LIMIT)
}
const metadataWindow = (raw: Record<string, unknown>) => positiveCatalogCount(raw.maxTokens) ?? positiveCatalogCount(raw.contextWindow) ?? positiveCatalogCount(raw.inputTokenLimit)
function imageCapability(raw: Record<string, unknown>, fallback: boolean | 'unknown') {
  if (typeof raw.supportsImages === 'boolean') return raw.supportsImages
  return Array.isArray(raw.supportedInputModalities) ? raw.supportedInputModalities.some(v => typeof v === 'string' && v.toLowerCase() === 'image') : fallback
}
export function parseCatalog(data: Record<string, unknown>): ModelConfig[] {
  if (!isRecord(data.models)) throw new Error('unrecognized Antigravity model catalog')
  return availableAntigravityModels(data.models).map(({ id, model, efforts, metadata }) => {
    // A group advertises conservative shared bounds; inference rechecks the selected upstream's current metadata.
    const windows = metadata.map(raw => metadataWindow(raw) ?? model.window)
    const window = windows.every((v): v is number => v !== null) ? Math.min(...windows) : null
    const outputLimit = Math.min(...metadata.map(antigravityOutputLimit))
    const providerOutputs = metadata.map(raw => positiveCatalogCount(raw.maxOutputTokens) ?? positiveCatalogCount(raw.outputTokenLimit))
    const images = metadata.map(raw => imageCapability(raw, model.images))
    return new ModelConfig({ id: 'antigravity:' + id, provider: 'antigravity', model: id, auth: 'oauth', label: model.label,
      context_window: window, window_source: metadata.every(raw => metadataWindow(raw) !== null) ? 'Antigravity fetchAvailableModels' : model.window ? REFERENCE : DAILY_GEMINI_SOURCE,
      max_tokens: Math.min(ANTIGRAVITY_DEFAULT_OUTPUT, outputLimit), reasoning_efforts: efforts,
      capabilities: { tool_calls: true, streaming: true, thinking: metadata.every(raw => raw.supportsThinking !== false), max_output_tokens: outputLimit,
        provider_max_output_tokens: providerOutputs.every((v): v is number => v !== null) ? Math.min(...providerOutputs) : null,
        images: images.every(v => v === true) ? true : images.some(v => v === false) ? false : 'unknown' },
      capability_source: DAILY_GEMINI_SOURCE + '; available effort intersection; default ' + model.defaultEffort + '; minimum shared catalog bounds; local default output 8192; per-request selected upstream membership and cap checked; no endpoint or effort fallback',
    })
  })
}
let snapshot: { key: string; until: number; routes: ModelConfig[] } | null = null
let pending: { key: string; task: Promise<void> } | null = null
export function discoveredRoutes(): ModelConfig[] {
  let grant: OAuthCredential | null
  try { grant = credentialStore().read('antigravity') } catch { return [] }
  return grant && !grant.disabled_reason && snapshot?.key === authorizationKey(grant) ? snapshot.routes : []
}
export async function refreshCatalog(http: FetchLike = (i, o) => safeFetch(i, o)): Promise<void> {
  const store = credentialStore()
  const stored = store.read('antigravity')
  if (!stored || stored.disabled_reason) { snapshot = null; return }
  const key = authorizationKey(stored)
  if (snapshot?.key === key && snapshot.until > Date.now()) return
  if (pending?.key === key) return pending.task
  const task = (async () => {
    const grant = await tokenManager().access('antigravity')
    const data = await control(http, grant.access, 'fetchAvailableModels', { project: grant.project_id })
    const routes = parseCatalog(data)
    const current = credentialStore().read('antigravity')
    if (credentialStore() === store && current && !current.disabled_reason && authorizationKey(current) === key) snapshot = { key, until: Date.now() + 60_000, routes }
  })()
  pending = { key, task }
  try { await task } catch (error) { if (snapshot?.key === key) snapshot = null; throw error } finally { if (pending?.task === task) pending = null }
}

onDefaultAuthDirChange(() => { snapshot = null; pending = null })
