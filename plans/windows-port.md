# Windows 版本可行性研究 + 移植计划

> 状态：已定稿，实施中（S1）
> 日期：2026-08-16 · 分支 FlashingChen/win

## 已确认决策（2026-08-16）

- 范围：直接进入移植实施，产出 Windows x64 NSIS 安装包
- 安装形态：A — NSIS 安装包（per-user 免管理员、可选安装目录）
- 目标架构：A — 仅 x64
- 代码签名：暂不做（未签名 exe，SmartScreen 警告预期内）
- 验证途径：Windows 实机（用户手边有机器）+ CI windows-latest 双通道

## Context

DSH Desktop Hub 目前为 macOS arm64 预览版（Electron 43 + 捆绑 Node v24.10.0 + `@deepseek-ai/dsh@0.1.0-rc.6`）。
PRD §3.4 明确 MVP 目标含 Windows（最大用户盘）；plan.md「下一步」列了 Windows 打包待做。
本计划回答：**能否提供 Windows 版本（可行性结论）→ 需要改什么（移植清单）→ 如何验证（CI 实机）**。

## 可行性结论（已实证，非猜测）

| 维度 | 证据 | 结论 |
|---|---|---|
| dsh 官方 Windows 支持 | `dsh` 包内 `plugin-9h8shc4d.js:111`：`spawnSync("pnpm", …, { shell: process.platform === "win32" })`；依赖含 `@deepseek-ai/dsh-pwsh-local/pwsh-sandbox/dsh-tool-pwsh`；sharp 含 `@img/sharp-win32-x64/arm64` 平台包；npm 元数据无 os/cpu 限制、无 install scripts、bin 为纯 JS `lib/bin.js` | ✅ 官方显式支持 Windows |
| dsh 用户目录 | `dsh-home-paths` 用 `os.homedir()` + `.dsh` → Windows 即 `C:\Users\<name>\.dsh` | ✅ 与壳层 `dshHome()`（homedir）一致 |
| 参考实现 | PRD §2.5 调研：`myYangyunfan/dsh_desktop` = Windows Electron + 内置 node.exe + dsh npm 包，生产运行 | ✅ 打包路线已验证 |
| Electron 43 | 官方支持 win32 x64/arm64 | ✅ |
| 捆绑 Node | Node v24.10.0 官方提供 `win-x64.zip` / `win-arm64.zip`（含 node.exe + npm.cmd），SHASUMS256.txt 覆盖 | ✅ |
| pnpm 通道 | dsh plugin 走 `spawnSync("pnpm", {shell:true})` → 壳层 `runtimePathEnv()` 把 `node_modules/.bin`（含 `pnpm.cmd`）加入 Path 即可 | ✅ 现有代码已备 |
| MCP stdio | dsh-mcp-client 用官方 `@modelcontextprotocol/sdk` StdioClientTransport（跨平台，Windows 下解析 .cmd） | ✅ |

**结论：可行，且是官方支持的一等平台，不是 hack。** 剩余工作 = 壳层 5 处平台适配 + 打包/CI + Windows 实机验证。

## 壳层 Windows 缺口（需修改的代码）

1. **`scripts/bundle-runtime.mjs`** — 第 19 行显式 throw win32。需加 win32 分支：
   - 下载 `node-v24.10.0-win-<arch>.zip`（x64/arm64），SHA-256 校验逻辑复用
   - 解压：Windows 用 PowerShell `Expand-Archive` 或 adm-zip（devDeps 已有），zip 根即 node.exe（无顶层目录，无需 strip）
   - 路径差异：node 可执行 = `node.exe`（zip 根）；npm CLI = `node_modules/npm/bin/npm-cli.js`（非 darwin 的 `lib/node_modules/...`）
   - `.bin` 产物校验：Windows 下是 `dsh.cmd`/`pnpm.cmd`（现有 `existsSync(dshBin)` 需按平台加 `.cmd`）
2. **`src/core/harness.ts`** —
   - `resolveDshExec()`：Windows 下捆绑 node 路径 = `resources/node/node.exe`（现写死 `node/bin/node`）
   - `stopTree()`：负 pid 进程组信号在 Windows 无效 → `taskkill /pid <pid> /T`（无 /F 先优雅），2s 兜底 `/T /F`；`spawn` 加 `windowsHide: true`
   - `findDsh()`：Windows PATH 探测 `dsh.cmd`/`dsh`（次要，捆绑 runtime 优先）
3. **HOME 环境变量 bug（Windows 必修）** —
   - `src/core/skills.ts` `scanSkills()`：`process.env.HOME ?? ''` → `os.homedir()`（Windows HOME 通常未设，现会解析到 `\.dsh` 盘符根）
   - `src/main/main.ts` `resolveSkillRoot()`：同样用 `process.env.HOME`
   - 路径分隔假设：`fallbackSkillName` 的 `split('/')`、`resolveScannedSkill` 的 `startsWith(rootReal + '/')` → 用 `path.sep`/`path.relative()`
4. **`electron-builder.yml`** — 加 `win:` 段：nsis target（arch 待定）、`icon: build/icon.png`（1024px 可自动转 .ico）、artifactName；`nsis:` 子项（per-user / allowToChangeInstallationDirectory）
5. **`.github/workflows/release.yml`** — 加 windows 构建 job（详见 Steps）
6. **小项**：`main.ts` Windows 菜单（无 app 菜单，补「文件→退出」可选）；`app.setAppUserModelId`（Windows 任务栏分组）；README「Windows 即将推出」徽章随发布更新

## 不动的部分

- `src/core/mcp.ts` / `plugins.ts` 纯逻辑 + 单测：平台无关（plugins.test.mjs 的 shebang fixture 只是字符串/文件存在性，不执行）
- `src/core/ipc.ts` / `preload.ts` / `renderer.ts`：跨平台
- `verify.mjs`：只跑 node/npm/tsc，平台无关
- `verify-m1.mjs`：调 `startHarness().stop()`，stopTree 改完后自然适配

## Files to modify

- `scripts/bundle-runtime.mjs`（win32 分支）
- `src/core/harness.ts`（node.exe 路径 / taskkill / findDsh）
- `src/core/skills.ts`（homedir + 分隔符）
- `src/main/main.ts`（resolveSkillRoot homedir + realpath 域校验 + 可选菜单/AppUserModelId）
- `tests/harness.test.mjs`（dshHome 断言随实现同步）
- `electron-builder.yml`（win/nsis 段）
- `.github/workflows/release.yml`（windows job）
- `README.md`（发布后更新平台声明）

## Steps（草案，待决策点确认后细化）

- [x] S0 决策确认（2026-08-16：NSIS x64 无签名，用户有 Windows 实机）
- [x] S1 代码适配：bundle-runtime win32 分支 + harness/skills/main 平台修正 + verify 平台化 + electron-builder yml + release.yml windows job
  - 实证发现：electron-builder CLI 平台参数会覆盖 yml 的 arch（默认用本机 arch）→ CI 显式 --x64/--arm64；
  - 实证发现：Windows 官方 Node zip 含顶层目录（node-v24.10.0-win-x64/）→ 剥前缀展开；
  - 实证发现：mac 交叉编译的 win 包 runtime 是 darwin 平台包（npm ci 平台相关）→ win 包必须在 Windows 上 bundle+build
- [x] S2 本地（mac）回归：typecheck ✓ 单测 54/54 ✓ verify ✓ bundle-runtime(darwin) ✓ mac dmg --arm64 ✓ win nsis --x64 交叉编译流程 ✓（产物仅验证配置，不可安装）
- [ ] S3 Windows 实机验证（用户机器 + CI windows-latest）：bundle-runtime(win) → `dsh web` 真实启动 → smoke → 无孤儿
- [ ] S4 electron-builder --win nsis 出包（Windows 实机/CI），安装试跑
- [ ] S5 文档：README 平台声明、已知限制、Windows 机器操作清单（本节下附）

## Windows 机器操作清单（S3，在 Windows 机器 PowerShell 中执行）

```powershell
# 1. 准备：安装 Node.js LTS 24（https://nodejs.org；跑脚本需要，打包产物不依赖）
node --version

# 2. 拉取分支代码
cd ~
git clone https://github.com/FlashingChen/dsh-desktop-hub.git
cd dsh-desktop-hub
git checkout FlashingChen/win

# 3. 依赖 + 平台无关验证（全绿才继续）
npm ci
npm run verify

# 4. 关键：win32 运行时捆绑（下载 win-x64.zip → SHA256 → adm-zip 解压 → node.exe 跑 npm ci 装 dsh）
node scripts/bundle-runtime.mjs
# 预期：末尾 [bundle] OK: ...dsh.cmd + ...pnpm.cmd；manifest platform=win32 arch=x64

# 5. 决议验证①：dsh web 在 Windows 真实启动 → HTTP 200 → taskkill 优雅停止 → 无孤儿
npm run verify:m1

# 6. 决议验证②：Electron 冒烟（iframe 内嵌 harness UI + 四 Tab + 截图 artifacts/m1-harness.png）
npm run smoke:harness

# 7. 出包
npx electron-builder --win nsis --x64 --publish never
# 预期：release\DSH-Desktop-Hub-0.1.0-x64.exe

# 8. 安装 exe 试跑：默认模式（四 Tab + Harness iframe 内嵌）、插件/MCP/Skills 各点一遍、退出后任务管理器无残留 node.exe
```

**请回报**：第 4/5/6 步输出；第 8 步 Harness 是否正常加载、有无报错面板；退出后是否无孤儿进程。

## Verification

- 平台无关：`npm run verify` 全绿（mac 本地回归）
- Windows 实机（CI windows-latest）：bundle-runtime 产出 node.exe + dsh 可启动；`dsh web` 起服务 HTTP 200；taskkill 退出无孤儿；smoke 断言四 Tab
- 打包：`electron-builder --win nsis` 出 exe，安装后可启动

## 风险

- `dsh web` 在 Windows 上的默认 web profile 含 bash 系插件（dsh-terminal-bash/dsh-tool-bash）：可能降级/警告但不应崩（官方有 pwsh 对等包）——S3 实机验证是最终裁决
- 未签名 exe → SmartScreen 警告（与 mac 未签名 DMG 对等，预览版接受）
- GitHub Actions windows-latest 跑 Electron GUI smoke 可行（交互式会话）
