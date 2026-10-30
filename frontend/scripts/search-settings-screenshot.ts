/** Run only after npm run build; fixture on 8399, isolated headless Chrome profile, no real credentials. */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { webSearchFixture } from '../e2e/web-search-fixture.ts'
const output = mkdtempSync(join(process.env.OASIS_CODE_E2E_TMP || tmpdir(), 'search-settings-shot-'))
const { page, close } = await webSearchFixture()
try {
  await page.getByTestId('web-search-add-key').click()
  await page.getByTestId('settings-dialog').screenshot({ path: join(output, 'web-search.png') })
  await page.getByTestId('settings-tab-accounts').click()
  for (const provider of ['deepseek', 'zhipu']) {
    await page.getByTestId(`add-key-${provider}`).click()
    const input = page.getByTestId(`key-input-${provider}`)
    await input.scrollIntoViewIfNeeded()
    await input.waitFor({ state: 'visible' })
    await page.getByTestId('settings-dialog').screenshot({ path: join(output, `accounts-${provider}.png`) })
  }
  console.log(output)
} finally { await close() }
