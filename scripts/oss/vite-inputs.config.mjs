// The frontend's own Vite config plus one plugin that records which modules and assets the bundle actually holds,
// for scripts/oss/third-party-notices.mjs --frontend-inputs. Run from frontend/ with the native config loader
// (no temporary bundled config file is written or removed) and an output folder of its own:
//
//   cd frontend && OASIS_CODE_INPUTS_OUT=/new/dir/frontend-inputs.json \
//     npx vite build --configLoader native --config ../scripts/oss/vite-inputs.config.mjs \
//       --outDir /new/dir/dist --emptyOutDir false
//
// Needs a Node that strips TypeScript types (22.18+ / 23.6+), since it imports frontend/vite.config.ts as is.

import { writeFileSync } from 'node:fs'
import base from '../../frontend/vite.config.ts'

const out = process.env.OASIS_CODE_INPUTS_OUT
if (!out) throw new Error('set OASIS_CODE_INPUTS_OUT to the JSON file to write')

const recorder = {
  name: 'oasis-code-record-inputs',
  generateBundle(_options, bundle) {
    const ids = new Set()
    for (const item of Object.values(bundle)) {
      if (item.type === 'chunk') for (const id of Object.keys(item.modules)) ids.add(id.replace(/^\0/, ''))
      else for (const name of item.originalFileNames ?? []) ids.add(name)
    }
    writeFileSync(out, JSON.stringify([...ids].sort(), null, 1))
  },
}

export default { ...base, plugins: [...(base.plugins ?? []), recorder] }
