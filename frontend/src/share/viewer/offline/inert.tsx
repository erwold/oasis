/** The thread's interactive blocks as the session share's viewer has them (in place of src/components/UiSurface.tsx,
 *  UiInput.tsx, ComputerScreen.tsx, InteractionEvidence.tsx and useInteractionWorkspace.ts): the snapshot carries no
 *  surface, no form, no live page, no interaction detail (its stats count them as left out), so the share never draws
 *  one; these draw nothing and ask nothing, and keep those modules' requests and storage out of the viewer's bundle. */

import type * as Surface from '../../../components/UiSurface'
import type * as Input from '../../../components/UiInput'
import type * as Screen from '../../../components/ComputerScreen'
import type * as Evidence from '../../../components/InteractionEvidence'
import type * as Workspace from '../../../components/useInteractionWorkspace'

export const UiSurfaceBlock: typeof Surface.UiSurfaceBlock = () => null
export const UiInputBlock: typeof Input.UiInputBlock = () => null
export const ComputerScreen: typeof Screen.ComputerScreen = () => null
export const InteractionEvidence = (() => null) as unknown as typeof Evidence.InteractionEvidence
export const useInteractionWorkspace: typeof Workspace.useInteractionWorkspace = () => ({ workspace: null, error: null } as ReturnType<typeof Workspace.useInteractionWorkspace>)
