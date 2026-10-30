/** The page store as the session share's viewer has it (vite.share.config.ts puts this module where src/state/store.ts
 *  would be): the same `useStore` hook the thread's components read, holding an empty session in memory — no boot, no
 *  token, no sync, no storage read or written, no stream, no request. The real store's module (its initial reads of
 *  the page's storage, its access watch, its API) is never part of the viewer's bundle.
 *
 *  It holds the real store's DATA fields at their initial values (an empty page); it holds no action: under the
 *  share's presentation no component mounts a control that would call one (ThreadPresentation.ts), so a call would be
 *  a bug that throws, never a silent request. */

import { create } from 'zustand'
import type { useStore as LiveStore } from '../../../state/store'

type State = ReturnType<typeof LiveStore.getState>

const EMPTY: Partial<State> = {
  build: null, buildMismatch: null, staleUi: null, models: [], defaultModel: null, projects: [], sessionActivity: null, railSeen: { ready: false, marks: {} },
  session: null, runs: [], notes: [], threads: {}, liveRunId: null, relays: [], relayRounds: 1, interactions: [], orchestration: 'director',
  interactionMaxRuns: null, interactionConcurrency: 2, noteTo: 'director', noteInteractionId: null, replaying: false, workspace: null, diff: null,
  changeView: { run_id: null, path: null }, recordsRunId: null, toast: null, modelChoice: null, directorModel: null, disposers: {}, tree: [], treeOf: null,
  childThreads: {}, childDisposers: {}, sidebarOpen: false, sidebarWidth: 0, draft: '', images: [], composers: {}, notice: null, busy: null, thinking: null,
  mentionThinking: {}, target: null, importRefusal: null, settingsOpen: false, settingsTab: 'accounts', control: null, proposals: [], access: null,
  accessSaving: false, director: null, directorLive: null, directorDisposer: null, composerTarget: 'agent', chatGptSheet: false, uiSurfaces: {}, uiInputs: {},
  uiTaskRuns: {}, pendingSteer: {}, collab: { sessionId: null, status: 'idle', graph: null, revision: null, error: null, told: false }, crossRounds: 1,
  groupPolicy: 'legacy', sendAs: 'main', references: { cites: [], receive: [] },
}

export const useStore = create<State>(() => EMPTY as State) as unknown as typeof LiveStore
