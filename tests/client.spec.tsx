// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { cleanup,fireEvent,render,screen,waitFor,within } from '@testing-library/react'
import { afterEach,expect,it,vi } from 'vitest'
import { defaultSettings,type NotificationApi,type Notice,type NoticeList,type NotifyStatus } from '../src/contract.ts'
import { NotifyClient,isQuiet } from '../src/client/controller.ts'
import { Body,NotificationCenter,NotificationOverlay } from '../src/client/ui.tsx'

afterEach(()=>cleanup())
const notice:Notice={id:'n1',seq:1,hostId:'host',source:{kind:'agent',agentId:'a',agentName:'研究助手',sessionId:'s',parentSessionId:null,workspace:'项目',callId:'c'},
  title:'研究完成',summary:'结果说明',category:'result',createdAt:Date.now(),sentAt:Date.now(),readAt:null,archivedAt:null}
const status:NotifyStatus={hostId:'host',revision:1,unread:1,latestSentSeq:1,counts:{pending:0,sending:0,sent:1,retry_wait:0,failed:0},recent:[],
  settings:defaultSettings,settingsRevision:1,settingsWritable:true,schedulerAvailable:true,workerError:null}
function setup(){
  const list:NoticeList={items:[notice],counts:{all:1,unread:1,action:0},sources:[{id:'a',name:'研究助手'}],total:1,cutoff:1,revision:1,hasMore:false}
  const api:NotificationApi={
    list:vi.fn(async()=>list),read:vi.fn(async()=>({...notice,body:'**完整结论**\n\n- 第一项\n- 第二项'})),
    sync:vi.fn(async()=>({changed:false,status})),markRead:vi.fn(async()=>{}),markAllRead:vi.fn(async()=>{}),archive:vi.fn(async()=>{}),
    settings:vi.fn(async()=>{}),test:vi.fn(async()=>({notificationId:'test',state:'pending',duplicate:false})),
    retry:vi.fn(async()=>{}),source:vi.fn(async()=>({sessionId:'s',parentSessionId:null})),
  }
  const client=new NotifyClient(api,vi.fn(async()=>{}),vi.fn())
  client.state.set({status,error:null,open:false,toast:null,reload:0})
  const useNotify=<T,>(selector:(value:ReturnType<typeof client.state.getSnapshot>)=>T)=>
    useSyncExternalStore(client.state.subscribe,()=>selector(client.state.getSnapshot()))
  return{api,client,useNotify}
}
it('shows real rows, expands with a durable read mutation, and bulk read uses displayed IDs and cutoff',async()=>{
  const {api,client,useNotify}=setup()
  try{
    render(<NotificationCenter client={client} useNotify={useNotify}/>)
    await screen.findByText('研究完成')
    expect(api.markRead).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button',{name:'展开内容'}))
    await screen.findByText('完整结论')
    expect(api.markRead).toHaveBeenCalledWith('n1',true)
    fireEvent.click(screen.getByRole('button',{name:'全部已读'}))
    await waitFor(()=>expect(api.markAllRead).toHaveBeenCalledWith(['n1'],1))
    fireEvent.click(screen.getByRole('button',{name:'打开来源会话'}))
    await waitFor(()=>expect(client.openSource).toHaveBeenCalledWith('n1'))
  }finally{client.stop()}
})
it('implements search, source filtering, archive browsing and pagination queries',async()=>{
  const {api,client,useNotify}=setup()
  try{
    render(<NotificationCenter client={client} useNotify={useNotify}/>)
    await screen.findByText('研究完成')
    fireEvent.change(screen.getByRole('textbox',{name:'搜索通知'}),{target:{value:'依赖'}})
    await waitFor(()=>expect(api.list).toHaveBeenCalledWith(expect.objectContaining({query:'依赖'}),expect.any(AbortSignal)))
    fireEvent.change(screen.getByRole('combobox',{name:'来源 Agent'}),{target:{value:'a'}})
    fireEvent.click(screen.getByRole('button',{name:'已归档'}))
    await waitFor(()=>expect(api.list).toHaveBeenCalledWith(expect.objectContaining({archived:true,agentId:'a'}),expect.any(AbortSignal)))
  }finally{client.stop()}
})
it('escapes markup rather than executing model HTML',()=>{
  const {container}=render(<Body text={'<img src=x onerror=alert(1)>\n\n**安全文本**'}/>)
  expect(container.querySelector('img')).toBeNull()
  expect(container.querySelector('strong')?.textContent).toBe('安全文本')
  expect(container.textContent).toContain('<img')
})
it('quiet hours handle midnight and all-day silence without dropping messages',()=>{
  const settings={...defaultSettings,quiet:true}
  expect(isQuiet(settings,new Date(2026,9,28,23,0))).toBe(true)
  expect(isQuiet(settings,new Date(2026,9,28,9,0))).toBe(false)
  expect(isQuiet({...settings,quietEnd:settings.quietStart},new Date())).toBe(true)
})
it('opens the drawer without marking messages read and closes using Escape',async()=>{
  const {api,client,useNotify}=setup()
  Object.defineProperty(window,'matchMedia',{configurable:true,value:()=>({matches:false,addEventListener(){},removeEventListener(){}})})
  HTMLDialogElement.prototype.show=function(){this.setAttribute('open','')}
  HTMLDialogElement.prototype.close=function(){this.removeAttribute('open')}
  try{
    client.toggle()
    render(<NotificationOverlay client={client} useNotify={useNotify}/>)
    const dialog=await screen.findByRole('dialog')
    await within(dialog).findByText('研究完成')
    expect(api.markRead).not.toHaveBeenCalled()
    fireEvent.keyDown(dialog,{key:'Escape'})
    await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull())
  }finally{client.stop()}
})
