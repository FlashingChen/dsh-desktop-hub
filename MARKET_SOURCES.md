# DSH Desktop Hub 市场数据来源

DSH Desktop Hub 的 Plugin、MCP、Skills 市场是一个**来源聚合与安装编排层**，不是这些上游项目的所有者，也不把外部目录的收录等同于安全审计。

## Plugin

| 来源 | 运行时地址 | 用途 |
|---|---|---|
| DSH Plugin Market | [仓库](https://github.com/dsh-market/dsh-market) / [machine snapshot](https://github.com/dsh-market/dsh-market/blob/main/data/registry-snapshot.json) | 优先使用它发布的机器可读清单，包含名称、分类、描述、GitHub/npm 安装 spec、来源页和 GitHub star 数 |
| Awesome DSH Plugin | [仓库](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) | DSH Plugin Market snapshot 不可用时的清单 fallback；该项目的收录标准是能安装、描述相符和仍在维护，不等同于安全审查 |
| npm Registry | [registry.npmjs.org](https://registry.npmjs.org/) | 仅在用户点击安装后读取选中 npm 包的 `package.json` / packument，校验 `dsh.bundle` 并解析精确版本；不用于默认插件搜索 |

插件最终仍通过 DSH 的 `dsh plugin` 执行安装。GitHub 来源会尽量解析为 commit；GitHub API 限流时会明确显示未锁定 commit 的警告。

## MCP

| 来源 | 运行时地址 | 用途 |
|---|---|---|
| Official MCP Registry | [Registry API](https://registry.modelcontextprotocol.io/v0.1/servers) / [规范仓库](https://github.com/modelcontextprotocol/registry) | 发现 MCP server 的 npm package、stdio transport、streamable HTTP endpoint、版本和环境变量声明 |
| DSH MCP Market | [仓库](https://github.com/LKMeng2001/dsh-mcp-market) / [snapshot](https://github.com/LKMeng2001/dsh-mcp-market/blob/main/data/registry-snapshot.json) | DSH 兼容的精选 snapshot，提供可直接转换为 `dsh-mcp-client` 行的配置 |

官方 Registry 的条目不自动代表安全可信。DSH 会展示来源等级、传输方式、命令、远程地址和所需环境变量；写入 profile 前仍需用户确认。

## Skills

| 来源 | 运行时地址 | 用途 |
|---|---|---|
| ClawHub | [市场](https://clawhub.ai) / [HTTP API 文档](https://docs.openclaw.ai/clawhub/http-api) | 搜索带有来源、版本、热度和可疑标记的 Skill；安装时解析最新版本并通过公开 file API 固定版本下载 `SKILL.md` |
| SkillsMP | [市场](https://skillsmp.com) / [API 文档](https://skillsmp.com/docs/api) | 搜索 Skill 元数据与对应 GitHub star 数；安装时回到条目的 GitHub source 下载完整 Skill 仓库 |
| 随包精选 | DSH Desktop Hub 本仓库 `src/core/market.ts` | 网络不可用时的离线模板和精选 MCP/Plugin fallback |

ClawHub 的匿名公开读取接口目前稳定提供 `SKILL.md`；需要辅助文件的 Skill 优先使用 SkillsMP 的 GitHub source。Skill 内容写入用户级 `~/.dsh/skills` 前需要用户确认，导入器会校验名称、路径和压缩包大小。

## 缓存、失败与安全边界

- 在线结果通过运行时 schema 校验后才进入 UI 和安装载荷。
- 默认目录成功获取后写入 Electron `userData/market-cache`，网络失败时使用上次缓存，再回退随包精选。
- 每张卡片显示来源、来源等级、原始来源链接、版本/快照信息、权限；插件与 GitHub source 的 Skill 在上游提供数据时显示 GitHub star 数，部分上游不可用时会在市场栏提示。
- 上游收录、`official` 标签或热度不等于 DSH 安全背书。Plugin/MCP 可能执行本地代码或访问网络，安装前请阅读来源并确认权限。
- 上游数据和内容的版权、许可证及服务条款以各上游项目为准；DSH 仅在 UI 中展示必要的发现元数据和用户主动请求的安装内容。
