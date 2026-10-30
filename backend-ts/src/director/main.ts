/** `bun run director`: run the director endpoint beside a running harness. Streamable HTTP on the loopback (the
 *  default; a tunnel carries it to the client, and the tunnel's hostname is named with --allow-host) or stdio (for a
 *  tunnel client that spawns the server itself). */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CURRENT_DIRECTOR_TOOL_SURFACE, DIRECTOR_TOOL_SURFACES, type DirectorToolSurface } from '@oasis-code/contract'
import { loadOrMintToken, printedToken } from '../api/auth.ts'
import { getSettings, type Settings } from '../config.ts'
import { buildHttpApp, mcpUrl } from './app.ts'
import { Harness, HarnessError } from './harness.ts'
import { buildServer } from './server.ts'

const HOST = '127.0.0.1'
const USAGE = `usage: bun run director [--transport streamable-http|stdio] [--port N] [--harness URL] [--allow-host HOST]... [--surface director.v1|director.v2|director.v3|director.v4|director.v5]`

export interface Args { transport: 'streamable-http' | 'stdio'; port: number | null; harness: string | null; allow_host: string[]; surface: DirectorToolSurface }

export function parseArgs(argv: string[]): Args {
  const args: Args = { transport: 'streamable-http', port: null, harness: null, allow_host: [], surface: 'director.v1' }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    const value = () => { const v = argv[i + 1]; if (v === undefined) throw new Error(`${arg} needs a value\n${USAGE}`); i += 1; return v }
    if (arg === '--transport') {
      const t = value()
      if (t !== 'streamable-http' && t !== 'stdio') throw new Error(`--transport must be streamable-http or stdio\n${USAGE}`)
      args.transport = t
    } else if (arg === '--port') args.port = Number(value())
    else if (arg === '--harness') args.harness = value()
    else if (arg === '--allow-host') args.allow_host.push(value())
    else if (arg === '--surface') {
      const surface = value()
      if (!(DIRECTOR_TOOL_SURFACES as readonly string[]).includes(surface)) throw new Error(`--surface must be one of ${DIRECTOR_TOOL_SURFACES.join(', ')}\n${USAGE}`)
      args.surface = surface as DirectorToolSurface
    }
    else throw new Error(`unknown option ${arg}\n${USAGE}`)
  }
  return args
}

export function sessionToken(settings: Settings): string {
  if (settings.session_token) return settings.session_token
  const path = join(settings.data_dir, 'session-token')
  let token = ''
  try { token = existsSync(path) ? readFileSync(path, 'utf8').trim() : '' } catch { token = '' }
  if (!token) throw new HarnessError(0, `no session token at ${path}: start the harness first (it writes the token there), or set OASIS_CODE_SESSION_TOKEN`)
  return token
}

export async function serve(args: Args, settings: Settings): Promise<void> {
  const harnessUrl = args.harness ?? `http://${settings.host}:${settings.port}`
  const harness = Harness.connect(harnessUrl, sessionToken(settings))
  try {
    const build = await harness.probe()
    if (args.transport === 'stdio') {
      console.warn(`oasis-code director on stdio (harness ${harnessUrl}, api ${build.api_version})`)
      // stdio is one client's own process: the surface it asks for (--surface), v1 by default as before
      const server = buildServer(harness, { surface: args.surface })
      await server.connect(new StdioServerTransport())
      await new Promise<void>((resolve) => { server.server.onclose = () => resolve() })
      return
    }
    const token = loadOrMintToken(settings.director_token, settings.data_dir, 'director-token')
    const port = args.port ?? settings.director_port
    const hosts = [...settings.director_allowed_hosts, ...args.allow_host]
    const log = (line: string) => console.warn(`${new Date().toISOString()} ${line}`)
    const app = buildHttpApp((client, surface) => buildServer(client ? harness.as(client) : harness, { surface, log }), token, hosts, log)
    const server = Bun.serve({ hostname: HOST, port, fetch: app.fetch, idleTimeout: 255 })
    const printed = printedToken(token, { explicit: !!settings.director_token, env: 'OASIS_CODE_DIRECTOR_TOKEN', dataDir: settings.data_dir, filename: 'director-token' }, process.stderr.isTTY === true)
    console.warn(`oasis-code director on ${mcpUrl(HOST, server.port ?? port, printed.token)}  (${printed.note ? `${printed.note}; ` : ''}harness ${harnessUrl}, api ${build.api_version}; accepted host names: loopback${hosts.map((h) => `, ${h}`).join('')})`)
    // the link above keeps director.v1 (a connector configured with it keeps its tools); a new connector takes the newest
    console.warn(`oasis-code director (tool surface ${CURRENT_DIRECTOR_TOOL_SURFACE}) on ${mcpUrl(HOST, server.port ?? port, printed.token, CURRENT_DIRECTOR_TOOL_SURFACE)}`)
    await new Promise<void>((resolve) => {
      const stop = () => { server.stop(); resolve() }
      process.on('SIGINT', stop)
      process.on('SIGTERM', stop)
    })
  } finally {
    await harness.close()
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  // stdout is the protocol channel on stdio; everything this process says goes to stderr on both transports
  let args: Args
  try { args = parseArgs(argv) } catch (error) { process.stderr.write(`director: ${(error as Error).message}\n`); return 2 }
  try {
    await serve(args, getSettings())
  } catch (error) {
    if (error instanceof HarnessError) { process.stderr.write(`director: ${error.detail}\n`); return 1 }
    throw error
  }
  return 0
}

if (import.meta.main) process.exit(await main())
