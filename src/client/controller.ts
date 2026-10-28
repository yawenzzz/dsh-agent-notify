import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { NotificationApi, NotifyStatus } from '../contract.ts'

export interface ViewState {
  status: NotifyStatus | null
  error: string | null
  open: boolean
  toast: string | null
  reload: number
}
export function isQuiet(settings: NotifyStatus['settings'], date = new Date()): boolean {
  if (!settings.quiet) return false
  const time = String(date.getHours()).padStart(2,'0') + ':' + String(date.getMinutes()).padStart(2,'0')
  return settings.quietStart === settings.quietEnd || (settings.quietStart < settings.quietEnd
    ? time >= settings.quietStart && time < settings.quietEnd : time >= settings.quietStart || time < settings.quietEnd)
}
/** One connection feed shared by the bell, drawer, center, and settings. */
export class NotifyClient {
  readonly state = createSnapshotStore<ViewState>({ status: null, error: null, open: false, toast: null, reload: 0 })
  private timer: ReturnType<typeof setTimeout> | undefined
  private toastTimer: ReturnType<typeof setTimeout> | undefined
  private stopped = false
  private epoch = 0
  private pending: AbortController | undefined
  private previousStatus = ''
  returnFocus: HTMLElement | null = null
  constructor(readonly api: NotificationApi, readonly openSource: (id: string) => Promise<void>,
    readonly navigate: (page: 'center' | 'settings' | 'conversation') => void) {}
  start(): void { void this.refresh() }
  async refresh(): Promise<void> {
    if (this.stopped) return
    clearTimeout(this.timer)
    this.pending?.abort()
    const pending = new AbortController(); this.pending = pending
    const epoch = ++this.epoch
    try {
      const prior = this.state.getSnapshot()
      const { status } = await this.api.sync(prior.status?.revision ?? -1, pending.signal)
      if (this.stopped || epoch !== this.epoch) return
      const encoded = JSON.stringify(status)
      const hostChanged = !!prior.status && prior.status.hostId !== status.hostId
      if (encoded !== this.previousStatus || prior.error) {
        this.previousStatus = encoded
        this.state.set({ ...this.state.getSnapshot(), status, error: null,
          reload: this.state.getSnapshot().reload + (hostChanged ? 1 : 0) })
      }
      if (!hostChanged && prior.status && status.latestSentSeq > prior.status.latestSentSeq && status.settings.popup && !isQuiet(status.settings) && !prior.open) {
        this.notice('收到新的 Agent 通知', false)
      }
    } catch (error) {
      if (!this.stopped && epoch === this.epoch) this.state.set({ ...this.state.getSnapshot(),
        error: error instanceof Error ? error.message : '连接已断开，保留已加载内容。' })
    } finally {
      if (!this.stopped && epoch === this.epoch) this.timer = setTimeout(() => { void this.refresh() },
        typeof document !== 'undefined' && document.hidden ? 30000 : 2000)
    }
  }
  async command(action: () => Promise<unknown>): Promise<void> {
    await action()
    if (this.stopped) return
    const state = this.state.getSnapshot()
    this.state.set({ ...state, reload: state.reload + 1 })
    await this.refresh()
  }
  toggle(): void {
    if (!this.state.getSnapshot().open) this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    this.state.set({ ...this.state.getSnapshot(), open: !this.state.getSnapshot().open })
  }
  close(): void {
    this.state.set({ ...this.state.getSnapshot(), open: false })
    this.returnFocus?.isConnected && this.returnFocus.focus({ preventScroll: true })
  }
  show(page: 'center' | 'settings' | 'conversation'): void { this.close(); this.navigate(page) }
  notice(text: string, announce = true): void {
    clearTimeout(this.toastTimer)
    this.state.set({ ...this.state.getSnapshot(), toast: text })
    this.toastTimer = setTimeout(() => { if (!this.stopped) this.state.set({ ...this.state.getSnapshot(), toast: null }) }, announce ? 5000 : 4000)
  }
  stop(): void {
    this.stopped = true; this.epoch++
    clearTimeout(this.timer); clearTimeout(this.toastTimer); this.pending?.abort()
  }
}
