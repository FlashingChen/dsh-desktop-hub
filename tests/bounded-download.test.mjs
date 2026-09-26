import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  downloadVerifiedArtifact,
  fetchBoundedText,
} from '../scripts/bounded-download.mjs'

const bytes = (text) => new TextEncoder().encode(text)

function responseFromChunks(chunks, options = {}) {
  let pulls = 0
  const body = new ReadableStream({
    pull(controller) {
      pulls += 1
      if (options.errorAt === pulls) {
        controller.error(options.error ?? new Error('stream disconnected'))
        return
      }
      const chunk = chunks.shift()
      if (chunk) controller.enqueue(chunk)
      else controller.close()
    },
    cancel(reason) {
      options.onCancel?.(reason)
    },
  }, { highWaterMark: 0 })
  return {
    response: new Response(body, { status: options.status ?? 200, headers: options.headers }),
    pulls: () => pulls,
  }
}

test('小文本按字节有界读取，Content-Length 超限在 pull 前取消', async () => {
  const normal = responseFromChunks([bytes('sha256  node.tar.gz\n')])
  assert.equal(await fetchBoundedText('fixture:sums', {
    maxBytes: 64,
    timeoutMs: 1_000,
    label: 'SHASUMS',
    fetchFn: async () => normal.response,
  }), 'sha256  node.tar.gz\n')

  let cancelCalls = 0
  const tooLarge = responseFromChunks([bytes('must-not-read')], {
    headers: { 'content-length': '4096' },
    onCancel: () => { cancelCalls += 1 },
  })
  await assert.rejects(fetchBoundedText('fixture:large-sums', {
    maxBytes: 128,
    timeoutMs: 1_000,
    label: 'SHASUMS',
    fetchFn: async () => tooLarge.response,
  }), /Content-Length: 4096/)
  assert.equal(tooLarge.pulls(), 0)
  assert.equal(cancelCalls, 1)
})

test('分块归档超过上限后立即取消、拒绝且删除确切 .part', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bounded-overflow-'))
  const destination = join(dir, 'node.tar.gz')
  const unrelated = join(dir, 'keep.part')
  writeFileSync(unrelated, 'keep')
  let cancelCalls = 0
  const fixture = responseFromChunks([bytes('1234'), bytes('5678'), bytes('not-read')], {
    onCancel: () => { cancelCalls += 1 },
  })
  try {
    await assert.rejects(downloadVerifiedArtifact({
      url: 'fixture:archive',
      destination,
      maxBytes: 6,
      timeoutMs: 1_000,
      label: 'Node tarball',
      fetchFn: async () => fixture.response,
      verify: async () => assert.fail('超限文件不得进入校验'),
    }), /超过大小上限 6 bytes/)
    assert.equal(cancelCalls, 1)
    assert.ok(fixture.pulls() < 3, '超限后不得继续读取剩余 chunk')
    assert.equal(existsSync(`${destination}.part`), false)
    assert.equal(readFileSync(unrelated, 'utf8'), 'keep', '清理只能触碰确切 destination.part')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('归档流中途断开会保留网络诊断并清理 .part', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bounded-disconnect-'))
  const destination = join(dir, 'node.zip')
  const failure = new Error('socket reset halfway')
  const fixture = responseFromChunks([bytes('prefix')], { errorAt: 2, error: failure })
  try {
    await assert.rejects(downloadVerifiedArtifact({
      url: 'fixture:broken',
      destination,
      maxBytes: 1024,
      timeoutMs: 1_000,
      label: 'Node archive',
      fetchFn: async () => fixture.response,
      verify: async () => assert.fail('断流文件不得进入校验'),
    }), (error) => {
      assert.equal(error, failure)
      return true
    })
    assert.equal(existsSync(`${destination}.part`), false)
    assert.equal(existsSync(destination), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('完整 body 消费受总超时约束，慢流不会让构建挂起', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bounded-timeout-'))
  const destination = join(dir, 'node.tar.gz')
  const response = new Response(new ReadableStream({
    pull() {
      return new Promise(() => {})
    },
  }, { highWaterMark: 0 }))
  const started = Date.now()
  try {
    await assert.rejects(downloadVerifiedArtifact({
      url: 'fixture:slow',
      destination,
      maxBytes: 1024,
      timeoutMs: 30,
      label: 'Node tarball',
      fetchFn: async () => response,
      verify: async () => assert.fail('超时文件不得进入校验'),
    }), /Node tarball下载超时（30ms）/)
    assert.ok(Date.now() - started < 500, '超时必须结束整个 body 消费')
    assert.equal(existsSync(`${destination}.part`), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('fetch 实现忽略 AbortSignal 时总超时仍能返回并清理 .part', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bounded-fetch-timeout-'))
  const destination = join(dir, 'node.zip')
  const started = Date.now()
  try {
    await assert.rejects(downloadVerifiedArtifact({
      url: 'fixture:stuck-fetch',
      destination,
      maxBytes: 1024,
      timeoutMs: 30,
      label: 'Node archive',
      fetchFn: () => new Promise(() => {}),
      verify: async () => assert.fail('fetch 超时不得进入校验'),
    }), /Node archive下载超时（30ms）/)
    assert.ok(Date.now() - started < 500)
    assert.equal(existsSync(`${destination}.part`), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('成功下载只在校验后提交，校验与提交失败均清理 part 且保留 destination', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bounded-transaction-'))
  try {
    const success = join(dir, 'success.zip')
    const good = responseFromChunks([bytes('verified archive')])
    let verifiedPath
    await downloadVerifiedArtifact({
      url: 'fixture:success',
      destination: success,
      maxBytes: 1024,
      timeoutMs: 1_000,
      label: 'Node archive',
      fetchFn: async () => good.response,
      verify: async (file) => {
        verifiedPath = file
        assert.equal(readFileSync(file, 'utf8'), 'verified archive')
        assert.equal(existsSync(success), false, '校验完成前不得发布 destination')
      },
    })
    assert.equal(verifiedPath, `${success}.part`)
    assert.equal(readFileSync(success, 'utf8'), 'verified archive')
    assert.equal(existsSync(`${success}.part`), false)

    const checksumTarget = join(dir, 'checksum.zip')
    writeFileSync(checksumTarget, 'previous checksum-verified archive')
    const checksum = responseFromChunks([bytes('bad checksum')])
    await assert.rejects(downloadVerifiedArtifact({
      url: 'fixture:checksum',
      destination: checksumTarget,
      maxBytes: 1024,
      timeoutMs: 1_000,
      label: 'Node archive',
      fetchFn: async () => checksum.response,
      verify: async () => { throw new Error('SHA-256 mismatch') },
    }), /SHA-256 mismatch/)
    assert.equal(existsSync(`${checksumTarget}.part`), false)
    assert.equal(readFileSync(checksumTarget, 'utf8'), 'previous checksum-verified archive')

    const existing = join(dir, 'existing.zip')
    writeFileSync(existing, 'previous verified archive')
    const renameFixture = responseFromChunks([bytes('replacement')])
    await assert.rejects(downloadVerifiedArtifact({
      url: 'fixture:rename',
      destination: existing,
      maxBytes: 1024,
      timeoutMs: 1_000,
      label: 'Node archive',
      fetchFn: async () => renameFixture.response,
      verify: async () => {},
    }, {
      commitFile: async () => { throw new Error('commit denied') },
    }), /commit denied/)
    assert.equal(readFileSync(existing, 'utf8'), 'previous verified archive')
    assert.equal(existsSync(`${existing}.part`), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('默认提交在 verify 后出现 destination 时原子拒绝覆盖并清理 part', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bounded-commit-race-'))
  const destination = join(dir, 'node.tar.gz')
  const fixture = responseFromChunks([bytes('new verified archive')])
  try {
    await assert.rejects(downloadVerifiedArtifact({
      url: 'fixture:commit-race',
      destination,
      maxBytes: 1024,
      timeoutMs: 1_000,
      label: 'Node archive',
      fetchFn: async () => fixture.response,
      verify: async (part) => {
        assert.equal(readFileSync(part, 'utf8'), 'new verified archive')
        writeFileSync(destination, 'raced existing archive')
      },
    }), (error) => {
      assert.equal(error.code, 'EEXIST')
      return true
    })
    assert.equal(readFileSync(destination, 'utf8'), 'raced existing archive')
    assert.equal(existsSync(`${destination}.part`), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('排他创建遇到竞态 EEXIST 时只清 exact part，不触碰 destination 或邻近文件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bounded-exclusive-'))
  const destination = join(dir, 'node.zip')
  const part = `${destination}.part`
  const neighbor = join(dir, 'neighbor.part')
  writeFileSync(destination, 'verified destination')
  writeFileSync(neighbor, 'keep neighbor')
  const response = responseFromChunks([bytes('must not overwrite race file')]).response
  try {
    await assert.rejects(downloadVerifiedArtifact({
      url: 'fixture:eexist',
      destination,
      maxBytes: 1024,
      timeoutMs: 1_000,
      label: 'Node archive',
      fetchFn: async () => {
        writeFileSync(part, 'raced part')
        return response
      },
      verify: async () => assert.fail('EEXIST 不得进入校验'),
    }), (error) => {
      assert.equal(error.code, 'EEXIST')
      return true
    })
    assert.equal(existsSync(part), false)
    assert.equal(readFileSync(destination, 'utf8'), 'verified destination')
    assert.equal(readFileSync(neighbor, 'utf8'), 'keep neighbor')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('主失败后 part 清理也失败时保留两份诊断', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bounded-cleanup-fail-'))
  const destination = join(dir, 'node.zip')
  let removeCalls = 0
  try {
    await assert.rejects(downloadVerifiedArtifact({
      url: 'fixture:cleanup-fail',
      destination,
      maxBytes: 1024,
      timeoutMs: 1_000,
      label: 'Node archive',
      verify: async () => { throw new Error('checksum failed') },
    }, {
      removeFile: async (file) => {
        removeCalls += 1
        if (removeCalls === 1) return rm(file, { force: true })
        throw new Error('part unlink denied')
      },
      downloadFile: async (_url, file) => { writeFileSync(file, 'bad') },
    }), (error) => {
      assert.ok(error instanceof AggregateError)
      assert.deepEqual(error.errors.map((item) => item.message), ['checksum failed', 'part unlink denied'])
      assert.match(error.message, /临时下载清理失败/)
      return true
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('原子提交成功后 part unlink 与重试都失败时聚合诊断且不回滚 destination', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bounded-publish-cleanup-fail-'))
  const destination = join(dir, 'node.tar.gz')
  const part = `${destination}.part`
  const fixture = responseFromChunks([bytes('verified archive')])
  let removeCalls = 0
  try {
    await assert.rejects(downloadVerifiedArtifact({
      url: 'fixture:publish-cleanup-fail',
      destination,
      maxBytes: 1024,
      timeoutMs: 1_000,
      label: 'Node archive',
      fetchFn: async () => fixture.response,
      verify: async () => {},
    }, {
      removeFile: async (file) => {
        removeCalls += 1
        if (removeCalls === 1) return rm(file, { force: true })
        if (removeCalls === 2) throw new Error('published part unlink denied')
        throw new Error('part cleanup retry denied')
      },
    }), (error) => {
      assert.ok(error instanceof AggregateError)
      assert.deepEqual(error.errors.map((item) => item.message), [
        'published part unlink denied',
        'part cleanup retry denied',
      ])
      assert.match(error.message, /临时下载清理失败/)
      return true
    })
    assert.equal(readFileSync(destination, 'utf8'), 'verified archive')
    assert.equal(readFileSync(part, 'utf8'), 'verified archive')
    assert.equal(removeCalls, 3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
