/* QA-only Electron entry point. Policy is installed BEFORE loading desktop/main.js,
 * hence no BrowserWindow can be shown/focused first and then hidden. Not SMOKE: no 2.5s quit.
 * Use fresh temp DATA/USER_DATA and four nonproduction ports. No Remote access, ever. */
'use strict'
const fs = require('node:fs')
const path = require('node:path')

function installBackgroundPolicy(electron) {
  const Original = electron.BrowserWindow
  class BackgroundWindow extends Original {
    constructor(options = {}) { super({ ...options, show: false }) }
    show() {} // hidden throughout; capturePage/CDP still render
    showInactive() {}
    focus() {}
  }
  Object.defineProperty(electron, 'BrowserWindow', { configurable: true, enumerable: true, writable: true, value: BackgroundWindow })
  electron.app.focus = () => {}
  if (typeof electron.app.setActivationPolicy === 'function') electron.app.setActivationPolicy('accessory')
  if (electron.app.dock) electron.app.dock.hide()
  return BackgroundWindow
}
function validateEnv(env) {
  for (const name of ['OASIS_CODE_DATA', 'OASIS_CODE_USER_DATA']) {
    if (!env[name] || !/^\/(?:private\/)?tmp\//.test(path.resolve(env[name]))) throw new Error(`QA requires fresh /tmp ${name}`)
  }
  const ports = ['OASIS_CODE_PORT', 'OASIS_CODE_BRIDGE_PORT', 'OASIS_CODE_DIRECTOR_PORT', 'OASIS_CODE_GATEWAY_PORT'].map((k) => Number(env[k]))
  if (ports.some((p) => !Number.isInteger(p) || p < 1024 || p > 65535 || [8321, 8322, 8323, 8324, 8399].includes(p)) || new Set(ports).size !== 4) throw new Error('QA requires four distinct nonproduction ports')
  if (env.OASIS_CODE_SMOKE === '1') throw new Error('QA long-lived Browser validation must not use SMOKE')
  const prefs = path.join(env.OASIS_CODE_DATA, 'remote-access.json')
  if (fs.existsSync(prefs)) throw new Error('QA refuses a preexisting Remote access preference file')
}
module.exports = { installBackgroundPolicy, validateEnv }
if (require.main === module) {
  validateEnv(process.env)
  require('./ssh-qa-process-guard.cjs') // fails closed if actual launchctl is attempted
  const electron = require('electron')
  installBackgroundPolicy(electron)
  require('../../desktop/main.js')
}
