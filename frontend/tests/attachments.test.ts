import assert from 'node:assert/strict'
import { test } from 'node:test'
import { admit, attachmentUrl, isHeif, jpegName, LONG_PASTE_CHARS, MAX_HEIF_BYTES, MAX_IMAGES, nameOf, pastedTextFile } from '../src/state/attachments.ts'

const png = (name: string, size = 1000) => ({ name, type: 'image/png', size })

test('the composer takes PNG, JPEG and WebP up to 5 MB, at most eight, and says why it leaves the rest', () => {
  const { accepted, refused } = admit(0, [png('a.png'), { name: 'b.jpg', type: 'image/jpeg', size: 10 }, { name: 'c.webp', type: 'image/webp', size: 10 },
    { name: 'd.gif', type: 'image/gif', size: 10 }, { name: 'e.svg', type: 'image/svg+xml', size: 10 }, png('f.png', 5 * 1024 * 1024 + 1)])
  assert.deepEqual(accepted.map((f) => f.name), ['a.png', 'b.jpg', 'c.webp'])
  assert.deepEqual(refused, ['d.gif: unsupported format; attach images, UTF-8 text/code, PDF or MP4/WebM/MOV (not Office, ZIP or audio)', 'e.svg: unsupported format; attach images, UTF-8 text/code, PDF or MP4/WebM/MOV (not Office, ZIP or audio)',
    'f.png: 5.0 MiB is over the 5 MiB limit'])
  const full = admit(MAX_IMAGES - 1, [png('x.png'), png('y.png')])
  assert.deepEqual(full.accepted.map((f) => f.name), ['x.png'])
  assert.deepEqual(full.refused, [`y.png: a message carries at most ${MAX_IMAGES} attachments`])
})

test('a pasted image gets a name of its own; the read-back URL is the session route', () => {
  assert.equal(nameOf(png('shot.png'), 0), 'shot.png')
  assert.equal(nameOf(png('image.png'), 2), 'pasted-3.png')
  assert.equal(nameOf({ name: '', type: 'image/jpeg', size: 1 }, 0), 'pasted-1.jpg')
  assert.equal(attachmentUrl('s_1', 'a/2'), '/api/sessions/s_1/attachments/a%2F2')
})

test('a HEIC photo joins too (the harness makes it a JPEG): by its type, by its name when the browser gives no type, and — under a .JPG name — by its bytes', () => {
  const { accepted, refused } = admit(0, [
    { name: 'IMG_1.HEIC', type: 'image/heic', size: 10 * 1024 * 1024 },               // over 5 MB: a HEIC may be, the JPEG made of it may not
    { name: 'IMG_2.heif', type: '', size: 10 }, { name: 'IMG_3.heic', type: 'image/heic', size: MAX_HEIF_BYTES + 1 },
    { name: 'notes.txt', type: '', size: 10 }, { name: 'clip.heic.mov', type: '', size: 10 },
  ])
  assert.deepEqual(accepted.map((f) => f.name), ['IMG_1.HEIC', 'IMG_2.heif', 'notes.txt', 'clip.heic.mov'])
  assert.deepEqual(refused, ['IMG_3.heic: 30.0 MiB is over the 30 MiB limit'])
  const head = (text: string) => new Uint8Array([0, 0, 0, 32, ...new TextEncoder().encode(text)])
  assert.equal(isHeif(head('ftypheic')), true)
  assert.equal(isHeif(head('ftypmif1')), true)
  assert.equal(isHeif(head('ftypisom')), false)                                       // a video
  assert.equal(isHeif(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1])), false)   // a real JPEG
  assert.equal(isHeif(head('ftyp')), false)                                           // cut before its brand
  assert.equal(jpegName('1790788534158.JPG'), '1790788534158.JPG')                    // already says JPEG
  assert.equal(jpegName('IMG_1.HEIC'), 'IMG_1.jpg')
  assert.equal(jpegName('photo'), 'photo.jpg')
  assert.equal(jpegName('.heic'), 'photo.jpg')
})


test('files have independent bounds and route-independent admission, including empty browser MIME', () => {
  const files = ['n.md', 'script.py', 'table.csv', 'data.json', 'report.pdf', 'clip.mp4', 'clip.mov', 'clip.webm'].map((name) => ({ name, type: '', size: 1 }))
  assert.deepEqual(admit(0, files).accepted, files)
  assert.equal(admit(0, [{ name: 'a.md', type: '', size: 1024 * 1024 + 1 }]).refused.length, 1)
  // changed with the large-file references (docs/large-file-attachments-ui.md): a PDF or a video has no size bound —
  // it joins by reference; the image, text and HEIC bounds stand
  assert.equal(admit(0, [{ name: 'a.pdf', type: '', size: 20 * 1024 * 1024 + 1 }]).accepted.length, 1)
  assert.equal(admit(0, [{ name: 'a.webm', type: 'video/webm', size: 20 * 1024 * 1024 }]).accepted.length, 1)
  for (const name of ['book.docx', 'book.xlsx', 'archive.zip', 'sound.mp3']) assert.equal(admit(0, [{ name, type: '', size: 1 }]).accepted.length, 0)
})

test('preparation retries release old preview URLs, failures preserve preview, cancellation allocates none', async () => {
  const { prepareAttachment } = await import('../src/state/attachments.ts')
  const created: string[] = [], revoked: string[] = []
  const urls = { createObjectURL() { const u = `blob:${created.length}`; created.push(u); return u }, revokeObjectURL(u: string) { revoked.push(u) } }
  let file: import('../src/state/attachments.ts').PendingImage = { id: 'f', file: new File(['image'], 'a.png', { type: 'image/png' }), url: '', name: 'a.png', state: 'ready', error: null, uploaded: null }
  const convert = async () => new Blob(['converted'], { type: 'image/jpeg' })
  file = { ...file, ...await prepareAttachment(file, convert, () => true, urls) }
  for (let i = 0; i < 3; i++) { file.state = 'failed'; file = { ...file, ...await prepareAttachment(file, convert, () => true, urls) } }
  assert.equal(created.length, 4); assert.deepEqual(revoked, created.slice(0, 3))
  assert.equal(await prepareAttachment(file, convert, () => false, urls), null)
  assert.equal(created.length, 4)
  const heic = new File([new Uint8Array([0, 0, 0, 32, ...new TextEncoder().encode('ftypheic')])], 'a.heic', { type: 'image/heic' })
  await assert.rejects(prepareAttachment({ ...file, file: heic }, async () => { throw new Error('conversion failed') }, () => true, urls))
  assert.equal(revoked.length, 3)
  urls.revokeObjectURL(file.url) // removeImage's final release
  assert.deepEqual(revoked, created)
})

test('async preparation reserves order; upload retry reuses successes, cancellation cannot submit stale IDs', async () => {
  const { uploadAttachments } = await import('../src/state/attachments.ts')
  type Pending = import('../src/state/attachments.ts').PendingImage
  let files: Pending[] = ['a', 'b'].map((id) => ({ id, name: `${id}.md`, file: new File([id], `${id}.md`), url: '', state: 'ready', error: null, uploaded: null }))
  const mark = (id: string, patch: Partial<Pending>) => { files = files.map((f) => f.id === id ? { ...f, ...patch } : f) }
  const reference = (name: string): import('@oasis-code/contract').Attachment => ({ asset_id: name, name, bytes: 1, sha256: 'a'.repeat(64), media_type: 'text/plain', file_kind: 'text', representation: 'utf8-v1' })
  const uploaded: string[] = []
  await assert.rejects(uploadAttachments('s', () => files, async (_, name) => { uploaded.push(name); if (name === 'b.md') throw new Error('offline failure'); return reference(name) }, mark), /b.md/)
  assert.equal(files[0].uploaded?.attachment.asset_id, 'a.md'); assert.equal(files[1].state, 'failed')
  assert.deepEqual(await uploadAttachments('s', () => files, async (_, name) => { uploaded.push(name); return reference(name) }, mark), ['a.md', 'b.md'])
  assert.deepEqual(uploaded, ['a.md', 'b.md', 'b.md'])
  let release!: () => void
  const waiting = new Promise<void>((r) => { release = r })
  const pending = uploadAttachments('other-session', () => files, async (_, name) => { await waiting; return reference(name) }, mark)
  files = files.filter((f) => f.id !== 'b'); release()
  await assert.rejects(pending, /removed/)
})

test('all text-only destinations block the entire attachment-bearing draft; agent text files do not require images', async () => {
  const { destinationRefusal, pendingMedia } = await import('../src/state/attachments.ts')
  const { attachmentRefusal } = await import('@oasis-code/contract')
  for (const destination of ['chatgpt-director', 'participants'] as const) {
    assert.match(destinationRefusal(destination, 1)!, /entire draft is kept/)
    assert.equal(destinationRefusal(destination, 0), null)
  }
  assert.equal(destinationRefusal('agent', 8), null)
  assert.equal(destinationRefusal('native-director', 8), null)
  assert.equal(destinationRefusal('interaction-director', 8), null)
  const file = { id: 'a', name: 'n.md', file: new File(['hi'], 'n.md'), url: '', state: 'ready' as const, error: null, uploaded: null }
  assert.equal(attachmentRefusal({ images: false }, [pendingMedia(file)], 'text'), null)
})

test('a long paste becomes a text file of the message, named in order without clashing; the bound is fixed', async () => {
  assert.equal(LONG_PASTE_CHARS, 4000)
  const text = '实验'.repeat(3000)
  const first = pastedTextFile(text, [])
  assert.equal(first.name, 'pasted-text-1.txt')
  assert.equal(first.type, 'text/plain')
  assert.equal(await first.text(), text)
  assert.equal(pastedTextFile(text, [{ name: 'pasted-text-1.txt' }, { name: 'photo.png' }]).name, 'pasted-text-2.txt')
  assert.equal(pastedTextFile(text, [{ name: 'pasted-text-2.txt' }]).name, 'pasted-text-1.txt')
  const { accepted, refused } = admit(0, [first])
  assert.deepEqual([accepted.length, refused.length], [1, 0])
})
