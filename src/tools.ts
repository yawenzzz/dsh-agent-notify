import { basename } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { foldSessionTitle } from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-agent'
import { notificationInputSchema } from './contract.ts'
import type { NotifyService } from './service.ts'

/** Context supplies authorship and Session linkage; no model-supplied sender fields. */
export function sourceFromExecution(execution: ToolRunContext) {
  const agent = execution.agent
  if (!agent) throw new Error('notify_user requires a native Agent session.')
  return {
    kind: 'agent' as const, agentId: agent.id, sessionId: agent.id,
    parentSessionId: agent.session.header.parentSession ?? null,
    agentName: (foldSessionTitle(agent.session.snapshotEvents())?.title ?? agent.session.header.agentPreset ?? 'Agent').slice(0,256),
    workspace: agent.session.header.cwd ? basename(agent.session.header.cwd).slice(0,256) : '',
    callId: execution.callId,
  }
}
export function registerNotifyTool(ctx: Context, service: NotifyService): void {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'notify_user',
    description: 'Send a durable proactive notification to this DSH application owner. Use for meaningful task results, reminders, or information requiring the user’s attention, including after a schedule wakes you. Normal chat replies do not need duplicate notifications. Keep quiet when there is no useful change. The host sets your identity and source session. A queued result means durably accepted, not read by the user. Never claim a human has approved or read something. Reuse a stable dedupe_key when retrying the same business notification.',
    parameters: {
      title: { type: 'string', required: true, description: 'Short notification title, 1–120 characters.' },
      body: { type: 'string', required: true, description: 'Useful message text; simple Markdown is supported, up to 16 KiB. Never include credentials.' },
      category: { type: 'string', enum: ['general', 'result', 'action'], description: 'general, result, or action (needs user attention).' },
      dedupe_key: { type: 'string', description: 'Optional stable business event key, scoped to this Agent session, at most 160 characters.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { result: { type: 'string', required: true } } },
      render: (_args: unknown, value: { result: string }) => [{ type: 'text', text: value.result }],
    },
    execute: async (args, execution) => {
      const receipt = service.send(notificationInputSchema.parse(args), sourceFromExecution(execution), execution.signal)
      return { result: JSON.stringify({ ...receipt, status: receipt.state === 'sent' ? 'sent' : 'queued', read: false }) }
    },
  })), 'agent-notify: notification tool')
}
