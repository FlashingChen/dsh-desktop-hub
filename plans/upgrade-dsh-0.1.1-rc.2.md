# DSH 0.1.0-rc.6 → 0.1.1-rc.2 升级计划（防呆 + 数据迁移）

> 状态：已验证（2026-08-27 Mac 106/106，Win 106/106）
> 执行人：Codex
> 日期：2026-08-27
> 关联 Issue：#38（credentials version 类型陷阱）
> 目标版本：`@deepseek-ai/dsh@0.1.1-rc.2` · Node v24.10.0 不变 · pnpm 11.22.0 不变

## 已确认决策

- 捆绑运行时直接升到 `0.1.1-rc.2`（最新 rc），不再保留多版本并存的 runtime 目录；允许多方案指“用户侧数据兼容多版本”，而非壳层同时装两套 dsh。
- 若检测到本机 `~/.dsh` 仍为旧格式（flat 凭据 / 旧 SQLite），**不静默覆盖、不阻断启动**，而是弹「推荐升级」横幅 + 备份 + 一键迁移。
- 所有迁移操作必须**先备份、再校验、后写入**，失败可回滚；迁移幂等，可重入。
- 实施顺序：本计划文档 → 代码实现 → `bundle-runtime` 重打 → 单测 + smoke → 打包验证。

## 现状与根因

- `resources/runtime-manifest.json`（2026-08-17）与 `scripts/bundle-runtime.mjs:DSH_VERSION='0.1.0-rc.6'` 冻结在 rc.6。
- 上游 `dsh-credentials-local` 在 `0.1.1-rc.1` 起改为 versioned 格式（`version: 1` 数字 + `refs:`），并在 `lib/index.js` 新增 `renderFlatLayoutMigration()`。旧 flat 文件在新版会报 `unknown top-level key`，新版 `version: "1"`（字符串）在旧版报 `must be a string`，形成两头都错。
- `0.1.0-rc.8` 声明 SQLite 结构不兼容；会话/存储需重建或迁移。

## 兼容性清单

| 数据 | 旧形态 | 新形态 | 风险 |
|------|--------|--------|------|
| `~/.dsh/.credentials.yaml` | 顶层 `KEY: value`，无 `version` | `version: 1`（number）+ `refs:` 嵌套 | 直接用新 dsh 启动旧文件会 `unknown top-level key`；旧 dsh 读新文件会 `must be a string` |
| `~/.dsh/sessions` / `storages` / `profiles/*/cordis.yml` | rc.6 SQLite/快照 | rc.8 重构后不兼容 | 旧数据在新版可能无法加载，Silently empty 或报错 |
| `~/.dsh/settings.yaml`、`~/.dsh/profiles/web/*` | 基本兼容 | 需验证 `cordis.patch.yml` 中旧 `directory-picker` 行 | 已有 `repairDirectoryPickerRows` 可复用 |
| 捆绑 Node/pnpm | v24.10.0 / 11.22.0 | 不变 | 无迁移 |

## 设计原则（防呆）

1. **默认用最新的**：`resources/rt` 始终为 0.1.1-rc.2；`resolveDshExec()` 优先捆绑，不回退系统旧 dsh。
2. **检测而非猜测**：启动前同步检测 `~/.dsh/.credentials.yaml` 形态（flat / versioned / 不存在 / 损坏），写入诊断块 `Credentials format` 字段，UI 可直接展示。
3. **推荐而非强制**：检测到 flat 旧格式时，主进程通过 `harness:status` 推送 `needsMigration` 状态，渲染层顶部横幅提示“检测到旧凭据格式，建议一键迁移（已自动备份）”，用户可「立即迁移」「稍后」「查看备份」。
4. **先备份后写入**：复用 `src/core/mcp.ts: atomicWriteWithBackup`；备份命名 `.credentials.yaml.bak-<ISO>`；SQLite/存储备份为 `~/.dsh/.backup-<ts>/` 目录拷贝（仅在用户确认迁移时执行）。
5. **校验后切换**：迁移后用新版 `parseCredentialsDocument` 逻辑校验（`js-yaml` / `yaml` 解析），失败则还原备份并报错。
6. **幂等可重入**：已是 `version: 1` + `refs:` 的文件不再迁移；空文件/不存在文件跳过。

## 方案（允许多方案）

- **方案 A（推荐）**：一键迁移 flat → versioned（复刻上游 `renderFlatLayoutMigration`：无 `version`、无文档指令、所有顶层键为合法 `credentialRef` 且值为非空字符串时，才重写为 `version: 1\nrefs:\n  <原行>`）。
- **方案 B（保守）**：仅备份，不迁移；提示用户手动按官方文档操作；壳层仍尝试启动 Harness（新 dsh 会自行报 `unknown top-level key`，错误透传到 UI，不吞错）。
- **方案 C（兜底）**：若用户已手动改成 `version: "1"` 字符串，检测到后自动修正为 `version: 1` 数字（仅改 version 行，保留 refs）。

三方案通过同一检测函数分流，统一备份入口。

## 数据迁移详细步骤

### 凭据迁移（`src/core/credentials-migration.ts` 新增）

```ts
detectCredentialsFormat(text): 'flat' | 'versioned' | 'empty' | 'unknown'
canMigrateFlat(text): boolean // 复刻上游校验
migrateFlat(text): string   // `version: 1\nrefs:\n<indent>`
backupAndMigrate(path): { ok, backup?, migrated?, error? }
```

调用点：`src/main/main.ts:startHarnessAndWatch()` 之前，`src/core/harness.ts:ensureCredentialsCompatible()`；若为 flat，则先备份再发 IPC 事件 `credentials:migration-needed`，由渲染层确认后执行 `migrateFlat` 并重启 Harness。

### 存储/会话迁移

- 检测：`~/.dsh/storages` 或 `sessions` 存在且 `runtime-manifest` 版本跨越 `0.1.0-rc.8` 时，标记 `storageNeedsMigration`。
- 行为：不自动删库；仅备份目录并提示“历史会话在新版本需重建，已备份至 …，重启后生效”。
- 实现：`copyDirWithBackup(src, dest)`，失败不阻断 Harness 启动。

## UI/交互

- 新增 IPC：`credentials:status`（返回 format/backupPath）、`credentials:migrate`（执行迁移）。
- 渲染层 `src/renderer/renderer.ts`：Harness Tab 顶部插入迁移横幅（与现有 `harnessStatus` 渲染同区），文案包含备份路径与“查看文件夹”按钮（`shell.openPath`）。
- 诊断块新增一行 `Credentials format: flat | versioned | missing | unknown`（`src/core/diagnostics.ts`）。

## 文件清单

- `scripts/bundle-runtime.mjs`：`DSH_VERSION='0.1.1-rc.2'`
- `resources/rt/package.json` + `package-lock.json`：`@deepseek-ai/dsh@0.1.1-rc.2`
- `resources/runtime-manifest.json`：执行 bundle 后自动生成
- `src/core/credentials-migration.ts`：新增（检测/迁移/备份）
- `src/core/harness.ts`：新增 `ensureCredentialsCompatible()` 导出，供 main 调用
- `src/core/diagnostics.ts`：新增 `credentialsFormat` 字段
- `src/core/ipc.ts` / `src/main/main.ts` / `src/preload/preload.ts` / `src/renderer/*`：IPC 与横幅
- `tests/credentials-migration.test.mjs`：新增单测

## 验证

- [x] `node scripts/bundle-runtime.mjs`（manifest/package.json 已更新至 0.1.1-rc.2；完整 node_modules 安装由后台 npm 进程收尾，106 tests 已通过）（本地 darwin/arm64 与 RUNTIME_TARGET=win32 交叉）
- [x] `npm run typecheck` + `npm test`（typecheck 0 错，106/106 通过）（新增迁移单测 8+ 用例）
- [x] `npm run verify` / `electron . --harness-smoke`（flat 文件场景：横幅出现→迁移→重启成功）— Win 实测 flat→versioned 迁移、备份、幂等、dump-config 通过
- [x] 手动回归：空凭据 / flat / versioned-数字 / versioned-字符串 / 损坏文件 五种形态 — detectCredentialsFormat/migrateFlat/fixVersionStringIssue 全覆盖，Win 实测 flat 与 version:"1" 两种现场均一键修复
- [x] 打包 `npm run build` 后诊断块显示正确 format — Mac/Win build 均通过，diagnostics 新增 Credentials format 行，Win 版 `formatDiagnostics` 输出 versioned

## 回滚

- 任何迁移失败自动还原备份文件；备份保留至少 1 份，用户可手动 `cp .bak-*` 回滚。
- 若 Harness 仍无法启动，UI 保留“查看备份目录”“复制诊断信息”入口，不丢数据。

## 不做

- 不在本次同时升级 Node/pnpm 版本（保持 v24.10.0 / 11.22.0，降低变量）。
- 不自动清理旧 SQLite，交由用户确认。


### Win 验证记录（2026-08-27 13:3x）
- bundle-runtime：manifest dshVersion 0.1.1-rc.2 已对齐（Mac/Win）
- Win `npm run build` ✅ `node --test` 106/106 ✅（曾出现 105/106 的 runtimePathEnv 抖动，重跑后通过）
- 凭据迁移：flat `DEEPSEEK_API_KEY` → `version: 1\nrefs:` 成功，.bak-* 备份保留，幂等二次调用 migrated:false
- version: "1" 字符串陷阱 → backupAndMigrate 自动修正为数字 1
- `dsh --profile web --dump-config` 在 versioned 凭据下正常输出，无 unknown top-level 报错
- resources/nd 清理：删除 node-v24.10.0-win-x64.zip、CHANGELOG/README/corepack、nd/node_modules 残留，仅保留 tracked 9 文件
