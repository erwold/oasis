// QA loopback SSH server (the system sshd's preauth Seatbelt sandbox cannot start under the outer sandbox here).
// Real SSH protocol (ssh2): key exchange with the fixture host key; publickey authentication only, for the fixture's
// authorized key only, and accepted only after the client's signature over the session data verifies against that
// key. No session, shell, exec, forwarding or subsystem is ever granted: nothing runs on the "server" side.
// usage: node server.js <fixture-dir>   (listens on 127.0.0.1:<fixture/ssh/port>, logs to fixture/logs/sshserver.log)
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { Server, utils } = require('ssh2')

const fx = fs.realpathSync(process.argv[2])
const port = Number(fs.readFileSync(path.join(fx, 'ssh/port'), 'utf8').trim())
const logPath = path.join(fx, 'logs/sshserver.log')
const log = (line) => fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`)
const allowed = utils.parseKey(fs.readFileSync(path.join(fx, 'ssh/authorized_keys')))
if (allowed instanceof Error) throw allowed
const allowedBlob = allowed.getPublicSSH()
const allowedUser = require('node:os').userInfo().username

const server = new Server({ hostKeys: [fs.readFileSync(path.join(fx, 'ssh/host_key'))] }, (client, info) => {
  log(`connection from ${info.ip}:${info.port} client=${JSON.stringify(info.header && info.header.identRaw)}`)
  client.on('authentication', (ctx) => {
    if (ctx.method !== 'publickey') { log(`auth method=${ctx.method} user=${ctx.username} -> reject`); return ctx.reject(['publickey']) }
    const sameKey = ctx.key.algo === allowed.type && Buffer.compare(ctx.key.data, allowedBlob) === 0
    if (!sameKey || ctx.username !== allowedUser) { log(`publickey user=${ctx.username} algo=${ctx.key.algo} known=${sameKey} -> reject`); return ctx.reject(['publickey']) }
    if (!ctx.signature) { log(`publickey query user=${ctx.username} algo=${ctx.key.algo} -> key acceptable (PK_OK)`); return ctx.accept() }
    const ok = allowed.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true
    log(`publickey signature user=${ctx.username} algo=${ctx.key.algo} sig_bytes=${ctx.signature.length} verified=${ok} -> ${ok ? 'accept' : 'reject'}`)
    return ok ? ctx.accept() : ctx.reject(['publickey'])
  })
  client.on('ready', () => {
    log('QA_SSH_AUTHENTICATED (signature verified)')
    client.on('session', (_accept, reject) => { log('session requested -> rejected'); reject() })
    client.on('request', (accept, reject, name) => { log(`global request ${name} -> rejected`); if (reject) reject() })
    client.on('tcpip', (_a, reject) => { log('tcpip -> rejected'); reject() })
  })
  client.on('close', () => log('connection closed'))
  client.on('error', (e) => log(`client error ${e.message}`))
})
server.listen(port, '127.0.0.1', () => { log(`listening 127.0.0.1:${port} pid=${process.pid}`); console.log(`listening 127.0.0.1:${port}`) })
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { log(`stopping on ${sig}`); server.close(); process.exit(0) })
