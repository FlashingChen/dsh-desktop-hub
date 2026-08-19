// Electron 权限白名单：只放行可信 Harness iframe 的剪贴板交互，其他权限默认拒绝。
// 该策略同时供 request/check 两条 Electron 权限路径使用，避免两条路径结果不一致。
const ALLOWED_PERMISSIONS = new Set([
  'clipboard-sanitized-write',
  'clipboard-read',
])

export interface PermissionContext {
  /** 发起请求的 frame 是否为主 frame；剪贴板只对 Harness 子 frame 开放。 */
  isMainFrame: boolean
  /** permission check 提供的 origin。 */
  requestingOrigin?: string
  /** permission request/check 提供的 frame URL（跨源 check 可能没有）。 */
  requestingUrl?: string
  /** 跨源子 frame 的嵌入者 origin。 */
  embeddingOrigin?: string
  /** 当前实际 Harness 的 origin；为空表示 Harness 尚未就绪。 */
  trustedOrigin?: string | null
}

function originOf(value: string | undefined): string | null {
  if (!value) return null
  try {
    const origin = new URL(value).origin
    return origin === 'null' ? null : origin
  } catch {
    return null
  }
}

function isLoopbackHttpOrigin(origin: string): boolean {
  try {
    const url = new URL(origin)
    return url.protocol === 'http:' && url.hostname === '127.0.0.1'
  } catch {
    return false
  }
}

function isTrustedShellOrigin(origin: string): boolean {
  // Chromium 对 file:// 的 origin 可能报告为 file:// 或 null；只接受这两种
  // 壳层嵌入来源，不接受任意远程页面作为 clipboard 权限的 embeddingOrigin。
  if (origin === 'file://' || origin === 'null') return true
  try {
    return new URL(origin).protocol === 'file:'
  } catch {
    return false
  }
}

export function isPermissionAllowed(permission: string, context?: PermissionContext): boolean {
  if (!ALLOWED_PERMISSIONS.has(permission)) return false
  if (!context || context.isMainFrame || !context.trustedOrigin) return false

  // requestingUrl 对 request 和同源 check 更接近实际发起请求的 frame；跨源 check
  // 按 Electron API 约定没有 requestingUrl 时再使用 requestingOrigin。
  const requestingOrigin = originOf(context.requestingUrl) ?? originOf(context.requestingOrigin)
  if (!requestingOrigin || requestingOrigin !== context.trustedOrigin) return false
  if (!isLoopbackHttpOrigin(requestingOrigin)) return false

  // embeddingOrigin 只在跨源子 frame 中提供；未提供时不额外限制，同源子 frame
  // 仍属于已验证的 Harness origin。提供时必须是本应用 file:// 壳层。
  return context.embeddingOrigin === undefined || isTrustedShellOrigin(context.embeddingOrigin)
}

export interface PermissionRequestDetails {
  isMainFrame: boolean
  requestingUrl: string
}

export interface PermissionCheckDetails {
  isMainFrame: boolean
  requestingUrl?: string
  embeddingOrigin?: string
}

/**
 * 生成 Electron 两条权限回调的适配器。
 * 单测可以直接捕获并调用这两个回调，避免只靠主进程源码正则测试权限行为。
 */
export function createPermissionHandlers(getTrustedOrigin: () => string | null): {
  request: (permission: string, callback: (granted: boolean) => void, details: PermissionRequestDetails) => void
  check: (permission: string, requestingOrigin: string, details: PermissionCheckDetails) => boolean
} {
  return {
    request(permission, callback, details) {
      callback(isPermissionAllowed(permission, {
        isMainFrame: details.isMainFrame,
        requestingUrl: details.requestingUrl,
        trustedOrigin: getTrustedOrigin(),
      }))
    },
    check(permission, requestingOrigin, details) {
      return isPermissionAllowed(permission, {
        isMainFrame: details.isMainFrame,
        requestingOrigin,
        requestingUrl: details.requestingUrl,
        embeddingOrigin: details.embeddingOrigin,
        trustedOrigin: getTrustedOrigin(),
      })
    },
  }
}
