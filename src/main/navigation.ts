function isAllowedHarnessNavigation(candidateUrl: string, harnessUrl: string | null): boolean {
  if (!harnessUrl) return false

  try {
    const candidate = new URL(candidateUrl)
    const trustedHarness = new URL(harnessUrl)

    if (
      trustedHarness.protocol !== 'http:'
      || trustedHarness.hostname !== '127.0.0.1'
      || trustedHarness.username !== ''
      || trustedHarness.password !== ''
    ) return false

    return candidate.protocol === trustedHarness.protocol
      && candidate.hostname === trustedHarness.hostname
      && candidate.port === trustedHarness.port
      && candidate.origin === trustedHarness.origin
      && candidate.username === ''
      && candidate.password === ''
  } catch {
    return false
  }
}

/** General trusted-page check used after a known Harness iframe navigation. */
export function isAllowedNavigation(candidateUrl: string, rendererUrl: string, harnessUrl: string | null): boolean {
  return candidateUrl === rendererUrl || isAllowedHarnessNavigation(candidateUrl, harnessUrl)
}

function isAllowedManagerNavigation(candidateUrl: string, rendererUrl: string): boolean {
  try {
    const shell = new URL(rendererUrl)
    const manager = new URL(candidateUrl)
    return shell.protocol === 'http:'
      && shell.hostname === '127.0.0.1'
      && manager.protocol === shell.protocol
      && manager.hostname === shell.hostname
      && manager.port === shell.port
      && manager.origin === shell.origin
      && manager.pathname === '/manager.html'
      && manager.username === ''
      && manager.password === ''
      && manager.hash === ''
      && manager.searchParams.get('embedded') === '1'
      && ['plugin', 'mcp', 'skills', 'updates', 'feedback'].includes(manager.searchParams.get('tab') ?? '')
      && [...manager.searchParams.keys()].every((key) => key === 'embedded' || key === 'tab')
  } catch {
    return false
  }
}

/**
 * Frame-aware navigation policy: the main frame must remain the exact desktop
 * shell, while only subframes may navigate inside the current Harness origin.
 */
export function isAllowedFrameNavigation(
  candidateUrl: string,
  isMainFrame: boolean,
  rendererUrl: string,
  harnessUrl: string | null,
): boolean {
  return isMainFrame
    ? candidateUrl === rendererUrl
    : isAllowedHarnessNavigation(candidateUrl, harnessUrl) || isAllowedManagerNavigation(candidateUrl, rendererUrl)
}

/**
 * IPC 来源策略，与上面的导航策略同口径：主帧只能是壳层本身，子帧只认内嵌管理中心。
 * 中心 UI 由 Harness 侧边栏在 shell 的子帧中打开（/manager.html?embedded=1），
 * 若沿用「只接受壳层主帧」会把整个中心的读/写 IPC 全部拒掉。
 * 判定复用 isAllowedManagerNavigation，因此子帧仍被严格约束在自有 loopback 的
 * manager.html 上——不放宽到任意子帧或 Harness 源。
 */
export function isAllowedIpcSender(candidateUrl: string, isMainFrame: boolean, rendererUrl: string): boolean {
  return isMainFrame
    ? candidateUrl === rendererUrl
    : isAllowedManagerNavigation(candidateUrl, rendererUrl)
}

export interface NavigationGuardEvent {
  url: string
  isMainFrame: boolean
  preventDefault: () => void
}

/** Same handler is safe for will-frame-navigate and will-redirect. */
export function createNavigationGuard(
  rendererUrl: string,
  harnessUrl: () => string | null,
): (details: NavigationGuardEvent) => void {
  return (details) => {
    if (!isAllowedFrameNavigation(details.url, details.isMainFrame, rendererUrl, harnessUrl())) {
      details.preventDefault()
    }
  }
}
