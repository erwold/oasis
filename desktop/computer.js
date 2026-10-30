// Computer use: an agent looks at a page the desktop app holds and acts on it — a screenshot and an outline of the
// page's controls to see it by, clicks, typing, keys, scrolling and navigation to change it. The pages are
// "surfaces": the agent's own browser (a view of its own profile, shown on the desk's Browser card) and the person's
// signed-in ChatGPT page (the bridge's). This module is the part that decides — who may act on a surface now, whether
// the look an action was chosen on is still the page's, what an action means — over a driver that does the
// looking and the input (desktop/computer_electron.js drives a real page through its devtools protocol; a test plays
// one). The backend reaches it through the bridge server (/computer/*) and the agent through its computer tools.
//
// The rules it keeps:
// - one actor per surface: an agent run holds a surface while it acts on it (a lease, let go after a quiet minute and
//   a half, or when it says so); another run is told who holds it. The bridge's own sends to ChatGPT take the page
//   the same way, and an agent is told to wait while the bridge sends or an answer it sent forms. An action queued
//   behind another runs only if its run still holds the page and its request is still open (else `cancelled`).
// - an action names the look it was chosen on (snapshot_id), a look of its own run and of this start of the app; it
//   is used up by the action. A page that navigated, was used by the person or by another run, opened a dialog or
//   changed size since — or whose target is no longer what the look showed (its line in the outline, or what is at
//   an x, y) — reads as stale: nothing is done, and a fresh look comes back instead. A dialog's answer names the look
//   that showed that dialog.
// - while the person is using the page (their input in the last few seconds, or any during the action) the agent
//   stops: `person_active`, with what was done so far.
// - navigation stays where the surface allows (ChatGPT's page: the sign-in and chat hosts; the browser: http(s),
//   never the harness's own addresses).
// - a click on an element happens only where the element itself would take it (Playwright's actionability, in
//   short): its box holds still, nothing covers its middle right before the press, and it is enabled — else nothing
//   is done (`unstable`, `covered`, `not_actionable`) and a fresh look comes back.
// - an action done is said as done: the look after it failing is `look_failed` on an ok answer, never a bare error.
// - waiting is the host's (`wait` with a condition: words that appear or go, an element that goes, an address, a
//   download), checked here every half second — never a model asking over and over.
// - a person may watch: what the agent is doing on a surface now and where its pointer last went are kept for the
//   live picture in the thread (`watch`), which takes nothing from the agent and opens no page.

const crypto = require('node:crypto')

const LEASE_MS = 90_000
const PERSON_QUIET_MS = 3_000
const KEEP_SNAPSHOTS = 20
const OUTLINE_LINES = 300
const NAME_CHARS = 100
const READ_CHARS = 20_000
const WAIT_MAX_S = 10
// a wait for a condition: at most this long (a ChatGPT answer takes minutes), checked this often
const WAIT_UNTIL_MAX_S = 300
const WAIT_EVERY_MS = 500
// how long an element may move or stay covered before a click on it is refused; how long it must hold still (a
// carousel that moves every 200 ms never does), sampled this often
const ACTIONABLE_MS = 1_500
const STEADY_MS = 300
const SAMPLE_MS = 100
// a look the page changed under (it navigated between the reads) is taken again this many times, then kept stale
const LOOK_RETAKES = 1
const TYPE_MAX_CHARS = 20_000
const MAX_FILES = 10
// the agent browser's tabs (a surface with `tabbed: true`): an agent tab no run holds, with nothing under way, that
// nobody used for this long is closed (its run ended, or the run left it); an approval of a look of it is stale then
const TAB_IDLE_MS = 10 * 60_000
// how many snapshot ids are remembered with the tab they were taken of (beyond the latest 20 looks of each tab), so
// an old look still names its own tab — never the run's current one — when it is refused
const KEEP_SNAPSHOT_INDEX = 2_000

const ACTIONS = ['click', 'double_click', 'right_click', 'hover', 'type', 'key', 'scroll', 'select', 'drag', 'navigate', 'back', 'forward', 'reload', 'upload', 'dialog', 'wait', 'read_text', 'release', 'tab_new', 'tab_select', 'tab_close']
// the agent browser's own tab actions: a run opens, selects and closes its own tabs only
const TAB_ACTIONS = new Set(['tab_new', 'tab_select', 'tab_close'])
// actions that touch the page as input does: they need a look that is still the page's
const INPUT_ACTIONS = new Set(['click', 'double_click', 'right_click', 'hover', 'type', 'key', 'scroll', 'select', 'drag', 'upload'])
// actions that answer what a look showed: an input, or a dialog's answer
const NEEDS_LOOK = new Set([...INPUT_ACTIONS, 'dialog'])
// the driver's calls that change the page (and a select that chose an option): the first one uses up the look the
// action named
const INPUT_CALLS = ['click', 'move', 'scroll', 'insertText', 'key', 'clearFocused', 'drag', 'setFiles', 'answerDialog', 'navigate', 'history', 'reload']
// refusals answered with a fresh look (the next action needs something current to go on)
const WITH_LOOK = new Set(['stale', 'covered', 'unstable', 'not_actionable', 'person_active'])

// the outline: the page's controls (each with a ref an action can name) and the landmarks between them
const INTERACTIVE = new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton', 'menuitem',
  'menuitemcheckbox', 'menuitemradio', 'tab', 'option', 'treeitem', 'listbox', 'textarea', 'textField', 'TextField', 'PopUpButton', 'ToggleButton'])
const LANDMARKS = new Set(['heading', 'dialog', 'alertdialog', 'alert', 'main', 'navigation', 'banner', 'contentinfo', 'complementary', 'form', 'search', 'img', 'image', 'menu', 'menubar', 'tablist', 'toolbar'])
const FLAGS = ['focused', 'disabled', 'checked', 'expanded', 'selected', 'pressed', 'required']

class ComputerRefusal extends Error {
  constructor(status, reason, extra = {}, { noLook = false } = {}) { super(reason); this.name = 'ComputerRefusal'; this.status = status; this.extra = extra; this.noLook = noLook }
}

const clip = (text, n) => {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

const propOf = (node, name) => {
  const p = (node.properties || []).find((x) => x.name === name)
  return p && p.value ? p.value.value : undefined
}

/** An accessibility node's line as the outline writes it, without its indent and ref — `- button "Send" disabled`.
 *  Without the focus (`focus: false`) it is what says an element is still the one a look showed. */
function lineOf(node, { focus = true } = {}) {
  const role = node.role && node.role.value ? String(node.role.value) : ''
  const name = node.name && node.name.value !== undefined ? clip(node.name.value, NAME_CHARS) : ''
  const value = node.value && node.value.value !== undefined && String(node.value.value) !== '' ? ` value="${clip(node.value.value, NAME_CHARS)}"` : ''
  const flags = FLAGS.filter((f) => (focus || f !== 'focused') && (() => { const v = propOf(node, f); return v === true || v === 'true' || v === 'mixed' })()).map((f) => ` ${f}`).join('')
  const level = role === 'heading' && propOf(node, 'level') ? ` level=${propOf(node, 'level')}` : ''
  return `- ${role}${name ? ` "${name.replace(/"/g, '\\"')}"` : ''}${level}${value}${flags}`
}

/** The page's controls and landmarks as indented lines — `- button "Send" [ref=e42]` — from the devtools protocol's
 *  accessibility tree (Accessibility.getFullAXTree nodes); refs are the page's own node ids (`e` + backendDOMNodeId).
 *  `lines` keeps each ref's line (the focus aside), to tell later whether the element is still the one shown. */
function outlineOf(nodes, { maxLines = OUTLINE_LINES } = {}) {
  const byId = new Map()
  for (const node of nodes || []) byId.set(node.nodeId, node)
  const root = (nodes || []).find((n) => !n.parentId) || (nodes || [])[0]
  const out = []
  const refs = new Set()
  const lines = new Map()
  let omitted = 0
  const visit = (node, depth, seen) => {
    if (!node || seen.has(node.nodeId)) return
    seen.add(node.nodeId)
    const role = node.role && node.role.value ? String(node.role.value) : ''
    const name = node.name && node.name.value !== undefined ? clip(node.name.value, NAME_CHARS) : ''
    const focusable = propOf(node, 'focusable') === true
    const interactive = !node.ignored && node.backendDOMNodeId !== undefined && (INTERACTIVE.has(role) || (focusable && name && role !== 'RootWebArea' && role !== 'WebArea'))
    const landmark = !node.ignored && LANDMARKS.has(role) && (name || role === 'dialog' || role === 'alertdialog' || role === 'main')
    let childDepth = depth
    if (interactive || landmark) {
      if (out.length >= maxLines) omitted += 1
      else {
        if (interactive) {
          refs.add(node.backendDOMNodeId)
          lines.set(node.backendDOMNodeId, lineOf(node, { focus: false }))
        }
        out.push(`${'  '.repeat(Math.min(depth, 12))}${lineOf(node)}${interactive ? ` [ref=e${node.backendDOMNodeId}]` : ''}`)
      }
      childDepth = depth + 1
    }
    for (const child of node.childIds || []) visit(byId.get(child), childDepth, seen)
  }
  visit(root, 0, new Set())
  if (omitted) out.push(`… ${omitted} more controls not listed (scroll, or read_text, to see the rest)`)
  return { text: out.join('\n'), refs, lines }
}

/** The outline of a page and its frames: the page's own, then each frame's under a line that names it (a frame of
 *  another site, which the page's process does not hold, is named and not outlined). */
function outlineOfFrames(trees, { maxLines = OUTLINE_LINES } = {}) {
  const [main, ...frames] = trees && trees.length ? trees : [{ nodes: [] }]
  const out = outlineOf(main.nodes, { maxLines })
  const lines = out.text ? [out.text] : []
  for (const frame of frames) {
    const where = frame.url ? hostOf(frame.url) : 'a frame'
    if (!frame.nodes) { lines.push(`- frame "${where}" (another site's page: not outlined — use the screenshot and x, y)`); continue }
    const inner = outlineOf(frame.nodes, { maxLines: Math.max(20, maxLines - lines.length) })
    for (const ref of inner.refs) out.refs.add(ref)
    for (const [ref, line] of inner.lines) out.lines.set(ref, line)
    if (inner.text) lines.push(`- frame "${where}"`, inner.text.split('\n').map((l) => `  ${l}`).join('\n'))
  }
  return { text: lines.join('\n'), refs: out.refs, lines: out.lines }
}

function hostOf(url) {
  try { return new URL(url).host || url.slice(0, 60) } catch { return String(url).slice(0, 60) }
}

/** A ref as the outline wrote it (`e42`), as the page's node id; null for anything else. */
function nodeOfRef(ref) {
  const m = /^e(\d{1,12})$/.exec(String(ref || '').trim())
  return m ? Number(m[1]) : null
}

const doneSoFar = (steps) => (steps.length ? `done so far: ${steps.join(', ')}` : 'nothing was done')

/** The computer over its surfaces: `{ [id]: surface }`, each `{ label, open(): driver, opened(), generation(),
 *  personAt(), allowsUrl(url), busy(): string|null (or its promise), events(owner): { dialog, chooser, notes,
 *  downloads, console } (the lists taken, since the owner's last look), peek(): { dialog, chooser },
 *  downloadsDone(owner): count, downloadsFailed?(owner): count, released?(owner), reset?(): whether the page was cleared, visibility?(): { shown, ever },
 *  pageId?(): the page shown now (a look of another is stale),
 *  chooserUsed(), note(line, owner), bindHolder?(fn) }` (see computer_electron.js). `instance` names this start of the
 *  app in every snapshot id.
 *
 *  A surface with `tabbed: true` (the agent browser) is a set of pages, each run on its own: `{ tabbed, label,
 *  allowsUrl(url), open(owner, { session, label, url }): { id } | { refused } (synchronous: the tab exists once it
 *  returns), page(id): a surface as above for that tab (null once it is closed), exists(id), ownerOf(id),
 *  tabsOf(owner): [{ id, url, title, loading }], all(): [{ id, owner, created_at }], close(id), onClosed(fn) }`.
 *  Every tab is a page of its own here — its lease, its looks, its queue of operations, its pointer — keyed
 *  `browser/<tab>`; two runs' operations on two tabs run at the same time, one tab's run one after another. A run
 *  sees, looks at and acts on its own tabs only (the tab's owner is the run that opened it, named by the backend);
 *  a look names the tab it was taken of and an action on it goes there or nowhere. */
function createComputer({ surfaces, log = () => {}, now = () => Date.now(), leaseMs = LEASE_MS, personQuietMs = PERSON_QUIET_MS, settle = (ms) => new Promise((r) => setTimeout(r, ms)), instance = crypto.randomBytes(4).toString('hex'), tabIdleMs = TAB_IDLE_MS }) {
  // page key -> { sid, tab, surface, holder, used_at, snapshots: Map, chain, party, personMark, handover, doing, pointer, last, takes, inflight, epoch, created_at }
  // (a page key is the surface's id, or `<id>/<tab>` for a tab of a tabbed surface)
  const state = new Map()
  // snapshot counters per surface id (the ids stay unique across the tabs of a surface)
  const counts = new Map()
  // snapshot id -> { key, sid, tab, owner }: which page (tab) a look was of, kept longer than the looks themselves
  const snapIndex = new Map()
  // run -> { current: { [sid]: tab }, session, label, ended }
  const runs = new Map()
  // ended run -> the later run of its session that took its tabs over (an approval of the ended run's looks still
  // reaches them)
  const heirs = new Map()
  const heirOf = (owner) => { let o = owner; for (let i = 0; i < 64 && heirs.has(o); i += 1) o = heirs.get(o); return o }
  // the person clearing the agent browser's data: no operation starts on any of its tabs meanwhile
  let clearing = false
  const tabbedOf = (sid) => !!(surfaces[sid] && surfaces[sid].tabbed)
  const keyOf = (sid, tab) => (tab ? `${sid}/${tab}` : sid)
  // a surface asks who holds it (it takes a download only for an agent)
  for (const [id, surface] of Object.entries(surfaces)) {
    if (surface.tabbed) { if (typeof surface.onClosed === 'function') surface.onClosed((tab) => tabClosed(id, tab)); continue }
    if (typeof surface.bindHolder === 'function') surface.bindHolder(() => holderOf(id))
  }
  /** A page's state, made on first use (a tab's binds its holder for its downloads). Null for a closed tab. */
  const stateOf = (key) => {
    let s = state.get(key)
    if (s) return s
    const at = key.indexOf('/')
    const sid = at < 0 ? key : key.slice(0, at)
    const tab = at < 0 ? null : key.slice(at + 1)
    // (a page the bridge alone takes, with no surface here, is kept as a hold only)
    const surface = tab ? (surfaces[sid] && surfaces[sid].tabbed ? surfaces[sid].page(tab) : null) : surfaces[sid] || { personAt: () => null }
    if (!surface) throw new ComputerRefusal('stale', 'that tab was closed; nothing was done', {}, { noLook: true })
    s = { sid, tab, surface, holder: null, used_at: 0, snapshots: new Map(), chain: Promise.resolve(), party: null, personMark: null, handover: false, doing: null, pointer: null, last: null, takes: 0, inflight: 0, epoch: 0, created_at: now() }
    state.set(key, s)
    if (tab && typeof surface.bindHolder === 'function') surface.bindHolder(() => holderOf(key))
    return s
  }
  const surfaceOf = (id) => {
    const key = typeof id === 'string' && id ? id : 'browser'
    const surface = Object.prototype.hasOwnProperty.call(surfaces, key) ? surfaces[key] : null
    if (!surface) throw new ComputerRefusal('refused', `unknown surface '${key}' (there are: ${Object.keys(surfaces).join(', ')})`)
    return [key, surface]
  }
  const holderOf = (key) => {
    const s = state.get(key)
    if (!s) return null
    return s.holder !== null && now() - s.used_at < leaseMs ? s.holder : null
  }
  // who the page was last for: a session when the backend names one, else the run
  const partyOf = (body) => (typeof body.session === 'string' && body.session ? `session:${body.session}` : body.owner)
  const runOf = (owner) => {
    let r = runs.get(owner)
    if (!r) { r = { current: {}, session: null, label: null, ended: null }; runs.set(owner, r) }
    return r
  }
  /** What an owner leaves behind when it lets go (its downloads), dropped. */
  const lettingGo = (key, owner) => {
    const s = state.get(key)
    if (!s) return
    if (typeof s.surface.released === 'function') s.surface.released(owner)
    s.personMark = s.surface.personAt()
  }
  /** The page for this owner: taken when free (or already theirs), refused when another holds it. A surface last
   *  used for another session (or run) is marked to be cleared before this one's first look — unless the person used
   *  the page since: then the page is theirs to hand over. (A tab is only ever its own run's.) */
  const claim = (key, owner, party = owner) => {
    if (typeof owner !== 'string' || !owner) throw new ComputerRefusal('refused', 'an owner (the run) is required')
    const s = stateOf(key)
    const holder = holderOf(key)
    if (holder !== null && holder !== owner) throw new ComputerRefusal('busy', `the ${key} surface is in use by ${holder}; try again when it is free (it frees itself after ${Math.round(leaseMs / 1000)} s without use)`, { holder })
    // another run's pointer is not this one's (a run taking the page again after its own quiet lease keeps its own)
    if (s.holder !== owner) s.pointer = null
    if (holder !== owner) {
      log(`[computer] ${owner} takes the ${key} surface`)
      s.takes += 1
      if (s.party !== null && s.party !== party && s.surface.personAt() === s.personMark) s.handover = true
      s.party = party
      // the one before let its lease run out: it let go then
      if (s.holder !== null && s.holder !== owner) { log(`[computer] ${s.holder}'s lease of the ${key} surface ran out`); lettingGo(key, s.holder); s.epoch += 1 }
    }
    s.holder = owner
    // who the page was last held by stays after the lease runs out or the holder lets go: a person watching follows
    // the page only while it is still the one that run (and session) left it as
    s.last = { owner, party }
    s.used_at = now()
    return s.epoch
  }
  const release = (key, owner) => {
    const s = state.get(key)
    if (s && s.holder === owner) {
      // what it was doing and where its pointer went are not the page's any more; whatever it still had queued here
      // is not wanted any more, even when the same run (an approval of its action, say) takes the page again
      s.holder = null; s.pointer = null; s.doing = null; s.epoch += 1
      lettingGo(key, owner); log(`[computer] ${owner} lets go of the ${key} surface`); return true
    }
    return false
  }
  /** The surface's latest look (null before the first). */
  const latestOf = (s) => (s.snapshots.size ? [...s.snapshots.values()].pop() : null)
  /** Every page an owner holds, let go (a run that ended). Its tabs stay, for an approval of its looks and for the
   *  person, until they are idle long enough to be closed. */
  const releaseAll = (owner) => {
    const let_go = []
    for (const key of [...state.keys()]) if (release(key, owner)) let_go.push(key)
    const r = runs.get(owner)
    if (r) r.ended = now()
    return let_go
  }
  // one operation at a time on a page (two tabs are two pages)
  const serially = (key, fn) => {
    const s = stateOf(key)
    const run = s.chain.then(fn, fn)
    s.chain = run.catch(() => undefined)
    return run
  }
  /** An operation that waited its turn starts only if its run still holds the page — the same hold it queued under
   *  (a release between ends it, even when the run took the page again since) — and still waits for the answer, and
   *  its tab is still open. */
  const stillWanted = (key, owner, what, closed, epoch) => {
    if (closed && closed()) {
      log(`[computer] ${owner}'s ${what} on ${key} was dropped: its request closed before it started`)
      throw new ComputerRefusal('cancelled', 'the request was withdrawn before the action started; nothing was done')
    }
    const s = state.get(key)
    if (!s || state.get(key) !== s || (s.tab && !surfaces[s.sid].exists(s.tab))) {
      throw new ComputerRefusal('cancelled', 'the tab was closed before the action started; nothing was done', {}, { noLook: true })
    }
    if (holderOf(key) !== owner || (epoch !== undefined && s.epoch !== epoch)) {
      log(`[computer] ${owner}'s ${what} on ${key} was dropped: the run no longer holds the page`)
      throw new ComputerRefusal('cancelled', 'this run let go of the page (or another run took it) before the action started; nothing was done')
    }
  }
  /** The page cleared for a new session's (or run's) first look, when it was marked so; whether it was cleared. */
  const handOver = async (key, surface, owner) => {
    const s = stateOf(key)
    if (!s.handover) return false
    s.handover = false
    if (typeof surface.reset !== 'function' || !(await surface.reset())) return false
    log(`[computer] the ${key} surface was cleared for ${owner}: another session used it before`)
    surface.note('The browser was cleared to a blank page for this run: another session (or run) used it before. Its profile — sign-ins, cookies, site storage — is shared by every project and session.', owner)
    return true
  }
  /** An owner's operation, in its turn: started only if still wanted; what the person did on the page so far is the
   *  owner's time, not after it (a later take by another session clears it). A look hands the page over first; an
   *  action does it itself, once its checks let it go ahead — one that is refused leaves the other session's page be. */
  const turnOf = (key, surface, owner, what, closed, fn, { handOverFirst = true, epoch } = {}) => serially(key, async () => {
    stillWanted(key, owner, what, closed, epoch)
    if (handOverFirst) await handOver(key, surface, owner)
    try { return await fn() } finally { if (holderOf(key) === owner && state.get(key)) state.get(key).personMark = surface.personAt() }
  })
  /** Another run's input: the looks of every other owner no longer show the page. */
  const markForeign = (s, owner) => { for (const snap of s.snapshots.values()) if (snap.owner !== owner) snap.foreign = true }

  /** The page a surface shows now, as it names it, or null for a surface of one page. */
  const pageOf = (surface) => (typeof surface.pageId === 'function' ? surface.pageId() : null)

  // -- the agent browser's tabs ------------------------------------------------------------------------------------

  /** The run's own tabs, as its looks list them. */
  const ownTabs = (sid, owner) => {
    const current = runs.has(owner) ? runs.get(owner).current[sid] || null : null
    return surfaces[sid].tabsOf(heirOf(owner)).map((t) => ({ tab_id: t.id, url: t.url, title: t.title, current: t.id === current }))
  }
  const ownsTab = (sid, owner, tab) => typeof tab === 'string' && !!tab && surfaces[sid].exists(tab) && surfaces[sid].ownerOf(tab) === heirOf(owner)
  /** A tab closed (by the run, the person, a clear or for being idle): its looks, queue and lease are gone with it;
   *  an action or approval that names a look of it is stale. */
  function tabClosed(sid, tab) {
    const key = keyOf(sid, tab)
    const s = state.get(key)
    if (s) { s.epoch += 1; s.holder = null; s.snapshots.clear(); state.delete(key) }
    for (const [owner, r] of [...runs]) {
      if (r.current[sid] === tab) delete r.current[sid]
      // a run with no tab left anywhere and nothing under way is forgotten (its looks' index entries stay, bounded)
      const left = Object.keys(surfaces).some((id) => tabbedOf(id) && surfaces[id].tabsOf(owner).length > 0)
      const busy = [...state.values()].some((st) => st.holder === owner || st.inflight > 0)
      if (!left && !busy && Object.keys(r.current).length === 0) runs.delete(owner)
    }
    log(`[computer] ${key} closed`)
  }
  /** Agent tabs nobody holds, with nothing under way and not shown on the Browser card, idle for `idleMs`: closed.
   *  The person's own tabs are never closed here. Returns the tabs closed. */
  function reap({ idleMs = tabIdleMs } = {}) {
    const closed = []
    for (const sid of Object.keys(surfaces)) {
      if (!tabbedOf(sid)) continue
      const surface = surfaces[sid]
      for (const t of surface.all()) {
        if (t.owner === null) continue
        const key = keyOf(sid, t.id)
        const s = state.get(key)
        if (s && (holderOf(key) !== null || s.inflight > 0)) continue
        const page = surface.page(t.id)
        const seen = page && typeof page.visibility === 'function' ? page.visibility() : null
        if (seen && seen.shown) continue
        // the person's own use of the page counts as use: a tab they just typed into is not idle
        const person = page && typeof page.personAt === 'function' ? page.personAt() || 0 : 0
        const last = Math.max(t.created_at || 0, s ? s.used_at : 0, person)
        if (now() - last < idleMs) continue
        log(`[computer] ${key} was idle for ${Math.round((now() - last) / 1000)} s: closed`)
        if (surface.close(t.id)) closed.push(t.id)
      }
    }
    return closed
  }
  /** A new tab of the run's own (synchronous: two first looks at once open one tab, not two). Refused, never busy,
   *  when the run or the browser has as many tabs as it may (idle tabs are closed first to make room). */
  const openTab = (sid, body, url = null) => {
    const surface = surfaces[sid]
    const opts = { session: typeof body.session === 'string' && body.session ? body.session : null, label: typeof body.owner_label === 'string' ? body.owner_label : null, url }
    let made = surface.open(body.owner, opts)
    if (made && made.refused && made.full === 'browser') { reap(); made = surface.open(body.owner, opts) }
    if (!made || made.refused) throw new ComputerRefusal('refused', (made && made.refused) || 'no new tab could be opened', {}, { noLook: true })
    const r = runOf(body.owner)
    r.current[sid] = made.id
    r.ended = null
    if (opts.session) r.session = opts.session
    log(`[computer] ${body.owner} opened ${keyOf(sid, made.id)}`)
    return made.id
  }
  /** A run's first page in a session another run of it ended in: that run's tabs, taken over as they are (the page
   *  the person left the conversation on stays where it was), the one it was on current. Only a run that ended (let
   *  go) and has nothing held or under way; a run of the session still going keeps its own. Null: nothing to take. */
  const takeOver = (sid, body) => {
    const surface = surfaces[sid]
    if (typeof surface.adopt !== 'function' || typeof body.session !== 'string' || !body.session) return null
    if (surface.tabsOf(body.owner).length) return null
    let from = null
    for (const [owner, r] of runs) {
      if (owner === body.owner || r.ended === null || r.session !== body.session) continue
      const tabs = surface.tabsOf(owner)
      if (!tabs.length) continue
      if (tabs.some((t) => { const st = state.get(keyOf(sid, t.id)); return st && (holderOf(keyOf(sid, t.id)) !== null || st.inflight > 0) })) continue
      if (from === null || r.ended > from.r.ended) from = { owner, r, tabs }
    }
    if (from === null) return null
    const label = typeof body.owner_label === 'string' ? body.owner_label : null
    const taken = from.tabs.filter((t) => surface.adopt(t.id, body.owner, { label })).map((t) => t.id)
    if (!taken.length) return null
    heirs.set(from.owner, body.owner)
    if (heirs.size > 500) heirs.delete(heirs.keys().next().value)
    const was = from.r.current[sid]
    delete from.r.current[sid]
    const r = runOf(body.owner)
    r.current[sid] = taken.includes(was) ? was : taken[taken.length - 1]
    r.ended = null
    r.session = body.session
    log(`[computer] ${body.owner} took over ${taken.map((id) => keyOf(sid, id)).join(', ')} from ${from.owner} (its session's last run)`)
    return r.current[sid]
  }
  /** The page an operation of this owner goes to: the surface itself, or — on a tabbed surface — the tab a look it
   *  names was of (never another: a `tab_id` that differs is refused, a closed tab is stale), the tab it names (its
   *  own only), or its current tab (opened when it has none and `allocate`). An approval (`approval: true`) never
   *  opens one: the page it was for is there, or it is stale. */
  function pageFor(sid, surface, body, { allocate = true } = {}) {
    const tabId = body.tab_id === undefined || body.tab_id === null || body.tab_id === '' ? null : body.tab_id
    if (!surface.tabbed) {
      if (tabId !== null) throw new ComputerRefusal('refused', `the ${sid} surface has one page; tab_id is for the browser surface`, {}, { noLook: true })
      return sid
    }
    if (typeof body.owner !== 'string' || !body.owner) throw new ComputerRefusal('refused', 'an owner (the run) is required')
    if (tabId !== null && typeof tabId !== 'string') throw new ComputerRefusal('refused', 'tab_id is a tab id from this run\'s looks', {}, { noLook: true })
    if (clearing) throw new ComputerRefusal('busy', 'the person is clearing the browser\'s data (cookies, site storage, cache); wait, then look again', {}, { noLook: true })
    if (body.snapshot_id !== undefined && body.snapshot_id !== null && body.snapshot_id !== '') {
      const entry = snapIndex.get(String(body.snapshot_id))
      if (entry && entry.owner === body.owner && entry.sid === sid) {
        if (tabId !== null && tabId !== entry.tab) throw new ComputerRefusal('stale', `snapshot ${body.snapshot_id} is a look of tab ${entry.tab}, not of ${tabId}; nothing was done`, {}, { noLook: true })
        if (!surface.exists(entry.tab)) throw new ComputerRefusal('stale', `the tab snapshot ${body.snapshot_id} was taken of (${entry.tab}) was closed; nothing was done`, {}, { noLook: true })
        runOf(body.owner).current[sid] = entry.tab
        return keyOf(sid, entry.tab)
      }
      // a look this run does not have (another run's, another start of the app's, or one forgotten): never a fallback
      // to some page for an approval
      if (body.approval === true) throw new ComputerRefusal('stale', `snapshot ${body.snapshot_id} is not a current look of this run; nothing was done`, {}, { noLook: true })
    }
    // an approval names the page it was for (its look's tab, or the tab it was bound to): never the run's current tab
    if (body.approval === true && tabId === null) throw new ComputerRefusal('stale', 'this approval names no page of this run (no look, no tab); nothing was done', {}, { noLook: true })
    if (body.approval === true && !ownsTab(sid, body.owner, tabId)) throw new ComputerRefusal('stale', `the tab this approval was for (${String(tabId).slice(0, 40)}) is closed; nothing was done`, {}, { noLook: true })
    if (tabId !== null) {
      if (!ownsTab(sid, body.owner, tabId)) throw new ComputerRefusal('refused', `this run has no tab ${String(tabId).slice(0, 40)} (a run sees and acts on its own tabs only; its looks list them)`, {}, { noLook: true })
      runOf(body.owner).current[sid] = tabId
      return keyOf(sid, tabId)
    }
    const current = runs.has(body.owner) ? runs.get(body.owner).current[sid] : null
    if (current && ownsTab(sid, body.owner, current)) return keyOf(sid, current)
    if (!allocate || body.approval === true) throw new ComputerRefusal('stale', 'this run has no open tab for that (it was closed); nothing was done', {}, { noLook: true })
    return keyOf(sid, takeOver(sid, body) || openTab(sid, body))
  }
  /** An operation of an owner on a page counted while it waits and runs (a clear of the browser's data waits for
   *  none and is refused while any is). */
  const counted = async (key, fn) => {
    const s = stateOf(key)
    s.inflight += 1
    try { return await fn() } finally { s.inflight -= 1 }
  }

  async function look(key, surface, owner, { screenshot = true } = {}) {
    surface.open()
    const s = stateOf(key)
    const sid = s.sid
    const events = surface.events(owner)
    // the page's generation is read before the reads: a navigation between them takes the look again (once), and a
    // look still straddling one is kept with the generation before it, so an action on it is stale
    let taken = null
    for (let attempt = 0; ; attempt += 1) {
      // the page shown, its driver and its generation, read together (nothing awaited between): every read of this
      // attempt is of that page — a tab the person shows meanwhile is another attempt, never a mix of the two
      const driver = surface.open()
      const generation = surface.generation()
      const page = pageOf(surface)
      const dialog = surface.peek().dialog
      // a JavaScript dialog holds the page: it answers nothing (no picture, no outline, no size) until it is answered
      let info = dialog ? { ...driver.shallowInfo(), viewport: s.viewport || { width: 0, height: 0 } } : await driver.info()
      // a page still loading (just opened, say) is looked at once it has loaded: a look taken mid-load goes stale at once
      if (!dialog && info.loading) { await driver.settle(); info = await driver.info() }
      // where things are, read on both sides of the picture and the outline (a look without a picture too: an x, y
      // may be chosen on an earlier picture or the outline): an x, y is checked against them, and a point where they
      // differ moved under the look. A read that fails leaves the look unable to check a point (`unread`): an x, y on
      // it is refused, never let through unchecked.
      let unread = false
      const layoutOf = async () => (!dialog && driver.layout ? driver.layout().catch(() => { unread = true; return null }) : null)
      const before = await layoutOf()
      const captured = screenshot && !dialog ? await driver.screenshot({ width: info.viewport.width, height: info.viewport.height }, { displayImage: sid === 'browser' }) : null
      // The model's image defines x/y. The thread's sharper copy is kept beside it, from the same capture.
      const { display_image: displayImage, ...agentImage } = captured || {}
      const image = captured ? agentImage : null
      const outline = dialog ? { text: '', refs: new Set(), lines: new Map() } : outlineOfFrames(await driver.tree())
      const after = before ? await layoutOf() : null
      const boxesOf = (layout) => { const boxes = new Map(); for (const ref of outline.refs) if (layout.has(ref)) boxes.set(ref, layout.get(ref)); return boxes }
      const read = before && after
      // the viewport read again once the picture and the outline are in: a page resized meanwhile (the card dragged
      // larger) may have drawn another size than the one the picture is scaled by — taken again, or kept unusable
      const settled = dialog ? info.viewport : (await driver.info()).viewport
      const resized = settled.width !== info.viewport.width || settled.height !== info.viewport.height
      taken = { generation, page, dialog, info, image, displayImage, outline, boxes: read ? boxesOf(before) : null, boxesAfter: read ? boxesOf(after) : null, unread, resized }
      if ((surface.generation() === generation && pageOf(surface) === page && !resized) || attempt >= LOOK_RETAKES) break
    }
    const { info, image, displayImage, outline, dialog } = taken
    s.viewport = info.viewport
    const count = (counts.get(sid) || 0) + 1
    counts.set(sid, count)
    const snapshotId = `${sid}-${instance}-${count}`
    const scale = image ? { x: info.viewport.width / image.width, y: info.viewport.height / image.height } : { x: 1, y: 1 }
    s.snapshots.set(snapshotId, {
      owner, generation: taken.generation, page: taken.page, resized: taken.resized, viewport: info.viewport, refs: outline.refs, lines: outline.lines, boxes: taken.boxes, boxesAfter: taken.boxesAfter, unread: taken.unread, scale, at: now(),
      dialog: dialog ? { type: dialog.type, message: dialog.message, seq: dialog.seq } : null, used: false, foreign: false,
    })
    while (s.snapshots.size > KEEP_SNAPSHOTS) s.snapshots.delete(s.snapshots.keys().next().value)
    snapIndex.set(snapshotId, { key, sid, tab: s.tab, owner })
    while (snapIndex.size > KEEP_SNAPSHOT_INDEX) snapIndex.delete(snapIndex.keys().next().value)
    const notes = [...events.notes]
    if (events.chooser) notes.push('A file chooser is open: `upload` with the files puts them in it.')
    // a page never shown draws only when looked at (seen 2026-10-01: its requestAnimationFrame hardly runs)
    const seen = typeof surface.visibility === 'function' ? surface.visibility() : null
    if (seen && !seen.shown && !seen.ever) notes.push('This page has never been shown on screen (the Browser card was not opened): it draws only when looked at, so its animations may not run.')
    return {
      surface: sid, ...(s.tab ? { tab_id: s.tab, tabs: ownTabs(sid, owner) } : {}), snapshot_id: snapshotId, url: info.url, title: info.title, loading: !!info.loading,
      viewport: info.viewport, ...(info.scroll ? { scroll: info.scroll } : {}), image, ...(displayImage ? { display_image: displayImage } : {}), outline: outline.text, dialog: dialog || null, notes,
      ...(events.downloads && events.downloads.length ? { downloads: events.downloads } : {}),
      ...(events.console && events.console.length ? { console: events.console } : {}),
    }
  }

  async function observe(body = {}, { closed = null } = {}) {
    try {
      const [sid, surface] = surfaceOf(body.surface)
      const key = pageFor(sid, surface, body)
      const s = stateOf(key)
      const epoch = claim(key, body.owner, partyOf(body))
      return await counted(key, () => turnOf(key, s.surface, body.owner, 'look', closed, async () => ({ status: 'ok', ...(await look(key, s.surface, body.owner, { screenshot: body.screenshot !== false })) }), { epoch }))
    } catch (error) {
      return refusalOf(error)
    }
  }
  /** The look an action names, if it still shows the page to this owner; else stale. */
  function currentLook(id, surface, s, body, action) {
    const snapshot = body.snapshot_id ? s.snapshots.get(String(body.snapshot_id)) : null
    if (!snapshot) throw new ComputerRefusal('stale', body.snapshot_id ? `snapshot ${body.snapshot_id} is not a current look of the ${s.sid} surface${s.tab ? ` (tab ${s.tab})` : ''}` : `${action === 'dialog' ? 'answering a dialog' : 'an input action'} needs the snapshot_id of the look it was chosen on`)
    if (snapshot.owner !== body.owner) throw new ComputerRefusal('stale', `snapshot ${body.snapshot_id} is another run's look; nothing was done`)
    if (snapshot.used) throw new ComputerRefusal('stale', `snapshot ${body.snapshot_id} was used by an earlier action (every action answers with a new look: name that one); nothing was done`)
    if (snapshot.foreign) throw new ComputerRefusal('stale', 'another run acted on the page since that look; nothing was done')
    if (snapshot.page !== pageOf(surface)) throw new ComputerRefusal('stale', s.tab ? 'the page navigated since that look (another document in its tab); nothing was done' : 'the browser shows another tab since that look; nothing was done')
    if (snapshot.resized) throw new ComputerRefusal('stale', 'the page was resized while that look was taken (the picture may be of another size); nothing was done')
    if (snapshot.generation !== surface.generation()) throw new ComputerRefusal('stale', 'the page changed since that look (it navigated, the person used it or a dialog opened); nothing was done')
    return snapshot
  }

  /** The element is still the one the look showed (its line in the outline, the focus aside); else stale. */
  async function sameElement(driver, snapshot, node, what) {
    const was = snapshot.lines ? snapshot.lines.get(node) : undefined
    if (was === undefined || !driver.axNode) return
    let ax
    try { ax = await driver.axNode(node) } catch { throw new ComputerRefusal('stale', `${what} is no longer on the page (that look showed \`${was}\`); nothing was done`) }
    if (!ax) return
    const is = lineOf(ax, { focus: false })
    if (is !== was) throw new ComputerRefusal('stale', `${what} is not what that look showed (it was \`${was}\`, it is \`${is}\` now); nothing was done`)
  }

  /** The element takes this input now: not disabled (nor, for typing, read-only); else not_actionable. */
  async function takesInput(driver, node, what, need) {
    if (!driver.state || (need !== 'click' && need !== 'type')) return
    let st
    try { st = await driver.state(node) } catch { throw new ComputerRefusal('stale', `${what} is no longer on the page; nothing was done`) }
    if (st.disabled) throw new ComputerRefusal('not_actionable', `${what} (${st.desc}) is disabled; nothing was done`)
    if (need === 'type' && st.readonly) throw new ComputerRefusal('not_actionable', `${what} (${st.desc}) is read-only; nothing was done`)
  }

  /** What is at a page point now is what the look had there: the look's element whose box held the point (and is
   *  still that element), or — where the look had none — no control that came or moved there since. Returns what is
   *  there (null: nothing, or no way to tell). */
  async function samePoint(driver, snapshot, x, y, need) {
    if (!driver.nodeAt) return null
    if (snapshot.unread) throw new ComputerRefusal('stale', 'where things were on the page could not be read when that look was taken, so a point on it cannot be checked; nothing was done — look again, or name a ref')
    // the smallest of the look's elements whose box holds the point
    const under = (boxes) => {
      let found = null
      let area = Infinity
      for (const [node, b] of boxes) if (x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height && b.width * b.height < area) { found = node; area = b.width * b.height }
      return found
    }
    const was = snapshot.boxes ? under(snapshot.boxes) : null
    if (snapshot.boxesAfter && under(snapshot.boxesAfter) !== was) throw new ComputerRefusal('stale', 'the page moved at that point while that look was taken (the picture may not show what is there); nothing was done')
    const at = await driver.nodeAt(x, y, was)
    if (!at) return null
    if ((need === 'click' || need === 'type') && at.disabled) throw new ComputerRefusal('not_actionable', `what is at that point (${at.desc}) is disabled; nothing was done`)
    if (need === 'type' && at.readonly) throw new ComputerRefusal('not_actionable', `what is at that point (${at.desc}) is read-only; nothing was done`)
    if (!snapshot.boxes) return at
    if (was !== null) {
      if (!at.inside) throw new ComputerRefusal('stale', `at that point the look had \`${snapshot.lines.get(was) || 'an element'}\`; the page has ${at.desc} there now; nothing was done`)
      await sameElement(driver, snapshot, was, 'the element at that point')
    } else if (at.control !== null && !at.other_site && (snapshot.boxes.has(at.control) || !snapshot.refs.has(at.control))) {
      throw new ComputerRefusal('stale', `at that point the page now has ${at.desc}, which that look did not have there; nothing was done`)
    }
    return at
  }

  /** The page point an action names: a ref of the look (its node's middle, scrolled into view, once it holds still)
   *  or x/y in the look's screenshot pixels. `need` says what is checked first: 'click' (the element or what is at the
   *  point is the look's, and enabled), 'type' (and not read-only), 'look' (the look's only), none. `recheck` hit-tests
   *  the point again right before a press. */
  async function pointOf(driver, snapshot, body, { ref = body.ref, x: bx = body.x, y: by = body.y, what = 'the element', need = null } = {}) {
    if (ref !== undefined && ref !== null && ref !== '') {
      const node = nodeOfRef(ref)
      if (node === null || !snapshot.refs.has(node)) throw new ComputerRefusal('refused', `ref ${ref} is not one of the snapshot's refs`)
      if (need) await sameElement(driver, snapshot, node, ref)
      if (need) await takesInput(driver, node, ref, need)
      const at = await actionable(driver, node, ref)
      const recheck = async () => {
        const hit = driver.hitTest ? await driver.hitTest(node, at.x, at.y) : { ok: true }
        if (!hit.ok) throw new ComputerRefusal('covered', `${ref} is covered at its middle by ${hit.covering || 'another element'}; nothing was pressed — close or move what covers it, or scroll`, { covering: hit.covering || null })
      }
      return { ...at, node, recheck, otherSite: false }
    }
    const x = Number(bx)
    const y = Number(by)
    if (bx === null || bx === undefined || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) throw new ComputerRefusal('refused', `give ${what} as a ref from the snapshot, or x and y in the screenshot's pixels`)
    // a point past the picture's right or bottom edge is no point of the page that look showed (it would land on
    // whatever lies there — the page's root)
    if (snapshot.viewport) {
      const width = Math.round(snapshot.viewport.width / snapshot.scale.x)
      const height = Math.round(snapshot.viewport.height / snapshot.scale.y)
      if (x >= width || y >= height) throw new ComputerRefusal('refused', `${what} at x ${x}, y ${y} is outside the screenshot (${width}×${height} pixels); nothing was done`)
    }
    const px = x * snapshot.scale.x
    const py = y * snapshot.scale.y
    const there = need ? await samePoint(driver, snapshot, px, py, need) : null
    return { x: px, y: py, node: null, recheck: null, otherSite: !!(there && there.other_site) }
  }

  /** Where an element takes a click: its box's middle, scrolled into view, once the box has held still for a while
   *  and the element (or something inside it) is what the page has at that point (under something pinned to the
   *  view, it is scrolled to the view's middle once first); else refused — `covered` (with what covers it),
   *  `unstable` (it never held still), or no box at all. */
  async function actionable(driver, node, ref) {
    const deadline = now() + ACTIONABLE_MS
    let still = null
    let hit = null
    let centred = false
    for (;;) {
      const box = await driver.box(node)
      if (!box) throw new ComputerRefusal('refused', `the element ${ref} has no box on the page (hidden, or gone)`)
      if (still === null || Math.abs(box.x - still.x) >= 1 || Math.abs(box.y - still.y) >= 1) still = { x: box.x, y: box.y, since: now() }
      else if (now() - still.since >= STEADY_MS) {
        hit = driver.hitTest ? await driver.hitTest(node, box.x, box.y) : { ok: true }
        if (hit.ok) return { x: box.x, y: box.y }
        // a header or bar pinned to the view (fixed, sticky) over it: scrolled to the view's middle once, from under
        // it, and looked at again (it must hold still there too)
        if (hit.pinned && !centred && driver.centre) { centred = true; await driver.centre(node); still = null; continue }
      }
      if (now() >= deadline) break
      await settle(SAMPLE_MS)
    }
    if (hit && !hit.ok) throw new ComputerRefusal('covered', `${ref} is covered at its middle by ${hit.covering || 'another element'}; nothing was done — close or move what covers it, or scroll`, { covering: hit.covering || null })
    throw new ComputerRefusal('unstable', `${ref} did not hold still for ${STEADY_MS} ms within ${ACTIONABLE_MS / 1000} s (it moves: an animation, a carousel); nothing was done — wait for it to stop, or act another way`)
  }

  /** Where the agent's pointer goes for an action (viewport CSS pixels): what a person watching sees move. */
  const pointTo = (id, at, action) => { stateOf(id).pointer = { x: Math.round(at.x), y: Math.round(at.y), action, at: now() } }

  /** What an action is on, in a few words, for a person watching. */
  const targetOf = (body) => {
    const target = [body.ref, body.url, body.keys, body.text].find((v) => typeof v === 'string' && v)
    return target ? clip(target, 60) : null
  }

  /** Whether a wait's condition holds now. */
  async function conditionMet(id, surface, driver, snapshot, body, start) {
    if (typeof body.url === 'string' && body.url) return String((await driver.shallowInfo()).url || '').includes(body.url)
    if (body.download) return surface.downloadsDone(body.owner) > start.downloads
    if (body.ref) {
      const node = nodeOfRef(body.ref)
      return !(await driver.box(node))
    }
    // the page's words and its controls' names (a stop button is a label, not words on the page)
    const words = String(await (driver.pageWords ? driver.pageWords() : driver.readText(null)) ?? '')
    return body.gone ? !words.includes(body.text) : words.includes(body.text)
  }

  /** Text typed into the field the action names (or the focused one). Each step — the press, the clearing (before
   *  its select-all and again before its delete), the typing, Enter — is sent only while the field still has the
   *  focus and the person has not used the page, checked as the driver's last word before it sends; else the typing
   *  stops and says what was done. The caret goes to the end of the field's text unless the field is cleared; what
   *  landed is read back. */
  async function typeInto(id, surface, driver, snapshot, body, { personFrom }) {
    const text = typeof body.text === 'string' ? body.text : ''
    if (!text && !body.clear) throw new ComputerRefusal('refused', 'type needs text')
    if (text.length > TYPE_MAX_CHARS) throw new ComputerRefusal('refused', `the text is ${text.length} characters; type takes up to ${TYPE_MAX_CHARS}`)
    const steps = []
    const personCame = (next) => {
      if (surface.personAt() !== personFrom) throw new ComputerRefusal('person_active', `the person used the page while the agent typed; stopped before ${next} (${doneSoFar(steps)})`, { done: { steps: [...steps] } })
    }
    let target = null
    if (body.ref || (body.x !== undefined && body.x !== null)) {
      const at = await pointOf(driver, snapshot, body, { need: 'type' })
      pointTo(id, at, 'click')
      await driver.click(at.x, at.y, { button: 'left', count: 1, beforePress: async () => { if (at.recheck) await at.recheck(); personCame('clicking the field') } })
      steps.push('clicked the field')
      // a click that did not leave the field focused (a label over it, a custom widget) is followed by a focus
      if (at.node !== null && driver.focus) await driver.focus(at.node)
      target = at.node
    }
    const field = driver.activeElement ? await driver.activeElement() : { node: null, desc: '' }
    const holder = target ?? field.node
    // the check a step's dispatch makes as its last word: the field still focused, the person not on the page
    const goOn = (next) => async () => {
      if (holder !== null && driver.holdsFocus && !(await driver.holdsFocus(holder))) {
        personCame(next)
        const focused = await driver.activeElement()
        throw new ComputerRefusal('not_actionable', `the focus left the field (it is on ${focused.desc} now); stopped before ${next} (${doneSoFar(steps)})`, { done: { steps: [...steps] } })
      }
      personCame(next)
    }
    if (text && target === null && field.node !== null && /^(body|html)\b/.test(field.desc)) throw new ComputerRefusal('not_actionable', 'no field has the focus (it is on the page itself): name the field by ref, or x and y; nothing was done')
    const before = text && field.node !== null && driver.fieldValue ? await driver.fieldValue(field.node) : { value: null }
    if (body.clear) {
      await driver.clearFocused({ before: goOn('clearing the field'), beforeDelete: goOn('clearing the field') })
      steps.push('cleared it')
    } else if (field.node !== null && driver.caretToEnd) await driver.caretToEnd(field.node)
    let typed = text.length
    let cleared = !!body.clear
    if (text) {
      await driver.insertText(text, { before: goOn('typing') })
      steps.push(`typed ${text.length} characters`)
      if (before.value !== null) {
        const after = await driver.fieldValue(field.node)
        if (after.value !== null) {
          const base = body.clear ? '' : before.value
          // told by what the typing changed, never by the text being somewhere in the field (it may have been there
          // before: a field that took nothing still holds it)
          const changed = after.value !== before.value || (body.clear && after.value === text)
          const grew = after.value.length - base.length
          typed = !changed ? 0 : after.value === base + text || (after.value.includes(text) && grew >= text.length) ? text.length : Math.max(0, Math.min(text.length, grew))
          if (body.clear) cleared = after.value === text || before.value === '' || !after.value.includes(before.value)
          if (typed === 0) {
            steps[steps.length - 1] = `sent ${text.length} characters (none landed)`
            personCame('pressing Enter')
            const focused = await driver.activeElement()
            throw new ComputerRefusal('not_actionable', `the text did not land in ${field.desc} (its value did not change; the focus is on ${focused.desc}); ${doneSoFar(steps)}`, { done: { steps: [...steps], typed: 0 } })
          }
        }
      }
    }
    if (body.submit) { await driver.key('Enter', { before: goOn('pressing Enter') }); steps.push('pressed Enter') }
    const into = field.node !== null ? field.desc : null
    return { typed, cleared, submitted: !!body.submit, ...(into ? { into } : {}), ...(typed < text.length ? { note: `${typed} of the ${text.length} characters are in the field (it may limit or reformat what is typed)` } : {}) }
  }

  async function perform(id, surface, driver, snapshot, action, body, ctx) {
    switch (action) {
      case 'click': case 'double_click': case 'right_click': {
        const at = await pointOf(driver, snapshot, body, { need: 'click' })
        pointTo(id, at, action)
        // another site's frame takes input through the browser's own routing: whether it got the press is asked of it
        const received = at.otherSite && driver.armOtherFrames ? await driver.armOtherFrames() : null
        // the last word before the press: still where the element takes it, and the person not on the page
        const beforePress = async () => {
          if (at.recheck) await at.recheck()
          if (surface.personAt() !== ctx.personFrom) throw new ComputerRefusal('person_active', 'the person used the page as the agent was about to click; nothing was pressed')
        }
        await driver.click(at.x, at.y, { button: action === 'right_click' ? 'right' : 'left', count: action === 'double_click' ? 2 : 1, beforePress })
        const clicked = body.ref ? String(body.ref) : { x: Math.round(at.x), y: Math.round(at.y) }
        if (received && (await received()) === false) throw new ComputerRefusal('not_actionable', 'the click at that point was sent to another site\'s frame, and the frame did not receive it; look again before trying anything else', { done: { clicked, received: false } })
        return { clicked }
      }
      case 'hover': {
        const at = await pointOf(driver, snapshot, body)
        pointTo(id, at, action)
        await driver.move(at.x, at.y)
        return { hovered: body.ref ? String(body.ref) : { x: Math.round(at.x), y: Math.round(at.y) } }
      }
      case 'type': return typeInto(id, surface, driver, snapshot, body, ctx)
      case 'key': {
        const keys = typeof body.keys === 'string' ? body.keys.trim() : ''
        if (!keys) throw new ComputerRefusal('refused', 'key needs keys, like "Enter", "Escape" or "Meta+A"')
        await driver.key(keys)
        return { pressed: keys }
      }
      case 'scroll': {
        const dx = Number.isFinite(Number(body.dx)) ? Number(body.dx) : 0
        const dy = Number.isFinite(Number(body.dy)) ? Number(body.dy) : (dx ? 0 : 600)
        const info = await driver.info()
        const at = body.ref || (body.x !== undefined && body.x !== null) ? await pointOf(driver, snapshot, body) : { x: info.viewport.width / 2, y: info.viewport.height / 2 }
        pointTo(id, at, action)
        await driver.scroll(at.x, at.y, dx, dy)
        return { scrolled: { dx, dy } }
      }
      case 'select': {
        const choice = typeof body.text === 'string' ? body.text : ''
        const node = body.ref ? nodeOfRef(body.ref) : null
        if (node === null || !snapshot.refs.has(node)) throw new ComputerRefusal('refused', 'select needs the ref of a select element from the snapshot')
        if (!choice) throw new ComputerRefusal('refused', 'select needs text: the option\'s label or value')
        await sameElement(driver, snapshot, node, body.ref)
        await takesInput(driver, node, body.ref, 'click')
        const picked = await driver.selectOption(node, choice)
        if (!picked.ok) throw new ComputerRefusal(picked.disabled ? 'not_actionable' : 'refused', picked.disabled ? `${body.ref}: ${picked.reason}; nothing was done` : picked.reason)
        return { selected: picked.label }
      }
      case 'drag': {
        const from = await pointOf(driver, snapshot, body, { what: 'where to drag from', need: 'look' })
        const to = await pointOf(driver, snapshot, body, { ref: body.to_ref ?? null, x: body.to_x ?? null, y: body.to_y ?? null, what: 'where to drop (to_ref, or to_x and to_y)' })
        pointTo(id, from, action)
        await driver.drag(from, to)
        pointTo(id, to, action)
        return { dragged: { from: body.ref || { x: Math.round(from.x), y: Math.round(from.y) }, to: body.to_ref || { x: Math.round(to.x), y: Math.round(to.y) } } }
      }
      case 'upload': {
        const files = Array.isArray(body.files) ? body.files.filter((f) => typeof f === 'string' && f) : []
        if (!files.length || files.length > MAX_FILES) throw new ComputerRefusal('refused', `upload takes 1 to ${MAX_FILES} files`)
        const node = body.ref ? nodeOfRef(body.ref) : null
        if (body.ref && (node === null || !snapshot.refs.has(node))) throw new ComputerRefusal('refused', `ref ${body.ref} is not one of the snapshot's refs`)
        if (node !== null) await sameElement(driver, snapshot, node, body.ref)
        const chooser = surface.peek().chooser
        const target = node ?? (chooser ? chooser.node : null)
        if (target === null) throw new ComputerRefusal('refused', 'no file chooser is open: click the page\'s attach or upload control first (or name a file input\'s ref)')
        await driver.setFiles(target, files)
        surface.chooserUsed()
        return { uploaded: files.length }
      }
      case 'navigate': {
        const url = typeof body.url === 'string' ? body.url.trim() : ''
        if (!url) throw new ComputerRefusal('refused', 'navigate needs a url')
        if (!surface.allowsUrl(url)) throw new ComputerRefusal('refused', `the ${ctx.sid || id} surface does not open ${url.slice(0, 200)}`)
        await driver.navigate(url)
        return { navigated: url }
      }
      case 'back': await driver.history(-1); return { went: 'back' }
      case 'forward': await driver.history(1); return { went: 'forward' }
      case 'reload': await driver.reload(); return { reloaded: true }
      case 'dialog': {
        const dialog = surface.peek().dialog
        await driver.answerDialog(body.accept !== false, typeof body.text === 'string' ? body.text : undefined)
        return { dialog: dialog.type, accepted: body.accept !== false }
      }
      case 'wait': {
        const until = (typeof body.text === 'string' && body.text) || (typeof body.url === 'string' && body.url) || body.ref || body.download
        const failed = () => (typeof surface.downloadsFailed === 'function' ? surface.downloadsFailed(body.owner) : 0)
        const start = { at: now(), downloads: surface.downloadsDone(body.owner), failed: failed() }
        const waited = () => Math.round((now() - start.at) / 100) / 10
        // the person using the page ends any wait: the agent looks again before it does anything
        const personCame = (extra) => { if (surface.personAt() !== ctx.personFrom) throw new ComputerRefusal('person_active', 'the person used the page during the wait; the wait ended — look again before acting', { done: { waited_s: waited(), met: false, ...extra } }) }
        if (!until) {
          const seconds = Math.max(0, Math.min(WAIT_MAX_S, Number(body.seconds) || 1))
          while (now() - start.at < seconds * 1000) {
            personCame({})
            if (holderOf(id) !== body.owner || (ctx.closed && ctx.closed())) return { waited_s: waited(), ended: 'the run let go of the page' }
            await settle(Math.min(WAIT_EVERY_MS, seconds * 1000 - (now() - start.at)))
          }
          personCame({})
          return { waited_s: seconds }
        }
        if (body.ref && (nodeOfRef(body.ref) === null || !snapshot.refs.has(nodeOfRef(body.ref)))) throw new ComputerRefusal('refused', `ref ${body.ref} is not one of the snapshot's refs`)
        const limit = Math.max(1, Math.min(WAIT_UNTIL_MAX_S, Number(body.seconds) || 30))
        const condition = body.url ? `the address contains "${body.url}"` : body.download ? 'a download finished' : body.ref ? `${body.ref} is gone` : `"${String(body.text).slice(0, 80)}" ${body.gone ? 'is gone from' : 'shows on'} the page`
        for (;;) {
          if (await conditionMet(id, surface, driver, snapshot, body, start)) return { waited_s: waited(), met: true, condition }
          if (body.download && failed() > start.failed) return { waited_s: waited(), met: false, condition, ended: 'a download did not finish (the notes say why)' }
          personCame({ condition })
          // the run let go (it ended, or was stopped), or stopped waiting for the answer: the wait ends with it
          if (holderOf(id) !== body.owner || (ctx.closed && ctx.closed())) return { waited_s: waited(), met: false, condition, ended: 'the run let go of the page' }
          if (now() - start.at >= limit * 1000) return { waited_s: limit, met: false, condition }
          await settle(WAIT_EVERY_MS)
          stateOf(id).used_at = now()
        }
      }
      default: throw new ComputerRefusal('refused', `unknown action '${action}'`)
    }
  }

  /** The agent browser's own tab actions: open a tab of the run's own (its look comes back), make one of its own the
   *  current one (its look), close one of its own (its tabs come back). Never another run's tab. */
  async function tabAction(sid, surface, action, body, closed, setTarget) {
    if (!surface.tabbed) throw new ComputerRefusal('refused', `the ${sid} surface has one page; ${action} is for the browser surface`, {}, { noLook: true })
    if (clearing) throw new ComputerRefusal('busy', 'the person is clearing the browser\'s data (cookies, site storage, cache); wait, then look again', {}, { noLook: true })
    if (action === 'tab_new') {
      const url = typeof body.url === 'string' && body.url.trim() ? body.url.trim() : null
      if (url !== null && !surface.allowsUrl(url)) throw new ComputerRefusal('refused', `the ${sid} surface does not open ${url.slice(0, 200)}`, {}, { noLook: true })
      const tab = openTab(sid, body, url)
      const key = keyOf(sid, tab)
      setTarget(key)
      const s = stateOf(key)
      const epoch = claim(key, body.owner, partyOf(body))
      return counted(key, () => turnOf(key, s.surface, body.owner, action, closed, async () => {
        if (url !== null) await s.surface.open().settle()
        s.used_at = now()
        return { status: 'ok', action, done: { opened: tab, ...(url !== null ? { url } : {}) }, ...(await look(key, s.surface, body.owner, { screenshot: body.screenshot !== false })) }
      }, { epoch }))
    }
    if (typeof body.tab_id !== 'string' || !body.tab_id) {
      if (action === 'tab_select') throw new ComputerRefusal('refused', 'tab_select needs tab_id: one of this run\'s tabs (its looks list them)', {}, { noLook: true })
    }
    // the tab named (its own), or for tab_close the current one: never a look's fallback
    const key = pageFor(sid, surface, { ...body, snapshot_id: null }, { allocate: false })
    const s = stateOf(key)
    const tab = s.tab
    if (action === 'tab_select') {
      setTarget(key)
      const epoch = claim(key, body.owner, partyOf(body))
      return counted(key, () => turnOf(key, s.surface, body.owner, action, closed, async () => ({ status: 'ok', action, done: { selected: tab }, ...(await look(key, s.surface, body.owner, { screenshot: body.screenshot !== false })) }), { epoch }))
    }
    // tab_close: in the tab's turn (what is queued on it before goes first); its looks go with it
    const epoch = claim(key, body.owner, partyOf(body))
    return counted(key, () => turnOf(key, s.surface, body.owner, action, closed, async () => {
      release(key, body.owner)
      surface.close(tab)
      const r = runOf(body.owner)
      const left = surface.tabsOf(heirOf(body.owner))
      if (!r.current[sid] && left.length) r.current[sid] = left[left.length - 1].id
      return { status: 'ok', surface: sid, action, done: { closed: tab }, ...(r.current[sid] ? { tab_id: r.current[sid] } : {}), tabs: ownTabs(sid, body.owner) }
    }, { epoch }))
  }

  async function act(body = {}, { closed = null } = {}) {
    // the page this action is on, once known: a refusal's fresh look is of it — never of another run's page, nor of a
    // page opened for the refusal
    let target = null
    try {
      const [sid, surface] = surfaceOf(body.surface)
      const action = typeof body.action === 'string' ? body.action : ''
      if (!ACTIONS.includes(action)) throw new ComputerRefusal('refused', `unknown action '${action}' (the actions: ${ACTIONS.join(', ')})`)
      if (action === 'release') {
        if (!surface.tabbed) return { status: 'ok', surface: sid, released: release(sid, body.owner) }
        let let_go = false
        for (const [key, st] of [...state]) if (st.sid === sid && release(key, body.owner)) let_go = true
        return { status: 'ok', surface: sid, released: let_go }
      }
      if (TAB_ACTIONS.has(action)) return await tabAction(sid, surface, action, body, closed, (key) => { target = key })
      const key = pageFor(sid, surface, body)
      target = key
      const s = stateOf(key)
      const id = key
      const page0 = s.surface
      const epoch = claim(key, body.owner, partyOf(body))
      return await counted(key, () => turnOf(key, page0, body.owner, action, closed, async () => {
        const surface = page0
        if (action === 'read_text') {
          await handOver(id, surface, body.owner)
          const driver = surface.open()
          const node = body.ref ? nodeOfRef(body.ref) : null
          const snapshot = body.snapshot_id ? s.snapshots.get(String(body.snapshot_id)) : latestOf(s)
          if (body.ref && (node === null || !snapshot || !snapshot.refs.has(node))) throw new ComputerRefusal('refused', `ref ${body.ref} is not one of that snapshot's refs`)
          const whole = String(await driver.readText(node) ?? '')
          const offset = Math.max(0, Math.trunc(Number(body.offset) || 0))
          const text = whole.slice(offset, offset + READ_CHARS)
          return { status: 'ok', surface: sid, ...(s.tab ? { tab_id: s.tab } : {}), action, text, offset, total_chars: whole.length, next_offset: offset + text.length < whole.length ? offset + text.length : null }
        }
        const busy = await surface.busy()
        if (busy) throw new ComputerRefusal('busy', busy)
        const person = surface.personAt()
        if (person !== null && now() - person < personQuietMs) throw new ComputerRefusal('person_active', 'the person is using this page right now; nothing was done — wait, then look again')
        const none = { refs: new Set(), lines: new Map(), boxes: null, scale: { x: 1, y: 1 } }
        // an action that changes nothing (a wait) may name a ref of the latest look without its snapshot_id
        const snapshot = NEEDS_LOOK.has(action) ? currentLook(id, surface, s, body, action)
          : body.snapshot_id ? s.snapshots.get(String(body.snapshot_id)) ?? none : (action === 'wait' ? latestOf(s) ?? none : none)
        const page = surface.open()
        // the page opened for the action is the look's (the tab shown when it was taken), checked again as the last
        // word before every step that reaches the page: a tab the person shows meanwhile stops it
        let acted = false
        const onLookPage = () => {
          if (snapshot === none || !NEEDS_LOOK.has(action) || pageOf(surface) === snapshot.page) return
          if (s.tab) throw new ComputerRefusal('stale', acted ? 'the page navigated (another document in its tab); the action stopped (part of it may have been done) — look again' : 'the page navigated since that look (another document in its tab); nothing was done')
          throw new ComputerRefusal('stale', acted ? 'the browser shows another tab now; the action stopped (part of it may have been done) — look again' : 'the browser shows another tab since that look; nothing was done')
        }
        onLookPage()
        // the agent's browser may have become busy while the action waited for its element (the person began picking
        // an element on the card): asked again as the last word before each step reaches the page
        const stillFree = async () => {
          if (pageOf(surface) === null) return
          const now = await surface.busy()
          if (now) throw new ComputerRefusal('busy', acted ? `${now} (the action stopped; part of it may have been done)` : now)
        }
        if (INPUT_ACTIONS.has(action)) {
          const { viewport } = await page.info()
          if (viewport.width !== snapshot.viewport.width || viewport.height !== snapshot.viewport.height) throw new ComputerRefusal('stale', 'the page was resized since that look; nothing was done')
        }
        if (action === 'dialog') {
          const open = surface.peek().dialog
          if (!open) throw new ComputerRefusal('refused', 'no dialog is open')
          const shown = snapshot.dialog
          if (!shown || shown.seq !== open.seq || shown.type !== open.type || shown.message !== open.message) throw new ComputerRefusal('stale', `the dialog open now (${open.type}: "${clip(open.message, 120)}") is not the one that look showed; nothing was done`)
        }
        // the action goes ahead: a page another session used is cleared for it first — and what a look showed of the
        // page before is gone with it
        if (await handOver(id, surface, body.owner) && NEEDS_LOOK.has(action)) throw new ComputerRefusal('stale', 'the page was cleared for this session (another session used it before); nothing was done')
        // the first change to the page uses the look up, and makes every other run's looks stale
        const changed = () => { if (!acted) { acted = true; if (snapshot !== none) snapshot.used = true; markForeign(s, body.owner) } }
        const driver = { ...page }
        // a step's own last word (before a press, a key, the typing, a delete) checks the page too
        const lastWord = (opts) => {
          if (!opts || typeof opts !== 'object') return opts
          const out = { ...opts }
          for (const hook of ['beforePress', 'before', 'beforeDelete']) if (typeof opts[hook] === 'function') out[hook] = async (...a) => { await opts[hook](...a); onLookPage(); await stillFree() }
          return out
        }
        for (const name of INPUT_CALLS) if (typeof page[name] === 'function') driver[name] = (...args) => { onLookPage(); const last = args.length - 1; if (last >= 0 && args[last] && typeof args[last] === 'object' && !Array.isArray(args[last])) args[last] = lastWord(args[last]); changed(); return page[name](...args) }
        // a select whose option is not there (or is disabled) changed nothing
        if (typeof page.selectOption === 'function') driver.selectOption = async (...args) => { const picked = await page.selectOption(...args); if (picked && picked.ok) changed(); return picked }
        s.doing = { action, target: targetOf(body), since: now() }
        let done
        try {
          done = await perform(id, surface, driver, snapshot, action, body, { personFrom: person, closed, sid })
        } catch (error) {
          if (error instanceof ComputerRefusal || !acted) throw error
          throw new Error(`${String((error && error.message) || error)} — after the action had begun on the page: part of it may have been done; look before trying again`)
        } finally {
          s.doing = null
        }
        s.used_at = now()
        log(`[computer] ${body.owner} on ${id}: ${action} ${JSON.stringify(done).slice(0, 200)}`)
        // the action is done: a look after it that fails is said beside it, never in place of it
        try {
          if (action !== 'wait') await page.settle()
          return { status: 'ok', action, done, ...(await look(id, surface, body.owner, { screenshot: body.screenshot !== false })) }
        } catch (error) {
          const why = String((error && error.message) || error).slice(0, 300)
          log(`[computer] ${body.owner} on ${id}: ${action} was done; the look after it failed: ${why}`)
          return { status: 'ok', surface: sid, ...(s.tab ? { tab_id: s.tab } : {}), action, done, look_failed: why }
        }
      }, { handOverFirst: false, epoch }))
    } catch (error) {
      const refusal = refusalOf(error)
      // a stale look is answered with a fresh one, so the next action has something current to go on — unless the
      // page is still another session's (not handed over: the refused action left it be), which this one never sees;
      // and only of the page the action was on (its own tab), never one opened for it nor another run's, nor while
      // the browser's data is being cleared
      if (WITH_LOOK.has(refusal.status) && !(error && error.noLook) && target !== null) {
        try {
          const s = state.get(target)
          if (!s || s.handover || (s.tab && (clearing || !ownsTab(s.sid, body.owner, s.tab)))) return refusal
          return { ...refusal, ...(await counted(target, () => serially(target, () => look(target, s.surface, body.owner, { screenshot: body.screenshot !== false })))) }
        } catch { /* the refusal alone */ }
      }
      return refusal
    }
  }

  function refusalOf(error) {
    if (error instanceof ComputerRefusal) return { status: error.status, reason: error.message, ...error.extra }
    log(`[computer] failed: ${error && error.stack ? error.stack.split('\n').slice(0, 3).join(' | ') : error}`)
    return { status: 'error', reason: String((error && error.message) || error).slice(0, 500) }
  }

  function list() {
    return {
      status: 'ok',
      surfaces: Object.entries(surfaces).map(([id, surface]) => (surface.tabbed
        ? { id, label: surface.label, opened: surface.all().length > 0, holder: null, tabs: surface.all().length }
        : { id, label: surface.label, opened: surface.opened(), holder: holderOf(id) })),
    }
  }

  /** Whether the person may clear the agent browser's data now: no run holds any of its tabs, nothing is under way on
   *  any, and no clear is going. Returns the refusal, or null. */
  const clearRefusal = (sid) => {
    if (clearing) return new ComputerRefusal('busy', 'the browser\'s data is being cleared already')
    for (const [key, s] of state) {
      if (s.sid !== sid) continue
      const holder = holderOf(key)
      if (holder !== null) return new ComputerRefusal('busy', `the ${sid} surface is in use by ${holder}; try again once the run lets go of it`, { holder })
      if (s.inflight > 0) return new ComputerRefusal('busy', `an agent's look or action is under way on the ${sid} surface; try again in a moment`)
    }
    return null
  }

  return {
    list, observe, act, reap,
    /** A run ended: what it held is free at once (not after the quiet lease); what it still had queued is cancelled.
     *  Its tabs and looks stay (an approval of one of its actions runs on its own page, or is stale), until idle. */
    releaseOwner(body = {}) {
      if (typeof body.owner !== 'string' || !body.owner) return { status: 'refused', reason: 'an owner (the run) is required' }
      return { status: 'ok', released: releaseAll(body.owner) }
    },
    /** Who holds a page now (null: nobody): a surface's id, or `<id>/<tab>`. */
    holder: holderOf,
    /** Who holds a tab of a tabbed surface now. */
    holderOfTab: (sid, tab) => (tab ? holderOf(keyOf(sid, tab)) : null),
    /** The tab a run is on now (null: it has none open): the thread's live view of that run follows it. */
    currentTab(owner, sid = 'browser') {
      if (!tabbedOf(sid) || typeof owner !== 'string' || !runs.has(owner)) return null
      const tab = runs.get(owner).current[sid]
      return tab && ownsTab(sid, owner, tab) ? tab : null
    },
    /** A page as a person watching follows it: who holds it, who held it last (`{ owner, party }`: the run and its
     *  session, still there after the lease ran out or the run let go; null before anyone took it), how many times it
     *  changed hands (`takes`), the action going on now (null between two) and where the agent's pointer last went.
     *  Takes nothing and opens no page; null for a surface there is not (or a tab that is closed). */
    watch(id, tab = null) {
      if (!Object.prototype.hasOwnProperty.call(surfaces, id)) return null
      if (tabbedOf(id)) {
        if (!tab || !surfaces[id].exists(tab)) return null
        const key = keyOf(id, tab)
        const s = state.get(key)
        return { surface: id, tab_id: tab, owner: surfaces[id].ownerOf(tab), holder: holderOf(key), last: s ? s.last : null, takes: s ? s.takes : 0, doing: s ? s.doing : null, pointer: s ? s.pointer : null }
      }
      const s = stateOf(id)
      return { surface: id, holder: holderOf(id), last: s.last, takes: s.takes, doing: s.doing, pointer: s.pointer }
    },
    /** Whether the person may clear the agent browser's data now (see whenFree). */
    canClear: (sid = 'browser') => (tabbedOf(sid) ? clearRefusal(sid) === null : holderOf(sid) === null),
    /** For the person: `fn` done on a surface no run holds, in the surface's turn — no look or action of an agent runs
     *  meanwhile (a run that takes the page while it goes waits for it). Refused, as a ComputerRefusal (`busy`), while a
     *  run holds the surface, also when one took it while `fn` waited its turn. On a tabbed surface (clearing the
     *  browser's data): refused while any run holds any tab or any operation is under way on one; while `fn` goes, no
     *  operation starts on any tab (each is refused `busy`) — a short latch, not a queue every operation waits in. */
    whenFree(id, fn) {
      if (tabbedOf(id)) {
        const refusal = clearRefusal(id)
        if (refusal) return Promise.reject(refusal)
        clearing = true
        return Promise.resolve().then(fn).finally(() => { clearing = false })
      }
      const busy = () => {
        const holder = holderOf(id)
        return holder === null ? null : new ComputerRefusal('busy', `the ${id} surface is in use by ${holder}; try again once the run lets go of it`, { holder })
      }
      const now = busy()
      if (now) return Promise.reject(now)
      return serially(id, async () => {
        const later = busy()
        if (later) throw later
        return fn()
      })
    },
    /** For the bridge: take the ChatGPT page for a send (refused, as a ComputerRefusal, when an agent holds it). */
    claim: (id, owner) => claim(id, owner),
    release: (id, owner) => release(id, owner),
  }
}

module.exports = { createComputer, outlineOf, outlineOfFrames, lineOf, nodeOfRef, ComputerRefusal, ACTIONS, TAB_ACTIONS, LEASE_MS, PERSON_QUIET_MS, READ_CHARS, TAB_IDLE_MS }
