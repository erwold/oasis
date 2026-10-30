/** The host a Full access command runs on (execution/host_env.ts): the user's login shell, by name, or refused; the
 *  environment it starts from — the host's, less exactly the harness's control credentials, the keys it copied from
 *  Accounts and its own working-directory variables. No fixture here reads the person's HOME. */

import { expect, test } from 'bun:test'
import { HARNESS_CONTROL_VARIABLES, HostShellRefused, hostCommandEnv, loginShellArgv, loginShellOf, parseSnapshotEnv, snapshotArgv, snapshotCommandEnv, snapshotScript } from '../src/execution/host_env.ts'
import * as access from '../src/policy/access.ts'
import { requestCap, surfaceCap, effectiveAccess } from '../src/policy/access.ts'

test('the login shell is SHELL (else the user record), absolute, executable and one this build runs as a login and interactive shell; anything else is refused', () => {
  expect(loginShellOf({ SHELL: '/bin/zsh' })).toBe('/bin/zsh')
  expect(loginShellOf({ SHELL: '/bin/bash' })).toBe('/bin/bash')
  expect(loginShellOf({}, () => '/bin/zsh')).toBe('/bin/zsh')
  expect(() => loginShellOf({}, () => null)).toThrow(HostShellRefused)
  expect(() => loginShellOf({ SHELL: 'zsh' })).toThrow(/absolute path/)
  expect(() => loginShellOf({ SHELL: '/bin/tcsh' })).toThrow(/is not one/)
  expect(() => loginShellOf({ SHELL: '/nonexistent/zsh' })).toThrow(/not an executable file/)
  expect(loginShellArgv('/bin/zsh', 'echo hi')).toEqual(['/bin/zsh', '-l', '-i', '-c', 'echo hi'])
})

test('the environment is the host\'s less the harness\'s control credentials, the keys it exported from Accounts and its working-directory variables — every other variable of the user\'s stays', () => {
  const host = {
    HOME: '/Users/fixture', TMPDIR: '/var/folders/x/T/', SSH_AUTH_SOCK: '/tmp/agent.sock', PATH: '/usr/bin:/bin',
    OASIS_CODE_SESSION_TOKEN: 't', OASIS_CODE_DIRECTOR_TOKEN: 'd', OASIS_CODE_DATA: '/tmp/private-data',
    MY_SAVED_KEY: 'copied from Accounts', OPENAI_API_KEY: 'exported by the user', PWD: '/backend', OLDPWD: '/before', UNSET: undefined,
  }
  const env = hostCommandEnv(host, { OASIS_CODE_EXECUTION_ID: 'x_1' }, ['MY_SAVED_KEY'])
  expect(env).toEqual({
    HOME: '/Users/fixture', TMPDIR: '/var/folders/x/T/', SSH_AUTH_SOCK: '/tmp/agent.sock', PATH: '/usr/bin:/bin', OASIS_CODE_DATA: '/tmp/private-data',
    OPENAI_API_KEY: 'exported by the user', OASIS_CODE_EXECUTION_ID: 'x_1',
  })
  expect([...HARNESS_CONTROL_VARIABLES]).toEqual(['OASIS_CODE_SESSION_TOKEN', 'OASIS_CODE_DIRECTOR_TOKEN'])
})

test('caps only narrow: v1–v5 and an unknown surface or a connector client of none hold the sandbox; v6 and the person none; a work order\'s filesystem bounds keep Full access, held on the host and said', () => {
  for (const s of ['director.v1', 'director.v2', 'director.v3', 'director.v4', 'director.v5', 'director.v99']) expect(surfaceCap(s), s).toBe('sandbox')
  expect(surfaceCap('director.v6')).toBeNull()
  expect(requestCap({})).toBeNull()
  expect(requestCap({ connector: 'ChatGPT' })).toBe('sandbox')
  expect(requestCap({ connector: 'ChatGPT', surface: 'director.v6' })).toBeNull()
  const order = (o: Record<string, unknown>) => ({ read_only: false, scope: { read: null, write: null }, execution: { network: true }, ...o }) as never
  // changed 2026-10-16 (execution limits): a work order's read-only / scope bounds no longer move a Full access command
  // into the whole sandbox (before: orderNeedsSandbox → 'sandbox'); they are held by the OS on the host and said as the
  // reason `order_bounds`; the network off is the command's own restriction (commands.ts: `network_off`)
  expect(effectiveAccess({ session: { access_mode: 'full' }, order: order({ read_only: true }) })).toBe('full')
  expect(effectiveAccess({ session: { access_mode: 'full' }, order: order({ execution: { network: false } }) })).toBe('full')
  const { accessDecision, orderFilesystemBounds } = access
  expect(orderFilesystemBounds(order({}))).toBeNull()
  expect(orderFilesystemBounds(order({ read_only: true }))).toEqual({ read_only: true, read: null, write: null })
  expect(orderFilesystemBounds(order({ scope: { read: ['src'], write: null } }))).toEqual({ read_only: false, read: ['src'], write: null })
  expect(orderFilesystemBounds(order({ execution: { network: false } }))).toBeNull()
  const bounded = accessDecision({ session: { access_mode: 'full' }, order: order({ scope: { read: null, write: ['src/**'] } }) })
  expect(bounded.effective).toBe('full')
  expect(bounded.reasons.map((r) => r.code)).toEqual(['order_bounds'])
  expect(bounded.reasons[0]!.detail).toContain('write scope ["src/**"]')
  // a cap still narrows to the sandbox, and says which and how to proceed
  const capped = accessDecision({ session: { access_mode: 'full' }, run_cap: 'sandbox', request: 'sandbox' })
  expect(capped).toMatchObject({ requested: 'full', effective: 'sandbox' })
  expect(capped.reasons.map((r) => r.code)).toEqual(['run_cap', 'request_cap'])
  for (const r of capped.reasons) expect(r.next_step.length).toBeGreaterThan(10)
  // a session in the sandbox asked for nothing wider: nothing to explain
  expect(accessDecision({ session: { access_mode: 'sandbox' }, run_cap: 'sandbox' })).toEqual({ requested: 'sandbox', effective: 'sandbox', reasons: [] })
  expect(effectiveAccess({ session: { access_mode: 'full' } })).toBe('full')
  expect(effectiveAccess({ session: { access_mode: 'full' }, run_cap: 'sandbox' })).toBe('sandbox')
  expect(effectiveAccess({ session: { access_mode: 'full' }, pinned: 'sandbox' })).toBe('sandbox')
  expect(effectiveAccess({ session: { access_mode: 'sandbox' }, pinned: 'full' })).toBe('sandbox')
})

test('a command from a snapshot: a plain shell reads the functions (the script path quoted), then runs the command as given; a shell without a script runs the command alone; the snapshot never carries aliases', () => {
  const zsh = snapshotArgv({ shell: '/bin/zsh', env: {}, script: "/tmp/it's here/script.sh", taken_at: 0 }, "echo 'a' && ls")
  expect(zsh).toEqual(['/bin/zsh', '-c', ". '/tmp/it'\\''s here/script.sh' 2>/dev/null\necho 'a' && ls"])
  expect(snapshotArgv({ shell: '/opt/homebrew/bin/fish', env: {}, script: null, taken_at: 0 }, 'echo hi')).toEqual(['/opt/homebrew/bin/fish', '-c', 'echo hi'])
  expect(snapshotScript('/bin/zsh')).toContain('typeset -f')
  expect(snapshotScript('/bin/zsh')).not.toContain('alias')
  expect(snapshotScript('/bin/bash')).not.toContain('alias')
  expect(snapshotScript('/bin/sh')).toBe('env -0 > "$OASIS_CODE_SNAPSHOT_ENV"')
})

test("the snapshot's environment is every pair it wrote less the shell's own (its folder, depth, last argument, the snapshot's paths); a command's is that less the harness's", () => {
  const env = parseSnapshotEnv('PATH=/a:/b\0EQ=x=y\0PWD=/w\0OLDPWD=/o\0SHLVL=2\0_=/usr/bin/env\0OASIS_CODE_SNAPSHOT_ENV=/t/env\0OASIS_CODE_SESSION_TOKEN=tok\0\0')
  expect(env).toEqual({ PATH: '/a:/b', EQ: 'x=y', OASIS_CODE_SESSION_TOKEN: 'tok' })
  expect(snapshotCommandEnv({ shell: '/bin/zsh', env, script: null, taken_at: 0 }, { OASIS_CODE_EXECUTION_ID: 'x1' }, [])).toEqual({ PATH: '/a:/b', EQ: 'x=y', OASIS_CODE_EXECUTION_ID: 'x1' })
})
