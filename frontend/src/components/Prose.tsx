import { memo, useMemo, useState, type ComponentProps } from 'react'
import Markdown, { defaultUrlTransform, type Components } from 'react-markdown'
import 'katex/dist/katex.min.css'
import { chatGptPlacer } from '../state/desktop'
import { fileNameOf, highlightLine, languageOf, linkKind, withoutChatGptMarkers } from '../state/highlight'
import { mathMarkdown } from '../state/math'
import { REHYPE_PLUGINS, REMARK_PLUGINS } from '../state/proseMath'
import { raiseChatGptCard } from './Desk'
import { CheckIcon, CopyIcon, ImageIcon } from './icons'
import { SourceLink } from './SourceChip'
import { MediaChip, WorkspaceImage } from './Media'
import { mediaKind } from '../state/media'
import { useSharePresentation } from './ThreadPresentation'

/** Words from a model or a person, as markdown: web links as source chips, code blocks with a copy button and line
 *  numbers, tables as cards that scroll sideways, images shown, math typeset (KaTeX; a formula it cannot read shows
 *  its source), and a file in ChatGPT's own sandbox (which never reaches oasis-code) as a chip that opens the ChatGPT
 *  page, where the file is. Rendered again only when its words change: the markdown and every formula are parsed
 *  and typeset on each render, and a parent that re-renders for its own reasons (the desk on every step of a window
 *  resize) would redo that for every answer on the page — 110 ms a step on a session of 638 formulas (2026-09-29). */
export const Prose = memo(function Prose({ text }: { text: string }) {
  const source = useMemo(() => mathMarkdown(withoutChatGptMarkers(text)), [text])
  return <Markdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} urlTransform={keepSandbox} components={COMPONENTS}>{source}</Markdown>
})

// markdown's default drops every address it does not know; a sandbox file and an inline image are kept so they
// render as what they are (neither is ever fetched or followed as a link)
const keepSandbox = (url: string) => (linkKind(url) === 'sandbox' || linkKind(url) === 'inline' ? url : defaultUrlTransform(url))

const COMPONENTS: Components = {
  a: ({ node, ...props }) => {
    void node
    return <ProseLink {...props} />
  },
  img: ({ node, ...props }) => {
    void node
    return <ProseImage {...props} />
  },
  // inline code that names a picture or a clip of the working folder (how an answer often names its results)
  code: ({ node, children, ...props }) => {
    void node
    const words = typeof children === 'string' ? children : Array.isArray(children) && children.every((c) => typeof c === 'string') ? children.join('') : null
    if (words !== null && mediaKind(words) !== null) return <MediaChip path={words}><code>{words}</code></MediaChip>
    return <code {...props}>{children}</code>
  },
  // a table is a card of its own that scrolls sideways inside the answer, never the answer itself
  table: ({ node, ...props }) => {
    void node
    return <div className="prose-table" role="region" tabIndex={0} aria-label="Table"><table {...props} /></div>
  },
  pre: ({ node, children }) => {
    const code = node?.children?.[0]
    if (!code || code.type !== 'element' || code.tagName !== 'code') return <pre>{children}</pre>
    return <CodeBlock code={textOf(code).replace(/\n$/, '')} language={languageOf(code.properties?.className)} />
  },
}

/** A link in the words. In the session share's copy every link is inert (SourceLink and MediaChip say so before they
 *  draw anything that would open or load). */
function ProseLink(props: ComponentProps<'a'>) {
  const href = props.href ?? ''
  if (linkKind(href) === 'sandbox') return <SandboxFile url={href} label={props.children} />
  if (linkKind(href) === 'inline') return <span>{props.children}</span>
  if (mediaKind(href) !== null) return <MediaChip path={href}>{props.children}</MediaChip>
  return <SourceLink {...props} />
}

type HastNode = { type: string; value?: string; children?: HastNode[] }
function textOf(node: HastNode): string {
  if (node.type === 'text') return node.value ?? ''
  return (node.children ?? []).map(textOf).join('')
}

function ProseImage({ src, alt }: ComponentProps<'img'>) {
  const url = typeof src === 'string' ? src : ''
  // the share's copy loads no picture its words name — a web address, an attachment, a file of the folder, a data: URL
  // alike: the only pictures of the file are those the page re-encoded itself; an image in the words is its alt text
  const shared = useSharePresentation()
  if (shared) return <span className="prose-img-missing" title="a picture the words named; the export does not load it" data-testid="prose-img-inert">{alt || 'image'}</span>
  const kind = linkKind(url)
  if (kind === 'sandbox') return <SandboxFile url={url} label={alt} image />
  if (kind === 'web') return <a className="prose-img-link" href={url} target="_blank" rel="noreferrer noopener" title={alt || url}><img className="prose-img" src={url} alt={alt ?? ''} loading="lazy" referrerPolicy="no-referrer" /></a>
  if (kind === 'inline') return <img className="prose-img" src={url} alt={alt ?? ''} />
  if (kind === 'attachment') return <img className="prose-img" src={url} alt={alt ?? ''} title={alt ?? undefined} loading="lazy" data-testid="prose-attachment" />
  if (mediaKind(url) !== null) return <WorkspaceImage path={url} alt={alt ?? ''} />
  return alt ? <span className="prose-img-missing" title={url}>{alt}</span> : null
}

/** A file that lives in ChatGPT's sandbox: named, and (in the desktop app) one click from the ChatGPT page. */
function SandboxFile({ url, label, image = false }: { url: string; label?: React.ReactNode; image?: boolean }) {
  const name = fileNameOf(url)
  const shared = useSharePresentation()
  const onCard = !shared && !!chatGptPlacer(window as { oasisCodeDesktop?: unknown })
  const words = <>{image && <ImageIcon size={12} />}<span className="sandbox-name">{typeof label === 'string' && label ? label : name}</span><span className="sandbox-where">in ChatGPT</span></>
  const title = `${name} is a file in ChatGPT's own sandbox; it shows in the ChatGPT conversation, not here`
  return onCard
    ? <button type="button" className="sandbox-file" title={`${title} — open the ChatGPT page`} onClick={raiseChatGptCard} data-testid="sandbox-file">{words}</button>
    : <span className="sandbox-file" title={title} data-testid="sandbox-file">{words}</span>
}

/** A fenced block: its language and a copy button over line-numbered, lightly coloured code that wraps. */
export function CodeBlock({ code, language }: { code: string; language: string }) {
  const [copied, setCopied] = useState(false)
  // the share's copy acts on nothing: no clipboard
  const shared = useSharePresentation()
  const lines = code.split('\n')
  const copy = () => {
    void navigator.clipboard.writeText(code).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500) }, () => undefined)
  }
  return (
    <div className="code-block" data-testid="code-block">
      <div className="code-head">
        <span className="code-lang">{language || 'code'}</span>
        {/* the share's copy: no button, only the room the app's takes — its icon and word, never shown (the head keeps
            the app's height, the language the app's width) */}
        {shared ? <span className="code-copy share-action-space" aria-hidden="true" data-testid="share-action-space"><CopyIcon size={11} />Copy</span> : <button type="button" className={`code-copy${copied ? ' copied' : ''}`} aria-label="Copy code" onClick={copy} data-testid="code-copy">
          {copied ? <CheckIcon size={11} /> : <CopyIcon size={11} />}{copied ? 'Copied' : 'Copy'}
        </button>}
      </div>
      <div className={`code-body${lines.length > 1 ? ' numbered' : ''}`}>
        {lines.map((line, i) => (
          <div key={i} className="code-line">
            {lines.length > 1 && <span className="code-num">{i + 1}</span>}
            <code>{highlightLine(line, language).map((t, k) => t.kind === 'plain' ? <span key={k}>{t.text}</span> : <span key={k} className={`tok-${t.kind}`}>{t.text}</span>)}{line === '' ? '​' : null}</code>
          </div>
        ))}
      </div>
    </div>
  )
}
