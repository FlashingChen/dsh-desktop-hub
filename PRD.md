# DSH-Orbit PRD v0.1

## 1. 定位

DSH-Orbit 是 DeepSeek Harness 的桌面管理工具，用于图形化管理 DSH 的：

- Plugins
- Skills
- MCP Servers
- Profiles
- Runtime / Configuration

不重新实现 DSH Agent、Chat UI 或 Agent Loop。

优先复用官方 DSH CLI、配置文件和运行时。

---

## 2. 技术要求

桌面端，优先支持：

- macOS
- Windows

建议使用 Electron + TypeScript。

应用启动时自动检测：

- DSH 是否安装
- DSH 版本
- `~/.dsh`
- Profiles
- 当前 Profile
- DSH Runtime 状态

所有配置修改必须：

```text
Read
→ Parse
→ Backup
→ Modify
→ Validate
→ Atomic Write
→ Health Check
```

配置修改失败时不得破坏原配置。

---

## 3. 页面结构

```text
Overview
Plugins
Skills
MCP
Profiles
Doctor
Settings
```

---

## 4. Overview

显示：

- DSH 版本
- 当前 Profile
- Runtime 状态
- Plugin 数量
- Skill 数量
- MCP 数量
- 当前错误 / Warning

快捷操作：

- Add MCP
- Install Skill
- Install Plugin
- Run Doctor
- Open DSH

---

## 5. MCP Manager

### 列表

显示所有 MCP：

- Name
- Enabled / Disabled
- Transport
- Connection Status
- Tool Count
- Error

支持：

- Add
- Edit
- Delete
- Enable / Disable
- Test Connection
- View Tools

### 添加 MCP

支持两种方式。

#### JSON Import

允许直接粘贴常见格式：

```json
{
  "mcpServers": {
    "example": {
      "url": "...",
      "headers": {}
    }
  }
}
```

自动：

```text
Parse
→ Convert to DSH config
→ Preview
→ Backup
→ Write
→ Validate
→ Test
```

#### Manual Form

支持：

- Name
- Transport
- URL
- Command
- Arguments
- Environment Variables
- Headers

根据 Transport 动态显示字段。

### 安全

每次修改 MCP 前创建 Snapshot。

如果修改后 DSH 无法启动：

```text
Configuration caused DSH startup failure.

[Rollback]
[View Logs]
```

---

## 6. Skills Manager

自动扫描 DSH 支持的 Skill 路径。

每个 Skill 显示：

- Name
- Description
- Scope
- Path
- Enabled
- Effective / Shadowed

需要识别同名 Skill 的优先级，并显示最终实际生效的是哪个。

支持：

- 查看 [`SKILL.md`](http://SKILL.md)
- Install from GitHub
- Install from Local Folder
- Delete
- Enable / Disable
- Open Folder

安装时允许选择：

```text
Global / User
Profile
Workspace
```

具体 Scope 必须以当前 DSH 实际支持的规则为准，不允许硬编码猜测。

---

## 7. Plugin Manager

显示：

- Plugin Name
- Version
- Source
- Profile
- Enabled
- Update Available

支持：

- Install
- Remove
- Update
- Update All
- Enable / Disable

优先调用官方：

```bash
dsh plugin ...
```

不要自行实现 Plugin 包管理逻辑。

---

## 8. Plugin Marketplace

v0.1 做基础版本。

支持：

- 浏览
- 搜索
- 查看详情
- 一键安装

Registry 层必须抽象：

```ts
interface PluginRegistry {
  search(query: string): Promise<Plugin[]>
  get(id: string): Promise<Plugin>
}
```

方便后续接不同社区 Plugin Registry。

市场数据和实际 Plugin 安装逻辑必须解耦。

---

## 9. Profiles

显示所有 Profile：

- Name
- Active
- Path
- Plugin Count
- MCP Count
- Skill Count

支持：

- Switch Profile
- Open Folder
- Refresh

所有 Plugin / MCP 操作必须明确当前修改的是哪个 Profile。

---

## 10. Doctor

执行完整环境检查：

```text
DSH
Runtime
Profile
Model Config
Plugins
Skills
MCP
Config Syntax
Filesystem
```

每项返回：

```ts
type CheckResult = {
  status: "ok" | "warning" | "error"
  title: string
  message: string
  details?: string
}
```

能够识别：

- DSH 未安装
- DSH 启动失败
- 配置文件语法错误
- Plugin 加载失败
- Skill 冲突 / Shadowed
- MCP 连接失败
- Profile 不存在

提供 Logs / Technical Details。

---

## 11. Snapshot / Rollback

保存最近配置修改记录：

```text
Timestamp
Action
Target
Profile
Backup
```

例如：

```text
12:30
Added MCP: baota-mcp
Profile: web
```

支持一键 Restore。

至少保留最近 10 次。

---

## 12. 非目标

v0.1 不实现：

- 自定义 Chat UI
- Agent Loop
- 多 Agent Orchestration
- 云同步
- 用户账号
- 手机端
- IM Channels
- 自建 Plugin Backend
- 自建 MCP Registry
- 修改 / Fork DSH Core

---

## 13. MVP 完成标准

以下流程全部跑通才算 v0.1：

```text
启动 DSH-Orbit
→ 自动识别本机 DSH
→ 识别 Profiles

粘贴一个 mcpServers JSON
→ 自动转换
→ 安装
→ Test 成功
→ DSH 可正常调用

安装一个 GitHub Skill
→ 正确识别
→ 显示 Scope
→ DSH 可以读取

安装一个 Plugin
→ Plugin 正常加载

修改错误配置
→ Doctor 能发现
→ Rollback 能恢复

关闭并重新启动 DSH-Orbit
→ 所有状态仍正确
```

**第一阶段开发顺序：MCP → Skills → Plugins → Profiles → Doctor → Marketplace。**