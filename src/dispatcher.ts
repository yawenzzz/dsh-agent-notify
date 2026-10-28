import { randomUUID } from 'node:crypto'
import type { NotifySettings } from './contract.ts'
import type { ClaimedDelivery, NotifyStore } from './store.ts'

/** Independent of model execution, but owned and drained by the DSH plugin. */
export class Dispatcher {
  private timer: ReturnType<typeof setTimeout> | undefined
  private running: Promise<void> | undefined
  private stopped = false
  private owner = randomUUID()
  private lastPrune = 0
  error: string | null = null
  constructor(private store: NotifyStore, private settings: () => NotifySettings,
    private deliver: (job: ClaimedDelivery) => void | Promise<void> = job => store.publish(job)) {}
  start(): void { this.wake() }
  wake(): void {
    if (this.stopped || this.running) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.running = this.tick().catch(error => { this.error = error instanceof Error ? error.message : '通知投递失败。' })
        .finally(() => {
          this.running = undefined
          if (!this.stopped) this.timer = setTimeout(() => this.wake(), 500)
        })
    }, 0)
  }
  private async tick(): Promise<void> {
    const settings = this.settings()
    if (Date.now() - this.lastPrune > 3600000) { this.store.prune(settings.retentionDays); this.lastPrune = Date.now() }
    if (!settings.enabled) return
    const jobs = this.store.claim(settings.batchSize, this.owner)
    for (let offset = 0; offset < jobs.length; offset += settings.concurrency) {
      await Promise.all(jobs.slice(offset, offset + settings.concurrency).map(async job => {
        try { await this.deliver(job) }
        catch (error) { this.store.fail(job, error instanceof Error ? error.message : '投递失败。', settings.maxRetries) }
      }))
    }
    this.error = null
  }
  async stop(): Promise<void> {
    this.stopped = true
    clearTimeout(this.timer)
    await this.running
  }
}
