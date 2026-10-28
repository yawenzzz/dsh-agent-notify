import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NotifyStore } from '../src/store.ts'
import { listQuerySchema, type NotificationSource } from '../src/contract.ts'

const input = { title:'结果已就绪',body:'需要你查看的结论。',category:'result' as const,dedupe_key:'report-1' }
const source: NotificationSource = {kind:'agent',agentId:'session-a',agentName:'研究助手',sessionId:'session-a',parentSessionId:null,workspace:'项目 A',callId:'call-a'}
describe('durable notifications',()=>{
  let directory:string,store:NotifyStore
  beforeEach(async()=>{directory=await mkdtemp(join(tmpdir(),'notify-unit-'));store=await NotifyStore.open(directory)})
  afterEach(async()=>{await store.close();await rm(directory,{recursive:true,force:true})})
  function publish(){for(const job of store.claim(100,'worker'))store.publish(job)}
  it('persists pending content and recovers a claimed delivery without duplicating the inbox',async()=>{
    const receipt=store.submit(input,source)
    expect(store.status().unread).toBe(0)
    store.claim(1,'crashed-worker')
    const hostId=store.hostId
    await store.close();store=await NotifyStore.open(directory)
    expect(store.hostId).toBe(hostId)
    expect(store.status().counts.pending).toBe(1)
    const job=store.claim(1,'recovered')[0]
    store.publish(job);store.publish(job)
    expect(store.status().unread).toBe(1)
    expect(store.read(receipt.notificationId).body).toBe(input.body)
    await store.close();store=await NotifyStore.open(directory)
    expect(store.status().counts.sent).toBe(1)
    expect(store.status().unread).toBe(1)
  })
  it('deduplicates call and business keys, rejects changed content, and rolls back conflicts',()=>{
    const first=store.submit(input,source)
    expect(store.submit(input,source)).toMatchObject({notificationId:first.notificationId,duplicate:true})
    expect(store.submit(input,{...source,callId:'retry'})).toMatchObject({notificationId:first.notificationId,duplicate:true})
    expect(()=>store.submit({...input,body:'different'},source)).toThrow('另一条内容')
    // A conflicting business key must not consume the new call key.
    expect(()=>store.submit({...input,body:'different'},{...source,callId:'fresh'})).toThrow()
    const next=store.submit({...input,dedupe_key:'report-2',body:'different'},{...source,callId:'fresh'})
    expect(next.notificationId).not.toBe(first.notificationId)
    expect(store.status().counts.pending).toBe(2)
  })
  it('binds keys to source identity and stores sender data independently of mutable inputs',()=>{
    const origin={...source}
    const a=store.submit(input,origin)
    origin.agentName='changed'
    const b=store.submit(input,{...source,agentId:'session-b',sessionId:'session-b'})
    publish()
    expect(a.notificationId).not.toBe(b.notificationId)
    expect(store.read(a.notificationId).source.agentName).toBe('研究助手')
  })
  it('bulk read only affects the displayed IDs and watermark while later messages stay unread',()=>{
    const a=store.submit(input,source);publish()
    const snapshot=store.list(listQuerySchema.parse({}))
    const b=store.submit({...input,dedupe_key:'report-2'},{...source,callId:'call-b'});publish()
    store.markAllRead([a.notificationId,b.notificationId],snapshot.cutoff)
    expect(store.read(a.notificationId).readAt).not.toBeNull()
    expect(store.read(b.notificationId).readAt).toBeNull()
    expect(store.status().unread).toBe(1)
    store.markRead(a.notificationId,false)
    store.archive(b.notificationId,true)
    expect(store.status().unread).toBe(1)
    store.archive(b.notificationId,false)
    expect(store.status().unread).toBe(2)
  })
  it('searches full content and paginates summaries without putting full bodies on list responses',()=>{
    store.submit({...input,body:'a'.repeat(300)+' 隐藏关键词'},source)
    store.submit({...input,title:'待确认',category:'action',dedupe_key:'other'},{...source,callId:'other'});publish()
    const search=store.list(listQuerySchema.parse({query:'隐藏关键词'}))
    expect(search.total).toBe(1)
    expect(search.items[0]).not.toHaveProperty('body')
    const page=store.list(listQuerySchema.parse({limit:1}))
    expect(page.hasMore).toBe(true)
    expect(page.items[0].title).toBe('待确认')
    expect(page.counts).toEqual({all:2,unread:2,action:1})
  })
  it('retains unread and queued content while pruning only old read deliveries',()=>{
    const old=Date.now()-100*86400000
    const read=store.submit(input,source,old)
    store.submit({...input,dedupe_key:'unread'},{...source,callId:'unread'},old)
    publish();store.markRead(read.notificationId,true,old)
    store.submit({...input,dedupe_key:'pending'},{...source,callId:'pending'},old)
    expect(store.prune(90)).toBe(1)
    expect(store.status().unread).toBe(1)
    expect(store.status().counts.pending).toBe(1)
  })
  it('refuses a second writer and releases the lock on disposal',async()=>{
    await expect(NotifyStore.open(directory)).rejects.toThrow()
    await store.close()
    store=await NotifyStore.open(directory)
    expect(store.status().unread).toBe(0)
  })
  it('preserves a corrupt database rather than creating an empty replacement',async()=>{
    await store.close()
    const path=join(directory,'notifications.sqlite')
    await writeFile(path,'not-a-sqlite-database')
    await expect(NotifyStore.open(directory)).rejects.toThrow()
    expect(await readFile(path,'utf8')).toBe('not-a-sqlite-database')
  })
  it('retains explicit failure state and allows only safe retries',()=>{
    const receipt=store.submit(input,source)
    const job=store.claim(1,'worker',100)[0]
    store.fail(job,'temporary error',0,101)
    expect(store.status().counts.failed).toBe(1)
    store.retry(receipt.notificationId)
    expect(store.status().counts.pending).toBe(1)
    publish()
    expect(()=>store.retry(receipt.notificationId)).toThrow('明确失败')
  })
})
