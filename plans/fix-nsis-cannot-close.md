# 排查与修复：Windows 安装包始终报「无法关闭，请手动关闭后重试」

> **状态**：调查完成，待实施（由后续 Agent 按本文档执行，无需重新排查）。
> 本文档 = 根因结论 + 可直接照做的实施规范 + 验证矩阵 + 用户现场诊断附录。

---

## 1. 机制结论（已查实，含模板行号）

报错文案 = electron-builder 26.15.3 NSIS 模板 `messages.yml` 的 `appCannotBeClosed`
（`node_modules/app-builder-lib/templates/nsis/messages.yml:128`，zh_CN：`${PRODUCT_NAME} 无法关闭。\n请手动关闭它，然后单击重试以继续。`）。

**同一文案在 3 个阶段抛出**：

| # | 位置 | 触发条件 | 重试行为 |
|---|------|---------|---------|
| 1 | `templates/nsis/include/allowOnlyOneInstallerInstance.nsh` `_CHECK_APP_RUNNING`（安装开头） | 发现运行中进程 → 优雅杀 → 1s → **强杀** → 2s，两轮后仍有进程存活 | 重试重新查杀，可能成功 |
| 2 | `templates/nsis/include/installUtil.nsh:219` `uninstallOldVersion` | 旧版静默卸载器连续 5 次执行失败 | 重试重跑卸载器 |
| 3 | `templates/nsis/include/extractAppPackage.nsh:116` | 7z 解到 `$PLUGINSDIR` 后 `CopyFiles` 到 `$INSTDIR` 连续 5 次失败（**文件被占用**） | **重试只重新 CopyFiles，不再杀任何进程 → 只要有进程锁文件，重试永远失败** |

安装器查杀逻辑（阶段 1，`allowOnlyOneInstallerInstance.nsh`）：

- **PowerShell 可用时**（`IS_POWERSHELL_AVAILABLE`：`Get-CimInstance` 存在且进程级执行策略非 Restricted）：
  `FIND_PROCESS` 用 `Get-CimInstance Win32_Process` 按 **`$INSTDIR` 路径前缀**匹配所有进程（含捆绑 node.exe 及孙进程）；`KILL_PROCESS` 用 `Stop-Process [-Force]`。注意：**`Stop-Process` 不带 -Force 也是 TerminateProcess 级强杀**，Electron 的 `will-quit` 不会执行。
- **PowerShell 不可用时**（回退）：`tasklist /FI "IMAGENAME eq DSH Desktop Hub.exe" /FI "USERNAME eq %USERNAME%"` —— 两个盲区：
  - 只按**主程序镜像名**匹配，看不到安装目录内的 `node.exe`；
  - `USERNAME eq` 在域账户/微软账户下可能永不命中（tasklist 显示 `域\用户` 格式）。

应用侧事实（`src/main/main.ts`、`src/core/harness.ts`）：

- harness = 捆绑 Node：`$INSTDIR\resources\app\resources\nd\node.exe`（asar:false 布局，`resolveDshExec` `src/core/harness.ts:35`），`spawn` 参数 `detached:true, windowsHide:true`（`harness.ts:157-163`）——**常驻且对用户不可见**，并经 `runtimePathEnv` 派生插件/MCP 孙进程（同目录 node.exe）。
- 正常退出 OK：无托盘、无 close 拦截；`window-all-closed` → `app.quit()` → `will-quit` → `stopTree`（taskkill /T 优雅 → 2s 后 /F，`harness.ts:250`）。启动在途孤儿（旧 P2-7）已由 `startingProc` 追踪修复（`main.ts:745-764`）。
- **剩余洞：主进程被强杀时 `will-quit` 不执行 → node.exe 变孤儿常驻**，恰好锁住安装器要覆盖的 `resources\nd\node.exe`。孤儿来源：任务管理器结束进程、崩溃、上次安装器强杀、异常关机。
- `watchHarness` 的 exit 回调（`main.ts:554`）未检查 `quitting` 标志，关闭竞态下可能立刻 respawn harness（概率性，顺手加固）。
- 应用无开机自启（无 `setLoginItemSettings`），无 electron-updater。

## 2. 候选根因（按与「始终报错、重试无效」的吻合度排序）

1. **孤儿 `node.exe` 锁文件 + 安装器查杀未覆盖它** → 阶段 3 弹窗，重试永远无效。用户「手动关闭 Desktop Hub」无用——孤儿不属于可见应用，任务管理器里只显示为「Node.js」。
2. **应用（或 harness）正以管理员身份运行**：per-user 安装器为中等权限，`Stop-Process`/`taskkill` 全部 Access Denied → 阶段 1 弹窗（NSIS 源码注释原文即 "App likely running with elevated permissions"）。
3. **PowerShell 不可用/Restricted + tasklist `USERNAME eq` 失配** → 阶段 1 漏检 → 阶段 3 锁文件弹窗。
4. 杀进程瞬间 harness 自动重启竞态（`watchHarness` 立即 respawn）——概率性。
5. Defender/AV 锁定刚解压文件——通常瞬态，重试可过，不太符合「始终」。

修复方案按「覆盖全部分支」设计，无需用户先确认具体分支（现场诊断命令见附录 D，可事后回填结论）。

---

## 3. 实施任务

### Task 1：新增 `build/installer.nsh`（自定义 `customCheckAppRunning` 钩子）

**接入机制（已核实）**：electron-builder 在 `NsisTarget.js:600-603` 通过 `packager.getResource(this.options.include, "installer.nsh")` 加载该文件并 `scriptGenerator.include()` 到生成脚本头部（宏定义先于使用）；`templates/nsis/include` 在 makensis include 路径上（`NsisTarget.js:577-578`），故 `!include "getProcessInfo.nsh"` / `"StrFunc.nsh"` 可直接解析。模板一旦检测到 `customCheckAppRunning` 宏已定义（`CHECK_APP_RUNNING` 内 `!ifmacrodef`），默认检查整体跳过。

**陷阱清单（实施前必读）**：

- 定义 `customCheckAppRunning` 后，模板**不再** include `getProcessInfo.nsh`、**不再**声明 `pid` 变量、**不再**执行 `IS_POWERSHELL_AVAILABLE` —— 均需在本文件自行处理（`getProcessInfo.nsh` 有 include guard，重复包含安全）。
- `$CmdPath` / `$PowerShellPath` 由 `CHECK_APP_RUNNING` 在调用本宏前设置（`Var /GLOBAL` + 赋值），可直接复用。
- `${GetProcessInfo} 0 $pid $ppid $priority $name $fullname` 输出顺序：pid → 父 pid → 优先级 → **进程名** → 完整路径。
- NSIS 字符串中 PowerShell 的 `$_` 必须写成 `$$_`（`$$` 是 NSIS 对 `$` 的转义）；`%` 原样写。
- `StrFunc.nsh` 的 `${StrRep}` 需先在**文件作用域**裸写一次 `${StrRep}` 声明函数，之后才能在代码中带参调用。已确认 electron-builder 模板未使用 StrFunc，无重复定义冲突。
- `$(appRunning)` / `$(appClosing)` / `$(appCannotBeClosed)` 均为 electron-builder 生成的 LangString（`messages.yml:47,238,83`），自定义宏中可直接用。
- **绝不可 `taskkill /IM node.exe`**：目标用户是开发者，会误杀系统里其他 Node 进程。杀捆绑 node 必须按 `$INSTDIR` 路径前缀。
- wmic 在 Win11 24H2+ 起被移除 → 仅作 best-effort 兜底，失败无害；WQL `LIKE` 中 `\` 需转义为 `\\`（用 `${StrRep}`），`%` 是多字符通配符。
- 本宏只展开一次（oneClick 安装段），普通标签即可，无需 `${__LINE__}` 唯一化。

**完整草稿代码**（写为 `build/installer.nsh`）：

```nsis
; ============================================================================
; DSH Desktop Hub — 自定义「运行中应用查杀」（electron-builder customCheckAppRunning 钩子）
;
; 修复默认实现 _CHECK_APP_RUNNING 的三个盲区：
;   1) 默认 tasklist 回退用 `USERNAME eq %USERNAME%` 过滤 —— 域账户/微软账户下
;      tasklist 显示 `域\用户`，过滤永不命中 → 查杀双双失效。
;   2) 默认回退只按主程序镜像名查杀，看不到安装目录内捆绑的 node.exe（harness）。
;      主进程被强杀后 node.exe 变孤儿常驻 → 锁住 resources\nd\node.exe →
;      extract 阶段 CopyFiles 连续失败 → 弹「无法关闭」且重试永远无效。
;   3) 每轮「先杀再查」，而非默认实现的弹窗后才重新查杀。
; ============================================================================

!include "getProcessInfo.nsh"   ; 定义 customCheckAppRunning 后模板不再包含它（有 include guard，安全）
!include "StrFunc.nsh"
${StrRep}                        ; 声明 StrRep 函数（必须在使用前于文件作用域出现一次）

Var /GLOBAL DshCheckRound
Var /GLOBAL DshSelfName
Var /GLOBAL DshDummy
Var /GLOBAL DshWmicPath

; ---- 查杀：主程序按镜像名（不带用户名过滤）；安装目录下进程按路径前缀 ----
!macro DSH_KILL_APP_TREE
  ; 主程序：镜像名全局唯一（DSH Desktop Hub.exe），误杀面为零
  nsExec::Exec `"$CmdPath" /C taskkill /F /IM "${APP_EXECUTABLE_FILENAME}"`
  Pop $DshDummy

  ; 安装目录下全部进程（harness 捆绑 node.exe 孤儿、插件/MCP 孙进程）
  ${if} $IsPowerShellAvailable == 0
    nsExec::Exec `"$PowerShellPath" -NoProfile -C "Get-CimInstance -ClassName Win32_Process | ? {$$_.Path -and $$_.Path.StartsWith('$INSTDIR', 'CurrentCultureIgnoreCase')} | % { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
    Pop $DshDummy
  ${else}
    ; 无 PowerShell：wmic 兜底（不存在则失败无害）
    ${StrRep} $DshWmicPath $INSTDIR "\" "\\"
    nsExec::Exec `"$SYSDIR\wbem\wmic.exe" process where "ExecutablePath like '$DshWmicPath%'" call terminate`
    Pop $DshDummy
  ${endif}
!macroend

; ---- 复查：有存活进程返回 0，无则非 0（与默认 FIND_PROCESS 语义一致） ----
!macro DSH_FIND_APP_PROCESS _RESULT
  ${if} $IsPowerShellAvailable == 0
    nsExec::Exec `"$PowerShellPath" -NoProfile -C "if ((Get-CimInstance -ClassName Win32_Process | ? {$$_.Path -and $$_.Path.StartsWith('$INSTDIR', 'CurrentCultureIgnoreCase')}).Count -gt 0) { exit 0 } else { exit 1 }"`
    Pop ${_RESULT}
  ${else}
    ; 无 PS：按镜像名（不带用户名过滤）；node.exe 孤儿依赖 DSH_KILL_APP_TREE 的 wmic 兜底
    nsExec::Exec `"$CmdPath" /C tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\""`
    Pop ${_RESULT}
  ${endif}
!macroend

!macro customCheckAppRunning
  ; 守卫：安装器自身以主程序名运行（自动更新场景）→ 跳过，与默认实现语义一致
  ${GetProcessInfo} 0 $DshDummy $R2 $R3 $DshSelfName $R4
  ${if} $DshSelfName == "${APP_EXECUTABLE_FILENAME}"
    Goto DshCheckAppRunning_done
  ${endif}

  !insertmacro IS_POWERSHELL_AVAILABLE   ; 产出 $IsPowerShellAvailable（0 = 可用）

  ; 全新安装且应用在跑：先按默认语义询问一次；覆盖安装（isUpdated）直接静默查杀
  !insertmacro DSH_FIND_APP_PROCESS $R0
  ${if} $R0 == 0
    ${ifNot} ${isUpdated}
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK DshCheckAppRunning_proceed
      Quit
      DshCheckAppRunning_proceed:
    ${endif}
  ${endif}

  ; 最多 3 轮「杀 → 等 → 查」
  StrCpy $DshCheckRound 0
  DshCheckAppRunning_loop:
    IntOp $DshCheckRound $DshCheckRound + 1

    DetailPrint "$(appClosing)"
    !insertmacro DSH_KILL_APP_TREE
    Sleep 1500

    !insertmacro DSH_FIND_APP_PROCESS $R0
    ${if} $R0 != 0
      Goto DshCheckAppRunning_done   ; 已无存活 → 放行
    ${endif}

    ; 杀不掉：基本是「以管理员身份运行」（权限无法逾越）或进程不可终止
    ${if} $DshCheckRound < 3
      Goto DshCheckAppRunning_loop
    ${endif}
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY DshCheckAppRunning_loop
    Quit
  DshCheckAppRunning_done:
!macroend
```

### Task 2：`electron-builder.yml` 接入

`nsis:` 节加一行（`getResource` 按 buildResources 目录内 basename 解析，`platformPackager.js:582-608`，项目根目录为兜底）：

```yaml
nsis:
  oneClick: true
  perMachine: false
  include: installer.nsh        # ← 新增：build/installer.nsh
  createDesktopShortcut: true
  createStartMenuShortcut: true
  shortcutName: DSH Desktop Hub
  runAfterFinish: true
```

### Task 3：`src/main/main.ts` —— 关闭竞态不再 respawn harness

两处微改（把 `quitting` 声明上移到变量区，并让 `watchHarness` 检查它）：

```ts
// 变量区（约 71 行附近，与 restarting/stoppingHarness 并列）新增：
let quitting = false
// 同时删除文件后部（约 744 行）原有的 `let quitting = false`
```

```ts
// watchHarness（约 554 行）：
proc.on('exit', (code, signal) => {
  // quitting：will-quit 清理期间不再触发自动重启（防关闭竞态 respawn 出孤儿）
  if (restarting || stoppingHarness || autoRestartTimer || quitting) return
```

### Task 4：`src/core/harness.ts` —— Windows 优雅停止窗口 2s → 800ms

`stopTree`（约 250 行）win32 分支的 `setTimeout(..., 2000)` 改为 `800`（POSIX 分支的 2000 保持不变），并加注释：

```ts
// 800ms：安装器非 PowerShell 路径在 WM_CLOSE 后约 1300ms（300+1000）即 /F 强杀主进程；
// 优雅清理须落在该窗口内，否则 stopTree 半途被 TerminateProcess → node.exe 孤儿
```

---

## 4. 构建与验证

构建（与 CI `.github/workflows/release.yml:110` 一致；本仓库已在 macOS 上成功交叉构建 NSIS，`release/` 有先例产物）：

```bash
npm run build
npx electron-builder --win nsis --x64 --publish never
```

makensis 编译期即校验 NSIS 语法（宏/标签/变量错误会直接构建失败），这是第一道验证。
`npm run typecheck && npm test` 验证 TS 改动。

**Windows 实机验证矩阵**：

| 场景 | 预期 |
|------|------|
| 应用未运行，直接安装 | 通过（现状应已如此） |
| 应用运行中安装 | 新安装器自动关闭并通过 |
| 制造孤儿：`taskkill /F /IM "DSH Desktop Hub.exe"`（harness 运行中）→ 安装 | 新安装器清掉孤儿并通过；**旧安装器应复现「始终报错」**（反向验证根因 1） |
| 应用以管理员身份运行中安装 | 弹「无法关闭」但重试指引正确（权限无法逾越，属预期行为） |
| PowerShell 受限机器（`Set-ExecutionPolicy Restricted` 或域控机） | 镜像名兜底杀主程序 + wmic 杀目录进程，通过 |
| 回归：`npm run verify`、smoke、正常退出后任务管理器无 node.exe 残留 | 不回归 |

---

## 附录

### A. 关键源码索引

| 内容 | 位置 |
|------|------|
| 报错文案（zh_CN） | `node_modules/app-builder-lib/templates/nsis/messages.yml:128` |
| 默认查杀宏 | `.../templates/nsis/include/allowOnlyOneInstallerInstance.nsh`（`CHECK_APP_RUNNING`/`FIND_PROCESS`/`KILL_PROCESS`/`_CHECK_APP_RUNNING`） |
| 弹窗点 ② 卸载旧版 | `.../templates/nsis/include/installUtil.nsh:219` |
| 弹窗点 ③ 解压 | `.../templates/nsis/include/extractAppPackage.nsh:116` |
| 查杀调用点 | `.../templates/nsis/installSection.nsh:33` |
| 自定义 include 加载 | `node_modules/app-builder-lib/out/targets/nsis/NsisTarget.js:600-603` |
| include 路径解析 | `node_modules/app-builder-lib/out/platformPackager.js:582-608` |
| harness 启动/停止 | `src/core/harness.ts:144`（startHarness）、`:250`（stopTree） |
| 退出清理 | `src/main/main.ts:740-764`（window-all-closed / will-quit） |
| harness 看门狗 | `src/main/main.ts:553-568`（watchHarness） |

### B. 用户侧即时 workaround（旧安装包用户，写进答复/文档）

```bat
taskkill /F /IM "DSH Desktop Hub.exe"
:: 清理孤儿 node.exe（只杀安装目录下的，不误杀其他 Node 进程）
powershell -NoProfile -C "Get-CimInstance Win32_Process | ? {$_.Path -like \"$env:LOCALAPPDATA\Programs\DSH Desktop Hub*\"} | % { Stop-Process -Id $_.ProcessId -Force }"
```

并检查：快捷方式属性 → 兼容性 → 不要勾「以管理员身份运行此程序」。

### C. 安装器日志（开发者调试用）

`ENABLE_LOGGING_ELECTRON_BUILDER` 是**构建期** define（`NsisTarget.js:174`，需 `customNsisBinary.debugLogging`），终端用户无法运行时开启；现场诊断走附录 D 的手动命令。

### D. 现场诊断（定位用户机器落在哪个根因分支）

报错弹窗**保持开着**时，用普通（非管理员）PowerShell 执行：

```powershell
# 1) 谁占着安装目录？有输出 = 根因 1/2（看是主程序还是 node.exe 孤儿）
Get-CimInstance Win32_Process | ? {$_.Path -like "$env:LOCALAPPDATA\Programs\DSH Desktop Hub*"} | Select ProcessId, Name, Path
# 2) 尝试杀掉：Access Denied = 进程以管理员运行（根因 2）
# 3) 命令本身报错/异常 = PowerShell/CIM 不可用（根因 3）
```

## Steps 状态

- [x] 1. 根因定位（代码级机制分析完成；现场诊断留给用户，修复覆盖全部分支）
- [x] 2. 编写 `build/installer.nsh` + 接入 `electron-builder.yml`（Task 1/2）
- [x] 3. main.ts / harness.ts 两处加固（Task 3/4）
- [x] 4. 本地构建安装包 + NSIS 编译校验（typecheck ✓、build ✓、makensis ✓、54/54 测试 ✓）
      
      验证证据：
      - `release/builder-debug.yml:101` 生成脚本含 `!include ".../build/installer.nsh"`（226 行 installSection.nsh 之前）
      - `release/win-unpacked/resources/app/dist/main/main.js` 含 quitting 防护（will-quit 清理期间不 respawn）
      - `release/win-unpacked/resources/app/dist/core/harness.js` 含 800ms 优雅窗口
      - 产物：`release/DSH-Desktop-Hub-0.1.0-x64.exe`（162MB）
- [x] 5. Windows 实机验证（192.168.0.139，用户确认「安装到使用链路正常」）
      - 场景 B（应用 5 实例 + node 运行中）：新安装器 /S 退出码 0，270s，全部进程清理干净
      - 用户自零状态测试通过：从清理后的基线安装 → 使用链路正常
      - 验证中确认：应用安装目录为 `Programs\dsh-desktop-hub`（APP_FILENAME 取自 package.json name）；
        新布局最深路径 62+170=232 字符 < 260（旧布局残留含 >260 路径，删除需 \\?\ 前缀）

**实施偏离记录**：Task 1 草案中的 wmic 路径转义从 `${StrRep}`（StrFunc.nsh）改为目录名子串 `LIKE '%DSH Desktop Hub%'`——产品目录名不含反斜杠，可直接命中且不引入额外的 NSIS 函数库，编译验证通过；覆盖范围不变（PS 路径仍按 `$INSTDIR` 前缀，无 PS 时 wmic 按目录子串，wmic 不存在则失败无害）。
