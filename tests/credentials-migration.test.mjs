import test from 'node:test'
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const mod = await import(pathToFileURL(join(root, 'dist', 'core', 'credentials-migration.js')).href)

test('flat 检测与迁移', () => {
  const flat = "DEEPSEEK_API_KEY: sk-123\nOPENAI_API_KEY: sk-abc\n"
  assert.equal(mod.detectCredentialsFormat(flat), 'flat')
  assert.ok(mod.canMigrateFlat(flat))
  const migrated = mod.migrateFlat(flat)
  assert.ok(migrated.startsWith('version: "1"\nrefs:\n  DEEPSEEK'))
  assert.equal(mod.detectCredentialsFormat(migrated), 'versioned')
})

test('versioned 检测', () => {
  const v = "version: \"1\"\nrefs:\n  DEEPSEEK_API_KEY: sk-123\n"
  assert.equal(mod.detectCredentialsFormat(v), 'versioned')
  assert.equal(mod.canMigrateFlat(v), false)
  assert.equal(mod.migrateFlat(v), undefined)
})

test('version 字符串陷阱', () => {
  const bad = "version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-123\n"
  assert.equal(mod.detectCredentialsFormat(bad), 'unknown')
  const fixed = mod.fixVersionStringIssue(bad)
  assert.ok(fixed.includes('version: "1"'))
  assert.equal(mod.detectCredentialsFormat(fixed), 'versioned')
})

test('空与缺失', () => {
  assert.equal(mod.detectCredentialsFormat(''), 'empty')
  assert.equal(mod.detectCredentialsFormat(undefined), 'missing')
  assert.equal(mod.detectCredentialsFormat('   \n'), 'empty')
})

test('未知格式不迁移', () => {
  const bad = "%YAML 1.1\n---\nA_KEY: val\n"
  assert.equal(mod.detectCredentialsFormat(bad), 'unknown')
  assert.equal(mod.migrateFlat(bad), undefined)
})

test('备份迁移端到端（flat文件）', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-creds-'))
  const dir = join(home, '.dsh')
  const file = join(dir, '.credentials.yaml')
  const origHome = process.env.DSH_HOME
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, "A_KEY: val1\nB_KEY: val2\n")
    process.env.DSH_HOME = dir.replace('/.dsh','')
    process.env.DSH_TEST_ALLOW_MIGRATE = '1'
    // use explicit path
    const res = mod.backupAndMigrate(file)
    assert.equal(res.ok, true)
    assert.equal(res.migrated, true)
    assert.ok(res.backupPath && existsSync(res.backupPath))
    const after = readFileSync(file, 'utf8')
    assert.match(after, /version: "1"/)
    assert.match(after, /refs:/)
    // idempotent second time
    const res2 = mod.backupAndMigrate(file)
    assert.equal(res2.migrated, false)
    delete process.env.DSH_TEST_ALLOW_MIGRATE
  } finally {
    if (origHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = origHome
    rmSync(home, { recursive: true, force: true })
  }
})

// issue #47 同类问题：Windows 上不能被 shell:false 直接 spawn 的 .cmd shim
test('Windows 下系统 dsh 探测只取 PATH 上真实存在的 .cmd/.exe，不含裸名', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-probe-'))
  try {
    assert.deepEqual(mod.dshProbeCandidates('win32', 'C:\\bin', () => false), [])
    writeFileSync(join(dir, 'dsh.cmd'), '@ECHO off\r\n')
    writeFileSync(join(dir, 'dsh.exe'), '// fixture')
    const candidates = mod.dshProbeCandidates('win32', `C:\\bin;${dir}`, existsSync)
    assert.deepEqual(candidates, [join(dir, 'dsh.cmd'), join(dir, 'dsh.exe')])
    assert.equal(candidates.includes('dsh'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('POSIX 探测候选保持原样（裸名交给 PATH 解析）', () => {
  const expected = ['dsh', '/opt/homebrew/bin/dsh', '/usr/local/bin/dsh']
  assert.deepEqual(mod.dshProbeCandidates('darwin', '/usr/bin:/bin'), expected)
  assert.deepEqual(mod.dshProbeCandidates('linux', ''), expected)
})

test('POSIX：systemDshVersion 走规划后的可执行文件', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-probe-posix-'))
  try {
    const script = join(dir, 'dsh')
    writeFileSync(script, '#!/bin/sh\necho 0.9.9\n')
    chmodSync(script, 0o755)
    assert.equal(mod.systemDshVersion(script), '0.9.9')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Windows：dsh.cmd shim 解析成 node + JS 入口后再探测版本', { skip: process.platform !== 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-probe-win-'))
  try {
    writeFileSync(join(dir, 'dsh-probe.js'), "console.log('0.9.9')\n")
    writeFileSync(join(dir, 'dsh.cmd'), '@ECHO off\r\n"%_prog%" "%dp0%\\dsh-probe.js" %*\r\n')
    assert.equal(mod.systemDshVersion(join(dir, 'dsh.cmd')), '0.9.9')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
