/** Computer use: the pages an agent looks at and acts on through the desktop app (desktop/computer.js), and the
 *  arguments of an action — one shape for the agent's tool (with its descriptions) and for the gate that proposes and
 *  later runs a paused one (without). */

import { z } from 'zod'

/** `browser`: the agent's own browser (its own profile, shown on the desk's Browser card); `chatgpt`: the person's
 *  signed-in ChatGPT page (the bridge's). */
export const COMPUTER_SURFACES = ['browser', 'chatgpt'] as const
export type ComputerSurface = typeof COMPUTER_SURFACES[number]

export const COMPUTER_ACTIONS = ['click', 'double_click', 'right_click', 'hover', 'type', 'key', 'scroll', 'select', 'drag', 'navigate', 'back', 'forward', 'reload', 'upload', 'dialog', 'wait', 'release', 'tab_new', 'tab_select', 'tab_close'] as const
export type ComputerAction = typeof COMPUTER_ACTIONS[number]
/** The agent browser's own tab actions: a run opens, selects and closes its own tabs only (never on chatgpt). */
export const COMPUTER_TAB_ACTIONS = ['tab_new', 'tab_select', 'tab_close'] as const satisfies readonly ComputerAction[]

type Describe = (key: string) => string | undefined

/** The action's arguments; `describe` names each for the model (the gate passes none). */
export function computerActSchema(describe: Describe = () => undefined) {
  const d = <T extends z.ZodType>(schema: T, key: string): T => {
    const text = describe(key)
    return (text === undefined ? schema : schema.describe(text)) as T
  }
  const opt = <T extends z.ZodType>(schema: T, key: string) => d(schema.nullable().default(null), key)
  return z.object({
    surface: d(z.enum(COMPUTER_SURFACES).default('browser'), 'surface'),
    action: d(z.enum(COMPUTER_ACTIONS), 'action'),
    // the browser tab the action is for: one of this run's own (a look names its tab, and an action on that look goes
    // there or nowhere). A proposal recorded before tabs parses without it (null).
    tab_id: opt(z.string(), 'tab_id'),
    snapshot_id: opt(z.string(), 'snapshot_id'),
    ref: opt(z.string(), 'ref'),
    x: opt(z.number(), 'x'),
    y: opt(z.number(), 'y'),
    to_ref: opt(z.string(), 'to_ref'),
    to_x: opt(z.number(), 'to_x'),
    to_y: opt(z.number(), 'to_y'),
    text: opt(z.string(), 'text'),
    clear: d(z.boolean().default(false), 'clear'),
    submit: d(z.boolean().default(false), 'submit'),
    keys: opt(z.string(), 'keys'),
    dx: opt(z.number(), 'dx'),
    dy: opt(z.number(), 'dy'),
    url: opt(z.string(), 'url'),
    files: opt(z.array(z.string()).max(10), 'files'),
    accept: d(z.boolean().default(true), 'accept'),
    seconds: opt(z.number(), 'seconds'),
    gone: d(z.boolean().default(false), 'gone'),
    download: d(z.boolean().default(false), 'download'),
  })
}
export type ComputerActArgs = z.infer<ReturnType<typeof computerActSchema>>
