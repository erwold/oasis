export const WEB_SEARCH_ENGINES = ['automatic', 'web', 'deepseek'] as const
export type WebSearchEngine = typeof WEB_SEARCH_ENGINES[number]
export interface WebSearchSettings { engine: WebSearchEngine }
export const WEB_SEARCH_LABELS: Record<WebSearchEngine, string> = { automatic: 'Automatic', web: 'Web', deepseek: 'DeepSeek' }
