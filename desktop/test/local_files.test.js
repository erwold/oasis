// A PDF or a video attached in the app window is named to the harness where it lies: the preload hands on only the
// path Electron gives for a real File, the shell answers only its own page's top frame, checks the path, registers it
// under the session token in a header and hands the page the attachment — never the token.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { LocalFileRefused, attachLocalFile, checkLocalPath, fromAppPage, localAttachRequest, registerLocalFile, scrub, within } = require('../local_files')

const BASE = 'http://127.0.0.1:8321'
const TOKEN = 'session-token-of-this-data-dir-0123456789'
const REF = { asset_id: 'a_1', name: 'clip.mov', media_type: 'video/quicktime', bytes: 5 * 1024 ** 3, file_kind: 'video', representation: 'ref-v1', origin: 'local', location: '/Users/me/Movies/clip.mov', sha256: null }

/** The File of the page as Electron sees it: one the person chose (a path on disk) or one made in the page (none). */
class FakeFile {
  constructor(name, type, diskPath) { this.name = name; this.type = type; this.diskPath = diskPath }
}

/** preload.js run as Electron runs it, on a fake `electron`: what it exposes and what it sends the main process. */
function loadPreload() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8')
  const sent = []
  let exposed = null
  const electron = {
    contextBridge: { exposeInMainWorld: (key, api) => { assert.equal(key, 'oasisCodeDesktop'); exposed = api } },
    ipcRenderer: { invoke: (channel, arg) => { sent.push([channel, arg]); return Promise.resolve(REF) }, send: (channel, arg) => sent.push([channel, arg]) },
    // Electron's own rule: anything that is not a File throws; a File made in the page answers ''
    webUtils: { getPathForFile: (file) => { if (!(file instanceof FakeFile)) throw new TypeError('parameter 1 is not of type File'); return file.diskPath } },
  }
  const required = []
  const requireFake = (name) => { required.push(name); if (name === 'electron') return electron; throw new Error(`a sandboxed preload cannot require ${name}`) }
  new Function('require', 'process', source)(requireFake, { platform: 'darwin' })
  return { api: exposed, sent, required }
}

test('the preload takes a real File only: its path is Electron\'s answer, a page-made File is null, a string or a forged .path is refused', async () => {
  const { api, sent, required } = loadPreload()
  assert.deepEqual(required, ['electron'])                                    // a sandboxed preload requires nothing local
  assert.equal(typeof api.attachLocalFile, 'function')
  assert.deepEqual(await api.attachLocalFile('s_1', new FakeFile('clip.mov', 'video/quicktime', '/Users/me/Movies/clip.mov')), REF)
  assert.deepEqual(sent, [['attach-local-file', { session_id: 's_1', path: '/Users/me/Movies/clip.mov', name: 'clip.mov', media_type: 'video/quicktime' }]])
  // a File made in the page has no file behind it: null (the page uploads it), nothing sent
  assert.equal(await api.attachLocalFile('s_1', new FakeFile('made.pdf', 'application/pdf', '')), null)
  // a path the page writes is no File: refused, nothing sent
  await assert.rejects(api.attachLocalFile('s_1', '/Users/me/.ssh/id_ed25519'), TypeError)
  await assert.rejects(api.attachLocalFile('s_1', { name: 'x.pdf', path: '/etc/master.passwd' }), TypeError)
  await assert.rejects(api.attachLocalFile('s_1', undefined), TypeError)
  // a File whose .path the page set: the path sent is still Electron's
  const forged = Object.assign(new FakeFile('a.mp4', 'video/mp4', '/Users/me/a.mp4'), { path: '/Users/me/.oasis-code/auth.json' })
  await api.attachLocalFile('s_1', forged)
  assert.equal(sent.length, 2)
  assert.equal(sent[1][1].path, '/Users/me/a.mp4')
  assert.ok(!JSON.stringify(sent).includes('auth.json') && !JSON.stringify(sent).includes('id_ed25519'))
})

test('the preload exposes nothing that hands the page a token or the file system', () => {
  const { api } = loadPreload()
  for (const key of Object.keys(api)) assert.doesNotMatch(key, /token|read|fs|path$/i, key)
})

/** A window and the events its frames send. */
function windowWithPage(url) {
  const top = { url, parent: null, processId: 7, routingId: 1 }
  const webContents = { mainFrame: top }
  return { win: { webContents }, top, webContents }
}

test('the shell answers its own page\'s top frame on the backend\'s origin only', () => {
  const { win, top, webContents } = windowWithPage(`${BASE}/`)
  assert.equal(fromAppPage({ sender: webContents, senderFrame: top }, win, BASE), true)
  assert.equal(fromAppPage({ sender: webContents, senderFrame: { ...top } }, win, BASE), true)      // the same frame, another wrapper
  assert.equal(fromAppPage({ sender: { mainFrame: top }, senderFrame: top }, win, BASE), false)      // another view (ChatGPT, the agent's browser)
  assert.equal(fromAppPage({ sender: webContents, senderFrame: { url: `${BASE}/`, parent: top, processId: 7, routingId: 2 } }, win, BASE), false)   // a frame in the page
  assert.equal(fromAppPage({ sender: webContents, senderFrame: { url: `${BASE}/`, parent: null, processId: 9, routingId: 1 } }, win, BASE), false)
  assert.equal(fromAppPage({ sender: webContents, senderFrame: null }, win, BASE), false)            // navigated or gone
  assert.equal(fromAppPage({ sender: webContents, senderFrame: { ...top, url: 'data:text/html,loading' } }, win, BASE), false)
  assert.equal(fromAppPage({ sender: webContents, senderFrame: { ...top, url: 'http://127.0.0.1:9999/' } }, win, BASE), false)
  assert.equal(fromAppPage({ sender: webContents, senderFrame: { ...top, url: 'https://evil.example/' } }, win, BASE), false)
  assert.equal(fromAppPage({ sender: webContents, senderFrame: top }, null, BASE), false)
})

test('a request is a session id and an absolute path; name and media type are hints, anything else is refused', () => {
  assert.deepEqual(localAttachRequest({ session_id: 's_1', path: '/a/b c.mov', name: 'b c.mov', media_type: 'video/QuickTime', extra: 1 }),
    { session_id: 's_1', path: '/a/b c.mov', name: 'b c.mov', media_type: 'video/quicktime' })
  assert.deepEqual(localAttachRequest({ session_id: 's_1', path: '/a/x.pdf', name: '../../x.pdf', media_type: 'not a type' }), { session_id: 's_1', path: '/a/x.pdf', name: 'x.pdf' })
  for (const bad of [null, 'x', [], { session_id: '../s', path: '/a' }, { session_id: 's', path: 'relative/x.pdf' }, { session_id: 's', path: '' },
    { session_id: 's', path: '/a\0b' }, { session_id: 's', path: `/${'a'.repeat(5000)}` }, { session_id: 's', path: 3 }, { path: '/a' }]) {
    assert.throws(() => localAttachRequest(bad), LocalFileRefused, JSON.stringify(bad))
  }
})

test('the path named is a regular file outside the folders the app keeps for itself, links followed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oasis-local-'))
  try {
    const data = path.join(root, 'data'); const profile = path.join(root, 'profile'); const movies = path.join(root, 'Movies')
    for (const dir of [data, profile, movies]) fs.mkdirSync(dir)
    const clip = path.join(movies, 'clip.mov'); fs.writeFileSync(clip, 'moov')
    fs.writeFileSync(path.join(data, 'auth.json'), '{}')
    fs.symlinkSync(path.join(data, 'auth.json'), path.join(movies, 'innocent.mov'))
    fs.symlinkSync(clip, path.join(movies, 'alias.mov'))
    const roots = { protectedRoots: [data, profile] }
    assert.equal(checkLocalPath(clip, roots), fs.realpathSync.native(clip))
    assert.equal(checkLocalPath(path.join(movies, 'alias.mov'), roots), fs.realpathSync.native(clip))
    assert.throws(() => checkLocalPath(path.join(data, 'auth.json'), roots), /keeps for itself/)
    assert.throws(() => checkLocalPath(path.join(movies, 'innocent.mov'), roots), /keeps for itself/)
    assert.throws(() => checkLocalPath(path.join(data.toUpperCase()), { ...roots, platform: 'darwin', realpath: (p) => p, stat: () => ({ isFile: () => true }) }), /keeps for itself/)
    assert.throws(() => checkLocalPath(movies, roots), /not a regular file/)
    assert.throws(() => checkLocalPath(path.join(movies, 'gone.mov'), roots), /not there/)
    assert.throws(() => checkLocalPath('/dev/fake-fifo', { realpath: (p) => p, stat: () => ({ isFile: () => false }) }), /not a regular file/)
    assert.equal(within('/a/b', '/a'), true); assert.equal(within('/ab', '/a'), false); assert.equal(within('/a', '/a'), true)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

/** A fetch that answers as the backend would, and keeps what it was sent. */
function fakeBackend(answer, status = 200) {
  const calls = []
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: status >= 200 && status < 300, status, json: async () => answer } }
  return { calls, fetchImpl }
}

test('the shell registers the path under the token in a header and hands the page the attachment only', async () => {
  const { calls, fetchImpl } = fakeBackend(REF)
  const request = { session_id: 's_1', path: '/Users/me/Movies/clip.mov', name: 'clip.mov', media_type: 'video/quicktime' }
  assert.deepEqual(await registerLocalFile({ baseUrl: BASE, token: TOKEN, fetchImpl, request }), REF)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, `${BASE}/api/sessions/s_1/attachments/local`)
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers['x-oasis-code-token'], TOKEN)
  assert.equal(calls[0].init.headers.cookie, undefined)
  assert.deepEqual(JSON.parse(calls[0].init.body), { path: '/Users/me/Movies/clip.mov', name: 'clip.mov', media_type: 'video/quicktime' })
  // the backend's refusal is the page's error, in its own words, the token never in it
  await assert.rejects(registerLocalFile({ baseUrl: BASE, token: TOKEN, fetchImpl: fakeBackend({ detail: `credential store refused (${TOKEN})` }, 403).fetchImpl, request }),
    (e) => e instanceof LocalFileRefused && /credential store refused/.test(e.message) && !e.message.includes(TOKEN))
  await assert.rejects(registerLocalFile({ baseUrl: BASE, token: TOKEN, fetchImpl: fakeBackend(null, 500).fetchImpl, request }), /HTTP 500/)
  // a path out of the agent's reach whose file may go as a copy: no reference, and the page uploads it
  assert.equal(await registerLocalFile({ baseUrl: BASE, token: TOKEN, fetchImpl: fakeBackend({ detail: 'in the original folder', code: 'copy_instead' }, 403).fetchImpl, request }), null)
  await assert.rejects(registerLocalFile({ baseUrl: BASE, token: TOKEN, fetchImpl: async () => { throw new Error(`connect refused ${TOKEN}`) }, request }), (e) => !e.message.includes(TOKEN))
  // an answer that is no local reference, or that carries the token, never reaches the page
  await assert.rejects(registerLocalFile({ baseUrl: BASE, token: TOKEN, fetchImpl: fakeBackend({ ...REF, origin: 'upload' }).fetchImpl, request }), /other than an attachment/)
  await assert.rejects(registerLocalFile({ baseUrl: BASE, token: TOKEN, fetchImpl: fakeBackend({ ...REF, note: TOKEN }).fetchImpl, request }), /carried a token/)
  // no token: nothing is sent
  const none = fakeBackend(REF)
  await assert.rejects(registerLocalFile({ baseUrl: BASE, token: null, fetchImpl: none.fetchImpl, request }), /no token/)
  assert.equal(none.calls.length, 0)
  assert.equal(scrub(`a ${TOKEN} b ${TOKEN}`, TOKEN), 'a … b …')
})

test('the whole answer: a call from anywhere but the app page, or a refused path, never reaches the backend', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oasis-local-'))
  try {
    const data = path.join(root, 'data'); fs.mkdirSync(data)
    const clip = path.join(root, 'clip.mp4'); fs.writeFileSync(clip, 'x')
    const secret = path.join(data, 'auth.json'); fs.writeFileSync(secret, '{}')
    const { win, top, webContents } = windowWithPage(`${BASE}/`)
    const backend = fakeBackend(REF)
    const opts = { win, baseUrl: BASE, protectedRoots: [data], token: TOKEN, fetchImpl: backend.fetchImpl }
    const ask = (p) => ({ session_id: 's_1', path: p, name: path.basename(p), media_type: 'video/mp4' })
    assert.deepEqual(await attachLocalFile({ sender: webContents, senderFrame: top }, ask(clip), opts), REF)
    await assert.rejects(attachLocalFile({ sender: webContents, senderFrame: { ...top, parent: top } }, ask(clip), opts), /only the app page/)
    await assert.rejects(attachLocalFile({ sender: webContents, senderFrame: top }, ask(secret), opts), /keeps for itself/)
    await assert.rejects(attachLocalFile({ sender: webContents, senderFrame: top }, { session_id: 's_1', path: 'auth.json' }, opts), /no usable path/)
    assert.equal(backend.calls.length, 1)
    assert.ok(!JSON.stringify(await attachLocalFile({ sender: webContents, senderFrame: top }, ask(clip), opts)).includes(TOKEN))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('the backend is named the path the shell checked — where the file really is — not the alias the File came by', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oasis-local-'))
  try {
    // a folder reached by a link (as /tmp is /private/tmp on a Mac, or a volume by a link to it), a file link in it
    const volume = path.join(root, 'Volume'); fs.mkdirSync(volume)
    const clip = path.join(volume, 'clip.mp4'); fs.writeFileSync(clip, 'x')
    const alias = path.join(root, 'tmp'); fs.symlinkSync(volume, alias)
    fs.symlinkSync(clip, path.join(volume, 'shortcut.mp4'))
    const data = path.join(root, 'data'); fs.mkdirSync(data); fs.writeFileSync(path.join(data, 'auth.json'), '{}')
    fs.symlinkSync(data, path.join(root, 'innocent'))
    const { win, top, webContents } = windowWithPage(`${BASE}/`)
    const backend = fakeBackend(REF)
    const opts = { win, baseUrl: BASE, protectedRoots: [data], token: TOKEN, fetchImpl: backend.fetchImpl }
    const event = { sender: webContents, senderFrame: top }
    const real = fs.realpathSync.native(clip)
    assert.deepEqual(await attachLocalFile(event, { session_id: 's_1', path: path.join(alias, 'clip.mp4'), name: 'clip.mp4', media_type: 'video/mp4' }, opts), REF)
    assert.deepEqual(JSON.parse(backend.calls[0].init.body), { path: real, name: 'clip.mp4', media_type: 'video/mp4' })
    // a file link: the target's path goes, the label stays the name it was attached by (the page's, or the link's own)
    await attachLocalFile(event, { session_id: 's_1', path: path.join(alias, 'shortcut.mp4') }, opts)
    assert.deepEqual(JSON.parse(backend.calls[1].init.body), { path: real, name: 'shortcut.mp4' })
    assert.equal(backend.calls[1].init.headers['x-oasis-code-token'], TOKEN)
    // the checks are not loosened: a link into a folder the app keeps for itself is refused and nothing is sent
    await assert.rejects(attachLocalFile(event, { session_id: 's_1', path: path.join(root, 'innocent', 'auth.json') }, opts), /keeps for itself/)
    await assert.rejects(attachLocalFile({ sender: webContents, senderFrame: { ...top, url: 'https://evil.example/' } }, { session_id: 's_1', path: clip }, opts), /only the app page/)
    // a checked path the backend could not take (longer than the request allows) is refused here, not cut short
    await assert.rejects(attachLocalFile(event, { session_id: 's_1', path: clip }, { ...opts, realpath: (p) => (p === clip ? `/${'x'.repeat(5000)}` : fs.realpathSync.native(p)), stat: () => ({ isFile: () => true }) }), /no usable path/)
    assert.equal(backend.calls.length, 2)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('main.js: the attach handler checks its sender first and hands the token to nothing but the backend call', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  const handler = source.split(/(?=ipcMain\.(?:handle|on)\()/).find((h) => h.startsWith("ipcMain.handle('attach-local-file'"))
  assert.ok(handler, 'the attach-local-file handler')
  const body = handler.split('\n})')[0]
  assert.match(body.split('\n')[1], /event\.sender !== mainWindow\.webContents\) throw/)
  assert.match(body, /attachLocalFile\(event, raw, \{ win: mainWindow, baseUrl: BASE_URL, protectedRoots: \[DATA_DIR, app\.getPath\('userData'\)\], token: sessionToken\(\) \}\)/)
  // the token is read to prove the backend's identity, for the page's URL (the backend redirects it into an HttpOnly
  // cookie) and for this one call — nowhere does a handler return it
  const uses = source.split('\n').filter((l) => l.includes('sessionToken()') && !l.startsWith('function sessionToken()')).map((l) => l.trim().slice(0, 40))
  assert.deepEqual(uses, ['return classifyAttach(res.status, body, ', 'const token = sessionToken()', 'return attachLocalFile(event, raw, { win'])
  assert.ok(require('../package.json').build.files.includes('local_files.js'))
})
