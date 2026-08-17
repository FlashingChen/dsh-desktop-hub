// 构建辅助：preload 必须以 CJS 编译（sandbox 要求），产物重命名为 .cjs
import { execFileSync } from 'node:child_process'
import { renameSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'dist', 'preload')
rmSync(out, { recursive: true, force: true })
// Windows 下 npx 是 npx.cmd shim，直接 execFileSync('npx') 会 ENOENT；须用 .cmd 名且经 shell 执行
const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx'
execFileSync(npxCmd, ['tsc', '-p', 'tsconfig.preload.json'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })
renameSync(join(out, 'preload.js'), join(out, 'preload.cjs'))
console.log('preload -> dist/preload/preload.cjs (CJS)')
