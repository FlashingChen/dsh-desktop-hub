// 构建辅助：把渲染层静态资源复制到 dist/renderer
import { cpSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(root, 'dist', 'renderer'), { recursive: true })
cpSync(join(root, 'src', 'renderer', 'index.html'), join(root, 'dist', 'renderer', 'index.html'))
console.log('copied renderer/index.html -> dist/renderer/index.html')
