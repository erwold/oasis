// The dependency inventory behind THIRD_PARTY_NOTICES.md (pure functions plus read-only file reads; nothing here
// writes, installs, deletes or touches the network). It answers: which packages can end up inside what we ship
// (frontend bundle, compiled backend, Electron runtime), what license each declares, and which license files the
// installed copy actually carries. It is a candidate inventory, never a legal conclusion.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Licenses that need no separate decision beyond carrying their text (SPDX ids). Everything else is flagged. */
export const PERMISSIVE = new Set([
  'MIT', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'BlueOak-1.0.0', 'CC0-1.0', 'Unlicense',
])

/** Things a package's license field does not say (NOTICE item 4 repeats them). */
export const KNOWN_NOTES = {
  katex: 'The package is MIT, but the fonts it ships (dist/fonts/KaTeX_*, bundled into the UI) are under the SIL Open Font License 1.1 (as the fonts themselves state); their notice and the OFL text are in licenses/katex-fonts-OFL-1.1.txt.',
  electron: 'Electron (MIT) bundles Chromium, Node.js, FFmpeg (LGPL-2.1-or-later) and many other components; their notices are in LICENSES.chromium.html, which a packaged app carries under Resources/licenses/electron/.',
}

/** bun.lock is JSON with trailing commas. */
export function parseBunLock(text) {
  const noTrailing = text.replace(/,(\s*[}\]])/g, '$1')
  return JSON.parse(noTrailing)
}

/** "name@version" -> { name, version } (scoped names keep their leading @). */
export function splitSpec(spec) {
  const at = spec.lastIndexOf('@')
  if (at <= 0) return { name: spec, version: '' }
  return { name: spec.slice(0, at), version: spec.slice(at + 1) }
}

/** The packages a bun workspace's runtime dependencies reach (devDependencies excluded), each once, sorted by name.
 *  Bun nests a second version of a package under "parent/name"; a dependency is looked up from the innermost key out. */
export function bunRuntimeClosure(lock, workspace = '') {
  const ws = lock.workspaces?.[workspace]
  if (!ws) throw new Error(`bun.lock has no workspace "${workspace}"`)
  const packages = lock.packages ?? {}
  const resolve = (fromKey, dep) => {
    let prefix = fromKey
    while (prefix) {
      if (packages[`${prefix}/${dep}`]) return `${prefix}/${dep}`
      const cut = prefix.lastIndexOf('/')
      // a scoped key ("@scope/name") is one segment, not two
      if (cut <= 0 || (prefix.startsWith('@') && prefix.indexOf('/') === cut)) prefix = ''
      else prefix = prefix.slice(0, cut)
    }
    return packages[dep] ? dep : null
  }
  const seen = new Map()
  const missing = []
  const queue = Object.keys({ ...(ws.dependencies ?? {}), ...(ws.optionalDependencies ?? {}) }).map((d) => [null, d])
  while (queue.length) {
    const [from, dep] = queue.shift()
    const key = from ? resolve(from, dep) : (packages[dep] ? dep : null)
    if (!key) { missing.push(dep); continue }
    if (seen.has(key)) continue
    const entry = packages[key]
    const { name, version } = splitSpec(entry[0])
    const meta = entry.find((x, i) => i > 0 && x && typeof x === 'object') ?? {}
    seen.set(key, { key, name, version, local: version.startsWith('file:'), installPath: bunKeyToInstallPath(key) })
    for (const d of Object.keys({ ...(meta.dependencies ?? {}), ...(meta.optionalDependencies ?? {}) })) queue.push([key, d])
  }
  return { packages: [...seen.values()].sort((a, b) => a.key.localeCompare(b.key)), missing }
}

/** A bun.lock package key ("a", "@s/x", "a/b", "@s/x/@t/y") -> where bun installs it under node_modules
 *  ("a", "@s/x", "a/node_modules/b", "@s/x/node_modules/@t/y"). */
export function bunKeyToInstallPath(key) {
  const parts = key.split('/')
  const names = []
  while (parts.length) {
    const p = parts.shift()
    names.push(p.startsWith('@') ? `${p}/${parts.shift()}` : p)
  }
  return names.join('/node_modules/')
}

/** The packages of an npm lockfile (v2/v3) that are not dev-only, each with its install path, sorted. Linked local
 *  packages ("link": true) are reported as local. */
export function npmRuntimePackages(lock) {
  const out = []
  for (const [path, meta] of Object.entries(lock.packages ?? {})) {
    if (!path.startsWith('node_modules/') && !path.includes('/node_modules/')) continue
    if (meta.dev || meta.devOptional) continue
    const name = meta.name ?? path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length)
    const installPath = path.slice(path.indexOf('node_modules/') + 'node_modules/'.length)
    out.push({ key: path, name, version: meta.version ?? '', license: meta.license ?? null, local: Boolean(meta.link), optional: Boolean(meta.optional), os: meta.os ?? null, cpu: meta.cpu ?? null, installPath })
  }
  return out.sort((a, b) => a.key.localeCompare(b.key))
}

/** The version npm's lock pins for one package path, or null. */
export function npmLockedVersion(lock, name) {
  return lock.packages?.[`node_modules/${name}`]?.version ?? null
}

const LICENSE_FILE = /^(licen[cs]e|copying|notice|copyright)([.-].*)?$/i

/** The license-like files at a package's root (LICENSE, LICENCE.md, COPYING, NOTICE ...), sorted. */
export function licenseFiles(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((n) => LICENSE_FILE.test(n) && statSync(join(dir, n)).isFile()).sort()
}

/** A declared license as a string ("MIT", "(MIT OR Apache-2.0)"), from a package.json's license / licenses. */
export function declaredLicense(pkg) {
  if (!pkg) return null
  if (typeof pkg.license === 'string') return pkg.license
  if (pkg.license && typeof pkg.license.type === 'string') return pkg.license.type
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => (typeof l === 'string' ? l : l.type)).join(' OR ')
  return null
}

/** Whether a declared license needs a decision: unknown, or any id outside PERMISSIVE (an OR is fine when one side is). */
export function needsReview(license) {
  if (!license) return true
  const ids = license.replace(/[()]/g, ' ').split(/\s+/).filter((t) => t && !/^(OR|AND|WITH)$/.test(t))
  if (/\bAND\b/.test(license)) return ids.some((id) => !PERMISSIVE.has(id))
  return !ids.some((id) => PERMISSIVE.has(id))
}

/** Read one installed package instance: its package.json license and its license files (texts included).
 *  `installPath` is the path under the node_modules folder ("a", or "a/node_modules/b" for a nested copy). */
export function readInstalled(modulesRoot, installPath) {
  const dir = join(modulesRoot, installPath)
  const pj = join(dir, 'package.json')
  if (!existsSync(pj)) return { installed: false, dir, declared: null, files: [] }
  let pkg = null
  try { pkg = JSON.parse(readFileSync(pj, 'utf8')) } catch { pkg = null }
  const files = licenseFiles(dir).map((file) => ({ file, text: readFileSync(join(dir, file), 'utf8') }))
  return { installed: true, dir, declared: declaredLicense(pkg), version: pkg?.version ?? null, files }
}

/** Install paths a bundler's input list touches, each relative to the first node_modules folder of its input:
 *  ".../node_modules/a/node_modules/@s/b/x.js" -> { root: "...", path: "a/node_modules/@s/b" }. */
export function installPathsInInputs(inputs) {
  const seen = new Map()
  for (const raw of inputs) {
    const p = raw.replace(/\\/g, '/')
    const i = p.indexOf('node_modules/')
    if (i < 0) continue
    const root = p.slice(0, i).replace(/\/$/, '')
    const rest = p.slice(i + 'node_modules/'.length).split('/')
    const names = []
    while (rest.length) {
      const seg = rest.shift()
      const name = seg.startsWith('@') ? `${seg}/${rest.shift()}` : seg
      names.push(name)
      if (rest[0] !== 'node_modules') break
      rest.shift()
    }
    const path = names.join('/node_modules/')
    seen.set(`${root}\u0000${path}`, { root, path })
  }
  return [...seen.values()].sort((a, b) => `${a.root}\u0000${a.path}`.localeCompare(`${b.root}\u0000${b.path}`))
}

/** Package names a bundler's input list touches: "node_modules/<name>/..." segments (the innermost one wins). */
export function packagesInInputs(inputs) {
  const names = new Set()
  for (const raw of inputs) {
    const p = raw.replace(/\\/g, '/')
    const i = p.lastIndexOf('node_modules/')
    if (i < 0) continue
    const rest = p.slice(i + 'node_modules/'.length).split('/')
    names.add(rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0])
  }
  return [...names].sort()
}
