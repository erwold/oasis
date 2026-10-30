import type { Page } from 'playwright-core'

/** These existing file/UI/panel scenarios exercise the explicit agent path, not natural-language routing. Click
 * the product's × after every new opening; do not mutate store state or turn the default off for the whole suite. */
export async function bypassDirector(page: Page): Promise<void> {
  await page.waitForSelector('[data-testid="composer"]')
  const remove = page.locator('[data-testid="director-chip-remove"], [data-testid="chatgpt-chip-remove"]')
  if (await remove.count()) await remove.first().click()
}
