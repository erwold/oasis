/** A task's share, pure: the bots' identity the app and the backend share (contract bots.ts, against its golden
 *  vectors, through the outline's own wrappers), the Agent Teams card a share carries read into the outline's rows,
 *  the V3 page document's gate (no source byte; a session's pictures only ever its own; a picture the page could not
 *  re-encode left out, never the export), its generation (one image budget for the task, pictures kept by session,
 *  the faces and bots the snapshot's own), and the session shown when the one chosen is gone. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import { BOT_GOLDEN } from '@oasis-code/contract/bots-golden'
import { botFor, identityTable, mainBot, memberBot, participantBotOf, participantBots, sessionBots, setIdentities, colourFamily } from '../src/state/outline.ts'
import { shownSession, teamItem, teamItems, teamRowState, runFaces } from '../src/share/team.ts'
import { botsNamed, checkShareAnyDocument, checkShareTaskDocument, SHARE_PAGE_FORMAT, SHARE_PAGE_VERSION_TASK, type ShareTaskDocument } from '../src/share/document.ts'
import { generateTaskShare, optionsKey, ShareTooLargeError, taskShareRequest, type ShareAssets } from '../src/state/share.ts'
import type { ImageCodec, RasterType } from '../src/state/shareImages.ts'
import type { ViewerBundle } from '../src/state/shareHtml.ts'
import { PNG_A, PNG_B, taskSnapshot, teamFixture } from './taskShareFixtures.ts'
import type { RunTreeRow } from '../src/api/types.ts'

// ---- the bots' identity -------------------------------------------------------------------------------------------

test('the outline\'s bots are the contract\'s: every golden vector, through the names the app\'s views read', () => {
  for (const [bot, family] of Object.entries(BOT_GOLDEN.colour)) assert.equal(colourFamily(bot), family, bot)
  for (const [session, bot] of Object.entries(BOT_GOLDEN.main)) assert.equal(mainBot(session), bot, session)
  for (const p of BOT_GOLDEN.participants) assert.deepEqual([...participantBots(p.session, p.ordered)], p.bots)
  for (const s of BOT_GOLDEN.session_bots) assert.deepEqual(sessionBots(s.session, s.agents as never), s.bots)
  const sessionId = BOT_GOLDEN.tables[0]!.session
  setIdentities(identityTable(BOT_GOLDEN.identity_rows as unknown as RunTreeRow[], sessionId))
  try {
    const table = BOT_GOLDEN.tables[0]!
    for (const [pid, bot] of table.byParticipant) assert.equal(participantBotOf(pid, 'm'), bot, pid)
    for (const r of BOT_GOLDEN.rows) assert.equal(botFor(r.row as never), r.bot, r.row.id)
    for (const m of BOT_GOLDEN.members) assert.equal(memberBot(m.group as never, m.alias, m.model), m.bot, `${m.group.id}:${m.alias}`)
  } finally { setIdentities(null) }
})

// ---- the card --------------------------------------------------------------------------------------------------------

test('a share\'s card is the outline\'s rows: its own bots, names, glyphs and badges; a parent or dependency it does not hold is none', () => {
  const rows = teamItems(teamFixture())
  assert.deepEqual(rows.map((r) => [r.id, r.parent_run_id, r.bot]), [['t1', null, '20-at'], ['t2', 't1', '13-puzzle'], ['t3', null, 'director'], ['t4', 't3', '29-lighthouse'], ['t5', 't3', null], ['t6', null, '08-prompt']])
  assert.deepEqual(rows[4]!.depends_on, ['t4'])                                  // t9 is no row of the card
  assert.equal(rows[3]!.participant_index, 0)
  assert.equal(rows[3]!.participant_name, 'Reviewer')
  assert.equal(rows[3]!.glyph_title, 'Done · some commands exited with an error')
  assert.equal(rows[0]!.runs, 2)
  // nothing the share does not carry: no id to show, no lock, no alias
  for (const r of rows) { assert.equal(r.ref, null); assert.equal(r.lock, null); assert.equal(r.participant_alias, null) }
  assert.equal(teamItem({ ...teamFixture().rows[5]!, status: 'cancelled' }).glyph_title, 'Stopped')
  assert.deepEqual(['queued', 'running', 'waiting', 'done', 'error'].map((status) => teamRowState({ status })), ['waiting', 'thinking', 'idle', 'static', 'static'])
  assert.deepEqual(runFaces(taskSnapshot().sessions[0]!.runs), { r1: { bot: '20-at', enclosed: false }, r2: { bot: '13-puzzle', enclosed: true } })
})

test('the session shown: the one chosen while it is there, else the one opened on, else the first', () => {
  const s = [{ key: 's1' }, { key: 's2' }, { key: 's3' }]
  assert.equal(shownSession(s, 's3', 's2'), 's3')
  assert.equal(shownSession(s, 's9', 's2'), 's2')                                // the chosen one deleted
  assert.equal(shownSession(s, null, 's9'), 's1')
  assert.equal(shownSession([], null, null), null)
})

// ---- the V3 page document ---------------------------------------------------------------------------------------------

const PNG_URL = `data:image/png;base64,${PNG_A}`
const PNG_URL_B = `data:image/png;base64,${PNG_B}`
const stripped = () => { const s = taskSnapshot(); return { ...s, sessions: s.sessions.map((x) => ({ ...x, images: x.images.map((i) => ({ ...i, data_base64: '' })) })) } }
const taskDoc = (over: Partial<ShareTaskDocument> = {}): ShareTaskDocument => ({
  format: SHARE_PAGE_FORMAT, version: SHARE_PAGE_VERSION_TASK, theme: 'light', snapshot: stripped(),
  pictures: { s1: { img1: { src: PNG_URL, width: 1, height: 1 } }, s2: { img1: { src: PNG_URL_B, width: 1, height: 1 } } },
  page: { images_rejected: 0, images_over_page_budget: 0 }, bots: { '20-at': PNG_URL }, ...over,
})

test('the V3 document: no source byte, each session\'s pictures its own, only the product\'s bots — and a picture left out is no failure', () => {
  const doc = checkShareTaskDocument(taskDoc())
  assert.equal(doc.pictures.s2!.img1!.src, PNG_URL_B)
  assert.equal(checkShareAnyDocument(taskDoc()).version, 3)
  // a picture the page could not re-encode, or over its budget: the item stays, its picture is simply not carried
  assert.doesNotThrow(() => checkShareTaskDocument(taskDoc({ pictures: { s1: { img1: { src: PNG_URL, width: 1, height: 1 } } } })))
  assert.doesNotThrow(() => checkShareTaskDocument(taskDoc({ pictures: {} })))
  const bad: [string, Partial<ShareTaskDocument> | Record<string, unknown>][] = [
    ['source bytes', { snapshot: taskSnapshot() }],
    ['a session of no snapshot', { pictures: { s9: { img1: { src: PNG_URL, width: 1, height: 1 } } } }],
    ['an image no item of its session names', { pictures: { s1: { img2: { src: PNG_URL, width: 1, height: 1 } } } }],
    ['an SVG', { pictures: { s1: { img1: { src: 'data:image/svg+xml;base64,PHN2Zz4=', width: 1, height: 1 } } } }],
    ['a bot of no product', { bots: { '../../x': PNG_URL } }],
    ['a bot not raster', { bots: { '20-at': 'https://evil.invalid/b.png' } }],
    ['an unknown field', { faces: {} }],
  ]
  for (const [why, over] of bad) assert.throws(() => checkShareTaskDocument({ ...taskDoc(), ...over }), Error, why)
  // an image item naming a key of ANOTHER session's images is refused by the snapshot's own check
  const s = stripped()
  const crossed = { ...s, sessions: [s.sessions[0]!, { ...s.sessions[1]!, images: [] }] }
  assert.throws(() => checkShareTaskDocument({ ...taskDoc(), snapshot: crossed }))
  assert.deepEqual([...botsNamed(taskSnapshot())].sort(), ['02-terminal', '08-prompt', '13-puzzle', '20-at', '29-lighthouse', 'director'])
})

// ---- generation ----------------------------------------------------------------------------------------------------

const BUNDLE: ViewerBundle = { js: 'window.__shareViewer = "ran";', css: '.thread{color:red}' }
const BOT_URL = 'data:image/png;base64,Ym90c3RpbGw='
const SECRET_RUN = 'run_realIdNeverInTheFile123'
const WEBP = (tag: number) => new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, tag, 1, 1, 1])
function codec(): ImageCodec<{ tag: number }> {
  return {
    async decode(bytes: Uint8Array, _t: RasterType) { return { image: { tag: bytes.reduce((a, b) => (a + b) % 256, 0) }, width: 1, height: 1 } },
    async encode(i) { return WEBP(i.tag) },
    release() {},
  }
}
const response = (snapshot = taskSnapshot()) => ({ snapshot, selection: { runs: [{ run_id: SECRET_RUN, session: 's2', key: 'r1', label: 'Main run', status: 'done' as const }] } })

test('generation: the task asked for, every session\'s picture re-encoded and kept under its own session, no id, no source byte', async () => {
  let asked: unknown = null
  const bots: string[] = []
  const assets: ShareAssets = { viewer: async () => BUNDLE, bot: async (name) => { bots.push(name); return BOT_URL } }
  const options = { tools: false, images: true, excluded: [], task: true }
  const built = await generateTaskShare(async (b) => { asked = b; return response() }, options, codec(), new AbortController().signal, 'dark', assets)
  assert.deepEqual(asked, { include_tool_details: false, include_images: true, exclude_run_ids: [], include_task_sessions: true })
  assert.deepEqual(taskShareRequest({ tools: true, images: false, excluded: [] }), { include_tool_details: true, include_images: false, exclude_run_ids: [], include_task_sessions: false })
  assert.notEqual(optionsKey({ ...options, task: false }), optionsKey(options))
  assert.ok(!built.html.includes(SECRET_RUN))
  assert.ok(!built.html.includes(PNG_A) && !built.html.includes(PNG_B))
  assert.equal(built.runs[0]!.session, 's2')
  assert.equal(built.images, 2)
  const data = new JSDOM(built.html).window.document.getElementById('share-data')!.textContent!
  const doc = checkShareTaskDocument(JSON.parse(data))
  assert.equal(doc.theme, 'dark')
  assert.deepEqual(Object.keys(doc.pictures).sort(), ['s1', 's2'])
  assert.notEqual(doc.pictures.s1!.img1!.src, doc.pictures.s2!.img1!.src, 'each session its own picture under the same key')
  assert.deepEqual(Object.keys(doc.bots).sort(), ['02-terminal', '08-prompt', '13-puzzle', '20-at', '29-lighthouse', 'director'])
  assert.deepEqual(bots.sort(), Object.keys(doc.bots).sort())
  for (const s of doc.snapshot.sessions) for (const i of s.images) assert.equal(i.data_base64, '')
})

test('generation: a picture the page refuses is left out and counted (its item stays); a task too large, a mismatch, an abort refuse the file', async () => {
  const snap = taskSnapshot()
  // the member's bytes are not what they say (a length that lies): refused by the page, the export goes on
  const lying = { ...snap, sessions: [snap.sessions[0]!, { ...snap.sessions[1]!, images: [{ ...snap.sessions[1]!.images[0]!, bytes: 9999 }] }] }
  const assets: ShareAssets = { viewer: async () => BUNDLE, bot: async () => PNG_URL }
  const built = await generateTaskShare(async () => response(lying), { tools: false, images: true, excluded: [], task: true }, codec(), new AbortController().signal, 'light', assets)
  assert.equal(built.page.images_rejected, 1)
  const doc = checkShareTaskDocument(JSON.parse(new JSDOM(built.html).window.document.getElementById('share-data')!.textContent!))
  assert.deepEqual(Object.keys(doc.pictures), ['s1'])
  assert.ok(doc.snapshot.sessions[1]!.items.some((i) => i.kind === 'image' && i.image === 'img1'))
  const signal = new AbortController().signal
  await assert.rejects(generateTaskShare(async () => { throw Object.assign(new Error('413'), { status: 413, detail: 'too many', body: { code: 'share_too_large' } }) }, { tools: false, images: false, excluded: [] }, codec(), signal, 'light', assets),
    (e: unknown) => e instanceof ShareTooLargeError)
  await assert.rejects(generateTaskShare(async () => response(), { tools: false, images: true, excluded: [], task: false }, codec(), signal, 'light', assets), /does not match/)
  const ctl = new AbortController()
  await assert.rejects(generateTaskShare(async () => { ctl.abort(new Error('superseded')); return response() }, { tools: false, images: true, excluded: [], task: true }, codec(), ctl.signal, 'light', assets), /superseded/)
})
