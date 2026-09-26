// M4 单元测试：skill 扫描 / frontmatter / 创建 / 可见性切换
import test from 'node:test'
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { crc32 } from 'node:zlib'
import AdmZip from 'adm-zip'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const mod = await import(pathToFileURL(join(root, 'dist', 'core', 'skills.js')).href)
const {
  scanSkills,
  scanSkillsDetailed,
  resolveSkillIdentity,
  parseSkillFile,
  renderSkillFile,
  createSkill,
  setInvocation,
  importSkillFromZip,
  parseGitHubSkillUrl,
  importSkillFromGitHub,
  importSkillFromClawHub,
  writeSkillFileAtomically,
  installExtracted,
  MAX_SKILL_FILE_BYTES,
  MAX_SCAN_SKILL_FILE_BYTES,
} = mod

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

test('同 root 同名 bundle/flat 使用不同 opaque id，按 id 切换只修改目标', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skills-identity-'))
  const dshHome = join(dir, 'home')
  const agentsHome = join(dir, 'agents')
  const rootDir = join(dshHome, 'skills')
  const bundle = join(rootDir, 'foo', 'SKILL.md')
  const flat = join(rootDir, 'foo.md')
  try {
    mkdirSync(dirname(bundle), { recursive: true })
    writeFileSync(bundle, '---\nname: foo\ndescription: bundle\n---\nbundle body\n')
    writeFileSync(flat, '---\nname: foo\ndescription: flat\n---\nflat body\n')
    const options = { dshHome, agentsHome }
    const foo = scanSkillsDetailed(options).skills.filter((skill) => skill.name === 'foo')
    assert.equal(foo.length, 2)
    const bundleSkill = foo.find((skill) => skill.kind === 'bundle')
    const flatSkill = foo.find((skill) => skill.kind === 'flat')
    assert.ok(bundleSkill?.id.startsWith('skill-v1.'))
    assert.ok(flatSkill?.id.startsWith('skill-v1.'))
    assert.notEqual(bundleSkill.id, flatSkill.id)
    assert.equal(bundleSkill.shadowed, false, 'Hub 同 root 冲突展示规则固定 bundle 优先')
    assert.equal(flatSkill.shadowed, true)
    assert.equal(bundleSkill.canToggle, true)
    assert.equal(flatSkill.canToggle, true, 'shadowed 用户项仍可预配置 fallback')

    const resolvedBundle = resolveSkillIdentity(options, {
      id: bundleSkill.id,
      source: bundleSkill.source,
      kind: bundleSkill.kind,
    })
    setInvocation(resolvedBundle.path, 'model', false)
    assert.match(readFileSync(bundle, 'utf8'), /disable-model-invocation: true/)
    assert.doesNotMatch(readFileSync(flat, 'utf8'), /disable-model-invocation/)

    const resolvedFlat = resolveSkillIdentity(options, {
      id: flatSkill.id,
      source: flatSkill.source,
      kind: flatSkill.kind,
    })
    setInvocation(resolvedFlat.path, 'user', false)
    assert.match(readFileSync(flat, 'utf8'), /user-invocable: false/)
    assert.doesNotMatch(readFileSync(bundle, 'utf8'), /user-invocable/)

    assert.throws(
      () => resolveSkillIdentity(options, { id: bundleSkill.id, source: bundleSkill.source, kind: 'flat' }),
      /count=0/,
    )
    const rescanned = scanSkillsDetailed(options).skills.filter((skill) => skill.name === 'foo')
    assert.deepEqual(rescanned.map((skill) => skill.id), foo.map((skill) => skill.id), '内容切换不得改变 opaque id')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('多个 custom root 的同 source/kind/name 仍有稳定唯一 id 且保持只读', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skills-root-slot-'))
  try {
    const roots = [join(dir, 'custom-a'), join(dir, 'custom-b')]
    for (const [index, rootDir] of roots.entries()) {
      mkdirSync(join(rootDir, 'same'), { recursive: true })
      writeFileSync(join(rootDir, 'same', 'SKILL.md'), `---\nname: same\ndescription: custom ${index}\n---\nb\n`)
    }
    const first = scanSkillsDetailed({ dshHome: join(dir, 'home'), agentsHome: join(dir, 'agents'), customDirs: roots }).skills
      .filter((skill) => skill.name === 'same')
    const second = scanSkillsDetailed({ dshHome: join(dir, 'home'), agentsHome: join(dir, 'agents'), customDirs: roots }).skills
      .filter((skill) => skill.name === 'same')
    assert.equal(first.length, 2)
    assert.equal(new Set(first.map((skill) => skill.id)).size, 2)
    assert.deepEqual(first.map((skill) => skill.id), second.map((skill) => skill.id))
    assert.ok(first.every((skill) => skill.canToggle === false))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('扫描对单文件、root 总字节与条目数设限，单条失败不拖垮正常 skill', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skills-scan-limits-'))
  try {
    const oversizeRoot = join(dir, 'oversize')
    mkdirSync(oversizeRoot, { recursive: true })
    writeFileSync(join(oversizeRoot, 'huge.md'), 'x'.repeat(129))
    chmodSync(join(oversizeRoot, 'huge.md'), 0o000)
    writeFileSync(join(oversizeRoot, 'normal.md'), '---\nname: normal\ndescription: ok\n---\nb\n')
    const oversize = scanSkillsDetailed({
      dshHome: join(dir, 'home'),
      agentsHome: join(dir, 'agents'),
      customDirs: [oversizeRoot],
      limits: { maxFileBytes: 128 },
    })
    assert.deepEqual(oversize.skills.map((skill) => skill.name), ['normal'])
    assert.ok(oversize.warnings.some((warning) => /huge\.md.*超过扫描上限 128/.test(warning)), '超限必须在尝试读取前按 metadata 拒绝')

    const totalRoot = join(dir, 'total')
    mkdirSync(totalRoot, { recursive: true })
    const alpha = '---\nname: alpha\ndescription: first\n---\naaaaa\n'
    const beta = '---\nname: beta\ndescription: second\n---\nbbbbb\n'
    writeFileSync(join(totalRoot, 'alpha.md'), alpha)
    writeFileSync(join(totalRoot, 'beta.md'), beta)
    const total = scanSkillsDetailed({
      dshHome: join(dir, 'home'),
      agentsHome: join(dir, 'agents'),
      customDirs: [totalRoot],
      limits: { maxFileBytes: 1_024, maxTotalBytesPerRoot: Buffer.byteLength(alpha) + 1 },
    })
    assert.deepEqual(total.skills.map((skill) => skill.name), ['alpha'])
    assert.ok(total.warnings.some((warning) => /beta\.md.*总读取字节/.test(warning)))

    const entryRoot = join(dir, 'entries')
    mkdirSync(entryRoot, { recursive: true })
    for (const name of ['a', 'b', 'c', 'd']) writeFileSync(join(entryRoot, `${name}.md`), `---\nname: ${name}\ndescription: d\n---\nb\n`)
    const entries = scanSkillsDetailed({
      dshHome: join(dir, 'home'),
      agentsHome: join(dir, 'agents'),
      customDirs: [entryRoot],
      limits: { maxEntriesPerRoot: 2 },
    })
    assert.equal(entries.skills.length, 2)
    assert.ok(entries.warnings.some((warning) => /条目超过上限 2/.test(warning)))
    assert.equal(MAX_SCAN_SKILL_FILE_BYTES < MAX_SKILL_FILE_BYTES, true, 'UI 同步扫描上限应严于写入上限')
  } finally {
    if (existsSync(join(dir, 'oversize', 'huge.md'))) chmodSync(join(dir, 'oversize', 'huge.md'), 0o600)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('扫描拒绝 root 外 symlink，内部 symlink 只读，并收敛目录/文件竞态', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'skills-symlink-'))
  try {
    const rootDir = join(dir, 'skills')
    const outside = join(dir, 'outside-secret.md')
    mkdirSync(rootDir, { recursive: true })
    writeFileSync(outside, '---\nname: leak\ndescription: TOP-SECRET-CONTENT\n---\nsecret\n')
    symlinkSync(outside, join(rootDir, 'leak.md'))
    writeFileSync(join(rootDir, 'real.md'), '---\nname: real\ndescription: inside\n---\nb\n')
    symlinkSync(join(rootDir, 'real.md'), join(rootDir, 'alias.md'))
    mkdirSync(join(rootDir, 'racy', 'SKILL.md'), { recursive: true })
    writeFileSync(join(rootDir, 'valid.md'), '---\nname: valid\ndescription: survives\n---\nb\n')

    const scanned = scanSkillsDetailed({ dshHome: dir, agentsHome: join(dir, 'agents') })
    assert.ok(!scanned.skills.some((skill) => skill.name === 'leak'))
    assert.ok(!scanned.warnings.join('\n').includes('TOP-SECRET-CONTENT'), '域外内容不得进入结果或 warning')
    assert.ok(scanned.warnings.some((warning) => /leak\.md.*路径越过扫描根/.test(warning)))
    assert.equal(scanned.skills.find((skill) => skill.name === 'alias')?.canToggle, false, 'symlink 即使域内也不得通过 toggle 原子替换')
    assert.ok(scanned.skills.some((skill) => skill.name === 'valid'), '单条目录/文件竞态不得拖垮其他项')
    assert.ok(scanned.warnings.some((warning) => /racy.*不是普通文件/.test(warning)))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('单个不可读 SKILL.md 只产生 warning，其他项仍可展示', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'skills-unreadable-'))
  const rootDir = join(dir, 'skills')
  const unreadable = join(rootDir, 'blocked.md')
  try {
    mkdirSync(rootDir, { recursive: true })
    writeFileSync(unreadable, '---\nname: blocked\ndescription: blocked\n---\nb\n')
    chmodSync(unreadable, 0o000)
    writeFileSync(join(rootDir, 'healthy.md'), '---\nname: healthy\ndescription: ok\n---\nb\n')
    const scanned = scanSkillsDetailed({ dshHome: dir, agentsHome: join(dir, 'agents') })
    assert.deepEqual(scanned.skills.map((skill) => skill.name), ['healthy'])
    assert.ok(scanned.warnings.some((warning) => /blocked\.md.*扫描失败/.test(warning)))
  } finally {
    if (existsSync(unreadable)) chmodSync(unreadable, 0o600)
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
    assert.throws(
      () => createSkill({ root: join(dir, 'skills'), name: 'hello-world', description: '覆盖', body: '覆盖' }),
      /已存在/,
    )
    assert.equal(readFileSync(file, 'utf8'), text, '排他创建失败不得改写已存在文件')
    chmodSync(file, 0o640)
    createSkill({
      root: join(dir, 'skills'),
      name: 'hello-world',
      description: '覆盖版本',
      body: '新内容',
      overwrite: true,
    })
    assert.ok(readFileSync(file, 'utf8').includes('覆盖版本'))
    assert.equal(statSync(file).mode & 0o777, 0o640, 'overwrite 原子替换必须保留 mode')
    assert.throws(() => createSkill({ root: join(dir, 'skills'), name: 'Hello World!', description: '', body: '' }), /kebab-case/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('createSkill 最终 SKILL.md 超过 10MiB 时在创建目录前拒绝', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skills-'))
  try {
    const skillRoot = join(dir, 'skills')
    assert.throws(
      () => createSkill({
        root: skillRoot,
        name: 'too-large',
        description: 'd',
        body: 'a'.repeat(MAX_SKILL_FILE_BYTES),
      }),
      /SKILL\.md 超过 .* 字节上限/,
    )
    assert.equal(existsSync(join(skillRoot, 'too-large')), false, '输入校验失败不得留下空目录')
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

test('setInvocation 修复非法字符串 name，非法 fallback 则拒绝且保留原文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skills-'))
  try {
    const fixed = join(dir, 'skills', 'canonical-name', 'SKILL.md')
    mkdirSync(dirname(fixed), { recursive: true })
    writeFileSync(fixed, '---\nname: Bad Name\ndescription: d\nlicense: MIT\n---\n正文\n')
    chmodSync(fixed, 0o640)

    setInvocation(fixed, 'user', false)

    const fixedText = readFileSync(fixed, 'utf8')
    assert.equal(parseSkillFile(fixedText).meta.name, 'canonical-name')
    assert.ok(fixedText.includes('license: MIT'))
    assert.ok(fixedText.endsWith('正文\n'))
    assert.equal(statSync(fixed).mode & 0o777, 0o640, '原子替换必须保留原文件 mode')

    const rejected = join(dir, 'skills', 'Bad Directory', 'SKILL.md')
    mkdirSync(dirname(rejected), { recursive: true })
    const original = '---\nname: Also Bad\ndescription: d\n---\n正文\n'
    writeFileSync(rejected, original)
    assert.throws(() => setInvocation(rejected, 'model', false), /合法的 kebab-case/)
    assert.equal(readFileSync(rejected, 'utf8'), original)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('原子覆盖模拟 Windows 冲突并在替换失败时恢复原文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skills-'))
  try {
    const file = join(dir, 'SKILL.md')
    writeFileSync(file, 'old')
    let renameCalls = 0
    const injectedRename = (from, to) => {
      renameCalls += 1
      if (renameCalls === 1) throw Object.assign(new Error('windows replace conflict'), { code: 'EPERM' })
      if (renameCalls === 3) throw Object.assign(new Error('injected replacement failure'), { code: 'EIO' })
      renameSync(from, to)
    }

    assert.throws(
      () => writeSkillFileAtomically(file, 'new', { rename: injectedRename }),
      /injected replacement failure/,
    )
    assert.equal(readFileSync(file, 'utf8'), 'old', '替换失败必须恢复原内容')
    assert.deepEqual(readdirSync(dir), ['SKILL.md'], '临时与备份文件必须收敛')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('原子覆盖的清理错误不会掩盖原始替换错误', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skills-'))
  try {
    const file = join(dir, 'SKILL.md')
    writeFileSync(file, 'old')
    let renameCalls = 0
    const injectedRename = (from, to) => {
      renameCalls += 1
      if (renameCalls === 1) throw Object.assign(new Error('replace conflict'), { code: 'EPERM' })
      if (renameCalls === 3) throw Object.assign(new Error('primary replacement failure'), { code: 'EIO' })
      renameSync(from, to)
    }
    const injectedRemove = () => {
      throw new Error('cleanup failure')
    }

    assert.throws(
      () => writeSkillFileAtomically(file, 'new', { rename: injectedRename, remove: injectedRemove }),
      (error) => {
        assert.ok(error instanceof AggregateError)
        assert.match(String(error.errors[0]), /primary replacement failure/)
        assert.match(String(error.errors[1]), /cleanup failure/)
        return true
      },
    )
    assert.equal(readFileSync(file, 'utf8'), 'old')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('文件与目录提交成功后的 recovery 清理失败不假报操作失败', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skills-'))
  try {
    const file = join(dir, 'SKILL.md')
    writeFileSync(file, 'old')
    let fileRenameCalls = 0
    const windowsRename = (from, to) => {
      fileRenameCalls += 1
      if (fileRenameCalls === 1) throw Object.assign(new Error('windows replace conflict'), { code: 'EPERM' })
      renameSync(from, to)
    }
    const failRecoveryCleanup = (path, options) => {
      if (String(path).includes('.old-')) throw new Error('recovery cleanup failure')
      rmSync(path, options)
    }

    assert.doesNotThrow(() => writeSkillFileAtomically(file, 'new', {
      rename: windowsRename,
      remove: failRecoveryCleanup,
    }))
    assert.equal(readFileSync(file, 'utf8'), 'new')

    const target = join(dir, 'installed-skill')
    const extracted = join(dir, 'extracted-skill')
    mkdirSync(target)
    mkdirSync(extracted)
    writeFileSync(join(target, 'SKILL.md'), 'old directory')
    writeFileSync(join(extracted, 'SKILL.md'), 'new directory')

    assert.doesNotThrow(() => installExtracted(extracted, target, true, { remove: failRecoveryCleanup }))
    assert.equal(readFileSync(join(target, 'SKILL.md'), 'utf8'), 'new directory')
    assert.ok(
      readdirSync(dir).filter((entry) => entry.includes('.old-')).length >= 2,
      '清理失败时可保留隐藏 recovery artifact',
    )
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

test('zip 导入把缺失或非法 name 规范化为最终安装名并保留其他内容', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skills-'))
  try {
    for (const [nameValue, expected] of [['Bad Name', 'canonical-zip'], [null, 'missing-name']]) {
      const zip = new AdmZip()
      const nameLine = nameValue === null ? '' : `name: ${nameValue}\n`
      zip.addFile(
        `${expected}/SKILL.md`,
        Buffer.from(`---\n${nameLine}description: d\nlicense: MIT\n---\n正文-${expected}\n`),
      )
      const result = importSkillFromZip(zip.toBuffer(), { root: join(dir, 'skills') })
      const installed = readFileSync(result.file, 'utf8')
      assert.equal(result.name, expected)
      assert.equal(parseSkillFile(installed).meta.name, expected)
      assert.ok(installed.includes('license: MIT'))
      assert.ok(installed.includes(`正文-${expected}`))
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('zip 导入拒绝缺少或 malformed frontmatter，不因合法目录名而放行', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skills-'))
  try {
    for (const contents of ['没有 frontmatter\n', '---\nname: [broken\n---\n正文\n']) {
      const zip = new AdmZip()
      zip.addFile('valid-directory/SKILL.md', Buffer.from(contents))
      assert.throws(() => importSkillFromZip(zip.toBuffer(), { root: join(dir, 'skills') }), /SKILL\.md 无效/)
    }
    assert.ok(!existsSync(join(dir, 'skills', 'valid-directory')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('importSkillFromZip 导入根级 SKILL.md 及同级资源', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skills-'))
  try {
    const zip = new AdmZip()
    zip.addFile('SKILL.md', Buffer.from('---\nname: root-skill\ndescription: 根级导入\n---\n正文\n'))
    zip.addFile('references/ref.md', Buffer.from('参考资料'))
    zip.addFile('scripts/run.sh', Buffer.from('#!/bin/sh\necho hi'))

    const res = importSkillFromZip(zip.toBuffer(), { root: join(dir, 'skills') })

    assert.equal(res.name, 'root-skill')
    assert.ok(existsSync(join(dir, 'skills', 'root-skill', 'SKILL.md')))
    assert.equal(readFileSync(join(dir, 'skills', 'root-skill', 'references', 'ref.md'), 'utf8'), '参考资料')
    assert.ok(existsSync(join(dir, 'skills', 'root-skill', 'scripts', 'run.sh')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('importSkillFromZip 拒绝没有合法 frontmatter name 的根级包', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skills-'))
  try {
    const zip = new AdmZip()
    zip.addFile('SKILL.md', Buffer.from('---\ndescription: 缺少名称\n---\n正文\n'))
    zip.addFile('references/ref.md', Buffer.from('参考资料'))

    assert.throws(
      () => importSkillFromZip(zip.toBuffer(), { root: join(dir, 'skills') }),
      /根目录 SKILL\.md.*frontmatter.*kebab-case name/,
    )
    assert.ok(!existsSync(join(dir, 'skills')), '拒绝时不应创建安装目录')
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

test('GitHub 导入规范化缺失 name，落盘 name 与 canonical 目录一致', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'skills-'))
  const originalFetch = globalThis.fetch
  try {
    const zip = new AdmZip()
    zip.addFile(
      'repo-main/github-canonical/SKILL.md',
      Buffer.from('---\ndescription: GitHub skill\nlicense: MIT\n---\n正文\n'),
    )
    globalThis.fetch = async () => new Response(zip.toBuffer(), { status: 200 })

    const result = await importSkillFromGitHub(
      'https://github.com/owner/repo',
      { root: join(dir, 'skills') },
    )
    const installed = readFileSync(result.file, 'utf8')
    assert.equal(result.name, 'github-canonical')
    assert.equal(parseSkillFile(installed).meta.name, 'github-canonical')
    assert.ok(installed.includes('license: MIT'))
  } finally {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  }
})

test('GitHub 非成功响应取消 body，取消失败不覆盖下载诊断', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'skills-'))
  const originalFetch = globalThis.fetch
  let fetchCalls = 0
  let cancelCalls = 0
  try {
    globalThis.fetch = async () => {
      fetchCalls += 1
      return {
        ok: false,
        status: 503,
        body: {
          cancel() {
            cancelCalls += 1
            return Promise.reject(new Error('cancel failed'))
          },
        },
      }
    }
    await assert.rejects(
      importSkillFromGitHub('https://github.com/owner/repo', { root: join(dir, 'skills') }),
      /下载失败.*owner\/repo/,
    )
    assert.ok(fetchCalls > 0)
    assert.equal(cancelCalls, fetchCalls, '每个非成功响应都必须尝试取消 body')
  } finally {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  }
})

test('importSkillFromClawHub 固定版本下载并事务写入 SKILL.md', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'skills-'))
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async (url) => {
      const value = String(url)
      if (value.includes('/api/v1/skills/demo?')) {
        return new Response(JSON.stringify({ latestVersion: { version: '1.2.3' } }), { status: 200 })
      }
      assert.match(value, /\/api\/v1\/skills\/demo\/file\?/)
      return new Response('---\ndescription: ClawHub skill\nlicense: MIT\n---\n正文\n', { status: 200 })
    }
    const res = await importSkillFromClawHub({ owner: 'owner', slug: 'demo', version: 'latest' }, { root: join(dir, 'skills') })
    assert.equal(res.name, 'demo')
    const installed = readFileSync(join(dir, 'skills', 'demo', 'SKILL.md'), 'utf8')
    assert.equal(parseSkillFile(installed).meta.name, 'demo')
    assert.ok(installed.includes('ClawHub skill'))
    assert.ok(installed.includes('license: MIT'))
  } finally {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ClawHub 导入拒绝 malformed frontmatter 且不落盘', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'skills-'))
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => new Response('---\nname: [broken\n---\n正文\n', { status: 200 })
    await assert.rejects(
      importSkillFromClawHub({ owner: 'owner', slug: 'demo', version: '1.0.0' }, { root: join(dir, 'skills') }),
      /ClawHub SKILL\.md 无效.*frontmatter 解析失败/,
    )
    assert.ok(!existsSync(join(dir, 'skills')))
  } finally {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ClawHub 非成功响应取消 body，取消失败不覆盖 HTTP 诊断', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'skills-'))
  const originalFetch = globalThis.fetch
  let cancelCalls = 0
  try {
    globalThis.fetch = async () => ({
      ok: false,
      status: 503,
      body: {
        cancel() {
          cancelCalls += 1
          return Promise.reject(new Error('cancel failed'))
        },
      },
    })
    await assert.rejects(
      importSkillFromClawHub({ owner: 'owner', slug: 'demo', version: '1.0.0' }, { root: join(dir, 'skills') }),
      /ClawHub SKILL\.md 下载失败（HTTP 503）/,
    )
    assert.equal(cancelCalls, 1)
  } finally {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  }
})

test('importSkillFromClawHub 对空元数据返回可控错误', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'skills-'))
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => new Response('null', { status: 200 })
    await assert.rejects(
      importSkillFromClawHub({ owner: 'owner', slug: 'demo', version: 'latest' }, { root: join(dir, 'skills') }),
      /ClawHub 没有返回可安装版本/,
    )
  } finally {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  }
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

test('scanSkills 扫描 custom 与 bundled 根并标注来源（rank 300/600）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skills-'))
  try {
    mkdirSync(join(dir, 'custom', 'alpha'), { recursive: true })
    writeFileSync(join(dir, 'custom', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: 自定义 skill\n---\nb\n')
    mkdirSync(join(dir, 'bundled', 'gamma'), { recursive: true })
    writeFileSync(join(dir, 'bundled', 'gamma', 'SKILL.md'), '---\nname: gamma\ndescription: 随包 skill\n---\nb\n')
    // 同名用户级 beta（rank 400 < bundled 600）与 custom 级 beta（rank 300 < 400）
    mkdirSync(join(dir, 'home', 'skills', 'beta'), { recursive: true })
    writeFileSync(join(dir, 'home', 'skills', 'beta', 'SKILL.md'), '---\nname: beta\ndescription: 用户级\n---\nb\n')
    mkdirSync(join(dir, 'custom', 'beta'), { recursive: true })
    writeFileSync(join(dir, 'custom', 'beta', 'SKILL.md'), '---\nname: beta\ndescription: 自定义级\n---\nb\n')
    const skills = scanSkills({ dshHome: join(dir, 'home'), customDirs: [join(dir, 'custom')], bundledDir: join(dir, 'bundled') })
    assert.equal(skills.find((s) => s.name === 'alpha')?.source, 'custom')
    assert.equal(skills.find((s) => s.name === 'alpha')?.shadowed, false)
    assert.equal(skills.find((s) => s.name === 'gamma')?.source, 'bundled')
    const beta = skills.filter((s) => s.name === 'beta')
    assert.equal(beta.length, 2, '同名应列出两个来源')
    assert.equal(beta.find((s) => s.source === 'custom')?.shadowed, false, 'rank 300 custom 应为有效')
    assert.equal(beta.find((s) => s.source === 'user-dsh')?.shadowed, true, 'rank 400 user 应被 custom shadowed')
    // 不传根时 bundled/custom 不出现
    const bare = scanSkills({ dshHome: join(dir, 'home') })
    assert.ok(!bare.some((s) => s.source === 'bundled' || s.source === 'custom'), '未配置的根不应扫描')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('setInvocation 对扁平 skill 用文件名作为 name 回退（而非目录名）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skills-'))
  try {
    const file = join(dir, 'skills', 'flat-skill.md')
    mkdirSync(join(dir, 'skills'), { recursive: true })
    writeFileSync(file, '---\ndescription: 无 name 的扁平 skill\n---\n正文\n')
    setInvocation(file, 'model', false)
    const text = readFileSync(file, 'utf8')
    assert.ok(text.includes('name: flat-skill'), `应回退为文件名: ${text}`)
    assert.ok(!text.includes('name: skills'), '不得用目录名（skills 根目录）')
    assert.ok(text.includes('disable-model-invocation: true'))
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
