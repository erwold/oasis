/** Load every tool implementation once; each registers itself on import. */

import './files.ts'
import './commands.ts'
import './web.ts'
import './watches.ts'
import './computer.ts'
import './ui.ts'
import './ui_interaction.ts'
import './images.ts'
import './ssh.ts'

export { specs, surface, specOf } from './registry.ts'
