export interface TrayWindowState {
  destroyed: boolean
  minimized: boolean
  visible: boolean
}

export type TrayWindowAction = 'show' | 'hide'

/** Decide whether a tray activation should restore/show or hide the main window. */
export function getTrayWindowAction(state: TrayWindowState): TrayWindowAction {
  if (state.destroyed || state.minimized || !state.visible) return 'show'
  return 'hide'
}
