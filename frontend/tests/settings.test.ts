/** Settings' tabs (state/settings.ts): which are shown, which one opens, and how the keys move between them. */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SETTINGS_TAB_LABELS, settingsTabForKey, shownSettingsTab, visibleSettingsTabs } from '../src/state/settings.ts'

test('Accounts, Appearance, Web Search, Connections in that order; no Connections tab without the desktop shell (no empty tab)', () => {
  assert.deepEqual(visibleSettingsTabs({ connections: true }), ['accounts', 'appearance', 'web-search', 'connections'])
  assert.deepEqual(visibleSettingsTabs({ connections: false }), ['accounts', 'appearance', 'web-search'])
  assert.deepEqual(Object.values(SETTINGS_TAB_LABELS), ['Accounts', 'Appearance', 'Web Search', 'Connections'])
})

test('the tab asked for opens when it is there, else the first', () => {
  const all = visibleSettingsTabs({ connections: true })
  const web = visibleSettingsTabs({ connections: false })
  assert.equal(shownSettingsTab(all, 'connections'), 'connections')
  assert.equal(shownSettingsTab(web, 'connections'), 'accounts')
  assert.equal(shownSettingsTab(web, 'appearance'), 'appearance')
})

test('Left and Right wrap, Home and End go to the ends; other keys do nothing', () => {
  const all = visibleSettingsTabs({ connections: true })
  assert.equal(settingsTabForKey(all, 'accounts', 'ArrowRight'), 'appearance')
  assert.equal(settingsTabForKey(all, 'connections', 'ArrowRight'), 'accounts')
  assert.equal(settingsTabForKey(all, 'accounts', 'ArrowLeft'), 'connections')
  assert.equal(settingsTabForKey(all, 'appearance', 'Home'), 'accounts')
  assert.equal(settingsTabForKey(all, 'accounts', 'End'), 'connections')
  for (const key of ['ArrowUp', 'ArrowDown', 'Enter', ' ', 'Tab', 'a']) assert.equal(settingsTabForKey(all, 'appearance', key), null, key)
  assert.equal(settingsTabForKey(visibleSettingsTabs({ connections: false }), 'web-search', 'ArrowRight'), 'accounts')
})
