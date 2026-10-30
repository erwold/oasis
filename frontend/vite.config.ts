import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/** The UI's own build identity: a fingerprint of its source, not the
 * target repository's HEAD (GET /api/meta/build carries the backend's). */
function sourceFingerprint(dir: string): string {
  const hash = createHash('sha256')
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else { hash.update(p); hash.update(readFileSync(p)) }
    }
  }
  walk(dir)
  return hash.digest('hex').slice(0, 12)
}

const BUILD = process.env.OASIS_CODE_BUILD || sourceFingerprint(join(process.cwd(), 'src'))

/** dist/build.json: the build the backend serves, so an open page can tell it is older than the dist on disk. */
const buildFile: Plugin = { name: 'oasis-code-build-file', generateBundle() { this.emitFile({ type: 'asset', fileName: 'build.json', source: JSON.stringify({ ui_build: BUILD }) }) } }

/** dist/live-share/live-share.{js,css}: the live link page's two files (`npm run build:live-share` wrote them to
 *  live-share-dist/), carried with the app's build — where the share listener reads them (the desktop app ships dist/
 *  only). Exactly these two names; a build without them fails rather than ship an app whose links show nothing. */
const LIVE_SHARE_FILES = ['live-share.js', 'live-share.css'] as const
const liveShareFiles: Plugin = {
  name: 'oasis-code-live-share-files',
  apply: 'build',
  generateBundle() {
    for (const name of LIVE_SHARE_FILES) {
      const file = join(import.meta.dirname, 'live-share-dist', name)
      if (!existsSync(file)) this.error(`live-share-dist/${name} is missing: run npm run build:live-share first`)
      this.emitFile({ type: 'asset', fileName: `live-share/${name}`, source: readFileSync(file) })
    }
  },
}

export default defineConfig({
  plugins: [react(), buildFile, liveShareFiles],
  define: { __OASIS_CODE_BUILD__: JSON.stringify(BUILD) },
  server: { proxy: { '/api': process.env.OASIS_CODE_API || 'http://127.0.0.1:8321' } },
})
