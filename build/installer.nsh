; ============================================================================
; DSH Desktop Hub — 自定义「运行中应用查杀」（electron-builder customCheckAppRunning 钩子）
;
; 修复默认实现 _CHECK_APP_RUNNING（allowOnlyOneInstallerInstance.nsh）的三个盲区：
;   1) 默认 tasklist 回退用 `USERNAME eq %USERNAME%` 过滤 —— 域账户/微软账户下
;      tasklist 显示 `域\用户` 格式，过滤永不命中 → 查杀双双失效。
;      本实现按镜像名杀主程序时不带用户名过滤（镜像名全局唯一，误杀面为零）。
;   2) 默认回退只按主程序镜像名查杀，看不到安装目录内捆绑的 node.exe（harness）。
;      主进程被强杀（任务管理器/崩溃/上次安装器强杀）后 node.exe 变孤儿常驻，
;      锁住 resources\nd\node.exe → extract 阶段 CopyFiles 连续失败 → 弹
;      「无法关闭」且重试永远无效（extract 阶段重试不会重新杀进程）。
;      本实现按 $INSTDIR 路径前缀杀全部进程（有 PowerShell 时），无 PS 时用
;      wmic 按目录名子串杀（产品目录名唯一，安全；wmic 在 Win11 24H2+ 可能
;      被移除，失败无害）。
;   3) 每轮「先杀再查」，而非默认实现的弹窗后才重新查杀。
;
; 接入：electron-builder.yml → nsis.include: installer.nsh（本文件位于 build/ 下，
;       getResource 按 buildResources 目录内 basename 解析，platformPackager.js:582）
; ============================================================================

!include "getProcessInfo.nsh"   ; 定义 customCheckAppRunning 后模板不再包含它（有 include guard，安全）

Var /GLOBAL DshCheckRound
Var /GLOBAL DshSelfName
Var /GLOBAL DshDummy

; ---- 查杀：主程序按镜像名（不带用户名过滤）；安装目录下进程按路径前缀 ----
!macro DSH_KILL_APP_TREE
  ; 主程序：镜像名全局唯一（DSH Desktop Hub.exe），误杀面为零
  nsExec::Exec `"$CmdPath" /C taskkill /F /IM "${APP_EXECUTABLE_FILENAME}"`
  Pop $DshDummy

  ; 安装目录下全部进程（harness 捆绑 node.exe 孤儿、插件/MCP 孙进程）。
  ; 绝不按 `node.exe` 镜像名杀 —— 目标用户是开发者，会误杀系统里其他 Node 进程。
  ${if} $IsPowerShellAvailable == 0
    nsExec::Exec `"$PowerShellPath" -NoProfile -C "Get-CimInstance -ClassName Win32_Process | ? {$$_.Path -and $$_.Path.StartsWith('$INSTDIR', 'CurrentCultureIgnoreCase')} | % { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
    Pop $DshDummy
  ${else}
    ; 无 PowerShell：wmic 兜底（wmic 不存在则失败无害）。
    ; WQL LIKE 按目录名子串匹配（产品目录名唯一；wmic 直接调用，不经 cmd，避免 % 变量展开干扰）。
    nsExec::Exec `"$SYSDIR\wbem\wmic.exe" process where "ExecutablePath like '%${PRODUCT_NAME}%'" call terminate`
    Pop $DshDummy
  ${endif}
!macroend

; ---- 复查：仍有存活进程返回 0，无则非 0（与默认 FIND_PROCESS 语义一致） ----
!macro DSH_FIND_APP_PROCESS _RESULT
  ${if} $IsPowerShellAvailable == 0
    nsExec::Exec `"$PowerShellPath" -NoProfile -C "if ((Get-CimInstance -ClassName Win32_Process | ? {$$_.Path -and $$_.Path.StartsWith('$INSTDIR', 'CurrentCultureIgnoreCase')}).Count -gt 0) { exit 0 } else { exit 1 }"`
    Pop ${_RESULT}
  ${else}
    ; 无 PS：按镜像名查（不带用户名过滤）；node.exe 孤儿依赖 DSH_KILL_APP_TREE 的 wmic 兜底
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

  !insertmacro IS_POWERSHELL_AVAILABLE   ; 产出 $IsPowerShellAvailable（0 = 可用；$CmdPath/$PowerShellPath 已由 CHECK_APP_RUNNING 设置）

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

    ; 杀不掉：基本是「以管理员身份运行」（权限无法逾越）或进程处于不可终止状态
    ${if} $DshCheckRound < 3
      Goto DshCheckAppRunning_loop
    ${endif}
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY DshCheckAppRunning_loop
    Quit
  DshCheckAppRunning_done:
!macroend