/** The Settings dialog's tabs (components/AccountsPanel.tsx draws them): Accounts (the subscriptions and API keys),
 *  Appearance (the theme), Connections (Live sharing on every page; Remote access in the desktop shell only — the
 *  dialog shows it on every page now, `connections: false` stays for a page with no card for it). Left and Right (wrapping), Home and End move between the tabs shown, as the ARIA tabs pattern has it. */

export const SETTINGS_TABS = ['accounts', 'appearance', 'web-search', 'connections'] as const
export type SettingsTab = (typeof SETTINGS_TABS)[number]
export const SETTINGS_TAB_LABELS: Record<SettingsTab, string> = { accounts: 'Accounts', appearance: 'Appearance', 'web-search': 'Web Search', connections: 'Connections' }

export function visibleSettingsTabs(opts: { connections: boolean }): SettingsTab[] {
  return SETTINGS_TABS.filter((t) => t !== 'connections' || opts.connections)
}

/** the tab shown: the one asked for when it is there, else the first */
export function shownSettingsTab(tabs: readonly SettingsTab[], wanted: SettingsTab): SettingsTab {
  return tabs.includes(wanted) ? wanted : tabs[0] ?? 'accounts'
}

/** where a key moves the focus from `current` (wrapping), or null for a key that does not move it */
export function settingsTabForKey(tabs: readonly SettingsTab[], current: SettingsTab, key: string): SettingsTab | null {
  if (tabs.length === 0) return null
  const i = Math.max(0, tabs.indexOf(current))
  if (key === 'ArrowRight') return tabs[(i + 1) % tabs.length]!
  if (key === 'ArrowLeft') return tabs[(i - 1 + tabs.length) % tabs.length]!
  if (key === 'Home') return tabs[0]!
  if (key === 'End') return tabs[tabs.length - 1]!
  return null
}
