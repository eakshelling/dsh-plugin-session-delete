/**
 * dsh-plugin-session-delete — Client 面。
 *
 * 在会话右键菜单（contextMenus target = 'session'）里加一条红色「删除对话」。
 * 点击后弹出自己的确认框（注册到 shell.overlay），确认后 POST 到 Host 的
 * `/dsh-session-delete/delete`。
 *
 * 会话正在使用中（Host 返回 409 `session-live`）时不再做无用的「归档 + 重试」：
 * DSH 把打开过的对话常驻在内存里，归档不会卸载它，重试永远不会成功。改为把该
 * 会话写进 Host 的待删队列，并明确告诉用户：完全重启 DeepSeek Harness 后，
 * 插件会在任何对话被打开之前删掉它。
 *
 * 不 import 任何内置客户端包：React 由模块加载器注入，图标注册进
 * `contextMenu.icon` keyed slot，文案用自带字典。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-session-delete',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const zh = String(navigator.language || '').toLowerCase().startsWith('zh')

    const STR = zh
      ? {
          menu: '删除对话',
          title: '彻底删除对话？',
          intro: (name) => `将永久删除「${name}」的会话记录：`,
          items: ['会话日志文件', '投影缓存', '工作区中的会话登记（含固定 / 归档状态）'],
          irreversible: '此操作不可撤销，删除后无法恢复。',
          queuedNote: '该对话已排队，重启 DeepSeek Harness 后会自动删除。',
          confirm: '删除',
          cancel: '取消',
          retry: '重试',
          busy: '正在删除…',
          deleted: '对话已彻底删除',
          owned: '该对话正被另一个 DeepSeek Harness 进程使用，请先关闭它再重试。',
          locked: '会话文件被占用，无法删除。请稍后再试。',
          live: '该对话仍在使用中，无法立即删除。',
          queuedTitle: '已排队，重启后删除',
          queuedBody: (name) => `「${name}」正在使用中，本次运行无法删除。已加入待删队列：\n\n完全退出（含托盘）并重新启动 DeepSeek Harness 后，插件会在任何对话被打开之前把它删掉。也可以随时在这里取消排队。`,
          queuedToast: '已加入待删队列，重启后自动删除',
          queueFailed: '无法加入待删队列：',
          unqueue: '取消排队',
          unqueued: '已取消排队',
          know: '知道了',
          invalid: '会话标识不合法，已取消删除。',
          unreachable: '插件服务未响应，请重启 DeepSeek Harness 后重试。',
          badRequest: '请求被插件拒绝（安全检查未通过）。',
          unknown: '删除失败。',
        }
      : {
          menu: 'Delete conversation',
          title: 'Permanently delete conversation?',
          intro: (name) => `This permanently deletes the session record of “${name}”:`,
          items: ['the session log files', 'the projection cache', 'workspace membership (including pin / archive state)'],
          irreversible: 'This cannot be undone.',
          queuedNote: 'This conversation is queued and will be deleted after DeepSeek Harness restarts.',
          confirm: 'Delete',
          cancel: 'Cancel',
          retry: 'Retry',
          busy: 'Deleting…',
          deleted: 'Conversation deleted',
          owned: 'Another DeepSeek Harness process is using this conversation. Close it and retry.',
          locked: 'The session files are locked. Try again later.',
          live: 'The conversation is still in use and cannot be deleted right now.',
          queuedTitle: 'Queued for deletion on restart',
          queuedBody: (name) => `“${name}” is in use, so it cannot be deleted in this run. It has been queued:\n\nfully quit (including the tray icon) and restart DeepSeek Harness — the plugin deletes it before any conversation is opened. You can also cancel the queue here.`,
          queuedToast: 'Queued; it will be deleted after restart',
          queueFailed: 'Could not add to the delete queue: ',
          unqueue: 'Cancel queue',
          unqueued: 'Removed from the delete queue',
          know: 'OK',
          invalid: 'Invalid session id; deletion cancelled.',
          unreachable: 'The plugin service did not respond. Restart DeepSeek Harness and retry.',
          badRequest: 'The plugin rejected the request (security check failed).',
          unknown: 'Deletion failed.',
        }

    /** 插件内部错误：带稳定 code 便于映射文案。 */
    class DeleteError extends Error {
      constructor(code, message, cause) {
        super(message)
        this.name = 'DeleteError'
        this.code = code
        if (cause) this.cause = cause
      }
    }

    // ---------------------------------------------------------------- 状态

    function createStore(initial) {
      let state = initial
      const listeners = new Set()
      return {
        get: () => state,
        set: (next) => {
          state = next
          for (const listener of listeners) {
            try { listener() } catch { /* 单个订阅者失败不影响其他 */ }
          }
        },
        subscribe: (listener) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
      }
    }

    /**
     * { dialog: null | { phase, sessionId, title, message?, queued? },
     *   toast: null | { text, ok } }
     */
    const store = createStore({ dialog: null, toast: null })
    let toastTimer = 0

    function setDialog(dialog) {
      store.set({ ...store.get(), dialog })
    }

    function showToast(text, ok) {
      store.set({ ...store.get(), toast: { text, ok: ok !== false } })
      clearTimeout(toastTimer)
      toastTimer = setTimeout(() => {
        const current = store.get()
        if (current.toast && current.toast.text === text) store.set({ ...current, toast: null })
      }, 3200)
    }

    function closeDialog() {
      const current = store.get()
      if (current.dialog && current.dialog.phase === 'busy') return
      setDialog(null)
    }

    /** 只更新仍然指向同一会话的对话框，避免异步结果覆盖用户已经关掉/换掉的框。 */
    function patchDialog(sessionId, patch) {
      const current = store.get().dialog
      if (!current || current.sessionId !== sessionId) return
      setDialog({ ...current, ...patch })
    }

    // ---------------------------------------------------------------- 网络

    /** 与 dshmarket 相同的部署前缀兼容：相对 document.baseURI 解析。 */
    function apiPath(path) {
      const relative = path.replace(/^\/+/, '')
      if (typeof document === 'undefined') return '/' + relative
      return new URL(relative, document.baseURI).pathname
    }

    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms))
    }

    /** POST 一个 JSON 请求，统一返回 { status, ok, payload }。 */
    async function postJson(route, body) {
      let response
      try {
        response = await fetch(apiPath(route), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body || {}),
        })
      } catch (error) {
        throw new DeleteError('network', STR.unreachable, error)
      }
      let payload = {}
      try {
        payload = await response.json()
      } catch { /* 非 JSON 响应按原状态处理 */ }
      const ok = response.ok && payload && payload.ok === true
      return { status: response.status, ok, payload: payload || {} }
    }

    function postDelete(sessionId) {
      return postJson('dsh-session-delete/delete', { sessionId })
    }

    function postQueue(sessionId, title) {
      return postJson('dsh-session-delete/queue', { sessionId, title })
    }

    function postUnqueue(sessionId) {
      return postJson('dsh-session-delete/unqueue', { sessionId })
    }

    function postPending(sessionId) {
      return postJson('dsh-session-delete/pending', { sessionId })
    }

    function describeError(error) {
      if (!error) return STR.unknown
      switch (error.code) {
        case 'session-owned': return STR.owned
        case 'file-locked': return STR.locked
        case 'session-live': return STR.live
        case 'queue-failed': return (STR.queueFailed || '') + (error.message || '')
        case 'invalid-session':
        case 'unsafe-path': return STR.invalid
        case 'network': return STR.unreachable
        case 'method-not-allowed':
        case 'unsupported-media-type':
        case 'cross-origin': return STR.badRequest
        default: break
      }
      return error.message || STR.unknown
    }

    /** 删除；会话仍在使用时改为排队，不再重试。 */
    async function runDelete(sessionId, title) {
      const ctx = ctxRef
      setDialog({ phase: 'busy', sessionId, title })
      try {
        let result = await postDelete(sessionId)
        // file-locked 通常是杀毒/索引的瞬时占用，值得再试一次。
        if (result.status === 409 && result.payload.code === 'file-locked') {
          await sleep(400)
          result = await postDelete(sessionId)
        }
        if (result.status === 409 && result.payload.code === 'session-live') {
          const queued = await postQueue(sessionId, title)
          if (!queued.ok) {
            throw new DeleteError(
              queued.payload.code || 'queue-failed',
              queued.payload.message || STR.queueFailed,
            )
          }
          logQueue(sizeOf(queued.payload), sessionId)
          setDialog({ phase: 'queued', sessionId, title })
          showToast(STR.queuedToast, true)
          return
        }
        if (!result.ok) {
          throw new DeleteError(
            result.payload.code || 'http-' + result.status,
            result.payload.message || STR.unknown,
          )
        }
        setDialog(null)
        showToast(STR.deleted, true)
        try {
          await ctx.sessions.refresh()
        } catch { /* 行最迟在下次刷新时消失 */ }
      } catch (error) {
        setDialog({ phase: 'error', sessionId, title, message: describeError(error) })
      }
    }

    function sizeOf(payload) {
      return Array.isArray(payload?.items) ? payload.items.length : 0
    }

    function logQueue(size, sessionId) {
      try {
        console.info(`[session-delete] queued ${sessionId} (queue size ${size}); it will be deleted on next start`)
      } catch { /* 控制台不可用忽略 */ }
    }

    /** 取消排队：仅当该会话确实在队列里时有效。 */
    async function cancelQueue(sessionId, title) {
      try {
        const result = await postUnqueue(sessionId)
        if (!result.ok) {
          throw new DeleteError(result.payload.code || 'unjqueue-failed', result.payload.message || STR.unknown)
        }
        setDialog(null)
        if (result.payload.removed) showToast(STR.unqueued, true)
      } catch (error) {
        setDialog({ phase: 'error', sessionId, title, message: describeError(error) })
      }
    }

    /**
     * 打开确认框后异步问一下 Host：这条对话是否已经在队列里？
     * 队列状态变化只影响提示文字，不阻塞确认框显示。
     */
    async function refreshQueued(sessionId) {
      try {
        const result = await postPending(sessionId)
        if (!result.ok) return
        const items = Array.isArray(result.payload.items) ? result.payload.items : []
        patchDialog(sessionId, { queued: items.some((item) => item && item.sessionId === sessionId) })
      } catch { /* 查询失败就当没排队，删除时会再判断 */ }
    }

    function requestDelete(target) {
      const sessionId = target && target.sessionId
      if (!sessionId) return
      const title = (target && target.displayTitle) || sessionId
      setDialog({ phase: 'confirm', sessionId, title, queued: false })
      void refreshQueued(sessionId)
    }

    // ---------------------------------------------------------------- 图标

    function TrashIcon() {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: 16,
          height: 16,
          'aria-hidden': 'true',
          focusable: 'false',
          fill: 'currentColor',
        },
        h('path', {
          d:
            'M6 1.5a1 1 0 0 0-1 1V3H3.5a.75.75 0 0 0 0 1.5h.34l.6 8.18A2 2 0 0 0 6.43 14.5h3.14a2 2 0 0 0 1.99-1.82l.6-8.18h.34a.75.75 0 0 0 0-1.5H11V2.5a1 1 0 0 0-1-1H6Zm0 1.5h4v-.5H6V3Zm.5 2.5a.6.6 0 0 1 .6.6l.2 6a.6.6 0 0 1-1.2.04l-.2-6a.6.6 0 0 1 .6-.64Zm2.4.6a.6.6 0 0 1 1.2.04l-.2 6a.6.6 0 0 1-1.2-.04l.2-6Z',
        }),
      )
    }

    // ---------------------------------------------------------------- 样式

    const backdropStyle = {
      position: 'fixed',
      inset: 0,
      zIndex: 2147483200,
      background: 'rgba(15, 18, 24, 0.38)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '24px',
      fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
    }

    const cardStyle = {
      width: 'min(440px, 100%)',
      boxSizing: 'border-box',
      background: 'var(--dsw-alias-bg-elevated, #ffffff)',
      color: 'var(--dsw-alias-text-primary, #1f2329)',
      border: '1px solid var(--dsw-alias-border-subtle, rgba(0,0,0,0.08))',
      borderRadius: '14px',
      boxShadow: '0 18px 60px rgba(0,0,0,0.28)',
      padding: '20px 20px 16px',
      fontSize: '13px',
      lineHeight: 1.55,
    }

    const toastStyle = (ok) => ({
      position: 'fixed',
      left: '50%',
      bottom: '32px',
      transform: 'translateX(-50%)',
      zIndex: 2147483300,
      maxWidth: 'min(460px, calc(100vw - 48px))',
      padding: '9px 16px',
      borderRadius: '10px',
      background: ok ? 'rgba(24, 121, 78, 0.96)' : 'rgba(178, 44, 44, 0.96)',
      color: '#fff',
      fontSize: '13px',
      fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
      boxShadow: '0 8px 28px rgba(0,0,0,0.28)',
      pointerEvents: 'none',
    })

    const buttonBase = {
      height: '32px',
      padding: '0 14px',
      borderRadius: '8px',
      fontSize: '13px',
      cursor: 'pointer',
      border: '1px solid transparent',
      fontFamily: 'inherit',
      lineHeight: '30px',
    }

    const dangerBox = {
      marginBottom: '14px',
      padding: '8px 10px',
      borderRadius: '8px',
      background: 'rgba(217, 45, 32, 0.08)',
      color: 'var(--dsw-alias-text-danger, #b42318)',
    }

    const noteBox = {
      marginBottom: '14px',
      padding: '8px 10px',
      borderRadius: '8px',
      background: 'rgba(217, 145, 32, 0.12)',
      color: 'var(--dsw-alias-text-primary, #7a4b00)',
    }

    const messageBox = {
      marginBottom: '12px',
      padding: '8px 10px',
      borderRadius: '8px',
      background: 'rgba(217, 45, 32, 0.10)',
      color: 'var(--dsw-alias-text-danger, #b42318)',
      whiteSpace: 'pre-wrap',
    }

    function secondaryButton(overrides) {
      return {
        ...buttonBase,
        background: 'transparent',
        color: 'var(--dsw-alias-text-secondary, #5b6472)',
        borderColor: 'var(--dsw-alias-border-subtle, rgba(0,0,0,0.16))',
        ...overrides,
      }
    }

    function primaryButton(overrides) {
      return {
        ...buttonBase,
        background: 'var(--dsw-alias-bg-danger, #d92d20)',
        color: '#ffffff',
        ...overrides,
      }
    }

    // ---------------------------------------------------------------- 对话框

    function DialogCard({ dialog }) {
      const phase = dialog.phase
      const busy = phase === 'busy'
      const queued = phase === 'queued'

      return h(
        'div',
        {
          style: backdropStyle,
          onClick: (event) => {
            if (event.target === event.currentTarget) closeDialog()
          },
        },
        h(
          'div',
          {
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': 'session-delete-title',
            style: cardStyle,
          },
          h('div', {
            id: 'session-delete-title',
            style: { fontSize: '15px', fontWeight: 600, marginBottom: '8px' },
          }, queued ? STR.queuedTitle : STR.title),
          queued
            ? h('div', { style: { opacity: 0.86, whiteSpace: 'pre-wrap' } }, STR.queuedBody(dialog.title))
            : h(
                React.Fragment,
                null,
                h('div', { style: { opacity: 0.86 } }, STR.intro(dialog.title)),
                h('ul', { style: { margin: '8px 0 10px', paddingLeft: '18px', opacity: 0.86 } },
                  STR.items.map((item, index) => h('li', { key: index }, item))),
                h('div', { style: dangerBox }, STR.irreversible),
                dialog.queued ? h('div', { style: noteBox }, STR.queuedNote) : null,
              ),
          busy
            ? h('div', { role: 'status', style: { marginBottom: '12px', opacity: 0.72 } }, STR.busy)
            : null,
          phase === 'error'
            ? h('div', { role: 'alert', style: messageBox }, dialog.message)
            : null,
          h('div', {
            style: { display: 'flex', justifyContent: 'flex-end', gap: '8px' },
          },
          queued
            ? h('button', {
                type: 'button',
                style: secondaryButton(),
                onClick: () => { void cancelQueue(dialog.sessionId, dialog.title) },
              }, STR.unqueue)
            : null,
          h('button', {
            type: 'button',
            style: secondaryButton({ opacity: busy ? 0.5 : 1, cursor: busy ? 'default' : 'pointer' }),
            disabled: busy,
            autoFocus: true,
            onClick: closeDialog,
          }, queued ? STR.know : STR.cancel),
          queued
            ? null
            : h('button', {
                type: 'button',
                style: primaryButton({ opacity: busy ? 0.6 : 1, cursor: busy ? 'default' : 'pointer' }),
                disabled: busy,
                onClick: () => { void runDelete(dialog.sessionId, dialog.title) },
              }, phase === 'error' ? STR.retry : STR.confirm)),
        ),
      )
    }

    function DeleteDialog() {
      const state = React.useSyncExternalStore(store.subscribe, store.get)
      const dialog = state ? state.dialog : null
      const toast = state ? state.toast : null

      React.useEffect(() => {
        if (!dialog) return undefined
        const onKeyDown = (event) => {
          if (event.key === 'Escape' && dialog.phase !== 'busy') {
            event.preventDefault()
            event.stopPropagation()
            closeDialog()
          }
        }
        window.addEventListener('keydown', onKeyDown, true)
        return () => { window.removeEventListener('keydown', onKeyDown, true) }
      }, [dialog])

      if (!dialog && !toast) return null
      return h(
        React.Fragment,
        null,
        dialog ? h(DialogCard, { dialog }) : null,
        toast ? h('div', { role: 'status', style: toastStyle(toast.ok) }, toast.text) : null,
      )
    }

    // ---------------------------------------------------------------- 挂载

    let ctxRef = null

    return {
      inject: ['slots', 'contextMenus', 'sessions'],
      apply(ctx) {
        ctxRef = ctx

        ctx.effect(() => ctx.contextMenus.register({
          id: 'session.delete',
          target: 'session',
          order: 650,
          resolve: (target) => [{
            id: 'delete',
            label: STR.menu,
            icon: { key: 'session-delete.trash' },
            danger: true,
            separatorBefore: true,
            run: () => requestDelete(target),
          }],
        }), 'session-delete: session menu')

        ctx.slots.inject('contextMenu.icon', () => ctx.slots.register(
          { name: 'contextMenu.icon', key: 'session-delete.trash' },
          TrashIcon,
        ))

        ctx.slots.inject('shell.overlay', () => ctx.slots.register(
          { name: 'shell.overlay', id: 'session-delete.dialog' },
          DeleteDialog,
        ))
      },
    }
  },
})
