# 反馈与社区入口升级计划

## Context

目标是在 DSH Desktop Hub 内增加第五个反馈 Tab，覆盖：

- 匿名/不署名提交：客户端和服务端不保存可识别身份；用户不访问 GitHub，由可访问的反馈 API 接收，再由 bot/服务端转成 GitHub Issue。
- 署名提交：用户手填署名，仍通过反馈 API 提交；用户不打开 GitHub Issue，服务端将署名写入 Issue 内容。
- 诊断信息：生成可复制的低敏环境信息，让用户明确选择是否随反馈传递。
- 离线/网络失败兜底：复制完整反馈或诊断信息，用户可发到 QQ 群。
- 社区入口：在软件内置 QQ 群二维码。

GitHub 只作为服务端的管理后端，桌面端不持有 GitHub token，也不要求用户访问 GitHub。

## Initial findings

- Electron 主进程入口为 `src/main/main.ts`，现有 IPC handler 均通过 `assertRendererSender` 校验壳层来源。
- preload 白名单集中在 `src/preload/preload.ts`，IPC channel 名和类型契约集中在 `src/core/ipc.ts`。
- 桌面壳 UI 是 `src/renderer/index.html` + 非模块脚本 `src/renderer/renderer.ts`，当前侧栏只有 Harness / 插件 / MCP / Skills 四个工作区。
- 已有安全的外链出口：`src/main/main.ts` 的 `setWindowOpenHandler` 只把 `http(s)` 交给 `shell.openExternal`；CSP 当前只允许本地壳、Harness loopback 和自有 IPC。
- 仓库已经有二维码资源 `assets/community/qq-group.png`，README 也展示 QQ 群信息，但桌面应用资源目录与 README 资产路径需要进一步确认如何随 renderer 打包。
- 现阶段没有 feedback/issue/diagnostic 相关 IPC、core 模块或测试。

## Confirmed product decisions

- 反馈入口作为第五个侧栏 Tab。
- 署名提交只需用户手填署名，不做 GitHub 登录验证；用户不应被引导打开 GitHub Issue。
- 匿名/不署名模式可以接受“应用不收集身份，但通过 GitHub 提交时会显示 GitHub 账号”的语义。
- GitHub 仓库确定为 `FlashingChen/dsh-desktop-hub`。
- 普通用户主流程不打开 GitHub；匿名和署名模式都应提交到未来的反馈 API，再由服务端异步创建 Issue。直接 GitHub URL 仅可作为开发者调试备用，不作为产品入口。
- 交流群为 QQ 群，继续使用现有 QQ 群二维码资源。
- 诊断信息采用低敏白名单，默认不附加，但提供单独复制按钮。

## Approach

把反馈设计成“客户端 → 可访问的反馈 API → GitHub Bot Issue”的两段式链路，普通用户流程完全不依赖 GitHub 页面。桌面端只负责表单、低敏诊断、用户确认、HTTPS 提交和复制兜底，不持有任何 GitHub 凭据；私有服务端负责校验、限流、幂等、队列/重试和 bot 建 Issue。

GitHub Bot 服务放在私有 `github-issue-server/` 工作目录中开发，不进入公开源码发布。这里的 **GitHub App** 可以理解为 GitHub 官方提供的“机器人应用”：它安装到指定仓库，只拥有创建 Issue 所需的 `Issues: read/write` 权限；服务端用私钥换取短时访问令牌，Issue 会显示为 bot 身份。它不需要用户登录，也比把个人 PAT（相当于个人长期密码）放进服务端更容易限权和撤销。GitHub 官方认证流程见：

- <https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app>
- <https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app>
- <https://docs.github.com/en/rest/issues/issues>

公开桌面端只保留不敏感的 API endpoint 和协议版本，不包含 App 私钥、installation token 或其他可写 GitHub 凭据。服务端未上线前，客户端提交按钮显示未配置/不可用，而不是假装成功；复制内容始终可用。

## Research findings and recommendation

### 是否一定需要服务端

用户网络大概率无法访问 GitHub，因此“打开 GitHub Issue”不能作为产品提交路径。核心流程应改为：桌面端把反馈提交到一个用户可访问的 HTTPS 接收端，再由接收端以 bot/GitHub App 身份异步创建 GitHub Issue。

可以使用 Cloudflare Worker，而且它很适合这个边界：Worker 负责接收反馈并调用 GitHub API，Cloudflare Queues 负责异步投递/重试，D1 负责保存幂等键与反馈状态；桌面端只访问一个可配置的自定义 HTTPS 域名，不访问 GitHub。Worker 的 GitHub App 私钥通过 Cloudflare Secret 注入，普通配置通过非敏感变量注入，任何 secret 都不写入 `github-issue-server/` 或公开桌面端。

推荐的私有目录结构是 `github-issue-server/` 作为 Cloudflare Worker 项目，包含 TypeScript handler、Wrangler 配置、D1 migration、Queue consumer 和部署说明。Cloudflare 官方能力依据：

- <https://developers.cloudflare.com/workers/configuration/secrets/>
- <https://developers.cloudflare.com/workers/configuration/environment-variables/>
- <https://developers.cloudflare.com/queues/configuration/batching-retries/>
- <https://developers.cloudflare.com/d1/worker-api/>
- <https://developers.cloudflare.com/workers/best-practices/workers-best-practices/>

需要实测目标用户网络能否访问 Worker 的自定义域名；Cloudflare Worker 解决的是“用户到反馈 API”的可达性，不能自动保证所有网络都能访问 Cloudflare。桌面端不能内置 GitHub token、bot token 或 SMTP 密码；安装包中的密钥可被提取并滥用。

建议的生产链路：

1. 客户端只请求配置好的 `https://feedback.<domain>/v1/feedback`，不请求 GitHub。
2. 请求载荷包含协议版本、匿名/署名模式、分类、标题/正文和用户明确勾选的诊断块；匿名模式不传署名和联系方式。
3. 服务端做字段校验、大小限制、基础限流/反滥用，并把任务放入队列或持久化待处理状态。
4. 服务端异步调用 GitHub API 创建 Issue。GitHub 暂时不可达时保留队列并重试，不能让用户重新提交造成重复 Issue。
5. 客户端只显示“已接收/提交失败/稍后重试”等服务端状态，不向用户返回必须访问 GitHub 的链接；可返回内部反馈编号供客服查询。
6. “复制完整反馈”和“复制诊断信息”仍保留，作为网络失败时发到 QQ 群的人工兜底。

匿名的产品语义应定义为“客户端和服务端不保存可识别身份”。服务端仍可能在网络层短暂看到 IP，因此需要另行规定访问日志、IP 留存周期、删除策略和滥用防护；不能在客户端声称网络层绝对匿名。

### GitHub 的角色

GitHub 官方支持通过预填 URL 创建 Issue，但这要求用户访问 GitHub 并手动提交，和本产品的网络约束冲突。因此 GitHub 只放在服务端：服务端使用 bot/GitHub App 异步创建 Issue，桌面端不打开 GitHub、不依赖 GitHub 可达性，也不向用户展示必须访问 GitHub 的链接。

客户端与服务端之间应使用版本化 JSON contract，并支持幂等键、明确的成功/排队/失败状态。服务端不可达时，客户端保留复制完整反馈和诊断信息的能力；服务端暂时无法访问 GitHub 时，应自行排队重试，不能让用户重复提交造成重复 Issue。

### 诊断信息方案

参考桌面工具的 Issue Reporter 做法，并结合本仓库现有运行时/状态信息，生成一段只读 Markdown 诊断块。默认仅包含复现所需的低敏元数据：

- DSH Desktop Hub 版本、是否打包运行、当前 profile。
- OS 平台、OS release、CPU 架构。
- Electron、Chrome、Node 版本。
- 捆绑 DSH/pnpm 版本（能读取 `resources/runtime-manifest.json` 时提供）。
- Harness 状态、最近一次状态码/退出码等结构化状态，不直接附加原始日志。
- 生成时间和诊断格式版本，便于后续解析。

明确排除：用户名、主机名、HOME/DSH 路径、IP/MAC、环境变量、API Key/token、MCP 配置、会话内容、插件/Skill 正文及原始日志。诊断生成应位于 `src/core/diagnostics.ts`，由主进程采集动态快照后格式化，方便单测和以后服务端复用。

### 第五个 Tab 的交互建议

- 反馈类型：问题反馈/功能建议（至少保留一个自由文本输入，不让用户必须理解 Issue 模板）。
- 提交身份：`匿名/不署名`、`署名提交`；署名模式展示手填署名框，并限制长度。
- 匿名和署名模式都显示“提交反馈”，都只请求反馈 API，不展示 GitHub 跳转；署名模式额外展示手填署名框。
- 服务端未配置或不可达时，提交按钮显示清晰错误/未配置状态，不显示虚假的成功；复制选项始终可用。
- 诊断信息：默认不附加；复选框明确写出“附加诊断信息（不含账号、路径和密钥）”；单独提供“复制诊断信息”和“复制完整反馈”。
- 页面下方展示 QQ 群二维码、群号 `1106611027` 和“网络不可用时可复制内容后发送到群里”的说明。

反馈正文应在客户端和服务端分别设置字段/总大小上限；客户端不再把完整内容放进 GitHub URL。

## Files to modify

- `src/renderer/index.html`：增加第五个 `feedback` Tab、反馈表单、诊断复选框/复制按钮、Issue 操作说明和 QQ 群二维码区。
- `src/renderer/renderer.ts`：身份模式切换、署名校验、诊断预览/复制、拼装规范化反馈、调用受控反馈 API 和状态提示。
- `src/preload/preload.ts`：以结构化参数暴露 feedback/diagnostics 白名单 API，不暴露任意 URL、GitHub 或任意网络请求。
- `src/core/ipc.ts`：新增 feedback/diagnostics channel 和载荷类型，并保持 preload 字符串契约一致。
- `src/main/main.ts`：采集诊断快照、验证/限长输入、调用配置好的 HTTPS feedback endpoint；不构造 GitHub URL，不持有 GitHub 凭据。
- `src/core/diagnostics.ts`：纯函数诊断快照类型、脱敏字段白名单、Markdown formatter、长度/换行规范。
- `src/core/feedback.ts`（新增）：反馈模式、分类、规范化 payload、服务端响应和幂等键的客户端 contract。
- `src/core/feedback-client.ts`（新增）：可注入 endpoint/fetch 的 HTTPS 客户端，处理 timeout、非 2xx、响应校验和有限重试；不包含 GitHub API 逻辑。
- `scripts/copy-renderer.mjs`：将 `assets/community/qq-group.png` 复制到 `dist/renderer`，解决当前 Electron 打包只包含 `dist/**` 的资源问题。
- `tests/diagnostics.test.mjs`（新增）及 `tests/skeleton.test.mjs`：诊断排除敏感字段、格式稳定、第五 Tab/资源/IPC 契约。
- `src/main/smoke.ts`：将冒烟断言扩展为第五 Tab、反馈面板、二维码/复制控件存在；不实际访问真实 API。
- `github-issue-server/`：私有服务端实现目录，包含 API handler、GitHub App 认证、Issue 组装、限流/幂等/队列和健康检查；部署密钥只从环境变量/secret manager 读取。
- `.gitignore`：确保 `github-issue-server/`、部署配置、数据库/队列数据和 `.env` 不进入公开仓库；如果该目录已经被 Git 跟踪，则必须迁移到私有仓库，单纯 `.gitignore` 不足以隐藏历史。

服务端真实 endpoint 通过构建配置/受控常量注入，未确定前不启用自动提交。

## Reuse

- 复用 `src/main/main.ts` 的 `assertRendererSender`、固定的窗口安全边界和 `log` 设施；不复用 `shell.openExternal` 作为普通反馈提交路径。
- 复用 `src/core/ipc.ts` / `src/preload/preload.ts` 的白名单式 IPC 结构，不从 renderer 暴露任意网络、shell 或 GitHub 能力。
- 复用 renderer 的 `textContent`/DOM API、`status` 样式和 `confirm` 操作确认模式，避免把用户反馈拼入 `innerHTML`。
- 复用 `src/core/harness.ts` 的运行时解析结果、`src/core/log.ts` 的应用日志存在性信息，以及 `resources/runtime-manifest.json` 的版本数据；不把日志原文或路径暴露给用户。
- 复用现有 CSP、sandbox/contextIsolation 配置和 `assets/community/qq-group.png`（当前 PNG 约 1156×2055、734 KB）。

## Steps

- [x] 完成第一轮需求澄清：第五个 Tab、手填署名、QQ 群二维码、服务端暂未规划。
- [x] 明确 GitHub 不进入普通用户流程：由服务端 bot 异步建 Issue，客户端不打开 GitHub。
- [x] 确认 feedback API 的部署边界、可访问域名、版本化 JSON contract、成功/排队/失败响应和幂等策略（Cloudflare Worker 自定义域名 `feedback.flashingchen.xyz`；客户端支持 `DSH_FEEDBACK_ENDPOINT` 覆盖）。
- [x] 设计并实现脱敏诊断生成器及输入/输出约束。
- [x] 实现 `feedback.ts` / `feedback-client.ts`，并扩展 IPC/preload/main：生成诊断、复制文本、HTTPS 提交、超时和离线错误处理。
- [x] 实现第五 Tab：匿名/署名切换、署名输入、诊断选择、复制完整反馈/诊断、API 提交和 QQ 二维码。
- [x] 处理资源打包和可访问性：二维码在开发、smoke、打包产物中都能加载。
- [x] 补齐单元、contract、mock API 和手工冒烟验证，并同步隐私说明/README。
- [x] 在私有 `github-issue-server/` 实现：校验、限流配置、幂等、Cloudflare Queue/D1 队列/重试、GitHub App 建 Issue、失败重试和隐私日志策略；密钥只通过 secret manager/environment 注入。

## Verification

- `npm run typecheck` 和 `npm run test`/`npm run verify` 全绿；新增纯函数测试覆盖诊断白名单、敏感字段排除、Markdown 格式和反馈 payload 的编码/长度策略。
- `npm run smoke` 断言五个 Tab、反馈面板、诊断/复制控件、二维码资源存在；测试不得访问真实反馈 endpoint 或 GitHub。
- 用本地 mock HTTPS/HTTP endpoint 验证匿名与署名 payload、诊断勾选行为、成功/排队/4xx/5xx/超时/重复提交响应。
- Electron 手工验证：匿名/署名切换、署名必填与长度限制、诊断默认不附加、选择附加后的正文预览、复制诊断/完整反馈、API 提交状态、QQ 二维码显示；确认全流程不打开 GitHub。
- 失败路径验证：服务端未配置、网络不可达、超时、用户取消、空反馈、超长正文、服务端返回非法 JSON；确认应用仍可复制内容作为离线兜底。
- 隐私验证：生成的诊断和 payload 不含用户名、路径、环境变量、密钥、MCP 配置、会话内容、原始日志；匿名 payload 不含署名/联系方式。
- 构建/打包验证：`dist/renderer` 中包含二维码，开发运行、smoke 和 electron-builder 产物均能读取。

## Remaining product questions

1. `github-issue-server/` 是只在当前工作区本地存在并由 `.gitignore` 排除，还是要放入一个独立的私有 Git 仓库？当前公开仓库不能跟踪这部分源码。
2. 是否按推荐方案创建 GitHub App（Issues read/write，仅安装到 `FlashingChen/dsh-desktop-hub`），而不是使用 bot 账号 PAT？App ID、installation ID 和私钥由你在部署环境注入，不要提交到仓库或发到对话中。
3. 需要在目标用户网络验证 `feedback.flashingchen.xyz` 可达；若不可达，再增加备用域名/入口。
4. 服务端成功响应是否只显示“已收到”与内部反馈编号，不向用户展示 GitHub Issue 地址？GitHub 暂时不可达时是否由服务端排队重试？
5. 是否接受匿名语义为“应用和服务端不保存可识别身份”，但服务商可能短暂接触 IP；需要确定访问日志和 IP 留存策略。
