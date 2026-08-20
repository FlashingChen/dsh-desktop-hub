# Issue #18：安装程序支持选择安装位置

## Context
- GitHub Issue #18（开放）：当前打开 Windows 安装程序后直接按默认路径安装到 C 盘，用户希望在安装过程中选择安装位置。
- 用户已确认范围：只处理 Windows NSIS 安装包；同时保留升级安装和静默安装能力。
- 根因已定位：`electron-builder.yml` 当前配置 `nsis.oneClick: true`，安装器走一键安装流程，不展示向导或目录选择页。
- 现有配置和文档明确产品采用 per-user、免管理员安装。直接把 `oneClick` 改为 assisted 后，`perMachine: false` 默认会出现“当前用户/所有用户”安装模式页，因此需要同时用现有 `build/installer.nsh` 的 `customInstallMode` hook 强制当前用户模式。

## Approach
- 将 NSIS 切换为 assisted 向导模式，并显式设置 `allowToChangeInstallationDirectory: true`，启用目录选择页。
- 保持 `perMachine: false`，在 `build/installer.nsh` 增加条件式 `customInstallMode`：仅在没有既有 per-user/per-machine 注册信息的新安装中强制当前用户模式；已有 machine 安装或显式模式参数交给 electron-builder 模板处理，避免升级/卸载分叉。
- 保留现有快捷方式、安装后启动、`include: installer.nsh` 和进程清理宏。electron-builder 的 assisted 安装分支仍会调用通用 `CHECK_APP_RUNNING`，无需重写现有进程处理逻辑。

## Files to modify
- `electron-builder.yml`：将 `oneClick` 改为 `false`，新增 `allowToChangeInstallationDirectory: true`，更新 Windows/NSIS 注释。
- `build/installer.nsh`：增加 `customInstallMode` 宏，强制当前用户安装；保留现有 `customCheckAppRunning` 实现。
- `README.md`：把 Windows 打包说明从 one-click 更新为 assisted、per-user、可选择安装目录。
- `tests/installer-config.test.mjs`：新增安装器配置契约测试，防止目录选择或 per-user 约束回退。

## Reuse
- `build/installer.nsh`：复用现有 `customCheckAppRunning`、`DSH_KILL_APP_TREE` 和 `DSH_FIND_APP_PROCESS`；新增的 `customInstallMode` 使用 electron-builder MultiUser 模板提供的变量，不改变查杀范围。
- `plans/windows-port.md`：已有 Windows NSIS、per-user、可选安装目录的目标定义，以及 `npx electron-builder --win nsis --x64 --publish never` 构建命令。
- `plans/fix-nsis-cannot-close.md`：复用其 NSIS 编译校验和 Windows 实机验证思路，尤其检查运行中应用/升级安装不回归。
- 现有 `tests/*.mjs` 的 Node test + `node:fs` + `node:assert/strict` 约定；使用项目已有 `yaml` 依赖解析 `electron-builder.yml`。

## Steps
- [x] 在 `electron-builder.yml` 将 `nsis.oneClick` 设为 `false`，设置 `nsis.allowToChangeInstallationDirectory` 为 `true`；保留 `perMachine: false`、`include: installer.nsh` 及现有快捷方式配置。
- [x] 在 `build/installer.nsh` 增加：
  ```nsis
  !macro customInstallMode
    ${if} $hasPerMachineInstallation == "0"
    ${andIf} $hasPerUserInstallation == "0"
      StrCpy $isForceCurrentInstall "1"
    ${endIf}
  !macroend
  ```
  确保新 assisted 安装默认只有目录选择，同时让已有 machine 安装的升级/卸载保留模板的安装范围判断。
- [x] 更新 `README.md` 的 Windows 安装器描述，明确安装时可选择目录，避免文档继续声称 one-click。
- [x] 新增配置契约测试，断言 assisted 模式、允许修改安装目录、保持 per-user、继续包含 `installer.nsh`，并断言 `customInstallMode` 只对全新安装强制当前用户模式。
- [x] 运行构建，确认 NSIS 脚本可编译、目录页被生成，且现有 `customCheckAppRunning` 在 assisted/升级流程中仍被调用。
- [x] 在 `flashingchen@192.168.0.139` 完成 Windows 实机验证：交互向导显示目录页并可打开 Browse，使用自定义目录完成安装；文件、桌面/开始菜单快捷方式、注册表安装位置和 Finish 启动链路一致；另验证 `/S /D=...` 静默自定义目录安装，以及应用运行中的无 `/D` 静默升级（均退出码 0 且保留自定义目录）；已清理测试产物。

## Verification
- 自动检查：`npm run typecheck`、`npm test`、`npm run verify`。
- Windows 构建：`npx electron-builder --win nsis --x64 --publish never`；以 NSIS 编译成功作为安装器语法/配置门禁。
- 手工矩阵：
  - 全新安装显示安装向导和目录选择页，选择自定义非默认目录后文件、快捷方式和启动位置一致。
  - 安装向导不显示 per-user/per-machine 选择，且普通用户可完成安装，不要求管理员权限。
  - 不修改目录时仍使用当前 per-user 默认目录。
  - 在旧版本已安装于自定义目录的情况下升级，不强制迁回 C 盘，应用可正常启动。
  - 执行 `安装程序.exe /S` 时不弹向导，静默安装仍能完成。
  - 安装/升级时应用正在运行，现有 `build/installer.nsh` 进程处理逻辑仍能放行，不出现“无法关闭”回归。

## Decision
- 已确认：Windows NSIS only；保留升级安装、静默安装和现有 per-user/免管理员行为。
