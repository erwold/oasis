/** The loopback-only fetch the test suite and the e2e server run under: anything but 127.0.0.1 / ::1 / localhost is
 *  refused before a socket, so a forgotten fake fails loudly instead of reaching a real host. `Bun.fetch` is a
 *  read-only, non-configurable property that cannot be swapped; test_network_guard keeps the source from using it
 *  (or any other outbound transport), so the global fetch is the one door and this guard stands in it. */

export class TestNetworkBlocked extends Error {
  constructor(action: string) {
    super(`the test suite blocked external network ${action}; use a fake fetch`)
    this.name = 'TestNetworkBlocked'
  }
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '[::1]'])

function hostOf(input: string | URL | Request): string {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  try { return new URL(url).hostname } catch { return url }
}

export function isLoopback(host: string): boolean {
  return LOOPBACK.has(host)
}

/** `fetchImpl`, refusing every host but the loopback. */
export function loopbackOnly(fetchImpl: typeof fetch): typeof fetch {
  const guarded = ((input: string | URL | Request, init?: RequestInit) => {
    const host = hostOf(input)
    if (!isLoopback(host)) throw new TestNetworkBlocked(`fetch ${host}`)
    return fetchImpl(input, init)
  }) as typeof fetch
  Object.assign(guarded, { preconnect: fetchImpl.preconnect })
  return guarded
}

/** Puts the guard in place of the global fetch; returns the fetch it replaced. */
export function installNetworkGuard(): typeof fetch {
  const original = globalThis.fetch
  globalThis.fetch = loopbackOnly(original)
  return original
}
