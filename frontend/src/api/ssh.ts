/** UI projection of LOCKED-API v1.1. Owned by the frontend until the shared contract lands. */
import { request } from './client'
import type { DirListing } from './types'

export { resourceTarget, sessionTarget, taskTarget, targetKey, parseTarget } from '../state/target.ts'
export type { TargetRef, ExecutionTarget } from '../state/target.ts'
export interface SshTargetInput { label: string; destination: string; port?: number | null; identity_file?: string | null }
export interface SshTarget extends SshTargetInput {
  id: string; state: 'disconnected' | 'connecting' | 'ready' | 'auth_required' | 'host_verification_required' | 'unsupported' | 'error';
  generation: string | null; capabilities: Record<string, boolean>; last_error: string | null; created_at: string;
}
export interface PortForward {
  id: string; target_id: string; workspace_id: string; remote_host: '127.0.0.1'; remote_port: number;
  local_host: '127.0.0.1'; local_port: number; local_url: string; state: 'ready' | 'disconnected' | 'error';
}
export interface RemoteBinding { target_id: string; root_id: string; generation: string; path: string; state_path: string }
const object = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null
function host(value: unknown): SshTarget {
  if (!object(value) || typeof value.id !== 'string' || typeof value.label !== 'string' || typeof value.destination !== 'string'
      || !['disconnected', 'connecting', 'ready', 'auth_required', 'host_verification_required', 'unsupported', 'error'].includes(String(value.state))
      || !object(value.capabilities) || Object.values(value.capabilities).some((v) => typeof v !== 'boolean')) throw new Error('Unknown SSH target')
  return value as unknown as SshTarget
}
function forwards(value: unknown): PortForward[] {
  if (!Array.isArray(value) || value.some((v) => !object(v) || typeof v.id !== 'string' || typeof v.target_id !== 'string' || typeof v.workspace_id !== 'string')) throw new Error('Unknown port forward')
  return value as PortForward[]
}
/** A connector's question to save or connect a host, answered by the person in the app. */
export interface SshAsk { id: string; from: string; title: string; lines: string[]; status: 'pending' | 'connected' | 'declined' | 'failed'; error: string | null }
function asks(value: unknown): SshAsk[] {
  if (!Array.isArray(value) || value.some((v) => !object(v) || typeof v.id !== 'string' || typeof v.title !== 'string' || !Array.isArray(v.lines))) throw new Error('Unknown SSH question')
  return value as SshAsk[]
}
const path = (id: string) => `/api/ssh/targets/${encodeURIComponent(id)}`
export const sshApi = {
  targets: async (): Promise<SshTarget[]> => { const v = await request<unknown>('/api/ssh/targets'); if (!Array.isArray(v)) throw new Error('Unknown SSH targets'); return v.map(host) },
  connect: async (id: string): Promise<SshTarget> => host(await request(`${path(id)}/connect`, { method: 'POST' })),
  dirs: (id: string, directory?: string): Promise<DirListing> => request(`${path(id)}/dirs${directory ? `?path=${encodeURIComponent(directory)}` : ''}`),
  forwards: async (id: string): Promise<PortForward[]> => forwards(await request(`${path(id)}/forwards`)),
  forward: async (id: string, workspace_id: string, remote_port: number): Promise<PortForward> => {
    const v = await request(`${path(id)}/forwards`, { method: 'POST', body: JSON.stringify({ workspace_id, remote_port, remote_host: '127.0.0.1' }) })
    return forwards([v])[0]!
  },
  closeForward: (id: string, forwardId: string): Promise<{ closed: boolean }> => request(`${path(id)}/forwards/${encodeURIComponent(forwardId)}`, { method: 'DELETE' }),
  asks: async (): Promise<SshAsk[]> => asks(await request('/api/ssh/asks')),
  answer: async (askId: string, connect: boolean): Promise<SshAsk> => asks([await request(`/api/ssh/asks/${encodeURIComponent(askId)}/answer`, { method: 'POST', body: JSON.stringify({ connect }) })])[0]!,
}
