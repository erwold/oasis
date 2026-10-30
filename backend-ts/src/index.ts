// one entry for the compiled backend: `director …` runs the director endpoint beside a running harness, `gateway …`
// the standing MCP ingress (the desktop app's remote access installs it as a launchd agent), anything else the harness
import { main as director } from './director/main.ts'
import { main as gateway } from './gateway/main.ts'
import { main } from './main.ts'

if (process.argv[2] === 'director') process.exit(await director(process.argv.slice(3)))
else if (process.argv[2] === 'gateway') process.exit(await gateway(process.argv.slice(3)))
else await main()
