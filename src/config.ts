import schema from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'
import type { NotifySettings } from './contract.ts'

export interface Config { settings: Volatile<NotifySettings> }
export const Config = schema.object({
  settings: schema.object({
    enabled: schema.boolean().default(true).description('启用主动通知，停用后保留历史消息。'),
    popup: schema.boolean().default(true).description('收到新通知时显示简短提示。'),
    quiet: schema.boolean().default(false).description('静默时段仅暂停提示，不影响入站。'),
    quietStart: schema.string().default('22:00'),
    quietEnd: schema.string().default('08:00'),
    retentionDays: schema.number().default(90).description('已读消息保留天数，0 表示永久保留。'),
    batchSize: schema.number().min(1).max(100).default(20),
    concurrency: schema.number().min(1).max(10).default(2),
    maxRetries: schema.number().min(0).max(20).default(5),
  }).volatile(),
})
