# 首次访问引导（Onboarding Wizard）计划

## Context

DSH Desktop Hub 是一个多 Tab 桌面管理控制台（Harness / 插件 / MCP / Skills / 反馈），新用户首次打开时不了解各功能区。目标：首次访问时弹出分步引导，用户「下一步、下一步」跟着提示自行完成交互式操作，降低上手成本。

## Confirmed product decisions

- 形态采用 **Spotlight 聚焦引导**：半透明遮罩挖洞高亮真实 UI 元素 + 定位气泡说明。
- 步骤覆盖：欢迎 → Harness 主界面 → 连接状态徽章 → **Harness 全屏**（用户追加）→ 插件市场 → MCP → Skills → 反馈与社区 → 检查更新 → 完成。
- 每步看完说明手动「下一步」前进，不强制用户完成对应操作才放行；随时可「跳过引导」。
- 侧边栏新增「使用引导」按钮，老用户可随时重看。
- 「首次」判定用 localStorage 标记；纯渲染层实现，主进程零改动。

## Initial findings

- 渲染层为 `src/renderer/index.html`（全部内联 CSS）+ `src/renderer/renderer.ts`（非模块脚本）。
- Tab 切换复用现成的 `switchTab(id)`（renderer.ts L261）；全屏切换复用 `setHarnessFullscreen(active)`（L254）。
- 现有最高 z-index 为 10，引导层用 z-index 100 即可压住全部 UI。
- 全项目尚未使用 localStorage；CSP `default-src 'self'` 下可直接使用（仍 try/catch 兜底）。
- Escape 键已有全局监听（关闭全屏与 harness 菜单），引导关闭并入同一 handler。
- 渲染层无自动化测试，验证以 typecheck + 手动走查为主。

## Approach

在渲染层新增一个自包含的 onboarding 模块：

- 遮罩层 `#onboarding` 固定全屏（z-index 100），背景半透明；用 CSS `mask` 双层合成（`mask-composite: exclude`）在目标元素位置挖出透明洞——洞内可真实点击交互，洞外遮罩拦截误触。洞的位置/尺寸通过 inline 自定义属性注入。
- 气泡卡片 `#onboarding-card` 绝对定位：优先目标右侧 → 下方 → 上方 → 左侧，clamp 在视口内。欢迎页与完成页无目标时卡片居中显示。
- 步骤定义为 `{ title, body, target?, tab?, prepare? }` 数组：`tab` 先调 `switchTab` 切到对应工作区再测量定位；更新一步先退出 Harness 全屏（`prepare` 钩子）。切 Tab 后用 rAF 延迟一帧测量，避免拿到隐藏面板的零矩形。
- 完成或跳过均写入 `dsh.onboarding.done.v1 = 1`；启动时未标记则自动开始。窗口 resize 时重算洞与气泡位置。
- 侧边栏 `.sidebar-help` 区块放「使用引导」按钮，点击清除标记并重新开始。

## Files to modify

- `src/renderer/index.html` — 引导层 DOM、样式、侧栏「使用引导」入口
- `src/renderer/renderer.ts` — 步骤定义、spotlight 定位状态机、localStorage 判定、Escape 关闭

## Steps

- [x] index.html：新增 `#onboarding` 遮罩/气泡 DOM 与 CSS（含 mask 挖洞、气泡定位、居中模式）
- [x] index.html：侧边栏新增 `.sidebar-help`「使用引导」按钮（窄屏媒体查询同步隐藏）
- [x] renderer.ts：步骤数组（10 步文案）+ 开始/结束/渲染步骤/定位逻辑
- [x] renderer.ts：首次启动判定 + replay 按钮 + resize 重定位 + Escape 关闭
- [x] typecheck + build + 手动全流程走查

## Code review fixes（2026-08-22 二轮）

- Esc 语义修正：全屏/状态弹层优先恢复，再按 Esc 才退出引导（修复第 4 步文案自相矛盾导致引导被永久关闭）
- resize 只调 `placeOnboardingCard` 重定位，不再重跑 prepare/switchTab/诊断 IPC
- 第 2-4 步补 `tab: 'harness'`，从其他 Tab 重放时 spotlight 不再回退居中卡
- `.sidebar-update` / `.sidebar-help` 共享选择器去重复；`#onboarding-spot` 几何改由 `--spot-*` 变量驱动与挖洞同源；删除不可达分支；步骤内 DOM 引用改为模块级缓存
- 未修：≤900px 窄窗下 `#app-update` 隐藏时第 9 步降级为居中卡片（设计内降级，文案仍可用）

## Verification

- [x] `npm run typecheck`、`npm run build`（99 个测试全部通过）
- [x] computer-use 实测走查：首次启动自动弹欢迎页 → 逐步走完 10 步，每步 spotlight 对准目标、切 Tab 正确（第 5-8 步自动切插件/MCP/Skills/反馈）
- [x] 点击侧栏「使用引导」可重看；Escape 可中途退出；「跳过引导」可用；完成或跳过后重启应用不再自动弹出
