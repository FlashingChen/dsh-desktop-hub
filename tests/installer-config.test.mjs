// Windows NSIS 安装器契约：目录可选，但仍固定为 per-user 安装。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const builderConfig = parse(readFileSync(join(root, 'electron-builder.yml'), 'utf8'))
const nsis = builderConfig.nsis
const installerScript = readFileSync(join(root, 'build', 'installer.nsh'), 'utf8')

test('Windows NSIS uses an assisted installer with a selectable directory', () => {
  assert.equal(nsis.oneClick, false, 'NSIS must use the assisted wizard')
  assert.equal(nsis.allowToChangeInstallationDirectory, true, 'directory selection must be enabled')
  assert.equal(nsis.perMachine, false, 'installation must remain per-user')
  assert.equal(nsis.include, 'installer.nsh', 'custom NSIS hooks must remain included')
  assert.ok(existsSync(join(root, 'build', nsis.include)), 'configured NSIS include must exist')
})

test('custom NSIS hooks preserve the old per-user installer contract', () => {
  assert.match(installerScript, /!undef APP_FILENAME\s+!define APP_FILENAME "dsh-desktop-hub"/)

  const mode = installerScript.match(/!macro customInstallMode[\s\S]*?!macroend/)
  assert.ok(mode, 'installer.nsh must define customInstallMode')
  assert.match(mode[0], /\$perMachineInstallationFolder == ""[\s\S]*StrCpy \$isForceCurrentInstall "1"/)
  assert.doesNotMatch(mode[0], /StrCpy \$isForceMachineInstall/)

  const init = installerScript.match(/!macro customInit[\s\S]*?!macroend/)
  assert.ok(init, 'installer.nsh must define customInit for silent installs')
  assert.match(init[0], /\$perMachineInstallationFolder == ""/)
  assert.match(init[0], /!insertmacro setInstallModePerUser/)
})
