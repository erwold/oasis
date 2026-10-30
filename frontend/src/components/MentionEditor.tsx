import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, type KeyboardEvent, type ClipboardEvent, type CSSProperties } from 'react'
import { agentSegments, mentionSegments, type AgentMention, type ToolMention } from '@oasis-code/contract'
import { LONG_PASTE_CHARS } from '../state/attachments'
import { toolIcon, toolTitle } from './EntityChip'

/** The composer's words as a contenteditable (after ChatGPT's prompt bar): the text as it is, and every agent named
 *  with @ — and every tool — as a rounded chip that stands in the line — deleted as one with Backspace or Delete,
 *  typed around, moved past with the arrows. The value is one string, the chip a token in it (`@[Label](agent:id)`,
 *  `@[Label](tool:id)`), so the store's draft,
 *  the send and the thread read the same words. The DOM is the browser's while the person types (an IME composes in
 *  it undisturbed); it is rendered from the value only when the value changed elsewhere (a chip chosen, "ask again",
 *  the send that clears it). */

export interface EditorHandle {
  focus(): void
  /** the words and the caret's place in them (a chip counts as its token) */
  read(): { text: string; caret: number }
  /** put the caret at a place in the words (after the chip when it falls inside one) */
  focusAt(offset: number): void
  /** new words now — rendered and the caret placed at once, so what is typed next lands after them (a chip chosen
   *  from the menu); the change is reported as the person's own */
  replace(text: string, caret: number): void
}

export interface EditorProps {
  value: string
  onChange: (text: string) => void
  /** the caret moved or the words changed: what the @ menu tracks */
  onCaret?: (text: string, caret: number) => void
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void
  onKeyDownCapture?: (e: KeyboardEvent<HTMLDivElement>) => void
  onPasteFiles?: (files: File[]) => void
  /** words pasted beyond LONG_PASTE_CHARS: true when taken (as a file of the message); else they paste as words */
  onPasteLongText?: (text: string) => boolean
  /** the picture of an agent chip: its logo by route id (null: no picture) */
  logoFor?: (agent: AgentMention) => string | null
  placeholder?: string
  disabled?: boolean
  autoFocus?: boolean
  className?: string
  style?: CSSProperties
  testId?: string
}

const CHIP_ATTR = 'data-agent'
const ALIAS_ATTR = 'data-alias'
const TOOL_ATTR = 'data-tool'
/** any chip: an agent's or a tool's */
const CHIP_SELECTOR = `[${CHIP_ATTR}], [${TOOL_ATTR}]`

/** A chip as a DOM node (the editor's children are the browser's, not React's): the participant's bot and label; the
 *  route and the participant's id on hover. */
export function chipElement(agent: AgentMention, logo: string | null): HTMLSpanElement {
  const chip = document.createElement('span')
  chip.className = 'agent-chip'
  chip.contentEditable = 'false'
  chip.setAttribute(CHIP_ATTR, agent.model)
  chip.setAttribute('data-label', agent.label)
  if (agent.alias) chip.setAttribute(ALIAS_ATTR, agent.alias)
  chip.setAttribute('data-testid', 'agent-chip')
  chip.title = agent.alias ? `${agent.model} · ${agent.alias}` : agent.model
  if (logo) {
    const img = document.createElement('img')
    img.src = logo
    img.alt = ''
    img.width = 14
    img.height = 14
    img.draggable = false
    // ChatGPT's mark is a bot picture: whole in its box like every bot's, still (a chip names an agent, no run of it)
    if (logo.startsWith('/bots/')) { img.className = 'bot-img'; img.dataset.bot = logo.replace(/^.*\/|\.\w+$/g, ''); img.dataset.botState = 'static' }
    chip.appendChild(img)
  }
  const label = document.createElement('span')
  label.className = 'agent-chip-label'
  label.textContent = agent.label
  chip.appendChild(label)
  return chip
}

/** A tool's chip as a DOM node: its picture and label; the agent tools it stands for on hover. */
function toolChipElement(tool: ToolMention): HTMLSpanElement {
  const chip = document.createElement('span')
  chip.className = 'agent-chip tool-chip'
  chip.contentEditable = 'false'
  chip.setAttribute(TOOL_ATTR, tool.tool)
  chip.setAttribute('data-label', tool.label)
  chip.setAttribute('data-testid', 'tool-chip')
  chip.title = toolTitle(tool.tool)
  const icon = toolIcon(tool.tool)
  if (icon) {
    const img = document.createElement('img')
    img.src = icon
    img.alt = ''
    img.width = 14
    img.height = 14
    img.draggable = false
    chip.appendChild(img)
  }
  const label = document.createElement('span')
  label.className = 'agent-chip-label'
  label.textContent = tool.label
  chip.appendChild(label)
  return chip
}

const isChip = (node: Node | null | undefined): boolean => !!node && node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).matches(CHIP_SELECTOR)
const tokenOf = (chip: HTMLElement): string => {
  const tool = chip.getAttribute(TOOL_ATTR)
  if (tool !== null) return `@[${chip.getAttribute('data-label') ?? ''}](tool:${tool})`
  const alias = chip.getAttribute(ALIAS_ATTR)
  return `@[${chip.getAttribute('data-label') ?? ''}](agent:${chip.getAttribute(CHIP_ATTR) ?? ''}${alias ? `#${alias}` : ''})`
}
const BLOCKS = new Set(['DIV', 'P', 'LI'])

/** The words of the editor's DOM, and where the caret (`at`: a container and an offset) falls in them. */
function serialize(root: HTMLElement, at: { node: Node; offset: number } | null): { text: string; caret: number | null } {
  let text = ''
  let caret: number | null = null
  const last = root.lastChild
  const visit = (node: Node, parent: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const data = (node.textContent ?? '').replace(/ /g, ' ')
      if (at && at.node === node) caret = text.length + Math.min(at.offset, data.length)
      text += data
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const el = node as HTMLElement
    if (isChip(el)) {
      if (at && (at.node === el || el.contains(at.node))) caret = text.length + tokenOf(el).length
      text += tokenOf(el)
      return
    }

    if (el.tagName === 'BR') {
      if (!(node === last && parent === root)) text += '\n'
      return
    }
    if (BLOCKS.has(el.tagName) && text && !text.endsWith('\n')) text += '\n'
    const children = [...el.childNodes]
    children.forEach((child, i) => {
      if (at && at.node === el && at.offset === i) caret = text.length
      visit(child, el)
    })
    if (at && at.node === el && at.offset >= children.length) caret = text.length
  }
  const children = [...root.childNodes]
  children.forEach((child, i) => {
    if (at && at.node === root && at.offset === i) caret = text.length
    visit(child, root)
  })
  if (at && at.node === root && at.offset >= children.length) caret = text.length
  return { text, caret }
}

/** What each chip of a value shows: its picture. */
function chipLooks(value: string, logoFor: (agent: AgentMention) => string | null): { agent: AgentMention; logo: string | null }[] {
  return agentSegments(value).flatMap((piece) => ('agent' in piece ? [{ agent: piece.agent, logo: logoFor(piece.agent) }] : []))
}

/** The DOM nodes of a value: text (newlines kept, the CSS shows them) and chips. */
function nodesOf(value: string, logoFor: (agent: AgentMention) => string | null): Node[] {
  const out: Node[] = []
  const looks = chipLooks(value, logoFor)
  let k = 0
  for (const piece of mentionSegments(value)) {
    if ('agent' in piece) out.push(chipElement(piece.agent, looks[k++]!.logo))
    else if ('tool' in piece) out.push(toolChipElement(piece.tool))
    else if (piece.text) out.push(document.createTextNode(piece.text))
  }
  return out
}

/** Whether the chips on show differ from what the words make them (a picture that was not known yet when the chip
 *  was drawn: the models' list read after the words). */
function chipsStale(root: HTMLElement, text: string, logoFor: (agent: AgentMention) => string | null): boolean {
  const want = chipLooks(text, logoFor).map((l) => l.logo ?? '')
  const have = [...root.querySelectorAll<HTMLElement>(`[${CHIP_ATTR}]`)].map((c) => c.querySelector('img')?.getAttribute('src') ?? '')
  return want.length === have.length && want.some((w, i) => w !== have[i])
}

function render(root: HTMLElement, value: string, logoFor: (agent: AgentMention) => string | null): void {
  root.replaceChildren(...nodesOf(value, logoFor))
  // a value ending in a newline needs a trailing break to show the empty last line
  if (value.endsWith('\n')) root.appendChild(document.createElement('br'))
}

/** The DOM place of an offset in the words: inside a text node, or between nodes (after a chip the offset falls in). */
function positionOf(root: HTMLElement, offset: number): { node: Node; offset: number } {
  let seen = 0
  const children = [...root.childNodes]
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i]!
    if (child.nodeType === Node.TEXT_NODE) {
      const len = (child.textContent ?? '').length
      if (offset <= seen + len) return { node: child, offset: offset - seen }
      seen += len
    } else if (isChip(child)) {
      const len = tokenOf(child as HTMLElement).length
      if (offset <= seen + len) return { node: root, offset: i + 1 }
      seen += len
    } else if ((child as HTMLElement).tagName === 'BR') {
      if (offset <= seen) return { node: root, offset: i }
      seen += 1
    }
  }
  return { node: root, offset: children.length }
}

function placeCaret(root: HTMLElement, offset: number): void {
  const at = positionOf(root, offset)
  const selection = window.getSelection()
  if (!selection) return
  const range = document.createRange()
  range.setStart(at.node, at.offset)
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)
}

function selectionIn(root: HTMLElement): Range | null {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  return root.contains(range.startContainer) && root.contains(range.endContainer) ? range : null
}

export const MentionEditor = forwardRef<EditorHandle, EditorProps>(function MentionEditor(
  { value, onChange, onCaret, onKeyDown, onKeyDownCapture, onPasteFiles, onPasteLongText, logoFor, placeholder, disabled, autoFocus, className, style, testId }, ref,
) {
  const root = useRef<HTMLDivElement>(null)
  // the value the DOM last produced (or was rendered from): a prop equal to it is the person's own typing, echoed
  const shown = useRef<string | null>(null)
  const composing = useRef(false)
  const logo = logoFor ?? (() => null)

  const read = (): { text: string; caret: number } => {
    const el = root.current
    if (!el) return { text: value, caret: value.length }
    const range = selectionIn(el)
    const out = serialize(el, range ? { node: range.startContainer, offset: range.startOffset } : null)
    return { text: out.text, caret: out.caret ?? out.text.length }
  }
  const commit = () => {
    const { text, caret } = read()
    // emptied by the person (a break the browser left behind): truly empty, so the placeholder shows
    const el = root.current
    if (el && !text && el.childNodes.length && !composing.current) el.replaceChildren()
    // a chip added or taken away changes the others' places: drawn again when their bots no longer match
    if (el && !composing.current && text && el.querySelector(`[${CHIP_ATTR}]`) && chipsStale(el, text, logo)) {
      render(el, text, logo)
      placeCaret(el, caret)
    }
    shown.current = text
    if (text !== value) onChange(text)
    onCaret?.(text, caret)
  }
  const caretMoved = () => {
    const { text, caret } = read()
    onCaret?.(text, caret)
  }

  useLayoutEffect(() => {
    const el = root.current
    if (!el || value === shown.current) return
    const focused = document.activeElement === el
    render(el, value, logo)
    shown.current = value
    if (focused) placeCaret(el, value.length)
  }, [value]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (autoFocus) root.current?.focus()
  }, [autoFocus])

  useImperativeHandle(ref, () => ({
    focus: () => root.current?.focus(),
    read,
    focusAt: (offset) => {
      const el = root.current
      if (!el) return
      el.focus()
      placeCaret(el, Math.max(0, Math.min(offset, (shown.current ?? value).length)))
      caretMoved()
    },
    replace: (text, caret) => {
      const el = root.current
      if (!el) return
      render(el, text, logo)
      shown.current = text
      el.focus()
      placeCaret(el, Math.max(0, Math.min(caret, text.length)))
      if (text !== value) onChange(text)
      onCaret?.(text, caret)
    },
  }))

  /** A chip right before (Backspace) or after (Delete) a collapsed caret goes as one. */
  const chipBeside = (range: Range, side: 'before' | 'after'): HTMLElement | null => {
    const el = root.current!
    let node: Node | null = null
    if (range.startContainer.nodeType === Node.TEXT_NODE) {
      const data = range.startContainer.textContent ?? ''
      if (side === 'before' && range.startOffset === 0) node = range.startContainer.previousSibling
      else if (side === 'after' && range.startOffset === data.length) node = range.startContainer.nextSibling
    } else if (range.startContainer === el) {
      node = side === 'before' ? el.childNodes[range.startOffset - 1] ?? null : el.childNodes[range.startOffset] ?? null
    } else if (isChip(range.startContainer as Node) || (range.startContainer as HTMLElement).closest?.(CHIP_SELECTOR)) {
      // the caret landed inside a chip: the chip is the one beside
      node = (range.startContainer as HTMLElement).closest(CHIP_SELECTOR)
    }
    // an empty text node between the caret and the chip does not count
    while (node && node.nodeType === Node.TEXT_NODE && !(node.textContent ?? '').length) node = side === 'before' ? node.previousSibling : node.nextSibling
    return isChip(node) ? (node as HTMLElement) : null
  }

  const keyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const el = root.current
    if (el && !e.nativeEvent.isComposing && (e.key === 'Backspace' || e.key === 'Delete')) {
      const range = selectionIn(el)
      if (range && range.collapsed) {
        const chip = chipBeside(range, e.key === 'Backspace' ? 'before' : 'after')
        if (chip) {
          e.preventDefault()
          // the chip's own place (its token may stand twice: the same agent named again)
          const { caret } = serialize(el, { node: chip, offset: 0 })
          const before = (caret ?? tokenOf(chip).length) - tokenOf(chip).length
          chip.remove()
          el.normalize()
          placeCaret(el, Math.max(0, before))
          commit()
          return
        }
      }
    }
    if (el && e.key === 'Enter' && e.shiftKey && !e.nativeEvent.isComposing) {
      // a new line as text (the browser would open a block)
      e.preventDefault()
      insertText('\n')
      return
    }
    onKeyDown?.(e)
  }

  /** Words (chips parsed) put in place of the selection; the caret after them. */
  const insertText = (text: string) => {
    const el = root.current
    if (!el) return
    el.focus()
    const range = selectionIn(el) ?? (() => { const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); return r })()
    range.deleteContents()
    const nodes = nodesOf(text, logo)
    const fragment = document.createDocumentFragment()
    for (const node of nodes) fragment.appendChild(node)
    const lastNode = nodes[nodes.length - 1] ?? null
    range.insertNode(fragment)
    if (lastNode) {
      // at the end (inserting into a text node splits it, leaving an empty one after): a new line there needs a break
      // to show the empty line the caret goes to
      let next = lastNode.nextSibling
      while (next && next.nodeType === Node.TEXT_NODE && !(next.textContent ?? '').length) next = next.nextSibling
      if (text.endsWith('\n') && next === null) el.appendChild(document.createElement('br'))
      // the caret after the words, by its place in them (normalize merges the nodes it would be set beside)
      const parent = lastNode.parentNode!
      const { caret } = serialize(el, { node: parent, offset: [...parent.childNodes].indexOf(lastNode as ChildNode) + 1 })
      el.normalize()
      placeCaret(el, caret ?? 0)
    } else el.normalize()
    commit()
  }

  /** The selection as words (chips as their tokens): what copy and cut put on the clipboard, so a paste — here or in
   *  another composer — brings the agents back as chips, never as their names alone. */
  const selectedText = (): string | null => {
    const el = root.current
    const range = el ? selectionIn(el) : null
    if (!range || range.collapsed) return null
    const box = document.createElement('div')
    box.appendChild(range.cloneContents())
    return serialize(box, null).text
  }
  const copy = (e: ClipboardEvent<HTMLDivElement>, cut: boolean) => {
    const text = selectedText()
    if (text === null) return
    e.preventDefault()
    e.clipboardData.setData('text/plain', text)
    if (cut) {
      const el = root.current
      const range = el ? selectionIn(el) : null
      if (range) { range.deleteContents(); el!.normalize(); commit() }
    }
  }

  const paste = (e: ClipboardEvent<HTMLDivElement>) => {
    const files = [...e.clipboardData.files]
    const text = e.clipboardData.getData('text/plain')
    if (files.length) onPasteFiles?.(files)
    // a screenshot pasted is an image, not a file name as text; copied text beside it still pastes — as plain text
    e.preventDefault()
    if (text && text.length > LONG_PASTE_CHARS && onPasteLongText?.(text)) return
    if (text) insertText(text)
  }

  return (
    <div ref={root} className={`composer-editor${className ? ` ${className}` : ''}${disabled ? ' is-disabled' : ''}`} style={style}
         contentEditable={!disabled} suppressContentEditableWarning role="textbox" aria-multiline="true" aria-disabled={disabled || undefined}
         data-testid={testId} data-placeholder={placeholder ?? ''} spellCheck={false}
         onInput={commit} onKeyDown={keyDown} onKeyDownCapture={onKeyDownCapture}
         onKeyUp={(e) => { if (!['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(e.key)) caretMoved() }}
         onClick={caretMoved} onFocus={caretMoved} onPaste={paste} onCopy={(e) => copy(e, false)} onCut={(e) => copy(e, true)}
         onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false; commit() }} />
  )
})
