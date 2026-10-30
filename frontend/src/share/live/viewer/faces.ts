/** The live link page's bots, carried in the page's script (the build inlines them as `data:` URLs — nothing is
 *  fetched for a bot). A v2 state names each bot itself (the backend's, by the app's own identity: contract bots.ts)
 *  and the page shows it from SHARE_BOT_STILLS. A v1 state carries no face of the app's: the page picks one of a few
 *  stills from the state's own sanitized labels (its model's name, its participant), the same run the same bot on
 *  every state — kept as it was for v1 links. */

import { CHATGPT_BOT, DIRECTOR_BOT } from '../../../state/outline.ts'
import type { LiveRun } from '@oasis-code/contract'
import type { ShareFace } from '../../document.ts'
import b_01_keycap from './bots/01-keycap.png'
import b_02_terminal from './bots/02-terminal.png'
import b_03_cursor from './bots/03-cursor.png'
import b_04_braces from './bots/04-braces.png'
import b_05_bubble from './bots/05-bubble.png'
import b_07_pixel from './bots/07-pixel.png'
import b_08_prompt from './bots/08-prompt.png'
import b_09_spark from './bots/09-spark.png'
import b_10_hex from './bots/10-hex.png'
import b_13_puzzle from './bots/13-puzzle.png'
import b_15_rocket from './bots/15-rocket.png'
import b_16_lens from './bots/16-lens.png'
import b_17_shield from './bots/17-shield.png'
import b_18_robot from './bots/18-robot.png'
import b_19_chip from './bots/19-chip.png'
import b_20_at from './bots/20-at.png'
import b_21_megaphone from './bots/21-megaphone.png'
import b_22_whistle from './bots/22-whistle.png'
import b_23_signpost from './bots/23-signpost.png'
import b_24_badge from './bots/24-badge.png'
import b_25_compass from './bots/25-compass.png'
import b_26_crownblob from './bots/26-crownblob.png'
import b_27_crown from './bots/27-crown.png'
import b_28_flag from './bots/28-flag.png'
import b_29_lighthouse from './bots/29-lighthouse.png'
import b_30_telescope from './bots/30-telescope.png'
import b_31_pin from './bots/31-pin.png'
import b_32_helm from './bots/32-helm.png'
import b_33_bell from './bots/33-bell.png'
import b_chatgpt from './bots/chatgpt.png'
import b_director from './bots/director.png'

/** Every bot a share may name, its still drawn small (64 px at most, its own proportions: scripts/share-bot-stills.mjs
 *  makes them from public/bots/icons), carried in the page's script: a v2 state names its bots (the backend computed
 *  them with the app's own identity, contract bots.ts) and the page shows each of them, asking nothing for one. */
export const SHARE_BOT_STILLS: Readonly<Record<string, string>> = {
  '01-keycap': b_01_keycap,
  '02-terminal': b_02_terminal,
  '03-cursor': b_03_cursor,
  '04-braces': b_04_braces,
  '05-bubble': b_05_bubble,
  '07-pixel': b_07_pixel,
  '08-prompt': b_08_prompt,
  '09-spark': b_09_spark,
  '10-hex': b_10_hex,
  '13-puzzle': b_13_puzzle,
  '15-rocket': b_15_rocket,
  '16-lens': b_16_lens,
  '17-shield': b_17_shield,
  '18-robot': b_18_robot,
  '19-chip': b_19_chip,
  '20-at': b_20_at,
  '21-megaphone': b_21_megaphone,
  '22-whistle': b_22_whistle,
  '23-signpost': b_23_signpost,
  '24-badge': b_24_badge,
  '25-compass': b_25_compass,
  '26-crownblob': b_26_crownblob,
  '27-crown': b_27_crown,
  '28-flag': b_28_flag,
  '29-lighthouse': b_29_lighthouse,
  '30-telescope': b_30_telescope,
  '31-pin': b_31_pin,
  '32-helm': b_32_helm,
  '33-bell': b_33_bell,
  'chatgpt': b_chatgpt,
  'director': b_director,
}

/** the stills the page carries, by bot name (each a name of the product's set) */
export const LIVE_BOT_STILLS: Readonly<Record<string, string>> = Object.fromEntries(
  ['03-cursor', '04-braces', '05-bubble', '08-prompt', '16-lens', '18-robot', DIRECTOR_BOT, CHATGPT_BOT].map((b) => [b, SHARE_BOT_STILLS[b]!]))
const PICKS = ['05-bubble', '03-cursor', '04-braces', '08-prompt', '16-lens', '18-robot'] as const

function hashOf(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}

/** The face of each run of the state: none for an action's run (the app draws none), ChatGPT's mark for ChatGPT, else
 *  a bot picked by its participant and model's labels; a participant's turn other than the main one is enclosed. */
export function liveFaces(runs: readonly LiveRun[]): Record<string, ShareFace> {
  const faces: Record<string, ShareFace> = {}
  for (const r of runs) {
    if (r.request === 'action') { faces[r.key] = { bot: null, enclosed: false }; continue }
    if (/^chatgpt\b/i.test(r.model_label)) { faces[r.key] = { bot: CHATGPT_BOT, enclosed: false }; continue }
    const enclosed = r.participant !== null && r.role !== null && r.role !== 'main'
    faces[r.key] = { bot: PICKS[hashOf(`${enclosed ? r.participant : 'main'}:${r.model_label}`) % PICKS.length]!, enclosed }
  }
  return faces
}
