import { rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const projectRoot = join(dirname(scriptPath), '..')

export function cleanDist(root) {
  const resolvedRoot = resolve(root)
  const distDir = join(resolvedRoot, 'dist')
  rmSync(distDir, { recursive: true, force: true })
  return distDir
}

function main() {
  const removed = cleanDist(projectRoot)
  console.log(`cleaned ${removed}`)
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  main()
}
