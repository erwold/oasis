import assert from 'node:assert/strict'
import { test } from 'node:test'
import { browserDataClearer, browserHolders, browserLine, browserPlacer, browserStatusOf, chatGptPlaceOf, chatGptSendingResumer, CLEAR_BROWSER_DATA_CONFIRM, clearBrowserDataOffer, computerAvailable, chatGptPlacer, desktopPlatform, remoteAccess, remoteLine, remoteSetupStep, sendLogNotice, shortRunId, tabOwnerBadge, usesAgentBrowser, type BrowserTab, type RemoteStatus } from '../src/state/desktop.ts'

test('the desktop bridge is read only when it is well formed', () => {
  assert.equal(desktopPlatform({}), null)
  assert.equal(desktopPlatform({ oasisCodeDesktop: { platform: 'darwin' } }), 'darwin')
  assert.equal(desktopPlatform({ oasisCodeDesktop: { platform: '' } }), null)
  assert.equal(desktopPlatform({ oasisCodeDesktop: 'darwin' }), null)
  assert.equal(desktopPlatform({ oasisCodeDesktop: { platform: 3 } }), null)
})

test('the ChatGPT page shows over its card only while nothing covers the card', () => {
  const rect = { left: 600.4, top: 80, width: 420, height: 300.6 }
  const clear = () => true
  assert.deepEqual(chatGptPlaceOf(rect, clear, true), { x: 600, y: 80, width: 420, height: 301, visible: true })
  // a menu over one corner, a card in front of the middle: the page steps aside
  assert.equal(chatGptPlaceOf(rect, (x, y) => !(x > 1000 && y > 360), true).visible, false)
  assert.equal(chatGptPlaceOf(rect, (x, y) => !(Math.abs(x - 810) < 5 && Math.abs(y - 230) < 5), true).visible, false)
  assert.equal(chatGptPlaceOf(rect, clear, false).visible, false)                  // the app is hidden
  assert.equal(chatGptPlaceOf({ left: 0, top: 0, width: 420, height: 10 }, clear, true).visible, false)   // a title strip
  assert.equal(chatGptPlacer({}), null)
  assert.equal(chatGptPlacer({ oasisCodeDesktop: { platform: 'darwin', placeChatGpt: 'no' } }), null)
  assert.equal(typeof chatGptPlacer({ oasisCodeDesktop: { platform: 'darwin', placeChatGpt: () => {} } }), 'function')
})

test("remote access is the desktop shell's alone, and its state reads as one short line: starting, connected, backend offline, tunnel unavailable", () => {
  assert.equal(remoteAccess({}), null)
  assert.equal(remoteAccess({ oasisCodeDesktop: { platform: 'darwin', remoteStatus: async () => null } }), null)   // all four or none
  const f = async () => null
  assert.equal(remoteAccess({ oasisCodeDesktop: { platform: 'darwin', remoteStatus: f, setRemote: f, rotateRemote: f } }), null)   // no setup: an older shell
  assert.ok(remoteAccess({ oasisCodeDesktop: { platform: 'darwin', remoteStatus: f, setRemote: f, configureRemote: f, rotateRemote: f } }))
  const base: RemoteStatus = { state: 'off', enabled: false, keep_awake: true, provider: 'quick', host: null, url: null, error: null, token_set: null, gateway_origin: 'http://127.0.0.1:8324' }
  assert.equal(remoteLine(base), 'Off')
  assert.equal(remoteLine({ ...base, enabled: true, state: 'starting', provider: 'cloudflare', host: 'mcp.example.com' }), 'Starting…')
  assert.equal(remoteLine({ ...base, enabled: true, state: 'connected', provider: 'cloudflare', host: 'mcp.example.com' }), 'Connected')
  assert.match(remoteLine({ ...base, enabled: true, state: 'backend_offline' }), /oasis-code is not running/)
  assert.equal(remoteLine({ ...base, enabled: true, state: 'tunnel_unavailable', error: 'the tunnel exited' }), 'Tunnel unavailable: the tunnel exited')
  // an error never claims the service is down (a stop that failed leaves it running)
  assert.equal(remoteLine({ ...base, enabled: true, state: 'error', error: 'could not turn remote access off: bootout failed' }), 'Needs attention: could not turn remote access off: bootout failed')
  assert.doesNotMatch(remoteLine({ ...base, state: 'error', error: 'x' }), /Not running/)
  // the setup line names where the tunnel must send traffic
  assert.equal(remoteSetupStep('cloudflare', base.gateway_origin), 'Route this hostname to http://127.0.0.1:8324; paste its tunnel token.')
  assert.equal(remoteSetupStep('external', 'http://127.0.0.1:9004'), 'Forward HTTPS on this hostname to http://127.0.0.1:9004.')
  assert.match(remoteSetupStep('ngrok', base.gateway_origin), /dev domain assigned to your account/)
  // the quick tunnel needs nothing set up: its line says only that its address moves when the gateway restarts
  assert.match(remoteSetupStep('quick', base.gateway_origin), /changes when the gateway restarts/)
})

test("the agent's browser (computer use) is the desktop shell's: its card follows an agent's use of it, its line says who acts on it", () => {
  assert.equal(browserPlacer({}), null)
  assert.equal(browserStatusOf({ oasisCodeDesktop: { platform: 'darwin' } }), null)
  const placed: unknown[] = []
  const shell = { oasisCodeDesktop: { platform: 'darwin', placeBrowser: (p: unknown) => placed.push(p), browserStatus: async () => null } }
  browserPlacer(shell)!({ x: 1, y: 2, width: 3, height: 4, visible: true })
  assert.deepEqual(placed, [{ x: 1, y: 2, width: 3, height: 4, visible: true }])
  assert.equal(typeof browserStatusOf(shell), 'function')
  // computer use can be named with @ where the app holds the pages
  assert.equal(computerAvailable(shell), true)
  assert.equal(computerAvailable({}), false)
  assert.equal(computerAvailable({ oasisCodeDesktop: { platform: 'darwin' } }), false)
  const act = (surface: unknown) => ({ kind: 'activity', tool: 'computer_act', result: { surface } })
  assert.equal(usesAgentBrowser(act('browser')), true)
  assert.equal(usesAgentBrowser(act('chatgpt')), false)                       // the ChatGPT page has its own card
  assert.equal(usesAgentBrowser({ kind: 'activity', tool: 'computer_observe' }), false)   // still running: no result yet
  assert.equal(usesAgentBrowser({ kind: 'activity', tool: 'fetch_url', result: { surface: 'browser' } }), false)
  assert.equal(browserLine(null), 'not opened')
  assert.equal(browserLine({ opened: true, url: 'https://example.com/a?b', title: 'x', holder: null }), 'example.com')
  assert.equal(browserLine({ opened: true, url: 'about:blank', title: '', holder: null }), 'blank')
  assert.equal(browserLine({ opened: true, url: 'https://example.com/', title: 'x', holder: 'run_1' }), 'an agent is using it')
})

test("the Browser card offers to clear the browser's data only while no run holds it, and asks first: it signs every project out", () => {
  const shell = { oasisCodeDesktop: { platform: 'darwin', clearBrowserData: async () => ({ cleared: true }) } }
  assert.equal(typeof browserDataClearer(shell), 'function')
  assert.equal(browserDataClearer({ oasisCodeDesktop: { platform: 'darwin' } }), null)
  assert.equal(browserDataClearer({}), null)
  const free = { opened: true, url: 'https://example.com/', title: 'x', holder: null }
  assert.equal(clearBrowserDataOffer(free, false).enabled, true)
  assert.equal(clearBrowserDataOffer(null, false).enabled, true)                     // never opened: its profile still clears
  const held = clearBrowserDataOffer({ ...free, holder: 'run_1' }, false)
  assert.deepEqual([held.enabled, /agent is using the browser/.test(held.title)], [false, true])
  assert.equal(clearBrowserDataOffer(free, true).enabled, false)                     // one clear at a time
  assert.match(CLEAR_BROWSER_DATA_CONFIRM, /every project and session/)
  assert.match(CLEAR_BROWSER_DATA_CONFIRM, /signed out/)
  assert.match(CLEAR_BROWSER_DATA_CONFIRM, /tabs .* are closed/)
})

test("Clear data follows the shell's can_clear_data: the tab shown being free says nothing of another run's tab", () => {
  const tab = (id: string, holder: string | null): BrowserTab => ({ id, url: 'https://example.com/', title: id, loading: false, active: id === 'a', owner: holder ?? 'run_old', session: 's_1', holder })
  // the person shows a free tab while another run holds its own: still held back
  const other = { opened: true, url: 'https://example.com/', title: 'x', holder: null, can_clear_data: false, tabs: [tab('a', null), tab('b', 'run_2')] }
  const offer = clearBrowserDataOffer(other, false)
  assert.deepEqual([offer.enabled, /agent is using the browser/.test(offer.title)], [false, true])
  assert.equal(clearBrowserDataOffer({ ...other, can_clear_data: true, tabs: [tab('a', null), tab('b', null)] }, false).enabled, true)
  // the shell's word wins over the tab shown's holder either way; an older shell (none said) is read by its holder
  assert.equal(clearBrowserDataOffer({ ...other, holder: 'run_2', can_clear_data: true }, false).enabled, true)
  assert.equal(clearBrowserDataOffer({ opened: true, url: null, title: null, holder: 'run_2' }, false).enabled, false)
  assert.equal(clearBrowserDataOffer({ ...other, can_clear_data: true }, true).enabled, false)
  // the card's line counts the runs holding a tab
  assert.deepEqual(browserHolders(other), ['run_2'])
  assert.equal(browserLine(other), 'an agent is using it')
  assert.equal(browserLine({ ...other, tabs: [tab('a', 'run_1'), tab('b', 'run_2'), tab('c', 'run_2')] }), '2 agents are using it')
  assert.equal(browserLine({ ...other, holder: 'run_9', tabs: [tab('a', null)] }), 'example.com')   // per-tab holders said: the tabs are read
  assert.deepEqual(browserHolders({ opened: true, url: null, title: null, holder: 'run_7', tabs: [{ id: 'a', url: '', title: '', loading: false, active: true }] }), ['run_7'])   // an older shell
})

test("a tab's badge names the agent it belongs to — its trusted name, else its run's short id — live or last; none on the person's own", () => {
  const base: BrowserTab = { id: 't', url: 'https://agent-a.example/', title: 'Agent A says hi', loading: false, active: true }
  assert.equal(tabOwnerBadge(base), null)                                                         // an older shell, or the person's tab
  assert.equal(tabOwnerBadge({ ...base, owner: null, session: null, owner_label: null, holder: null }), null)
  const live = tabOwnerBadge({ ...base, owner: 'run_3f9a2c1b0d4e', session: 's_1', owner_label: ' Researcher ', holder: 'run_3f9a2c1b0d4e' })!
  assert.deepEqual([live.label, live.live, live.run], ['Researcher', true, 'run_3f9a2c1b0d4e'])
  assert.equal(live.title, 'Researcher · using this tab\nrun run_3f9a2c1b0d4e\nsession s_1')
  const last = tabOwnerBadge({ ...base, owner: 'run_77aa00bb11cc', session: 's_2', holder: null })!
  assert.deepEqual([last.label, last.live], ['run 77aa', false])                                  // no label: the run's short id, never the page's title
  assert.equal(last.title, 'Agent · used this tab last\nrun run_77aa00bb11cc\nsession s_2')
  assert.equal(tabOwnerBadge({ ...base, owner: null, holder: 'run_1234abcd0000', owner_label: '' })!.label, 'run 1234')
  assert.equal(shortRunId('run_3f9a2c1b0d4e'), 'run 3f9a')
  assert.equal(shortRunId('bridge'), 'bridge')
  assert.equal(shortRunId('a-very-long-owner-id'), 'a-very-…')
})

test('a damaged send log pauses sending on the ChatGPT card with a way to resume; an unreadable one says why, with none', () => {
  assert.equal(sendLogNotice(undefined), null)
  assert.equal(sendLogNotice({ state: 'usable' }), null)
  assert.deepEqual(sendLogNotice({ state: 'damaged', file: 'bridge-turns.damaged-x.json', at: '2026-10-01T08:30:00Z' }), {
    text: 'The send log was damaged; sending is paused. Check the ChatGPT page for messages that may have gone, then resume.', resumable: true,
  })
  const unreadable = sendLogNotice({ state: 'unreadable', reason: 'EACCES' })
  assert.deepEqual([unreadable?.resumable, /cannot be read \(EACCES\); sending is paused/.test(unreadable?.text ?? '')], [false, true])
  const shell = { oasisCodeDesktop: { platform: 'darwin', resumeChatGptSending: async () => ({ resumed: true, journal: { state: 'usable' } }) } }
  assert.equal(typeof chatGptSendingResumer(shell), 'function')
  assert.equal(chatGptSendingResumer({ oasisCodeDesktop: { platform: 'darwin' } }), null)
})
