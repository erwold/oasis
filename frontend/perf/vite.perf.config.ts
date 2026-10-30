import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/** The bench's build (perf/desk.perf.ts builds it into its own temporary folder): the desk's own source, untouched,
 *  with React's profiling build (the Profiler reports render time in a production bundle) and a counter in the
 *  components whose renders the bench counts — every import of one, from anywhere in src, gets the component with a
 *  count at the start of its body: the real body runs in the same component (its hooks, its subscriptions), a memo
 *  stays a memo with the same comparison, so every render is counted, whoever caused it. */

const here = dirname(fileURLToPath(import.meta.url))
const COUNTED = ['FloatingWindow', 'RunView', 'AgentOutline', 'Prose'] as const
const PREFIX = '\0counted:'

function counted(): Plugin {
  const real = new Map(COUNTED.map((name) => [join(here, '..', 'src', 'components', `${name}.tsx`), name]))
  return {
    name: 'bench-counted',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!importer || importer.startsWith(PREFIX)) return null
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
      const name = resolved && real.get(resolved.id)
      return name ? `${PREFIX}${name}` : null
    },
    load(id) {
      if (!id.startsWith(PREFIX)) return null
      const name = id.slice(PREFIX.length)
      const file = join(here, '..', 'src', 'components', `${name}.tsx`)
      return [
        `import { memo } from 'react'`,
        `import * as real from ${JSON.stringify(file)}`,
        `export * from ${JSON.stringify(file)}`,
        `const counts = (window.__counts ??= {})`,
        `const target = real.${name}`,
        `const draw = typeof target === 'function' ? target : target.type`,
        `function counted(props) { counts.${name} = (counts.${name} ?? 0) + 1; return draw(props) }`,
        `export const ${name} = typeof target === 'function' ? counted : memo(counted, target.compare)`,
      ].join('\n')
    },
  }
}

export default defineConfig({
  root: here,
  publicDir: join(here, '..', 'public'),
  plugins: [counted(), react()],
  define: { __OASIS_CODE_BUILD__: JSON.stringify('bench') },
  resolve: { alias: [{ find: /^react-dom\/client$/, replacement: 'react-dom/profiling' }] },
  build: { emptyOutDir: true, minify: false, sourcemap: false, rollupOptions: { input: join(here, 'bench.html') } },
  logLevel: 'warn',
})
