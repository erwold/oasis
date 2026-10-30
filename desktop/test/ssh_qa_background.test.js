'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const { installBackgroundPolicy, validateEnv } = require('../../frontend/e2e/ssh-qa-electron-background.cjs')

test('QA background launcher forces show:false at construction, never show-then-hide, and suppresses focus', () => {
  const calls = []
  class Original {
    constructor(options) { calls.push(['construct', options]) }
    show() { calls.push('show') }
    showInactive() { calls.push('showInactive') }
    focus() { calls.push('focus') }
  }
  const electron = { BrowserWindow: Original, app: { focus: () => calls.push('appFocus'), setActivationPolicy: (p) => calls.push(['policy', p]), dock: { hide: () => calls.push('dockHide') } } }
  installBackgroundPolicy(electron)
  const win = new electron.BrowserWindow({ show: true, width: 1000 })
  win.show(); win.showInactive(); win.focus(); electron.app.focus()
  assert.deepEqual(calls, [['policy', 'accessory'], 'dockHide', ['construct', { show: false, width: 1000 }]])
})

test('QA background launcher refuses production ports, smoke auto-quit and existing remote preferences', () => {
  const root = mkdtempSync('/tmp/oasis-qa-launcher-test-')
  try {
    mkdirSync(join(root, 'data')); mkdirSync(join(root, 'profile'))
    const env = { OASIS_CODE_DATA: join(root, 'data'), OASIS_CODE_USER_DATA: join(root, 'profile'), OASIS_CODE_PORT: '18391', OASIS_CODE_BRIDGE_PORT: '18392', OASIS_CODE_DIRECTOR_PORT: '18393', OASIS_CODE_GATEWAY_PORT: '18394' }
    assert.doesNotThrow(() => validateEnv(env))
    assert.throws(() => validateEnv({ ...env, OASIS_CODE_PORT: '8321' }))
    assert.throws(() => validateEnv({ ...env, OASIS_CODE_PORT: '8399' }))
    assert.throws(() => validateEnv({ ...env, OASIS_CODE_SMOKE: '1' }))
    assert.throws(() => validateEnv({ ...env, OASIS_CODE_USER_DATA: '/Users/someone/profile' }))
    writeFileSync(join(root, 'data/remote-access.json'), '{"enabled":false}')
    assert.throws(() => validateEnv(env))
  } finally { rmSync(root, { recursive: true, force: true }) }
})
