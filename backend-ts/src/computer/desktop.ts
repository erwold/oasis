/** The desktop app's computer (desktop/computer.js) as this process reaches it: the bridge server the app runs on the
 *  loopback, under the token it keeps in the data directory — the same address and token the ChatGPT route reads, at
 *  every call (the app may have started it on another port since). An agent's look and action go there; the app does
 *  the looking and the input, and keeps who may act on a page now. */

import { join } from 'node:path'
import { BRIDGE_TOKEN_FILE, bridgeRequest, localBridgeUrl } from '../llm/chatgpt_web.ts'
import type { FetchLike } from '../llm/http.ts'
import { safeFetch } from '../safe_fetch.ts'
import { readFileSync } from 'node:fs'

type Rec = Record<string, unknown>

/** How long one look or action may take: a navigation waits up to 15 s for its page, a wait up to 10 s, and the look
 *  after it draws and outlines the page. */
export const COMPUTER_TIMEOUT_MS = 90_000

export interface ComputerClient {
  request(path: '/computer/observe' | '/computer/act' | '/computer/release', body: Rec, signal?: AbortSignal, timeoutMs?: number): Promise<Rec>
  /** where the desktop app keeps what an agent's pages downloaded (null: nothing is taken from anywhere) */
  readonly downloadsDir: string | null
}

/** The desktop app's folder for an agent's downloads, in the data directory (desktop/bridge.js COMPUTER_DOWNLOADS). */
export const COMPUTER_DOWNLOADS = 'computer-downloads'

export function desktopComputer(dataDir: string, fetchImpl: FetchLike = (input, init) => safeFetch(input, init)): ComputerClient {
  const token = (): string | null => {
    try { return readFileSync(join(dataDir, BRIDGE_TOKEN_FILE), 'utf8').trim() || null } catch { return null }
  }
  return {
    downloadsDir: join(dataDir, COMPUTER_DOWNLOADS),
    request: (path, body, signal, timeoutMs = COMPUTER_TIMEOUT_MS) => bridgeRequest(fetchImpl, localBridgeUrl(dataDir), token(), 'POST', path, body, signal, timeoutMs),
  }
}
