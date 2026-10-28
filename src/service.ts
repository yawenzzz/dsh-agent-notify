import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-schedule'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { settingsSchema, type NotificationInput, type NotificationSource, type NotifySettings, type NotifyStatus } from './contract.ts'
import type { Config } from './config.ts'
import { NotifyError, type NotifyStore } from './store.ts'
import { Dispatcher } from './dispatcher.ts'

declare module '@deepseek-ai/cordis' { interface Context { agentNotify: NotifyService } }

/** Host-only sending capability. Browser mutation routes never accept source identities. */
export class NotifyService {
  readonly dispatcher: Dispatcher
  private stopped = false
  constructor(private ctx: Context, private config: Config, readonly store: NotifyStore) {
    this.dispatcher = new Dispatcher(store, () => this.settings())
  }
  settings(): NotifySettings { return settingsSchema.parse(this.config.settings.get()) }
  private descriptor() {
    const entry = [...this.ctx.loader.entries()].find(item => item.fiber === this.ctx.fiber)
    return this.ctx.settings.describe({ redactSecrets: true }).find(item => item.ns === entry?.options.id)
  }
  status(): NotifyStatus {
    const descriptor = this.descriptor()
    return { ...this.store.status(), settings: this.settings(), settingsRevision: descriptor?.revision ?? 0,
      settingsWritable: !!descriptor && this.ctx.settings.writable,
      schedulerAvailable: !!this.ctx.get('schedule'), workerError: this.dispatcher.error }
  }
  async updateSettings(value: NotifySettings, expectedRevision: number): Promise<void> {
    const descriptor = this.descriptor()
    if (!descriptor) throw new NotifyError('settings_unavailable', '当前配置不可编辑，请检查插件 profile。')
    await this.ctx.settings.update(descriptor.ns, { settings: settingsSchema.parse(value) }, expectedRevision)
    this.dispatcher.wake()
  }
  send(input: NotificationInput, source: NotificationSource, signal?: AbortSignal) {
    if (this.stopped) throw new NotifyError('stopped', '通知服务已经停止。')
    signal?.throwIfAborted()
    if (!this.settings().enabled) throw new NotifyError('disabled', '主动通知已停用，历史消息仍可查看。')
    const receipt = this.store.submit(input, source)
    this.dispatcher.wake()
    return receipt
  }
  async close(): Promise<void> {
    this.stopped = true
    await this.dispatcher.stop()
    await this.store.close()
  }
}
