import { mkdtemp,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { expect,it } from 'vitest'
import { NotifyStore } from '../src/store.ts'
import { Dispatcher } from '../src/dispatcher.ts'
import { defaultSettings } from '../src/contract.ts'

it('does not deliver while disabled, wakes when enabled, and drains an accepted send before closing',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'notify-dispatch-'))
  const store=await NotifyStore.open(directory)
  let enabled=false,entered=false,release!:()=>void
  const barrier=new Promise<void>(resolve=>{release=resolve})
  const dispatcher=new Dispatcher(store,()=>({...defaultSettings,enabled}),async job=>{entered=true;await barrier;store.publish(job)})
  try{
    store.submit({title:'完成',body:'待投递',category:'result'},{kind:'agent',agentId:'a',agentName:'Agent',sessionId:'a',parentSessionId:null,workspace:'',callId:'one'})
    dispatcher.start();await delay(50)
    expect(store.status().counts.pending).toBe(1)
    enabled=true;dispatcher.wake()
    for(let i=0;i<100&&!entered;i++)await delay(10)
    expect(entered).toBe(true)
    let stopped=false
    const closing=dispatcher.stop().then(()=>{stopped=true})
    await delay(10);expect(stopped).toBe(false)
    release();await closing
    expect(store.status().counts.sent).toBe(1)
  }finally{release();await dispatcher.stop();await store.close();await rm(directory,{recursive:true,force:true})}
})
