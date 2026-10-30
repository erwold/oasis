// Executes the real main entry with injected Electron/network/fs. No app, port or launchd is touched.
const assert = require('node:assert/strict')
const test = require('node:test')
const vm = require('node:vm')
const fs = require('node:fs')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const shell = require('../shell')
function load(background = true, extra = {}) {
  const calls = { windows: [], focus: 0, remote: 0, quits: 0, timers: [] }
  const handlers = new Map(), app = new EventEmitter()
  Object.assign(app, { isPackaged: false, setName() {}, setPath() {}, setActivationPolicy() {}, getPath: () => '/tmp/ssh-ui-test/profile', requestSingleInstanceLock: () => true, whenReady: () => ({ then() {} }), quit: () => calls.quits++, exit: () => calls.quits++ })
  class Window extends EventEmitter {
    constructor(options) { super(); this.options = options; calls.windows.push(this); this.webContents = new EventEmitter(); Object.assign(this.webContents, { setWindowOpenHandler() {}, session: { clearCache: async () => {} }, executeJavaScript: async () => null }) }
    async loadURL() {} isDestroyed() { return false } isMinimized() { return true } restore() { calls.focus++ } focus() { calls.focus++ } maximize() { calls.focus++ }
  }
  const fakeFs = { readFileSync: () => JSON.stringify({ maximized: true }), mkdirSync() {}, appendFileSync() {}, chmodSync() {}, writeFileSync() {}, existsSync: () => true }
  const env = { OASIS_CODE_BACKGROUND: background ? '1' : '0', OASIS_CODE_DATA: '/tmp/ssh-ui-test/data', OASIS_CODE_USER_DATA: '/tmp/ssh-ui-test/profile', OASIS_CODE_PORT: '18801', OASIS_CODE_BRIDGE_PORT: '18802', OASIS_CODE_DIRECTOR_PORT: '18803', OASIS_CODE_GATEWAY_PORT: '18804', ...extra }
  const context = {
    require: (name) => {
      if (name === 'electron') return { app, BrowserWindow: Window, dialog: { showErrorBox() {} }, ipcMain: { handle: (n, f) => handlers.set(n, f), on() {} }, screen: { getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1440, height: 900 } }] }, shell: { openExternal() {} }, session: {} }
      if (name === 'node:fs') return fakeFs
      if (name === 'node:child_process') return { spawn: () => assert.fail('no spawn') }
      if (name === './shell') return { ...shell, knownTokens: () => [], classifyAttach: () => 'ours' }
      if (name === './bridge') return { bridgePortOf: () => 18802 }
      if (name === './computer_electron') return { BROWSER_PARTITION: 'test' }
      if (name === './remote') return { createRemote: () => { calls.remote++; return { resume: async () => { calls.remote++ }, set: async () => { calls.remote++ }, configure: async () => { calls.remote++ }, rotate: async () => { calls.remote++ }, status: () => ({}) } } }
      if (name === './local_files') return { fromAppPage: () => true }
      return require(name)
    },
    process: { env, platform: 'darwin', resourcesPath: '/tmp/resources', stdout: { write() {} }, exit: () => { throw new Error('startup refused') } },
    __dirname: path.resolve(__dirname, '..'), console: { log() {}, error() {} }, URL, AbortSignal,
    fetch: async () => ({ status: 200, json: async () => ({}) }),
    setTimeout: (_fn, ms) => { calls.timers.push(ms); return 1 }, clearTimeout() {},
  }
  vm.createContext(context)
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8') + '\nthis.qaCreateWindow = createWindow;', context)
  return { calls, handlers, app, create: context.qaCreateWindow }
}
test('background entry creates hidden before first load, never maximizes/focuses, and has no smoke exit timer', async () => {
  const h = load(); await h.create()
  assert.equal(h.calls.windows[0].options.show, false)
  assert.equal(h.calls.focus, 0)
  h.app.emit('second-instance'); h.app.emit('activate')
  assert.equal(h.calls.focus, 0)
  assert.equal(h.calls.quits, 0)
  assert.ok(!h.calls.timers.includes(2500))
})
test('background entry never constructs/resumes/enables Remote access, even from its own renderer', async () => {
  const h = load(); await h.create()
  const event = { sender: h.calls.windows[0].webContents }
  for (const name of ['remote-set', 'remote-configure', 'remote-rotate']) await h.handlers.get(name)(event, { enabled: true, provider: 'cloudflare' })
  assert.equal(h.calls.remote, 0)
})
test('ordinary desktop behavior remains visible and resumes its configured Remote access', async () => {
  const h = load(false); await h.create()
  assert.equal(h.calls.windows[0].options.show, true)
  assert.ok(h.calls.remote > 0)
  h.app.emit('second-instance'); assert.ok(h.calls.focus > 0)
})

test('background refuses missing isolation, production ports, duplicate ports and SMOKE before creating a window', () => {
  for (const patch of [
    { OASIS_CODE_DATA: '' }, { OASIS_CODE_USER_DATA: '' }, { OASIS_CODE_PORT: '8321' },
    { OASIS_CODE_BRIDGE_PORT: '8322' }, { OASIS_CODE_DIRECTOR_PORT: '8323' }, { OASIS_CODE_GATEWAY_PORT: '8324' },
    { OASIS_CODE_GATEWAY_PORT: '18801' }, { OASIS_CODE_SMOKE: '1' },
  ]) assert.throws(() => load(true, patch), /BACKGROUND/)
})
