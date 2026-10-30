// One devtools-protocol client per page, shared by everything that listens to the page or drives it (the ChatGPT
// tap, the computer driver): Electron gives a page one debugger, and a second attach by someone who does not know
// about the first fails. The client attaches on first use, fans every protocol event out to its listeners, and —
// when the debugger is taken away (the person opened the page's DevTools, the page crashed) — says so to its
// listeners and attaches again on the next command, running each user's setup (`onAttach`) again, so a listener's
// `Network.enable` is not lost with the old session.

const COMMAND_TIMEOUT_MS = 15_000
const clients = new WeakMap()

/** A protocol command that did not answer in time, or a page whose debugger cannot be had now. */
class CdpUnavailable extends Error {
  constructor(message) { super(message); this.name = 'CdpUnavailable' }
}

function withTimeout(promise, ms, what) {
  let timer = null
  const timeout = new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new CdpUnavailable(`${what} did not answer within ${Math.round(ms / 1000)} s`)), ms) })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/** The page's shared client, made on first ask; null for a page without a debugger (a test's fake, say). */
function cdpOf(webContents, { log = () => {} } = {}) {
  const dbg = webContents && webContents.debugger
  if (!dbg) return null
  const known = clients.get(webContents)
  if (known) return known
  const listeners = new Set()
  const attachHooks = new Set()
  const detachHooks = new Set()
  let attached = false
  let lastReason = null

  function attach() {
    if (attached) return true
    try {
      dbg.attach('1.3')
    } catch (error) {
      // attached before by this process (an earlier client of a page that outlived it): usable as it is
      if (!/already attached/i.test(String(error && error.message))) {
        lastReason = String(error && error.message)
        return false
      }
    }
    attached = true
    lastReason = null
    for (const hook of attachHooks) {
      try { hook() } catch (error) { log(`[cdp] a setup after attaching failed: ${error.message}`) }
    }
    return true
  }

  dbg.on('message', (_event, method, params) => {
    for (const listener of listeners) {
      try { listener(method, params || {}) } catch (error) { log(`[cdp] a listener failed on ${method}: ${error.message}`) }
    }
  })
  dbg.on('detach', (_event, reason) => {
    attached = false
    lastReason = String(reason || 'detached')
    log(`[cdp] the page's debugger was detached (${lastReason})`)
    for (const hook of detachHooks) {
      try { hook(lastReason) } catch { /* a listener's own business */ }
    }
  })

  const client = {
    /** Attaches when not attached; false when the page's debugger cannot be had (its DevTools open, say). */
    attach,
    attached: () => attached,
    /** Why the last attach failed or the debugger went away, or null. */
    reason: () => lastReason,
    /** A command, attaching first when needed; rejects as CdpUnavailable when it cannot attach or the page does not
     *  answer in time. */
    send(method, params = {}, timeoutMs = COMMAND_TIMEOUT_MS) {
      if (!attach()) return Promise.reject(new CdpUnavailable(`the page's debugger is not available (${lastReason || 'unknown'})`))
      return withTimeout(Promise.resolve().then(() => dbg.sendCommand(method, params)), timeoutMs, method)
    },
    /** Every protocol event, as (method, params); returns the unsubscribe. */
    on(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    /** A setup run now when attached and again after every attach. */
    onAttach(hook) {
      attachHooks.add(hook)
      if (attached) {
        try { hook() } catch (error) { log(`[cdp] a setup failed: ${error.message}`) }
      }
      return () => attachHooks.delete(hook)
    },
    onDetach(hook) { detachHooks.add(hook); return () => detachHooks.delete(hook) },
    /** The page is going away: the debugger is let go and nobody is told anything more. */
    close() {
      listeners.clear()
      attachHooks.clear()
      detachHooks.clear()
      clients.delete(webContents)
      if (attached) {
        attached = false
        try { dbg.detach() } catch { /* already */ }
      }
    },
  }
  clients.set(webContents, client)
  return client
}

module.exports = { cdpOf, CdpUnavailable, COMMAND_TIMEOUT_MS }
