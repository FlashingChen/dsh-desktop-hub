// 插件移除冒烟：只在临时 DSH_HOME/profile 中执行真实 dsh plugin remove，不触碰用户 profile。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { resolveDshExec } from '../dist/core/harness.js'

const exec = resolveDshExec()
if (!exec) {
  console.log('SMOKE SKIP: 未找到 dsh，跳过真实插件移除冒烟')
  process.exit(0)
}

const temp = mkdtempSync(join(tmpdir(), 'dsh-plugin-remove-smoke-'))
try {
  const profileDir = join(temp, 'profiles', 'remove-test')
  const packageFile = join(profileDir, 'package.json')
  const packageJson = {
    name: 'dsh-plugin-remove-smoke',
    private: true,
    dependencies: { 'dsh-worktree': 'github:FlashingChen/dsh-worktree' },
  }
  // dsh plugin 只要求 profile package.json；pnpm 会在临时目录中完成 remove，不需要复制真实 node_modules。
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(packageFile, JSON.stringify(packageJson, null, 2))
  const command = exec.node ?? exec.exec
  const args = exec.node
    ? [exec.exec, 'plugin', '--profile', 'remove-test', 'remove', 'dsh-worktree']
    : ['plugin', '--profile', 'remove-test', 'remove', 'dsh-worktree']
  const result = spawnSync(command, args, {
    cwd: temp,
    env: { ...process.env, DSH_HOME: temp },
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
  })
  if (result.status !== 0) {
    console.error(`SMOKE FAIL: dsh plugin remove exit=${result.status}\n${String(result.stderr || result.stdout).slice(-4000)}`)
    process.exit(1)
  }
  const after = JSON.parse(readFileSync(packageFile, 'utf8'))
  if (after.dependencies?.['dsh-worktree'] || after.devDependencies?.['dsh-worktree']) {
    console.error('SMOKE FAIL: remove 命令退出成功但 package.json 仍保留 dsh-worktree')
    process.exit(1)
  }
  console.log('SMOKE OK: 真实 dsh plugin remove 在临时 profile 中通过')
} finally {
  rmSync(temp, { recursive: true, force: true })
}
