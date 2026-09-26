/** DSH Web client plugin that mounts the desktop manager into DSH's own sidebar. */
window.__ModuleLoader__.load({
  id: '@dsh-desktop-hub/manager',
  factory(require) {
    const React = require('react')
    const { IconPluginPinwheelOutlineRegular } = require('@deepseek-ai/dsh-client-ui-primitives')
    const localeId = 'dshDesktopHub'

    function ManagerPanel() {
      const [src, setSrc] = React.useState('')
      const [available, setAvailable] = React.useState(true)
      const frame = React.useRef(null)
      const sendTheme = React.useCallback(() => {
        if (!src || !frame.current?.contentWindow) return
        const style = window.getComputedStyle(document.body)
        const tokens = {
          '--surface': '--dsw-alias-bg-layer-1',
          '--canvas': '--dsw-alias-bg-layer-1',
          '--surface-subtle': '--dsw-alias-bg-module-platform',
          '--ink': '--dsw-alias-label-primary',
          '--ink-soft': '--dsw-alias-label-secondary',
          '--ink-faint': '--dsw-alias-label-tertiary',
          '--line': '--dsw-alias-border-l2',
          '--line-strong': '--dsw-alias-border-l4',
          '--brand': '--dsw-alias-state-business-primary',
          '--brand-dark': '--dsw-alias-state-business-primary',
        }
        const theme = Object.fromEntries(Object.entries(tokens).map(([key, token]) => [key, style.getPropertyValue(token).trim()]))
        frame.current.contentWindow.postMessage({ type: 'dsh-desktop-hub/theme', theme, colorScheme: style.colorScheme }, new URL(src).origin)
      }, [src])

      React.useEffect(() => {
        const observer = new MutationObserver(sendTheme)
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-ds-theme-source'] })
        observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'style', 'data-ds-dark-theme'] })
        const media = window.matchMedia('(prefers-color-scheme: dark)')
        media.addEventListener('change', sendTheme)
        sendTheme()
        return () => {
          observer.disconnect()
          media.removeEventListener('change', sendTheme)
        }
      }, [sendTheme])

      React.useEffect(() => {
        let timer
        const receive = (event) => {
          if (event.source !== window.parent || event.data?.type !== 'dsh-desktop-hub/manager-url') return
          const candidate = event.data.url
          try {
            const url = new URL(candidate)
            if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/manager.html') return
            setSrc(url.href)
            setAvailable(true)
            window.clearTimeout(timer)
          } catch {
            // Ignore malformed messages from the hosting frame.
          }
        }

        window.addEventListener('message', receive)
        window.parent.postMessage({ type: 'dsh-desktop-hub/manager-url-request' }, '*')
        timer = window.setTimeout(() => setAvailable(false), 8000)
        return () => {
          window.removeEventListener('message', receive)
          window.clearTimeout(timer)
        }
      }, [])

      if (!src) {
        return React.createElement('div', {
          style: {
            alignItems: 'center',
            color: 'var(--text-secondary, #737880)',
            display: 'flex',
            height: '100%',
            justifyContent: 'center',
            padding: 32,
            textAlign: 'center',
          },
        }, available ? '正在连接桌面管理器…' : '请从 DSH Desktop Hub 打开此面板。')
      }

      return React.createElement('iframe', {
        ref: frame,
        onLoad: sendTheme,
        title: 'DSH Desktop Hub',
        src,
        allow: 'clipboard-read; clipboard-write',
        style: { border: 0, display: 'block', height: '100%', minHeight: 0, width: '100%' },
      })
    }

    function ManagerIcon({ size }) {
      return React.createElement(IconPluginPinwheelOutlineRegular, { size })
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(localeId, {
          zh: { panel: '桌面管理' },
          en: { panel: 'Desktop Hub' },
        }))
        const t = ctx.locale.bind(localeId)
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'dsh-desktop-hub',
        }, ManagerPanel))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'dsh-desktop-hub',
          order: 100,
          label: () => t('panel'),
          locale: localeId,
        }, ManagerIcon))
      },
    }
  },
})
