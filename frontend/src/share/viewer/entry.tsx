/** The session share's viewer entry (vite.share.config.ts builds it into one script and one stylesheet the file
 *  carries inline): it reads the file's own data block, checks it, and draws the app's thread from it. No app boot, no
 *  token, no sync, no storage, no request: the page store, the API and the desk are the in-memory stand-ins of
 *  ./offline (the build puts them where the app's modules would be). */

// FIRST: zod without its eval JIT, before any module that builds a schema evaluates (./jitless.ts)
import './jitless'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ShareApp } from './ShareApp'
import { checkShareAnyDocument } from '../document'
// the app's own stylesheet, after the components as in src/main.tsx (KaTeX's comes with Prose), then the page's shell
import '../../index.css'
import './shell.css'

const root = document.getElementById('root')
if (root) {
  try {
    const doc = checkShareAnyDocument(JSON.parse(document.getElementById('share-data')?.textContent ?? 'null'))
    createRoot(root).render(<StrictMode><ShareApp doc={doc} /></StrictMode>)
  } catch (e) {
    root.textContent = `This file could not be read: ${e instanceof Error ? e.message : String(e)}`
  }
}
