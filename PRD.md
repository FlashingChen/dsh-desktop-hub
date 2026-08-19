# DSH Desktop Hub — 产品需求文档（PRD）

> 状态：**已实现（审计修复完成）**（§2 调研结论为实施依据；M0-M6 已按 plan.md 全部落地并通过验证，见 §5；AUDIT_REPORT.md 的 P0-P3 全部修复）
> 版本：v0.1 · 日期：2026-08-16
> 应用名：**DSH Desktop Hub**（已定名并落实，规避社区 `dsh-desktop` / `dsh_desktop` 撞名）

---

## 0. 原始需求（未改动）

> 我要构建一个应用，应用名称可以后续再定，核心功能如下：
>
> DSH 最近发布，其理念是一切皆插件，因此我们需要构建一个桌面端，在桌面端内集成所有功能，用户无需安装 Node、CS 等运行环境，双击打开桌面端即可进入 DSH harness。
>
> 同时采用多 Tab 理念设计，规划几个系统：
> 1. **插件系统（Plugin）**：负责管理、安装和移除本机 DSH 的所有插件；
> 2. **MCP 系统**：将普通 JSON 格式转换为 DeepSeek 所需的 YAML 格式；
> 3. **Skills 系统**：负责管理 DeepSeek 可用的 skills；
> 4. 第四个系统暂不做，目前只保留以上几个系统。
>
> 整体流程：写入 PRD 供审核 → 审核通过后自行制定 plan，按 MVP 拆分，每次只做一件事，以最小可验证的方式推进，自行测试。

---

## 1. 背景

### 1.1 DSH 是什么

**DSH = DeepSeek Harness**，DeepSeek AI 开源的 agent harness（[github.com/deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)，MIT，118k+ stars）。核心理念 **"Everything is a Plugin"**：模型、工具、Agent Loop、文件系统、会话、UI、MCP、skills、权限、持久化等一切能力都以 Cordis 插件形式组合，核心保持极薄。

关键事实：

| 项 | 值 |
|---|---|
| 当前版本 | repo main `0.1.0-rc.5`；**npm latest `0.1.0-rc.6`**（2026-08-16 实测；developer preview，官方声明会有破坏性变更） |
| 底层框架 | [Cordis](https://github.com/cordiverse/cordis)（时空可组合的插件框架） |
| 运行时依赖 | Node.js `^22.19.0 \|\| >=24.0.0` + pnpm `11.7.0` |
| npm 包 | `@deepseek-ai/dsh`（bin: `dsh`） |
| 启动方式 | `npx @deepseek-ai/dsh web` → 本地 Web UI `http://127.0.0.1:3080` |
| 语言 | TypeScript |

**当前的使用门槛**正是用户要解决的痛点：必须自己安装 Node.js（+ pnpm），再执行命令启动；没有开箱即用的桌面入口。

### 1.2 生态现状（调研对象）

| 项目 | Stars | 定位 | 与本项目关系 |
|---|---|---|---|
| [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | 118k | 官方 DSH 本体（web/CLI） | 被封装的上游 |
| [anywhere-labs/deepseek-harness-desktop](https://github.com/anywhere-labs/deepseek-harness-desktop) | 6.6k | Electron 桌面壳 + `desktopPnpm`/`desktopProfiles` 服务；**插件市场「即将推出」** | 最强参考；其插件管理走 CLI 语义，无管理台 UI |
| [myYangyunfan/dsh_desktop](https://github.com/myYangyunfan/dsh_desktop) | 304 | Windows 专用 Electron 壳，内置 node.exe + `@deepseek-ai/dsh`，有简单插件市场（npm/github） | 参考；Windows-only、封装而非管理系统 |
| [mcporter](https://github.com/openclaw/mcporter) | — | 第三方 MCP 配置管理工具，支持 `mcporter config import claude-code` | 验证了「JSON MCP 配置 → 目标格式」转换的行业惯例 |

**差异化结论**：现有桌面端都只做「封装启动」，没有任何产品提供用户要求的三个管理系统的 UI 化整合（Plugin 管理台 / MCP JSON→YAML 转换器 / Skills 管理器）。本项目的定位是 **DSH 桌面管理控制台 + 内置 harness**，并进一步提供三类扩展市场。

---

## 2. 调研结论（技术事实，均出自官方源码/文档）

> 本节所有事实来自官方仓库本地 checkout（`deepseek-harness` @ `0.1.0-rc.5`）与参考实现仓库，引用路径即证据位置。

### 2.1 用户数据与配置目录（`$DSH_HOME`）

所有用户数据位于 `$DSH_HOME`（默认 `~/.dsh`）：

| 路径 | 内容 |
|---|---|
| `$DSH_HOME/profiles/<name>/` | profile 目录：`package.json`（声明 `dsh.profile.bundles` 有序列表）+ `cordis.patch.yml`（该 profile 的用户 patch 层） |
| `$DSH_HOME/profiles/node_modules` | dsh 为应用/组合包依赖维护的符号链接后备目录，每次启动自动修复 |
| `$DSH_HOME/cordis.patch.yml` | home 级用户 patch（各 profile 共享的机器本地偏好） |
| `$DSH_HOME/.credentials.yaml` | 各 provider 的 API 密钥（**只写**，UI 只拿脱敏描述符） |
| `$DSH_HOME/settings.yaml` | provider/model 等设置 |
| `$DSH_HOME/.env` | 启动环境层（与调用目录 `.env` 并列） |
| `$DSH_HOME/skills/` | 用户级 skills（rank 400，见 2.2） |
| `$DSH_HOME/sessions`、`$DSH_HOME/storages` | 会话与存储（profile 间共享） |

workspace 根 = **启动 `dsh` 命令时的目录**；该目录下的 `.dsh/skills`、`.agents/skills`、`AGENTS.md`/`CLAUDE.md`（65,536 字节预算加载）都会进入 agent 上下文。

### 2.2 DSH harness 如何检测 skills（核心调研项①）

实现于 `packages/skill/`（`ctx.skills` 注册表 + 本地 provider + 模型侧 tool）。

**检测机制 = 多 provider 合并的注册表，按 rank 扫描目录：**

| Rank | Source | 根目录 |
|---|---|---|
| 100 | `project-dsh` | `<projectRoot>/.dsh/skills` |
| 200 | `project-agents` | `<projectRoot>/.agents/skills` |
| 300 | `custom` | `Config.customSkillDirs` |
| 400 | `user-dsh` | `<dshHome>/skills` |
| 500 | `user-agents` | `<agentsHome>/skills` |
| 600 | `bundled` | `Config.bundledSkillDir`（默认取 `$DSH_BUNDLED_SKILL_DIR` 环境变量） |

- 项目根 = 向上找最近含 `.git` 的祖先目录；找不到则用 cwd。
- **skill 身份**：kebab-case 名称（`^[a-z0-9]+(?:-[a-z0-9]+)*$`）。两种形态：目录包 `<name>/SKILL.md` 或扁平文件 `<name>.md`。
- **frontmatter 元数据**：`name`、`description`、可选 `disable-model-invocation`、`user-invocable`（缺省均视为 true）。模型只看到 `name` + `description`，**绝不暴露正文/路径**。
- **模型侧消费**：面向模型的 `skill({ name })` 工具；会话早期以 user-role `<system-reminder>` 注入 `<available_skills>` 目录；目录 digest 变化才追加替换（增量注入，不浪费 token）。
- **变更监听**：Chokidar 监视各根目录（新增/删除/修改即时失效）；模型 `write`/`edit` 命中 skill 路径时同步失效。**改动 skill 文件无需重启 harness。**
- 本机克隆官方仓库自身即用 `.agents/skills/*/SKILL.md` 承载内部 skill —— 这就是「随包/项目 skills」的真实工作方式。

**对 Skills 系统的启示**：管理 = 读写 `$DSH_HOME/skills/`（用户级）与 workspace 的 `.dsh/skills`（项目级）；bundled 只读展示。修改后即时生效，无需重启，天然适合 UI 管理。

### 2.3 如何安装 plugin（核心调研项②）

**两个核心概念**（见 `docs/user/develop/basic/publish.md`）：

1. **组合包（bundle）**：附带配置层的 npm 包。`package.json` 声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`，patch 文件是对空配置根的插件行插入。
2. **profile**：`$DSH_HOME/profiles/<name>/`，`package.json` 的 `dsh.profile.bundles` 记录**有序**的组合包列表；另有用户自己的 `cordis.patch.yml`。

**安装命令**（`apps/cli/reference/README.md`）：

```sh
dsh plugin --profile <name> add <package-or-git-spec>   # 转发给 pnpm，成功后将 bundle 追加进 dsh.profile.bundles
dsh plugin --profile <name> remove <package>
dsh plugin --profile <name> update
```

- 安装来源：npm 包名（`dsh plugin add your-package`）、本地 checkout（`add ./path`）、tarball（`pnpm pack` 产物）、`github:owner/repo#commit`。
- **git 安装有构建授权边界**：拉的是源码，pnpm ≥10 可能拒绝依赖的 `prepare`/构建脚本。用户确认安装后，Hub 会解析 pnpm 给出的包名或完整 Git depPath，并逐包再次请求确认；用户允许后才写入 profile `pnpm-workspace.yaml` 的 `allowBuilds` 并重试一次。这仍等价于允许第三方代码在本机执行（**不在沙箱内**）。
- **生效配置层顺序**（后层按 `id` 整行覆盖，非深合并）：
  1. profile 的 `dsh.profile.bundles` 各 bundle patch（按列表顺序）
  2. profile 自己的 `cordis.patch.yml`
  3. `$DSH_HOME/cordis.patch.yml`
  4. 各 `--patch <path>` overlay
- **HMR**：profile/home 两级 `cordis.patch.yml` 的**配置变更会被监视并事务性重应用，无需重启进程**；但**安装新 bundle（改依赖图）必须重启** Loader 才进入组合。
- 内置 bundle：`@deepseek-ai/dsh-base`（所有 profile 的基底）、`@deepseek-ai/dsh-web-app`（web UI）、`@deepseek-ai/dsh-headless`。
- `dsh --profile <name> --dump-config` 可预览组合结果，无需启动。

**对 Plugin 系统的启示**：管理操作 = 在选中 profile 上执行 `dsh plugin` 语义（参考实现 anywhere-labs 封装为 `desktopPnpm.runPlugin()` 服务，完整保留 profile 初始化、相对路径锚定与 bundle reconcile）。安装/移除/更新后需重启 harness 生效；配置级 patch 变更可热生效。

### 2.4 MCP 机制与「JSON → YAML」（核心调研项③）

**DSH 的 MCP 消费方式**（`packages/mcp/mcp-client/`）：`@deepseek-ai/dsh-mcp-client` 是一个插件，**每个 MCP 服务器 = `cordis.yml` 里一个插件实例**：

```yaml
- id: mcp-github
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: github          # 工具命名空间 mcp__<serverName>__<rawName>
    transport: stdio            # 或 streamable-http
    command: npx
    args: ['-y', '@modelcontextprotocol/server-github']
    env:
      GITHUB_TOKEN: !!js process.env.GITHUB_TOKEN

- id: mcp-web
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: web
    transport: streamable-http
    url: http://localhost:3000/mcp
    headers:
      Authorization: !!js '`Bearer ${process.env.MCP_TOKEN}`'
```

- 字段：`transport: stdio|streamable-http`、`serverName`（`[A-Za-z0-9_-]{1,32}` 且实例内唯一）、`command`/`args`/`env`/`cwd`（stdio）、`url`/`headers`（http）、`toolCallTimeoutMs`（默认 60000）、`failOnStartupError`、`reconnect.*`。
- 工具注册为 `mcp__<serverName>__<rawName>`，与 Claude Code/Codex 的服务器限定形状一致；名称规范化 64 字符 + 确定性 hash 防碰撞。
- **HMR 支持配置热替换**：改 `cordis.yml` 里的 MCP 配置会触发断开+重连，**无需重启进程**。
- CLI 随附 `@deepseek-ai/dsh-mcp-client` 但**默认不启用任何 MCP 服务器**——官方明示原因：每条服务器命令都是 agent 沙箱之外的受信可执行代码。UI 需显式用户确认。
- **安全边界**：webServer 只监听 `127.0.0.1`，**无 TLS/认证**；绑定非回环即暴露（CLI 拒绝 `--host 0.0.0.0`）。

**「普通 JSON → DeepSeek 所需 YAML」映射**：输入 = 生态通用 JSON（Claude Code `.mcp.json`、Cursor、mcporter 等），输出 = 上面 `@deepseek-ai/dsh-mcp-client` 的 YAML 插件行（写入选中 profile 的 `cordis.patch.yml`，HMR 热生效）。转换映射表（已对照 Claude Code 官方文档与 DSH 配置 schema 验证）：

| Claude Code `.mcp.json` 字段 | DSH `cordis.yml` 目标字段 |
|---|---|
| `mcpServers.<name>.command` | `config.command`（`transport: stdio`） |
| `mcpServers.<name>.args` | `config.args` |
| `mcpServers.<name>.env` | `config.env` |
| `mcpServers.<name>.type: "http"` / `"sse"` | `config.transport: streamable-http` |
| `mcpServers.<name>.url` | `config.url` |
| `mcpServers.<name>.headers` | `config.headers` |
| `mcpServers.<name>`（键名） | `config.serverName` + 插件行 `id` |

参考工具 [mcporter](https://github.com/openclaw/mcporter) 已实现 Claude Code → 自身 JSON 的 import（`mcporter config import claude-code`），验证了该转换需求的真实性与格式差异点（stdio 定义基本原样迁移，HTTP 字段 `url`↔`baseUrl`）。DSH 的目标格式是 YAML 插件行，比 mcporter 多一步「行写入 profile patch」。

**已验证的转换样例**（2026-08-16 用本映射实现跑通，输出与官方 `dsh-mcp-client` README 示例同构）：

输入（Claude Code `.mcp.json`，混合 stdio + http）：

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" }
    },
    "remote-search": {
      "type": "http",
      "url": "https://mcp.example.com/search",
      "headers": { "Authorization": "Bearer ${MCP_TOKEN}" }
    }
  }
}
```

输出（可直接写入选中 profile 的 `cordis.patch.yml`，顶层必须是 patch 操作 `insert`）：

```yaml
- insert:
    - id: mcp-github
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: github
        transport: stdio
        command: npx
        args: ['-y', '@modelcontextprotocol/server-github']
        env:
          GITHUB_TOKEN: '${GITHUB_TOKEN}'
    - id: mcp-remote-search
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: remote-search
        transport: streamable-http
        url: https://mcp.example.com/search
        headers:
          Authorization: 'Bearer ${MCP_TOKEN}'
```

转换规则要点：`serverName` 必须匹配 `[A-Za-z0-9_-]{1,32}`（做 kebab 化清洗 + 冲突检测）；`type: sse` 需人工确认（DSH 仅支持 `streamable-http`）；环境变量 `${VAR}` 作为字面字符串透传，`!!js process.env.X` 语法仅在需要动态求值时使用。

### 2.5 桌面端参考实现要点

| 维度 | anywhere-labs（macOS+Win） | myYangyunfan（Win） |
|---|---|---|
| 运行时方案 | Electron + 固定上游子模块 + **内置 pnpm**（`ELECTRON_RUN_AS_NODE` 生成私有 node helper） | Electron + 内置 node.exe + `@deepseek-ai/dsh` npm 包 |
| harness 启动 | Launcher 在 main 进程内启动 Host generation | spawn 内置 node 执行 `dsh web --host 127.0.0.1 --port <复用>`，轮询 HTTP 200 |
| 插件管理 | `desktopPnpm.runPlugin()`（封装 `dsh plugin --profile <active> ...`，内置 pnpm，进程树托管） | `settings.json` + `dsh plugin` 语义，npm/github 源，重启生效 |
| profile | 多 profile + last-known-good 回退；托盘切换（重启边界） | 单 profile（`web`）为主 |
| 生命周期 | 单实例锁、退出清理进程树、SIGINT/SIGTERM 优雅 dispose（5s 预算） | 退出杀 dsh 进程树、渲染崩溃自愈、看门狗 |
| 更新 | 自建版本服务（`dshdesktop.cn/api/desktop/version`） | npm overlay（官方 dsh 更新）+ 壳自更新（GitHub/Gitee 双源分片） |

两者共同验证的结论：**Electron 壳 + 内置 Node 运行时 + loopback 加载官方 Web UI 是成熟路线**；插件管理必须走 `dsh plugin`（pnpm）语义而不是裸 pnpm 或直接改文件。

---

## 3. 产品定义

### 3.1 定位

**DSH Desktop Hub 管理控制台**：一个桌面应用，内置完整 DSH harness（无需安装 Node.js/pnpm 等任何运行环境，双击即进入），并在原生/集成 UI 中以多 Tab 提供三个管理系统和一个反馈入口：

1. **Plugin 系统** — 管理、安装、移除本机 DSH 所有插件
2. **MCP 系统** — 把普通 JSON 格式的 MCP 配置转换为 DeepSeek 所需的 YAML 并接入 harness
3. **Skills 系统** — 管理 DeepSeek（DSH harness）可用的 skills
4. **反馈系统** — 匿名/署名反馈、低敏诊断信息、复制兜底和 QQ 群入口；通过可访问的反馈 API 由 bot 创建 GitHub Issue
5. （其他系统预留 Tab 位，暂不做）

### 3.2 用户故事

| # | 用户故事 |
|---|---|
| U1 | 作为非技术用户，双击安装后的应用图标即可进入 DSH harness 对话界面，无需安装任何运行环境或执行命令 |
| U2 | 作为 DSH 用户，我能在 Plugin 系统看到本机所有插件（内置 bundle + 第三方），搜索 npm/GitHub 来源安装、移除、更新插件 |
| U3 | 作为从 Claude Code 迁来的用户，我能粘贴/选择 `.mcp.json`（或其他 JSON 格式），预览转换后的 DSH YAML，确认后写入配置并即时生效 |
| U4 | 作为 DSH 用户，我能在 Skills 系统浏览、创建、编辑、启用/禁用用户级与项目级 skills，改动即时生效 |
| U5 | 作为用户，我能看到 harness 运行状态、API Key/模型配置状态，并能彻底退出（不留孤儿进程） |
| U6 | 作为用户，我能在不访问 GitHub 的情况下提交匿名或署名反馈，并选择是否附加低敏诊断信息；网络失败时可以复制内容发送到 QQ 群 |

### 3.3 多 Tab 主窗口（当前实现）

**壳层（已落地）**：主窗口＝五 Tab 壳（顶部 Tab 栏：Harness / Plugin / MCP / Skills / 反馈，`src/renderer/index.html`）。应用启动后主进程拉起 `dsh web`（profile「web」，`--port 0` 由 dsh 自选端口），轮询 HTTP 200 就绪后创建 BrowserWindow（1280×800，sandbox + contextIsolation）；**Harness Tab 以 `<iframe>` 内嵌官方 Web UI**（CSP `frame-src http://127.0.0.1:*`）。由于 iframe 的 `load` 事件对长连接页面不可靠，由主进程监听 `did-frame-navigate`（非主帧且前缀命中 harness URL）推送 `harness:frame-loaded`，渲染层据此更新状态条「harness 已连接: 127.0.0.1:PORT」。

| Tab | 功能 | 关键交互（已实现） |
|---|---|---|
| **Harness（主）** | 官方 Web UI（会话、模型、工具） | iframe 内嵌 loopback Web UI；`harness:frame-loaded` 状态推送 |
| **Plugin** | profile「web」插件管理 | 列表（名称 / 来源：内置组合包、第三方组合包、普通依赖 / spec）；安装框支持 **npm 包名、`github:owner/repo#commit`、本地路径，并已升级为支持直接粘贴 GitHub 链接**（spec 透传给 `dsh plugin --profile web add`）；对 `dsh-routing-suite` 这类无 `package.json/dsh.bundle` 的聚合仓库拒绝直装，改为显示 injector/preset 的真实识别状态；移除（第三方包）、更新；写操作前确认，变更后提示「重启 harness 生效」 |
| **MCP** | JSON → YAML 转换器 + 服务器管理 | 粘贴 Claude Code / Cursor 风格 JSON → 转换预览（含警告：`type: sse` 仅按 HTTP 处理、非法 serverName 跳过）→ 确认后写入 profile「web」的 `cordis.patch.yml`（**写入前自动 `.bak-<ts>` 备份**，原子写，官方 HMR 热生效）；市场条目声明环境变量时，在安装卡片先填写并写入该 MCP 行，用户无需自行设置系统环境；显示现有服务器数 |
| **Skills** | skills 目录管理 | 按 DSH rank 规则扫描（用户 `~/.dsh/skills` / `~/.agents/skills` + `$DSH_BUNDLED_SKILL_DIR` 存在时的随包根，rank 400/500/600）；列表按来源标注，同名低 rank 生效、高 rank 标「被遮蔽」；可见性切换仅对用户级生效（项目/自定义/随包只读展示）；**新建**（kebab-case 名称校验 + 描述 + 正文表单，落盘 `~/.dsh/skills/<name>/SKILL.md`）；模型可见 / 用户可见切换（写 frontmatter `disable-model-invocation` / `user-invocable`），改动即时生效 |
| **反馈** | 匿名/署名反馈、低敏诊断、复制和 QQ 群 | 通过配置的 HTTPS feedback API 提交，不打开 GitHub；服务端由私有 Cloudflare Worker + GitHub Bot 异步创建 Issue；服务端未配置或网络失败时复制内容仍可用 |
| **Settings（壳级）** | API Key、模型、profile、更新 | 本期未实现（预留；API Key/模型配置复用官方 Web UI 内能力） |
| **其他系统（占位）** | 预留入口 | 本期未实现 |

UI 风格：浅色主题（`color-scheme: light`，品牌蓝 `#4d6bfe`），五个系统 Tab 与官方会话界面并列切换。

### 3.4 平台与范围

- **平台**：MVP 目标 macOS（本机开发环境）+ Windows（最大用户盘，参考实现已验证打包路线）；Linux 后续。
- **本期不做**：第四系统、开放式社区市场（本期先做随包精选目录）、手机远程、IM Channels、多 profile 高级管理（MVP 单 profile 起步）。

---

## 4. 技术方案（当前实现）

### 4.1 技术选型

| 决策点 | 选择（已落地） | 理由 |
|---|---|---|
| 壳 | **Electron 43.4.0 + TypeScript 5.8**，三套 tsc 配置：main+core（NodeNext）/ preload（CommonJS → `preload.cjs`）/ renderer（纯脚本，无模块） | DSH 是 Node 应用，Electron 自带 Node；Tauri 需另捆绑 Node 二进制，复杂度更高 |
| 内置 DSH | **`@deepseek-ai/dsh@0.1.0-rc.6` npm 包**（方案 A 已落地）：`scripts/bundle-runtime.mjs` 下载 Node v24.10.0 到 `resources/node`、npm 安装 dsh 到 `resources/dsh-runtime` | 与官方发布同步、打包体积可控；`--ignore-scripts` 安装规避未知副作用 |
| 运行时解析 | `resolveDshExec()`：**优先打包内 runtime**（`resources/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js` + `resources/node/bin/node`，兼容 `app.asar.unpacked/resources` 布局），回退系统 PATH（`$DSH_BIN` / Homebrew / `/usr/local` / `/usr` / PATH） | 打包应用不依赖用户安装 Node/dsh（双击即用） |
| 插件操作通道 | 主进程 spawn `dsh plugin --profile web add|remove|update`（进程树托管、输出流回 UI、支持取消） | 与 anywhere-labs `desktopPnpm.runPlugin()` 同构；`dsh` 是 bundle reconcile 的权威 |
| 配置写入 | 直接编辑 `$DSH_HOME/profiles/web/cordis.patch.yml`（MCP 行），原子写（tmp + rename）+ `.bak-<ts>` 备份，利用官方 HMR 热生效 | 配置层变更无需重启；bundle 安装仍走 `dsh plugin` + 重启 |
| 转换器 | 主进程纯逻辑模块（`src/core/mcp.ts`，`yaml` 库）：JSON 解析/校验 → 映射表 → YAML 插件行；兼容 `url`/`baseUrl`，`type: sse` 仅警告 | 可单测；无网络依赖 |
| Skills 管理 | `src/core/skills.ts`：用户级（rank 400/500）+ 随包（`$DSH_BUNDLED_SKILL_DIR`，rank 600）多根扫描 + frontmatter 解析 + 创建 + 可见性切换（与官方检测机制同构，§2.2；项目/自定义根由 DSH 在 workspace 内管理，壳层暂不扫描） | 改动即时生效，天然适合 UI 管理 |
| 扩展市场 | `src/core/market.ts`：Plugin 接入 DSH Plugin Market 发布的 Awesome DSH Plugin machine snapshot，MCP 合并官方 MCP Registry 与 DSH MCP Market，Skills 合并 ClawHub 与 SkillsMP；schema 校验、磁盘缓存、随包精选目录离线兜底；Plugin 安装前校验 `dsh.bundle` 并锁定 npm 版本/GitHub commit | 外部平台负责发现与来源证明，DSH 负责统一展示、预检、权限确认和安装；所有写入仍需用户确认 |
| 状态文件 | 暂无（`ACTIVE_PROFILE` 常量 = `'web'`；profile 切换为后续工作） | 当前 MVP 单 profile 起步 |

### 4.2 进程与生命周期

```
启动 → app.whenReady
  → registerIpc()（harness:* / plugins:* / mcp:* / skills:* / feedback:*）
  → resolveDshExec()（打包内 runtime 优先，回退 PATH）
  → spawn dsh web --port 0（detached 独立进程组，cwd=~）
  → 解析输出 127.0.0.1:PORT → 轮询 HTTP 200（就绪超时 120s）
  → 创建 BrowserWindow（1280×800，sandbox + contextIsolation + preload.cjs）
  → 加载五 Tab 壳（file://dist/renderer/index.html）
  → renderer 经 IPC 取 harness URL → iframe 挂载官方 Web UI
  → 主进程 did-frame-navigate（非主帧且前缀命中）推送 harness:frame-loaded
退出 → window-all-closed（非 macOS 退出）
  → will-quit → harness.stop()：SIGTERM 进程组 → 2s 兜底 SIGKILL → app.quit
```

冒烟模式：`--smoke`（不启 harness：五 Tab DOM + 真实插件/MCP/skills 数据断言，截屏 `artifacts/m0-smoke.png`）；`--harness-smoke`（真实 harness + iframe 加载断言，截屏 `artifacts/m1-harness.png`）。

### 4.3 安全边界（当前实现）

- BrowserWindow：`sandbox: true` + `contextIsolation: true` + `nodeIntegration: false`；preload 仅经 `contextBridge` 暴露白名单 API（`window.dshDesktop`）。
- 渲染层 CSP：`default-src 'self'`；`script-src 'self'`；`frame-src http://127.0.0.1:*`（仅允许 loopback 内嵌）；`connect-src 'self' http://127.0.0.1:*`。
- harness 只监听 loopback（`dsh web --port 0` 由 dsh 自选端口，官方无认证设计，**绝不**开放 `0.0.0.0`）。
- 插件安装 / MCP 写入 = 全部显式用户确认（官方明示：这些都是沙箱外受信代码）；git 来源插件若触发 pnpm 构建拦截，只展示 pnpm 明确报告的包并逐包请求确认，用户允许后才写入 `allowBuilds` 并重试，见 §2.3。
- MCP 写入前自动备份（`.bak-<ts>`），原子写（tmp + rename）失败不落盘。
- 转换器只做解析与映射，不执行任何命令。
- API Key 走官方通道（`$DSH_HOME/.credentials.yaml`，只写），壳层不触碰。
- 反馈 API 只接收用户明确提交的反馈和可选低敏诊断；桌面端不保存或发送 GitHub 凭据。私有 `github-issue-server/` 使用 Cloudflare Worker/Queues/D1 和 GitHub App secret。

---

## 5. 市场数据来源与归属声明

三类市场均为上游目录聚合，不自称拥有或审计第三方扩展：

- Plugin：`dsh-market/dsh-market` 发布的 Awesome DSH Plugin machine snapshot；README 作为 fallback；npm 仅在安装预检时读取 manifest。
- MCP：官方 MCP Registry 与 `LKMeng2001/dsh-mcp-market` snapshot。
- Skills：ClawHub 与 SkillsMP；ClawHub 匿名安装当前落地 `SKILL.md`，SkillsMP GitHub source 可带辅助文件。
- 完整 URL、缓存、许可证边界与安全提示见 [`MARKET_SOURCES.md`](MARKET_SOURCES.md)。

## 6. 里程碑（M0-M6 已完成；反馈升级另记为 M7）

| 里程碑 | 内容 | 状态与验证 |
|---|---|---|
| M0 壳骨架 | Electron + TypeScript 三端工程（main/preload/renderer）；五 Tab 契约；`typecheck` / `test` / `verify` 脚本 | ✅ 已完成：`npm run verify` 全绿；`npm run smoke` 五 Tab DOM 断言（截屏 `artifacts/m0-smoke.png`） |
| M1 Harness 启动与加载 | `dsh` / `$DSH_HOME` / profiles 检测；spawn `dsh web`（`--port 0`，detached 进程组）；轮询 HTTP 200；Harness Tab iframe 内嵌官方 Web UI（`did-frame-navigate` 状态推送）；退出清理进程树 | ✅ 已完成：`npm run verify:m1`（真实启动 → HTTP 200 → 优雅停止 → 端口关闭无孤儿）；`npm run smoke:harness`（iframe 挂载 + 状态「已连接」，截屏 `artifacts/m1-harness.png`） |
| M2 Plugin Tab | profile 发现 + 插件列表（`dsh.profile.bundles` ∪ dependencies）；封装 `dsh plugin --profile web add|remove|update`（支持 npm 包名 / `github:owner/repo#commit` / 本地路径 / 直接粘贴 GitHub 链接） | ✅ 已完成：单测 17 例（分类/排序/命令形态/带协议与裸 GitHub 链接归一化/聚合仓库拦截/pnpm ignored builds 与 Git prepare 授权/显式拒绝保护/退出码+取消/幂等激活行清理）；冒烟断言真实 web profile ≥4 项含 dsh-base |
| M3 MCP Tab | JSON→YAML 转换器 + profile `cordis.patch.yml` 事务读写（备份/回滚）+ 服务器列表 | ✅ 已完成：单测 18 例（混合输入/sse 警告/格式拒绝/YAML 同构/提取/替换/编辑/删除保留注释/空 patch 新建/备份事务/`!!js` 行级保真）；UI 支持读取、编辑、删除已有 MCP 行 |
| M4 Skills Tab | rank 400-600 目录扫描（用户级 + 随包）；SKILL.md/扁平 md 解析 + frontmatter；新建（kebab-case 校验）；模型/用户可见性切换 | ✅ 已完成：单测 15 例（rank 合并/shadowed/custom+bundled 根/往返一致/创建校验/可见性切换/扁平 skill 文件名回退/zip 导入与穿越拒绝）；冒烟真实数据 huashu-design + media-use |
| M5 桌面整合与打包 | 五 Tab 主窗口整合（Harness iframe 内嵌官方 Web UI）+ electron-builder 出 DMG | ✅ 已完成：默认模式＝启动 harness + 五 Tab 壳；`release/DSH-Desktop-Hub-0.1.0-arm64.dmg` 产物存在；打包 app 在 PATH 仅 `/usr/bin:/bin`（无系统 node/dsh）下用捆绑运行时启动，HTTP 200；TERM 退出无孤儿 |
| M6 扩展中心 MVP | Plugin / MCP / Skills 三类市场 + 在线目录搜索 + 精选安装链路 | ✅ 已完成：DSH Plugin Market / Awesome DSH Plugin / 官方 MCP Registry / DSH MCP Market / ClawHub / SkillsMP 接入，来源等级与权限展示，插件 CLI 安装，MCP patch 合并写入，Skills GitHub / ClawHub / 模板安装；账号/评论/社区提交未纳入本期 |
| M7 反馈与社区入口 | 第五个反馈 Tab + 低敏诊断/复制 + 私有 Cloudflare Worker 接收 + GitHub Bot Issue | 🚧 客户端与 Cloudflare Worker 私有工程已实现；正式 endpoint、Cloudflare 资源和 GitHub App 凭据需部署配置后启用；未配置时不伪造提交成功 |

> 后续演进（未在本期范围）：Settings Tab（API Key/模型/更新）、profile 切换、更细粒度的插件构建授权向导、MCP/Skills 文件导入、Windows/Linux 打包、自动更新 —— 详见 plan.md「下一步」。

---

## 7. 风险与开放问题

1. **上游破坏性变更**：DSH 是 developer preview，官方明示兼容性会断。已实证：调研期间（2026-08-16）repo main 为 `0.1.0-rc.5` 而 npm latest 已发布 `0.1.0-rc.6`。→ 锁定 npm 版本交付，升级走显式更新。
2. **命名冲突**：`dsh-desktop` / `dsh_desktop` 已被社区项目占用。→ 需要新应用名（待用户定）。
3. **插件生态安全**：第三方插件执行本机代码。→ UI 授权流程 + 安装前展示来源/commit 锁定。
4. **MCP JSON 格式多样性**：Claude Code / Cursor / mcporter 字段有差异（`url` vs `baseUrl`、`type: sse` 等）。→ 探测器 + 未知字段保留警告。
5. **Skill 管理粒度**：官方无「启停」概念，只能靠 frontmatter 策略（`disable-model-invocation`/`user-invocable`）与文件移除表达。→ UI 语义需明确为「模型可见/用户可见/隐藏」三态。
6. **重启体验**：bundle 安装/移除必须重启 harness，会打断会话。→ 变更前明确提示 + 一键重启 + 会话持久化（官方会话存 `$DSH_HOME/sessions`，重启可恢复）。

---

## 8. 交付说明

- 本文档为 **v0.1 已实现版**：§2 调研结论作为实施依据落地（见 §3.3 / §4 / §5 的当前实现说明）；M0-M6 已按 plan.md 完成并通过验证（`npm run verify` / `smoke` / `smoke:harness` / `verify:m1`）。
- 调研证据均为公开仓库当前 main/HEAD 状态；DSH 迭代快，实施以锁定的 npm 版本（`@deepseek-ai/dsh@0.1.0-rc.6`）为准。
