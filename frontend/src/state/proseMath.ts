/** The markdown reader's plugins for words from a model or a person (components/Prose.tsx): GitHub's markdown, and
 *  math typeset by KaTeX through rehype-katex. Kept apart from the component (no stylesheet import), so node --test
 *  renders the same pipeline the page does. */

import type { Options } from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'

/** KaTeX's settings, every one written out here: Chinese inside \text{} (or anywhere) is typeset, not warned about;
 *  an unknown command shows its source in red. `trust` is never set, so KaTeX keeps its default (false): \href,
 *  \url, \includegraphics and \html… show as source, never as a link, an image or an attribute. */
export const KATEX_OPTIONS = Object.freeze({ throwOnError: false, strict: 'ignore' } as const)

// single dollars are left to `mathMarkdown`, which tells inline math from a price; the reader takes `$$` only
export const REMARK_PLUGINS: Options['remarkPlugins'] = [remarkGfm, [remarkMath, { singleDollarTextMath: false }]]
export const REHYPE_PLUGINS: Options['rehypePlugins'] = [[rehypeKatex, KATEX_OPTIONS]]
