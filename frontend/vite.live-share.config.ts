/** The live link page's build (`npm run build:live-share`): src/share/live/viewer/entry.tsx as ONE classic script and
 *  ONE stylesheet in live-share-dist/ (live-share.js, live-share.css; their measures and SHA-256 in live-share.json).
 *  `npm run build` then carries both into dist/live-share/ (vite.config.ts), where the share listener reads them and
 *  serves them at /live/assets/ under its own CSP (`script-src 'self'; connect-src 'self'`; contract/src/live_share.ts).
 *
 *  - The app's thread components are bundled as they are, with the SAME stand-ins as the offline file's viewer
 *    (src/share/viewer/offline: the page store, the API, the desk, the interactive blocks) and the same guard: no module
 *    of the app's boot, sync, streams, storage or API enters the bundle.
 *  - Everything is inlined (one chunk, no dynamic import, no preload, assets — the few bot stills — as data: URLs);
 *    KaTeX's faces keep their woff2 source only.
 *  - The script's network call sites, read from its syntax tree: exactly ONE global `fetch(…)` (src/share/live/
 *    connection.ts — the stream and the pictures, two exact same-origin paths), nothing else (no XMLHttpRequest,
 *    EventSource, WebSocket, Worker, sendBeacon, import()), and no network API named outside a call. */

import { join, resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { checkedOutput, offline } from './vite.share-plugins.ts'

const SRC = resolve(import.meta.dirname, 'src')
const OUT = resolve(import.meta.dirname, 'live-share-dist')

export default defineConfig({
  // the offline file's builder never belongs on the live page (nor the other way round)
  plugins: [offline('the live share viewer', ['state/share', 'state/shareImages', 'components/shareExport', 'share/viewerBundle', 'share/viewer/entry']), react(),
    checkedOutput(OUT, 'live-share', { allowed: { 'fetch()': 1 }, inline: false, references: true })],
  publicDir: false,
  define: { 'process.env.NODE_ENV': JSON.stringify('production'), __OASIS_CODE_BUILD__: JSON.stringify('live-share-viewer') },
  build: {
    outDir: OUT,
    emptyOutDir: true,
    copyPublicDir: false,
    minify: true,
    sourcemap: false,
    cssCodeSplit: false,
    modulePreload: false,
    assetsInlineLimit: () => true,
    lib: { entry: join(SRC, 'share/live/viewer/entry.tsx'), formats: ['iife'], name: 'oasisLiveShareViewer', fileName: () => 'live-share.js', cssFileName: 'live-share' },
  },
})
