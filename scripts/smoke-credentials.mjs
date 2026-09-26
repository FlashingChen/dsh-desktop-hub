// Opt-in real-runtime regression for #45. Run with the bundled Node and
// DSH_TEST_RESOURCES pointing at a resources directory containing rt/ and nd/.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse } from 'yaml'
import { startHarness } from '../dist/core/harness.js'

if (!process.env.DSH_TEST_RESOURCES) throw new Error('Set DSH_TEST_RESOURCES to the bundled resources directory')
process.resourcesPath = resolve(process.env.DSH_TEST_RESOURCES)
const runtime = join(process.resourcesPath, 'rt', 'node_modules')
const version = JSON.parse(readFileSync(join(runtime, '@deepseek-ai/dsh/package.json'), 'utf8')).version
console.log(`Runtime ${version}; ${process.platform}/${process.arch}; Node ${process.version}`)
const previousHome = process.env.DSH_HOME
const key = 'fixture-only-not-a-real-key'
for (const kind of ['versioned', 'flat']) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-issue45-'))
  let handle
  try {
    process.env.DSH_HOME = home
    const profile = join(home, 'profiles', 'web')
    mkdirSync(profile, { recursive: true })
    writeFileSync(join(profile, 'package.json'), JSON.stringify({
      name: 'issue45-fixture', private: true,
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
    }))
    symlinkSync(runtime, join(profile, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
    const file = join(home, '.credentials.yaml')
    const source = kind === 'versioned'
      ? `version: 1\nrefs:\n  DEEPSEEK_API_KEY: "${key}"\nrecords:\n  provider/fixture:\n    kind: api-key\n    key: "${key}"\n`
      : `# existing credential\nDEEPSEEK_API_KEY: "${key}"\n`
    writeFileSync(file, source, { mode: 0o600 })
    let starts = 0
    handle = await startHarness({ cwd: home, readyTimeoutMs: 60_000, onSpawn: () => { starts++ } })
    assert.equal(starts, 1)
    // A URL may be printed before the plugin tree finishes activating.
    await new Promise(resolve => setTimeout(resolve, 1500))
    assert.equal(handle.proc.exitCode, null)
    const response = await fetch(handle.url, { signal: AbortSignal.timeout(5000) })
    assert.equal(response.status, 200)
    assert.ok((await response.text()).length > 100)
    const stored = readFileSync(file, 'utf8')
    if (kind === 'versioned') assert.equal(stored, source, 'versioned credentials stay byte-for-byte unchanged')
    const parsed = parse(stored)
    assert.equal(parsed.version, 1)
    assert.equal(parsed.refs.DEEPSEEK_API_KEY, key)
    if (kind === 'versioned') assert.equal(parsed.records['provider/fixture'].key, key)
    const url = handle.url
    await handle.stop()
    handle = undefined
    await assert.rejects(fetch(url, { signal: AbortSignal.timeout(2000) }))
    console.log(`PASS ${kind}: HTTP 200, credentials preserved, process stopped, port closed`)
  } finally {
    if (handle) await handle.stop()
    // Remove only this run's temporary fixture; never touch the user's DSH home.
    rmSync(home, { recursive: true, force: true })
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
}
