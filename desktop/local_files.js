// A PDF or a video the person attached in the app window, named to the harness where it lies: no byte of it is copied
// or uploaded. The page hands the preload a File (chosen, dropped or pasted); the preload asks Electron for the file's
// path on disk (webUtils.getPathForFile — a File made in JavaScript has none, a string is no File) and hands that path
// here; the shell checks who asks, checks the path, and registers it with the backend under the session token, which
// never reaches the page. The backend checks the path again (it is the authority: credential stores, its data
// directory, other projects) and answers the attachment — the only thing the page gets back. A refusal is an error the
// page shows; the page never falls back to uploading a file the shell refused.
const fs = require('node:fs')
const path = require('node:path')

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/
const MAX_PATH = 4096
const MAX_NAME = 255
const MEDIA_TYPE = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i

/** A refusal of the shell's own: said to the page as it is. */
class LocalFileRefused extends Error {
  constructor(message) { super(message); this.name = 'LocalFileRefused' }
}

/** Whether an IPC call comes from the app's own page: the app window's top frame, showing the backend's origin — not
 *  the loading page (a data: URL), not a frame inside the page, not another view of the app (the ChatGPT page, the
 *  agent's browser). */
function fromAppPage(event, win, baseUrl) {
  if (!win || !event || event.sender !== win.webContents) return false
  const frame = event.senderFrame
  const top = win.webContents.mainFrame
  if (!frame || !top || frame.parent) return false
  if (frame !== top && (frame.processId !== top.processId || frame.routingId !== top.routingId)) return false
  try { return new URL(frame.url).origin === new URL(baseUrl).origin } catch { return false }
}

/** What the page asked, checked: the session's id, an absolute path (no NUL, bounded), and — as hints the backend
 *  measures again — the file's name and media type. Anything else is refused. */
function localAttachRequest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new LocalFileRefused('refused: not a file attachment request')
  const { session_id: sessionId, path: where, name, media_type: mediaType } = raw
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) throw new LocalFileRefused('refused: not a session id')
  if (typeof where !== 'string' || where.length === 0 || where.length > MAX_PATH || where.includes('\0') || !path.isAbsolute(where)) {
    throw new LocalFileRefused('refused: the file has no usable path on this computer')
  }
  const out = { session_id: sessionId, path: where }
  if (typeof name === 'string' && name.length > 0 && name.length <= MAX_NAME && !name.includes('\0')) out.name = path.basename(name)
  if (typeof mediaType === 'string' && mediaType.length <= 100 && MEDIA_TYPE.test(mediaType)) out.media_type = mediaType.toLowerCase()
  return out
}

/** Whether `child` is `root` or lies under it (case-folded where the file system usually is: macOS, Windows). */
function within(child, root, platform = process.platform) {
  const fold = (p) => (platform === 'darwin' || platform === 'win32' ? p.toLowerCase() : p)
  const rel = path.relative(fold(root), fold(child))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** The path the shell registers: where the file really is (links followed), a regular file (not a folder, a pipe, a
 *  device or a socket), and outside the folders the shell keeps for itself (the harness's data directory, the app's
 *  Electron profile). The backend checks it again against everything a command may not read. */
function checkLocalPath(where, { protectedRoots = [], realpath = fs.realpathSync.native, stat = fs.statSync, platform = process.platform } = {}) {
  let real
  try { real = realpath(where) } catch { throw new LocalFileRefused(`refused: ${path.basename(where)} is not there any more`) }
  let st
  try { st = stat(real) } catch { throw new LocalFileRefused(`refused: ${path.basename(where)} cannot be read`) }
  if (!st.isFile()) throw new LocalFileRefused(`refused: ${path.basename(where)} is not a regular file`)
  for (const root of protectedRoots) {
    if (!root) continue
    let resolved = root
    try { resolved = realpath(root) } catch { /* a root not made yet still guards its path */ }
    if (within(real, resolved, platform) || within(where, root, platform)) throw new LocalFileRefused(`refused: ${path.basename(where)} lies in a folder the app keeps for itself`)
  }
  return real
}

/** A line with the token masked wherever it stands (a backend's detail never carries it; this makes sure). */
function scrub(text, token) {
  const line = String(text)
  return token ? line.split(token).join('…') : line
}

/** Registers the path with the backend (POST /api/sessions/:id/attachments/local, the session token in its header —
 *  the backend takes this request from that header only, never from the page's cookie) and answers the attachment the
 *  backend made. Its refusal is thrown with its own words; null when it answers `copy_instead` (the page uploads a copy). */
async function registerLocalFile({ baseUrl, token, fetchImpl = fetch, request, timeoutMs = 120_000 }) {
  if (!token) throw new LocalFileRefused('refused: the app holds no token for this backend, so the file was not attached')
  const body = { path: request.path }
  if (request.name) body.name = request.name
  if (request.media_type) body.media_type = request.media_type
  let res
  try {
    res = await fetchImpl(`${baseUrl}/api/sessions/${encodeURIComponent(request.session_id)}/attachments/local`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-oasis-code-token': token }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    throw new LocalFileRefused(scrub(`the harness did not answer: ${error && error.message ? error.message : error}`, token))
  }
  let answer = null
  try { answer = await res.json() } catch { answer = null }
  // the file lies where only its path is out of the agent's reach: no local reference, and the page uploads a copy
  if (!res.ok && answer && answer.code === 'copy_instead') return null
  if (!res.ok) {
    const detail = answer && typeof answer.detail === 'string' ? answer.detail : `the harness refused the file (HTTP ${res.status})`
    throw new LocalFileRefused(scrub(detail, token))
  }
  if (!answer || typeof answer !== 'object' || Array.isArray(answer) || typeof answer.asset_id !== 'string' || answer.representation !== 'ref-v1' || answer.origin !== 'local') {
    throw new LocalFileRefused('the harness answered something other than an attachment')
  }
  if (JSON.stringify(answer).includes(token)) throw new LocalFileRefused('the harness answer carried a token; it was not handed to the page')
  return answer
}

/** The whole of the shell's answer to the page's ask (main.js checks the sender first, as every handler does): the app
 *  page's top frame, a well-formed request, a path the shell may name, the backend's attachment. The backend is named
 *  the path the shell checked — where the file really is, links followed (/tmp/clip.mov is /private/tmp/clip.mov on
 *  a Mac; a link to a volume is the volume's path) — never another; it resolves and checks that path again itself.
 *  The label stays the name the person attached it by. A refusal anywhere sends nothing; the token goes nowhere else. */
async function attachLocalFile(event, raw, { win, baseUrl, protectedRoots = [], token, fetchImpl = fetch, realpath, stat, platform } = {}) {
  if (!fromAppPage(event, win, baseUrl)) throw new LocalFileRefused('refused: only the app page attaches files')
  const request = localAttachRequest(raw)
  const real = checkLocalPath(request.path, { protectedRoots, ...(realpath ? { realpath } : {}), ...(stat ? { stat } : {}), ...(platform ? { platform } : {}) })
  if (typeof real !== 'string' || !path.isAbsolute(real) || real.length > MAX_PATH || real.includes('\0')) {
    throw new LocalFileRefused(`refused: ${path.basename(request.path)} has no usable path on this computer`)
  }
  const name = request.name || path.basename(request.path).slice(0, MAX_NAME)
  return registerLocalFile({ baseUrl, token, fetchImpl, request: { ...request, path: real, ...(name ? { name } : {}) } })
}

module.exports = { LocalFileRefused, attachLocalFile, checkLocalPath, fromAppPage, localAttachRequest, registerLocalFile, scrub, within }
