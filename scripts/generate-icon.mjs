// 生成应用图标 build/icon.png（1024×1024）：DSH Desktop Hub 品牌标
// 设计：深蓝渐变圆角方块 + 白色鲸鱼（DeepSeek 品牌元素）+ 底部 hub 节点（三连点）
// 运行：npx electron scripts/generate-icon.mjs
import { app, BrowserWindow } from 'electron'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const SVG = (color1, color2, whaleBody, whaleTail, nodeColor) => `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; padding: 0; width: 1024px; height: 1024px; background: transparent; }
</style></head>
<body>
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${color1}"/>
      <stop offset="1" stop-color="${color2}"/>
    </linearGradient>
    <linearGradient id="whale" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="1" stop-color="${whaleBody}"/>
    </linearGradient>
    <linearGradient id="tail" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="1" stop-color="${whaleTail}"/>
    </linearGradient>
    <clipPath id="icon-clip" clipPathUnits="userSpaceOnUse">
      <rect x="32" y="32" width="960" height="960" rx="216"/>
    </clipPath>
  </defs>

  <!-- 圆角方块底 -->
  <rect x="32" y="32" width="960" height="960" rx="216" fill="url(#bg)"/>

  <!-- 所有装饰裁切在圆角底内，避免透明图标边缘出现白色溢出 -->
  <g clip-path="url(#icon-clip)">
  <!-- 顶部高光 -->
  <ellipse cx="330" cy="220" rx="420" ry="260" fill="#ffffff" opacity="0.08"/>

  <!-- hub 同心环 -->
  <circle cx="512" cy="470" r="330" fill="none" stroke="#ffffff" stroke-opacity="0.12" stroke-width="4"/>
  <circle cx="512" cy="470" r="262" fill="none" stroke="#ffffff" stroke-opacity="0.08" stroke-width="3"/>

  <!-- 鲸鱼：身体（圆润水平椭圆 + 嘴部弧） -->
  <g>
    <path d="M 310 560
             C 280 470 320 400 430 380
             C 560 356 700 388 768 452
             C 812 494 828 530 822 560
             C 816 596 790 618 748 628
             C 660 650 470 652 380 620
             C 332 604 310 588 310 560 Z"
          fill="url(#whale)"/>
    <!-- 眼部 -->
    <circle cx="700" cy="478" r="14" fill="#1c2a6e"/>
    <!-- 鳍 -->
    <path d="M 470 520 C 520 480 580 480 620 520 C 580 570 510 585 470 520 Z" fill="#bcd2ff" opacity="0.85"/>
  </g>

  <!-- 鲸鱼尾（左） -->
  <path d="M 318 500
           C 252 470 190 448 148 458
           C 128 464 118 478 126 496
           C 150 506 200 510 246 508
           C 214 534 192 566 186 598
           C 184 618 196 630 214 628
           C 250 620 288 584 316 548 Z"
        fill="url(#tail)"/>

  <!-- hub 三节点 -->
  <g>
    <line x1="512" y1="815" x2="512" y2="755" stroke="${nodeColor}" stroke-width="14" stroke-linecap="round"/>
    <line x1="512" y1="755" x2="392" y2="685" stroke="${nodeColor}" stroke-width="14" stroke-linecap="round"/>
    <line x1="512" y1="755" x2="632" y2="685" stroke="${nodeColor}" stroke-width="14" stroke-linecap="round"/>
    <line x1="392" y1="685" x2="632" y2="685" stroke="${nodeColor}" stroke-width="14" stroke-linecap="round"/>
    <circle cx="512" cy="755" r="52" fill="#ffffff"/>
    <circle cx="392" cy="685" r="40" fill="#ffffff"/>
    <circle cx="632" cy="685" r="40" fill="#ffffff"/>
    <circle cx="512" cy="755" r="52" fill="none" stroke="${nodeColor}" stroke-width="10"/>
    <circle cx="392" cy="685" r="40" fill="none" stroke="${nodeColor}" stroke-width="10"/>
    <circle cx="632" cy="685" r="40" fill="none" stroke="${nodeColor}" stroke-width="10"/>
  </g>
  </g>
</svg>
</body></html>`

const design = SVG(
  '#4d6bfe', // color1: 品牌蓝
  '#141d4d', // color2: 深海军蓝
  '#c7d6ff', // whaleBody: 浅蓝白
  '#e4ecff', // whaleTail
  '#67e8f9', // nodeColor: 青色
)

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    useContentSize: true,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true, backgroundThrottling: false },
  })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(design))
  await new Promise((r) => setTimeout(r, 800))
  // Retina runners may capture at 2x; normalize the artifact while preserving
  // the transparent corners of the rounded-square background.
  const captured = await win.webContents.capturePage()
  const image = captured.resize({ width: 1024, height: 1024 })
  const outDir = join(root, 'build')
  mkdirSync(outDir, { recursive: true })
  const out = join(outDir, 'icon.png')
  writeFileSync(out, image.toPNG())
  console.log(`icon written: ${out} (${image.getSize().width}x${image.getSize().height}, alpha corners preserved)`)
  app.exit(0)
})
