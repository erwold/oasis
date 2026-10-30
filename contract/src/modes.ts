/** User-facing permission presets. They never relax path policies, locks or the sandbox. */
export const HARNESS_MODES = ['auto', 'approve', 'plan'] as const
export type HarnessMode = typeof HARNESS_MODES[number]
export type EffectiveMode = HarnessMode | 'custom'
export interface ModeGrants {
  workspace_write: boolean
  run_commands: boolean
  network: boolean
  attached_write: boolean
}
export interface ModeControl { desired_state: string; gate_effects: string[] }
export const MODE_LABELS: Record<EffectiveMode, string> = {
  auto: 'Auto', approve: 'Ask before changes', plan: 'Plan', custom: 'Custom permissions',
}
export const MODE_DESCRIPTIONS: Record<HarnessMode, string> = {
  auto: 'Edit, run commands and use the network in the isolated workspace, and write an attached original folder.',
  approve: 'Read freely; review file edits and commands before they execute.',
  plan: "Read, search the web and plan. Agent tools cannot edit, execute commands or delegate. An agent can look at its own browser tabs (its first is a blank page) and the ChatGPT page, but cannot navigate, open, switch or close a tab, or click or type on a page. Change mode to implement.",
}
const APPROVAL_EFFECTS = ['workspace_write', 'isolated_code_execution', 'state_change', 'network']
export function modePolicy(mode: HarnessMode) {
  if (!(HARNESS_MODES as readonly string[]).includes(mode)) throw new Error(`Unknown harness mode: ${mode}`)
  return {
    grants: { workspace_write: mode !== 'plan', run_commands: mode !== 'plan', attached_write: mode !== 'plan',
      network: true, network_until: null, network_reason: null },
    control: { desired_state: mode === 'auto' ? 'run' : 'pause', gate_effects: mode === 'approve' ? [...APPROVAL_EFFECTS] : [] },
  }
}
/** Where an agent's shell commands run, beside the mode (orthogonal to auto / approve / plan, which decide what is
 *  asked and what is allowed): `full` — as the user, outside any sandbox: the user's HOME, login shell environment,
 *  network and files; `sandbox` — inside the OS isolation runtime (the workspace writable, the credential stores and
 *  the harness's data unreadable, the network as the session grants it). A session holds one; a new session made by
 *  the app or the REST API is `full` unless it names another; the v28 upgrade set every session made before access
 *  modes existed (schema v27 and earlier) to `full` (backend-ts/src/db/database.ts). Plan runs no command in either. Checkpoints and undo cover the working
 *  folder only, in both. */
export const ACCESS_MODES = ['full', 'sandbox'] as const
export type AccessMode = typeof ACCESS_MODES[number]
/** The access of a session the app or the REST API makes without naming one. */
export const DEFAULT_ACCESS_MODE: AccessMode = 'full'
/** The access where none is named at the database layer (a session the repository makes without one, a proposal
 *  pinned before access modes existed) or a stored value not readable as one: the sandbox (fail closed). */
export const LEGACY_ACCESS_MODE: AccessMode = 'sandbox'
export const ACCESS_LABELS: Record<AccessMode, string> = { full: 'Full access', sandbox: 'Sandbox' }
/** A stored access value as one of the modes: anything but `full` reads as the sandbox. */
export function accessOf(value: unknown): AccessMode {
  return value === 'full' ? 'full' : 'sandbox'
}
/** The narrowest of several accesses: the sandbox when any is the sandbox; null / undefined entries are no cap. */
export function narrowestAccess(...modes: (AccessMode | null | undefined)[]): AccessMode {
  return modes.some((m) => m === 'sandbox') ? 'sandbox' : 'full'
}
/** Infer legacy/custom sessions without silently overwriting their permissions. */
export function inferMode(grants: ModeGrants, control: ModeControl): EffectiveMode {
  if (!grants.workspace_write && !grants.run_commands && !grants.attached_write &&
      control.desired_state === 'pause' && control.gate_effects.length === 0) return 'plan'
  // the network and the attached folder are add-ons beside a mode (both on by default; choosing a mode turns the
  // network on and the attached folder on, Plan's off), not a mode of their own
  if (!grants.workspace_write || !grants.run_commands) return 'custom'
  if (control.desired_state === 'run' && control.gate_effects.length === 0) return 'auto'
  const effects = new Set(control.gate_effects)
  if (control.desired_state === 'pause' && effects.size === APPROVAL_EFFECTS.length &&
      APPROVAL_EFFECTS.every((effect) => effects.has(effect))) return 'approve'
  return 'custom'
}
/** Plan is enforced at the tool execution boundary, not just explained in a system prompt. Plan reads the workspace
 * and the web; unknown effects fail closed in Plan. Other modes still cross their existing permission checks. */
export function allowsAgentEffect(mode: EffectiveMode, effect: string): boolean {
  return mode !== 'plan' || effect === 'read' || effect === 'network'
}
