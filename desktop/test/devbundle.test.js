const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { bundleKeys, ensureDevBundle, stampOf } = require('../devbundle')

const ICON = path.join(__dirname, '..', 'build', 'icon.png')

test('the stamp follows Electron, the icon and the keys', () => {
  const icon = Buffer.from('icon')
  assert.equal(stampOf('38.8.6', icon), stampOf('38.8.6', Buffer.from('icon')))
  assert.notEqual(stampOf('38.8.6', icon), stampOf('38.8.7', icon))
  assert.notEqual(stampOf('38.8.6', icon), stampOf('38.8.6', Buffer.from('other')))
  assert.equal(bundleKeys().CFBundleName, 'oasis-code')
  assert.notEqual(bundleKeys().CFBundleIdentifier, require('../package.json').build.appId)
})

function plistValue(plist, key) {
  return execFileSync('plutil', ['-extract', key, 'raw', plist], { encoding: 'utf8' }).trim()
}

test('on macOS a bundle is cloned with the product name and icon, reused, and remade when the icon changes',
  { skip: process.platform !== 'darwin' && 'plutil, sips and iconutil are macOS tools' }, () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oasis-devbundle-'))
    try {
      // a stand-in for node_modules' Electron.app: its plist, an executable and a resource
      const electronApp = path.join(tmp, 'Electron.app')
      fs.mkdirSync(path.join(electronApp, 'Contents', 'MacOS'), { recursive: true })
      fs.mkdirSync(path.join(electronApp, 'Contents', 'Resources'), { recursive: true })
      fs.writeFileSync(path.join(electronApp, 'Contents', 'MacOS', 'Electron'), '#!/bin/sh\n', { mode: 0o755 })
      fs.writeFileSync(path.join(electronApp, 'Contents', 'Resources', 'electron.icns'), 'electron icon')
      const plistSource = path.join(electronApp, 'Contents', 'Info.plist')
      execFileSync('plutil', ['-create', 'xml1', plistSource])
      for (const [key, value] of [['CFBundleName', 'Electron'], ['CFBundleDisplayName', 'Electron'], ['CFBundleIdentifier', 'com.github.Electron'], ['CFBundleIconFile', 'electron.icns'], ['CFBundleExecutable', 'Electron']]) {
        execFileSync('plutil', ['-insert', key, '-string', value, plistSource])
      }
      const icon = path.join(tmp, 'icon.png')
      fs.copyFileSync(ICON, icon)
      const outDir = path.join(tmp, '.dev')
      const opts = { electronApp, electronVersion: '38.8.6', iconPng: icon, outDir }

      const first = ensureDevBundle(opts)
      assert.equal(first.rebuilt, true)
      assert.equal(first.app, path.join(outDir, 'oasis-code.app'))
      assert.ok(fs.existsSync(first.executable))
      const plist = path.join(first.app, 'Contents', 'Info.plist')
      for (const [key, value] of Object.entries(bundleKeys())) assert.equal(plistValue(plist, key), value)
      assert.equal(plistValue(plist, 'CFBundleExecutable'), 'Electron')
      const icns = fs.readFileSync(path.join(first.app, 'Contents', 'Resources', 'oasis-code.icns'))
      assert.equal(icns.subarray(0, 4).toString('latin1'), 'icns')
      assert.ok(icns.length > 10000)
      assert.equal(plistValue(plistSource, 'CFBundleName'), 'Electron') // node_modules' bundle untouched
      assert.deepEqual(fs.readdirSync(outDir).sort(), ['bundle.stamp', 'oasis-code.app']) // the iconset cleaned up

      assert.equal(ensureDevBundle(opts).rebuilt, false)

      execFileSync('sips', ['-z', '512', '512', ICON, '--out', icon], { stdio: 'ignore' })
      assert.equal(ensureDevBundle(opts).rebuilt, true)
      assert.equal(ensureDevBundle({ ...opts, electronVersion: '38.8.7' }).rebuilt, true)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
