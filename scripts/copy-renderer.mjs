// 构建辅助：把渲染层静态资源复制到 dist/renderer
import { cpSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const rendererDir = join(root, 'dist', 'renderer')
mkdirSync(rendererDir, { recursive: true })
cpSync(join(root, 'src', 'renderer', 'index.html'), join(rendererDir, 'index.html'))
const communityDir = join(rendererDir, 'community')
mkdirSync(communityDir, { recursive: true })
cpSync(join(root, 'assets', 'community', 'qq-group.png'), join(communityDir, 'qq-group.png'))
console.log('copied renderer/index.html and community/qq-group.png -> dist/renderer')
