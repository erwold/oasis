import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { rememberTokenFromUrl } from './api/client'
import { App } from './App'
import { desktopPlatform } from './state/desktop'
import { appTheme } from './state/theme'
import './index.css'

const root = document.getElementById('root')!
// the live UI demo (a simulated run drawn by the product's components) takes the page instead of the app, loaded only
// when asked for: the app's boot, its token and its sync never start under it (src/demo/liveEntry.tsx)
if (new URLSearchParams(window.location.search).get('demo') === 'live-ui') {
  void import('./demo/liveEntry').then((m) => m.mountLiveDemo(root))
} else {
  rememberTokenFromUrl()
  // the saved theme (index.html already drew it before the first paint): kept on the root, System following the system
  appTheme()
  // inside the desktop shell the window has no title bar: the rail leaves room for the traffic lights (index.css)
  const platform = desktopPlatform(window as { oasisCodeDesktop?: unknown })
  if (platform) document.documentElement.dataset.desktop = platform
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
