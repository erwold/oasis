/** The build handshake (carried from oasis's, see NOTICE; the oasis lesson — a docs-only commit made every page
 *  refuse — is why only the API version blocks): an incompatible API refuses to render; a page older than the UI the
 *  backend now serves is told to reload, and works meanwhile. */

import type { BuildInfo } from '../api/types'

export const API_VERSION = 'code-v1'

export function handshake(build: BuildInfo, uiBuild: string): { block: string | null; stale: string | null } {
  if (build.api_version !== API_VERSION) return { block: `API version ${build.api_version} ≠ ${API_VERSION} (rebuild the UI)`, stale: null }
  if (build.ui_build && build.ui_build !== uiBuild)
    return { block: null, stale: `This page is UI build ${uiBuild}; the backend now serves ${build.ui_build}. Reload to use it.` }
  return { block: null, stale: null }
}
