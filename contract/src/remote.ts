/** SSH workspace identity and API inputs. Paths here are data for OpenSSH, never key contents. */
import { z } from 'zod'

const NoControls = /^[^\x00-\x1f\x7f]+$/
export const SshTargetInputSchema = z.object({
  label: z.string().trim().min(1).max(200).regex(NoControls),
  destination: z.string().min(1).max(512).regex(/^[^\s\x00-\x1f\x7f-][^\s\x00-\x1f\x7f]*$/),
  port: z.number().int().min(1).max(65535).nullable().optional(),
  identity_file: z.string().min(1).max(4096).regex(NoControls).refine(value => !value.includes('PRIVATE KEY'), 'identity_file accepts a path, not private-key contents').nullable().optional(),
}).strict()
export type SshTargetInput = z.infer<typeof SshTargetInputSchema>
export const SshTargetStateSchema = z.enum(['disconnected', 'connecting', 'ready', 'auth_required', 'host_verification_required', 'unsupported', 'error'])
/** The person's word on a target (schema v31): `connect` (Connect pressed: dialed again after a restart or a lost
 *  connection), `disconnect` (Disconnect pressed: never dialed until Connect), `none` (never connected, or a v30 stop
 *  whose cause cannot be told). The transport's `state` is separate and never changes it. */
export const SshConnectIntentSchema = z.enum(['none', 'connect', 'disconnect'])
export type SshConnectIntent = z.infer<typeof SshConnectIntentSchema>
export const SshTargetSchema = SshTargetInputSchema.extend({
  id: z.string(), state: SshTargetStateSchema, generation: z.string().nullable(),
  capabilities: z.record(z.string(), z.boolean()), last_error: z.string().nullable(), created_at: z.string(),
  connect_intent: SshConnectIntentSchema.default('none'),
})
export type SshTarget = z.infer<typeof SshTargetSchema>
export const TargetRefSchema = z.discriminatedUnion('kind', [z.object({ kind: z.literal('local') }).strict(), z.object({ kind: z.literal('ssh'), target_id: z.string().min(1) }).strict()])
export type TargetRef = z.infer<typeof TargetRefSchema>
export const RemoteWorkspaceBindingSchema = z.object({
  target_id: z.string().min(1), root_id: z.string().min(1), generation: z.string().min(1),
  path: z.string().startsWith('/').regex(NoControls), state_path: z.string().startsWith('/').regex(NoControls),
})
export type RemoteWorkspaceBinding = z.infer<typeof RemoteWorkspaceBindingSchema>
export const RemoteExecutionRefSchema = z.object({ target_id: z.string(), root_id: z.string(), generation: z.string(), job_id: z.string().nullable().optional() })
export const RemoteConnectionStateSchema = z.enum(['connected', 'disconnected', 'unknown'])
export const PortForwardInputSchema = z.object({
  workspace_id: z.string().min(1), remote_port: z.number().int().min(1).max(65535), remote_host: z.literal('127.0.0.1').optional(),
}).strict()
export const PortForwardSchema = z.object({
  id: z.string(), target_id: z.string(), workspace_id: z.string(), remote_host: z.literal('127.0.0.1'), remote_port: z.number().int(),
  local_host: z.literal('127.0.0.1'), local_port: z.number().int(), local_url: z.string(), state: z.enum(['ready', 'disconnected', 'error']),
})
export type PortForward = z.infer<typeof PortForwardSchema>
export const REMOTE_SMALL_FILE_BYTES = 2 * 1024 * 1024
export const REMOTE_STATE_DIRECTORY = '.oasis-remote'
