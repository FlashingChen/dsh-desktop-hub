# DSH Desktop — 执行计划（plan.md）

> 依据：PRD.md v0.1（2026-08-16，已含调研结论与实证样例）
> 开发环境实测：macOS (Apple M5) · Node v25.9.0 · `dsh` 0.1.0-rc.6（Homebrew）· `~/.dsh` 含真实 profiles（web / dsh-tui）、skills（huashu-design）、plugins（dsh-super-injector）
> 规则：每次只做一件事；每步先写最小可执行方案 + 验证方式；完成打勾；验证脚本一键运行（`npm run verify`）

## 里程碑（按 PRD §5 拆分，每步独立可验证）

- [x] **M0 壳骨架** — Electron + TypeScript 三端（main/preload/renderer）工程；`typecheck` / `test` / `verify` 脚本。
  - 验证：`npm run typecheck` 通过；`npm run verify` 全绿（骨架检查 + 测试）。
  - 实测 2026-08-16：`npm run verify` → VERIFY OK；`npm run smoke` → SMOKE OK，DOM 断言 4 Tab（harness/plugin/mcp/skills）就绪，截屏 `artifacts/m0-smoke.png`。

- [x] **M1 Harness 启动与加载** — 检测 `dsh`/`$DSH_HOME`/profiles；`resolveDshExec()` 优先打包内 runtime（回退系统 PATH）；spawn `dsh web --port 0`（detached 独立进程组）→ 解析端口 + 轮询 HTTP 200；Harness Tab 以 iframe 内嵌官方 Web UI（主进程 `did-frame-navigate` 推送 `harness:frame-loaded` 更新状态）；退出时 SIGTERM 进程组清理（2s 兜底 SIGKILL）。
  - 验证：`npm run verify:m1`（真实启动 → HTTP 200 → 优雅停止 → 端口关闭无孤儿）；`npm run smoke:harness`（iframe 挂载 `http://127.0.0.1:PORT` + 状态「已连接」+ 截屏 `artifacts/m1-harness.png`）。
  - 实测 2026-08-16：`npm run verify:m1` → M1 VERIFY OK；`npm run smoke:harness` → SMOKE OK，harness 内嵌成功（iframe + 状态「已连接」）。

- [x] **M2 Plugin 系统** — profile 发现 + 插件列表（`dsh.profile.bundles` + node_modules 依赖）；封装 `dsh plugin --profile <name> add|remove|update`（防呆：目标 profile 显式选择）。
  - 验证：单测（临时 profile 模拟 bundle 解析）；真实 `web` profile 只读列表正确。
  - 实测 2026-08-16：单测 4/4（分类/排序/命令形态/退出码+取消）；Electron 冒烟断言真实列表 ≥4 项含 dsh-base；真实 CLI `dsh plugin --profile web why` 通。

- [x] **M3 MCP 系统** — JSON→YAML 转换器（PRD §2.4 已验证算法）+ profile `cordis.patch.yml` 事务读写（备份/回滚）+ 服务器列表/增删改。
  - 验证：单测（转换器 + patch 事务，损坏写入可回滚）；真实 `web` profile 的 cordis.patch.yml 只读展示。
  - 实测 2026-08-16：单测 8/8（混合输入/sse 警告/格式拒绝/YAML 同构/提取/替换保留注释/空 patch 新建/备份事务）；Electron 冒烟端到端驱动转换（renderer→IPC→core→renderer），真实 profile 只读列表 = 0。

- [x] **M4 Skills 系统** — rank 100-600 目录扫描；SKILL.md/平铺 md 解析 + frontmatter（name/description/disable-model-invocation/user-invocable）；新建/编辑/可见性切换。
  - 验证：单测（fixture 目录，含同名 shadow 判定）；真实 `~/.dsh/skills/huashu-design` 展示正确。
  - 实测 2026-08-16：单测 4/4（rank 合并/shadowed/往返一致/创建 kebab 校验/可见性切换）；Electron 冒烟真实数据：huashu-design(user-dsh)+media-use(user-agents)=2 个，rank 扫描正确。

- [x] **M5 桌面整合与打包** — 四 Tab 主窗口（Harness / Plugin / MCP / Skills）整合：默认模式＝启动 harness + 四 Tab 壳，**Harness Tab 以 iframe 内嵌官方 Web UI**（非独立窗口/非菜单跳转，主进程 `did-frame-navigate` 推送加载状态）；electron-builder 出 DMG。
  - 验证：应用启动后各 Tab 功能走通；打包产物存在且可启动。
  - 实测 2026-08-16：默认模式＝四 Tab 壳 + iframe 内嵌官方 Web UI（主菜单仅「退出/全屏」）；DMG 248MB（arm64，`release/DSH-Desktop-0.1.0-arm64.dmg`）；打包 app 在 PATH 仅 /usr/bin:/bin（无系统 node/dsh）下用捆绑 Node+dsh 启动，HTTP 200；TERM 退出无孤儿。
  - 已知限制：`ACTIVE_PROFILE` 固定 'web'（profile 切换待做）；强杀（timeout/group-kill）可能遗留 dsh 子进程；应用图标为 Electron 默认；Windows 打包待后续（本机构建环境为 macOS）。

## 约束

- 只读操作优先走真实环境（`~/.dsh`）；任何写操作（安装插件 / 改 patch / 新建 skill）默认落在**临时 profile / 临时目录**，除非用户显式指向真实 profile。
- 打包前的「用户无需安装 Node」由 M5 的 electron-builder 内置运行时保证（PRD §4.1 方案 A）。
- 上游版本锁定：以 `@deepseek-ai/dsh` 实际安装版本为准（本机 0.1.0-rc.6）。

## 下一步（建议）

- **Profile 切换**：`ACTIVE_PROFILE` 常量（现固定 'web'）→ 壳级设置/托盘多 profile 选择；借鉴 anywhere-labs 的 last-known-good 回退（重启边界）。
- **Settings Tab（壳级）**：API Key / 模型 / profile / 更新入口（复用官方 Web UI 设置能力 + 壳级项，PRD §3.3）。
- **插件体验**：git 来源 `allowBuilds` 授权向导（PRD §2.3）；安装后一键重启 harness（当前为手动重启）。
- **MCP / Skills 导入**：`.mcp.json` 文件选择器；skill 文件导入（当前为粘贴正文表单）。
- **打包矩阵**：Windows（NSIS）与 Linux（AppImage）；应用图标；自动更新（electron-updater 或自建版本服务）。
- **稳定性**：单实例锁；渲染崩溃自愈；`dsh web` 意外退出后的重连/重启策略。

