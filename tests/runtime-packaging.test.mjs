import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
const builder = parse(read('electron-builder.yml'))

test('DSH runtime manifest, lock and bundler agree on the version with official account sign-in', () => {
  const manifest = JSON.parse(read('resources/rt/package.json'))
  const lock = JSON.parse(read('resources/rt/package-lock.json'))
  const version = manifest.dependencies['@deepseek-ai/dsh']
  assert.equal(version, '0.1.7-rc.2')
  assert.equal(lock.packages[''].dependencies['@deepseek-ai/dsh'], version)
  for (const name of ['dsh', 'dsh-credentials-local', 'dsh-base', 'dsh-web-app']) {
    assert.equal(lock.packages[`node_modules/@deepseek-ai/${name}`].version, version, name)
  }
  assert.ok(read('scripts/bundle-runtime.mjs').includes(`const DSH_VERSION = '${version}'`))
})

function matchesSingleDirectoryGlob(glob, file) {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escaped.replaceAll('*', '[^/]*')}$`).test(file)
}

test('Node 下载归档不进入发布包，解压运行时与 manifest 保持携带', () => {
  assert.ok(Array.isArray(builder.files), 'electron-builder files 必须是可审计的数组')
  const archiveExcludes = builder.files
    .filter((entry) => typeof entry === 'string' && entry.startsWith('!resources/nd/'))
    .map((entry) => entry.slice(1))

  assert.deepEqual(
    new Set(archiveExcludes),
    new Set(['resources/nd/*.zip', 'resources/nd/*.tar.gz']),
    '只排除 nd 根目录下的两种 Node 官方压缩缓存',
  )

  const isArchiveExcluded = (file) => archiveExcludes.some((glob) => matchesSingleDirectoryGlob(glob, file))
  assert.equal(isArchiveExcluded('resources/nd/node-v24.10.0-darwin-arm64.tar.gz'), true)
  assert.equal(isArchiveExcluded('resources/nd/node-v24.10.0-win-x64.zip'), true)

  for (const runtimeFile of [
    'resources/nd/bin/node',
    'resources/nd/node.exe',
    'resources/nd/lib/node_modules/npm/bin/npm-cli.js',
    'resources/runtime-manifest.json',
  ]) {
    assert.equal(isArchiveExcluded(runtimeFile), false, `${runtimeFile} 不得被归档缓存规则排除`)
  }
  assert.equal(builder.files.includes('resources/**/*'), true, '解压运行时仍须由 resources/**/* 纳入')
  assert.equal(builder.files.includes('!resources/node/*.zip'), false, '不得恢复已失效的旧目录排除规则')

  const ignored = new Set(read('.gitignore').split(/\r?\n/).filter(Boolean))
  assert.equal(ignored.has('resources/nd/*.zip'), true, 'Windows Node 下载缓存不得进入版本控制')
  assert.equal(ignored.has('resources/nd/*.tar.gz'), true, 'POSIX Node 下载缓存不得进入版本控制')
  assert.equal(ignored.has('resources/node/'), true, '旧版本地 runtime 残留目录仍须防止误提交')
})

test('mac 与 Windows runtime 仍使用真实平台归档后缀', () => {
  const bundleScript = read('scripts/bundle-runtime.mjs')
  assert.match(bundleScript, /const nodeDir = join\(root, 'resources', 'nd'\)/)
  assert.match(bundleScript, /IS_WIN \? 'zip' : 'tar\.gz'/)
  assert.match(bundleScript, /const TRIM = TARGET \|\| process\.env\.TRIM_RUNTIME === '1'/)

  const release = read('.github/workflows/release.yml')
  assert.match(release, /Bundle runtime \(Node \+ DSH, darwin\)[\s\S]*?run: node scripts\/bundle-runtime\.mjs/)
  assert.match(release, /Bundle runtime \(Node \+ DSH, win32\)[\s\S]*?run: node scripts\/bundle-runtime\.mjs/)
  assert.match(release, /electron-builder --win nsis --x64/)
})

test('runtime bundler 的 SHASUMS 与归档下载都接入超时和字节上限事务', () => {
  const bundleScript = read('scripts/bundle-runtime.mjs')
  assert.match(bundleScript, /import \{ downloadVerifiedArtifact, fetchBoundedText \} from '.\/bounded-download\.mjs'/)
  assert.match(bundleScript, /SHASUMS_MAX_BYTES = 256 \* 1024/)
  assert.match(bundleScript, /SHASUMS_TIMEOUT_MS = 30_000/)
  assert.match(bundleScript, /NODE_ARCHIVE_MAX_BYTES = \(IS_WIN \? 96 : 128\) \* 1024 \* 1024/)
  assert.match(bundleScript, /NODE_ARCHIVE_TIMEOUT_MS = 5 \* 60_000/)
  assert.match(bundleScript, /await fetchBoundedText\(SHASUMS_URL/)
  assert.match(bundleScript, /await downloadVerifiedArtifact\(\{[\s\S]*?verify: verifyNodeSha256/)
  assert.doesNotMatch(bundleScript, /rmSync\(tarPath/, '发布新归档前不得删除已验证 tarPath')
})
