// The license files a packaged app carries (read-only checks over committed fixtures; nothing is written or removed).
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { LICENSE_RESOURCES, licenseExtraResources, licenseResourceProblems, missingLicenseEntries } = require('../packaging')

const desktop = path.resolve(__dirname, '..')
const fixtures = path.join(__dirname, 'fixtures')

test('package.json build.extraResources copies every license file explicitly', () => {
  const extra = require('../package.json').build.extraResources
  assert.deepEqual(missingLicenseEntries(extra), [])
  for (const want of ['licenses/LICENSE', 'licenses/NOTICE', 'licenses/THIRD_PARTY_NOTICES.md', 'licenses/electron/LICENSE', 'licenses/electron/LICENSES.chromium.html']) {
    assert.ok(licenseExtraResources().some((e) => e.to === want), want)
  }
})

test('a list without the Electron licenses is reported, entry by entry', () => {
  const extra = require('../package.json').build.extraResources.filter((e) => !String(e.from).includes('electron'))
  assert.deepEqual(missingLicenseEntries(extra).map((e) => e.to), ['licenses/electron/LICENSE', 'licenses/electron/LICENSES.chromium.html'])
})

test('the repository-side sources of the license resources exist (Electron\'s once its binary is installed)', () => {
  // Electron's binary (and the license files beside it) arrives with its install script; a checkout installed with
  // --ignore-scripts lacks it
  const electronDist = path.join(desktop, 'node_modules', 'electron', 'dist')
  for (const r of LICENSE_RESOURCES) {
    const source = path.resolve(desktop, r.from)
    if (r.from.startsWith('node_modules/electron/dist/') && !fs.existsSync(electronDist)) {
      console.log(`# ${r.from}: Electron\'s binary is not installed here; checked at packaging time by verify_pack`)
      continue
    }
    assert.ok(fs.existsSync(source), `${r.from} -> ${source}`)
  }
})

test('a complete resources folder passes the check', () => {
  assert.deepEqual(licenseResourceProblems(path.join(fixtures, 'resources-ok')), [])
})

test('missing, empty and wrong license files each fail the check by name', () => {
  const problems = licenseResourceProblems(path.join(fixtures, 'resources-bad'))
  assert.ok(problems.some((p) => p.includes('licenses/LICENSE lacks "Apache License"')), problems.join('\n'))
  assert.ok(problems.some((p) => p === 'license resource empty: licenses/NOTICE'), problems.join('\n'))
  assert.ok(problems.some((p) => p.includes('licenses/vendored')), problems.join('\n'))
  assert.ok(problems.some((p) => p.startsWith('license resource missing: licenses/electron/LICENSES.chromium.html')), problems.join('\n'))
  assert.ok(!problems.some((p) => p.includes('THIRD_PARTY_NOTICES')), problems.join('\n'))
  assert.equal(problems.length, 4, problems.join('\n'))
})

test('a folder with nothing in it reports every license resource missing', () => {
  const problems = licenseResourceProblems(path.join(fixtures, 'no-such-resources-folder'))
  assert.equal(problems.length, LICENSE_RESOURCES.length)
})
