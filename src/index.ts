import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-app-boot'
import { Config } from './config.ts'
import { NotifyStore } from './store.ts'
import { NotifyService } from './service.ts'
import { registerNotifyTool } from './tools.ts'
import { registerRpc } from './rpc.ts'

export { Config, NotifyService }
export type { NotificationInput, NotificationSource, NotifySettings } from './contract.ts'
export const name = 'agent-notify'
export const inject = ['profileContext', 'tools', 'connection', 'settings', 'loader', 'sessionController']

/** All runtime work lives in the official CLI-owned Host and its plugin lifecycle. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const profile = await realpath(ctx.profileContext.dir)
  const scope = createHash('sha256').update(profile).digest('hex').slice(0,24)
  const store = await NotifyStore.open(join(ctx.profileContext.home, 'agent-notify', scope))
  const service = new NotifyService(ctx, config, store)
  try {
    service.settings()
    ctx.effect(() => () => service.close(), 'agent-notify: database and worker')
    ctx.provide('agentNotify', service)
    ctx.effect(() => ctx.settings.configure({ auto: false }), 'agent-notify: custom settings')
    registerNotifyTool(ctx, service)
    registerRpc(ctx, service)
    service.dispatcher.start()
  } catch (error) { await service.close(); throw error }
}
