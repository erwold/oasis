/** A director's answer with the pictures it showed: the ChatGPT page's answer names its files in its own sandbox
 *  (`![cat](sandbox:/mnt/data/cat.png)`), which never reach oasis-code; the bridge keeps the images the page loaded
 *  for the answer, and here each such image reference is pointed at the session's copy — by file name, or, when one
 *  reference and one image are left over, at that image. Images the words never named follow the answer. Links to
 *  sandbox files stay as they are (the page shows them as a chip that opens the ChatGPT conversation). */

import type { Session } from '@oasis-code/contract'
import { attachmentUrlOf, saveAttachment, type AttachmentStore } from '../api/attachments.ts'
import { redactSecrets } from '../llm/redact.ts'

export interface KeptImage { name: string; url: string }

/** The answer's pictures as the session's attachments; one that is not an image the harness reads is left out (and
 *  said in the log). */
export function keepAnswerImages(state: AttachmentStore, session: Session, images: { name: string; bytes: Uint8Array }[], who: string): KeptImage[] {
  const kept: KeptImage[] = []
  for (const image of images) {
    try {
      const saved = saveAttachment(state, session, image.bytes, image.name)
      kept.push({ name: saved.name, url: attachmentUrlOf(session.id, saved.asset_id) })
    } catch (error) {
      console.warn(`${who}: an image of the answer was not kept (${image.name}): ${redactSecrets(error instanceof Error ? error.message : String(error))}`)
    }
  }
  return kept
}

const SANDBOX_IMAGE = /!\[([^\]]*)\]\((sandbox:[^)\s]+)\)/g

function baseName(url: string): string {
  return (url.replace(/^sandbox:/i, '').split(/[?#]/)[0] ?? '').split('/').filter(Boolean).pop()?.toLowerCase() ?? ''
}

export function withAnswerImages(text: string, images: KeptImage[]): string {
  if (!images.length) return text
  const refs = [...text.matchAll(SANDBOX_IMAGE)].map((m) => ({ whole: m[0], alt: m[1] ?? '', url: m[2]! }))
  const left = [...images]
  const target = new Map<string, KeptImage>()
  for (const ref of refs) {
    const at = left.findIndex((img) => img.name.toLowerCase() === baseName(ref.url))
    if (at >= 0) { target.set(ref.whole, left[at]!); left.splice(at, 1) }
  }
  const unmatched = refs.filter((r) => !target.has(r.whole))
  if (unmatched.length === 1 && left.length === 1) target.set(unmatched[0]!.whole, left.shift()!)
  let out = text.replace(SANDBOX_IMAGE, (whole, alt: string) => {
    const img = target.get(whole)
    return img ? `![${alt || img.name}](${img.url})` : whole
  })
  if (left.length) out = `${out.trimEnd()}\n\n${left.map((img) => `![${img.name}](${img.url})`).join('\n\n')}`
  return out
}
