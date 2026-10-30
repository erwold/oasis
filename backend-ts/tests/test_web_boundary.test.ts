/** The web tools' network boundary, on the real transport where the boundary is the transport's: local HTTP
 *  canaries only, synthetic names, no external network. A redirect is checked hop by hop before it is followed, an
 *  IPv4 address reached through any IPv6 spelling is refused, a failed lookup opens no connection, and the
 *  connection goes to the address that was checked with the name pinned in Host and in the TLS identity. */

import { afterEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as web from '../src/agent/tools/web.ts'
import { lastToolReturn, modelResponse, textPart, toolCallPart } from '../src/llm/messages.ts'
import { appState, buggyRepo, closeState, openSession, scriptedModel, setModel, waitDone, type AppState } from './harness.ts'
import { originalFetch } from './preload.ts'

const original = { ...web.hooks }
let state: AppState | null = null
const servers: ReturnType<typeof Bun.serve>[] = []
afterEach(async () => {
  web.setWebHooks(original)
  web.forgetMissingIcons()
  for (const s of servers.splice(0)) s.stop(true)
  if (state) await closeState(state)
  state = null
})

async function call(url: string) {
  state = await appState()
  const { session } = await openSession(state, buggyRepo())
  let output: Record<string, unknown> = {}
  setModel(state, 'scripted:a', scriptedModel((messages) => {
    const ret = lastToolReturn(messages, 'fetch_url')
    if (!ret) return modelResponse([toolCallPart('fetch_url', { url }, '')])
    output = ret as Record<string, unknown>
    return modelResponse([textPart('done')])
  }))
  await waitDone(state, (await state.runs.start(session, 'read synthetic local fixture')).id)
  return output
}

test('a real HTTP redirect to the loopback is refused before the loopback is asked anything', async () => {
  let hits = 0
  const target = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => { hits++; return new Response('SYNTHETIC_CANARY') } })
  servers.push(target)
  const source = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${target.port}/canary` } }) })
  servers.push(source)
  let redirectMode: RequestInit['redirect'] | undefined
  // only the public fixture's first hop is mapped to the local source; the real fetch answers the redirect itself
  web.setWebHooks({
    resolve: async () => ['93.184.216.34'],
    fetchImpl: async (_url, init) => { redirectMode = init?.redirect; return fetch(`http://127.0.0.1:${source.port}/redirect`, init) },
  })
  const output = await call('http://qa-public.example.test/redirect')
  expect(redirectMode).toBe('manual')
  expect(output.status).toBe('refused')
  expect(output.reason as string).toContain('redirected to a private')
  expect(hits).toBe(0)
}, 20000)

test('a redirect chain is followed hop by hop, each hop resolved, and ends at a public page', async () => {
  const transport: string[] = []
  const resolved: string[] = []
  web.setWebHooks({
    resolve: async (host) => { resolved.push(host); return ['93.184.216.34'] },
    fetchImpl: async (url, init) => {
      transport.push(`${String(url)} @${init?.address ?? '-'}`)
      const u = new URL(String(url))
      if (u.hostname === 'first.example.test') return new Response(null, { status: 301, headers: { location: 'https://second.example.test/page' } })
      if (u.hostname === 'second.example.test' && u.pathname === '/page') return new Response(null, { status: 307, headers: { location: '/final' } })
      return new Response('FINAL PAGE', { status: 200, headers: { 'content-type': 'text/plain' } })
    },
  })
  const output = await call('http://first.example.test/start')
  expect(output.status).toBe('ok')
  expect(output.final_url).toBe('https://second.example.test/final')
  expect(output.text).toBe('FINAL PAGE')
  // then the site's icon, from where the page landed, resolved and pinned the same way
  expect(resolved).toEqual(['first.example.test', 'second.example.test', 'second.example.test', 'second.example.test'])
  expect(transport).toEqual(['http://first.example.test/start @93.184.216.34', 'https://second.example.test/page @93.184.216.34', 'https://second.example.test/final @93.184.216.34', 'https://second.example.test/favicon.ico @93.184.216.34'])
})

test('a redirect loop ends with a bounded number of hops', async () => {
  let hops = 0
  web.setWebHooks({ resolve: async () => ['93.184.216.34'], fetchImpl: async () => { hops++; return new Response(null, { status: 302, headers: { location: 'http://loop.example.test/again' } }) } })
  const output = await call('http://loop.example.test/')
  expect(output.status).toBe('unreachable')
  expect(output.error as string).toContain('redirects')
  expect(hops).toBe(web.MAX_REDIRECTS + 1)
})

test('an IPv4-mapped IPv6 URL never reaches the real loopback canary, with the default transport and resolver', async () => {
  let hits = 0
  const target = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => { hits++; return new Response('SYNTHETIC_CANARY') } })
  servers.push(target)
  expect(await (await fetch(`http://127.0.0.1:${target.port}/positive`)).text()).toBe('SYNTHETIC_CANARY')
  hits = 0
  const url = `http://[::ffff:127.0.0.1]:${target.port}/canary`
  expect(new URL(url).hostname).toBe('[::ffff:7f00:1]')   // WHATWG spells the mapped address in hex
  web.setWebHooks({ fetchImpl: (input, init) => {
    if (String(input) !== url) throw new Error('the test refuses any transport but the fixture URL')
    return originalFetch(input, init)
  } })
  const output = await call(url)
  expect(hits).toBe(0)
  expect(output.status).toBe('refused')
}, 20000)

test('a lookup that answers nothing refuses before the transport is asked', async () => {
  let calls = 0
  web.setWebHooks({ resolve: async () => [], fetchImpl: async () => { calls++; throw new Error('the resolver must fail closed before this') } })
  const output = await call('http://qa-unresolved.example.test/')
  expect(calls).toBe(0)
  expect(output.status).toBe('refused')
  expect(output.reason as string).toContain('cannot be resolved')
})

test('every private, local, mapped, embedded and reserved address form is refused; public ones are not', async () => {
  const refused = ['localhost', 'localhost.', 'LOCALHOST', 'api.localhost', 'x.internal', 'printer.local', '127.0.0.1', '127.255.255.254', '0.0.0.0', '10.0.0.1', '172.16.0.1', '172.31.255.255',
    '192.168.1.1', '169.254.169.254', '100.64.0.1', '192.0.0.8', '192.0.2.1', '198.51.100.7', '203.0.113.9', '224.0.0.1', '240.0.0.1', '255.255.255.255',
    '[::1]', '::1', '[::]', '[0:0:0:0:0:0:0:1]', '[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[::FFFF:7F00:1]', '[::ffff:a00:1]', '[::ffff:c0a8:101]', '[::ffff:ac10:1]', '[::ffff:0:7f00:1]',
    '[::127.0.0.1]', '[::7f00:1]', '[64:ff9b::7f00:1]', '[64:ff9b::127.0.0.1]', '[64:ff9b:1::1]', '[2002:7f00:1::]', '[2002:c0a8:101::1]', '[fc00::1]', '[fd12:3456::1]', '[fe80::1]',
    '[fe80::1%en0]', '[fec0::1]', '[ff02::1]', '[100::1]', '[2001:db8::1]', 'not an address at all', '[::ffff:999.1.1.1]']
  const publics = ['93.184.216.34', '8.8.8.8', '198.18.0.26', '[2606:4700::1111]', '[2001:4860:4860::8888]', '[::ffff:5db8:d822]', '[::ffff:93.184.216.34]', '[64:ff9b::808:808]', '[2002:808:808::]']
  for (const host of refused) expect(web.refusedAddress(host) || await web.isPrivateHost(host), host).toBe(true)
  for (const host of publics) expect(web.refusedAddress(host), host).toBe(false)
  web.setWebHooks({ resolve: async () => ['93.184.216.34'] })
  for (const host of publics) expect(await web.isPrivateHost(host), host).toBe(false)
  expect(await web.isPrivateHost('public.example.test')).toBe(false)
  web.setWebHooks({ resolve: async () => ['93.184.216.34', '10.0.0.1'] })
  expect(await web.isPrivateHost('mixed.example.test')).toBe(true)         // one private answer among public ones refuses the name
  web.setWebHooks({ resolve: async () => ['93.184.216.34', '::ffff:7f00:1'] })
  expect(await web.isPrivateHost('mapped.example.test')).toBe(true)
  web.setWebHooks({ resolve: async () => [] })
  expect(await web.isPrivateHost('unresolved.example.test')).toBe(true)     // a failed lookup fails closed
  expect(web.ipv6Bytes('::ffff:127.0.0.1')).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 127, 0, 0, 1])
  expect(web.ipv6Bytes('1:2:3:4:5:6:7:8:9')).toBeNull()
  expect(web.ipv6Bytes('1::2::3')).toBeNull()
})

test('the default transport connects to the checked address with the name in Host, and verifies TLS against the name', async () => {
  const seen: string[] = []
  const plain = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (req) => { seen.push(req.headers.get('host') ?? ''); return new Response('PLAIN') } })
  servers.push(plain)
  const name = 'pinned.example.test'
  const response = await web.pinnedFetch(`http://${name}:${plain.port}/x`, { address: '127.0.0.1' })
  expect(await response.text()).toBe('PLAIN')
  expect(seen).toEqual([`${name}:${plain.port}`])
  // an address in the URL connects as it is (no Host rewrite, no server name)
  const direct = await web.pinnedFetch(`http://127.0.0.1:${plain.port}/y`, { address: '127.0.0.1' })
  expect(await direct.text()).toBe('PLAIN')
  expect(seen[1]).toBe(`127.0.0.1:${plain.port}`)
  // https: the certificate is for the name, the connection goes to the address; a wrong name is refused by TLS
  const cert = readFileSync(join(import.meta.dir, 'fixtures', 'tls', `${name}.crt`), 'utf8')
  const key = readFileSync(join(import.meta.dir, 'fixtures', 'tls', `${name}.key`), 'utf8')
  const secure = Bun.serve({ hostname: '127.0.0.1', port: 0, tls: { cert, key }, fetch: (req) => { seen.push(req.headers.get('host') ?? ''); return new Response('SECURE') } })
  servers.push(secure)
  const trusted = { tls: { ca: cert } } as unknown as RequestInit
  const ok = await web.pinnedFetch(`https://${name}:${secure.port}/z`, { address: '127.0.0.1', ...trusted })
  expect(await ok.text()).toBe('SECURE')
  expect(seen[2]).toBe(`${name}:${secure.port}`)
  await expect(web.pinnedFetch(`https://other.example.test:${secure.port}/z`, { address: '127.0.0.1', ...trusted })).rejects.toThrow(/altnames|certificate|does not match/i)
})
