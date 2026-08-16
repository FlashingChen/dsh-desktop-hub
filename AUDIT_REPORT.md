# DSH Desktop 仓库审查报告

> 日期：2026-08-16  
> 审查结论：**REQUEST_CHANGES**  
> 审查范围：21 个核心源码、测试、脚本和文档文件，共 4,124 行；另检查 package/build 配置、锁文件、打包后的 ASAR、Bundled DSH CLI。

## 1. 执行摘要

当前不能把 PRD 标记为“全部实现”，也不建议继续分发现有 DMG。

| 严重级别 | 数量 |
|---|---:|
| P0 Critical | 1 |
| P1 High | 7 |
| P2 Medium | 6 |
| P3 Low | 1 |

核心 Harness 在当前 macOS arm64 环境可以启动、返回 HTTP 200 并在正常退出时关闭端口；但 Skills 导入存在可利用的任意路径写入漏洞，Plugin 在无系统 pnpm 的目标环境不可用，MCP 预览和实际写入不一致，当前 DMG 也不是由当前源码构建。

---

## 2. Findings

### P0 — Critical

#### 1. Skill ZIP 导入存在目录穿越，可越界写文件

**位置：** `src/core/skills.ts:239-263`

`writeBundleFromZip()` 直接根据 ZIP entry 拼接落盘路径：

```ts
const rel = e.entryName.slice(skillDir.length).replace(/^\/+/, '')
const dest = join(target, rel)
writeFileSync(dest, e.getData())
```

代码没有拒绝 `..`、绝对路径或 NUL，也没有验证 `resolve(dest)` 仍位于 `target` 内。

实际构造包含以下 entry 的原始 ZIP：

```text
safe-skill/../../escaped.txt
```

代码成功把文件写到 skill 目标目录之外：

```text
.../.audit-zipraw-*/escaped.txt
```

增加更多 `..` 可以继续越过 `$DSH_HOME/skills`，覆盖当前用户可写文件。攻击入口包括用户导入恶意 `.skill` 或 `.zip`。

**修复要求：**

- 统一路径分隔符，拒绝绝对路径、NUL 和任何 `..` segment。
- 使用 `resolve(target, rel)`，强制结果位于 `resolve(target)` 内。
- 限制文件数、单文件大小和总解压大小。
- 先解压到临时目录，全部验证成功后再原子替换。
- 回归测试必须使用原始 ZIP central-directory traversal；`AdmZip.addFile()` 会提前规整路径，无法覆盖该漏洞。

### P1 — High

#### 2. Skill 内容可注入管理台 DOM，并借助 IPC 修改任意路径

**位置：**

- `src/renderer/renderer.ts:498-516`
- `src/main/main.ts:209-215`
- `src/core/skills.ts:203-224`

Skill 的 `name`、`description` 和 `path` 未转义就进入 `innerHTML`。随后 renderer 会为所有注入出的 `[data-toggle]` 元素绑定可信点击处理器。

恶意 skill 可以在 description 中插入伪造按钮和任意 `data-toggle="/path/to/file"`。主进程不验证路径是否来自扫描结果，直接调用 `setInvocation(input.path, ...)`，导致任意文本文件被改写成 skill frontmatter 格式。CSP 会阻止普通内联脚本，但无法阻止可信 renderer 给注入按钮绑定事件。

**修复要求：**

- Skills 表格使用 DOM API 和 `textContent`，不拼接 `innerHTML`。
- Renderer 只传稳定 skill ID；主进程重新扫描并解析到真实路径。
- `realpath` 后验证目标属于允许的 skill roots，且确实是扫描到的 `SKILL.md` 或扁平 skill。
- IPC 增加 sender/frame 来源校验。

#### 3. “无需安装运行环境”对 Plugin 和常见 MCP 实际不成立

**位置：**

- `scripts/bundle-runtime.mjs:32-40`
- `src/core/harness.ts:109-115`
- Bundled DSH `lib/plugin-*.js:108-116`

安装包只捆绑 Node/npm/npx，没有捆绑 `pnpm`，也没有把 `resources/node/bin` 加入子进程 `PATH`。而 `dsh plugin` 内部直接执行 `pnpm`。

在 `PATH=/usr/bin:/bin`、仅使用 bundled Node/DSH 的环境中实测：

```text
status=127
dsh: pnpm not found on PATH — install pnpm to manage profile plugins
```

同理，PRD 示例中的 `command: npx` MCP 在干净桌面环境也找不到 bundled `npx`。

**影响：** Harness 能启动，但 Plugin 核心管理能力和大量 stdio MCP 在目标“非技术用户”环境失效。

**修复要求：** 捆绑并锁定 pnpm；构造统一 runtime `PATH`，同时传给 Harness 和 Plugin 子进程；增加最小 PATH 下的插件安装和 `npx` MCP 实机验证。

#### 4. MCP 预览、实际写入和事务语义不一致

**位置：**

- `src/core/mcp.ts:94-110`
- `src/core/mcp.ts:168-207`
- `src/core/mcp.ts:226-235`
- `src/main/main.ts:151-160`

存在四个问题：

1. 预览把 `${TOKEN}` 显示为 `!!js process.env.TOKEN`，但返回给 UI 的 `rows` 没有转换；实际写入仍是字面 `${TOKEN}`。实测结果为 `previewHasJs=true`、`writtenHasJs=false`、`writtenHasLiteral=true`。
2. 导入一份新 JSON 会删除 patch 中全部既有 MCP rows；确认框只写“写入”，没有告知“全量替换”。
3. 如果 `cordis.patch.yml` 不存在，`copyFileSync(file, backup)` 会先报 `ENOENT`，首次写入失败。
4. 现有 patch 权限为 `0600` 时，经临时文件 rename 后变为 `0644`；MCP headers 中可能包含 token。

**修复要求：** 预览和落盘共享同一规范化模型/serializer；明确选择“合并”或“全量替换”；不存在原文件时跳过备份；临时文件继承原 mode，敏感新文件默认 `0600`。

#### 5. Plugin 状态机和 PRD 声称的操作不闭环

**位置：**

- `src/core/plugins.ts:109-124`
- `src/main/main.ts:120-136`
- `src/renderer/renderer.ts:194-262`

问题包括：

- `plugins:update` 已注册到 main/preload，但 renderer 没有按钮或调用。
- `PluginOpHandle.cancel()` 没有暴露给 UI；PRD 声称的“输出流、支持取消”实际是主进程全量缓冲，结束后截取 2,000 字符。
- 第三方 bundle 因 `inBundles` 被标记 active，UI 却提供“停用”；停用逻辑只删除 patch row，因此稳定报“插件未激活”。
- 手动激活的普通 dependency 可以直接“移除”；package 被删除后，patch 激活行仍保留，重启 Harness 后会引用不存在的插件。

**修复要求：** 显式建模 `activationSource: bundle | patch | none`；把移除、patch 清理和失败回滚设计成一个状态转换；补齐 update、取消和流式输出；串行化 profile mutation。

#### 6. Skill 导入取消逻辑错误，切换可见性会丢元数据

**位置：**

- `src/renderer/renderer.ts:556-581`
- `src/core/skills.ts:203-224`
- `src/core/skills.ts:239-265`

- 用户在“确认导入”对话框点击 Cancel，只会令 `overwrite=false`，导入仍继续；目标不存在时会照常安装。
- `setInvocation()` 重新渲染整个 frontmatter，只保留 `name`、`description`、`whenToUse` 和两个 visibility 字段。实测 `license`、`allowed-tools` 均被删除。
- 覆盖导入没有先清理旧目录，也不是事务性写入；旧资源可能残留，失败会留下半安装状态。

**修复要求：** Cancel 必须立即 return；只修改目标 YAML AST 字段并保留未知元数据；导入使用临时目录和原子替换。

#### 7. Electron 37.10.3 存在已知高危漏洞

**位置：**

- `package.json:20`
- `package-lock.json:1712-1715`

`npm audit --json` 报告两个 high severity vulnerable packages：`electron` 和其依赖 `extract-zip`。Electron 37 同时命中 context isolation、iframe/window.open、use-after-free 等多项 advisory。审计给出的可用修复版本为 Electron `43.4.0`。

该应用同时使用 iframe、contextBridge 和大量高权限 IPC，不能把这些 advisory 当作无关开发依赖。

#### 8. 当前源码、Smoke 契约和发布 DMG 不是同一个版本

**位置：**

- `src/main/main.ts:428-443`
- `src/renderer/index.html:506-514`
- `release/mac-arm64/DSH Desktop.app/Contents/Resources/app.asar`

当前 HTML 已没有 `#harness-status`，renderer 也没有订阅 `onFrameLoaded`；但 `--harness-smoke` 仍会执行：

```ts
document.getElementById('harness-status').textContent
```

该路径会解引用 `null`。当前 `artifacts/m1-harness.png` 也只显示空白 Harness 区域。

对发布 ASAR 与当前构建的 `dist` 做 SHA-256 比较后，`main.js`、`renderer.js`、`index.html` 三者全部不同；发布版 renderer 仍含旧 `harness-status`，且缺少当前源码中的 Skill 导入 UI。

**影响：** PRD 的“M5 已交付”和现有 DMG 不能作为当前源码的验证证据。

### P2 — Medium

#### 9. Electron 第二道安全边界缺失

`src/main/main.ts:241-258` 没有设置：

- `setWindowOpenHandler`
- `will-navigate` 限制
- permission request/check handler
- IPC sender/frame URL 校验

当前已有可注入 renderer 的入口，因此这些不是纯理论加固。至少应拒绝任意 popup、外部导航和非壳层 sender 的 IPC。

#### 10. 网络、解压和子进程均缺少资源上限

- `src/core/skills.ts:314-320`：GitHub fetch 无超时、Content-Length 或下载上限。
- ZIP 只限制压缩包为 20MB，不限制总解压大小、文件数或单文件大小。
- `src/main/main.ts:49-53`：插件输出先无限累积，再 `slice(0, 2000)`。
- `src/core/harness.ts:128-142`：每个后续日志块都可能启动新的 HTTP 轮询。

这些路径可导致主进程内存耗尽、磁盘耗尽或操作永久挂起。

#### 11. 生命周期缺少异常恢复和单实例保护

Harness 就绪后没有监听后续 `exit` 并更新 UI或重启；应用也没有 `requestSingleInstanceLock()`。两个桌面实例可以同时操作同一 profile 和 patch。

正常 `verify:m1` 的 TERM 清理有效，但不覆盖 Harness 意外退出、启动超时后 `app.exit()`、多实例写冲突等路径。

#### 12. 验证门禁存在明显假绿

- `tests/harness.test.mjs:14-28` 依赖开发者本机安装的 dsh 和真实 `~/.dsh`。
- Smoke 固定要求真实 profile 至少四个插件，以及 `huashu-design`、`media-use`。
- `npm test` 直接测试 `dist`，不先 build；源码变化后可能测试旧产物。
- 当前 35 个测试全绿，却未覆盖 P0 ZIP traversal、MCP 实际落盘、Plugin 状态转换、当前 Harness DOM。

#### 13. Bundled runtime 构建不可复现，供应链校验不足

`scripts/bundle-runtime.mjs:24-40`：

- 下载 Node tarball 后不验证官方 SHASUM/signature。
- 运行 `npm install @deepseek-ai/dsh@固定版本`，但 resources 下生成的 lockfile 被 gitignore，不参与可复现构建。
- DSH 的大量传递依赖使用 semver range，不同时间打包可能得到不同运行时。

应校验 Node 官方 SHA-256，并将 runtime manifest、lock 和 integrity 作为受控构建输入。

#### 14. 主进程和 Renderer 已出现契约漂移

- `src/main/main.ts` 523 行，同时包含 IPC、窗口、生命周期和约 180 行 smoke driver。
- `renderer.ts` 607 行，以全局脚本维护三个管理系统。
- `plugins.update`、`harness.onFrameLoaded`、`PluginOpHandle.cancel` 都处于“底层存在、UI 不可达”状态。
- `versions` bridge 暴露但无消费者。
- profile `web` 分散硬编码在 main、renderer、HTML 和文档。

建议先抽出共享 IPC contract 和 smoke driver，不需要建立复杂框架。

### P3 — Low

#### 15. PRD/README 已与源码明显失同步

例如：

- PRD 声称深色主题；当前 `src/renderer/index.html:9` 是 `color-scheme: light`。
- README 写 33 个测试；实际为 35。
- PRD 将 Skills 文件导入列为后续工作，当前源码已有，但发布 DMG renderer 尚未包含。
- PRD 顶部写“M0-M5 全部完成”，与缺失功能和 stale release 冲突。

---

## 3. PRD 功能追踪

| PRD 要求 | 当前状态 | 缺口 |
|---|---|---|
| **U1 双击即用、无需环境** | **部分实现** | macOS arm64 Harness 可由 bundled runtime 启动；Plugin 仍需系统 pnpm，常见 `npx` MCP 仍依赖 PATH；DMG 仅 ad-hoc 签名 |
| **U2 Plugin 查看、搜索、安装、移除、更新** | **部分实现** | 列表/安装/移除代码存在；无 npm/GitHub 搜索、无 Update UI、无 cancel/stream、无 `allowBuilds` 向导、无一键重启；状态转换有错误 |
| **U3 粘贴/选择 `.mcp.json`、预览、写入并热生效** | **部分实现** | 粘贴/预览/列表/编辑/删除存在；没有文件选择器，仅支持 `{mcpServers}`；预览与实际写入不一致；导入会全量替换 |
| **U4 浏览、创建、编辑、启停用户级和项目级 skills** | **部分实现** | 用户级列表/创建/visibility/import 存在；没有正文编辑；`main.ts:193` 只传 `dshHome`，项目/custom/bundled roots 没有接入；创建仅支持用户级 |
| **U5 Harness 状态、API Key/模型状态、彻底退出** | **部分实现** | 正常 TERM 退出实测通过；当前 Harness 状态 UI 已丢失；API Key/模型状态没有壳层实现；Harness 异常退出无恢复 |
| **macOS + Windows MVP** | **未完成/PRD 自相矛盾** | Builder 仅 macOS arm64；runtime 脚本在 Windows 会错误选择 Linux tarball；PRD 后文又把 Windows 标为后续 |
| **Settings/profile/update** | **明确延期** | 但 U5 和早期平台故事没有同步降级，应修改验收口径 |
| **暗色 UI** | **未实现** | 当前为浅色主题 |

---

## 4. 验证证据

### 通过

- `npm run verify`：通过。
- `npm test`：35/35。
- `npm run verify:m1`：
  - Harness HTTP 200。
  - 页面 12,296B。
  - 停止后端口关闭。
- Bundled DSH runtime `npm audit`：0 vulnerability。

### 失败或已确认问题

- Root `npm audit`：两个 high severity vulnerable packages。
- ZIP traversal：已复现越界写。
- Bundled Plugin + 最小 PATH：退出码 127，找不到 pnpm。
- MCP preview/write parity：已复现不一致。
- 不存在 patch 的首次写入：已复现 `ENOENT`。
- patch 权限：已复现 `0600 → 0644`。
- Skill visibility toggle：已复现未知 frontmatter 字段丢失。
- 第三方 bundle 停用：已复现“插件未激活”。
- 发布 ASAR 与当前构建：三个核心文件 hash 均不一致。

### 未执行项

没有执行 `npm run smoke:harness`：该命令会覆盖当前已修改的 `artifacts/m1-harness.png`；源码中缺失 `#harness-status` 已能确定其当前断言路径错误。

---

## 5. 修复与迭代计划

### 发布阻断项

1. 修复 ZIP traversal、解压限额和事务安装。
2. 修复 Skills DOM 输出和主进程路径 allowlist。
3. 捆绑 pnpm，统一 runtime PATH。
4. 重做 MCP 单一序列化/事务写入路径。
5. 升级 Electron，并补导航、popup、permission 限制。
6. 修复 Plugin 状态机。
7. 重建、签名、notarize 发布产物，再执行 clean-machine 冒烟。

### 可安全删除或迁出

- 无消费者的 `preload.versions`。
- 将 `src/main/main.ts:270-452` 的 smoke driver 迁出生产主进程。
- 删除过期的 M5/profile 注释和错误测试数量。

### 不应删除，应补齐调用链

- `plugins:update`
- `harness.onFrameLoaded`
- `PluginOpHandle.cancel`

这些都是 PRD 明确要求，不是可删除的死功能。

---

## 6. 建议执行顺序

1. P0 ZIP traversal。
2. Skills DOM/IPC 信任边界。
3. Bundled pnpm/PATH。
4. MCP 写入一致性和文件事务。
5. Plugin 状态机。
6. Electron 升级和窗口安全边界。
7. 补齐 PRD U2-U5，再重建签名发布产物。
8. 最后同步 PRD、README 和验证基线。
