// M0 骨架：Tab 切换 + 版本信息展示。功能面板在 M1-M4 逐项实现。

interface DesktopApi {
  versions: { electron: string; node: string; chrome: string }
}

declare global {
  interface Window {
    dshDesktop?: DesktopApi
  }
}

const TABS = ['harness', 'plugin', 'mcp', 'skills'] as const
type TabId = (typeof TABS)[number]

function switchTab(id: TabId): void {
  for (const t of TABS) {
    document.querySelector(`[data-tab="${t}"]`)?.classList.toggle('active', t === id)
    document.getElementById(`panel-${t}`)?.classList.toggle('active', t === id)
  }
}

for (const t of TABS) {
  document.querySelector(`[data-tab="${t}"]`)?.addEventListener('click', () => switchTab(t))
}

const api = window.dshDesktop
if (api) {
  const el = document.getElementById('footer-versions')
  if (el) {
    el.textContent = `Electron ${api.versions.electron} · Node ${api.versions.node} · Chromium ${api.versions.chrome}`
  }
}
