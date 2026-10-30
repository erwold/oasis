/** Which of the app's modules the session share's viewer has in place of the real ones (paths under src/, without
 *  extension → the stand-in under src/share/viewer/offline/), and which must never enter its bundle at all. One table
 *  for the viewer build (vite.share.config.ts) and the viewer's tests (tests/shareViewer.test.ts). */

export const STAND_INS: Readonly<Record<string, string>> = {
  'state/store': 'store.ts',
  'api/client': 'api.ts',
  'components/Desk': 'Desk.tsx',
  'components/UiSurface': 'inert.tsx',
  'components/UiInput': 'inert.tsx',
  'components/ComputerScreen': 'inert.tsx',
  'components/InteractionEvidence': 'inert.tsx',
  'components/useInteractionWorkspace': 'inert.tsx',
  'state/ssh': 'ssh.ts',
  'components/SshTarget': 'ssh.ts',
}

/** the app's boot, its storage, its streams, its API: never part of the viewer */
export const FORBIDDEN: readonly string[] = [
  ...Object.keys(STAND_INS), 'api/sse', 'api/runStream', 'api/sessionStream', 'api/ssh', 'state/desk', 'state/collabSync', 'state/auth', 'state/theme',
  'components/Composer', 'components/Thread', 'App', 'main', 'demo/liveEntry',
]
