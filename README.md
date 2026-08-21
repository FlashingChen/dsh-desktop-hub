<div align="center">

<img src="build/icon.png" width="112" alt="DSH Desktop Hub logo" />

# DSH Desktop Hub

**无需 Node.js，不碰 YAML，一站式使用和管理 DeepSeek Harness。**

DeepSeek Harness 官方 Web UI 桌面客户端 —— 内置插件市场、MCP 市场、Skills 市场与三套本地管理台。

> 注：本项目是社区维护的开源项目，非 DeepSeek 官方产品。

[![macOS 下载 DMG](https://img.shields.io/badge/macOS-%E4%B8%8B%E8%BD%BD%20DMG-4d6bfe?style=for-the-badge&logo=apple&logoColor=white)](https://github.com/FlashingChen/dsh-desktop-hub/releases/latest)
[![Windows 下载 EXE](https://img.shields.io/badge/Windows-%E4%B8%8B%E8%BD%BD%20EXE-4d6bfe?style=for-the-badge&logo=windows&logoColor=white)](https://github.com/FlashingChen/dsh-desktop-hub/releases/latest)
[![GitHub release](https://img.shields.io/github/v/release/FlashingChen/dsh-desktop-hub?color=4d6bfe)](https://github.com/FlashingChen/dsh-desktop-hub/releases)
[![License MIT](https://img.shields.io/github/license/FlashingChen/dsh-desktop-hub?color=4d6bfe)](LICENSE)
[![CI](https://github.com/FlashingChen/dsh-desktop-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/FlashingChen/dsh-desktop-hub/actions/workflows/ci.yml)
[![Release](https://github.com/FlashingChen/dsh-desktop-hub/actions/workflows/release.yml/badge.svg)](https://github.com/FlashingChen/dsh-desktop-hub/actions/workflows/release.yml)

</div>

<img src="assets/demo/harness.png" width="900" alt="DSH Desktop Hub 主界面：左侧五 Tab 工作区，主区域为 DeepSeek Harness 官方 Web UI" />

---

## 社区交流

欢迎加入 QQ 交流群，获取使用帮助、交流插件与功能想法。

| QQ 交流群 |
| :---: |
| <img src="assets/community/qq-group.png" width="280" alt="dsh-desktop-hub QQ 交流群二维码，群号 1106611027" /> |
| **群名：dsh-desktop-hub · 群号：1106611027** |

## 为什么不是普通 Desktop

不是套壳。官方 Web UI 原样保留在 Harness Tab 里，同时把三个命令行场景搬进同一个窗口：

- **开箱即用**：内置 Node.js + DeepSeek Harness 运行时（约 586MB），下载即用，本机不需要安装任何环境。
- **一体化**：在 Harness 对话、插件市场、MCP 市场、Skills 市场之间切换，不用再开终端敲 `dsh plugin` / 手写 YAML。
- **安全**：所有写操作原子落盘、自动备份 `.bak-<ts>`、官方 HMR 热生效，改错了随时可恢复。
- **及时更新**：Windows 发布版启动后自动检查 GitHub Releases，侧边栏提示新版本；用户确认后下载并重启安装，不必再手动打开 GitHub。macOS 完成正式签名后启用同一更新链路。

## 核心能力

### 三类扩展市场

插件、MCP 与 Skills 共用一个目录体验：搜索、查看来源、来源等级与权限，确认后分别安装到当前 profile 或用户级 skills。插件默认来自 [DSH Plugin Market](https://github.com/dsh-market/dsh-market) 发布的 [Awesome DSH Plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 清单，MCP 合并官方 Registry 与 [DSH MCP Market](https://github.com/LKMeng2001/dsh-mcp-market)，Skills 合并 [ClawHub](https://clawhub.ai) 与 [SkillsMP](https://skillsmp.com)。npm 只在插件安装预检时读取 manifest，不作为主市场搜索源；网络不可用时回退到本地缓存和随包精选目录。

> **市场数据来源声明**：各来源的运行时地址、用途、缓存策略、许可证边界和安全限制见 [`MARKET_SOURCES.md`](MARKET_SOURCES.md)。上游目录的收录不等于 DSH 安全背书。

### MCP 市场与配置转换 —— 粘贴即用

Claude Code / Cursor 导出的 MCP JSON，粘贴进去 → 自动转换成 DSH 插件行 YAML（`${VAR}` 自动转 `!!js process.env.VAR`，sse / 非法 serverName 会警告）→ 确认后写入 profile patch，官方 HMR 热生效。市场条目若声明环境变量，会在安装卡片中先填写密钥，DSH 将值写入当前 MCP 配置，用户不需要再手动设置系统环境变量。

![MCP 转换流程演示](assets/demo/mcp-flow.gif)

### Skills 市场与管理

扫描用户级 / 随包全部 skills（rank 规则，同名低 rank 生效、高 rank 标「被遮蔽」）；支持导入 `.skill` / `.zip` / GitHub 仓库链接，或直接新建用户级 skill，模型可见 / 用户可见一键切换。

<img src="assets/demo/skills.png" width="760" alt="Skills 管理台：4 个 skill，来源与可见性开关" />

### Plugin 市场与管理

按组合包 / 依赖分类展示 web profile 的插件清单；安装、移除、更新真实执行 `dsh plugin`；聚合仓库（缺 `dsh.bundle`）拒绝误装，避免把仓库根目录装成插件。

<img src="assets/demo/plugins.png" width="760" alt="Plugin 管理台：组合包与依赖清单" />

## 快速开始

1. **下载安装**：macOS 下载 DMG；Windows 下载 EXE（当前未签名，首次运行需放行一次：macOS 右键 → 打开；Windows SmartScreen → 更多信息 → 仍要运行）。
2. **配置模型**：在 Harness Tab 的官方 Web UI 里填入 API Key（首次引导会提示）。
3. **开始使用**：直接对话；需要外部工具时，到 MCP / Skills / Plugin Tab 管理。

> 当前为预览版（macOS arm64 / Windows x64，均未签名）。

## Roadmap

| 状态 | 项目 |
|---|---|
| ✅ | 基础版：五 Tab 壳（含反馈入口）+ MCP / Skills / Plugin 管理 + 内置运行时 |
| ✅ | 扩展中心 MVP：Plugin 市场、MCP 市场、Skills 市场（随包精选目录） |
| 🚧 | Profile 切换（当前固定 `web`） |
| Planned | Model Manager（API Key / 模型管理面板） |
| Planned | Doctor（环境自检与一键修复） |
| ✅ | Windows 安装包（NSIS，x64，与 macOS 并行发布） |
| Planned | Linux 安装包 |
| ✅ | 应用更新（GitHub Releases 检查、下载与重启安装） |

## 社区与反馈

应用内置第五个“反馈”Tab。匿名/署名反馈会提交到可访问的反馈服务，再由 bot 整理为 GitHub Issue，普通用户不需要访问 GitHub。诊断环境信息默认不附加，用户可以单独复制诊断信息或完整反馈；网络不可用时可复制内容发送到 QQ 群。

- [Issues](https://github.com/FlashingChen/dsh-desktop-hub/issues)：维护者与能访问 GitHub 的开发者直接查看问题
- [Discussions](https://github.com/FlashingChen/dsh-desktop-hub/discussions)：使用讨论与想法交流
- QQ 交流群：群号 `1106611027`，二维码见应用内反馈 Tab

本项目是活项目：CI 每个 tag 自动出包，Roadmap 上的能力持续在长。Star 一下跟踪进展。

---

# 开发者 / Architecture

## 架构

```
渲染进程（sandbox）             preload                   主进程                    核心逻辑                   捆绑运行时
┌──────────────────┐   ┌──────────────────┐   ┌────────────────────┐   ┌──────────────────┐   ┌─────────────────────────┐
│ 五 Tab 壳         │   │ window.dshDesktop│   │ IPC handlers       │   │ src/core/         │   │ resources/              │
│ index.html       │──▶│ contextBridge    │──▶│ harness:url         │──▶│ harness.ts        │──▶│ node/（Node v24.10.0）   │
│ renderer.ts      │   │ preload.cjs      │   │ plugins:list/       │   │ plugins.ts        │   │ dsh-runtime/            │
│ (harness iframe) │◀──│ (CJS, sandbox)   │◀──│   install/remove/    │   │ mcp.ts            │   │  @deepseek-ai/dsh       │
│                  │   │                  │   │   update             │   │ skills.ts         │   │  (0.1.0-rc.6)           │
│                  │   │                  │   │ mcp:list/convert/    │   └──────────────────┘   │        │                │
│                  │   │                  │   │   apply/update/     │            │ spawn(detached) ▼                │
│                  │   │                  │   │   delete             │            └──── dsh web --port 0 ─────┘                │
│                  │   │                  │   │ skills:list/create/  │                          │                                │
│                  │   │                  │   │   toggle             │                          │                                │
│                  │◀──│ harness:frame-   │   │ harness:frame-loaded │                    http://127.0.0.1:PORT                  │
└──────────────────┘   └──────────────────┘   └────────────────────┘                          └─────────────────────────────────┘
```

```mermaid
flowchart LR
    UI["渲染进程（sandbox）<br/>五 Tab 壳 index.html + renderer.ts"]
    PRE["preload.cjs<br/>contextBridge → window.dshDesktop"]
    MAIN["主进程 main.ts<br/>IPC handlers + harness 生命周期"]
    CORE["src/core 纯逻辑<br/>harness / plugins / mcp / skills"]
    RT["捆绑运行时 resources/<br/>Node v24.10.0 + @deepseek-ai/dsh@0.1.0-rc.6"]
    WEB["dsh web → http://127.0.0.1:PORT"]
    UI -->|IPC invoke| PRE --> MAIN
    MAIN --> CORE
    CORE -->|spawn detached 进程组| RT
    RT --> WEB
    WEB -->|iframe src| UI
```

生命周期：

```
启动 → registerIpc() → resolveDshExec()（打包内 runtime 优先，回退 PATH）
  → spawn dsh web --port 0（独立进程组）→ 解析 127.0.0.1:PORT → 轮询 HTTP 200（就绪超时 120s）
  → BrowserWindow（1280×800，sandbox + contextIsolation + preload.cjs）
  → 加载五 Tab 壳（file://dist/renderer/index.html）
  → renderer 经 IPC 取 harness URL → iframe 挂载官方 Web UI
退出 → will-quit → harness.stop()：SIGTERM 进程组 → 2s 兜底 SIGKILL → app.quit
```

- 默认（无 flag）＝产品行为：启动 harness + 五 Tab 壳；主菜单仅「退出 / 全屏」。
- 冒烟模式：`--smoke`（不启 harness，DOM + 真实数据断言）；`--harness-smoke`（真实 harness + iframe 加载断言）。

## 目录结构

```
dsh-desktop-hub/
├── src/
│   ├── main/main.ts            # Electron 主进程：窗口 + IPC + harness 进程生命周期
│   ├── preload/preload.ts      # contextBridge 白名单 API（sandbox，编译为 preload.cjs）
│   ├── renderer/               # 五 Tab 壳：index.html + renderer.ts（纯脚本，无模块）
│   └── core/                   # 纯逻辑（可单测）：harness.ts / plugins.ts / plugin-ops.ts / pnpm.ts / mcp.ts / skills.ts / feedback.ts / diagnostics.ts
├── tests/                      # node --test 单测（从 dist/ 导入，需先 build）
├── scripts/
│   ├── build-preload.mjs       # preload 以 CJS 编译并重命名为 .cjs
│   ├── copy-renderer.mjs       # 拷贝 index.html → dist/renderer
│   ├── bundle-runtime.mjs      # 下载 Node + npm 安装 dsh 到 resources/
│   ├── generate-icon.mjs       # 生成品牌图标 build/icon.png（1024×1024，深蓝鲸鱼 + hub 节点）
│   ├── capture-demo.mjs        # README 演示截图/GIF 捕获（合成演示 profile，不碰真实数据）
│   ├── verify.mjs              # 一键门禁：契约 + 构建 + typecheck×2 + 单测
│   └── verify-m1.mjs           # M1 实机验证：dsh web 启动 → HTTP 200 → 优雅停止
├── resources/                  # 捆绑运行时（node_modules 忽略）：nd/（Node 本体+shim）+ rt/（dsh runtime，锁文件入库）
├── assets/demo/                # README 截图与 GIF（脚本生成，可重跑）
├── build/icon.png              # 应用图标（electron-builder 引用，macOS 自动转 icns）
├── release/                    # electron-builder 产物（gitignore）：DMG arm64 + NSIS EXE x64
├── dist/                       # tsc 产物（gitignore）
├── tsconfig.json               # 主进程 + core + preload（NodeNext，outDir dist）
├── tsconfig.preload.json       # preload：CommonJS → dist/preload/preload.cjs
├── tsconfig.renderer.json      # renderer：纯脚本 → dist/renderer
├── electron-builder.yml        # appId com.dshdesktop.app；DMG arm64；asarUnpack resources
└── package.json
```

## 开发命令

| 命令 | 说明 |
|---|---|
| `npm install` | 安装依赖（electron / typescript / electron-builder / electron-updater / yaml） |
| `npm run build` | 三套 tsc（main+core → preload CJS → renderer）+ 拷贝 index.html，产物 `dist/` |
| `npm run typecheck` | `tsc --noEmit`（main + core + preload；renderer 类型检查含在 `verify` 中） |
| `npm test` | `node --test` 单测（自动发现 `tests/`，Windows 兼容；**需先 build**，测试从 dist 导入） |
| `npm start` | 产品模式：启动 harness + 五 Tab 壳（需 dsh 可用且 `~/.dsh` 存在 web profile）；默认反馈地址为 `https://feedback.flashingchen.xyz/v1/feedback`，可用 `DSH_FEEDBACK_ENDPOINT` 覆盖 |
| `npm run smoke` | 骨架冒烟（不启 harness）：五 Tab DOM + 真实插件/MCP/skills 数据断言，截屏 `artifacts/m0-smoke.png` |
| `npm run smoke:harness` | 真实 harness 冒烟：iframe 挂载 + 状态「已连接」，截屏 `artifacts/m1-harness.png` |
| `npm run verify:m1` | M1 实机验证：真实启动 dsh web → HTTP 200 → 优雅停止 → 端口关闭无孤儿 |
| `npm run verify` | 一键门禁：骨架契约 + 构建产物 + typecheck×2 + 单测全绿（`npm test` 已改为先 build） |

## 打包命令

```sh
npm run build                          # 1. 构建 dist/
node scripts/bundle-runtime.mjs        # 2. 捆绑运行时（首次/更新）：下载 Node v24.10.0 +
                                      #    安装 @deepseek-ai/dsh@0.1.0-rc.6 到 resources/
npx electron-builder --mac dmg zip --arm64 # 3. macOS：DMG 首装 + zip（签名版本的更新载荷）
npx electron-builder --win nsis --x64  # 4. Windows：release/DSH-Desktop-Hub-<version>-x64.exe
```

- `bundle-runtime.mjs`：下载官方 Node v24.10.0（win/darwin/linux × x64/arm64）到 `resources/nd`，用捆绑 npm 以 `--ignore-scripts` 安装锁定版本 `@deepseek-ai/dsh@0.1.0-rc.6` 到 `resources/rt`；`RUNTIME_TARGET=win32` 可在 macOS 上交叉捆绑 Windows 运行时（含 .cmd shim 生成）。
- `electron-builder.yml`：`files` 含 `dist/**/*` + `resources/**/*`；`asar: false`（产物直放 `resources/app`，压低 Windows 安装路径深度）；mac 目标 DMG + zip（arm64，正式签名后用于自动更新）+ Windows 目标 NSIS（x64，assisted per-user，可选择安装目录）；当前均未签名。
- 打包后的应用在 PATH 仅 `/usr/bin:/bin`（无系统 node/dsh）的环境下可用捆绑运行时启动。

## Release

推送 `v*` tag 后，GitHub Actions 自动完成发布（无需手动构建/上传）：

1. 创建 draft Release（自动生成 release notes）
2. **并行构建**：macOS arm64 DMG（macos-15）与 Windows x64 NSIS 安装包（windows-latest），各自执行 `verify` → 捆绑运行时 → `electron-builder`
3. **双平台都成功后自动转正发布**，上传 `.dmg / .dmg.blockmap / .zip / .zip.blockmap / .exe / .exe.blockmap / latest.yml / latest-mac.yml`（Windows 直接使用更新通道；macOS 的 `.zip` 仅在正式签名后启用）

```sh
git tag v0.3.0
git push origin v0.3.0
```

> `resources/` 采用「蓝图入库」：`nd/node.exe`、`rt/package-lock.json` 提交进仓库；`rt/node_modules`（数百 MB）被忽略，由 `bundle-runtime.mjs` 在打包时从锁文件重建（`npm ci`）。

## 验证基线

| 层级 | 内容 |
|---|---|
| 契约测试 `tests/skeleton.test.mjs` | 骨架文件齐全；package.json 脚本与 devDependencies；五 Tab 契约；contextIsolation + sandbox + nodeIntegration:false；tsconfig strict |
| Harness `tests/harness.test.mjs`（5 例，不依赖真实 dsh） | `findDsh` 可解析；`dshHome` 默认/覆盖；真实 web profile 发现（首个 bundle = dsh-base）；忽略非 profile 目录；`parseHarnessUrl` |
| Plugin `tests/plugins.test.mjs`（17 例） | bundles ∪ dependencies 分类；排序稳定；`buildPluginCommand` 命令形态；`normalizeInstallSpec` GitHub 链接归一化；聚合仓库识别/拦截；pnpm ignored builds 与 Git prepare 授权、显式拒绝保护；`runPluginOp` 退出码 + 取消；`deactivatePluginIfActive` 幂等清理（remove 后残留激活行） |
| Plugin 生命周期 `tests/plugin-ops.test.mjs`（2 例） | 启动立即返回 token；完成推送失败时仍可查询终态 |
| 权限策略 `tests/permissions.test.mjs`（7 例） | Harness iframe 剪贴板权限精确放行；主帧、其他来源与未知权限继续拒绝 |
| MCP `tests/mcp.test.mjs`（18 例） | 混合 stdio+http 解析；sse / 非法 serverName 警告；格式拒绝；YAML 与官方示例同构；`${VAR}` → `!!js process.env.VAR`；patch 提取 / 替换 / 编辑 / 删除保留注释；空 patch 新建 / 备份事务；`!!js` 行在 merge/update/delete 后保真（AST 行级操作 + `$js` 哨兵） |
| Skills `tests/skills.test.mjs`（15 例） | rank 合并 + shadowed；custom/bundled 根扫描；frontmatter 往返一致；kebab-case 校验落盘；可见性切换（含扁平 skill 文件名回退）；zip/.skill 导入（含资源文件、包裹目录剥离、拒绝无 SKILL.md、目录穿越拒绝）；GitHub URL 解析；ClawHub 固定版本导入 |
| `npm run smoke` | 五 Tab 就绪；反馈面板/二维码存在；Plugin/Skills 面板加载完成；MCP 转换端到端（preview 含 `dsh-mcp-client` / `streamable-http`）；不依赖特定 profile 数据 |
| `npm run smoke:plugin` | 临时 `DSH_HOME` 中执行真实 `dsh plugin remove`，确认退出码与 package.json 依赖删除；不触碰用户 profile |
| `npm run smoke:harness` | harness 就绪；iframe 挂载 `http://127.0.0.1:PORT`；状态条「已连接」（`#harness-status`）；重启后 iframe 重挂载到新端口 |
| `npm run verify:m1` | 真实 dsh web 启动并 HTTP 200（页面 ≥100B）；优雅停止后端口关闭、无孤儿进程 |

## 已知限制

- **profile 固定**：`ACTIVE_PROFILE` 常量 = `'web'`，暂无 UI 切换（Roadmap 中）。
- **市场目录**：Plugin 使用 DSH Plugin Market / Awesome DSH Plugin 清单，MCP 使用官方 MCP Registry + DSH MCP Market，Skills 使用 ClawHub + SkillsMP；在线结果经过 schema 校验并缓存到本地。Plugin 安装前校验 `dsh.bundle`，npm 锁定精确版本，GitHub 尽量锁定 commit；ClawHub Skills 锁定版本后只写入 `SKILL.md`。
- **Routing Suite 聚合仓库**：`https://github.com/yjh051108/dsh-routing-suite` 不是单一 DSH bundle，根目录缺 `package.json/dsh.bundle`；Plugin Tab 会拒绝直接安装。应按仓库说明分别装配 injector、router-standard preset 与可选 mode-boost。
- **无完整 Settings / 其他系统**：API Key/模型配置请使用官方 Web UI 内能力；应用更新入口已在壳层侧边栏提供；反馈 Tab 已加入，但生产提交依赖可访问的 feedback API。
- **git 来源插件的构建授权**：pnpm ≥10 拒绝依赖构建脚本时，Hub 会解析 pnpm 给出的包名或完整 Git depPath，逐包请求用户确认；确认后才原子写入 profile 的 `pnpm-workspace.yaml.allowBuilds` 并重试一次。该授权仍属于在本机执行第三方代码。
- **MCP `!!js` backtick 模板兼容**：patch 中以反引号模板写 `Bearer ${...}`（官方 README 示例写法）超出 yaml 解析器语法，MCP 面板会拒绝解析并提示；请改用单引号字符串 `!!js 'Bearer ${...}'`（语义为字面字符串）或行级 `process.env.X`。
- **MCP 无文件导入**：MCP 面板支持粘贴 JSON（`${VAR}` 自动转 `!!js process.env.VAR`；默认合并写入，可选全量替换），暂无 `.mcp.json` 文件选择器。
- **退出边界**：正常退出走 SIGTERM 进程组清理 + 单实例锁；Harness 意外退出可在 UI 一键重启；强杀（timeout / group-kill）仍可能遗留 dsh 子进程。
- **打包范围**：macOS DMG + zip（arm64）和 Windows NSIS 安装包（x64）当前均未签名（首次运行需按平台放行一次）；Linux 待做。Windows 正式安装版支持自动更新；未签名 macOS 会明确提示手动下载 DMG，开发模式不会联网检查。
- **体积**：`resources/` 捆绑运行时约 586MB（gitignore），首包体积较大。
- **反馈服务配置**：桌面端默认请求 `https://feedback.flashingchen.xyz/v1/feedback`，也可通过 `DSH_FEEDBACK_ENDPOINT` 覆盖；服务不可达时复制反馈仍可用。服务端启用 Cloudflare Rate Limiting（每个 edge client IP 每 60 秒 10 次，限流策略具有边缘位置级最终一致性）。私有 `github-issue-server/` 不随公开仓库发布。
- **写操作落真实 profile**：MCP「写入 patch」真实修改 `~/.dsh/profiles/web/cordis.patch.yml`（写入前自动 `.bak-<ts>` 备份）；插件安装/移除真实执行 `dsh plugin`。

## License

MIT
