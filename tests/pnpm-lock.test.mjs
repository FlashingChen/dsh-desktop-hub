import test from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isProcessAlive, withWorkspaceLock } from '../dist/core/pnpm.js'

const OWNER_TOKEN = 'owner-token-0001'
const OTHER_TOKEN = 'other-token-0002'

function lockRecord(token, pid, createdAt = Date.now()) {
  return { version: 1, token, pid, createdAt }
}

function errno(code, message = code) {
  return Object.assign(new Error(message), { code })
}

function fixture(name) {
  const dir = mkdtempSync(join(tmpdir(), `${name}-`))
  const workspaceFile = join(dir, 'pnpm-workspace.yaml')
  return { dir, workspaceFile, lockFile: `${workspaceFile}.lock` }
}

function noWaitOptions(overrides = {}) {
  return {
    retryLimit: 1,
    retryMs: 0,
    sleep: () => {},
    makeToken: () => OWNER_TOKEN,
    ...overrides,
  }
}

test('old owner never deletes a canonical lock replaced by a later owner', () => {
  const item = fixture('pnpm-lock-owner-change')
  try {
    assert.throws(
      () => withWorkspaceLock(item.workspaceFile, () => {
        unlinkSync(item.lockFile)
        writeFileSync(item.lockFile, `${JSON.stringify(lockRecord(OTHER_TOKEN, process.pid))}\n`)
      }, noWaitOptions()),
      /所有权已变化/,
    )
    assert.equal(JSON.parse(readFileSync(item.lockFile, 'utf8')).token, OTHER_TOKEN)
  } finally {
    rmSync(item.dir, { recursive: true, force: true })
  }
})

test('live owner is never reclaimed merely because its lock mtime is old', () => {
  const item = fixture('pnpm-lock-live-old')
  const now = Date.now()
  try {
    writeFileSync(item.lockFile, `${JSON.stringify(lockRecord(OTHER_TOKEN, 4242, now - 120_000))}\n`)
    utimesSync(item.lockFile, new Date(now - 120_000), new Date(now - 120_000))
    assert.throws(
      () => withWorkspaceLock(
        item.workspaceFile,
        () => assert.fail('live lock must not be stolen'),
        noWaitOptions({ now: () => now, pid: 5252, kill: () => {} }),
      ),
      /等待 pnpm-workspace\.yaml 锁超时/,
    )
    assert.equal(JSON.parse(readFileSync(item.lockFile, 'utf8')).token, OTHER_TOKEN)
  } finally {
    rmSync(item.dir, { recursive: true, force: true })
  }
})

test('confirmed dead owner is recovered without waiting for mtime expiry', () => {
  const item = fixture('pnpm-lock-dead')
  const now = Date.now()
  try {
    writeFileSync(item.lockFile, `${JSON.stringify(lockRecord(OTHER_TOKEN, 4242, now))}\n`)
    assert.equal(withWorkspaceLock(
      item.workspaceFile,
      () => 'entered',
      noWaitOptions({
        now: () => now,
        pid: 5252,
        kill: (pid) => {
          if (pid === 4242) throw errno('ESRCH')
        },
      }),
    ), 'entered')
    assert.equal(existsSync(item.lockFile), false)
  } finally {
    rmSync(item.dir, { recursive: true, force: true })
  }
})

test('malformed fresh lock is kept while malformed sufficiently old lock is recovered', () => {
  const fresh = fixture('pnpm-lock-malformed-fresh')
  const old = fixture('pnpm-lock-malformed-old')
  const now = Date.now()
  try {
    writeFileSync(fresh.lockFile, '{broken')
    assert.throws(
      () => withWorkspaceLock(fresh.workspaceFile, () => false, noWaitOptions({ now: () => now })),
      /等待 pnpm-workspace\.yaml 锁超时/,
    )
    assert.equal(readFileSync(fresh.lockFile, 'utf8'), '{broken')

    writeFileSync(old.lockFile, '{broken')
    utimesSync(old.lockFile, new Date(now - 60_000), new Date(now - 60_000))
    assert.equal(withWorkspaceLock(old.workspaceFile, () => true, noWaitOptions({ now: () => now })), true)
    assert.equal(existsSync(old.lockFile), false)
  } finally {
    rmSync(fresh.dir, { recursive: true, force: true })
    rmSync(old.dir, { recursive: true, force: true })
  }
})

test('EPERM and unknown process-probe errors fail closed as alive', () => {
  assert.equal(isProcessAlive(4242, () => { throw errno('EPERM') }), true)
  assert.equal(isProcessAlive(4242, () => { throw errno('ESRCH') }), false)
  assert.equal(isProcessAlive(4242, () => { throw errno('EIO') }), true)
})

test('invalid retry and stale durations are rejected before creating a lock', () => {
  const item = fixture('pnpm-lock-invalid-options')
  try {
    for (const options of [
      { retryMs: -1 },
      { retryMs: Number.NaN },
      { retryMs: Number.POSITIVE_INFINITY },
      { staleMs: -1 },
      { staleMs: Number.NaN },
      { staleMs: Number.POSITIVE_INFINITY },
    ]) {
      assert.throws(
        () => withWorkspaceLock(item.workspaceFile, () => assert.fail('invalid options must fail before task'), {
          ...noWaitOptions(),
          ...options,
        }),
        /工作区锁(?:重试间隔|陈旧期限)无效/,
      )
      assert.equal(existsSync(item.lockFile), false)
    }
  } finally {
    rmSync(item.dir, { recursive: true, force: true })
  }
})

test('recovery guard serializes competing recoverers and later contenders re-inspect the live owner', () => {
  const item = fixture('pnpm-lock-recovery-guard')
  const now = Date.now()
  const kill = (pid) => {
    if (pid === 4242) throw errno('ESRCH')
  }
  let competingRecovererBlocked = false
  try {
    writeFileSync(item.lockFile, `${JSON.stringify(lockRecord(OTHER_TOKEN, 4242, now))}\n`)
    assert.equal(withWorkspaceLock(item.workspaceFile, () => {
      for (const token of ['later-owner-0003', 'third-owner-0004']) {
        assert.throws(
          () => withWorkspaceLock(item.workspaceFile, () => assert.fail('live owner must exclude contenders'), {
            ...noWaitOptions({ makeToken: () => token, pid: 6262, kill }),
          }),
          /等待 pnpm-workspace\.yaml 锁超时/,
        )
      }
      return 'owner-entered'
    }, noWaitOptions({
      now: () => now,
      pid: 5252,
      kill,
      onRecoveryGuardAcquired: () => {
        assert.throws(
          () => withWorkspaceLock(item.workspaceFile, () => assert.fail('second recoverer must not enter'), {
            ...noWaitOptions({ makeToken: () => 'second-owner-0005', pid: 6262, kill }),
          }),
          /等待 pnpm-workspace\.yaml 锁超时/,
        )
        competingRecovererBlocked = true
      },
    })), 'owner-entered')
    assert.equal(competingRecovererBlocked, true)
    assert.equal(existsSync(`${item.lockFile}.recovery`), false)
  } finally {
    rmSync(item.dir, { recursive: true, force: true })
  }
})

test('partial creator resumed after stale recovery fails ownership verification and never enters', {
  skip: process.platform === 'win32' ? 'Windows already prevents renaming an open lock handle' : false,
}, () => {
  const item = fixture('pnpm-lock-partial-create')
  let firstEntered = false
  let recoveredOwnerEntered = false
  let interleaved = false
  try {
    assert.throws(
      () => withWorkspaceLock(item.workspaceFile, () => { firstEntered = true }, noWaitOptions({
        pid: 5252,
        afterCreateOpen: () => {
          if (interleaved) return
          interleaved = true
          const future = Date.now() + 60_000
          withWorkspaceLock(item.workspaceFile, () => { recoveredOwnerEntered = true }, noWaitOptions({
            now: () => future,
            makeToken: () => OTHER_TOKEN,
            pid: 6262,
          }))
        },
      })),
      /创建后所有权复核失败/,
    )
    assert.equal(firstEntered, false)
    assert.equal(recoveredOwnerEntered, true)
  } finally {
    rmSync(item.dir, { recursive: true, force: true })
  }
})

test('orphaned recovery guard fails closed and is never reclaimed recursively', () => {
  const item = fixture('pnpm-lock-orphaned-guard')
  try {
    writeFileSync(`${item.lockFile}.recovery`, '{crashed guard')
    assert.throws(
      () => withWorkspaceLock(item.workspaceFile, () => assert.fail('orphaned guard must block writes'), noWaitOptions()),
      /等待 pnpm-workspace\.yaml 锁超时/,
    )
    assert.equal(readFileSync(`${item.lockFile}.recovery`, 'utf8'), '{crashed guard')
    assert.equal(existsSync(item.lockFile), false)
  } finally {
    rmSync(item.dir, { recursive: true, force: true })
  }
})

test('recovery rechecks the moved inode and restores a replacement from the read/rename race', () => {
  const item = fixture('pnpm-lock-recover-race')
  const now = Date.now()
  let replaced = false
  try {
    writeFileSync(item.lockFile, '{broken')
    utimesSync(item.lockFile, new Date(now - 60_000), new Date(now - 60_000))
    assert.throws(
      () => withWorkspaceLock(item.workspaceFile, () => false, noWaitOptions({
        now: () => now,
        beforeMove: (phase, lockFile) => {
          if (phase !== 'recover' || replaced) return
          replaced = true
          unlinkSync(lockFile)
          writeFileSync(lockFile, `${JSON.stringify(lockRecord(OTHER_TOKEN, process.pid, now))}\n`)
        },
      })),
      /等待 pnpm-workspace\.yaml 锁超时/,
    )
    assert.equal(JSON.parse(readFileSync(item.lockFile, 'utf8')).token, OTHER_TOKEN)
  } finally {
    rmSync(item.dir, { recursive: true, force: true })
  }
})

test('release rechecks the moved inode and restores a replacement from the read/rename race', () => {
  const item = fixture('pnpm-lock-release-race')
  let replaced = false
  try {
    assert.throws(
      () => withWorkspaceLock(item.workspaceFile, () => true, noWaitOptions({
        beforeMove: (phase, lockFile) => {
          if (phase !== 'release' || replaced) return
          replaced = true
          unlinkSync(lockFile)
          writeFileSync(lockFile, `${JSON.stringify(lockRecord(OTHER_TOKEN, process.pid))}\n`)
        },
      })),
      /释放期间被替换/,
    )
    assert.equal(JSON.parse(readFileSync(item.lockFile, 'utf8')).token, OTHER_TOKEN)
  } finally {
    rmSync(item.dir, { recursive: true, force: true })
  }
})

test('release cleanup failure is surfaced and aggregates with a task failure', () => {
  const success = fixture('pnpm-lock-cleanup-error')
  const failure = fixture('pnpm-lock-double-error')
  const failReleaseCleanup = (path) => {
    if (path.includes('.release-')) throw errno('EACCES', 'release cleanup denied')
    unlinkSync(path)
  }
  try {
    assert.throws(
      () => withWorkspaceLock(success.workspaceFile, () => 'done', noWaitOptions({ unlink: failReleaseCleanup })),
      /release cleanup denied/,
    )

    let combined
    try {
      withWorkspaceLock(
        failure.workspaceFile,
        () => { throw new Error('task failed') },
        noWaitOptions({ unlink: failReleaseCleanup }),
      )
    } catch (error) {
      combined = error
    }
    assert.ok(combined instanceof AggregateError)
    assert.equal(combined.errors.length, 2)
    assert.match(combined.errors[0].message, /task failed/)
    assert.match(combined.errors[1].message, /release cleanup denied/)
  } finally {
    rmSync(success.dir, { recursive: true, force: true })
    rmSync(failure.dir, { recursive: true, force: true })
  }
})
