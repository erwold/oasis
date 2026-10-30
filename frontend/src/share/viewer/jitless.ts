/** The session share's viewer runs under a CSP without 'unsafe-eval'. zod (the contract's schemas) compiles a fast
 *  object parser with `new Function` unless its global config says `jitless`, and probes whether it may (`Function('')`)
 *  while it builds an object schema — a probe the page's CSP would report as a violation even though zod catches it.
 *  zod reads that config from `globalThis.__zod_globalConfig`, created only if absent when zod's core first evaluates.
 *  This module sets it — and it is the viewer entry's FIRST import, so it evaluates before zod and before any schema
 *  of the contract is built (the viewer build checks the order in its output). The app itself never imports it. */

const holder = globalThis as { __zod_globalConfig?: Record<string, unknown> }
holder.__zod_globalConfig = { ...(holder.__zod_globalConfig ?? {}), jitless: true }

export {}
