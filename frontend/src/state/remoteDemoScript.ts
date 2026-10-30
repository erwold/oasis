import { demo, type DemoScript } from './demoTimeline.ts'

/** The address the walkthrough shows: a reserved name (.invalid never resolves), `key` standing where the secret
 *  goes, and the real path — short enough to be read whole. The card's real address is never handed to it. */
export const REMOTE_DEMO_URL = 'https://demo.invalid/key/mcp/current'

/** Connecting ChatGPT to oasis-code, as ChatGPT's own steps name it (developers.openai.com/plugins/quickstart):
 *  remote access on and its address copied; Plugins → + → Add custom MCP server; a name, the address, No
 *  authentication; the risk acknowledged, Create as a plugin; the personal plugin installed; a Work chat, @oasis-code. */
export const REMOTE_DEMO_SCRIPT: DemoScript = [
  demo.scene('oasis', 'Turn on, copy the address'),
  demo.wait(400), demo.move('toggle', 650), demo.click(), demo.set('on', '1'), demo.wait(650),
  demo.set('address', '1'), demo.wait(550), demo.move('copy', 550), demo.click(), demo.set('copied', '1'), demo.wait(1200),

  demo.scene('plugins', 'Plugins → + → Add custom MCP server'),
  demo.wait(350), demo.move('nav-plugins', 650), demo.click(), demo.set('plugins', '1'), demo.wait(500),
  demo.move('plus', 550), demo.click(), demo.set('menu', '1'), demo.wait(450), demo.move('add-custom', 500), demo.click(), demo.wait(900),

  demo.scene('server', 'Name, URL, No authentication'),
  demo.wait(350), demo.move('name', 550), demo.click(), demo.type('name', 'oasis-code', 500), demo.wait(200),
  demo.move('desc', 400), demo.click(), demo.type('desc', 'Code on my Mac', 550), demo.wait(250),
  demo.move('server-url', 500), demo.click(), demo.set('server-url', '1'), demo.wait(550),
  demo.move('auth', 500), demo.click(), demo.set('auth', '1'), demo.wait(1100),

  demo.scene('risk', 'I understand → Create as a plugin'),
  demo.wait(350), demo.move('risk', 600), demo.click(), demo.set('risk', '1'), demo.wait(450),
  demo.move('create', 550), demo.click(), demo.set('created', '1'), demo.wait(1200),

  demo.scene('install', 'Your plugins → oasis-code → +'),
  demo.wait(350), demo.move('plugin-card', 600), demo.click(), demo.set('open', '1'), demo.wait(500),
  demo.move('install', 550), demo.click(), demo.set('installed', '1'), demo.wait(1200),

  demo.scene('work', 'New chat → Work → @oasis-code'),
  demo.wait(350), demo.move('new-chat', 550), demo.click(), demo.set('fresh', '1'), demo.wait(450), demo.move('tab-work', 600), demo.click(), demo.set('work', '1'), demo.wait(500),
  demo.move('composer', 500), demo.click(), demo.type('prompt', '@', 150), demo.set('mention', '1'), demo.wait(450),
  demo.move('mention-item', 450), demo.click(), demo.set('picked', '1'), demo.wait(1500),
]
