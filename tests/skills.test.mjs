// M4 单元测试：skill 扫描 / frontmatter / 创建 / 可见性切换
import test from 'node:test'
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { crc32 } from 'node:zlib'
import AdmZip from 'adm-zip'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const mod = await import(join(root, 'dist', 'core', 'skills.js'))
const { scanSkills, parseSkillFile, renderSkillFile, createSkill, setInvocation, importSkillFromZip, parseGitHubSkillUrl } = mod

/**
 * 构建原始 ZIP（store 方法，不做任何路径规整）。
 * AdmZip.addFile() 会提前清洗 `..` 路径，无法覆盖目录穿越回归；必须手工拼 central directory。
 */
function rawZip(files) {
  const enc = new TextEncoder()
  const bufs = []
  const central = []
  let offset = 0
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf8')
    const dataBuf = Buffer.from(data, 'utf8')
    const crc = crc32(dataBuf) >>> 0
    const size = dataBuf.length
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0, 6) // flags
    local.writeUInt16LE(0, 8) // method: store
    local.writeUInt16LE(0, 10) // time
    local.writeUInt16LE(0x21, 12) // date 1980-01-01
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(size, 18)
    local.writeUInt32LE(size, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28) // extra len
    bufs.push(local, nameBuf, dataBuf)
    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4) // version made by
    cd.writeUInt16LE(20, 6) // version needed
    cd.writeUInt16LE(0, 8)
    cd.writeUInt16LE(0, 10)
    cd.writeUInt16LE(0, 12)
    cd.writeUInt16LE(0x21, 14)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(size, 20)
    cd.writeUInt32LE(size, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt16LE(0, 30) // extra
    cd.writeUInt16LE(0, 32) // comment
    cd.writeUInt16LE(0, 34) // disk
    cd.writeUInt16LE(0, 36) // internal attrs
    cd.writeUInt32LE(0, 38) // external attrs
    cd.writeUInt32LE(offset, 42) // local header offset
    central.push(cd, nameBuf)
    offset += 30 + nameBuf.length + size
  }
  const cdSize = central.reduce((n, b) => n + b.length, 0)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(cdSize, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...bufs, ...central, eocd])
}

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

test('importSkillFromZip 从 .skill/.zip 导入 bundle 并保留资源文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skills-'))
  try {

    const zip = new AdmZip()
    zip.addFile('my-skill/SKILL.md', Buffer.from('---\nname: my-skill\ndescription: 导入测试\n---\n正文\n'))
    zip.addFile('my-skill/references/ref.md', Buffer.from('参考资料'))
    zip.addFile('my-skill/scripts/run.sh', Buffer.from('#!/bin/sh\necho hi'))
    const buf = zip.toBuffer()
    const res = importSkillFromZip(buf, { root: join(dir, 'skills') })
    assert.equal(res.name, 'my-skill')
    const skill = readFileSync(join(dir, 'skills', 'my-skill', 'SKILL.md'), 'utf8')
    assert.ok(skill.includes('name: my-skill'))
    assert.ok(existsSync(join(dir, 'skills', 'my-skill', 'references', 'ref.md')), '资源文件应一并安装')
    assert.ok(existsSync(join(dir, 'skills', 'my-skill', 'scripts', 'run.sh')))
    assert.throws(() => importSkillFromZip(buf, { root: join(dir, 'skills') }), /已存在/, '默认拒绝覆盖')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('importSkillFromZip 剥离单一包裹目录并拒绝无 SKILL.md 的包', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skills-'))
  try {

    const zip = new AdmZip()
    zip.addFile('repo-main/my-skill/SKILL.md', Buffer.from('---\nname: my-skill\ndescription: d\n---\nb\n'))
    const res = importSkillFromZip(zip.toBuffer(), { root: join(dir, 'skills'), overwrite: true })
    assert.equal(res.name, 'my-skill')
    assert.ok(existsSync(join(dir, 'skills', 'my-skill', 'SKILL.md')))
    const bad = new AdmZip()
    bad.addFile('readme.txt', Buffer.from('not a skill'))
    assert.throws(() => importSkillFromZip(bad.toBuffer(), { root: join(dir, 'skills') }), /SKILL\.md/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('parseGitHubSkillUrl 解析仓库根与 tree 路径', () => {
  assert.deepEqual(parseGitHubSkillUrl('https://github.com/owner/skill-repo'), {
    owner: 'owner', repo: 'skill-repo', branch: 'main', subPath: '',
  })
  assert.deepEqual(parseGitHubSkillUrl('https://github.com/owner/skill-repo/tree/main/skills/foo'), {
    owner: 'owner', repo: 'skill-repo', branch: 'main', subPath: 'skills/foo',
  })
  assert.throws(() => parseGitHubSkillUrl('https://example.com/x'), /GitHub/)
})

test('importSkillFromZip 拒绝原始 ZIP 目录穿越（..）且不越界写', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skills-'))
  try {
    const buf = rawZip([
      { name: 'safe-skill/SKILL.md', data: '---\nname: safe-skill\ndescription: d\n---\nb\n' },
      { name: 'safe-skill/../../escaped.txt', data: 'pwned' },
    ])
    assert.throws(() => importSkillFromZip(buf, { root: join(dir, 'skills') }), /非法路径/)
    assert.ok(!existsSync(join(dir, 'escaped.txt')), '不得越界写文件')
    assert.ok(!existsSync(join(dir, 'skills', 'safe-skill')), '失败时不应留下半安装目录')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('importSkillFromZip 拒绝绝对路径条目与单文件体积上限', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skills-'))
  try {
    const abs = rawZip([
      { name: 'ok-skill/SKILL.md', data: '---\nname: ok-skill\ndescription: d\n---\nb\n' },
      { name: '/etc/evil.txt', data: 'x' },
    ])
    assert.throws(() => importSkillFromZip(abs, { root: join(dir, 'skills') }), /非法路径/)
    // 单文件超过 10MB 上限
    const big = rawZip([
      { name: 'ok-skill/SKILL.md', data: '---\nname: ok-skill\ndescription: d\n---\nb\n' },
      { name: 'ok-skill/big.bin', data: 'x'.repeat(11 * 1024 * 1024) },
    ])
    assert.throws(() => importSkillFromZip(big, { root: join(dir, 'skills') }), /单文件上限/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('setInvocation 保留未知 frontmatter 字段与正文', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skills-'))
  try {
    const file = join(dir, 'skills', 'meta-skill', 'SKILL.md')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(
      file,
      '---\nname: meta-skill\ndescription: d\nlicense: MIT\nallowed-tools:\n  - bash\n---\n正文第一行\n',
    )
    setInvocation(file, 'model', false)
    const text = readFileSync(file, 'utf8')
    assert.ok(text.includes('license: MIT'), 'license 应保留')
    assert.ok(text.includes('allowed-tools'), 'allowed-tools 应保留')
    assert.ok(text.includes('disable-model-invocation: true'))
    assert.ok(text.includes('正文第一行'), '正文应保留')
    setInvocation(file, 'model', true)
    const text2 = readFileSync(file, 'utf8')
    assert.ok(text2.includes('license: MIT'), '再次切换后未知字段仍应保留')
    assert.ok(!text2.includes('disable-model-invocation'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('覆盖导入清理旧资源且为事务性', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skills-'))
  try {
    const root = join(dir, 'skills')
    const zip1 = new AdmZip()
    zip1.addFile('demo/SKILL.md', Buffer.from('---\nname: demo\ndescription: v1\n---\nb1\n'))
    zip1.addFile('demo/legacy.txt', Buffer.from('old'))
    importSkillFromZip(zip1.toBuffer(), { root })
    assert.ok(existsSync(join(root, 'demo', 'legacy.txt')))
    const zip2 = new AdmZip()
    zip2.addFile('demo/SKILL.md', Buffer.from('---\nname: demo\ndescription: v2\n---\nb2\n'))
    const res = importSkillFromZip(zip2.toBuffer(), { root, overwrite: true })
    assert.equal(res.name, 'demo')
    assert.ok(existsSync(join(root, 'demo', 'SKILL.md')))
    assert.ok(!existsSync(join(root, 'demo', 'legacy.txt')), '覆盖后旧资源不应残留')
    assert.equal(readFileSync(join(root, 'demo', 'SKILL.md'), 'utf8').includes('v2'), true)
    // 临时目录应被清理
    const residue = readdirSync(dir).filter((n) => n.startsWith('.dsh-skill-import-'))
    assert.deepEqual(residue, [], '不应残留临时解压目录')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
