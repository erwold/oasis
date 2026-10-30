// The shell tells the page it runs in the desktop app (the rail leaves room for the traffic lights), lends it the
// system's folder dialog for the start screen's folder chip, starts the ChatGPT bridge for ChatGPT as a participant or
// as the session's director (answering where the bridge listens and with which token), places the ChatGPT page over the desk's ChatGPT card or the
// sign-in sheet, says whether that page is signed in and knows the oasis-code connector, and turns remote access
// (ChatGPT reaching oasis-code through the standing gateway) on or off, sets up its provider and revokes its link; resumes the bridge's sending after its send log was damaged
// (the person looked at the page); places the agent's browser (computer use) over the desk's Browser card, says what
// it shows, hands the card's tabs, address bar, buttons and element picker to it, and clears its profile's data at the
// person's ask; hands the thread's live view the page an agent is acting on, as it is now.
// And it names a PDF or a video the person attached (a File they chose, dropped or pasted) to the harness where it lies:
// the path is Electron's answer for that File (webUtils.getPathForFile), never a string the page wrote; the shell
// registers it under the session token (local_files.js) and the page gets back only the attachment.
// Nothing else is exposed: no file system, no process, no network beyond what the page already has.
const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('oasisCodeDesktop', {
  platform: process.platform,
  pickDirectory: () => ipcRenderer.invoke('pick-directory'),
  // null: the File has no file on disk behind it (made in the page, a pasted picture) — the page uploads it instead;
  // anything that is not a File is refused; a refusal of the shell or the harness rejects (never an upload), except
  // the harness's `copy_instead` (the path is out of the agent's reach, the file is not): null too, and the page uploads it
  attachLocalFile: (sessionId, file) => {
    let where
    try { where = webUtils.getPathForFile(file) } catch { return Promise.reject(new TypeError('attachLocalFile takes a File the person chose, dropped or pasted')) }
    if (typeof where !== 'string' || where === '') return Promise.resolve(null)
    return ipcRenderer.invoke('attach-local-file', { session_id: String(sessionId), path: where, name: file.name, media_type: file.type })
  },
  openChatGptBridge: () => ipcRenderer.invoke('open-chatgpt-bridge'),
  placeChatGpt: (place) => ipcRenderer.send('chatgpt-view', place),
  chatGptStatus: (opts) => ipcRenderer.invoke('chatgpt-status', opts && opts.load === false ? { load: false } : undefined),
  offerChatGptConnector: (mention) => ipcRenderer.invoke('chatgpt-connector', mention),
  reloadChatGpt: () => ipcRenderer.invoke('chatgpt-reload'),
  placeBrowser: (place) => ipcRenderer.send('browser-view', place),
  browserStatus: () => ipcRenderer.invoke('browser-status'),
  browserTab: (change) => ipcRenderer.invoke('browser-tab', change && typeof change === 'object' ? { action: String(change.action), id: change.id === undefined ? undefined : String(change.id), url: change.url === undefined ? undefined : String(change.url) } : null),
  browserNavigate: (change) => ipcRenderer.invoke('browser-navigate', change && typeof change === 'object' ? { action: String(change.action), url: change.url === undefined ? undefined : String(change.url) } : null),
  browserInput: (input) => ipcRenderer.invoke('browser-input', input),
  pickBrowserElement: () => ipcRenderer.invoke('browser-pick'),
  cancelBrowserPick: () => ipcRenderer.invoke('browser-pick-cancel'),
  clearBrowserData: () => ipcRenderer.invoke('browser-clear-data'),
  resumeChatGptSending: () => ipcRenderer.invoke('chatgpt-resume-sending'),
  // the second argument (the browser only): the run whose own current tab the thread's live view shows; without it,
  // the tab the Browser card shows
  surfaceFrame: (surface, owner) => ipcRenderer.invoke('surface-frame', surface === 'chatgpt' ? 'chatgpt' : typeof owner === 'string' && owner ? { surface: 'browser', owner: owner.slice(0, 100) } : 'browser'),
  remoteStatus: () => ipcRenderer.invoke('remote-status'),
  setRemote: (change) => ipcRenderer.invoke('remote-set', change),
  configureRemote: (change) => ipcRenderer.invoke('remote-configure', change && typeof change === 'object' ? { provider: String(change.provider || ''), host: String(change.host || ''), token: typeof change.token === 'string' ? change.token : '' } : null),
  rotateRemote: () => ipcRenderer.invoke('remote-rotate'),
})
