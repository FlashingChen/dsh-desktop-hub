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
