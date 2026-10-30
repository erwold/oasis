// The app icon: one of the product's bots (frontend/public/bots/icons) on a rounded square drawn on Apple's icon grid
// (824 of a 1024 canvas, 100 px margins), rendered at 1024 px by
// the browser Playwright already has (the frontend's playwright-core; OASIS_CODE_ICON_BROWSER names another
// Chromium). electron-builder makes the .icns / .ico from build/icon.png.
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..', '..')
const require = createRequire(join(repo, 'frontend', 'package.json'))
const { chromium } = require('playwright-core')

const bot = process.argv[2] ?? '08-prompt'
const png = readFileSync(join(repo, 'frontend', 'public', 'bots', 'icons', `${bot}.png`)).toString('base64')
const html = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;background:transparent}
/* Apple's macOS icon grid: a 1024 canvas, the rounded square 824 wide with 100 px of transparent margin around it,
   its corners at 22.5 % — so the icon sits in the Dock at the same size as every other app's */
.tile{width:824px;height:824px;margin:100px;border-radius:185px;background:linear-gradient(160deg,#fdfdfb 0%,#ececea 100%);box-shadow:inset 0 0 0 5px rgba(0,0,0,.06);display:flex;align-items:center;justify-content:center}
img{width:520px;height:520px;image-rendering:auto;filter:drop-shadow(0 14px 22px rgba(0,0,0,.18))}
</style><div class="tile"><img src="data:image/png;base64,${png}"></div>`
const executablePath = process.env.OASIS_CODE_ICON_BROWSER
const browser = await chromium.launch(executablePath ? { executablePath, args: ['--no-sandbox'] } : { channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 })
await page.setContent(html)
const out = join(here, '..', 'build', 'icon.png')
writeFileSync(out, await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: 1024, height: 1024 } }))
await browser.close()
console.log(`wrote ${out} (bot ${bot})`)
