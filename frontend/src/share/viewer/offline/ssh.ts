/** SSH hosts as the session share's viewer has them (in place of src/state/ssh.ts and src/components/SshTarget.tsx):
 *  none. Only the app's live turn footer reads them (to offer an undo on a host), and the share never mounts it. */

import { create } from 'zustand'
import type * as LiveSsh from '../../../state/ssh'
import type * as LiveTarget from '../../../components/SshTarget'

export const useSsh = create(() => ({ targets: [], error: null, preview: null })) as unknown as typeof LiveSsh.useSsh
export const allows: typeof LiveSsh.allows = () => false
export const useExecutionTarget: typeof LiveTarget.useExecutionTarget = () => ({ kind: 'local' }) as ReturnType<typeof LiveTarget.useExecutionTarget>
