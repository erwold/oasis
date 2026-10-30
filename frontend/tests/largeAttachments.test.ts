import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AttachmentSchema, isFileRefAttachment, type Attachment, type FileRefAttachment } from '@oasis-code/contract'
import { admit, attachmentCard, attachmentUrl, errorText, fileRefOf, fileSize, MAX_IMAGES, removeWaitingFile, sendAttachment, sendWay, uploadAttachments,
  type PendingImage, type SendWays } from '../src/state/attachments.ts'
import { localAttacher } from '../src/state/desktop.ts'

const GiB = 1024 ** 3
const MiB = 1024 ** 2

const ref = (name: string, origin: 'local' | 'upload' = 'local', over: Partial<FileRefAttachment> = {}): FileRefAttachment => ({
  asset_id: `a_${name}`, name, media_type: name.endsWith('.pdf') ? 'application/pdf' : 'video/mp4', bytes: 7 * GiB,
  file_kind: name.endsWith('.pdf') ? 'pdf' : 'video', representation: 'ref-v1', origin,
  location: origin === 'local' ? `/Users/me/Movies/${name}` : `/Users/me/.oasis-code/assets/p_1/ref/a_${name}`, sha256: origin === 'local' ? null : 'b'.repeat(64), ...over,
})
const textRef = (name: string): Attachment => ({ asset_id: `a_${name}`, name, bytes: 3, sha256: 'a'.repeat(64), media_type: 'text/plain', file_kind: 'text', representation: 'utf8-v1' })

test('a PDF or a video has no size bound: it joins by reference; images, text, HEIC and the count keep theirs; other formats stay out', () => {
  const big = [{ name: 'film.mov', type: 'video/quicktime', size: 7 * GiB }, { name: 'scan.pdf', type: '', size: 900 * MiB }, { name: 'tera.webm', type: '', size: 1024 * GiB }]
  assert.deepEqual(admit(0, big).accepted.map((f) => f.name), ['film.mov', 'scan.pdf', 'tera.webm'])
  const { refused } = admit(0, [{ name: 'shot.png', type: 'image/png', size: 5 * MiB + 1 }, { name: 'n.md', type: '', size: MiB + 1 },
    { name: 'IMG.HEIC', type: 'image/heic', size: 30 * MiB + 1 }, { name: 'a.zip', type: '', size: 1 }, { name: 'a.mp3', type: 'audio/mpeg', size: 1 }])
  assert.equal(refused.length, 5)
  assert.match(refused[0]!, /over the 5 MiB limit/); assert.match(refused[1]!, /over the 1 MiB limit/); assert.match(refused[2]!, /over the 30 MiB limit/)
  const full = admit(MAX_IMAGES - 1, [{ name: 'a.mp4', type: 'video/mp4', size: 3 * GiB }, { name: 'b.mp4', type: 'video/mp4', size: 3 * GiB }])
  assert.deepEqual([full.accepted.length, full.refused.length], [1, 1])
})

test('a PDF or a video goes by reference; an image, a text, a HEIC made a JPEG go by the one-request upload as before', () => {
  for (const [name, type] of [['a.pdf', ''], ['a.pdf', 'application/pdf'], ['b.mp4', ''], ['c.mov', 'video/quicktime'], ['d.webm', 'video/webm'], ['pasted-1.mp4', 'video/mp4']]) {
    assert.equal(sendWay({ name: name!, type: type! }), 'reference', name)
  }
  for (const [name, type] of [['a.png', 'image/png'], ['IMG_1.jpg', 'image/jpeg'], ['n.md', ''], ['pasted-text-1.txt', 'text/plain'], ['a.webp', '']]) {
    assert.equal(sendWay({ name: name!, type: type! }), 'upload', name)
  }
})

/** The ways a file can go, counted: what the bridge answers, what an upload answers. */
function counted(local: ((file: File) => Promise<FileRefAttachment | null>) | null) {
  const calls = { local: [] as string[], upload: [] as string[], chunked: [] as string[] }
  const ways: SendWays = {
    local: local && (async (file) => { calls.local.push(file.name); return local(file) }),
    upload: async (_file, name) => { calls.upload.push(name); return textRef(name) },
    chunked: async (_file, name) => { calls.chunked.push(name); return ref(name, 'upload') },
  }
  return { calls, ways }
}
const pending = (name: string, type = ''): Pick<PendingImage, 'file' | 'name'> => ({ name, file: new File(['x'], name, { type }) })

test('in the desktop app a PDF or a video with a file behind it is named where it lies: nothing is uploaded, small or large', async () => {
  const { calls, ways } = counted(async (file) => ref(file.name))
  const answer = await sendAttachment(pending('clip.mp4', 'video/mp4'), ways)
  assert.equal(isFileRefAttachment(answer) && answer.origin, 'local')
  await sendAttachment(pending('tiny.pdf', 'application/pdf'), ways)            // a small one too: never uploaded first
  assert.deepEqual(calls, { local: ['clip.mp4', 'tiny.pdf'], upload: [], chunked: [] })
})

test('a File with no file behind it (null from the bridge, or a plain browser) is uploaded in chunks; images and text never ask the bridge', async () => {
  const desktop = counted(async () => null)
  await sendAttachment(pending('made.pdf', 'application/pdf'), desktop.ways)
  await sendAttachment(pending('shot.png', 'image/png'), desktop.ways)
  await sendAttachment(pending('pasted-text-1.txt', 'text/plain'), desktop.ways)
  assert.deepEqual(desktop.calls, { local: ['made.pdf'], upload: ['shot.png', 'pasted-text-1.txt'], chunked: ['made.pdf'] })
  const browser = counted(null)
  await sendAttachment(pending('clip.webm', 'video/webm'), browser.ways)
  assert.deepEqual(browser.calls, { local: [], upload: [], chunked: ['clip.webm'] })
})

test('a refusal of the desktop app is the file\'s failure, said in its words: it is never uploaded instead', async () => {
  const refusal = new Error("Error invoking remote method 'attach-local-file': Error: refused: auth.json lies in a folder the app keeps for itself")
  const { calls, ways } = counted(async () => { throw refusal })
  await assert.rejects(sendAttachment(pending('innocent.mov', 'video/quicktime'), ways), (e) => e === refusal)
  assert.deepEqual(calls, { local: ['innocent.mov'], upload: [], chunked: [] })
  // through the composer's upload: the file marked failed with the refusal as the person reads it, the send refused
  let files: PendingImage[] = [
    { id: 'a', name: 'a.png', file: new File(['png'], 'a.png', { type: 'image/png' }), url: '', state: 'ready', error: null, uploaded: null },
    { id: 'b', name: 'innocent.mov', file: new File(['x'], 'innocent.mov', { type: 'video/quicktime' }), url: '', state: 'ready', error: null, uploaded: null },
  ]
  const mark = (id: string, patch: Partial<PendingImage>) => { files = files.map((f) => f.id === id ? { ...f, ...patch } : f) }
  await assert.rejects(uploadAttachments('s_1', () => files, (_f, _n, p) => sendAttachment(p, ways), mark), /^Error: innocent\.mov: refused: auth\.json lies in a folder/)
  assert.equal(files[1]!.state, 'failed')
  assert.equal(files[1]!.error, 'refused: auth.json lies in a folder the app keeps for itself')
  assert.deepEqual(calls.chunked, [])
  assert.equal(errorText(new Error("Error invoking remote method 'x': TypeError: no File")), 'no File')
  assert.equal(errorText('plain'), 'plain')
})

test('the composer\'s files go in their order, each by its way; a retry reuses what went, references included', async () => {
  const { calls, ways } = counted(async (file) => (file.name.startsWith('made') ? null : ref(file.name)))
  let files: PendingImage[] = ['a.png', 'film.mov', 'made.pdf', 'n.md'].map((name, i) => ({ id: `f${i}`, name, file: new File(['x'], name), url: '', state: 'ready', error: null, uploaded: null }))
  const mark = (id: string, patch: Partial<PendingImage>) => { files = files.map((f) => f.id === id ? { ...f, ...patch } : f) }
  const ids = await uploadAttachments('s_1', () => files, (_f, _n, p) => sendAttachment(p, ways), mark)
  assert.deepEqual(ids, ['a_a.png', 'a_film.mov', 'a_made.pdf', 'a_n.md'])
  assert.deepEqual(calls, { local: ['film.mov', 'made.pdf'], upload: ['a.png', 'n.md'], chunked: ['made.pdf'] })
  assert.deepEqual(await uploadAttachments('s_1', () => files, (_f, _n, p) => sendAttachment(p, ways), mark), ids)
  assert.equal(calls.local.length + calls.upload.length + calls.chunked.length, 5)       // nothing again
})

test('a thread card: a local reference shows its path as attached and no download; an uploaded one and the old files download', () => {
  const where = '/Users/me/Movies/Trip 2026 — 東京/clip (final).mov'
  const local = attachmentCard(ref('clip (final).mov', 'local', { location: where, media_type: 'video/quicktime', bytes: 5 * GiB }), 's_1')
  assert.equal(local.href, null)
  assert.equal(local.location, where)                                               // exactly as the harness keeps it
  assert.equal(local.line, 'video/quicktime · 5.00 GiB · live reference, read where it lies')
  const uploaded = attachmentCard(ref('scan.pdf', 'upload'), 's_1')
  assert.equal(uploaded.href, attachmentUrl('s_1', 'a_scan.pdf'))
  assert.equal(uploaded.location, null)
  assert.match(uploaded.line, /download$/)
  assert.equal(attachmentCard(textRef('n.md'), 's_1').href, attachmentUrl('s_1', 'a_n.md'))
  assert.equal(attachmentCard({ asset_id: 'img', name: 'a.png', media_type: 'image/png', width: 1, height: 1 } as unknown as Attachment, 's_1').href, attachmentUrl('s_1', 'img'))
  assert.equal(fileSize(5 * GiB), '5.00 GiB'); assert.equal(fileSize(20 * MiB), '20.0 MiB')
})

test('a reference is the contract\'s FileRefAttachment, checked whole by its schema and its origin; the old attachments parse as before', () => {
  for (const origin of ['local', 'upload'] as const) {
    const good = ref(origin === 'local' ? 'a.mp4' : 'b.pdf', origin)
    assert.deepEqual(fileRefOf(good, origin), good)
    assert.equal(fileRefOf(good, origin === 'local' ? 'upload' : 'local'), null, 'the other origin is not taken')
    assert.deepEqual(AttachmentSchema.parse(good), good)                            // the union holds a reference
  }
  const bad: [string, unknown][] = [
    ['legacy representation', { ...ref('a.mp4'), representation: 'native-v1' }],
    ['a text kind', { ...ref('a.mp4'), file_kind: 'text' }],
    ['a relative location', { ...ref('a.mp4'), location: 'Movies/a.mp4' }],
    ['a local file with a hash', { ...ref('a.mp4'), sha256: 'b'.repeat(64) }],
    ['a PDF said to be a video', { ...ref('a.pdf'), file_kind: 'video' }],
    ['a media type that is no PDF or video', { ...ref('a.mp4'), media_type: 'text/html' }],
    ['a size that is no count', { ...ref('a.mp4'), bytes: -1 }],
    ['no asset id', { ...ref('a.mp4'), asset_id: undefined }],
    ['nothing', null], ['a string', 'ref-v1'],
  ]
  for (const [why, answer] of bad) assert.equal(fileRefOf(answer, 'local'), null, why)
  assert.equal(fileRefOf({ ...ref('a.pdf', 'upload'), sha256: null }, 'upload'), null, 'an upload without its content hash')
  // the old image, text and file JSON is no reference, and the card treats it as before
  const legacy = { asset_id: 'a_v', name: 'v.mp4', media_type: 'video/mp4', bytes: 9, sha256: 'c'.repeat(64), file_kind: 'video', representation: 'native-v1' }
  assert.deepEqual(AttachmentSchema.parse(legacy), legacy)
  assert.equal(isFileRefAttachment(legacy), false)
  assert.equal(attachmentCard(legacy as Attachment, 's_1').line, 'video/mp4 · 9 B · download')
})

test('removing a file whose upload the harness may hold: it leaves only once the harness confirms the drop; otherwise it stays, saying so, and removing again asks again', async () => {
  const transfer = { session_id: 's_1', upload_id: 'u_1', chunk_bytes: MiB, sent: 3 * MiB, total: 10 * MiB }
  const marks: Partial<PendingImage>[] = []
  let removed = 0
  const asked: string[] = []
  const outcomes = [{ dropped: false, reason: 'HTTP 503' }, { dropped: true, reason: null }]
  const drop = async (sid: string, uid: string) => { asked.push(`${sid}/${uid}`); return outcomes.shift()! }
  await removeWaitingFile({ transfer }, drop, (p) => marks.push(p), () => { removed += 1 })
  assert.equal(removed, 0)
  assert.deepEqual(marks.map((m) => m.state), ['dropping', 'failed'])
  assert.match(marks[1]!.error!, /did not confirm it dropped the 3\.0 MiB uploaded of it \(HTTP 503\); remove it again to ask again/)
  await removeWaitingFile({ transfer }, drop, (p) => marks.push(p), () => { removed += 1 })
  assert.equal(removed, 1)
  assert.deepEqual(asked, ['s_1/u_1', 's_1/u_1'])
  // a drop that throws is no drop; a file with no upload leaves at once, nothing asked
  await removeWaitingFile({ transfer }, async () => { throw new Error('offline') }, (p) => marks.push(p), () => { removed += 1 })
  assert.equal(removed, 1)
  assert.match(marks.at(-1)!.error!, /\(offline\)/)
  await removeWaitingFile({ transfer: null }, async () => assert.fail('nothing to drop'), () => assert.fail('no mark'), () => { removed += 1 })
  assert.equal(removed, 2)
  // a send waits for no removal: one under way refuses the send, the draft kept
  const files: PendingImage[] = [{ id: 'a', name: 'a.mp4', file: new File(['x'], 'a.mp4'), url: '', state: 'dropping', error: null, uploaded: null, transfer }]
  await assert.rejects(uploadAttachments('s_1', () => files, async () => assert.fail('nothing sent'), () => undefined), /still being removed/)
})

test('the desktop bridge is read only when present; its answer is a local reference, null, or an error — never "upload it"', async () => {
  assert.equal(localAttacher({}, 's_1'), null)
  assert.equal(localAttacher({ oasisCodeDesktop: { platform: 'darwin' } }, 's_1'), null)
  const seen: unknown[][] = []
  const answers: unknown[] = [ref('a.mp4'), null, { ...ref('a.mp4'), origin: 'upload' }, { asset_id: 'x' }]
  const attach = localAttacher({ oasisCodeDesktop: { platform: 'darwin', attachLocalFile: async (...args: unknown[]) => { seen.push(args); return answers.shift() } } }, 's_1')!
  const file = new File(['x'], 'a.mp4', { type: 'video/mp4' })
  assert.equal((await attach(file))?.origin, 'local')
  assert.equal(await attach(file), null)
  await assert.rejects(attach(file), /other than a local reference/)
  await assert.rejects(attach(file), /other than a local reference/)
  assert.deepEqual(seen.map(([sid, f]) => [sid, f === file]), [['s_1', true], ['s_1', true], ['s_1', true], ['s_1', true]])
})
