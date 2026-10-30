/** The harness API as the session share's viewer has it (vite.share.config.ts puts this module where
 *  src/api/client.ts would be): every call refuses at once, nothing is fetched. Defense in depth — under the share's
 *  presentation no component asks for anything (ThreadPresentation.ts). */

import type { api as LiveApi } from '../../../api/client'

const refuse = (name: string) => () => Promise.reject(new Error(`the session share asks nothing of a harness (${name})`))

export const api = new Proxy({}, { get: (_target, name) => refuse(String(name)) }) as typeof LiveApi
