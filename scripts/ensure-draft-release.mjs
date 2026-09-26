import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const MAX_GH_OUTPUT_BYTES = 1024 * 1024

function compactOutput(value) {
  const text = String(value ?? '').trim()
  if (!text) return '(no diagnostic output)'
  return text.length > 4_000 ? `${text.slice(0, 4_000)}\n… output truncated` : text
}

export function parseIncludedResponse(stdout) {
  const text = String(stdout ?? '')
  const statusPattern = /^HTTP\/[^\s]+\s+(\d{3})(?:\s|$)/gm
  let match
  let lastMatch
  while ((match = statusPattern.exec(text)) !== null) lastMatch = match
  if (!lastMatch) return null

  const headerEndPattern = /\r?\n\r?\n/g
  headerEndPattern.lastIndex = lastMatch.index
  const headerEnd = headerEndPattern.exec(text)
  return {
    status: Number(lastMatch[1]),
    body: headerEnd ? text.slice(headerEndPattern.lastIndex) : '',
  }
}

export function runGh(args) {
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    maxBuffer: MAX_GH_OUTPUT_BYTES,
    shell: false,
  })
  if (result.error) {
    throw new Error(`Failed to start GitHub CLI: ${result.error.message}`)
  }
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

function validateInputs(repo, tag) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error(`Invalid GITHUB_REPOSITORY value: ${JSON.stringify(repo)}`)
  }
  if (!tag || /[\0\r\n]/.test(tag)) {
    throw new Error('GITHUB_REF_NAME must be a non-empty tag without control characters')
  }
}

function apiFailure(action, result, response) {
  const exit = result.signal ? `signal ${result.signal}` : `exit ${String(result.status)}`
  const http = response ? `, HTTP ${response.status}` : ''
  return new Error(`${action} failed (${exit}${http}): ${compactOutput(result.stderr)}`)
}

function parseRelease(body, expectedTag) {
  let value
  try {
    value = JSON.parse(body)
  } catch (error) {
    throw new Error(`GitHub returned invalid release JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('GitHub returned a release response that is not an object')
  }
  if (value.tag_name !== expectedTag) {
    throw new Error(
      `GitHub returned release tag ${JSON.stringify(value.tag_name)} while ${JSON.stringify(expectedTag)} was requested`,
    )
  }
  if (typeof value.draft !== 'boolean') {
    throw new Error('GitHub release response is missing the draft flag')
  }
  return value
}

export function queryRelease({ repo, tag, execute = runGh }) {
  const endpoint = `repos/${repo}/releases/tags/${encodeURIComponent(tag)}`
  const result = execute([
    'api',
    '--include',
    '--method',
    'GET',
    '--header',
    'Accept: application/vnd.github+json',
    endpoint,
  ])
  const response = parseIncludedResponse(result.stdout)

  if (result.status === 0) {
    if (!response || response.status < 200 || response.status >= 300) {
      throw apiFailure('GitHub release lookup returned no successful HTTP response', result, response)
    }
    return parseRelease(response.body, tag)
  }

  if (response?.status === 404) return null
  throw apiFailure('GitHub release lookup', result, response)
}

function existingReleaseError(tag) {
  return new Error(
    `Release ${JSON.stringify(tag)} is already published; refusing to edit or overwrite it during a retry`,
  )
}

export function ensureDraftRelease({ repo, tag, execute = runGh }) {
  validateInputs(repo, tag)

  const existing = queryRelease({ repo, tag, execute })
  if (existing) {
    if (!existing.draft) throw existingReleaseError(tag)
    return { action: 'reused', release: existing }
  }

  const created = execute([
    'release',
    'create',
    tag,
    '--draft',
    '--generate-notes',
    '--repo',
    repo,
  ])
  if (created.status === 0) return { action: 'created' }

  // A manually re-run workflow can race another run after the initial 404.
  // Only suppress the create failure when a second lookup proves that the
  // competing run created the exact draft we wanted.
  let racedRelease
  try {
    racedRelease = queryRelease({ repo, tag, execute })
  } catch (lookupError) {
    throw new AggregateError(
      [apiFailure('GitHub draft release creation', created), lookupError],
      `Creating release ${JSON.stringify(tag)} failed and its final state could not be verified`,
    )
  }
  if (racedRelease?.draft) return { action: 'reused-after-race', release: racedRelease }
  if (racedRelease) throw existingReleaseError(tag)
  throw apiFailure('GitHub draft release creation', created)
}

function main() {
  const repo = process.env.GITHUB_REPOSITORY ?? ''
  const tag = process.env.GITHUB_REF_NAME ?? ''
  const result = ensureDraftRelease({ repo, tag })
  if (result.action === 'created') {
    console.log(`Created draft release ${tag}`)
  } else {
    console.log(`Reusing existing draft release ${tag}`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
