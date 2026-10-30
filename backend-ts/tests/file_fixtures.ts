/** Synthetic container fixtures for structural tests; NOT evidence of codec decoding or model understanding. */
export function pdfFixture(text = 'Synthetic attachment ABC42'): Buffer {
  const stream = `BT /F1 12 Tf 20 100 Td (${text}) Tj ET`
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`]
  let body = '%PDF-1.4\n'
  const offsets = [0]
  for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(body)); body += `${i + 1} 0 obj\n${object}\nendobj\n` }
  const at = Buffer.byteLength(body)
  body += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`
  return Buffer.from(body)
}
export function box(type: string, ...content: Buffer[]): Buffer {
  const body = Buffer.concat(content), head = Buffer.alloc(8)
  head.writeUInt32BE(body.length + 8); head.write(type, 4)
  return Buffer.concat([head, body])
}
export function mp4Fixture(brand = 'isom', track = 'vide'): Buffer {
  return Buffer.concat([box('ftyp', Buffer.from(brand), Buffer.alloc(4), Buffer.from('isom')), box('moov', box('trak', box('mdia', box('hdlr', Buffer.alloc(8), Buffer.from(track), Buffer.alloc(12))))), box('mdat', Buffer.from('synthetic bytes, not a codec'))])
}
function ebml(id: string, body: Buffer): Buffer { return Buffer.concat([Buffer.from(id, 'hex'), Buffer.from([0x80 | body.length]), body]) }
export function webmFixture(track = 1): Buffer {
  return Buffer.concat([ebml('1a45dfa3', ebml('4282', Buffer.from('webm'))), ebml('18538067', Buffer.concat([ebml('1654ae6b', ebml('ae', ebml('83', Buffer.from([track])))), ebml('1f43b675', ebml('a3', Buffer.from([0x81, 0, 0, 0x80, 0])))]))])
}

export function xrefStreamPdf(): Buffer {
  const original = pdfFixture(), start = Number(/startxref\s+(\d+)/.exec(original.toString())![1])
  const body = original.subarray(0, start)
  const entries = Buffer.alloc(7 * 7)
  entries.writeUInt16BE(65535, 5)
  for (let id = 1; id <= 6; id++) {
    const at = id === 6 ? start : body.indexOf(`${id} 0 obj`)
    entries[id * 7] = 1; entries.writeUInt32BE(at, id * 7 + 1)
  }
  return Buffer.concat([body, Buffer.from('6 0 obj\n<< /Type /XRef /Size 7 /Root 1 0 R /W [1 4 2] /Length 49 >>\nstream\n'), entries,
    Buffer.from(`\nendstream\nendobj\nstartxref\n${start}\n%%EOF\n`)])
}
export function webmClustersFixture(group = false): Buffer {
  const block = group ? ebml('a0', ebml('a1', Buffer.from([0x81, 0, 0, 0x80, 0]))) : ebml('a3', Buffer.from([0x81, 0, 0, 0x80, 0]))
  return Buffer.concat([ebml('1a45dfa3', ebml('4282', Buffer.from('webm'))), Buffer.from('18538067ff', 'hex'),
    ebml('1654ae6b', ebml('ae', ebml('83', Buffer.from([1])))), Buffer.from('1f43b675ff', 'hex'), block,
    // A sibling sized Cluster must not be swallowed into the preceding unknown-sized Cluster.
    ebml('1f43b675', block), ebml('1c53bb6b', Buffer.alloc(0))])
}

/** A legal hybrid revision whose Root exists only in its supplemental xref stream / object stream.
 * The older revision advertises a different (non-Catalog) object 1, so reversing Prev precedence cannot pass. */
export function hybridPdfFixture(): Buffer {
  let body = '%PDF-1.7\n'
  const oldRoot = body.length; body += '1 0 obj\n<< /Type /Pages /Count 0 >>\nendobj\n'
  const oldPages = body.length; body += '2 0 obj\n<< /Type /Pages /Count 0 /Kids [] >>\nendobj\n'
  const previous = body.length
  body += `xref\n0 3\n0000000000 65535 f \n${String(oldRoot).padStart(10, '0')} 00000 n \n${String(oldPages).padStart(10, '0')} 00000 n \ntrailer\n<< /Size 3 /Root 1 0 R >>\nstartxref\n${previous}\n%%EOF\n`
  const objectStream = body.length, content = '1 0 << /Type /Catalog /Pages 2 0 R >>'
  body += `3 0 obj\n<< /Type /ObjStm /N 1 /First 4 /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`
  const supplement = body.length
  const data = Buffer.alloc(3 * 7)
  data[0] = 2; data.writeUInt32BE(3, 1) // object 1 -> object stream 3, index 0
  data[7] = 1; data.writeUInt32BE(oldPages, 8)
  data[14] = 1; data.writeUInt32BE(objectStream, 15) // object stream entry also only in the supplement
  const head = Buffer.from(body + `4 0 obj\n<< /Type /XRef /Size 5 /Index [1 3] /W [1 4 2] /Length ${data.length} >>\nstream\n`)
  const beforeTable = Buffer.concat([head, data, Buffer.from('\nendstream\nendobj\n')])
  const table = beforeTable.length
  return Buffer.concat([beforeTable, Buffer.from(`xref\n0 5\n0000000000 65535 f \n0000000000 00000 f \n${String(oldPages).padStart(10, '0')} 00000 n \n0000000000 00000 f \n${String(supplement).padStart(10, '0')} 00000 n \ntrailer\n<< /Size 5 /Root 1 0 R /XRefStm ${supplement} /Prev ${previous} >>\nstartxref\n${table}\n%%EOF\n`)])
}

/** A legacy (`native-v1` / `utf8-v1`) file attachment as the build before references stored one (content-addressed in
 *  the store, its measurement in the asset's meta): what an old history names. New uploads never make one. */
export async function legacyFileAttachment(state: { conn: import('../src/db/database.ts').Conn; store: import('../src/store.ts').AssetStore }, session: { id: string; project_id: string }, bytes: Uint8Array, name: string) {
  const { measureAttachment } = await import('../src/llm/files.ts')
  const { assetAttachment } = await import('../src/llm/attachments.ts')
  const measured = measureAttachment(bytes, name) as { file_kind: string; media_type: string; representation: string }
  const ext = measured.file_kind === 'text' ? 'txt' : measured.file_kind === 'pdf' ? 'pdf' : measured.media_type === 'video/quicktime' ? 'mov' : measured.media_type.split('/')[1]!
  const asset = state.store.save(state.conn, session.project_id, measured.file_kind === 'text' ? 'text' : 'data', bytes, { ext, meta: { ...measured, name, role: 'attachment', session_id: session.id } })
  return assetAttachment(asset)
}
