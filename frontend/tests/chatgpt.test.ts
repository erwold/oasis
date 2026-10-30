import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chatGptAvailable, chatGptReloader, chatGptSignIn, chatGptWarning, startChatGptPage } from '../src/state/desktop.ts'

test("the ChatGPT chip warns of what is missing: a sign-in first, then the connector; nothing while unknown", () => {
  const status = (logged_in: boolean | null, connector: string | null) => ({ started: true, logged_in, connector, model: null })
  assert.equal(chatGptWarning(null), null)
  assert.equal(chatGptWarning(status(false, null)), 'signin')
  assert.equal(chatGptWarning(status(false, '[$oasis-code](app://a)')), 'signin')
  assert.equal(chatGptWarning(status(true, null)), 'connector')
  assert.equal(chatGptWarning(status(null, '[$oasis-code](app://a)')), null)   // the page not read yet: no alarm
  assert.equal(chatGptWarning(status(true, '[$oasis-code](app://a)')), null)
  assert.equal(chatGptAvailable({}), false)
  assert.equal(chatGptAvailable({ oasisCodeDesktop: { platform: 'darwin', openChatGptBridge: async () => null } }), true)
})

test('ChatGPT as a participant reads as connected by its sign-in alone; unknown while the page is not open', () => {
  const status = (started: boolean, logged_in: boolean | null, connector: string | null = null) => ({ started, logged_in, connector, model: null })
  assert.equal(chatGptSignIn(null), undefined)
  assert.equal(chatGptSignIn(status(false, null)), undefined)                       // a look that did not open the page
  assert.equal(chatGptSignIn(status(true, null)), undefined)
  assert.equal(chatGptSignIn(status(true, false)), 'signin')
  assert.equal(chatGptSignIn(status(true, true)), null)                             // no connector needed
  // the page not open, its profile with no sign-in cookie: signed out, and the menu offers the sign-in at once
  assert.equal(chatGptSignIn(status(false, false)), 'signin')
})

test('the page is started before a run types into it, in the desktop app; nothing to start elsewhere', async () => {
  let opened = 0
  await startChatGptPage({ oasisCodeDesktop: { openChatGptBridge: async () => { opened += 1; return { url: 'http://127.0.0.1:8323', token: 't' } } } })
  assert.equal(opened, 1)
  await startChatGptPage({})
  assert.equal(opened, 1)
})

test('the ChatGPT page can be reloaded where the desktop app holds it, and only there', async () => {
  let reloaded = 0
  const reload = chatGptReloader({ oasisCodeDesktop: { reloadChatGpt: async () => { reloaded += 1; return true } } })
  assert.ok(reload)
  assert.equal(await reload!(), true)
  assert.equal(reloaded, 1)
  assert.equal(chatGptReloader({}), null)
  assert.equal(chatGptReloader({ oasisCodeDesktop: { reloadChatGpt: 'no' } }), null)
})
