// electron-builder's afterPack hook: the packed app carries every module the shell requires, the compiled backend
// and the built UI — checked in the artifact itself (app.asar's file list and the resources beside it), so a
// packaging gap fails `npm run dist` here rather than on the person's first launch.

const fs = require('node:fs')
const path = require('node:path')
const { asarFiles, ENTRY_POINTS, licenseResourceProblems, missingFromPackage, requireClosure } = require('../packaging')

function resourcesDir(context) {
  const { appOutDir, packager } = context
  if (packager.platform.name === 'mac') {
    const app = fs.readdirSync(appOutDir).find((name) => name.endsWith('.app'))
    if (!app) throw new Error(`no .app bundle in ${appOutDir}`)
    return path.join(appOutDir, app, 'Contents', 'Resources')
  }
  return path.join(appOutDir, 'resources')
}

module.exports = async function verifyPack(context) {
  const resources = resourcesDir(context)
  const archive = path.join(resources, 'app.asar')
  if (!fs.existsSync(archive)) throw new Error(`packaging check: ${archive} is missing`)
  const closure = requireClosure(path.resolve(__dirname, '..'), ENTRY_POINTS)
  const missing = missingFromPackage(closure, asarFiles(archive))
  const problems = missing.map((name) => `app.asar lacks ${name} (required by the shell; add it to package.json build.files)`)
  const backend = path.join(resources, 'backend', context.packager.platform.name === 'windows' ? 'oasis-code.exe' : 'oasis-code')
  if (!fs.existsSync(backend)) problems.push(`the compiled backend is missing: ${backend}`)
  const ui = path.join(resources, 'ui', 'index.html')
  if (!fs.existsSync(ui)) problems.push(`the built UI is missing: ${ui}`)
  // the license files, copied explicitly (electron-builder 26 drops Electron's own from a macOS bundle)
  problems.push(...licenseResourceProblems(resources))
  if (problems.length) throw new Error(`packaging check failed:\n  ${problems.join('\n  ')}`)
  console.log(`  • packaging check  app.asar carries ${closure.length} shell modules (${closure.join(', ')}); backend, UI and license files present`)
}
