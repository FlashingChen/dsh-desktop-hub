# Issue #35 — 启动太慢 + 「自动更新好像坏了」反馈处理

Issue: https://github.com/FlashingChen/dsh-desktop-hub/issues/35
用户环境：0.3.5 · win32/x64 · profile web，反馈「每次启动都要将近两分钟」「自动更新插件好像坏了」，诊断显示 Harness state=starting。

## 排查结论（2026-08-24 实测）

### 启动慢

- 壳层自身启动路径（Electron ready → 窗口先行）无同步网络/磁盘瓶颈；更新检查在 ready 后 8s 异步执行，不阻塞。
- 捆绑运行时（`resources/rt`，532 包 / 195 个 @deepseek-ai 包）在本机 `dsh web` 冷启动 **< 1s**：
  - 首次输出 ~670ms，HTTP 200 ~720ms（macOS arm64，node 24.10.0，rc.6）。
  - 结论：慢不在壳层代码、也不在 dsh 本身，而是 Windows 用户机器上的环境因素 ——
    最可能是 Defender/杀毒软件对 500+ 新 JS 文件与 node.exe 的逐文件扫描（每次版本更新后重新触发）。
- 现有 UI 文案「首次运行或需 1-2 分钟」反而把异常慢当成了常态，掩盖了问题。

### 自动更新

- v0.3.5 是当时最新 Release：updater 正确返回 not-available，用户感知的「坏了」无对应 bug。
- latest.yml / exe / blockmap 资产齐全，electron-updater 元数据正确。
- 改进空间：检查失败时只显示裸错误文本（如 GitHub 不可达的超时），看起来像「坏了」。

## 改动（全部落地）

1. **启动耗时度量**（src/main/main.ts）
   - `startHarnessAndWatch` 记录 spawn→就绪耗时，日志输出 `harness: 就绪 …（启动耗时 X.Xs）`。
   - 超过 45s 视为慢启动，日志给出可操作建议（杀毒软件排除安装目录）。
2. **诊断块新增低敏字段**（src/core/diagnostics.ts）
   - `Harness last startup`（上次启动耗时，秒）与 `App update state`（更新状态枚举），
     下次同类反馈可直接看到「到底多慢」「更新卡在哪个状态」。
3. **等待秒表**（src/renderer/renderer.ts）
   - 连接中/重启中每秒刷新「已等待 N 秒」；>45s 追加杀毒软件扫描提示。
   - 移除「首次需 1-2 分钟」的错误暗示（引导文案同步修正）；状态时间戳经 `HarnessStatus.since` 下发。
4. **更新错误可读性**（renderer）：网络类错误追加代理/手动下载提示，避免被误读为插件坏了。

## 验证

- [x] `npm run verify`（typecheck + build + 100 tests 全过，含新增诊断字段测试）
- [x] `--smoke` / `--harness-smoke` 端到端通过（本机实测 harness 就绪 0.8s）
- [x] 打包应用占用单实例锁时开发实例会静默退出 —— 已知坑：smoke 验证需隔离 HOME

## 后续（未在本次处理）

- 若后续反馈诊断块显示启动确实 >45s，可考虑：安装器申请 Defender 排除目录、
  runtime 更新后预热、或 dsh 侧冷启动优化。
