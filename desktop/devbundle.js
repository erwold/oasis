// The source tree's own app bundle on macOS. `npm start` used to launch node_modules' Electron.app, and every surface
// macOS draws from the bundle — the Dock's label, the app switcher, Stage Manager, Mission Control — showed Electron's
// name and icon; `app.dock.setIcon` reaches the Dock tile only. So the launcher clones Electron.app (an APFS clone:
// no bytes copied) into desktop/.dev/oasis-code.app, gives it the product's name, identifier and icon, and runs that.
// The clone is remade when Electron's version, the icon or the keys below change (a stamp beside it records them).

const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const APP_NAME = 'oasis-code'
const ICON_FILE = 'oasis-code.icns'

// the packaged app is dev.oasis-code.desktop; the source tree's bundle is another app to LaunchServices
function bundleKeys() {
  return {
    CFBundleName: APP_NAME,
    CFBundleDisplayName: APP_NAME,
    CFBundleIdentifier: 'dev.oasis-code.desktop.source',
    CFBundleIconFile: ICON_FILE,
  }
}

function stampOf(electronVersion, iconBytes) {
  const hash = crypto.createHash('sha256')
  hash.update(`electron ${electronVersion}\n`)
  hash.update(JSON.stringify(bundleKeys()))
  hash.update(iconBytes)
  return hash.digest('hex')
}

// the iconset iconutil wants: 16–512 pt at 1x and 2x, each from the 1024 px master
const ICONSET = [16, 32, 128, 256, 512].flatMap((pt) => [[`icon_${pt}x${pt}.png`, pt], [`icon_${pt}x${pt}@2x.png`, pt * 2]])

function run(file, args) {
  execFileSync(file, args, { stdio: ['ignore', 'ignore', 'pipe'] })
}

function cloneTree(from, to) {
  try { run('cp', ['-cR', from, to]) } catch { run('cp', ['-R', from, to]) } // -c: clonefile(2) on APFS, else a copy
}

function makeIcns(iconPng, out, workDir) {
  const iconset = path.join(workDir, `${APP_NAME}.iconset`)
  fs.rmSync(iconset, { recursive: true, force: true })
  fs.mkdirSync(iconset, { recursive: true })
  for (const [name, px] of ICONSET) run('sips', ['-z', String(px), String(px), iconPng, '--out', path.join(iconset, name)])
  run('iconutil', ['-c', 'icns', iconset, '-o', out])
  fs.rmSync(iconset, { recursive: true, force: true })
}

/** The bundle's executable, made or reused. `electronApp` is node_modules' Electron.app, `iconPng` the 1024 px icon,
 *  `outDir` where the bundle and its stamp live. Throws when a macOS tool fails (the caller falls back). */
function ensureDevBundle({ electronApp, electronVersion, iconPng, outDir }) {
  const app = path.join(outDir, `${APP_NAME}.app`)
  const executable = path.join(app, 'Contents', 'MacOS', 'Electron')
  const stampPath = path.join(outDir, 'bundle.stamp')
  const stamp = stampOf(electronVersion, fs.readFileSync(iconPng))
  let current = null
  try { current = fs.readFileSync(stampPath, 'utf8').trim() } catch { current = null }
  if (current === stamp && fs.existsSync(executable)) return { app, executable, rebuilt: false }

  fs.mkdirSync(outDir, { recursive: true })
  fs.rmSync(app, { recursive: true, force: true })
  fs.rmSync(stampPath, { force: true })
  cloneTree(electronApp, app)
  makeIcns(iconPng, path.join(app, 'Contents', 'Resources', ICON_FILE), outDir)
  const plist = path.join(app, 'Contents', 'Info.plist')
  for (const [key, value] of Object.entries(bundleKeys())) run('plutil', ['-replace', key, '-string', value, plist])
  // a bundle changed in place keeps LaunchServices' cached name and icon until its modification time moves
  const now = new Date()
  fs.utimesSync(app, now, now)
  fs.writeFileSync(stampPath, `${stamp}\n`)
  return { app, executable, rebuilt: true }
}

module.exports = { APP_NAME, ICON_FILE, bundleKeys, ensureDevBundle, stampOf }
