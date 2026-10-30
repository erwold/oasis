// What a packaged app must carry (pure; the afterPack hook and the tests use it): the files the shell's entry points
// require from this folder, followed transitively, and a reader of app.asar's file list — so a `require('./x')`
// added to main.js without `x.js` in package.json's build.files fails the build instead of the app's first launch.

const fs = require('node:fs')
const path = require('node:path')

/** The local modules a file requires (`require('./name')`, with or without `.js`), as file names in this folder. */
function localRequires(source) {
  const out = []
  const pattern = /require\(\s*['"]\.\/([A-Za-z0-9_./-]+?)(?:\.js)?['"]\s*\)/g
  let m
  while ((m = pattern.exec(source)) !== null) out.push(`${m[1]}.js`)
  return out
}

/** Every file the entry points reach through local requires, the entry points included, sorted. */
function requireClosure(dir, entries) {
  const seen = new Set()
  const queue = [...entries]
  while (queue.length) {
    const name = queue.shift()
    if (seen.has(name)) continue
    seen.add(name)
    const file = path.join(dir, name)
    if (!fs.existsSync(file)) throw new Error(`${name} is required but does not exist in ${dir}`)
    for (const dep of localRequires(fs.readFileSync(file, 'utf8'))) queue.push(dep)
  }
  return [...seen].sort()
}

/** The entry points Electron loads from the app: the main process and the preload. */
const ENTRY_POINTS = ['main.js', 'preload.js']

/** The files of an asar archive, as `/name` paths (the archive's JSON header, read without a dependency: a pickle
 *  of four uint32 sizes, then the header JSON). */
function asarFiles(archive) {
  const fd = fs.openSync(archive, 'r')
  try {
    const head = Buffer.alloc(16)
    fs.readSync(fd, head, 0, 16, 0)
    const headerSize = head.readUInt32LE(12)
    const json = Buffer.alloc(headerSize)
    fs.readSync(fd, json, 0, headerSize, 16)
    const header = JSON.parse(json.toString('utf8'))
    const out = []
    const walk = (node, prefix) => {
      for (const [name, entry] of Object.entries(node.files ?? {})) {
        const full = `${prefix}/${name}`
        if (entry.files) walk(entry, full)
        else out.push(full)
      }
    }
    walk(header, '')
    return out.sort()
  } finally {
    fs.closeSync(fd)
  }
}

/** The files the closure needs that a package (a list of `/name` paths, or package.json's build.files) lacks. */
function missingFromPackage(closure, packaged) {
  const have = new Set(packaged.map((p) => p.replace(/^\//, '')))
  return closure.filter((name) => !have.has(name))
}

/** The license files a packaged app carries under its resources folder, and where package.json build.extraResources
 *  takes each from (relative to this folder). Copied explicitly: electron-builder 26 removes Electron's own LICENSE and
 *  LICENSES.chromium.html from a macOS bundle, so the default layout cannot be relied on. `marker` is a string the
 *  file must contain, so an empty or wrong file fails the check rather than passing it. */
const LICENSE_RESOURCES = [
  { from: '../LICENSE', to: 'licenses/LICENSE', marker: 'Apache License' },
  { from: '../NOTICE', to: 'licenses/NOTICE', marker: 'oasis-code contributors' },
  { from: '../THIRD_PARTY_NOTICES.md', to: 'licenses/THIRD_PARTY_NOTICES.md', marker: 'Third-party notices' },
  { from: '../licenses', to: 'licenses/vendored', dir: true, marker: null },
  { from: 'node_modules/electron/dist/LICENSE', to: 'licenses/electron/LICENSE', marker: 'Electron' },
  { from: 'node_modules/electron/dist/LICENSES.chromium.html', to: 'licenses/electron/LICENSES.chromium.html', marker: '<' },
]

/** The extraResources entries the license files need (what package.json must hold). */
function licenseExtraResources() {
  return LICENSE_RESOURCES.map(({ from, to }) => ({ from, to }))
}

/** The license entries package.json build.extraResources lacks (compared on from/to). */
function missingLicenseEntries(extraResources) {
  const have = new Set((extraResources ?? []).map((e) => (typeof e === 'string' ? `${e}=>${e}` : `${e.from}=>${e.to}`)))
  return licenseExtraResources().filter((e) => !have.has(`${e.from}=>${e.to}`))
}

/** What is wrong with the license files in a packaged app's resources folder (read only): each one missing, empty,
 *  or without its marker; an empty vendored folder. An empty list means every license resource is there. */
function licenseResourceProblems(resources) {
  const problems = []
  for (const r of LICENSE_RESOURCES) {
    const target = path.join(resources, ...r.to.split('/'))
    if (!fs.existsSync(target)) { problems.push(`license resource missing: ${r.to} (from ${r.from})`); continue }
    if (r.dir) {
      if (!fs.statSync(target).isDirectory() || fs.readdirSync(target).length === 0) problems.push(`license folder empty: ${r.to}`)
      continue
    }
    const text = fs.readFileSync(target, 'utf8')
    if (text.trim().length === 0) problems.push(`license resource empty: ${r.to}`)
    else if (r.marker && !text.includes(r.marker)) problems.push(`license resource ${r.to} lacks "${r.marker}"`)
  }
  return problems
}

module.exports = {
  ENTRY_POINTS, LICENSE_RESOURCES, asarFiles, licenseExtraResources, licenseResourceProblems, localRequires, missingFromPackage,
  missingLicenseEntries, requireClosure,
}
