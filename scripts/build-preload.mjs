// 构建辅助：preload 必须以 CJS 编译（sandbox 要求），产物重命名为 .cjs
import { execFileSync } from 'node:child_process'
import { renameSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'dist', 'preload')
rmSync(out, { recursive: true, force: true })
execFileSync('npx', ['tsc', '-p', 'tsconfig.preload.json'], { cwd: root, stdio: 'inherit' })
renameSync(join(out, 'preload.js'), join(out, 'preload.cjs'))
console.log('preload -> dist/preload/preload.cjs (CJS)')
