/** Build identity: what the running process actually loaded (the package version plus a fingerprint of the source
 *  files this process runs from), never the target repository's HEAD. The UI bakes its own fingerprint; the API
 *  compatibility version is what blocks interaction when it differs. */

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { API_VERSION } from '@oasis-code/contract'

export { API_VERSION }
export const PACKAGE_VERSION = '0.1.0'
export const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url))
/** The repository root (frontend/dist lives beside backend-ts/). */
export const REPO_ROOT = join(PACKAGE_ROOT, '..', '..')
/** The built frontend the backend serves: OASIS_CODE_FRONTEND_DIST (a compiled binary carries no source tree), else the repository's. */
export const FRONTEND_DIST = process.env.OASIS_CODE_FRONTEND_DIST || join(REPO_ROOT, 'frontend', 'dist')

let cached: string | null = null

/** sha256 over the package's .ts / .md / .sql files, in path order, 12 hex chars. */
export function sourceFingerprint(): string {
  if (cached) return cached
  const digest = createHash('sha256')
  const files: string[] = []
  const walk = (dir: string) => {
    let names: string[]
    try { names = readdirSync(dir) } catch { return }
    for (const name of names.sort()) {
      const path = join(dir, name)
      let stat
      try { stat = statSync(path) } catch { continue }
      if (stat.isDirectory()) { if (name !== 'node_modules') walk(path); continue }
      if (/\.(ts|md|sql)$/.test(name)) files.push(path)
    }
  }
  walk(PACKAGE_ROOT)
  if (files.length === 0) {
    // a compiled binary: no source tree to walk; the executable itself is what this process loaded
    try { digest.update(readFileSync(process.execPath)) } catch { digest.update(process.execPath) }
    cached = digest.digest('hex').slice(0, 12)
    return cached
  }
  for (const path of files.sort()) {
    digest.update(relative(PACKAGE_ROOT, path))
    digest.update('\0')
    digest.update(readFileSync(path))
    digest.update('\0')
  }
  cached = digest.digest('hex').slice(0, 12)
  return cached
}

export function backendIdentity(): { package_version: string; source_fingerprint: string; api_version: string } {
  return { package_version: PACKAGE_VERSION, source_fingerprint: sourceFingerprint(), api_version: API_VERSION }
}
