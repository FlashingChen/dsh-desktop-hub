// M4 单元测试：skill 扫描 / frontmatter / 创建 / 可见性切换
import test from 'node:test'
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const mod = await import(join(root, 'dist', 'core', 'skills.js'))
const { scanSkills, parseSkillFile, renderSkillFile, createSkill, setInvocation } = mod

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'skills-'))
  // 项目级 bundle skill（rank 100）
  mkdirSync(join(dir, 'proj', '.dsh', 'skills', 'foo'), { recursive: true })
  writeFileSync(
    join(dir, 'proj', '.dsh', 'skills', 'foo', 'SKILL.md'),
    '---\nname: foo\ndescription: 项目级 skill\ndisable-model-invocation: true\n---\n正文 A\n',
  )
  // 项目级扁平 skill（rank 100）
  writeFileSync(join(dir, 'proj', '.dsh', 'skills', 'bar.md'), '---\nname: bar\ndescription: 扁平 skill\n---\n正文 B\n')
  // 用户级同名 foo（rank 400，应 shadowed）
  mkdirSync(join(dir, 'home', 'skills', 'foo'), { recursive: true })
  writeFileSync(join(dir, 'home', 'skills', 'foo', 'SKILL.md'), '---\nname: foo\ndescription: 用户级同名\n---\n正文 C\n')
  // 用户级正常 skill
  mkdirSync(join(dir, 'home', 'skills', 'baz'), { recursive: true })
  writeFileSync(join(dir, 'home', 'skills', 'baz', 'SKILL.md'), '---\nname: baz\ndescription: 用户级\nuser-invocable: false\n---\n正文 D\n')
  // 非法名称目录应被忽略
  mkdirSync(join(dir, 'home', 'skills', 'Bad Name!'), { recursive: true })
  writeFileSync(join(dir, 'home', 'skills', 'Bad Name!', 'SKILL.md'), '---\nname: Bad Name!\n---\n')
  return dir
}

test('scanSkills 按 rank 合并并标记 shadowed', () => {
  const dir = fixture()
  try {
    const skills = scanSkills({ projectRoot: join(dir, 'proj'), dshHome: join(dir, 'home') })
    const foo = skills.filter((s) => s.name === 'foo')
    assert.equal(foo.length, 2, '同名应列出两个来源')
    const projFoo = foo.find((s) => s.source === 'project-dsh')
    const userFoo = foo.find((s) => s.source === 'user-dsh')
    assert.equal(projFoo?.shadowed, false, '低 rank 项目级应为有效')
    assert.equal(userFoo?.shadowed, true, '高 rank 用户级应 shadowed')
    assert.equal(projFoo?.modelInvocable, false, 'disable-model-invocation 应生效')
    assert.equal(skills.find((s) => s.name === 'bar')?.kind, 'flat')
    assert.equal(skills.find((s) => s.name === 'baz')?.userInvocable, false)
    assert.ok(!skills.some((s) => s.name.includes('Bad')), '非法名称应被忽略')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('parseSkillFile / renderSkillFile 往返一致', () => {
  const text = renderSkillFile({ name: 'my-skill', description: '描述', modelInvocable: false, userInvocable: true, body: '正文' })
  const { meta, body } = parseSkillFile(text)
  assert.equal(meta.name, 'my-skill')
  assert.equal(meta['disable-model-invocation'], true)
  assert.equal(meta['user-invocable'], undefined)
  assert.equal(body.trim(), '正文')
})

test('createSkill 校验 kebab-case 并落盘', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skills-'))
  try {
    const file = createSkill({ root: join(dir, 'skills'), name: 'hello-world', description: '测试', body: '内容' })
    const text = readFileSync(file, 'utf8')
    assert.ok(text.startsWith('---\n'))
    assert.ok(text.includes('name: hello-world'))
    assert.throws(() => createSkill({ root: join(dir, 'skills'), name: 'Hello World!', description: '', body: '' }), /kebab-case/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('setInvocation 切换 model/user 可见性', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skills-'))
  try {
    const file = createSkill({ root: join(dir, 'skills'), name: 'toggle-me', description: 'd', body: 'b' })
    setInvocation(file, 'model', false)
    let text = readFileSync(file, 'utf8')
    assert.ok(text.includes('disable-model-invocation: true'))
    setInvocation(file, 'model', true)
    text = readFileSync(file, 'utf8')
    assert.ok(!text.includes('disable-model-invocation'))
    setInvocation(file, 'user', false)
    text = readFileSync(file, 'utf8')
    assert.ok(text.includes('user-invocable: false'))
    assert.ok(text.includes('正文') === false, '正文不应丢失')
    assert.ok(text.includes('body') || text.includes('b\n'), '正文应保留')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
