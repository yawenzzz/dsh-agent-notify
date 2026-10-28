import type { Context } from '@deepseek-ai/cordis'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { createApi } from './api.ts'
import { NotifyClient } from './controller.ts'
import { NotificationBell, NotificationCenter, NotificationIcon, NotificationOverlay, NotificationSettings, type Face } from './ui.tsx'

export const inject = ['slots','layout','uiWorkspace']
export function apply(ctx: Context): void {
  const lifetime = new AbortController()
  const center = 'agent-notify-center' as MainPanelId, settings = 'agent-notify-settings' as MainPanelId
  const api = createApi(lifetime.signal)
  const client = new NotifyClient(api, async id => {
    const target = await api.source(id)
    ctx.uiWorkspace.openSession(target.parentSessionId
      ? { parentSessionId: target.parentSessionId as SessionId, childSessionId: target.sessionId as SessionId, mode: 'unknown' }
      : target.sessionId as SessionId)
    await api.markRead(id,true)
    client.close()
    await client.refresh()
  }, page => ctx.layout.selectPanel(page==='center'?center:page==='settings'?settings:null))
  const face: Face = { hooks: { notify: client.state }, client }
  ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register({ name: 'sidebar.footer.action', id: 'agent-notify-bell', inject: () => face }, NotificationBell)))
  ctx.effect(() => ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register({ name: 'shell.overlay', id: 'agent-notify-overlay', inject: () => face }, NotificationOverlay)))
  ctx.effect(() => ctx.slots.inject('main', function* () {
    yield ctx.slots.register({ name: 'main', key: center, inject: () => face }, NotificationCenter)
    yield ctx.slots.register({ name: 'main', key: settings, inject: () => face }, NotificationSettings)
  }))
  ctx.effect(() => ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register({ name: 'sidebar.panellist', id: center, label: '通知中心', order: 10 }, NotificationIcon)))
  ctx.effect(() => {
    const refresh = () => { if (!document.hidden) void client.refresh() }
    document.addEventListener('visibilitychange',refresh)
    window.addEventListener('focus',refresh)
    window.addEventListener('online',refresh)
    client.start()
    return () => {
      lifetime.abort(); client.stop()
      document.removeEventListener('visibilitychange',refresh)
      window.removeEventListener('focus',refresh)
      window.removeEventListener('online',refresh)
    }
  }, 'agent-notify: browser connection')
}
