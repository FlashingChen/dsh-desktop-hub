// M1 单元测试：harness 核心纯函数（依赖 npm run build 后的 dist）
import test from 'node:test'
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { findDsh, dshHome, listProfiles, parseHarnessUrl } = await import(
  join(root, 'dist', 'core', 'harness.js')
)

test('findDsh 在本机可解析到 dsh 可执行文件', () => {
  const dsh = findDsh()
  assert.ok(dsh && existsSync(dsh), `应有 dsh 路径，实际 ${dsh}`)
})

test('dshHome 默认 ~/.dsh，可被 DSH_HOME 覆盖', () => {
  assert.equal(dshHome(), join(process.env.HOME ?? '', '.dsh'))
})

test('listProfiles 能发现真实 web profile 且首个 bundle 为 dsh-base', () => {
  const profiles = listProfiles()
  const web = profiles.find((p) => p.name === 'web')
  assert.ok(web, `应有 web profile，实际 ${profiles.map((p) => p.name).join(',')}`)
  assert.equal(web.bundles[0], '@deepseek-ai/dsh-base')
  assert.ok(web.bundles.includes('@deepseek-ai/dsh-web-app'))
})

test('listProfiles 忽略缺 package.json 的目录', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-home-'))
  try {
    const fake = join(home, 'profiles', 'not-a-profile')
    mkdirSync(fake, { recursive: true })
    writeFileSync(join(fake, 'x.txt'), 'x')
    assert.deepEqual(listProfiles(home), [])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('parseHarnessUrl 解析 dsh web 输出', () => {
  assert.equal(parseHarnessUrl('dsh web: http://127.0.0.1:3080'), 'http://127.0.0.1:3080')
  assert.equal(parseHarnessUrl('[info] Listening on 127.0.0.1:45231'), 'http://127.0.0.1:45231')
  assert.equal(parseHarnessUrl('unrelated line'), null)
})
