import test from 'node:test'
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const mod = await import(pathToFileURL(join(root, 'dist', 'core', 'credentials-migration.js')).href)

test('flat 检测与迁移', () => {
  const flat = "DEEPSEEK_API_KEY: sk-123\nOPENAI_API_KEY: sk-abc\n"
  assert.equal(mod.detectCredentialsFormat(flat), 'flat')
  assert.ok(mod.canMigrateFlat(flat))
  const migrated = mod.migrateFlat(flat)
  assert.ok(migrated.startsWith('version: 1\nrefs:\n  DEEPSEEK'))
  assert.equal(mod.detectCredentialsFormat(migrated), 'versioned')
})

test('versioned 检测', () => {
  const v = "version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-123\n"
  assert.equal(mod.detectCredentialsFormat(v), 'versioned')
  assert.equal(mod.canMigrateFlat(v), false)
  assert.equal(mod.migrateFlat(v), undefined)
})

test('version 字符串陷阱', () => {
  const bad = "version: \"1\"\nrefs:\n  DEEPSEEK_API_KEY: sk-123\n"
  assert.equal(mod.detectCredentialsFormat(bad), 'unknown')
  const fixed = mod.fixVersionStringIssue(bad)
  assert.ok(fixed.includes('version: 1'))
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
    // use explicit path
    const res = mod.backupAndMigrate(file)
    assert.equal(res.ok, true)
    assert.equal(res.migrated, true)
    assert.ok(res.backupPath && existsSync(res.backupPath))
    const after = readFileSync(file, 'utf8')
    assert.match(after, /version: 1/)
    assert.match(after, /refs:/)
    // idempotent second time
    const res2 = mod.backupAndMigrate(file)
    assert.equal(res2.migrated, false)
  } finally {
    if (origHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = origHome
    rmSync(home, { recursive: true, force: true })
  }
})
