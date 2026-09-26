// Windows NSIS 安装器契约：目录可选，但仍固定为 per-user 安装。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname, win32 } from 'node:path'
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

test('PowerShell process matching receives the selected install directory as data', () => {
  const commands = [...installerScript.matchAll(/nsExec::Exec `"\$PowerShellPath"[^`]+`/g)].map(
    (match) => match[0],
  )
  assert.equal(commands.length, 2, 'kill and find must each use the guarded PowerShell matcher')

  assert.match(
    installerScript,
    /SetEnvironmentVariable\(t, t\)i \("\$\{DSH_INSTALL_DIR_ENV\}", "\$INSTDIR"\)/,
    'the NSIS API must pass $INSTDIR as an environment value rather than command text',
  )
  assert.match(
    installerScript,
    /SetEnvironmentVariable\(t, p\)i \("\$\{DSH_INSTALL_DIR_ENV\}", 0\)/,
    'the temporary environment value must be cleared after each child exits',
  )

  for (const command of commands) {
    assert.doesNotMatch(command, /\$INSTDIR/, 'user-selected paths must never be interpolated into PowerShell')
    assert.match(command, /GetEnvironmentVariable\('\$\{DSH_INSTALL_DIR_ENV\}','Process'\)/)
    assert.match(command, /\[IO\.Path\]::GetFullPath\(\$\$root\)/)
    assert.match(command, /\[IO\.Path\]::GetPathRoot\(\$\$full\)/)
    assert.match(command, /\[string\]::Equals\(\$\$trimmed,\$\$trimmedRoot,\[StringComparison\]::OrdinalIgnoreCase\)/)
    assert.match(command, /\.ExecutablePath\.StartsWith\(\$\$prefix, \[StringComparison\]::OrdinalIgnoreCase\)/)
    assert.match(command, /\$\$prefix=\$\$trimmed\+\[IO\.Path\]::DirectorySeparatorChar/)
    assert.doesNotMatch(command, /CurrentCultureIgnoreCase/)
  }

  // Model NSIS variable expansion with inputs that used to break or alter the quoted
  // PowerShell literal. Only the System::Call data argument may change.
  for (const dangerousPath of [
    String.raw`C:\Users\O'Brien\DSH`,
    String.raw`C:\$env:TEMP\DSH`,
    String.raw`C:\DSH; Stop-Process -Id 1`,
  ]) {
    const expanded = installerScript.replaceAll('$INSTDIR', dangerousPath)
    const expandedCommands = [...expanded.matchAll(/nsExec::Exec `"\$PowerShellPath"[^`]+`/g)].map(
      (match) => match[0],
    )
    assert.deepEqual(expandedCommands, commands)
    assert.ok(expanded.includes(`"${dangerousPath}"`), 'the exact selected path must still reach the API data argument')
  }
})

function modelSafeInstallPrefix(input) {
  const driveFull = /^[A-Za-z]:[\\/]/.test(input)
  const unc = /^\\\\/.test(input)
  if (!driveFull && !unc) return null
  const full = win32.normalize(input)
  const pathRoot = win32.parse(full).root
  if (!pathRoot) return null
  const trimmed = full.replace(/[\\/]+$/, '')
  const trimmedRoot = pathRoot.replace(/[\\/]+$/, '')
  if (trimmed.toLowerCase() === trimmedRoot.toLowerCase()) return null
  return `${trimmed}\\`
}

test('PowerShell install prefix model rejects volume/share roots and preserves normal directories', () => {
  assert.equal(modelSafeInstallPrefix('C:\\'), null)
  assert.equal(modelSafeInstallPrefix(String.raw`C:/`), null)
  assert.equal(modelSafeInstallPrefix('\\\\server\\share\\'), null)
  assert.equal(modelSafeInstallPrefix('\\\\server\\share'), null)
  assert.equal(modelSafeInstallPrefix(String.raw`relative\path`), null)
  assert.equal(modelSafeInstallPrefix(String.raw`C:relative\path`), null)

  assert.equal(modelSafeInstallPrefix(String.raw`C:\Program Files\DSH`), 'C:\\Program Files\\DSH\\')
  assert.equal(modelSafeInstallPrefix('C:\\Program Files\\DSH\\'), 'C:\\Program Files\\DSH\\')
  assert.equal(modelSafeInstallPrefix('\\\\server\\share\\DSH\\'), '\\\\server\\share\\DSH\\')
  assert.equal(
    String.raw`C:\Program Files\DSH\helper.exe`.toLowerCase().startsWith(modelSafeInstallPrefix(String.raw`C:\Program Files\DSH`).toLowerCase()),
    true,
  )
  assert.equal(
    String.raw`C:\Program Files\DSH-evil\helper.exe`.toLowerCase().startsWith(modelSafeInstallPrefix(String.raw`C:\Program Files\DSH`).toLowerCase()),
    false,
  )
})
