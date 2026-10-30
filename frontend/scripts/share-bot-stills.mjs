// The live link page's bot stills (src/share/live/viewer/bots/): every bot a share may name (the product's set, the
// director's paper plane, ChatGPT's mark), each the app's own still (public/bots/icons) drawn at most SIDE px on its
// longest side, whole, as PNG — small enough for the page's one script to carry them all (vite inlines them as data:
// URLs; the page asks nothing for a bot). Drawn by the browser Playwright already has (the frontend's playwright-core,
// as desktop/scripts/icon.mjs does; OASIS_CODE_ICON_BROWSER names another Chromium): the pictures go in as data: URLs
// and come out of a canvas, nothing is fetched.
//
//   node scripts/share-bot-stills.mjs        (from frontend/; writes src/share/live/viewer/bots/*.png)
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SIDE = 64
const here = dirname(fileURLToPath(import.meta.url))
const frontend = resolve(here, '..')
const require = createRequire(join(frontend, 'package.json'))
const { chromium } = require('playwright-core')

// the names a share may carry: SHARE_BOTS — the product's set (BOTS: contract/src/bots.ts, or src/state/outline.ts
// before the contract carried it), the director's, ChatGPT's
const sources = [join(frontend, '..', 'contract', 'src', 'bots.ts'), join(frontend, 'src', 'state', 'outline.ts')]
const set = sources.map((f) => { try { return /export const BOTS = \[([^\]]+)\]/.exec(readFileSync(f, 'utf8'))?.[1] } catch { return undefined } }).find(Boolean)
const names = [...(set ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1])
if (names.length < 20) throw new Error('could not read the bot set')
names.push('director', 'chatgpt')

const icons = join(frontend, 'public', 'bots', 'icons')
const out = join(frontend, 'src', 'share', 'live', 'viewer', 'bots')
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

const executablePath = process.env.OASIS_CODE_ICON_BROWSER
const browser = await chromium.launch(executablePath ? { executablePath, args: ['--no-sandbox'] } : { channel: 'chrome' })
const page = await browser.newPage()
let total = 0
for (const name of names) {
  const src = `data:image/png;base64,${readFileSync(join(icons, `${name}.png`)).toString('base64')}`
  const data = await page.evaluate(async ({ src, side }) => {
    const img = new Image()
    img.src = src
    await img.decode()
    const scale = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale))
    const ctx = canvas.getContext('2d')
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/png')
  }, { src, side: SIDE })
  const bytes = Buffer.from(data.slice(data.indexOf(',') + 1), 'base64')
  writeFileSync(join(out, `${name}.png`), bytes)
  total += bytes.length
}
await browser.close()
console.log(`wrote ${readdirSync(out).length} stills to ${out} (${SIDE}px, ${(total / 1024).toFixed(1)} KB)`)
