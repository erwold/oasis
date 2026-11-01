/** Synthetic, pure data only: no app/DB/files/network or real conversation samples. */
import { requestLimitsFor } from '@oasis-code/contract'
import type { ContextReportInput } from '../src/agent/context_report_compute.ts'
import { modelRequest, modelResponse, textPart, toolCallPart, toolReturn, userPrompt, type ModelMessage } from '../src/llm/messages.ts'

export function reportInput(patch: Partial<ContextReportInput> = {}): ContextReportInput {
  const rows = [
    { name: 'alpha', description: '工具 α', input_schema: { type: 'object', properties: { text: { type: 'string' } } } },
    { name: 'beta', description: 'second tool', input_schema: { type: 'object', properties: {} } },
  ]
  return {
    sessionId: 'session-synthetic', modelId: 'openai:synthetic', route: { id: 'openai:synthetic', provider: 'openai', capabilities: { images: true, pdf: true } },
    fileLimits: requestLimitsFor({ protocol: 'openai', url: 'https://api.openai.com/v1' }),
    resolved: { window: 120_000, source: 'configured (synthetic)', known: true }, reserve: 16_000,
    seed: { anchor: null, trigger: null }, runModel: 'openai:synthetic', lastRun: null, historyJson: null,
    text: 'Synthetic instructions, sent once. 中文🙂', names: rows.map((r) => r.name), payloads: rows.map((r) => JSON.stringify(r)),
    schemaEstimateText: JSON.stringify(rows), installedLabel: null, ...patch,
  }
}

export function reportMessages(): ModelMessage[] {
  return [
    modelRequest([userPrompt('hello 中文🙂 ' + 'x'.repeat(129) + '\n' + 'a '.repeat(2010))], 'repeated stored instructions'),
    modelResponse([toolCallPart('alpha', { text: 'arguments' }, 'call-1')]),
    modelRequest([toolReturn('alpha', { stdout: 'result', lines: ['one', 'two'] }, 'call-1')], 'repeated stored instructions'),
    modelResponse([textPart('done')]),
  ]
}

export function attachmentMessages(): ModelMessage[] {
  const image = { kind: 'image' as const, asset_id: 'image-fixture', media_type: 'image/png' as const, bytes: 42, sha256: 'b'.repeat(64), width: 1, height: 1, name: 'pixel.png' }
  return [modelRequest([userPrompt([
    'files and images', image,
    { kind: 'file', asset_id: 'text-fixture', name: 'note.txt', bytes: 800, sha256: 'a'.repeat(64), media_type: 'text/plain', file_kind: 'text', representation: 'utf8-v1' },
    { kind: 'file', asset_id: 'legacy-fixture', name: 'legacy.pdf', bytes: 256_001, sha256: 'c'.repeat(64), media_type: 'application/pdf', file_kind: 'pdf', representation: 'native-v1' },
    { kind: 'file', asset_id: 'ref-fixture', name: 'reference.pdf', bytes: 300_000, sha256: null, media_type: 'application/pdf', file_kind: 'pdf', representation: 'ref-v1', origin: 'local', location: '/synthetic/reference.pdf' },
    { kind: 'file', asset_id: 'oversized-ref-fixture', name: 'large.pdf', bytes: 5_000_000_000, sha256: null, media_type: 'application/pdf', file_kind: 'pdf', representation: 'ref-v1', origin: 'local', location: '/synthetic/large.pdf' },
  ])]), modelRequest([toolReturn('alpha', { image }, 'image-return')])]
}
