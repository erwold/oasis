/** The desk as the session share's viewer has it (in place of src/components/Desk.tsx): there is no desk — no card,
 *  no workspace, no ChatGPT page. Nothing in the share calls these (its controls are not mounted); they do nothing. */

import { memo } from 'react'
import type * as Live from '../../../components/Desk'

export const Desk = memo(() => null) as unknown as typeof Live.Desk
export const revealRun: typeof Live.revealRun = () => false
export const raiseWorkspaceCard: typeof Live.raiseWorkspaceCard = () => undefined
export const raiseChatGptCard: typeof Live.raiseChatGptCard = () => undefined
