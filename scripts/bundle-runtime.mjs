// 打包运行时捆绑：下载 Node（校验官方 SHASUM）+ npm 安装 @deepseek-ai/dsh 与 pnpm（锁定版本）到 resources/
// 目标：打包应用不依赖系统 Node/dsh/pnpm（PRD 核心承诺：双击即用）
// 可复现性（P2-13）：Node tarball 校验官方 SHA-256；dsh/pnpm 精确版本；
// resources/dsh-runtime/package.json + package-lock.json 提交进仓库，安装走 npm ci。
// 注意：本文件必须保持纯 JS（node 直接执行，不得含 TS 类型标注）。
import { execFileSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync, realpathSync } from 'node:fs'
import { join, dirname, basename, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import AdmZip from 'adm-zip'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const NODE_VER = 'v24.10.0'
const DSH_VERSION = '0.1.0-rc.6'
const PNPM_VERSION = '11.22.0'
// 交叉捆绑：RUNTIME_TARGET=win32 时在非 Windows 机器上为 win32/x64 组装运行时
// （下载 win-x64.zip + npm --os/--cpu 按目标平台解析 optionalDependencies）。
// 注意：mac 上无法执行 node.exe，产物仅用于打包供 Windows 实机验证；
// 官方路径仍是 Windows 机器上跑本机 bundle-runtime（不设 RUNTIME_TARGET）。
const TARGET = process.env.RUNTIME_TARGET
if (TARGET && TARGET !== 'win32') throw new Error(`RUNTIME_TARGET 仅支持 win32（当前: ${TARGET}）`)
const ARCH = TARGET ? 'x64' : process.arch === 'arm64' ? 'arm64' : 'x64'
const IS_WIN = (TARGET ?? process.platform) === 'win32'
// Windows 官方分发为 zip（含顶层目录 node-v24.10.0-win-x64/）；darwin/linux 为 tar.gz（bin/node，需 strip）
const PLAT = (TARGET ?? process.platform) === 'darwin' ? 'darwin' : IS_WIN ? 'win' : 'linux'
const TARBALL = `node-${NODE_VER}-${PLAT}-${ARCH}.${IS_WIN ? 'zip' : 'tar.gz'}`
const URL = `https://nodejs.org/dist/${NODE_VER}/${TARBALL}`
const SHASUMS_URL = `https://nodejs.org/dist/${NODE_VER}/SHASUMS256.txt`

const runtimeDir = join(root, 'resources', 'rt')
const nodeDir = join(root, 'resources', 'nd')
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
// 清空旧的解压产物但保留 zip 缓存（tarPath 在 nodeDir 内，避免重复下载）
for (const f of readdirSync(nodeDir)) {
  if (f === basename(tarPath)) continue
  rmSync(join(nodeDir, f), { recursive: true, force: true })
}
if (IS_WIN) {
  // Windows zip 含顶层目录 node-v24.10.0-win-<arch>/（与 tar.gz 同构），逐条目剥掉前缀展开；
  // 用 adm-zip（应用自带依赖）避免依赖系统 tar/Expand-Archive
  const zip = new AdmZip(tarPath)
  const entries = zip.getEntries()
  const top = entries[0]?.entryName.replace(/\\/g, '/').split('/')[0] ?? ''
  for (const e of entries) {
    if (e.isDirectory) continue
    const rel = e.entryName.replace(/\\/g, '/').slice(top ? top.length + 1 : 0)
    if (!rel) continue
    const dest = join(nodeDir, rel)
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, e.getData())
  }
} else {
  execFileSync('tar', ['-xzf', tarPath, '-C', nodeDir, '--strip-components=1'], { stdio: 'inherit' })
}

const nodeBin = IS_WIN ? join(nodeDir, 'node.exe') : join(nodeDir, 'bin', 'node')
if (!existsSync(nodeBin)) throw new Error('Node 解压失败')

// 2) 可复现安装：提交的 package.json + lockfile 精确锁定 dsh 与 pnpm，npm ci 安装
writeFileSync(
  join(runtimeDir, 'package.json'),
  JSON.stringify({ name: 'dsh-desktop-hub-runtime', private: true, dependencies: { '@deepseek-ai/dsh': DSH_VERSION, pnpm: PNPM_VERSION } }, null, 2) + '\n',
)
console.log(`[bundle] npm ci @deepseek-ai/dsh@${DSH_VERSION} + pnpm@${PNPM_VERSION}（锁定版本，--ignore-scripts）…`)
// Windows zip 布局：npm 在 node_modules/npm（无 lib/ 层）
const npmCli = IS_WIN
  ? join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
  : join(nodeDir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
// 交叉捆绑时按目标平台解析 optionalDependencies（如 sharp → @img/sharp-win32-x64）；
// npm-cli.js 是平台无关 JS：交叉时用本机 node 执行（node.exe 无法在 mac 上运行），本机模式照旧
const npmRunner = TARGET ? process.execPath : nodeBin
const targetFlags = TARGET ? ['--os=' + (TARGET === 'win32' ? 'win32' : TARGET), '--cpu=' + ARCH] : []
if (existsSync(join(runtimeDir, 'package-lock.json'))) {
  execFileSync(npmRunner, [npmCli, 'ci', '--prefix', runtimeDir, '--no-audit', '--no-fund', '--ignore-scripts', ...targetFlags], { stdio: 'inherit' })
} else {
  // 首次：生成 lockfile（提交进仓库后，CI 走 npm ci）
  execFileSync(
    npmRunner,
    [npmCli, 'install', '--prefix', runtimeDir, '--no-audit', '--no-fund', '--ignore-scripts', ...targetFlags, `@deepseek-ai/dsh@${DSH_VERSION}`, `pnpm@${PNPM_VERSION}`],
    { stdio: 'inherit' },
  )
}

// Windows 下 npm 的 .bin 是 .cmd shim（另有 dsh/dsh.ps1）；交叉捆绑时先有 POSIX shim，.cmd 由下方补齐
const dshBin = join(runtimeDir, 'node_modules', '.bin', 'dsh')
const pnpmBin = join(runtimeDir, 'node_modules', '.bin', 'pnpm')
const dshBinWin = join(runtimeDir, 'node_modules', '.bin', 'dsh.cmd')
const pnpmBinWin = join(runtimeDir, 'node_modules', '.bin', 'pnpm.cmd')
if (!existsSync(dshBin) && !existsSync(dshBinWin)) throw new Error('dsh 安装失败')
if (!existsSync(pnpmBin) && !existsSync(pnpmBinWin)) throw new Error('pnpm 安装失败')
console.log(`[bundle] OK: ${existsSync(dshBinWin) ? dshBinWin : dshBin} + ${existsSync(pnpmBinWin) ? pnpmBinWin : pnpmBin}`)

// 交叉捆绑专用：npm 在非 Windows 上生成的 .bin 是 POSIX shim（symlink，无 .cmd），
// Windows 的 cmd /c pnpm 按 PATHEXT 只找 .cmd/.exe → dsh plugin 内部 spawn pnpm 会 127。
// 为 .bin 下每个无扩展名条目生成同名 .cmd（node "%~dp0<rel目标>" %*）。
if (TARGET) {
  const binDir = join(runtimeDir, 'node_modules', '.bin')
  let added = 0
  for (const name of readdirSync(binDir)) {
    if (name.includes('.')) continue
    const shimPath = join(binDir, name)
    let target
    try {
      target = realpathSync(shimPath)
    } catch {
      continue
    }
    const rel = relative(binDir, target).replace(/\//g, '\\')
    const cmd = `@ECHO off\r\nSETLOCAL\r\nnode \"%~dp0${rel}\" %*\r\n`
    writeFileSync(join(binDir, `${name}.cmd`), cmd)
    added += 1
  }
  console.log(`[bundle] 交叉捆绑：为 ${added} 个 .bin 条目生成 Windows .cmd shim`)
}

// 3) 运行时 manifest：受控构建输入（版本 + Node tarball 完整性）
const manifest = {
  nodeVersion: NODE_VER,
  nodeTarball: TARBALL,
  nodeSha256: createHash('sha256').update(readFileSync(tarPath)).digest('hex'),
  dshVersion: DSH_VERSION,
  pnpmVersion: PNPM_VERSION,
  platform: TARGET ?? process.platform, // darwin | win32 | linux
  arch: ARCH,
  generatedAt: new Date().toISOString(),
}
writeFileSync(join(root, 'resources', 'runtime-manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(`[bundle] manifest: resources/runtime-manifest.json`)

// 4) 交叉目标瘦身 + 通用裁剪（调用在文件末尾所有声明之后，见 end）
const TRIM = TARGET || process.env.TRIM_RUNTIME === '1'

/** 递归 walk：目录先判删，文件交给 fn（跳过 node_modules 目录本身） */
function walkRuntime(dir, skipDirs, fn) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name !== 'node_modules' && skipDirs.has(e.name)) {
        rmSync(p, { recursive: true, force: true })
        continue
      }
      walkRuntime(p, skipDirs, fn)
    } else fn(p, e.name)
  }
}

const SKIP_DIRS = new Set(['test', 'tests', '__tests__', 'benchmark', 'bench', 'examples'])

function trimRuntime(nodeDir, runtimeDir, winOnly) {
  const rm = (p) => rmSync(p, { recursive: true, force: true })
  // 1) 文档/类型/测试/点文件（平台无关；LICENSE/NOTICE/AUTHORS/COPYING 保留——合规）
  const dropFile = (p, name) => {
    if (name === '.map' || name.endsWith('.map')) return rm(p)
    if (name.endsWith('.d.ts') || name.endsWith('.md')) return rm(p)
    if (/^(README|CHANGELOG|SECURITY|CONTRIBUTING)/i.test(name)) return rm(p)
    if (/^\.(npmignore|gitignore|gitattributes|editorconfig|eslintrc|prettierrc|yarn-integrity|DS_Store)/.test(name)) return rm(p)
  }
  walkRuntime(nodeDir, SKIP_DIRS, dropFile)
  walkRuntime(runtimeDir, SKIP_DIRS, dropFile)
  // 2) 嵌套 @opentelemetry 副本（顶层保留；嵌套的 2.9.0 满足顶层 ^2.9.0 解析，Node 向上回退）
  //    （同时递归进入顶层 @opentelemetry——前版 bug：顶层名被跳过导致嵌套未删）
  const nm = join(runtimeDir, 'node_modules')
  const dropNestedOtel = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      const p = join(dir, e.name)
      if (e.name === 'node_modules') {
        const otel = join(p, '@opentelemetry')
        if (existsSync(otel) && p !== nm) rm(otel)
        dropNestedOtel(p)
      } else {
        dropNestedOtel(p)
      }
    }
  }
  dropNestedOtel(nm)
  // 3) @opentelemetry/*/build/esnext 全删：'esnext' 不是 Node exports 条件（Node 解析走 default→build/src），
  //    仅打包器使用，运行时永不加载。
  const otelRoot = join(nm, '@opentelemetry')
  if (existsSync(otelRoot)) {
    for (const name of readdirSync(otelRoot)) {
      rm(join(otelRoot, name, 'build', 'esnext'))
    }
    // mistralai src 是 TS 源码（main 指向 esm/index.js），运行时不需要
    rm(join(runtimeDir, 'node_modules', '@mistralai', 'mistralai', 'src'))
  }
  // 4) win32 专属（交叉捆绑时才执行，darwin 验证需保留本机 prebuilds）
  if (winOnly) {
    rm(join(nodeDir, TARBALL))
    for (const f of ['corepack', 'corepack.cmd', 'corepack.ps1', 'install_tools.bat', 'CHANGELOG.md']) {
      rm(join(nodeDir, f))
    }
    const pty = join(runtimeDir, 'node_modules', 'node-pty')
    const prebuilds = join(pty, 'prebuilds')
    if (existsSync(prebuilds)) {
      for (const d of readdirSync(prebuilds)) {
        if (d !== 'win32-x64') rm(join(prebuilds, d))
      }
    }
    const conpty = join(pty, 'third_party', 'conpty')
    if (existsSync(conpty)) {
      for (const verDir of readdirSync(conpty)) {
        const ver = join(conpty, verDir)
        if (!existsSync(ver)) continue
        for (const sub of readdirSync(ver)) {
          const s = sub.toLowerCase()
          if (s.includes('arm64') || s.includes('x86')) rm(join(ver, sub))
        }
      }
    }
    for (const rel of ['dist/vendor/fastlist-0.3.0-x86.exe', 'artifacts/exe/dist/vendor/fastlist-0.3.0-x86.exe']) {
      rm(join(runtimeDir, 'node_modules', 'pnpm', rel))
    }
    rm(join(runtimeDir, 'node_modules', '@img', 'sharp-wasm32'))
  }
  // 5) 统计
  const count = (d) => {
    let n = 0
    walkRuntime(d, new Set(), () => { n++ })
    return n
  }
  console.log(`[bundle] 裁剪完成：node ${count(nodeDir)} 文件 / dsh-runtime ${count(runtimeDir)} 文件${winOnly ? '（含 win32 专属裁剪）' : ''}`)
}

if (TRIM) {
  trimRuntime(nodeDir, runtimeDir, !!TARGET)
}
