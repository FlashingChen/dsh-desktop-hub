# 贡献指南

感谢你愿意为 DSH Desktop Hub 提交代码、文档、测试或问题反馈。

这份指南针对本仓库当前的开发流程。项目仍在快速迭代中，遇到文档没有覆盖的情况，可以先在 [Issues](https://github.com/FlashingChen/dsh-desktop-hub/issues) 或 [Discussions](https://github.com/FlashingChen/dsh-desktop-hub/discussions) 讨论。

## 贡献前先了解什么

建议先阅读：

- [`README.md`](README.md)：产品范围、架构、开发命令和已知限制
- [`PRD.md`](PRD.md)：产品目标与功能边界
- [`MARKET_SOURCES.md`](MARKET_SOURCES.md)：市场数据来源、许可证边界和安全限制
- `src/core/`：可复用、可单测的核心逻辑
- `src/main/`、`src/preload/`、`src/renderer/`：Electron 主进程、受限桥接层和界面
- `tests/`：Node.js 单元测试

小型修复、测试补充和文档改进可以直接提交 PR。新功能、架构调整、市场来源变更，以及会修改用户 profile 或执行第三方代码的改动，建议先开 Issue 或 Discussion 说明目标和方案。

## 本地开发环境

- Node.js 24。CI 使用 Node.js 24，建议使用同一主版本。
- npm。仓库使用 `package-lock.json`，不要混用其他包管理器更新依赖。
- macOS 或 Windows 可进行本地开发；CI 会在 Windows 上运行主要门禁。

初始化项目：

```sh
git clone https://github.com/FlashingChen/dsh-desktop-hub.git
cd dsh-desktop-hub
npm ci
```

## 常用命令

| 命令 | 用途 |
|---|---|
| `npm run build` | 编译主进程、core、preload 和 renderer |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm test` | 构建后运行 `tests/` 下的 Node.js 测试 |
| `npm run verify` | 完整门禁：构建、两套 typecheck 和全部单测 |
| `npm run smoke` | Electron 五 Tab 壳层冒烟测试，并生成截图 |
| `npm run smoke:plugin` | 在临时 `DSH_HOME` 中验证真实 `dsh plugin remove`，不触碰个人 profile |
| `npm start` | 启动产品模式，需要可用的 dsh 和 `web` profile |
| `npm run smoke:harness` | 启动真实 Harness 并验证 iframe，需要可用的 dsh 和 `web` profile |
| `npm run verify:m1` | 验证 Harness 启动、HTTP 可访问和优雅停止，需要可用的 dsh |

提交前至少运行：

```sh
npm run verify
```

涉及界面、Electron 生命周期或 IPC 的改动，再运行：

```sh
npm run smoke
```

`npm start`、`npm run smoke:harness` 和 `npm run verify:m1` 会启动真实 Harness。它们可能读取或影响本机的 `web` profile，测试插件安装、移除或 MCP 写入时请使用临时 `DSH_HOME`，不要直接操作重要的个人配置。

## 项目结构和改动边界

- `src/core/`：Harness、Plugin、MCP、Skills、市场和反馈等核心逻辑。优先把可测试逻辑放在这里。
- `src/main/`：Electron 主进程、窗口生命周期、IPC handler 和权限策略。
- `src/preload/`：通过 `contextBridge` 暴露给 renderer 的最小 API。不要把 Node.js 或任意文件系统能力直接暴露给页面。
- `src/renderer/`：五个 Tab 的界面。当前 renderer 是纯脚本，不要随意改成依赖 bundler 的模块结构。
- `tests/`：核心逻辑和安全边界测试。测试从 `dist/` 导入，因此修改后要先构建。
- `scripts/`：构建、运行时捆绑和验证脚本。
- `resources/rt/package-lock.json`、`resources/runtime-manifest.json`：捆绑运行时的可追踪清单。`node_modules/`、`dist/`、`release/` 和 `artifacts/` 是生成或忽略内容，不要把本地产物提交进去。

### 跨层改动

如果修改 IPC 契约，通常需要同步检查：

1. `src/core/ipc.ts` 中的 channel 和类型
2. `src/preload/preload.ts` 中的白名单桥接 API
3. `src/main/main.ts` 中的 handler
4. `src/renderer/renderer.ts` 中的调用和界面状态
5. 对应测试和 smoke 断言

如果修改 profile 或 patch 写入逻辑，请保留原子写入、备份、并发串行化和错误处理行为，并补充事务失败、空配置或格式异常等测试。

如果修改权限、Harness iframe、子进程清理、第三方插件安装或市场来源，请把安全影响和跨平台行为写进 PR，并补充相应测试。

## 测试要求

- 新增或修复核心逻辑时，优先在对应的 `tests/*.test.mjs` 中加入回归测试。
- 测试应使用临时目录、临时 `DSH_HOME` 或内存数据，不能依赖贡献者机器上的固定 profile、插件、Skills 或密钥。
- UI 改动至少确认五个 Tab、数据加载和关键交互没有回归；必要时更新 `src/main/smoke.ts` 的断言。
- 修改 Windows 路径、进程、`.cmd` shim 或权限行为时，至少说明是否在 Windows 上验证过。CI 的 `windows-gate` 会运行 `npm run verify` 和 Electron smoke。
- 不要为了让测试通过而降低安全设置，例如关闭 `contextIsolation`、开启 `nodeIntegration` 或放宽来源权限。

## 分支和提交

从最新的 `main` 创建分支，建议使用清晰的前缀：

```text
feat/short-description
fix/short-description
test/short-description
docs/short-description
```

提交信息建议沿用仓库已有的简短英文前缀，例如 `feat:`、`fix:`、`docs:` 或 `test:`。一次提交尽量只解决一个主题，避免把无关格式化、生成文件或依赖升级混进功能改动。

## 提交 Pull Request

PR 描述请尽量包含：

- 改动解决了什么问题，以及为什么采用这个方案
- 影响到哪些平台、profile、文件写入或权限边界
- 已运行的命令及结果，例如 `npm run verify`、`npm run smoke`
- 界面改动的截图或录屏
- 关联的 Issue 或 Discussion
- 已知限制、未覆盖的测试和需要维护者特别关注的地方

提交前检查：

- [ ] 改动范围与 PR 目标一致
- [ ] `npm run verify` 通过
- [ ] 相关的 smoke、跨平台或真实 Harness 验证已经运行，或已在 PR 中说明原因
- [ ] 没有提交 API Key、个人 profile、真实反馈内容、日志或本地产物
- [ ] 依赖和 `package-lock.json` 的变更是必要且可解释的
- [ ] 用户可见行为、市场来源或已知限制发生变化时，相关文档已同步

PR 会由 GitHub Actions 自动检查。请根据 CI 日志修复失败项；维护者可能要求补充测试、缩小改动范围或先完成设计讨论。

## Issue 和安全问题

Bug 报告请提供操作系统、应用版本或 commit、复现步骤、期望行为、实际行为，以及必要的日志或截图。提交日志前请删除 API Key、访问令牌、个人路径和其他敏感信息。

不要在公开 Issue 中披露可直接利用的安全漏洞或第三方凭据。若问题涉及权限绕过、任意代码执行、敏感数据泄露或供应链风险，请通过 GitHub 提供的私下联系渠道联系维护者，并尽量提供最小可复现信息。

## 许可证

提交到本项目的代码和文档将按仓库的 [MIT License](LICENSE) 发布。
