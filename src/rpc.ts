import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection'
import { z } from 'zod'
import { listQuerySchema, settingsSchema } from './contract.ts'
import type { NotifyService } from './service.ts'
import { NotifyError } from './store.ts'

const id = z.string().uuid()
function operation<T>(schema: z.ZodType<T>, run: (input: T, signal: AbortSignal) => unknown | Promise<unknown>) {
  return (input: unknown, signal: AbortSignal) => run(schema.parse(input), signal)
}
/** Exact Fetch routes inherit official DSH owner authentication and Origin checks. */
export function registerRpc(ctx: Context, service: NotifyService): void {
  const store = service.store
  const methods = {
    list: operation(listQuerySchema, value => store.list(value)),
    read: operation(z.strictObject({ id }), value => store.read(value.id)),
    sync: operation(z.strictObject({ after: z.number().int().min(-1) }), ({ after }) => {
      const status = service.status(); return { changed: after !== status.revision, status }
    }),
    status: operation(z.strictObject({}), () => service.status()),
    markRead: operation(z.strictObject({ id, read: z.boolean() }), value => { store.markRead(value.id, value.read); return null }),
    markAllRead: operation(z.strictObject({ ids: z.array(id).max(5000), cutoff: z.number().int().nonnegative() }),
      value => { store.markAllRead(value.ids, value.cutoff); return null }),
    archive: operation(z.strictObject({ id, archived: z.boolean() }), value => { store.archive(value.id, value.archived); return null }),
    settings: operation(z.strictObject({ value: settingsSchema, revision: z.number().int().nonnegative() }),
      async value => { await service.updateSettings(value.value, value.revision); return null }),
    test: operation(z.strictObject({}), (_value, signal) => service.send({
      title: '通知功能已就绪', body: '这是一条由你手动发送的测试通知。消息已经持久化，刷新页面或重启 DSH 后仍可查看。',
      category: 'general',
    }, { kind: 'test', agentId: 'notification-test', agentName: '通知测试', sessionId: null, parentSessionId: null, workspace: '', callId: randomUUID() }, signal)),
    retry: operation(z.strictObject({ id }), value => { store.retry(value.id); service.dispatcher.wake(); return null }),
    source: operation(z.strictObject({ id }), async (value, signal) => {
      const { source } = store.read(value.id)
      if (source.sessionId === null) throw new NotifyError('source_unavailable', '这条测试或系统通知没有来源会话。')
      const entries = await ctx.sessionController.list({}, signal)
      const target = source.parentSessionId ?? source.sessionId
      if (!entries.items.some(item => item.sessionId === target)) throw new NotifyError('source_unavailable', '来源会话可能已归档或删除。通知正文仍然保留。')
      return { sessionId: source.sessionId, parentSessionId: source.parentSessionId }
    }),
  }
  for (const [name, handler] of Object.entries(methods)) {
    const method = 'agentNotify/' + name
    ctx.effect(() => ctx.connection.fetch.register({
      path: '/api/' + method, methods: ['POST'], requestBody: 'buffered',
      async fetch(request) {
        if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') return new Response('Expected application/json', { status: 415 })
        const raw = await request.text()
        if (Buffer.byteLength(raw) > 256 * 1024) return new Response('Request too large', { status: 413 })
        let envelope: z.infer<typeof clientRequestSchema>
        try {
          envelope = clientRequestSchema.parse(JSON.parse(raw))
          if (envelope.method !== method) return new Response('Mismatched RPC method', { status: 400 })
        } catch { return new Response('Invalid RPC envelope', { status: 400 }) }
        try {
          request.signal.throwIfAborted()
          const payload = z.strictObject({ args: z.unknown() }).parse(envelope.payload)
          const value = await handler(payload.args, request.signal)
          return Response.json({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value } })
        } catch (error) {
          const code = error instanceof NotifyError ? error.code : error instanceof z.ZodError ? 'invalid_request'
            : error instanceof Error && 'code' in error && error.code === 'SETTINGS_CONFLICT' ? 'settings_conflict' : 'operation_failed'
          const message = error instanceof NotifyError ? error.message : error instanceof z.ZodError ? '请求内容不符合要求。'
            : code === 'settings_conflict' ? '设置已在其他窗口更新，请重新加载后再保存。' : '通知操作失败，请重试或检查 DSH 日志。'
          if (code === 'operation_failed') ctx.logger.warn('Notification operation failed', error)
          return Response.json({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: false, error: { code, message, details: {} } } })
        }
      },
    }), 'agent-notify: ' + method)
  }
}
