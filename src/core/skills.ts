// Skills 系统核心：按 DSH rank 规则扫描 skill 根目录、frontmatter 解析、创建/可见性切换
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { parseDocument, stringify } from 'yaml'

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
