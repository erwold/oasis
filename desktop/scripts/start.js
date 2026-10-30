// `npm start` / `npm run smoke`: Electron on this folder. On macOS it runs from the source tree's own bundle
// (devbundle.js) so the system shows the product's name and icon; elsewhere, or if the bundle cannot be made, from
// node_modules' Electron as before. Arguments after `--` go to Electron; its exit code is this script's.
// The smoke run gets a data directory, an Electron profile and a free port of its own in a temporary folder (any of
// them the person names is kept): it never opens the person's profile or attaches to their running backend. The
// folder is removed after a run that passed and kept, with its log, after one that did not.

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { ensureDevBundle } = require('../devbundle')
const { smokeEnv } = require('../shell')

const desktop = path.resolve(__dirname, '..')
let executable = require('electron') // the path of node_modules' Electron binary

if (process.platform === 'darwin') {
  try {
    const bundle = ensureDevBundle({
      electronApp: path.resolve(path.dirname(executable), '..', '..'),
      electronVersion: require('electron/package.json').version,
      iconPng: path.join(desktop, 'build', 'icon.png'),
      outDir: path.join(desktop, '.dev'),
    })
    if (bundle.rebuilt) console.log(`[start] made ${path.relative(desktop, bundle.app)}`)
    executable = bundle.executable
  } catch (error) {
    console.error(`[start] the source bundle could not be made (${error.message.split('\n')[0]}); running node_modules' Electron`)
  }
}

/** A port nothing listens on now (the system's pick on the loopback). */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

async function main() {
  const smoke = process.env.OASIS_CODE_SMOKE === '1'
  const scratch = smoke ? fs.mkdtempSync(path.join(os.tmpdir(), 'oasis-code-smoke-')) : null
  const env = scratch ? smokeEnv(process.env, scratch, await freePort()) : process.env
  if (scratch) console.log(`[start] smoke: data ${env.OASIS_CODE_DATA}, profile ${env.OASIS_CODE_USER_DATA}, port ${env.OASIS_CODE_PORT}`)
  const child = spawn(executable, [desktop, ...process.argv.slice(2)], { stdio: 'inherit', env })
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
  child.on('exit', (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0)
    if (!scratch) return
    if (process.exitCode === 0) fs.rmSync(scratch, { recursive: true, force: true })
    else console.error(`[start] smoke: kept ${scratch} (the desktop log is in data/logs)`)
  })
}

main().catch((error) => {
  console.error(`[start] ${error.message}`)
  process.exitCode = 1
})
