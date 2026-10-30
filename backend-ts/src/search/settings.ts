/** Non-secret, machine-wide search preference. Credentials stay in auth's credential store. */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { atomicWrite, type AssetStore } from '../store.ts'

export const SEARCH_ENGINES = ['automatic', 'web', 'deepseek'] as const
export type SearchEngine = typeof SEARCH_ENGINES[number]
export interface SearchSettings { engine: SearchEngine }
const pathFor = (store: Pick<AssetStore, 'root'>) => join(dirname(store.root), 'web-search.json')
export function readSearchSettings(store: Pick<AssetStore, 'root'>): SearchSettings {
  try {
    const value = JSON.parse(readFileSync(pathFor(store), 'utf8')) as SearchSettings
    if (SEARCH_ENGINES.includes(value.engine)) return { engine: value.engine }
    throw new Error('invalid web search settings')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { engine: 'automatic' }
    // Never silently substitute a different provider for an unreadable explicit preference.
    throw new Error('Web Search settings could not be read; save them again in Settings')
  }
}
export function saveSearchSettings(store: Pick<AssetStore, 'root'>, value: SearchSettings): SearchSettings {
  if (!SEARCH_ENGINES.includes(value.engine)) throw new Error('invalid web search engine')
  const saved = { engine: value.engine }
  atomicWrite(pathFor(store), JSON.stringify(saved) + '\n', { mode: 0o600 })
  return saved
}
const selections = new WeakMap<object, SearchEngine>()
/** One selection per run; provider-frame freezing still owns an existing conversation's native tools. */
export function searchEngineForRun(deps: { store: AssetStore }): SearchEngine {
  let engine = selections.get(deps)
  if (!engine) { engine = readSearchSettings(deps.store).engine; selections.set(deps, engine) }
  return engine
}
