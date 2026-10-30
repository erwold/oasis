'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { mkdtempSync, readFileSync, rmSync } = require('node:fs')
const { join, resolve } = require('node:path')

test('QA preload verifies ChildProcess.kill and process.kill, refuses groups/unowned PIDs and real launchctl', () => {
  const root = mkdtempSync('/tmp/oasis-qa-guard-test-')
  const log = join(root, 'pids.jsonl')
  const guard = resolve(__dirname, '../../frontend/e2e/ssh-qa-process-guard.cjs')
  try {
    const code = `
      const assert=require('node:assert/strict'),cp=require('node:child_process');
      assert.throws(()=>cp.spawnSync('/bin/launchctl',['list']),/forbids/);
      assert.throws(()=>process.kill(process.pid,'SIGTERM'),/unrecorded/);
      assert.throws(()=>process.kill(-process.pid,'SIGTERM'),/group/);
      (async()=>{
        for(const mode of ['child','process']) {
          const c=cp.spawn('/bin/sleep',['10']);
          const done=new Promise(r=>c.once('exit',r));
          if(mode==='child') c.kill('SIGTERM'); else process.kill(c.pid,'SIGTERM');
          await done;
        }
        console.log('GUARD_OK');
      })().catch(()=>process.exitCode=1);
    `
    const out = execFileSync(process.execPath, ['--require', guard, '-e', code], { encoding: 'utf8', env: { ...process.env, OASIS_SSH_QA_PID_LOG: log } })
    assert.match(out, /GUARD_OK/)
    const events = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse)
    assert.ok(events.some((e) => e.event === 'signal-verified'))
    assert.ok(events.some((e) => e.event === 'process-signal-verified'))
    assert.equal(events.filter((e) => e.event === 'process-signal-refused-unowned-or-group').length, 2)
    assert.ok(events.some((e) => e.event === 'forbidden-launchctl'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})
