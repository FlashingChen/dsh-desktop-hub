/**
 * 内嵌管理中心（Plugin/MCP/Skills 中心）的地址契约。
 *
 * 中心不再由桌面壳层直接渲染，而是由 Harness 侧边栏在 shell 的子帧中打开
 * /manager.html?embedded=1。这个地址同时被三处消费，必须只有一处定义：
 *   1. 渲染层：响应 Harness 侧边栏的 manager-url-request 握手；
 *   2. 主进程：IPC 来源校验据此判定「哪些子帧是合法中心」（见 navigation.ts）；
 *   3. 冒烟：--smoke 复现同一拓扑来验证中心真的能加载数据。
 * 任何一处单独改 URL 都会让其中一方验证到生产根本不会下发的地址。
 */
export const MANAGER_CENTER_TABS = ['plugin', 'mcp', 'skills', 'updates', 'feedback'] as const

export type ManagerCenterTab = (typeof MANAGER_CENTER_TABS)[number]

export function isManagerCenterTab(value: string | null | undefined): value is ManagerCenterTab {
  return MANAGER_CENTER_TABS.includes(value as ManagerCenterTab)
}

/** 以壳层地址为基准拼出内嵌管理中心地址；`tab` 决定中心打开后停在哪个工作区。 */
export function embeddedManagerUrl(shellUrl: string, tab: ManagerCenterTab = 'plugin'): string {
  const url = new URL('/manager.html', shellUrl)
  url.searchParams.set('embedded', '1')
  url.searchParams.set('tab', tab)
  return url.href
}
