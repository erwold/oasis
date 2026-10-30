import test from 'node:test'
import assert from 'node:assert/strict'
import { HARNESS_MODES, MODE_DESCRIPTIONS, allowsAgentEffect, inferMode, modePolicy, type HarnessMode } from '../../contract/src/modes.ts'

for (const mode of HARNESS_MODES) {
  test(`${mode} round-trips with the network on and original-folder writes allowed (Plan: none)`, () => {
    const policy = modePolicy(mode)
    assert.equal(inferMode(policy.grants, policy.control), mode)
    assert.equal(policy.grants.network, true)
    assert.equal(policy.grants.attached_write, mode !== 'plan')
    assert.equal(policy.grants.network_until, null)
    assert.equal(policy.grants.network_reason, null)
  })
}
test('Auto enables workspace operations but not a sandbox bypass', () => {
  const p = modePolicy('auto')
  assert.equal(p.grants.workspace_write, true)
  assert.equal(p.grants.run_commands, true)
  assert.deepEqual(p.control, { desired_state: 'run', gate_effects: [] })
  assert.equal('sandbox' in p.grants, false)
  assert.equal('locks' in p, false)
})
test('approval mode gates edits, execution, integration and network', () => {
  const p = modePolicy('approve')
  assert.equal(p.control.desired_state, 'pause')
  assert.deepEqual(p.control.gate_effects, ['workspace_write', 'isolated_code_execution', 'state_change', 'network'])
  assert.equal(p.grants.workspace_write, true)
})
test('Plan disables file-write and command grants', () => {
  const p = modePolicy('plan')
  assert.equal(p.grants.workspace_write, false)
  assert.equal(p.grants.run_commands, false)
  assert.equal(p.control.desired_state, 'pause')
})
test('legacy partial grants remain Custom without mutation', () => {
  const p = modePolicy('auto')
  p.grants.run_commands = false
  const before = JSON.stringify(p)
  assert.equal(inferMode(p.grants, p.control), 'custom')
  assert.equal(JSON.stringify(p), before)
})
test('custom gate effects cannot be mislabeled as the approval preset', () => {
  const p = modePolicy('approve')
  p.control.gate_effects.push('compute')
  assert.equal(inferMode(p.grants, p.control), 'custom')
})
test('presets have independent mutable values', () => {
  const a = modePolicy('approve'), b = modePolicy('approve')
  a.control.gate_effects.pop(); a.grants.network = false
  assert.equal(b.control.gate_effects.length, 4)
  assert.equal(b.grants.network, true)
})
test('unknown modes fail closed', () => {
  assert.throws(() => modePolicy('god-mode' as HarnessMode), /Unknown harness mode/)
})
test('the network is an add-on beside Plan: turned off, the session is still in Plan', () => {
  const p = modePolicy('plan')
  p.grants.network = false
  assert.equal(inferMode(p.grants, p.control), 'plan')
})
test('Plan permits reads and the web and refuses every other effect, including unknown tools', () => {
  assert.equal(allowsAgentEffect('plan', 'read'), true)
  assert.equal(allowsAgentEffect('plan', 'network'), true)
  for (const effect of ['compute', 'workspace_write', 'isolated_code_execution', 'state_change', 'new_effect', '']) {
    assert.equal(allowsAgentEffect('plan', effect), false, effect)
  }
})
test('the Plan guard does not replace ordinary permission checks in other modes', () => {
  for (const mode of ['auto', 'approve', 'custom'] as const) {
    assert.equal(allowsAgentEffect(mode, 'workspace_write'), true)
  }
})
test("Plan's description says what an agent may do with the app's pages: look at its own tabs (the first blank) and ChatGPT's, not navigate, use tabs or act on one", () => {
  assert.match(MODE_DESCRIPTIONS.plan, /look at its own browser tabs \(its first is a blank page\) and the ChatGPT page/)
  assert.match(MODE_DESCRIPTIONS.plan, /cannot navigate, open, switch or close a tab, or click or type on a page/)
})
