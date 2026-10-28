import type { NotificationApi } from '../contract.ts'

export function createApi(lifetime: AbortSignal, base = document.baseURI): NotificationApi {
  async function call<T>(method: string, args: object, signal?: AbortSignal): Promise<T> {
    const name = 'agentNotify/' + method
    const response = await fetch(new URL('./api/' + name, base), {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      signal: AbortSignal.any([lifetime, AbortSignal.timeout(15000), ...(signal ? [signal] : [])]),
      body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: name, payload: { args } }),
    })
    if (!response.ok) throw new Error(response.status === 401 ? '连接认证已失效，请重新打开 DSH。' : '通知服务暂时不可用。')
    const envelope = await response.json()
    if (envelope?.result?.ok !== true) throw new Error(envelope?.result?.error?.message ?? '通知请求失败。')
    return envelope.result.value as T
  }
  return {
    list: (query, signal) => call('list', query, signal),
    read: id => call('read', { id }),
    sync: (after, signal) => call('sync', { after }, signal),
    markRead: (id, read) => call('markRead', { id, read }),
    markAllRead: (ids, cutoff) => call('markAllRead', { ids, cutoff }),
    archive: (id, archived) => call('archive', { id, archived }),
    settings: (value, revision) => call('settings', { value, revision }),
    test: () => call('test', {}),
    retry: id => call('retry', { id }),
    source: id => call('source', { id }),
  }
}
