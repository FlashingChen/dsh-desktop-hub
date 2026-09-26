type DidFailLoadListener = (
  event: unknown,
  errorCode: number,
  errorDescription: string,
  validatedURL: string,
  isMainFrame: boolean,
) => void

export interface InitialPageWindow {
  webContents: {
    on(event: 'did-fail-load', listener: DidFailLoadListener): unknown
    removeListener(event: 'did-fail-load', listener: DidFailLoadListener): unknown
  }
  loadURL(url: string): Promise<void>
}

export interface InitialPageLoadFailure {
  source: 'loadURL' | 'did-fail-load'
  detail: string
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error)
}

/**
 * Load the shell after installing its failure listener. Electron reports the same
 * failure through both did-fail-load and the loadURL Promise, so only the first
 * terminal result is delivered to the caller.
 */
export function loadInitialPage(
  win: InitialPageWindow,
  url: string,
  onFailure: (failure: InitialPageLoadFailure) => void,
): void {
  let settled = false
  let didFailFallback: NodeJS.Immediate | null = null

  const detach = (): void => {
    win.webContents.removeListener('did-fail-load', onDidFailLoad)
  }
  const fail = (failure: InitialPageLoadFailure): void => {
    if (settled) return
    settled = true
    if (didFailFallback) clearImmediate(didFailFallback)
    didFailFallback = null
    detach()
    onFailure(failure)
  }
  const onDidFailLoad: DidFailLoadListener = (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || settled || didFailFallback) return
    // loadURL normally rejects for the same failure. Give that rejection one
    // turn to provide the richer Error/stack, then fall back to the event data.
    didFailFallback = setImmediate(() => {
      didFailFallback = null
      fail({
        source: 'did-fail-load',
        detail: `${errorCode} ${errorDescription}${validatedURL ? ` (${validatedURL})` : ''}`,
      })
    })
  }

  win.webContents.on('did-fail-load', onDidFailLoad)
  let load: Promise<void>
  try {
    load = win.loadURL(url)
  } catch (error) {
    fail({ source: 'loadURL', detail: errorDetail(error) })
    return
  }
  void load.then(
    () => {
      if (settled) return
      settled = true
      if (didFailFallback) clearImmediate(didFailFallback)
      didFailFallback = null
      detach()
    },
    (error: unknown) => fail({ source: 'loadURL', detail: errorDetail(error) }),
  )
}
