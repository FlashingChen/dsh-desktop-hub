// 打包运行时捆绑：下载 Node + npm 安装 @deepseek-ai/dsh 到 resources/
// 目标：打包应用不依赖系统 Node/dsh（PRD 核心承诺：双击即用）
import { execFileSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const NODE_VER = 'v24.10.0'
const ARCH = process.arch === 'arm64' ? 'arm64' : 'x64'
const PLAT = process.platform === 'darwin' ? 'darwin' : 'linux' // Windows 打包后续扩展
const TARBALL = `node-${NODE_VER}-${PLAT}-${ARCH}.tar.gz`
const URL = `https://nodejs.org/dist/${NODE_VER}/${TARBALL}`

const runtimeDir = join(root, 'resources', 'dsh-runtime')
const nodeDir = join(root, 'resources', 'node')
mkdirSync(runtimeDir, { recursive: true })
mkdirSync(nodeDir, { recursive: true })

console.log(`[bundle] 下载 Node ${NODE_VER} (${PLAT}-${ARCH})…`)
const tarPath = join(nodeDir, TARBALL)
if (!existsSync(tarPath)) {
  const res = await fetch(URL)
  if (!res.ok || !res.body) throw new Error(`下载失败: ${res.status}`)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tarPath))
}
console.log('[bundle] 解压 Node…')
execFileSync('tar', ['-xzf', tarPath, '-C', nodeDir, '--strip-components=1'], { stdio: 'inherit' })

const nodeBin = join(nodeDir, 'bin', 'node')
if (!existsSync(nodeBin)) throw new Error('Node 解压失败')

console.log('[bundle] npm install @deepseek-ai/dsh（锁定版本）…')
// 使用捆绑的 node 运行捆绑的 npm，安装到 runtimeDir；--ignore-scripts 避免未知副作用，.bin/dsh 入口可用
const npmCli = join(nodeDir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
execFileSync(nodeBin, [npmCli, 'install', '--prefix', runtimeDir, '--no-audit', '--no-fund', '--ignore-scripts', '@deepseek-ai/dsh@0.1.0-rc.6'], {
  stdio: 'inherit',
})

const dshBin = join(runtimeDir, 'node_modules', '.bin', 'dsh')
if (!existsSync(dshBin)) throw new Error('dsh 安装失败')
console.log(`[bundle] OK: ${dshBin}`)
