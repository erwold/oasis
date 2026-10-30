/** The session share's viewer build (`npm run build:share`): src/share/viewer/entry.tsx as ONE classic script and ONE
 *  stylesheet in share-viewer-dist/, which the app carries as text (src/share/viewerBundle.ts) and writes inline into
 *  every share file under a hash-only CSP.
 *
 *  - The app's thread components are bundled as they are; the modules that would reach the harness or the page's
 *    storage are replaced by the in-memory stand-ins of src/share/viewer/offline (the page store, the API, the desk,
 *    the interactive blocks a snapshot never carries). A guard fails the build if any replaced module, or a module of
 *    the app's boot, sync or streams, still enters the bundle.
 *  - Everything is inlined (one chunk, no dynamic import, no preload, assets as data: URLs). KaTeX's faces keep their
 *    woff2 source only (its woff/ttf fallbacks are dropped before they are read: a browser that runs this page reads
 *    woff2), so the stylesheet's only external-looking references are `data:font/woff2` URLs.
 *  - The script is checked for what would end its inline element (`</script`, `<!--`), written escaped, and checked to
 *    hold no network call site of its own (its syntax tree: no global fetch, XMLHttpRequest, EventSource, WebSocket,
 *    Worker, sendBeacon, import()). The module guard and the file's zero-request tests stay the primary controls. */

import { join, resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { checkedOutput, offline } from './vite.share-plugins.ts'

const SRC = resolve(import.meta.dirname, 'src')
const OUT = resolve(import.meta.dirname, 'share-viewer-dist')

export default defineConfig({
  plugins: [offline('the share viewer'), react(), checkedOutput(OUT, 'share-viewer', { allowed: {}, inline: true, references: false })],
  publicDir: false,
  define: { 'process.env.NODE_ENV': JSON.stringify('production'), __OASIS_CODE_BUILD__: JSON.stringify('share-viewer') },
  build: {
    outDir: OUT,
    emptyOutDir: true,
    copyPublicDir: false,
    minify: true,
    sourcemap: false,
    cssCodeSplit: false,
    modulePreload: false,
    assetsInlineLimit: () => true,
    lib: { entry: join(SRC, 'share/viewer/entry.tsx'), formats: ['iife'], name: 'oasisShareViewer', fileName: () => 'share-viewer.js', cssFileName: 'share-viewer' },
  },
})
