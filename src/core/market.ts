// 扩展市场目录：插件、MCP 与 Skills 共用同一套可扩展的条目模型。
// 外部项目只负责发现/来源证明，DSH 在这里统一归一化、校验、缓存和生成待用户确认的安装载荷。
// Plugin 不把 npm 搜索当市场：主目录来自 Awesome DSH Plugin，npm 只用于选中后的 manifest 预检。
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MCP_PLUGIN, type McpRow } from './mcp.js'

export type MarketKind = 'plugin' | 'mcp' | 'skill'
export type MarketTrust = 'bundled' | 'official' | 'curated' | 'community' | 'unreviewed'

export interface MarketBaseItem {
  id: string
  kind: MarketKind
  name: string
  description: string
  author: string
  version: string
  category: string
  tags: string[]
  verified: boolean
  permissions: string[]
  /** 目录来源，例如「随包精选」「SkillsMP」「MCP Registry」「npm」 */
  source?: string
  sourceUrl?: string
  popularity?: number
  /** 来源级信任标签，不等同于安全审计；第三方条目仍需用户确认。 */
  trust?: MarketTrust
}

export interface PluginMarketItem extends MarketBaseItem {
  kind: 'plugin'
  spec: string
  packageName: string
}

export interface McpMarketItem extends MarketBaseItem {
  kind: 'mcp'
  row: McpRow
  requiredEnv: string[]
}

export interface SkillTemplateInstall {
  type: 'template'
  name: string
  description: string
  body: string
}

export interface SkillGitHubInstall {
  type: 'github'
  url: string
  name: string
}

export interface SkillClawHubInstall {
  type: 'clawhub'
  owner: string
  slug: string
  version: string
  name: string
}

export type SkillMarketInstall = SkillTemplateInstall | SkillGitHubInstall | SkillClawHubInstall

export interface SkillMarketItem extends MarketBaseItem {
  kind: 'skill'
  install: SkillMarketInstall
}

export type MarketItem = PluginMarketItem | McpMarketItem | SkillMarketItem

/**
 * 随包精选目录。
 * - Plugin 使用 dsh plugin 的官方安装 spec。
 * - MCP 直接提供 dsh-mcp-client 行，安装后仍需用户确认并填写环境变量。
 * - Skill 先提供可离线安装的模板，避免首次打开市场必须联网。
 */
export const MARKET_ITEMS: readonly MarketItem[] = [
  {
    id: 'dsh-super-injector',
    kind: 'plugin',
    name: 'DSH Super Injector',
    description: '为 DSH 提供可组合的注入与路由能力。安装前请阅读仓库说明并确认第三方代码权限。',
    author: 'yjh051108',
    version: 'GitHub main',
    category: '运行时扩展',
    tags: ['injector', 'routing', 'GitHub'],
    verified: false,
    trust: 'curated',
    permissions: ['安装并执行第三方 Node.js 代码', '修改 web profile 依赖'],
    spec: 'github:yjh051108/dsh-super-injector',
    packageName: '@dsh-external/dsh-super-injector',
    source: '随包精选',
    sourceUrl: 'https://github.com/yjh051108/dsh-super-injector',
  },
  {
    id: 'mcp-github',
    kind: 'mcp',
    name: 'GitHub MCP Server',
    description: '让 Harness 通过 MCP 访问 GitHub 仓库、Issue、Pull Request 等能力。',
    author: 'Model Context Protocol',
    version: 'latest',
    category: '开发工具',
    tags: ['GitHub', '代码', 'Issue'],
    verified: false,
    trust: 'official',
    permissions: ['启动 npx 子进程', '访问 GitHub 网络服务'],
    requiredEnv: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
    source: '随包精选',
    sourceUrl: 'https://github.com/modelcontextprotocol/servers',
    row: {
      id: 'mcp-market-github',
      name: MCP_PLUGIN,
      config: {
        serverName: 'github',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_PERSONAL_ACCESS_TOKEN}' },
      },
    },
  },
  {
    id: 'mcp-fetch',
    kind: 'mcp',
    name: 'Fetch MCP Server',
    description: '抓取网页并转换为适合模型阅读的内容，适合资料检索与网页分析。',
    author: 'Model Context Protocol',
    version: 'latest',
    category: '信息检索',
    tags: ['HTTP', '网页', '检索'],
    verified: false,
    trust: 'official',
    permissions: ['启动 npx 子进程', '访问目标网页'],
    requiredEnv: [],
    source: '随包精选',
    sourceUrl: 'https://github.com/modelcontextprotocol/servers',
    row: {
      id: 'mcp-market-fetch',
      name: MCP_PLUGIN,
      config: {
        serverName: 'fetch',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-fetch'],
      },
    },
  },
  {
    id: 'mcp-memory',
    kind: 'mcp',
    name: 'Memory MCP Server',
    description: '提供基于知识图谱的持久化记忆工具，帮助跨会话保存实体和关系。',
    author: 'Model Context Protocol',
    version: 'latest',
    category: '记忆与知识',
    tags: ['memory', 'knowledge graph'],
    verified: false,
    trust: 'official',
    permissions: ['启动 npx 子进程', '在本地 profile 中保存记忆数据'],
    requiredEnv: [],
    source: '随包精选',
    sourceUrl: 'https://github.com/modelcontextprotocol/servers',
    row: {
      id: 'mcp-market-memory',
      name: MCP_PLUGIN,
      config: {
        serverName: 'memory',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-memory'],
      },
    },
  },
  {
    id: 'skill-code-review',
    kind: 'skill',
    name: 'Code Review',
    description: '以审查清单的方式检查代码变更，优先发现正确性、安全性和回归风险。',
    author: 'DSH Desktop Hub',
    version: '1.0.0',
    category: '开发协作',
    tags: ['代码审查', '工程', '质量'],
    verified: true,
    trust: 'bundled',
    permissions: ['写入用户级 ~/.dsh/skills'],
    source: '随包精选',
    install: {
      type: 'template',
      name: 'code-review',
      description: '以审查清单的方式检查代码变更，优先发现正确性、安全性和回归风险。',
      body: `# Code Review\n\n审查代码变更时，按以下顺序工作：\n\n1. 先确认需求、边界条件和失败路径。\n2. 检查数据校验、权限边界、路径处理和外部输入。\n3. 检查异步流程、并发、资源释放和错误恢复。\n4. 评估测试是否覆盖新增行为与回归风险。\n5. 只报告可复现或有明确依据的问题，并给出文件位置和修复建议。`,
    },
  },
  {
    id: 'skill-release-notes',
    kind: 'skill',
    name: 'Release Notes',
    description: '从提交和变更中整理面向用户的版本说明，区分新增、修复和兼容性影响。',
    author: 'DSH Desktop Hub',
    version: '1.0.0',
    category: '发布协作',
    tags: ['changelog', '发布', '文档'],
    verified: true,
    trust: 'bundled',
    permissions: ['写入用户级 ~/.dsh/skills'],
    source: '随包精选',
    install: {
      type: 'template',
      name: 'release-notes',
      description: '从提交和变更中整理面向用户的版本说明，区分新增、修复和兼容性影响。',
      body: `# Release Notes\n\n整理版本说明时：\n\n- 按新增功能、体验改进、问题修复和兼容性变化分组。\n- 使用用户能理解的结果描述，避免只罗列内部实现。\n- 标明需要迁移、重新配置或重启的变化。\n- 不夸大影响，不把未验证的内容写成已完成。`,
    },
  },
]

function cloneMarketItem(item: MarketItem): MarketItem {
  if (item.kind === 'mcp') {
    return {
      ...item,
      tags: [...item.tags],
      permissions: [...item.permissions],
      requiredEnv: [...item.requiredEnv],
      row: { ...item.row, config: { ...item.row.config } },
    }
  }
  if (item.kind === 'skill') {
    return { ...item, tags: [...item.tags], permissions: [...item.permissions], install: { ...item.install } }
  }
  return { ...item, tags: [...item.tags], permissions: [...item.permissions] }
}

export function listMarketItems(kind?: MarketKind): MarketItem[] {
  return MARKET_ITEMS.filter((item) => !kind || item.kind === kind).map(cloneMarketItem)
}

export function findMarketItem(kind: MarketKind, id: string): MarketItem | undefined {
  const item = MARKET_ITEMS.find((candidate) => candidate.kind === kind && candidate.id === id)
  return item ? cloneMarketItem(item) : undefined
}

const SKILLSMP_SEARCH_URL = 'https://skillsmp.com/api/v1/skills/search'
const CLAWHUB_SEARCH_URL = 'https://clawhub.ai/api/v1/search'
const CLAWHUB_API_URL = 'https://clawhub.ai/api/v1/skills'
const MCP_REGISTRY_URL = 'https://registry.modelcontextprotocol.io/v0.1/servers'
const DSH_MCP_CATALOG_URL = 'https://raw.githubusercontent.com/LKMeng2001/dsh-mcp-market/main/data/registry-snapshot.json'
const DSH_MCP_CATALOG_API_URL = 'https://api.github.com/repos/LKMeng2001/dsh-mcp-market/contents/data/registry-snapshot.json?ref=main'
const DSH_PLUGIN_CATALOG_URLS = [
  'https://cdn.jsdelivr.net/gh/dsh-market/dsh-market@main/data/registry-snapshot.json',
  'https://gcore.jsdelivr.net/gh/dsh-market/dsh-market@main/data/registry-snapshot.json',
  'https://raw.githubusercontent.com/dsh-market/dsh-market/main/data/registry-snapshot.json',
] as const
const DSH_PLUGIN_CATALOG_API_URL = 'https://api.github.com/repos/dsh-market/dsh-market/contents/data/registry-snapshot.json?ref=main'
const AWESOME_DSH_PLUGIN_README_URLS = [
  'https://gcore.jsdelivr.net/gh/awesome-dsh-plugin/awesome-dsh-plugin@main/README.zh.md',
  'https://cdn.jsdelivr.net/gh/awesome-dsh-plugin/awesome-dsh-plugin@main/README.zh.md',
  'https://fastly.jsdelivr.net/gh/awesome-dsh-plugin/awesome-dsh-plugin@main/README.zh.md',
  'https://raw.githubusercontent.com/awesome-dsh-plugin/awesome-dsh-plugin/main/README.zh.md',
] as const
const AWESOME_DSH_PLUGIN_README_API_URL = 'https://api.github.com/repos/awesome-dsh-plugin/awesome-dsh-plugin/contents/README.zh.md?ref=main'
const MARKET_FETCH_TIMEOUT_MS = 10_000
const MARKET_MAX_RESPONSE_BYTES = 12 * 1024 * 1024
const MARKET_CACHE_TTL_MS = 5 * 60_000

interface JsonRecord {
  [key: string]: unknown
}

function record(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

async function fetchText(url: string, timeoutMs = MARKET_FETCH_TIMEOUT_MS): Promise<string> {
  const response = await fetch(url, {
    headers: { Accept: 'text/plain, text/markdown, application/json', 'User-Agent': 'DSH-Desktop-Hub/0.2' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`市场请求失败（HTTP ${response.status}）`)
  const length = Number(response.headers.get('content-length') ?? 0)
  if (length > MARKET_MAX_RESPONSE_BYTES) throw new Error('市场响应超过大小上限')
  const text = await response.text()
  if (text.length > MARKET_MAX_RESPONSE_BYTES) throw new Error('市场响应超过大小上限')
  return text
}

async function fetchJson(url: string, timeoutMs = MARKET_FETCH_TIMEOUT_MS): Promise<unknown> {
  const text = await fetchText(url, timeoutMs)
  try {
    return JSON.parse(text) as unknown
  } catch (err) {
    throw new Error(`市场响应不是有效 JSON：${err instanceof Error ? err.message : String(err)}`)
  }
}

function hashText(value: string): string {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619)
  return (hash >>> 0).toString(36)
}

function safeServerName(seed: string): string {
  const clean = seed.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'server'
  const suffix = hashText(seed).slice(0, 6)
  const maxBase = 32 - suffix.length - 1
  return `${clean.slice(0, maxBase)}-${suffix}`.slice(0, 32)
}

function compareVersions(a: string, b: string): number {
  const left = a.replace(/^v/i, '').split(/[.+-]/).map((part) => Number(part) || 0)
  const right = b.replace(/^v/i, '').split(/[.+-]/).map((part) => Number(part) || 0)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

function marketText(item: MarketItem): string {
  return [item.name, item.description, item.author, item.category, item.source ?? '', ...item.tags].join(' ').toLowerCase()
}

function matchesQuery(item: MarketItem, query: string): boolean {
  if (!query.trim()) return true
  const haystack = marketText(item)
  return query.toLowerCase().trim().split(/\s+/).every((term) => haystack.includes(term))
}

function dedupeMarketItems(items: MarketItem[]): MarketItem[] {
  const seen = new Set<string>()
  const result: MarketItem[] = []
  for (const item of items) {
    const key = item.kind === 'plugin'
      ? item.spec.startsWith('github:')
        ? `plugin:github:${item.spec.split('#')[0]}`
        : `plugin:npm:${item.packageName}`
      : item.kind === 'mcp'
        ? `mcp:${String(item.row.config.serverName ?? item.row.id)}`
        : item.install.type === 'github'
          ? `skill:github:${item.install.url}`
          : item.install.type === 'clawhub'
            ? `skill:clawhub:${item.install.owner}/${item.install.slug}`
            : `skill:template:${item.install.name}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(item)
  }
  return result
}

let curatedPluginCache: { expiresAt: number; items: PluginMarketItem[] } | null = null

function pluginSpecFromCatalog(value: unknown): { spec: string; packageName: string; sourceUrl?: string } | null {
  const specText = stringValue(value)
  if (!specText) return null
  const match = specText.match(/\badd\s+([^\s]+)$/)
  const spec = (match?.[1] ?? specText).trim()
  if (spec.startsWith('github:')) {
    const github = spec.match(/^github:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:#.+)?$/)
    if (!github) return null
    return { spec, packageName: github[2] }
  }
  if (spec.startsWith('http')) {
    const github = spec.match(/^https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/.*)?$/)
    if (!github) return null
    return { spec: `github:${github[1]}/${github[2]}`, packageName: github[2], sourceUrl: spec }
  }
  const npm = spec.match(/^(@[^/]+\/[^@]+|[^@/]+)(?:@.+)?$/)
  if (!npm) return null
  return { spec, packageName: npm[1] }
}

function mapDshMarketPlugin(raw: unknown, categories: JsonRecord | null): PluginMarketItem | null {
  const plugin = record(raw)
  const name = stringValue(plugin?.name)
  const sourceUrl = stringValue(plugin?.url)
  const install = pluginSpecFromCatalog(plugin?.install)
  if (!name || !sourceUrl || !install) return null
  const categoryKey = stringValue(plugin?.category) ?? 'community'
  const categoryObject = record(categories?.[categoryKey])
  const category = stringValue(categoryObject?.zh) ?? categoryKey
  const descriptionObject = record(plugin?.description)
  const description = stringValue(descriptionObject?.zh) ?? stringValue(descriptionObject?.en) ?? '来自 DSH Plugin Market 的社区插件。'
  const stars = Number(plugin?.stars ?? 0)
  return {
    id: `dsh-market-plugin-${hashText(sourceUrl)}`,
    kind: 'plugin',
    name,
    description,
    author: stringValue(plugin?.owner) ?? 'DSH 社区',
    version: 'GitHub / npm · 安装时校验',
    category,
    tags: [...new Set(['dsh-plugin', 'curated', category])],
    verified: false,
    trust: 'curated',
    permissions: ['安装并执行第三方 Node.js 代码', '安装前校验 dsh.bundle'],
    source: 'DSH Plugin Market · curated',
    // 安装来源链接必须指向真实 GitHub/npm source，而不是上游目录详情页。
    sourceUrl,
    popularity: Number.isFinite(stars) ? stars : undefined,
    spec: install.spec,
    packageName: install.packageName,
  }
}

async function fetchDshPluginSnapshot(): Promise<JsonRecord> {
  // 机器清单走 CDN；每个镜像短超时，避免某个镜像连接悬挂拖慢首屏。
  for (const url of DSH_PLUGIN_CATALOG_URLS) {
    try {
      const payload = record(await fetchJson(url, 4_000))
      if (payload && Array.isArray(payload.plugins)) return payload
    } catch {
      /* try next mirror */
    }
  }
  // CDN 全部不可用时，GitHub Contents API 返回带 sha 的 base64 文件。
  const apiPayload = record(await fetchJson(DSH_PLUGIN_CATALOG_API_URL, 6_000))
  const encoded = stringValue(apiPayload?.content)
  if (!encoded) throw new Error('DSH Plugin Market snapshot 缺少 content')
  const decoded = Buffer.from(encoded.replace(/\s+/g, ''), 'base64').toString('utf8')
  const snapshot = record(JSON.parse(decoded))
  if (!snapshot || !Array.isArray(snapshot.plugins)) throw new Error('DSH Plugin Market snapshot 格式无效')
  return snapshot
}

/**
 * Awesome DSH Plugin 是 DSH 社区维护的审核清单：条目来自 GitHub，收录前确认能安装并声明 dsh.bundle。
 * DSH Plugin Market 发布的 machine-readable snapshot 优先；README 只作为兼容 fallback。
 * npm 只在安装预检阶段读取包 manifest，不再作为主目录搜索源。
 */
function parseAwesomeDshPlugins(markdown: string): PluginMarketItem[] {
  const start = markdown.indexOf('<!-- BEGIN PLUGINS -->')
  const end = markdown.indexOf('<!-- END PLUGINS -->')
  if (start < 0 || end <= start) throw new Error('Awesome DSH Plugin 清单格式不完整')
  const section = markdown.slice(start, end)
  const result: PluginMarketItem[] = []
  let category = '社区插件'
  const seen = new Set<string>()
  for (const line of section.split(/\r?\n/)) {
    const heading = line.match(/^###\s+(.+?)\s*$/)
    if (heading) {
      category = heading[1].replace(/^[^A-Za-z0-9\u4e00-\u9fff]+/g, '').trim() || '社区插件'
      continue
    }
    const match = line.match(/^-\s+\[([^\]]+)\]\((https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+))\)\s+(?:—|-)\s+(.+)$/)
    if (!match) continue
    const [, displayName, sourceUrl, owner, repo, description] = match
    if (seen.has(sourceUrl)) continue
    seen.add(sourceUrl)
    result.push({
      id: `awesome-dsh-${hashText(sourceUrl)}`,
      kind: 'plugin',
      name: displayName,
      description: description.trim(),
      author: owner,
      version: 'GitHub · 安装时锁定 commit',
      category,
      tags: ['dsh-plugin', 'curated', category],
      verified: false,
      trust: 'curated',
      permissions: ['安装并执行第三方 Node.js 代码', '安装前校验 dsh.bundle'],
      source: 'Awesome DSH Plugin',
      sourceUrl,
      spec: `github:${owner}/${repo}`,
      packageName: repo,
    })
  }
  if (result.length === 0) throw new Error('Awesome DSH Plugin 清单没有可用条目')
  return result
}

async function fetchCuratedDshPlugins(): Promise<MarketItem[]> {
  if (curatedPluginCache && curatedPluginCache.expiresAt > Date.now()) {
    return curatedPluginCache.items.map(cloneMarketItem)
  }
  try {
    const snapshot = await fetchDshPluginSnapshot()
    const categories = record(snapshot.categories)
    const items = arrayValue(snapshot.plugins)
      .map((raw) => mapDshMarketPlugin(raw, categories))
      .filter((item): item is PluginMarketItem => item !== null)
    if (items.length > 0) {
      curatedPluginCache = { expiresAt: Date.now() + MARKET_CACHE_TTL_MS, items }
      return items.map(cloneMarketItem)
    }
  } catch {
    /* machine-readable dsh-market snapshot unavailable; try the source README */
  }
  let markdown = ''
  const errors: string[] = []
  for (const url of AWESOME_DSH_PLUGIN_README_URLS) {
    try {
      markdown = await fetchText(url)
      break
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err))
    }
  }
  if (!markdown) {
    try {
      const apiPayload = record(await fetchJson(AWESOME_DSH_PLUGIN_README_API_URL))
      const encoded = stringValue(apiPayload?.content)
      if (encoded) markdown = Buffer.from(encoded.replace(/\s+/g, ''), 'base64').toString('utf8')
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err))
    }
  }
  if (!markdown) throw new Error(`Awesome DSH Plugin 清单不可用：${errors.join('；')}`)
  const items = parseAwesomeDshPlugins(markdown)
  curatedPluginCache = { expiresAt: Date.now() + MARKET_CACHE_TTL_MS, items }
  return items.map(cloneMarketItem)
}

function registryServerToMcp(server: JsonRecord): McpMarketItem | null {
  const name = stringValue(server.name)
  if (!name) return null
  const version = stringValue(server.version) ?? 'latest'
  const displayName = stringValue(server.title) ?? name.split('/').pop() ?? name
  const serverName = safeServerName(displayName)
  const packages = arrayValue(server.packages).map(record).filter((item): item is JsonRecord => item !== null)
  const npmPackage = packages.find((item) => item.registryType === 'npm' && record(item.transport)?.type === 'stdio')
  const remotes = arrayValue(server.remotes).map(record).filter((item): item is JsonRecord => item !== null)
  const remote = remotes.find((item) => item.type === 'streamable-http' && stringValue(item.url))
  let config: Record<string, unknown>
  const requiredEnv: string[] = []
  let transportLabel = 'streamable-http'
  if (npmPackage) {
    const identifier = stringValue(npmPackage.identifier)
    if (!identifier) return null
    const packageVersion = stringValue(npmPackage.version) ?? version
    const args = ['-y', `${identifier}@${packageVersion}`]
    for (const argument of arrayValue(npmPackage.packageArguments).map(record).filter((item): item is JsonRecord => item !== null)) {
      const value = stringValue(argument.value)
      if (!value) continue
      if (argument.type === 'positional') args.push(value)
      else if (typeof argument.name === 'string') args.push(`--${argument.name}`, value)
    }
    const env: Record<string, string> = {}
    for (const variable of arrayValue(npmPackage.environmentVariables).map(record).filter((item): item is JsonRecord => item !== null)) {
      const envName = stringValue(variable.name)
      if (!envName || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) continue
      env[envName] = `\${${envName}}`
      if (variable.isRequired === true || variable.isSecret === true) requiredEnv.push(envName)
    }
    config = { serverName, transport: 'stdio', command: 'npx', args }
    if (Object.keys(env).length > 0) config.env = env
    transportLabel = 'stdio / npm'
  } else if (remote) {
    const url = stringValue(remote.url)
    if (!url) return null
    const headers: Record<string, string> = {}
    for (const header of arrayValue(remote.headers).map(record).filter((item): item is JsonRecord => item !== null)) {
      const headerName = stringValue(header.name)
      if (!headerName) continue
      const envName = `MCP_${serverName.replace(/-/g, '_').toUpperCase()}_${headerName.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}`.slice(0, 60)
      headers[headerName] = `\${${envName}}`
      requiredEnv.push(envName)
    }
    config = { serverName, transport: 'streamable-http', url }
    if (Object.keys(headers).length > 0) config.headers = headers
  } else {
    return null
  }
  const repository = record(server.repository)
  const sourceUrl = stringValue(repository?.url) ?? stringValue(server.websiteUrl)
  const source = npmPackage ? 'MCP Registry · npm' : 'MCP Registry · remote'
  return {
    id: `mcp-registry-${hashText(name)}`,
    kind: 'mcp',
    name: displayName,
    description: stringValue(server.description) ?? '来自官方 MCP Registry 的服务器。',
    author: stringValue(repository?.url)?.replace(/^https?:\/\/(?:www\.)?github\.com\//, '').split('/')[0] ?? 'MCP 社区',
    version,
    category: npmPackage ? '本地 MCP' : '远程 MCP',
    tags: ['MCP Registry', transportLabel],
    verified: false,
    trust: 'official',
    permissions: npmPackage ? ['启动 npx 子进程'] : ['访问远程 MCP 服务'],
    source,
    sourceUrl,
    requiredEnv: [...new Set(requiredEnv)],
    row: { id: `mcp-registry-${hashText(name)}`, name: MCP_PLUGIN, config },
  }
}

async function fetchDshMcpSnapshot(): Promise<JsonRecord> {
  let apiPayload: JsonRecord | null = null
  try {
    apiPayload = record(await fetchJson(DSH_MCP_CATALOG_API_URL, 4_000))
  } catch {
    /* API 限流时再走 raw CDN */
  }
  if (apiPayload) {
    const encoded = stringValue(apiPayload.content)
    if (encoded) {
      const decoded = Buffer.from(encoded.replace(/\s+/g, ''), 'base64').toString('utf8')
      const snapshot = record(JSON.parse(decoded))
      if (snapshot) return snapshot
    }
  }
  try {
    const payload = record(await fetchJson(DSH_MCP_CATALOG_URL, 4_000))
    if (payload) return payload
  } catch {
    // GitHub raw 429/网络波动时最终由上层 Promise.allSettled 处理。
  }
  throw new Error('DSH MCP Market snapshot 不可用')
}

async function fetchDshMcpCatalog(query: string): Promise<MarketItem[]> {
  const payload = await fetchDshMcpSnapshot()
  const updated = stringValue(payload.updated) ?? 'snapshot'
  const rows: McpMarketItem[] = []
  for (const raw of arrayValue(payload?.servers)) {
    const server = record(raw)
    const name = stringValue(server?.name)
    if (!name) continue
    const transport = server?.transport === 'streamable-http' ? 'streamable-http' : 'stdio'
    const serverName = safeServerName(name)
    const requiredEnv = isStringArray(server?.envHint) ? server.envHint.filter((env) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(env)) : []
    const config: Record<string, unknown> = { serverName, transport }
    if (transport === 'stdio') {
      const command = stringValue(server?.command)
      const args = arrayValue(server?.args).filter((value): value is string => typeof value === 'string')
      if (!command) continue
      config.command = command
      config.args = args
    } else {
      const url = stringValue(server?.url)
      if (!url || !/^https?:\/\//i.test(url)) continue
      config.url = url
    }
    if (requiredEnv.length > 0) config.env = Object.fromEntries(requiredEnv.map((env) => [env, `\${${env}}`]))
    const descriptionValue = record(server?.description)
    const description = stringValue(descriptionValue?.zh) ?? stringValue(descriptionValue?.en) ?? '来自 DSH MCP Market 的精选 MCP 服务器。'
    const homepage = stringValue(server?.homepage)
    const category = stringValue(server?.category) ?? '社区精选'
    const tags = isStringArray(server?.tags) ? server.tags.slice(0, 8) : []
    rows.push({
      id: `mcp-dsh-catalog-${hashText(name)}`,
      kind: 'mcp',
      name,
      description,
      author: 'DSH MCP Market',
      version: `snapshot ${updated}`,
      category,
      tags: [...new Set(['DSH MCP Market', ...tags])],
      verified: false,
      trust: 'curated',
      permissions: transport === 'stdio' ? ['启动本地 MCP 子进程'] : ['访问远程 MCP 服务'],
      source: 'DSH MCP Market · curated',
      sourceUrl: homepage,
      requiredEnv,
      row: { id: `mcp-dsh-catalog-${hashText(name)}`, name: MCP_PLUGIN, config },
    })
  }
  return rows.filter((item) => matchesQuery(item, query))
}

async function fetchOfficialMcpRegistry(query: string): Promise<MarketItem[]> {
  const latest = new Map<string, JsonRecord>()
  let cursor = ''
  const seenCursors = new Set<string>()
  // 官方 Registry 使用 cursor 分页；首屏最多拉取 2 页，剩余条目通过搜索关键词发现，避免阻塞桌面启动。
  for (let page = 0; page < 2; page++) {
    const params = new URLSearchParams({ limit: '100' })
    if (query.trim()) params.set('search', query.trim())
    if (cursor) params.set('cursor', cursor)
    let payload: JsonRecord | null
    try {
      payload = record(await fetchJson(`${MCP_REGISTRY_URL}?${params.toString()}`, 9_000))
    } catch (err) {
      // 分页后续页失败时保留已经拿到的第一页；只有第一页失败才让另一条 MCP 源接管。
      if (page === 0) throw err
      break
    }
    for (const entry of arrayValue(payload?.servers)) {
      const server = record(record(entry)?.server)
      const name = stringValue(server?.name)
      if (!server || !name) continue
      const current = latest.get(name)
      if (!current || compareVersions(stringValue(server.version) ?? '0', stringValue(current.version) ?? '0') > 0) latest.set(name, server)
    }
    const next = stringValue(record(payload?.metadata)?.nextCursor)
    if (!next || seenCursors.has(next)) break
    seenCursors.add(next)
    cursor = next
  }
  return [...latest.values()].map(registryServerToMcp).filter((item): item is McpMarketItem => item !== null)
}

interface RemoteCatalogResult {
  items: MarketItem[]
  warning?: string
}

async function fetchMcpCatalog(query: string): Promise<RemoteCatalogResult> {
  const results = await Promise.allSettled([fetchDshMcpCatalog(query), fetchOfficialMcpRegistry(query)])
  const items: MarketItem[] = []
  const errors: string[] = []
  for (const result of results) {
    if (result.status === 'fulfilled') items.push(...result.value)
    else errors.push(result.reason instanceof Error ? result.reason.message : String(result.reason))
  }
  if (items.length === 0 && errors.length > 0) throw new Error(errors.join('；'))
  return { items: dedupeMarketItems(items), warning: errors.length > 0 ? `部分 MCP 来源不可用：${errors.join('；')}` : undefined }
}

async function fetchSkillsMp(query: string): Promise<MarketItem[]> {
  const params = new URLSearchParams({ q: query.trim() || 'skill', limit: '50', sortBy: 'stars' })
  const payload = record(await fetchJson(`${SKILLSMP_SEARCH_URL}?${params.toString()}`))
  const data = record(payload?.data)
  return arrayValue(data?.skills).map((raw): SkillMarketItem | null => {
    const skill = record(raw)
    const githubUrl = stringValue(skill?.githubUrl)
    const name = stringValue(skill?.name)
    if (!githubUrl || !name) return null
    const stars = Number(skill?.stars ?? 0)
    const language = stringValue(skill?.contentLanguage)
    return {
      id: `skillsmp-${stringValue(skill?.id) ?? hashText(githubUrl)}`,
      kind: 'skill',
      name,
      description: stringValue(skill?.description) ?? '来自 SkillsMP 的 Agent Skill。',
      author: stringValue(skill?.author) ?? 'SkillsMP 社区',
      version: 'GitHub source · 安装时读取仓库',
      category: language ? `SkillsMP · ${language}` : 'SkillsMP',
      tags: [...new Set(['SkillsMP', ...(language ? [language] : [])])],
      verified: false,
      trust: 'community',
      permissions: ['写入用户级 ~/.dsh/skills', '从 GitHub 下载 skill 文件'],
      source: 'SkillsMP · GitHub source',
      sourceUrl: stringValue(skill?.skillUrl) ?? githubUrl,
      popularity: stars,
      install: { type: 'github', url: githubUrl, name },
    }
  }).filter((item): item is SkillMarketItem => item !== null)
}

async function fetchClawHubSkills(query: string): Promise<MarketItem[]> {
  const params = new URLSearchParams({ q: query.trim() || 'skill', limit: '50', nonSuspiciousOnly: 'true' })
  const payload = record(await fetchJson(`${CLAWHUB_SEARCH_URL}?${params.toString()}`))
  return arrayValue(payload?.results).map((raw): SkillMarketItem | null => {
    const result = record(raw)
    const native = record(result?.native)
    const nativeSkill = record(native?.skill)
    const install = record(result?.install)
    const reference = stringValue(install?.reference)
    const owner = stringValue(result?.ownerHandle) ?? stringValue(native?.ownerHandle) ?? reference?.split('/')[0]
    const slug = stringValue(result?.slug) ?? reference?.split('/').pop()
    if (!owner || !slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return null
    const stats = record(nativeSkill?.stats)
    const displayName = stringValue(result?.displayName) ?? slug
    const version = stringValue(result?.version) ?? 'latest'
    // 某些 ClawHub 响应会同时带规范 name；只有合法 skill 名才用于已安装匹配，
    // 否则保留 slug，避免把展示标题（如 "Code Review"）当成目录名。
    const canonicalName = [stringValue(result?.name), stringValue(nativeSkill?.name), displayName]
      .find((value) => value !== undefined && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) ?? slug
    const summary = stringValue(result?.summary) ?? stringValue(nativeSkill?.summary) ?? '来自 ClawHub 的 Agent Skill。'
    const topics = isStringArray(nativeSkill?.topics) ? nativeSkill.topics.slice(0, 8) : []
    const downloads = Number(result?.downloads ?? stats?.downloads ?? 0)
    const canonical = stringValue(result?.canonicalUrl) ?? `/${owner}/skills/${slug}`
    const sourceUrl = canonical.startsWith('http') ? canonical : `https://clawhub.ai${canonical}`
    return {
      id: `clawhub-${hashText(`${owner}/${slug}`)}`,
      kind: 'skill',
      name: displayName,
      description: summary,
      author: stringValue(record(result?.owner)?.displayName) ?? owner,
      version,
      category: topics[0] ?? 'ClawHub',
      tags: [...new Set(['ClawHub', ...topics])],
      verified: result?.official === true,
      trust: result?.official === true ? 'official' : 'community',
      permissions: ['写入用户级 ~/.dsh/skills', '从 ClawHub 下载 SKILL.md'],
      source: result?.official === true ? 'ClawHub · official' : 'ClawHub · community',
      sourceUrl,
      popularity: downloads,
      install: { type: 'clawhub', owner, slug, version, name: canonicalName },
    }
  }).filter((item): item is SkillMarketItem => item !== null)
}

async function fetchSkillCatalog(query: string): Promise<RemoteCatalogResult> {
  const results = await Promise.allSettled([fetchClawHubSkills(query), fetchSkillsMp(query)])
  const items: MarketItem[] = []
  const errors: string[] = []
  for (const result of results) {
    if (result.status === 'fulfilled') items.push(...result.value)
    else errors.push(result.reason instanceof Error ? result.reason.message : String(result.reason))
  }
  if (items.length === 0 && errors.length > 0) throw new Error(errors.join('；'))
  return { items: dedupeMarketItems(items), warning: errors.length > 0 ? `部分 Skills 来源不可用：${errors.join('；')}` : undefined }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/** 缓存和远程响应都必须经过同一层运行时校验，不能把未知 JSON 直接送进安装链路。 */
function isMarketItem(value: unknown): value is MarketItem {
  const item = record(value)
  if (!item || typeof item.id !== 'string' || typeof item.kind !== 'string' || typeof item.name !== 'string') return false
  if (typeof item.description !== 'string' || typeof item.author !== 'string' || typeof item.version !== 'string') return false
  if (typeof item.category !== 'string' || !isStringArray(item.tags) || typeof item.verified !== 'boolean' || !isStringArray(item.permissions)) return false
  if (item.kind === 'plugin') return typeof item.spec === 'string' && typeof item.packageName === 'string'
  if (item.kind === 'mcp') {
    const row = record(item.row)
    return !!row && typeof row.id === 'string' && typeof row.name === 'string' && !!record(row.config) && isStringArray(item.requiredEnv)
  }
  if (item.kind === 'skill') {
    const install = record(item.install)
    if (!install || typeof install.name !== 'string') return false
    if (install.type === 'template') return typeof install.description === 'string' && typeof install.body === 'string'
    if (install.type === 'github') return typeof install.url === 'string'
    return install.type === 'clawhub' && typeof install.owner === 'string' && typeof install.slug === 'string' && typeof install.version === 'string'
  }
  return false
}

function validateMarketItems(value: unknown): MarketItem[] {
  return arrayValue(value).filter(isMarketItem).map(cloneMarketItem)
}

interface MarketFetchOptions {
  /** userData/market-cache；未传时只使用进程内缓存，便于单测。 */
  cacheDir?: string
}

interface MarketCacheFile {
  schemaVersion: 1
  kind: MarketKind
  fetchedAt: number
  items: MarketItem[]
}

function readDiskMarketCache(cacheDir: string | undefined, kind: MarketKind): MarketItem[] {
  if (!cacheDir) return []
  const file = join(cacheDir, `market-${kind}.json`)
  if (!existsSync(file)) return []
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    const cache = record(parsed)
    if (cache?.schemaVersion !== 1 || cache.kind !== kind) return []
    return validateMarketItems(cache.items)
  } catch {
    return []
  }
}

function writeDiskMarketCache(cacheDir: string | undefined, kind: MarketKind, items: MarketItem[]): void {
  if (!cacheDir) return
  try {
    mkdirSync(cacheDir, { recursive: true })
    const file = join(cacheDir, `market-${kind}.json`)
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
    const payload: MarketCacheFile = { schemaVersion: 1, kind, fetchedAt: Date.now(), items: items.map(cloneMarketItem) }
    const text = JSON.stringify(payload)
    if (text.length > MARKET_MAX_RESPONSE_BYTES) return
    writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 })
    try {
      renameSync(tmp, file)
    } catch {
      // Windows 可能不允许 rename 覆盖现有文件；缓存可丢，但不能影响市场使用。
      try {
        unlinkSync(file)
        renameSync(tmp, file)
      } catch {
        try {
          unlinkSync(tmp)
        } catch {
          /* ignore cache residue */
        }
      }
    }
  } catch {
    /* 缓存失败不应阻断在线市场 */
  }
}

const remoteMarketCache = new Map<string, { expiresAt: number; items: MarketItem[] }>()
const MAX_MEMORY_MARKET_CACHE_ENTRIES = 32

function cacheRemoteMarketItems(key: string, items: MarketItem[]): void {
  remoteMarketCache.delete(key)
  while (remoteMarketCache.size >= MAX_MEMORY_MARKET_CACHE_ENTRIES) {
    const oldest = remoteMarketCache.keys().next().value
    if (typeof oldest !== 'string') break
    remoteMarketCache.delete(oldest)
  }
  remoteMarketCache.set(key, { expiresAt: Date.now() + MARKET_CACHE_TTL_MS, items })
}

/** 从真实在线目录加载市场；网络失败时依次使用磁盘缓存与随包精选目录。 */
export async function fetchMarketItems(
  kind: MarketKind,
  query = '',
  options: MarketFetchOptions = {},
): Promise<{ items: MarketItem[]; online: boolean; cached: boolean; error?: string }> {
  const normalizedQuery = query.trim().slice(0, 120)
  const cacheKey = `${kind}:${normalizedQuery.toLowerCase()}`
  const cached = remoteMarketCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) {
    return { items: cached.items.map(cloneMarketItem), online: true, cached: false }
  }
  const diskItems = readDiskMarketCache(options.cacheDir, kind)
  const bundledItems = listMarketItems(kind)
  const fallbackItems = (): MarketItem[] => dedupeMarketItems([
    ...diskItems.filter((item) => matchesQuery(item, normalizedQuery)),
    ...bundledItems.filter((item) => matchesQuery(item, normalizedQuery)),
  ]).map(cloneMarketItem)
  try {
    let rawRemote: MarketItem[]
    let sourceWarning: string | undefined
    if (kind === 'plugin') {
      rawRemote = await fetchCuratedDshPlugins()
    } else if (kind === 'mcp') {
      const result = await fetchMcpCatalog(normalizedQuery)
      rawRemote = result.items
      sourceWarning = result.warning
    } else {
      const result = await fetchSkillCatalog(normalizedQuery)
      rawRemote = result.items
      sourceWarning = result.warning
    }
    const remote = validateMarketItems(rawRemote)
    // 在线成功时以当前远程快照为准，不把旧缓存中的过期条目重新混入；缓存只用于断网回退。
    const all = dedupeMarketItems([...bundledItems, ...remote])
    const items = all.filter((item) => matchesQuery(item, normalizedQuery)).map(cloneMarketItem)
    cacheRemoteMarketItems(cacheKey, items)
    if (!normalizedQuery) writeDiskMarketCache(options.cacheDir, kind, all)
    return { items, online: true, cached: false, error: sourceWarning }
  } catch (err) {
    const items = fallbackItems()
    return {
      items,
      online: false,
      cached: diskItems.length > 0,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export interface PluginPreflightResult {
  ok: boolean
  normalizedSpec?: string
  packageName?: string
  version?: string
  bundle?: boolean
  locked?: boolean
  warning?: string
  error?: string
}

function parseNpmSpec(spec: string): { name: string; requestedVersion?: string } | null {
  const value = spec.trim()
  if (!value || value.startsWith('.') || value.startsWith('/') || value.startsWith('git+') || value.startsWith('http')) return null
  const match = value.startsWith('@')
    ? value.match(/^(@[^/]+\/[^@]+?)(?:@(.+))?$/)
    : value.match(/^([^@/]+?)(?:@(.+))?$/)
  if (!match) return null
  return { name: match[1], requestedVersion: match[2] }
}

function isBundlePackage(pkg: JsonRecord): boolean {
  const dsh = record(pkg.dsh)
  return !!dsh && !!record(dsh.bundle)
}

async function preflightNpmPlugin(spec: string): Promise<PluginPreflightResult> {
  const parsed = parseNpmSpec(spec)
  if (!parsed) return { ok: false, error: '市场预检暂不支持该安装来源；请使用 npm 包名或 GitHub 仓库。' }
  const packageUrl = `https://registry.npmjs.org/${parsed.name.split('/').map(encodeURIComponent).join('/')}`
  const packument = record(await fetchJson(packageUrl))
  if (!packument) return { ok: false, error: `无法读取 npm 包信息：${parsed.name}` }
  const versions = record(packument.versions)
  if (!versions) return { ok: false, error: `npm 包没有可用版本：${parsed.name}` }
  const latest = stringValue(record(packument['dist-tags'])?.latest)
  const requested = parsed.requestedVersion && parsed.requestedVersion !== 'latest' ? parsed.requestedVersion : latest
  if (!requested) return { ok: false, error: `无法解析 npm 包版本：${parsed.name}` }
  const pkg = record(versions[requested])
  if (!pkg) return { ok: false, error: `npm 包版本不存在：${parsed.name}@${requested}` }
  if (!isBundlePackage(pkg)) {
    return { ok: false, packageName: parsed.name, version: requested, bundle: false, error: `「${parsed.name}@${requested}」没有声明 dsh.bundle，拒绝从插件市场安装。` }
  }
  return {
    ok: true,
    normalizedSpec: `${parsed.name}@${requested}`,
    packageName: parsed.name,
    version: requested,
    bundle: true,
    locked: true,
  }
}

function parseGitHubPluginSpec(spec: string): { owner: string; repo: string; ref: string } | null {
  const match = spec.trim().match(/^github:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:#(.+))?$/)
  if (!match) return null
  return { owner: match[1], repo: match[2], ref: match[3] ?? 'main' }
}

async function preflightGitHubPlugin(spec: string): Promise<PluginPreflightResult> {
  const parsed = parseGitHubPluginSpec(spec)
  if (!parsed) return { ok: false, error: 'GitHub 插件 spec 无效。' }
  const base = `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`
  let sha = /^[0-9a-f]{7,40}$/i.test(parsed.ref) ? parsed.ref : ''
  let lockWarning = ''
  if (!sha) {
    try {
      const commit = record(await fetchJson(`${base}/commits/${encodeURIComponent(parsed.ref)}`))
      sha = stringValue(commit?.sha) ?? ''
    } catch {
      // GitHub 未认证 API 有严格限流；仍可先按 ref 验证 package.json，但明确告知用户未锁到 commit。
      lockWarning = 'GitHub API 当前限流，已验证分支 manifest，但本次未能锁定 commit。'
    }
  }
  const ref = sha || parsed.ref
  // jsDelivr 作为 GitHub raw 的 CDN fallback，避免 GitHub unauthenticated API/raw 限流把合法插件全部挡住。
  const packageUrl = `https://cdn.jsdelivr.net/gh/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}@${encodeURIComponent(ref)}/package.json`
  const pkg = record(await fetchJson(packageUrl))
  if (!pkg || !isBundlePackage(pkg)) {
    return { ok: false, error: `GitHub 仓库 ${parsed.owner}/${parsed.repo} 没有声明 dsh.bundle，拒绝从插件市场安装。` }
  }
  const version = stringValue(pkg.version)
  return {
    ok: true,
    normalizedSpec: `github:${parsed.owner}/${parsed.repo}#${ref}`,
    packageName: stringValue(pkg.name),
    version,
    bundle: true,
    locked: Boolean(sha),
    warning: lockWarning || undefined,
  }
}

/** 插件市场安装前预检：确认 dsh.bundle，并把 GitHub 分支解析为不可变 commit。 */
export async function preflightPluginSpec(spec: string): Promise<PluginPreflightResult> {
  const value = spec.trim()
  try {
    if (value.startsWith('github:')) return await preflightGitHubPlugin(value)
    return await preflightNpmPlugin(value)
  } catch (err) {
    return { ok: false, error: `插件预检失败：${err instanceof Error ? err.message : String(err)}` }
  }
}