/** One life of the harness, for the restart tests: a process manager on the given data directory starts the command
 *  in the folder, says its execution id, and runs on until it is killed — SIGKILL, as a crash: nothing of it
 *  cleans up. Arguments: the data directory, the folder, the command. */

import { Settings } from '../../src/config.ts'
import { connect } from '../../src/db/database.ts'
import { ProcessManager } from '../../src/execution/processes.ts'
import { AssetStore } from '../../src/store.ts'
import { FAKE_FULL, PassthroughRuntime } from '../harness.ts'

const [dataDir, folder, command] = process.argv.slice(2)
if (!dataDir || !folder || !command) throw new Error('usage: lost_command_life.ts <data dir> <folder> <command>')
const settings = new Settings({ data_dir: dataDir, host: '127.0.0.1', port: 0, session_token: 'test-token' })
const conn = connect(settings.db_path)
const runtime = new PassthroughRuntime()
const processes = new ProcessManager(settings, conn, new AssetStore(settings.assets_dir), runtime, { ...FAKE_FULL, runtime: runtime.name })
const execution = await processes.start({
  command, cwd: folder, project_id: 'p_lost', timeout_s: 120,
  sandbox: { writable: [folder], write_deny: [], read_deny: [], read_allow: [folder], network: false },
})
process.stdout.write(`${JSON.stringify({ execution_id: execution.id })}\n`)
setInterval(() => undefined, 60_000)
