/** The agent tool surface as this tree's registry describes it: every registered tool's name, description and
 *  parameters (the JSON schema the model reads), in the registry's order — the order a run's request lists them in.
 *  `src/agent/surfaces/agent.v1.json` is this script's output on the baseline tree (main 3d06c7b, schema v24): the
 *  rows a conversation recorded by that build was sent, kept so that its tool list can be rebuilt byte for byte
 *  (and checked against the fingerprint its manifest recorded) whatever the registry says later.
 *
 *    bun run scripts/agent_surface_snapshot.ts > src/agent/surfaces/agent.v1.json   (on the baseline tree) */

import { parametersSchema, specs } from '../src/agent/tools/registry.ts'

const rows = specs().map((s) => ({ name: s.name, description: s.description, parameters: parametersSchema(s) }))
process.stdout.write(`${JSON.stringify({ surface: 'agent.v1', source: 'main 3d06c7b0cb2ede86f3c4e5423037fa05536a478f (schema v24): backend-ts/src/agent/tools registry', rows }, null, 1)}\n`)
