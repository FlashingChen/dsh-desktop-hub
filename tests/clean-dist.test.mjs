import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { cleanDist } from '../scripts/clean-dist.mjs'

test('cleanDist 只删除给定项目根下的 dist', () => {
  const parent = mkdtempSync(join(tmpdir(), 'dsh-clean-dist-'))
  const root = join(parent, 'project')
  const dist = join(root, 'dist')
  const siblingDir = join(root, 'dist-backup')
  const outsideDist = join(parent, 'dist')

  try {
    mkdirSync(join(dist, 'renderer'), { recursive: true })
    mkdirSync(siblingDir, { recursive: true })
    mkdirSync(outsideDist, { recursive: true })
    writeFileSync(join(dist, 'stale.js'), 'stale')
    writeFileSync(join(dist, 'renderer', 'stale.html'), 'stale')
    writeFileSync(join(root, 'keep.txt'), 'keep')
    writeFileSync(join(siblingDir, 'keep.js'), 'keep')
    writeFileSync(join(outsideDist, 'keep.js'), 'keep')

    assert.equal(cleanDist(root), dist)
    assert.equal(existsSync(dist), false, 'dist 目录及其中所有旧产物都应删除')
    assert.equal(readFileSync(join(root, 'keep.txt'), 'utf8'), 'keep')
    assert.equal(readFileSync(join(siblingDir, 'keep.js'), 'utf8'), 'keep')
    assert.equal(readFileSync(join(outsideDist, 'keep.js'), 'utf8'), 'keep')

    assert.doesNotThrow(() => cleanDist(root), 'dist 不存在时也应幂等成功')
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('npm build 在所有产物生成步骤之前清理 dist', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const steps = pkg.scripts.build.split(' && ')

  assert.equal(steps[0], 'node scripts/clean-dist.mjs')
  assert.deepEqual(steps.slice(1), [
    'tsc -p tsconfig.json',
    'node scripts/build-preload.mjs',
    'tsc -p tsconfig.renderer.json',
    'node scripts/copy-renderer.mjs',
  ])
})
