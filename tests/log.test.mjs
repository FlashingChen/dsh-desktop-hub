import test from 'node:test'
import assert from 'node:assert/strict'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLogSession, sanitizeLogMessage } from '../dist/core/log.js'

function fixture(name) {
  return mkdtempSync(join(tmpdir(), `${name}-`))
}

test('log directory and newly-created file use private modes', {
  skip: process.platform === 'win32' ? 'Windows does not expose POSIX mode enforcement' : false,
}, () => {
  const dir = fixture('dsh-log-mode')
  try {
    chmodSync(dir, 0o755)
    const session = createLogSession({ dir, now: () => 1_700_000_000_000, pid: 42, randomSuffix: () => 'aaaaaaaa' })
    assert.ok(session)
    assert.equal(lstatSync(dir).mode & 0o777, 0o700)
    assert.equal(lstatSync(session.path).mode & 0o777, 0o600)
    session.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('wx collision and matching symlink never overwrite or follow an existing path', () => {
  const dir = fixture('dsh-log-collision')
  const target = join(dir, 'target.txt')
  const first = join(dir, 'main-1700000000000-42-aaaaaaaa.log')
  const suffixes = ['aaaaaaaa', 'bbbbbbbb']
  try {
    writeFileSync(target, 'untouched')
    symlinkSync(target, first)
    const session = createLogSession({
      dir,
      now: () => 1_700_000_000_000,
      pid: 42,
      randomSuffix: () => suffixes.shift(),
    })
    assert.ok(session)
    assert.match(session.path, /-bbbbbbbb\.log$/)
    session.write('new log')
    session.close()
    assert.equal(readFileSync(target, 'utf8'), 'untouched')
    assert.equal(readFileSync(first, 'utf8'), 'untouched')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('retention touches only exact managed regular files and keeps final count at the boundary', () => {
  const dir = fixture('dsh-log-retention')
  const unrelated = join(dir, 'main-not-ours.log')
  const target = join(dir, 'symlink-target.txt')
  const link = join(dir, 'main-1600000000099.log')
  const matchingDir = join(dir, 'main-1600000000098.log')
  try {
    for (let index = 0; index < 6; index++) {
      const path = join(dir, `main-${1_600_000_000_000 + index}.log`)
      writeFileSync(path, String(index))
      utimesSync(path, new Date(1_600_000_000_000 + index), new Date(1_600_000_000_000 + index))
    }
    writeFileSync(unrelated, 'keep')
    writeFileSync(target, 'keep target')
    symlinkSync(target, link)
    // A directory with a managed-looking name must never be recursively removed.
    mkdirSync(matchingDir)

    const session = createLogSession({
      dir,
      maxFiles: 3,
      now: () => 1_700_000_000_000,
      pid: 42,
      randomSuffix: () => 'cccccccc',
    })
    assert.ok(session)
    session.close()

    const regularManaged = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^main-(?:\d{13}|\d{13}-\d+-[a-f0-9]{8,})\.log$/.test(entry.name))
    assert.equal(regularManaged.length, 3)
    assert.equal(readFileSync(unrelated, 'utf8'), 'keep')
    assert.equal(readFileSync(link, 'utf8'), 'keep target')
    assert.equal(lstatSync(matchingDir).isDirectory(), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('size budget and write failures disable file logging without throwing', () => {
  const sizeDir = fixture('dsh-log-size')
  const failureDir = fixture('dsh-log-write-failure')
  try {
    const bounded = createLogSession({
      dir: sizeDir,
      maxBytes: 6,
      now: () => 1_700_000_000_000,
      pid: 42,
      randomSuffix: () => 'dddddddd',
    })
    assert.ok(bounded)
    bounded.write('abc')
    bounded.write('zz')
    bounded.write('x')
    bounded.close()
    assert.equal(readFileSync(bounded.path, 'utf8'), 'abc\n')

    const failed = createLogSession({
      dir: failureDir,
      randomSuffix: () => 'eeeeeeee',
      fs: { write: () => { throw new Error('disk full') } },
    })
    assert.ok(failed)
    assert.doesNotThrow(() => failed.write('first'))
    assert.doesNotThrow(() => failed.write('second'))
    failed.close()
  } finally {
    rmSync(sizeDir, { recursive: true, force: true })
    rmSync(failureDir, { recursive: true, force: true })
  }
})

test('permission tightening and retention cleanup failures never block session creation', () => {
  const dir = fixture('dsh-log-best-effort')
  try {
    for (let index = 0; index < 3; index++) writeFileSync(join(dir, `main-${1_600_000_000_000 + index}.log`), '')
    const session = createLogSession({
      dir,
      maxFiles: 1,
      randomSuffix: () => 'ffffffff',
      fs: {
        chmod: () => { throw new Error('chmod denied') },
        unlink: () => { throw new Error('cleanup denied') },
      },
    })
    assert.ok(session)
    session.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('directory, name generation, and exclusive-open failures return null without throwing', () => {
  const dir = fixture('dsh-log-init-failure')
  try {
    assert.doesNotThrow(() => {
      assert.equal(createLogSession({ dir: join(dir, 'missing'), fs: { mkdir: () => { throw new Error('read only') } } }), null)
    })
    assert.equal(createLogSession({ dir, randomSuffix: () => { throw new Error('entropy unavailable') } }), null)
    assert.equal(createLogSession({ dir, fs: { open: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) } } }), null)
    assert.equal(createLogSession({ dir, maxFiles: 0 }), null)
    assert.equal(createLogSession({ dir, maxBytes: Number.POSITIVE_INFINITY }), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('log redaction removes credentials and common secret forms while preserving placeholders', () => {
  const samples = [
    ['https://demo-user:demo-pass@example.test/path', 'demo-pass'],
    ['Authorization: Bearer bearer-demo-value-1234567890', 'bearer-demo-value'],
    ['authorization=Basic basic-demo-value-1234567890', 'basic-demo-value'],
    ['GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz123456', 'ghp_abcdefghijklmnopqrstuvwxyz'],
    ['{"api_key":"sk-abcdefghijklmnopqrstuvwxyz123456","password":"demo-password"}', 'demo-password'],
    ['?secret=query-secret-value&name=visible', 'query-secret-value'],
    ['npm_abcdefghijklmnopqrstuvwxyz123456', 'npm_abcdefghijklmnopqrstuvwxyz'],
    ['github_pat_abcdefghijklmnopqrstuvwxyz123456', 'github_pat_abcdefghijklmnopqrstuvwxyz'],
  ]
  for (const [source, forbidden] of samples) {
    const sanitized = sanitizeLogMessage(source)
    assert.equal(sanitized.includes(forbidden), false)
    assert.match(sanitized, /<redacted>/)
  }

  assert.equal(sanitizeLogMessage('TOKEN=${TOKEN} api_key="${API_KEY}"'), 'TOKEN=${TOKEN} api_key="${API_KEY}"')
  assert.equal(sanitizeLogMessage('Authorization: Bearer ${AUTH_TOKEN}'), 'Authorization: Bearer ${AUTH_TOKEN}')
})

test('log redaction preserves ordinary paths and versions and bounds oversized messages first', () => {
  const ordinary = 'node=/Users/demo/project/bin/node version=v24.10.0 url=http://127.0.0.1:4312/path tokenizer=normal'
  assert.equal(sanitizeLogMessage(ordinary), ordinary)
  const bounded = sanitizeLogMessage('x'.repeat(40_000))
  assert.ok(bounded.length < 33_000)
  assert.match(bounded, /…<truncated>$/)
})
