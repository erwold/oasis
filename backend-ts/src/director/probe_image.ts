/** A probe, not a director surface: whether an MCP client (ChatGPT's connector) sees an image a tool returns as MCP
 *  image content. Served at `/<token>/mcp/probe-image`, apart from every frozen surface; its one tool, probe_image,
 *  draws a new picture on every call — four random digits on a random background colour — and returns it as an
 *  `image` content block beside a text block that names neither. What it drew goes to the gateway's log only, so the
 *  client's answer can be checked against it. */

import { randomInt } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

const COLOURS: Record<string, [number, number, number]> = {
  red: [200, 30, 30], green: [20, 140, 40], blue: [30, 60, 200], orange: [235, 130, 20], purple: [120, 40, 160],
}

// seven segments of a digit: a top, b top right, c bottom right, d bottom, e bottom left, f top left, g middle
const SEGMENTS = ['abcdef', 'bc', 'abged', 'abgcd', 'fgbc', 'afgcd', 'afgedc', 'abc', 'abcdefg', 'abfgcd']

const CRC = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0 }
  return table
})()
const crc32 = (bytes: Uint8Array) => { let c = 0xffffffff; for (const b of bytes) c = CRC[(c ^ b) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }

function png(width: number, height: number, rgb: Uint8Array): Uint8Array {
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length)
    const view = new DataView(out.buffer)
    view.setUint32(0, data.length)
    out.set(new TextEncoder().encode(type), 4)
    out.set(data, 8)
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
    return out
  }
  const header = new Uint8Array(13)
  const hv = new DataView(header.buffer)
  hv.setUint32(0, width); hv.setUint32(4, height); header[8] = 8; header[9] = 2
  const raw = new Uint8Array((width * 3 + 1) * height)
  for (let y = 0; y < height; y += 1) raw.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), y * (width * 3 + 1) + 1)
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', new Uint8Array(deflateSync(raw))), chunk('IEND', new Uint8Array())]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

/** Four digits in white seven-segment strokes on `colour`, 480×240. */
export function drawProbe(digits: string, colour: [number, number, number]): Uint8Array {
  const W = 480, H = 240
  const rgb = new Uint8Array(W * H * 3)
  for (let i = 0; i < W * H; i += 1) rgb.set(colour, i * 3)
  const box = (x0: number, y0: number, w: number, h: number) => {
    for (let y = y0; y < y0 + h; y += 1) for (let x = x0; x < x0 + w; x += 1) rgb.set([255, 255, 255], (y * W + x) * 3)
  }
  const dw = 70, dh = 140, t = 14, gap = 40, left = (W - (4 * dw + 3 * gap)) / 2, top = (H - dh) / 2
  ;[...digits].forEach((ch, i) => {
    const x = left + i * (dw + gap), on = SEGMENTS[Number(ch)]!, half = dh / 2
    if (on.includes('a')) box(x, top, dw, t)
    if (on.includes('g')) box(x, top + half - t / 2, dw, t)
    if (on.includes('d')) box(x, top + dh - t, dw, t)
    if (on.includes('f')) box(x, top, t, half)
    if (on.includes('b')) box(x + dw - t, top, t, half)
    if (on.includes('e')) box(x, top + half, t, half)
    if (on.includes('c')) box(x + dw - t, top + half, t, half)
  })
  return png(W, H, rgb)
}

export function buildProbeServer(log: (line: string) => void, pick = () => ({ digits: String(randomInt(0, 10_000)).padStart(4, '0'), colour: Object.keys(COLOURS)[randomInt(0, Object.keys(COLOURS).length)]! })): McpServer {
  const server = new McpServer({ name: 'oasis-code image probe', version: '1' })
  server.registerTool('probe_image', {
    description: 'Returns one picture. Say what number is written in it and what its background colour is.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    const { digits, colour } = pick()
    const bytes = drawProbe(digits, COLOURS[colour]!)
    log(`[probe-image] drew ${digits} on ${colour} (${bytes.length} bytes)`)
    return { content: [
      { type: 'text', text: 'The picture follows as an image content block.' },
      { type: 'image', data: Buffer.from(bytes).toString('base64'), mimeType: 'image/png' },
    ] }
  })
  return server
}
