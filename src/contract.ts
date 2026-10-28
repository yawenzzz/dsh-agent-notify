import { z } from 'zod'

export const categorySchema = z.enum(['general', 'result', 'action'])
export const notificationInputSchema = z.strictObject({
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).refine(value => new TextEncoder().encode(value).length <= 16384, '正文不能超过 16 KiB'),
  category: categorySchema.default('general'),
  dedupe_key: z.string().trim().min(1).max(160).optional(),
})
export type NotificationInput = z.infer<typeof notificationInputSchema>
export const sourceSchema = z.strictObject({
  kind: z.enum(['agent', 'plugin', 'test']),
  agentId: z.string().min(1).max(256),
  agentName: z.string().min(1).max(256),
  sessionId: z.string().min(1).max(256).nullable(),
  parentSessionId: z.string().min(1).max(256).nullable().default(null),
  workspace: z.string().max(256),
  callId: z.string().min(1).max(256),
})
export type NotificationSource = z.infer<typeof sourceSchema>
export const settingsSchema = z.strictObject({
  enabled: z.boolean(),
  popup: z.boolean(),
  quiet: z.boolean(),
  quietStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  quietEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  retentionDays: z.union([z.literal(0), z.literal(7), z.literal(30), z.literal(90)]),
  batchSize: z.number().int().min(1).max(100),
  concurrency: z.number().int().min(1).max(10),
  maxRetries: z.number().int().min(0).max(20),
})
export type NotifySettings = z.infer<typeof settingsSchema>
export const defaultSettings: NotifySettings = {
  enabled: true, popup: true, quiet: false, quietStart: '22:00', quietEnd: '08:00',
  retentionDays: 90, batchSize: 20, concurrency: 2, maxRetries: 5,
}
export const listQuerySchema = z.strictObject({
  filter: z.enum(['all', 'unread', 'action']).default('all'),
  archived: z.boolean().default(false),
  agentId: z.string().max(256).default(''),
  query: z.string().trim().max(200).default(''),
  limit: z.number().int().min(1).max(5000).default(20),
})
export type ListQuery = z.infer<typeof listQuerySchema>
export interface Notice {
  id: string
  seq: number
  hostId: string
  source: NotificationSource
  title: string
  summary: string
  category: NotificationInput['category']
  createdAt: number
  sentAt: number
  readAt: number | null
  archivedAt: number | null
}
export interface NoticeDetail extends Notice { body: string }
export interface NoticeList {
  items: Notice[]
  counts: { all: number; unread: number; action: number }
  sources: { id: string; name: string }[]
  total: number
  cutoff: number
  revision: number
  hasMore: boolean
}
export type DeliveryState = 'pending' | 'sending' | 'sent' | 'retry_wait' | 'failed'
export interface Delivery {
  notificationId: string
  title: string
  state: DeliveryState
  attempts: number
  error: string | null
  createdAt: number
  updatedAt: number
  nextAttemptAt: number
}
export interface NotifyStatus {
  hostId: string
  revision: number
  unread: number
  latestSentSeq: number
  counts: Record<DeliveryState, number>
  recent: Delivery[]
  settings: NotifySettings
  settingsRevision: number
  settingsWritable: boolean
  schedulerAvailable: boolean
  workerError: string | null
}
export interface SubmitReceipt {
  notificationId: string
  state: DeliveryState
  duplicate: boolean
}
export interface NotificationApi {
  list(query: ListQuery, signal?: AbortSignal): Promise<NoticeList>
  read(id: string): Promise<NoticeDetail>
  sync(after: number, signal?: AbortSignal): Promise<{ changed: boolean; status: NotifyStatus }>
  markRead(id: string, read: boolean): Promise<void>
  markAllRead(ids: string[], cutoff: number): Promise<void>
  archive(id: string, archived: boolean): Promise<void>
  settings(value: NotifySettings, revision: number): Promise<void>
  test(): Promise<SubmitReceipt>
  retry(id: string): Promise<void>
  source(id: string): Promise<{ sessionId: string; parentSessionId: string | null }>
}
