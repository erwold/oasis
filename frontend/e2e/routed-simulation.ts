import type { Browser, Page } from 'playwright-core'

/** A page whose request stand-ins belong to one simulation. */
export async function openRoutedSimulation(browser: Browser): Promise<{ page: Page; close: () => Promise<void> }> {
  const page = await browser.newPage()
  try {
    // Enable interception before navigation, and keep this fallback until the
    // page closes. Removing/re-adding all routes on a live shared page lets a
    // late Playwright cleanup corrupt the next simulation's interceptor state.
    await page.route('**/*', (route) => route.fallback())
    return { page, close: () => page.close() }
  } catch (error) {
    await page.close()
    throw error
  }
}
