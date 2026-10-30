import { Fragment, memo, type ReactNode } from 'react'
import { MENTION_TOOLS, type AgentMention, type ToolMention } from '@oasis-code/contract'
import { mentionLabel, segments, type Mention } from '../state/entities'
import { CHATGPT_WEB_ID } from '@oasis-code/contract'
import { botSrc, CHATGPT_BOT } from '../state/outline'
import { BotImage } from './BotImage'
import { useStore } from '../state/store'
import type { ModelEntry } from '../api/types'
import antigravityLogo from '../assets/logo-antigravity.png'
import claudeLogo from '../assets/logo-claude.png'
import deepseekLogo from '../assets/logo-deepseek.png'
import geminiLogo from '../assets/logo-gemini.png'
import openaiLogo from '../assets/logo-openai.png'
import computerIcon from '../assets/tool-computer.svg'

/** A file or a definition the person pointed at, drawn inline (the coding counterpart of oasis's EntityChip, see
 *  NOTICE): a file glyph or a symbol glyph, the basename (the full path on hover). */
export function EntityChip({ mention }: { mention: Mention }) {
  return (
    <span className={`entity-chip${mention.symbol ? ' symbol' : ''}`} title={`${mention.path}${mention.symbol ? `::${mention.symbol}` : ''}`} data-testid="entity-chip">
      <span className="entity-glyph" aria-hidden>{mention.symbol ? 'ƒ' : '▤'}</span>
      <span className="entity-label">{mentionLabel(mention)}</span>
    </span>
  )
}

/** The picture of an agent chip: its provider's logo (the catalogue says which provider a route runs on; a route
 *  the page does not know is read from its id). */
export function agentLogo(model: string, provider?: string | null): string | null {
  // The subscription route owns its identity, even when its underlying model is Claude or Gemini.
  if (model.startsWith('antigravity:') || provider === 'antigravity') return antigravityLogo
  const p = provider ?? model.split(':')[0] ?? ''
  if (p.startsWith('anthropic')) return claudeLogo
  if (p.startsWith('openai')) return openaiLogo
  if (p.startsWith('google') || p.startsWith('gemini')) return geminiLogo
  if (p.startsWith('deepseek')) return deepseekLogo
  return null
}

/** The picture on an agent chip: its provider's logo (ChatGPT on the web: its own mark). A participant is given its
 *  bot once it runs (state/outline.ts identityTable, by its id), which a message not yet sent cannot know. */
export function agentImage(agent: AgentMention, models: Pick<ModelEntry, 'id' | 'provider'>[]): string | null {
  if (agent.model === CHATGPT_WEB_ID) return botSrc(CHATGPT_BOT)
  return agentLogo(agent.model, models.find((m) => m.id === agent.model)?.provider)
}

/** An agent named with @ (a rounded chip, after ChatGPT's): its provider's logo and the name the person saw; the route
 *  and the participant's id on hover. */
export function AgentChip({ agent }: { agent: AgentMention }) {
  const models = useStore((s) => s.models)
  const logo = agentImage(agent, models)
  return (
    <span className="agent-chip" title={agent.alias ? `${agent.model} · ${agent.alias}` : agent.model} data-agent={agent.model} data-label={agent.label} data-alias={agent.alias ?? undefined} data-testid="agent-chip">
      {logo && (agent.model === CHATGPT_WEB_ID ? <BotImage bot={CHATGPT_BOT} size={14} /> : <img src={logo} alt="" width={14} height={14} draggable={false} />)}
      <span className="agent-chip-label">{agent.label}</span>
    </span>
  )
}

const TOOL_ICONS: Record<string, string> = { computer: computerIcon }

/** The picture of a tool chip (null: a tool this page has no picture for). */
export function toolIcon(tool: string): string | null {
  return TOOL_ICONS[tool] ?? null
}

/** What a tool chip says on hover: the agent tools it stands for (a tool this page does not know: its id). */
export function toolTitle(tool: string): string {
  const known = Object.entries(MENTION_TOOLS).find(([id]) => id === tool)?.[1]
  return known ? `The agent is asked to use ${known.tools.join(' and ')}` : tool
}

/** A tool named with @ (a chip like an agent's): its picture and the name the person saw. */
export function ToolChip({ tool }: { tool: ToolMention }) {
  const icon = toolIcon(tool.tool)
  return (
    <span className="agent-chip tool-chip" title={toolTitle(tool.tool)} data-tool={tool.tool} data-label={tool.label} data-testid="tool-chip">
      {icon && <img src={icon} alt="" width={14} height={14} draggable={false} />}
      <span className="agent-chip-label">{tool.label}</span>
    </span>
  )
}

/** A person's words with their @mentions as chips (the same words are not parsed again on every render of the thread). */
export const WithEntities = memo(function WithEntities({ text }: { text: string }): ReactNode {
  return <>{segments(text).map((s, i) => {
    if ('mention' in s) return <EntityChip key={i} mention={s.mention} />
    if ('agent' in s) return <AgentChip key={i} agent={s.agent} />
    if ('tool' in s) return <ToolChip key={i} tool={s.tool} />
    return <Fragment key={i}>{s.text}</Fragment>
  })}</>
})
