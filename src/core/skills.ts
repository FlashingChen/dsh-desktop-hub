// Skills 系统核心：按 DSH rank 规则扫描 skill 根目录、frontmatter 解析、创建/可见性切换、zip/GitHub 导入
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { parseDocument, stringify } from 'yaml'
import AdmZip from 'adm-zip'

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export type SkillSource = 'project-dsh' | 'project-agents' | 'custom' | 'user-dsh' | 'user-agents' | 'bundled'

export interface SkillScanOptions {
  dshHome?: string
  agentsHome?: string
  projectRoot?: string
  customDirs?: string[]
  bundledDir?: string
}

export interface SkillSummary {
  name: string
  description: string
  whenToUse?: string
  modelInvocable: boolean
  userInvocable: boolean
  source: SkillSource
  root: string
  path: string
  kind: 'bundle' | 'flat'
  shadowed: boolean
  bodyPreview: string
}

interface RawSkill {
  name: string
  description: string
  whenToUse?: string
  modelInvocable: boolean
  userInvocable: boolean
  source: SkillSource
  root: string
  path: string
  kind: 'bundle' | 'flat'
  body: string
}

const RANK: Record<SkillSource, number> = {
  'project-dsh': 100,
  'project-agents': 200,
  custom: 300,
  'user-dsh': 400,
  'user-agents': 500,
  bundled: 600,
}

/** 解析 SKILL.md / <name>.md：frontmatter + 正文 */
export function parseSkillFile(text: string): { meta: Record<string, unknown>; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!m) return { meta: {}, body: text }
  const doc = parseDocument(m[1])
  const meta = doc.errors.length > 0 ? {} : ((doc.toJS() ?? {}) as Record<string, unknown>)
  return { meta, body: m[2].replace(/^\n/, '') }
}

function skillNameFromDir(name: string): string | null {
  return KEBAB.test(name) ? name : null
}

/** 扫描单个 skill 根目录 */
function scanRoot(root: string, source: SkillSource, out: RawSkill[]): void {
  if (!existsSync(root)) return
  const entries = readdirSync(root, { withFileTypes: true })
  for (const e of entries) {
    const p = join(root, e.name)
    if (e.isDirectory()) {
      const skill = join(p, 'SKILL.md')
      const name = skillNameFromDir(e.name)
      if (name && existsSync(skill)) {
        const text = readFileSync(skill, 'utf8')
        const { meta, body } = parseSkillFile(text)
        const desc = typeof meta.description === 'string' ? meta.description : ''
        out.push({
          name,
          description: desc,
          whenToUse: typeof meta.whenToUse === 'string' ? meta.whenToUse : undefined,
          modelInvocable: meta['disable-model-invocation'] !== true,
          userInvocable: meta['user-invocable'] !== false,
          source,
          root,
          path: skill,
          kind: 'bundle',
          body,
        })
      }
    } else if (e.name.endsWith('.md')) {
      const name = skillNameFromDir(e.name.slice(0, -3))
      if (!name) continue
      const text = readFileSync(p, 'utf8')
      const { meta, body } = parseSkillFile(text)
      const desc = typeof meta.description === 'string' ? meta.description : ''
      out.push({
        name,
        description: desc,
        whenToUse: typeof meta.whenToUse === 'string' ? meta.whenToUse : undefined,
        modelInvocable: meta['disable-model-invocation'] !== true,
        userInvocable: meta['user-invocable'] !== false,
        source,
        root,
        path: p,
        kind: 'flat',
        body,
      })
    }
  }
}

/** 扫描全部 skill 根（rank 升序），低 rank 优先，同名高 rank 标 shadowed */
export function scanSkills(opts: SkillScanOptions = {}): SkillSummary[] {
  const dshHome = opts.dshHome ?? join(process.env.HOME ?? '', '.dsh')
  const agentsHome = opts.agentsHome ?? join(process.env.HOME ?? '', '.agents')
  const roots: { dir: string; source: SkillSource }[] = []
  if (opts.projectRoot) {
    roots.push({ dir: join(opts.projectRoot, '.dsh', 'skills'), source: 'project-dsh' })
    roots.push({ dir: join(opts.projectRoot, '.agents', 'skills'), source: 'project-agents' })
  }
  for (const dir of opts.customDirs ?? []) roots.push({ dir, source: 'custom' })
  roots.push({ dir: join(dshHome, 'skills'), source: 'user-dsh' })
  roots.push({ dir: join(agentsHome, 'skills'), source: 'user-agents' })
  if (opts.bundledDir) roots.push({ dir: opts.bundledDir, source: 'bundled' })

  const all: RawSkill[] = []
  for (const { dir, source } of roots) scanRoot(dir, source, all)

  // 按 (name, rank) 取胜者，其余 shadowed
  const winner = new Map<string, RawSkill>()
  for (const s of all) {
    const cur = winner.get(s.name)
    if (!cur || RANK[s.source] < RANK[cur.source]) winner.set(s.name, s)
  }
  return all
    .map((s) => ({
      name: s.name,
      description: s.description,
      whenToUse: s.whenToUse,
      modelInvocable: s.modelInvocable,
      userInvocable: s.userInvocable,
      source: s.source,
      root: s.root,
      path: s.path,
      kind: s.kind,
      shadowed: winner.get(s.name) !== s,
      bodyPreview: s.body.slice(0, 120),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** 组装带 frontmatter 的 SKILL.md 文本 */
export function renderSkillFile(input: {
  name: string
  description: string
  whenToUse?: string
  modelInvocable: boolean
  userInvocable: boolean
  body: string
}): string {
  const meta: Record<string, unknown> = { name: input.name, description: input.description }
  if (input.whenToUse) meta.whenToUse = input.whenToUse
  if (!input.modelInvocable) meta['disable-model-invocation'] = true
  if (!input.userInvocable) meta['user-invocable'] = false
  const body = input.body.replace(/^\n+/, '').replace(/\s+$/, '') + '\n'
  return `---\n${stringify(meta).trimEnd()}\n---\n${body}`
}

/** 在指定根目录创建 bundle skill（<name>/SKILL.md） */
export function createSkill(opts: {
  root: string
  name: string
  description: string
  body: string
  whenToUse?: string
  modelInvocable?: boolean
  userInvocable?: boolean
  overwrite?: boolean
}): string {
  const name = opts.name.trim()
  if (!KEBAB.test(name)) throw new Error(`skill 名称必须是 kebab-case: ${name}`)
  const dir = join(opts.root, name)
  const file = join(dir, 'SKILL.md')
  if (existsSync(file) && !opts.overwrite) throw new Error(`skill 已存在: ${name}`)
  mkdirSync(dir, { recursive: true })
  const text = renderSkillFile({
    name,
    description: opts.description,
    whenToUse: opts.whenToUse,
    modelInvocable: opts.modelInvocable ?? true,
    userInvocable: opts.userInvocable ?? true,
    body: opts.body,
  })
  writeFileSync(file, text)
  return file
}

/** 切换可见性并回写文件（model 可见 = 移除 disable-model-invocation） */
export function setInvocation(path: string, kind: 'model' | 'user', value: boolean): string {
  const text = readFileSync(path, 'utf8')
  const { meta, body } = parseSkillFile(text)
  const name = typeof meta.name === 'string' && KEBAB.test(meta.name) ? meta.name : dirname(path).split('/').pop() ?? ''
  if (!name) throw new Error('无法确定 skill 名称')
  if (kind === 'model') {
    if (value) delete meta['disable-model-invocation']
    else meta['disable-model-invocation'] = true
  } else {
    if (value) delete meta['user-invocable']
    else meta['user-invocable'] = false
  }
  const next = renderSkillFile({
    name,
    description: typeof meta.description === 'string' ? meta.description : '',
    whenToUse: typeof meta.whenToUse === 'string' ? meta.whenToUse : undefined,
    modelInvocable: meta['disable-model-invocation'] !== true,
    userInvocable: meta['user-invocable'] !== false,
    body,
  })
  writeFileSync(path, next)
  return next
}

export interface SkillImportResult {
  name: string
  file: string
  installed: string[]
}

function skillNameOf(metaName: unknown, dirName: string): string {
  if (typeof metaName === 'string' && KEBAB.test(metaName)) return metaName
  if (KEBAB.test(dirName)) return dirName
  throw new Error(`无法确定合法的 kebab-case skill 名称（frontmatter: ${JSON.stringify(metaName)}，目录: ${dirName}）`)
}

function writeBundleFromZip(zip: AdmZip, sourceDir: string, root: string, overwrite: boolean): SkillImportResult {
  const entries = zip.getEntries()
  const prefix = sourceDir ? `${sourceDir.replace(/\/$/, '')}/` : ''
  const skillEntry = entries.find(
    (e) => !e.isDirectory && e.entryName.startsWith(prefix) && e.entryName.endsWith('/SKILL.md'),
  )
  if (!skillEntry) throw new Error('压缩包中未找到 SKILL.md，不是有效的 skill 包')
  const skillDir = skillEntry.entryName.slice(0, skillEntry.entryName.length - '/SKILL.md'.length)
  const dirName = skillDir.split('/').pop() ?? ''
  const text = skillEntry.getData().toString('utf8')
  const { meta } = parseSkillFile(text)
  const name = skillNameOf(meta.name, dirName)
  const target = join(root, name)
  const targetSkill = join(target, 'SKILL.md')
  if (existsSync(targetSkill) && !overwrite) throw new Error(`skill 已存在: ${name}（如需覆盖请再次确认）`)
  mkdirSync(target, { recursive: true })
  const installed: string[] = []
  for (const e of entries) {
    if (e.isDirectory) continue
    if (!e.entryName.startsWith(skillDir)) continue
    const rel = e.entryName.slice(skillDir.length).replace(/^\/+/, '')
    const dest = join(target, rel)
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, e.getData())
    installed.push(dest)
  }
  return { name, file: targetSkill, installed }
}

/** 从 zip 容器（.skill 或 .zip）导入 skill 包；支持根/单层子目录含 SKILL.md */
export function importSkillFromZip(buffer: Buffer, opts: { root: string; overwrite?: boolean }): SkillImportResult {
  const zip = new AdmZip(buffer)
  const entries = zip.getEntries()
  const hasSkill = entries.some((e) => !e.isDirectory && e.entryName.replace(/\\/g, '/').endsWith('/SKILL.md'))
  if (!hasSkill) throw new Error('压缩包中未找到 SKILL.md，不是有效的 skill 包（.skill 或含 SKILL.md 的 zip）')
  // 若 zip 顶层是单一包裹目录（{repo}-{branch}/），自动剥掉
  const topLevels = new Set(
    entries
      .filter((e) => !e.isDirectory)
      .map((e) => e.entryName.replace(/\\/g, '/').split('/')[0]),
  )
  if (topLevels.size === 1) {
    return writeBundleFromZip(zip, [...topLevels][0], opts.root, opts.overwrite ?? false)
  }
  return writeBundleFromZip(zip, '', opts.root, opts.overwrite ?? false)
}

export interface GitHubUrl {
  owner: string
  repo: string
  branch: string
  subPath: string
}

/** 解析 GitHub skill 仓库链接（支持 /tree/<branch>/<path> 与根仓库） */
export function parseGitHubSkillUrl(url: string): GitHubUrl {
  const m = url.trim().match(/^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/|$)/)
  if (!m) throw new Error(`不是有效的 GitHub 链接: ${url}`)
  const rest = url.trim().slice(m[0].length)
  if (!rest) return { owner: m[1], repo: m[2], branch: 'main', subPath: '' }
  const tree = rest.match(/^tree\/([^/]+)(?:\/(.*))?$/)
  if (tree) return { owner: m[1], repo: m[2], branch: tree[1], subPath: tree[2] ?? '' }
  const blob = rest.match(/^blob\/([^/]+)\/(.+)\.md$/)
  if (blob) return { owner: m[1], repo: m[2], branch: blob[1], subPath: blob[2] }
  throw new Error(`暂不支持该 GitHub 路径（支持仓库根或 /tree/<branch>/<path>）: ${url}`)
}

/** 从 GitHub 仓库下载并导入 skill（codeload zip → 定位 SKILL.md → 安装） */
export async function importSkillFromGitHub(
  url: string,
  opts: { root: string; overwrite?: boolean },
): Promise<SkillImportResult> {
  const { owner, repo, branch, subPath } = parseGitHubSkillUrl(url)
  const candidates = [branch, branch === 'main' ? 'master' : branch].filter((v, i, a) => a.indexOf(v) === i)
  let buffer: Buffer | null = null
  for (const ref of candidates) {
    const url = `https://codeload.github.com/${owner}/${repo}/zip/refs/heads/${encodeURIComponent(ref)}`
    for (let attempt = 0; attempt < 3 && !buffer; attempt++) {
      try {
        const dl = await fetch(url)
        if (dl.ok) buffer = Buffer.from(await dl.arrayBuffer())
      } catch {
        /* 网络瞬时失败，重试 */
      }
    }
    if (buffer) break
  }
  if (!buffer) throw new Error(`下载失败：仓库 ${owner}/${repo} 分支 ${branch} 不存在或不可访问`)
  const zip = new AdmZip(buffer)
  const entries = zip.getEntries()
  const top = entries.filter((e) => !e.isDirectory).map((e) => e.entryName.split('/')[0])
  const topLevel = [...new Set(top)][0] ?? ''
  const sourceDir = [topLevel, subPath].filter(Boolean).join('/')
  return writeBundleFromZip(zip, sourceDir, opts.root, opts.overwrite ?? false)
}
