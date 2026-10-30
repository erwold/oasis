import assert from 'node:assert/strict'
import { test } from 'node:test'
import { webSearchFixture } from './web-search-fixture.ts'

test('Web Search engines are rows: Use saves at once and persists; DeepSeek asks for the key it shares with Accounts', { timeout: 180_000 }, async () => {
  const { page, close } = await webSearchFixture()
  try {
    const panel = page.getByTestId('settings-panel-web-search')
    const row = (name: string) => panel.locator('.acct-row2', { has: page.locator('strong', { hasText: new RegExp(`^${name}$`) }) })
    assert.deepEqual(await panel.locator('.acct-row2 strong').allTextContents(), ['Automatic', 'Web', 'DeepSeek'])
    assert.match(await row('Automatic').innerText(), /In use/)
    assert.match(await row('DeepSeek').innerText(), /No key/)
    await page.getByTestId('web-search-add-key').click()
    await page.getByTestId('web-search-key').fill('synthetic-search-fixture-key')
    await row('DeepSeek').getByRole('button', { name: 'Save', exact: true }).click()
    await row('DeepSeek').getByText('In use').waitFor()
    assert.equal(await panel.locator('input[type=password]').count(), 0)
    await page.getByTestId('settings-tab-accounts').click()
    assert.match(await page.getByTestId('settings-panel-accounts').innerText(), /DeepSeek/)
    assert.doesNotMatch(await page.getByTestId('settings-dialog').innerText(), /synthetic-search-fixture-key/)
    await page.reload()
    await page.getByTestId('settings').click()
    await page.getByTestId('settings-tab-web-search').click()
    await page.waitForSelector('[data-testid="web-search-use-web"]:enabled')
    assert.match(await row('DeepSeek').innerText(), /In use/)
    assert.doesNotMatch(await row('DeepSeek').innerText(), /No key/)
    await page.getByTestId('web-search-use-web').click()
    await row('Web').getByText('In use').waitFor()
    assert.equal(await panel.locator('input[type=password]').count(), 0)
  } finally { await close() }
})
