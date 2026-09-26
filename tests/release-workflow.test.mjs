import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ensureDraftRelease, parseIncludedResponse, queryRelease } from '../scripts/ensure-draft-release.mjs'

function apiResponse(status, body = {}) {
  const reason = status === 200 ? 'OK' : status === 404 ? 'Not Found' : 'Error'
  return `HTTP/2.0 ${status} ${reason}\r\ncontent-type: application/json\r\n\r\n${JSON.stringify(body)}\n`
}

function result(status, stdout = '', stderr = '') {
  return { status, signal: null, stdout, stderr }
}

function release(tag, draft) {
  return { tag_name: tag, draft, id: 42 }
}

test('included GitHub response parser uses the final HTTP response', () => {
  const parsed = parseIncludedResponse(
    `HTTP/1.1 200 Connection established\r\nproxy: yes\r\n\r\n` + apiResponse(404, { message: 'Not Found' }),
  )
  assert.deepEqual(parsed, { status: 404, body: '{"message":"Not Found"}\n' })
})

test('missing release is created as a draft with generated notes', () => {
  const calls = []
  const execute = (args) => {
    calls.push(args)
    if (args[0] === 'api') return result(1, apiResponse(404), 'gh: Not Found (HTTP 404)')
    return result(0)
  }

  assert.deepEqual(ensureDraftRelease({ repo: 'owner/repo', tag: 'v1.2.3', execute }), { action: 'created' })
  assert.deepEqual(calls[1], [
    'release',
    'create',
    'v1.2.3',
    '--draft',
    '--generate-notes',
    '--repo',
    'owner/repo',
  ])
})

test('existing draft is reused without creating another release', () => {
  let callCount = 0
  const execute = () => {
    callCount += 1
    return result(0, apiResponse(200, release('v1.2.3', true)))
  }

  const ensured = ensureDraftRelease({ repo: 'owner/repo', tag: 'v1.2.3', execute })
  assert.equal(ensured.action, 'reused')
  assert.equal(callCount, 1)
})

test('published release is never edited or overwritten by create step', () => {
  let callCount = 0
  const execute = () => {
    callCount += 1
    return result(0, apiResponse(200, release('v1.2.3', false)))
  }

  assert.throws(
    () => ensureDraftRelease({ repo: 'owner/repo', tag: 'v1.2.3', execute }),
    /already published; refusing to edit or overwrite/,
  )
  assert.equal(callCount, 1)
})

test('authentication, server, and transport failures are not treated as a missing release', () => {
  for (const failed of [
    result(1, apiResponse(401), 'gh: Bad credentials (HTTP 401)'),
    result(1, apiResponse(500), 'gh: server error (HTTP 500)'),
    result(1, '', 'network is unreachable'),
  ]) {
    let callCount = 0
    const execute = () => {
      callCount += 1
      return failed
    }
    assert.throws(
      () => ensureDraftRelease({ repo: 'owner/repo', tag: 'v1.2.3', execute }),
      /release lookup/,
    )
    assert.equal(callCount, 1)
  }
})

test('a concurrent creator is accepted only after the exact release is proven to be a draft', () => {
  let call = 0
  const execute = () => {
    call += 1
    if (call === 1) return result(1, apiResponse(404), 'not found')
    if (call === 2) return result(1, '', 'already exists')
    return result(0, apiResponse(200, release('v1.2.3', true)))
  }

  assert.equal(
    ensureDraftRelease({ repo: 'owner/repo', tag: 'v1.2.3', execute }).action,
    'reused-after-race',
  )
  assert.equal(call, 3)
})

test('malformed successful lookup responses fail closed', () => {
  assert.throws(
    () => queryRelease({
      repo: 'owner/repo',
      tag: 'v1.2.3',
      execute: () => result(0, apiResponse(200, { tag_name: 'v9.9.9', draft: true })),
    }),
    /while "v1\.2\.3" was requested/,
  )
})

test('release workflow invokes the idempotent guard and keeps uploads and publish tag-scoped', () => {
  const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
  assert.match(
    workflow,
    /create-release:[\s\S]*?uses: actions\/checkout@v4[\s\S]*?node scripts\/ensure-draft-release\.mjs/,
  )
  assert.doesNotMatch(workflow, /gh release create "\$GITHUB_REF_NAME"/)
  assert.match(workflow, /gh release upload "\$GITHUB_REF_NAME"[\s\S]*?--repo "\$GITHUB_REPOSITORY"/)
  assert.match(workflow, /gh release edit "\$GITHUB_REF_NAME" --draft=false --repo "\$GITHUB_REPOSITORY"/)
})
