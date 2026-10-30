import assert from 'node:assert/strict'
import type { Browser, Page, Route } from 'playwright-core'
import { openRoutedSimulation } from './routed-simulation.ts'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

// Playwright's public API cannot hold the gap between removing its server-side
// interceptor and clearing the dispatcher's matchers. This test-only interface
// targets the installed Playwright's private scheduling seam; the shape checks
// below explain when a dependency change requires updating this regression.
// It delays the real removal rather than inserting duplicate interceptors.
type ServerPage = {
  removeRequestInterceptor: (handler: unknown) => Promise<void>
  requestInterceptors: unknown[]
}
type ServerRoute = {
  _delegate: {
    continue: () => Promise<void>
    fulfill: (response: { status: number; headers: { name: string; value: string }[]; body: string; isBase64: boolean }) => Promise<void>
  }
}
type InternalRoute = Route & { _innerContinue: (...args: unknown[]) => Promise<unknown> }
type InternalPage = Page & {
  _connection: { toImpl: (value: Page | Route) => ServerPage | ServerRoute }
  _onRoute: (route: InternalRoute) => Promise<void>
}

/** Reproduce cleanup's overlapping automatic/explicit removals deterministically. */
export async function verifyRoutedSimulationIsolation(browser: Browser): Promise<void> {
  const shared = await browser.newPage()
  assert.equal(typeof (shared as InternalPage)._connection?.toImpl, 'function', 'Playwright scheduling seam changed: page connection must expose toImpl')
  const serverShared = (shared as InternalPage)._connection.toImpl(shared) as ServerPage
  assert.equal(typeof serverShared.removeRequestInterceptor, 'function', 'Playwright scheduling seam changed: server page must expose removeRequestInterceptor')
  const removed = deferred()
  const releaseRemoval = deferred()
  const removalFinished = deferred()
  const originalRemove = serverShared.removeRequestInterceptor.bind(serverShared)
  let firstRemoval = true
  serverShared.removeRequestInterceptor = async (handler) => {
    await originalRemove(handler)
    if (firstRemoval) {
      firstRemoval = false
      removed.resolve()
      await releaseRemoval.promise
      // The caller clears its matcher list in the following microtask.
      setImmediate(() => removalFinished.resolve())
    }
  }
  let simulation: Awaited<ReturnType<typeof openRoutedSimulation>> | undefined
  try {
    // Finishing a one-use handler starts Playwright's unawaited automatic
    // removal. The explicit cleanup can finish while that removal is held.
    await shared.route('https://fixture.invalid/previous', (route) => route.fulfill({ json: { previous: true } }), { times: 1 })
    await shared.goto('data:text/html,previous simulation')
    await shared.evaluate(async () => (await fetch('https://fixture.invalid/previous')).json())
    await removed.promise
    await shared.unrouteAll({ behavior: 'ignoreErrors' })

    simulation = await openRoutedSimulation(browser)
    const page = simulation.page as InternalPage
    await page.goto('data:text/html,next simulation')
    await page.route((url) => url.pathname === '/matched', (route) => route.fulfill({ json: { mocked: true } }))
    releaseRemoval.resolve()
    await removalFinished.promise
    await page.route((url) => url.pathname === '/unused', (route) => route.fulfill({ json: {} }))

    assert.deepEqual(await page.evaluate(async () => (await fetch('https://fixture.invalid/matched')).json()), { mocked: true })
    const continuation = deferred<Error | undefined>()
    const originalOnRoute = page._onRoute.bind(page)
    page._onRoute = async (route) => {
      if (route.request().url().endsWith('/unmatched')) {
        const serverRoute = page._connection.toImpl(route) as ServerRoute
        // Stand in only for the final native transport. This request must take
        // the normal unmatched fallback path, but opens no socket or server.
        serverRoute._delegate.continue = async () => {
          await serverRoute._delegate.fulfill({
            status: 200,
            headers: [{ name: 'content-type', value: 'application/json' }, { name: 'access-control-allow-origin', value: '*' }],
            body: JSON.stringify({ continued: true }),
            isBase64: false,
          })
          continuation.resolve(undefined)
        }
        const originalContinue = route._innerContinue.bind(route)
        route._innerContinue = async (...args) => {
          try { return await originalContinue(...args) }
          catch (error) { continuation.resolve(error as Error); throw error }
        }
      }
      return originalOnRoute(route)
    }
    const result = page.evaluate(async () => (await fetch('https://fixture.invalid/unmatched')).json()).catch((error: unknown) => error)
    const error = await continuation.promise
    const serverPage = page._connection.toImpl(page) as ServerPage
    assert.equal(error, undefined, `unmatched request failed to continue; ${serverPage.requestInterceptors.length} server interceptors / ${new Set(serverPage.requestInterceptors).size} distinct: ${error?.message}`)
    assert.deepEqual(await result, { continued: true })
  } finally {
    releaseRemoval.resolve()
    await simulation?.close()
    await shared.close()
  }
}
