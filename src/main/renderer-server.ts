import { readFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'

const HOST = '127.0.0.1'
const ASSETS = new Map<string, { file: string; type: string; bodyClass?: string }>([
  ['/index.html', { file: 'index.html', type: 'text/html; charset=utf-8', bodyClass: 'desktop-host' }],
  ['/manager.html', { file: 'index.html', type: 'text/html; charset=utf-8', bodyClass: 'manager-embedded' }],
  ['/renderer.js', { file: 'renderer.js', type: 'text/javascript; charset=utf-8' }],
  ['/community/qq-group.png', { file: 'community/qq-group.png', type: 'image/png' }],
])

export interface LocalRendererServer {
  url: string
  close(): Promise<void>
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error)
    server.once('error', onError)
    server.listen(0, HOST, () => {
      server.removeListener('error', onError)
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('无法读取桌面渲染服务端口'))
        return
      }
      resolve(address.port)
    })
  })
}

/** Serve only the built desktop shell over loopback so its Harness iframe is same-site. */
export async function startLocalRendererServer(root: string): Promise<LocalRendererServer> {
  const server = createServer((request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' })
      response.end()
      return
    }

    let pathname: string
    try {
      pathname = new URL(request.url ?? '/', `http://${HOST}`).pathname
    } catch {
      response.writeHead(400, { 'cache-control': 'no-store' })
      response.end()
      return
    }
    const asset = ASSETS.get(pathname)
    if (!asset) {
      response.writeHead(404, { 'cache-control': 'no-store' })
      response.end()
      return
    }

    void readFile(join(root, asset.file)).then((body) => {
      const servedBody = asset.bodyClass
        ? Buffer.from(body.toString('utf8').replace('<body>', `<body class="${asset.bodyClass}">`))
        : body
      response.writeHead(200, {
        'content-type': asset.type,
        'content-length': servedBody.byteLength,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      })
      response.end(request.method === 'HEAD' ? undefined : servedBody)
    }, () => {
      response.writeHead(404, { 'cache-control': 'no-store' })
      response.end()
    })
  })

  const port = await listen(server)
  let closed = false
  return {
    url: `http://${HOST}:${port}/index.html`,
    close: () => {
      if (closed) return Promise.resolve()
      closed = true
      return new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve())
      })
    },
  }
}
