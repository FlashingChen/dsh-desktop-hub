// 打包运行时捆绑：下载 Node（校验官方 SHASUM）+ npm 安装 @deepseek-ai/dsh 与 pnpm（锁定版本）到 resources/
// 目标：打包应用不依赖系统 Node/dsh/pnpm（PRD 核心承诺：双击即用）
// 可复现性（P2-13）：Node tarball 校验官方 SHA-256；dsh/pnpm 精确版本；
// resources/dsh-runtime/package.json + package-lock.json 提交进仓库，安装走 npm ci。
import { execFileSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const NODE_VER = 'v24.10.0'
const DSH_VERSION = '0.1.0-rc.6'
const PNPM_VERSION = '11.22.0'
const ARCH = process.arch === 'arm64' ? 'arm64' : 'x64'
const PLAT = process.platform === 'darwin' ? 'darwin' : 'linux' // Windows 打包后续扩展
const TARBALL = `node-${NODE_VER}-${PLAT}-${ARCH}.tar.gz`
const URL = `https://nodejs.org/dist/${NODE_VER}/${TARBALL}`
const SHASUMS_URL = `https://nodejs.org/dist/${NODE_VER}/SHASUMS256.txt`

const runtimeDir = join(root, 'resources', 'dsh-runtime')
const nodeDir = join(root, 'resources', 'node')
mkdirSync(runtimeDir, { recursive: true })
mkdirSync(nodeDir, { recursive: true })

// 1) 下载并校验 Node 官方 SHA-256（P2-13：供应链校验；已存在的 tarball 也强制复核）
const tarPath = join(nodeDir, TARBALL)
async function verifyNodeSha256(file) {
  const sums = await fetch(SHASUMS_URL)
  if (!sums.ok) throw new Error(`SHASUMS 下载失败: ${sums.status}`)
  const sumsText = await sums.text()
  const expected = sumsText
    .split('\n')
    .find((line) => line.trim().endsWith(`  ${TARBALL}`) || line.trim().endsWith(` *${TARBALL}`))
    ?.split(/\s+/)[0]
  if (!expected) throw new Error(`SHASUMS256.txt 中找不到 ${TARBALL}`)
  const actual = createHash('sha256').update(readFileSync(file)).digest('hex')
  if (actual !== expected.toLowerCase()) {
    throw new Error(`Node tarball SHA-256 校验失败：期望 ${expected}，实际 ${actual}`)
  }
  console.log('[bundle] Node SHA-256 校验通过')
}
if (!existsSync(tarPath)) {
  console.log(`[bundle] 下载 Node ${NODE_VER} (${PLAT}-${ARCH})…`)
  const res = await fetch(URL)
  if (!res.ok || !res.body) throw new Error(`下载失败: ${res.status}`)
  const tmpTar = `${tarPath}.part`
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmpTar))
  await verifyNodeSha256(tmpTar)
  rmSync(tarPath, { force: true })
  const { renameSync } = await import('node:fs')
  renameSync(tmpTar, tarPath)
} else {
  console.log('[bundle] Node tarball 已存在，复核官方 SHASUM…')
  await verifyNodeSha256(tarPath)
}

console.log('[bundle] 解压 Node…')
execFileSync('tar', ['-xzf', tarPath, '-C', nodeDir, '--strip-components=1'], { stdio: 'inherit' })

const nodeBin = join(nodeDir, 'bin', 'node')
if (!existsSync(nodeBin)) throw new Error('Node 解压失败')

// 2) 可复现安装：提交的 package.json + lockfile 精确锁定 dsh 与 pnpm，npm ci 安装
writeFileSync(
  join(runtimeDir, 'package.json'),
  JSON.stringify({ name: 'dsh-desktop-hub-runtime', private: true, dependencies: { '@deepseek-ai/dsh': DSH_VERSION, pnpm: PNPM_VERSION } }, null, 2) + '\n',
)
console.log(`[bundle] npm ci @deepseek-ai/dsh@${DSH_VERSION} + pnpm@${PNPM_VERSION}（锁定版本，--ignore-scripts）…`)
const npmCli = join(nodeDir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
if (existsSync(join(runtimeDir, 'package-lock.json'))) {
  execFileSync(nodeBin, [npmCli, 'ci', '--prefix', runtimeDir, '--no-audit', '--no-fund', '--ignore-scripts'], { stdio: 'inherit' })
} else {
  // 首次：生成 lockfile（提交进仓库后，CI 走 npm ci）
  execFileSync(
    nodeBin,
    [npmCli, 'install', '--prefix', runtimeDir, '--no-audit', '--no-fund', '--ignore-scripts', `@deepseek-ai/dsh@${DSH_VERSION}`, `pnpm@${PNPM_VERSION}`],
    { stdio: 'inherit' },
  )
}

const dshBin = join(runtimeDir, 'node_modules', '.bin', 'dsh')
const pnpmBin = join(runtimeDir, 'node_modules', '.bin', 'pnpm')
if (!existsSync(dshBin)) throw new Error('dsh 安装失败')
if (!existsSync(pnpmBin)) throw new Error('pnpm 安装失败')
console.log(`[bundle] OK: ${dshBin} + ${pnpmBin}`)

// 3) 运行时 manifest：受控构建输入（版本 + Node tarball 完整性）
const manifest = {
  nodeVersion: NODE_VER,
  nodeTarball: TARBALL,
  nodeSha256: createHash('sha256').update(readFileSync(tarPath)).digest('hex'),
  dshVersion: DSH_VERSION,
  pnpmVersion: PNPM_VERSION,
  platform: PLAT,
  arch: ARCH,
  generatedAt: new Date().toISOString(),
}
writeFileSync(join(root, 'resources', 'runtime-manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(`[bundle] manifest: resources/runtime-manifest.json`)
