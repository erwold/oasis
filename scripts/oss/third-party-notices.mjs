#!/usr/bin/env node
// Writes THIRD_PARTY_NOTICES.md: the packages that can end up in what we ship, from the lock files, with the license
// each declares and the license texts the installed copy actually carries. Re-runnable; read-only except for --out.
//
//   node scripts/oss/third-party-notices.mjs [--modules-root DIR] [--out FILE | --check FILE]
//        [--frontend-inputs FILE.json] [--backend-metafile FILE.json]
//
// --modules-root  where the four packages' node_modules live (default: this repository; a copy installed elsewhere
//                 may be named instead — only read). Its <pkg>/node_modules folders are read.
// --frontend-inputs  a JSON list of module ids the frontend build actually bundled (scripts/oss/vite-inputs.config.mjs
//                 writes one; scripts/oss/notices.mjs runs the whole chain); without it the frontend list is the lock's non-dev closure ("candidate").
// --backend-metafile  `bun build --metafile` output for the backend entry points; same role for the backend.
// --check FILE    compare with FILE and exit 1 when it differs (CI), write nothing.
//
// Exit status: 0 when written / identical; 1 on a difference (--check) or an unreadable lock; 2 on bad arguments.
// Packages without a readable license are listed as "unknown" — never dropped, never assumed fine.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import {
  KNOWN_NOTES, bunRuntimeClosure, installPathsInInputs, needsReview, npmLockedVersion, npmRuntimePackages, parseBunLock, readInstalled,
} from './lib/inventory.mjs'
import { parseCli } from './lib/args.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

export function parseArgs(argv) {
  const cli = parseCli(argv, { values: ['--modules-root', '--out', '--check', '--frontend-inputs', '--backend-metafile'] })
  const v = (name) => (cli.values[name] === undefined ? null : resolve(cli.values[name]))
  const opts = { modulesRoot: v('--modules-root') ?? REPO, out: v('--out'), check: v('--check'), frontendInputs: v('--frontend-inputs'), backendMetafile: v('--backend-metafile') }
  if (opts.out && opts.check) throw new Error('--out and --check exclude each other')
  return opts
}

const sha = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16)

/** One row per installed package instance (component + install path), judged against the version its lock pins.
 *  Reads only the installed package files under `roots` (tests pass fixture folders). */
export function buildRows({ feLock, beLock, contractLock, deskLock, modulesRoot, feInputs = null, beInputs = null, roots: given = null }) {
  const rows = []
  const roots = given ?? {
    frontend: join(modulesRoot, 'frontend', 'node_modules'),
    backend: join(modulesRoot, 'backend-ts', 'node_modules'),
    contract: join(modulesRoot, 'contract', 'node_modules'),
    desktop: join(modulesRoot, 'desktop', 'node_modules'),
  }
  // which install paths each build actually bundled, by the package folder they came from
  const bundledFrom = (inputs) => {
    if (!inputs) return null
    const by = { frontend: new Set(), backend: new Set(), contract: new Set(), other: new Set() }
    for (const { root, path } of installPathsInInputs(inputs)) {
      const base = root.replace(/\/+$/, '').split('/').pop()
      if (base === 'contract') by.contract.add(path)
      else if (base === 'frontend') by.frontend.add(path)
      else if (base === '' || base === 'backend-ts' || base === '.') by.backend.add(path)
      else by.other.add(`${root}/node_modules/${path}`)
    }
    return by
  }
  const fe = bundledFrom(feInputs)
  const be = bundledFrom(beInputs)
  const seen = new Set()

  const add = ({ component, name, installPath, lockVersion, lockLicense = null, modulesDir, bundled }) => {
    const id = `${component}\u0000${installPath}`
    if (seen.has(id)) return
    seen.add(id)
    const inst = readInstalled(modulesDir, installPath)
    const mismatch = inst.installed && lockVersion && inst.version !== lockVersion
    let status
    let files = inst.files
    let declared = inst.declared ?? lockLicense ?? null
    if (!inst.installed) { status = 'not installed where read (license text unknown)'; files = [] }
    else if (mismatch) { status = `installed copy is ${inst.version}, the lock pins ${lockVersion}: its license is NOT taken for the locked version`; files = []; declared = lockLicense ?? null }
    else status = inst.files.length ? 'license file found' : 'no license file in package (declared only)'
    rows.push({
      component, name, installPath, version: lockVersion ?? inst.version ?? '', declared: declared ?? 'unknown', status, files,
      bundled: bundled === null ? 'candidate (lock closure)' : bundled === 'runtime' ? 'yes (the app runs on it)' : bundled ? 'yes (seen in build)' : 'no (not in build inputs)',
      review: needsReview(declared) || Boolean(KNOWN_NOTES[name]) || !inst.installed || mismatch || inst.files.length === 0,
      mismatch: Boolean(mismatch), installed: inst.installed, note: KNOWN_NOTES[name] ?? null,
    })
  }

  for (const p of npmRuntimePackages(feLock)) {
    if (p.local) continue // our own contract package, Apache-2.0 with this repository
    const platform = p.os || p.cpu ? ` [platform: ${[p.os, p.cpu].filter(Boolean).flat().join('/')}]` : ''
    add({ component: 'frontend (UI bundle)' + platform, name: p.name, installPath: p.installPath, lockVersion: p.version, lockLicense: p.license, modulesDir: roots.frontend, bundled: fe ? fe.frontend.has(p.installPath) : null })
  }
  const beClosure = bunRuntimeClosure(beLock)
  for (const p of beClosure.packages) {
    if (p.local) continue
    add({ component: 'backend (compiled binary)', name: p.name, installPath: p.installPath, lockVersion: p.version, modulesDir: roots.backend, bundled: be ? be.backend.has(p.installPath) : null })
  }
  // packages a build took from ../contract's own node_modules (the shared schemas' zod), at the version contract/bun.lock pins
  const contractClosure = bunRuntimeClosure(contractLock).packages
  for (const [component, by] of [['frontend (UI bundle) [from ../contract]', fe], ['backend (compiled binary) [from ../contract]', be]]) {
    if (!by) continue
    for (const path of by.contract) {
      const locked = contractClosure.find((p) => p.installPath === path)
      add({ component, name: locked?.name ?? path.split('/node_modules/').pop(), installPath: path, lockVersion: locked?.version ?? null, modulesDir: roots.contract, bundled: true })
    }
  }
  const electronVersion = npmLockedVersion(deskLock, 'electron')
  add({ component: 'desktop (Electron runtime)', name: 'electron', installPath: 'electron', lockVersion: electronVersion, lockLicense: deskLock.packages?.['node_modules/electron']?.license ?? null, modulesDir: roots.desktop, bundled: 'runtime' })

  const sortKey = (r) => `${r.component}\u0000${r.installPath}`
  rows.sort((a, b) => sortKey(a).localeCompare(sortKey(b)))
  // every package instance a build actually bundled must have its row; one that is not in its lock's runtime closure
  // (a dev-only package, a lock drift) is listed by name instead of silently left out
  const unmatched = [fe, be].filter(Boolean).flatMap((by) => [...by.other].map((path) => ({ component: 'unknown package folder', path })))
  const hasRow = (prefix, path) => rows.some((r) => r.component.startsWith(prefix) && !r.component.includes('[from ../contract]') && r.installPath === path)
  if (fe) for (const path of fe.frontend) if (!hasRow('frontend (UI bundle)', path)) unmatched.push({ component: 'frontend (UI bundle)', path })
  if (be) for (const path of be.backend) if (!hasRow('backend (compiled binary)', path)) unmatched.push({ component: 'backend (compiled binary)', path })
  unmatched.sort((a, b) => `${a.component}\u0000${a.path}`.localeCompare(`${b.component}\u0000${b.path}`))
  return { rows, missing: beClosure.missing, electronVersion, unmatched }
}

/** Build the inventory from the repository's locks and the installed packages under opts.modulesRoot. */
export function collect(opts) {
  const read = (p) => readFileSync(join(REPO, p), 'utf8')
  const locks = {
    'frontend/package-lock.json': read('frontend/package-lock.json'),
    'backend-ts/bun.lock': read('backend-ts/bun.lock'),
    'contract/bun.lock': read('contract/bun.lock'),
    'desktop/package-lock.json': read('desktop/package-lock.json'),
  }
  const feInputs = opts.frontendInputs ? JSON.parse(readFileSync(opts.frontendInputs, 'utf8')) : null
  const beInputs = opts.backendMetafile ? Object.keys(JSON.parse(readFileSync(opts.backendMetafile, 'utf8')).inputs ?? {}) : null
  const built = buildRows({
    feLock: JSON.parse(locks['frontend/package-lock.json']), beLock: parseBunLock(locks['backend-ts/bun.lock']),
    contractLock: parseBunLock(locks['contract/bun.lock']), deskLock: JSON.parse(locks['desktop/package-lock.json']),
    modulesRoot: opts.modulesRoot, feInputs, beInputs,
  })
  return { ...built, lockHashes: Object.fromEntries(Object.entries(locks).map(([k, v]) => [k, sha(v)])), modulesRootIsRepo: resolve(opts.modulesRoot) === REPO, buildInputs: Boolean(feInputs && beInputs) }
}

export function render(inv) {
  const L = []
  L.push('# Third-party notices', '')
  L.push('Generated by `scripts/oss/notices.mjs` (through `scripts/oss/third-party-notices.mjs`) from the lock files and the')
  L.push('license files of the installed packages. **This is an inventory, not a legal review.** Rows marked for review and')
  L.push('packages whose license text could not be read ("unknown") need a look before a binary is handed to anyone. This')
  L.push('file does not cover the Bun runtime compiled into the backend executable, nor the components inside Electron;')
  L.push('see NOTICE (item 4) and `Resources/licenses/electron/LICENSES.chromium.html` in a packaged app. Material kept in')
  L.push('this repository itself (Lucide icons, the Fraunces and KaTeX fonts, beautiful-ui) is listed in NOTICE, with its')
  L.push('license texts under `licenses/`.', '')
  L.push('Lock files read (sha256, first 16 hex):', '')
  for (const [k, v] of Object.entries(inv.lockHashes)) L.push(`- \`${k}\` ${v}`)
  L.push('')
  const review = inv.rows.filter((r) => r.review)
  const mism = inv.rows.filter((r) => r.mismatch).length
  const absent = inv.rows.filter((r) => !r.installed).length
  L.push(`Installed copies were read from ${inv.modulesRootIsRepo ? 'this checkout' : 'another directory named with --modules-root (not recorded here)'}; ${inv.rows.length - mism - absent} match their lock, ${mism} differ from it, ${absent} were not found.`)
  L.push(inv.buildInputs ? 'Build lists: the real Vite bundle and Bun metafile inputs (scripts/oss/notices.mjs).' : 'Build lists: none supplied; every lock package is a candidate.', '')
  L.push(`Package instances listed: ${inv.rows.length}. Marked for review: ${review.length}.`, '')
  if (inv.unmatched.length) {
    L.push(`**Bundled but not in the lock's runtime packages: ${inv.unmatched.length} (review each; no license text is given for them here).**`, '')
    for (const u of inv.unmatched) L.push(`- ${u.component}: \`${u.path}\``)
    L.push('')
  }
  if (inv.missing.length) L.push(`Backend dependencies named in the lock but not resolvable in it: ${inv.missing.join(', ')}`, '')
  L.push('| Component | Package | Install path | Version (lock) | Declared license | License text | In build | Review |')
  L.push('|---|---|---|---|---|---|---|---|')
  for (const r of inv.rows) {
    L.push(`| ${r.component} | ${r.name} | ${r.installPath} | ${r.version} | ${r.declared} | ${r.status} | ${r.bundled} | ${r.review ? 'yes' : ''} |`)
  }
  L.push('', '## Notes on specific packages', '')
  for (const r of inv.rows.filter((x) => x.note)) L.push(`- **${r.name}** — ${r.note}`)
  L.push('', '## License texts', '')
  L.push('Texts are given for every package the build bundled, the Electron runtime, and every package listed as a')
  L.push('candidate when no build list was supplied; a package the build list shows was not bundled is named in the table only.', '')
  const seen = new Set()
  for (const r of inv.rows.filter((x) => !x.bundled.startsWith('no '))) {
    const id = `${r.name}@${r.version}`
    if (seen.has(id) && r.files.length) continue
    seen.add(id)
    L.push(`### ${id} (${r.installPath})`, '', `Declared: ${r.declared}`, '')
    if (!r.files.length) { L.push(`_No license file could be read (${r.status})._`, ''); continue }
    for (const f of r.files) {
      L.push(`#### ${f.file}`, '', '```text', f.text.replace(/```/g, "'''").trimEnd(), '```', '')
    }
  }
  return L.join('\n') + '\n'
}

async function main() {
  let opts
  try { opts = parseArgs(process.argv.slice(2)) } catch (e) { console.error(String(e.message ?? e)); process.exit(2) }
  for (const pkg of ['frontend', 'backend-ts', 'desktop']) {
    if (!existsSync(join(opts.modulesRoot, pkg, 'node_modules'))) console.error(`note: ${join(opts.modulesRoot, pkg, 'node_modules')} is missing; its packages will be "not installed here"`)
  }
  const text = render(collect(opts))
  if (opts.check) {
    const old = existsSync(opts.check) ? readFileSync(opts.check, 'utf8') : ''
    if (old !== text) { console.error(`${opts.check} is out of date; regenerate with --out`); process.exit(1) }
    console.log(`${opts.check} is up to date`)
    return
  }
  if (opts.out) { writeFileSync(opts.out, text); console.log(`wrote ${opts.out}`) } else process.stdout.write(text)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
