/** A model's thinking as the thread shows it: the text as written, but the `**…**` titles some providers put in their
 *  reasoning summaries (GPT's are nothing but such titles) as titles, not asterisks. Only that — the rest of a
 *  thinking is no markdown. As in markdown, the pair hugs its words (`a ** b ** c` is no title). A title still
 *  streaming (a line that opens one, no closing `**` yet, at the very end) is a title already. */

export interface ThinkingPart { text: string; title: boolean }

const TITLE = /\*\*(?!\s)([^*\n]+?)(?<!\s)\*\*|(?<=^|\n)\*\*(?!\s)([^*\n]+)$/g

export function thinkingParts(text: string): ThinkingPart[] {
  const parts: ThinkingPart[] = []
  let at = 0
  for (const m of text.matchAll(TITLE)) {
    if (m.index > at) parts.push({ text: text.slice(at, m.index), title: false })
    parts.push({ text: m[1] ?? m[2]!, title: true })
    at = m.index + m[0].length
  }
  if (at < text.length) parts.push({ text: text.slice(at), title: false })
  return parts
}
