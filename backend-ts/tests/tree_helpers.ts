/** Shared scripts for the tests that run a thread beside an order run. */

import { expect } from 'bun:test'
import { modelResponse, textPart } from '../src/llm/messages.ts'
import type { AgentInfo, Script } from '../src/llm/scripted.ts'

export const PARENT_MODEL = 'scripted:a'
export const CHILD_MODEL = 'scripted:b'

export function childScript(text = '42 files', opts: { fail?: boolean; sleep_ms?: number } = {}): Script {
  return async () => {
    if (opts.sleep_ms) await new Promise((r) => setTimeout(r, opts.sleep_ms))
    if (opts.fail) throw new Error('the child blew up')
    return modelResponse([textPart(text)])
  }
}

export function toolNames(info: AgentInfo): string[] { return info.function_tools.map((t) => t.name).sort() }

export function rec(value: unknown): Record<string, unknown> {
  expect(value && typeof value === 'object').toBe(true)
  return value as Record<string, unknown>
}
