# DSH Beacon — 执行计划（PRD → MVP v0.1）

> 项目目录：`./beacon`
> 项目名：**DSH Beacon**（信标：一眼看到 DSH 的状态、健康与入口）
> 理由：创新、易读、与现有 `dsh-desktop` / `DSH-Orbit` 不重叠；短小易输入，适合桌面应用。

## 执行规则

- 每一步先写最小可执行方案 + 明确验证脚本。
- 每完成一项任务在下方打勾 `[x]`。
- 所有验证脚本可一键运行：`npm run verify`。
- 开发目录为 `beacon/`，根目录只保留 `plan.md`。

## 任务清单

- [x] **T1 项目骨架**
  - 方案：`beacon/` 初始化 npm 包，Electron + TypeScript 主进程/预加载/渲染进程三端分离；提供 `npm run typecheck`、`npm run test`、`npm run verify`。
  - 验证：`node scripts/verify.mjs --skeleton`；`npm run typecheck` 通过。

- [x] **T2 DSH 环境检测与 Profile 发现**
  - 方案：`src/core/env.ts` 检测 `dsh` 命令、`~/.dsh`、版本、Profiles；`src/core/profiles.ts` 读取 profile package.json 的 `dsh.profile.bundles` 与插件依赖。
  - 验证：`npm run test -- --env`；在真实机器上识别 `web`/`dsh-tui`。

- [x] **T3 安全配置事务 + Snapshot/Rollback**
  - 方案：`src/core/transaction.ts` 实现 Read→Parse→Backup→Modify→Validate→Atomic Write→Health Check；`src/core/snapshots.ts` 保存最近 10 条，可 Restore。
  - 验证：`npm run test -- --transaction`；用临时目录模拟损坏写入并验证原文件不被破坏。

- [x] **T4 MCP Manager**
  - 方案：`src/mcp/` 支持 JSON Import 转换到 DSH `cordis.yml` MCP 实例、Manual Form、Add/Edit/Delete/Enable/Disable、Test Connection、View Tools；每个修改走 T3 事务。
  - 验证：`npm run test -- --mcp`；临时 profile 写入 MCP 配置后可回滚。

- [x] **T5 Skills Manager**
  - 方案：`src/skills/` 按 DSH `skill-filesystem` 规则扫描 `project/.dsh/skills`、`~/.dsh/skills` 等根；解析 `SKILL.md`/平铺 `.md`；识别同名 Shadowed/Effective；Install from GitHub/Local；Enable/Disable/Open。
  - 验证：`npm run test -- --skills`；构造两个同名 skill 验证 shadow 判定。

- [x] **T6 Plugin Manager**
  - 方案：`src/plugins/` 封装官方 `dsh plugin --profile <name> ...`，列出 bundle/依赖、安装/移除/更新/启停；不自行实现包管理。
  - 验证：`npm run test -- --plugins`；用临时 profile 校验依赖/bundle 解析与启停逻辑，安装命令封装留待真实环境手动执行。

- [x] **T7 Doctor**
  - 方案：`src/doctor/` 实现 DSH/Runtime/Profile/Model/Plugins/Skills/MCP/Config Syntax/Filesystem 检查，返回 `CheckResult[]`。
  - 验证：`npm run test -- --doctor`；模拟缺失 DSH、坏配置等场景。

- [x] **T8 Plugin Marketplace**
  - 方案：`src/marketplace/` 抽象 `PluginRegistry`，内置示例 Registry + 搜索/详情/一键安装（安装仍走 T6）。
  - 验证：`npm run test -- --marketplace`。

- [x] **T9 Electron UI**
  - 方案：主进程暴露 IPC API，渲染进程实现 Overview/Plugins/Skills/MCP/Profiles/Doctor/Settings/Marketplace 七页 + Snapshot 区。
  - 验证：`npm run typecheck`；`node scripts/verify.mjs --ui` 校验静态页面与 IPC 合约。

- [x] **T10 端到端验证与收尾**
  - 方案：运行全部验证脚本，更新 README，确认 `plan.md` 全勾选。
  - 验证：`npm run verify` 全绿。

## 验证脚本

- `scripts/verify.mjs`：聚合所有最小验证。
- `scripts/test-runner.mjs`：独立模块验证（`--env`、`--transaction`、`--mcp` 等）。
- 测试使用临时 `DSH_HOME`（`mkdtemp`），不修改真实 `~/.dsh`（除显式安装/演示操作外）。
