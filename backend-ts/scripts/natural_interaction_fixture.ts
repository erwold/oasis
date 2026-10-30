/** Deterministic test provider scripts, not a semantic classifier and never OAuth. Used only by e2e_server/tests. */
import { ModelConfig } from '../src/config.ts'
import { isRequest, isUserPrompt, modelResponse, textPart, toolCallPart, toolReturns, userTexts, type ModelMessage } from '../src/llm/messages.ts'
import { scriptedModel } from '../src/llm/scripted.ts'

export const NATURAL_DIRECTOR = 'scripted:natural-director'
export const NATURAL_FABLE = 'anthropic:claude-fable-5-1'
export const NATURAL_SLOW = 'scripted:natural-slow'
export const GAN_BATTLE_SENTENCE = '让 Fable 5.1 在我的 research backup 目录下，根据现有实验数据，结合数学理论推导，battle 出纯 GAN 稳定训练的方法。'
export const INDEPENDENT_SENTENCE = '让多个 agent 根据现有实验数据给出独立候选，先由我选择。'
export const SLOW_SENTENCE = '让三个 agent battle，包含慢节点，先独立回答再交叉讨论。'
export const SOURCE_NAME = 'research_backup_fixture'

function turnMessages(messages: ModelMessage[]): ModelMessage[] {
  let start = 0
  for (const [i, m] of messages.entries()) if (isRequest(m) && m.parts.some(isUserPrompt)) start = i
  return messages.slice(start)
}
export function naturalFixtureRoutes() {
  const config = [
    new ModelConfig({ id: NATURAL_DIRECTOR, label: 'Scripted Natural Director', provider: 'anthropic', model: 'scripted-natural-director', api_key_env: 'OASIS_TEST_KEY_A' }),
    new ModelConfig({ id: NATURAL_FABLE, label: 'Fable 5.1 (scripted fixture, no OAuth)', provider: 'anthropic', model: 'claude-fable-5-1', auth: 'api_key', api_key_env: 'OASIS_TEST_KEY_A', context_window: 1_000_000, capabilities: { images: true, pdf: true } }),
    new ModelConfig({ id: NATURAL_SLOW, label: 'Scripted Natural Slow', provider: 'anthropic', model: 'scripted-natural-slow', api_key_env: 'OASIS_TEST_KEY_A', reasoning_efforts: ['high', 'xhigh'] }),
  ]
  const director = scriptedModel((messages: ModelMessage[]) => {
    const current = turnMessages(messages)
    const prompt = userTexts(current).join('\n')
    if (prompt.includes('interaction execution index')) return modelResponse([textPart(`NATURAL_RESULT_INDEX\n${prompt.slice(prompt.indexOf('- interaction execution index'))}`)])
    const called = toolReturns(current).find((p) => p.tool_name === 'start_interaction')
    if (called) return modelResponse([textPart(`NATURAL_DISPATCHED ${JSON.stringify(called.content)}`)])
    const independent = prompt.includes(INDEPENDENT_SENTENCE)
    const slow = prompt.includes(SLOW_SENTENCE)
    if (!independent && !slow && !prompt.includes(GAN_BATTLE_SENTENCE)) return modelResponse([textPart('NATURAL_FOLLOWUP_ACK: supplement received by director only; no participant dispatch.')])
    // the message itself is never restated: director.v2 names the turn whose stored envelope carries it (the turn's
    // context line gives its id); director.v1 names nothing and the harness binds the turn's envelope itself
    const turn = /Original message envelope of user turn (turn_[a-z0-9]+)/.exec(prompt)?.[1]
    return modelResponse([toolCallPart('start_interaction', {
      mode: independent ? 'independent' : 'discussion', cross_rounds: 1,
      participants: Array.from({ length: 3 }, (_, i) => ({ model: slow && i === 0 ? NATURAL_SLOW : NATURAL_FABLE })),
      ...(turn ? { source_turn_id: turn } : {}),
    }, '')])
  }, 'scripted-natural-director')
  const participant = (slow: boolean) => scriptedModel(async (messages, info) => {
    const prompt = userTexts(messages).join('\n')
    const current = turnMessages(messages)
    const latest = userTexts(current).join('\n')
    const me = /You are (pt_[a-z0-9]+)\./.exec(prompt)?.[1] ?? 'missing-participant'
    const cross = latest.includes('Step cross-1-')
    if (slow) await new Promise((r) => setTimeout(r, 2500))
    if (!cross && !toolReturns(current).some((p) => p.tool_name === 'read_file')) {
      return modelResponse([toolCallPart('read_file', { path: `${SOURCE_NAME}/experiment.jsonl` }, '')])
    }
    if (!cross && !JSON.stringify(toolReturns(current).find((p) => p.tool_name === 'read_file')?.content).includes('0.125')) return modelResponse([textPart('NATURAL_SOURCE_UNAVAILABLE: no successful synthetic experiment read; no research result.')])
    const peers = [...new Set([...latest.matchAll(/NATURAL_FIRST (pt_[a-z0-9]+)/g)].map((m) => m[1]))]
    return modelResponse([textPart(cross
      ? `NATURAL_CROSS ${me} thinking=${String(info.model_settings.thinking)} peers=${peers.join(',')} ${peers.length === 2 ? 'PEER_INPUT_OK' : 'PEER_INPUT_MISSING'}`
      : `NATURAL_FIRST ${me} thinking=${String(info.model_settings.thinking)} ${prompt.includes('NATURAL_FIRST') ? 'INDEPENDENCE_BROKEN' : 'INDEPENDENT_OK'} synthetic experiment seed=7. No GAN experiment was performed.`)])
  }, slow ? 'scripted-natural-slow' : 'scripted-fable', { supports_thinking: true })
  return { config, models: { [NATURAL_DIRECTOR]: director, [NATURAL_FABLE]: participant(false), [NATURAL_SLOW]: participant(true) } }
}
