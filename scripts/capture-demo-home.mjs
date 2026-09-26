import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

export const CAPTURE_HOME_PREFIX = 'dsh-demo-capture-'
const createdHomes = new Set()

export function createCaptureHome({ baseDir = tmpdir(), create = mkdtempSync } = {}) {
  const home = resolve(create(join(baseDir, CAPTURE_HOME_PREFIX)))
  createdHomes.add(home)
  return home
}

export function removeCaptureHome(home, { remove = rmSync } = {}) {
  const target = typeof home === 'string' ? resolve(home) : ''
  if (!target || !basename(target).startsWith(CAPTURE_HOME_PREFIX) || !createdHomes.has(target)) {
    throw new Error('拒绝清理非本次 capture 临时目录')
  }
  remove(target, { recursive: true, force: true })
  createdHomes.delete(target)
}
