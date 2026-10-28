import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir,readFile,writeFile,realpath } from 'node:fs/promises'
import { dirname,join,resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

export const redact=value=>String(value).replace(/([?&]token=)[^\s"'<>]+/g,'$1[redacted]')
export function cleanEnvironment(taskRoot,dshHome) {
  const clean=Object.fromEntries(Object.entries(process.env).filter(([key])=>
    !/KEY|TOKEN|SECRET|PASSWORD|AUTH/i.test(key)&&!/^(DSH_|RSI_|CODEX_|OPENAI_|DEEPSEEK_|ANTHROPIC_|GEMINI_|npm_)/i.test(key)&&key!=='NODE_OPTIONS'))
  return {...clean,DSH_HOME:dshHome,DSH_TELEMETRY_DISABLED:'1',NPM_CONFIG_USERCONFIG:join(taskRoot,'.npmrc'),NPM_CONFIG_REGISTRY:'https://registry.npmjs.org/'}
}
export class Processes {
  states=new Set()
  constructor(env) { this.env=env }
  start(command,args,cwd) {
    const child=spawn(command,args,{cwd,env:this.env,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']})
    const state={child,stdout:'',stderr:'',settled:false}
    child.stdout.setEncoding('utf8').on('data',data=>{state.stdout=(state.stdout+data).slice(-1024*1024)})
    child.stderr.setEncoding('utf8').on('data',data=>{state.stderr=(state.stderr+data).slice(-1024*1024)})
    state.done=new Promise(resolve=>{
      child.once('error',error=>{state.stderr+=error.message;resolve({code:-1})})
      child.once('close',(code,signal)=>resolve({code,signal}))
    }).finally(()=>{state.settled=true;this.states.delete(state)})
    this.states.add(state);return state
  }
  kill(state,signal='SIGTERM') {
    if(state.settled||!state.child.pid)return
    try{if(process.platform==='win32')state.child.kill(signal);else process.kill(-state.child.pid,signal)}
    catch(error){if(error.code!=='ESRCH')throw error}
  }
  async stop(state) {
    if(state.settled)return
    this.kill(state)
    const timer=setTimeout(()=>this.kill(state,'SIGKILL'),10000)
    try{await state.done}finally{clearTimeout(timer)}
  }
  async command(command,args,cwd,timeout=300000) {
    const state=this.start(command,args,cwd)
    let expired=false
    const timer=setTimeout(()=>{expired=true;this.kill(state,'SIGKILL')},timeout)
    try{
      const result=await state.done
      if(expired||result.code!==0)throw new Error(command+' failed: '+redact(state.stderr||state.stdout).slice(-8000))
      return state.stdout
    }finally{clearTimeout(timer)}
  }
  async close(){await Promise.allSettled([...this.states].map(state=>this.stop(state)))}
}
export async function until(probe,timeout=60000) {
  const deadline=Date.now()+timeout
  while(Date.now()<deadline){const result=await probe();if(result)return result;await delay(100)}
  throw new Error('Timed out waiting for an observed state')
}
export async function prepareFixture(root,binary,processes,profile,version,fixtureSource,configure=true) {
  const fixture=join(root,'fixture')
  await mkdir(fixture,{recursive:true})
  await writeFile(join(fixture,'package.json'),JSON.stringify({name:'notify-integration-fixture',version:'1.0.0',private:true,type:'module',
    exports:{'.':'./index.mjs','./package.json':'./package.json'},dsh:{bundle:{patch:'./bundle.yml'}},
    peerDependencies:{'@deepseek-ai/dsh-llm':version}})+'\n')
  await writeFile(join(fixture,'index.mjs'),await readFile(fixtureSource))
  await writeFile(join(fixture,'bundle.yml'),'- insert:\n    - id: notify-fixture\n      name: notify-integration-fixture\n')
  await processes.command(process.execPath,[binary,'plugin','--profile',profile,'add',fixture,'--ignore-scripts'],root)
  const path=join(processes.env.DSH_HOME,'profiles',profile,'cordis.patch.yml')
  if(configure)await writeFile(path,JSON.stringify([
    {id:'agent-default-model',config:{provider:'notify-fixture',model:'fixture'}},
    {id:'session-title-llm',disabled:true},
  ],null,2)+'\n')
}
export async function boot(binary,profile,root,processes) {
  const state=processes.start(process.execPath,[binary,'--profile',profile,'--no-open','--port','0'],root)
  const url=await until(()=>{
    if(state.settled)throw new Error('DSH exited during startup: '+redact(state.stderr||state.stdout).slice(-10000))
    return state.stdout.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+)/)?.[1]
  })
  return {state,url,...await connect(url)}
}
export async function connect(url) {
  const origin=new URL(url).origin
  const response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(15000)})
  assert.equal(response.status,303)
  const cookie=response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ')
  assert.ok(cookie)
  async function rpc(method,args={}) {
    const result=await fetch(origin+'/api/'+method,{method:'POST',headers:{cookie,'content-type':'application/json'},
      signal:AbortSignal.timeout(30000),body:JSON.stringify({type:'client-request',rpcId:randomUUID(),method,payload:{args}})})
    assert.equal(result.status,200,method+' HTTP response')
    const data=await result.json()
    if(!data.result?.ok)throw new Error(method+': '+data.result?.error?.message)
    return data.result.value
  }
  return{origin,rpc,cookie}
}
export async function prompt(client,sessionId,text) {
  const before=await client.rpc('session/list',{_request:{}})
  const turns=before.items.find(item=>item.sessionId===sessionId)?.projections?.values?.sessionStats?.turns??0
  await client.rpc('session/prompt',{request:{requestId:randomUUID(),sessionId,mode:'queue',content:[{type:'text',text}]}})
  try{
    await until(async()=>{
      const list=await client.rpc('session/list',{_request:{}})
      const session=list.items.find(item=>item.sessionId===sessionId)
      return session&&!session.running&&(session.projections?.values?.sessionStats?.turns??0)>turns
    })
  }catch(error){throw new Error('Native turn did not complete for '+text+': '+error.message)}
}
export async function officialBinary(installation) {
  const directory=await realpath(join(installation,'node_modules/@deepseek-ai/dsh'))
  const manifest=JSON.parse(await readFile(join(directory,'package.json'),'utf8'))
  return{binary:resolve(directory,manifest.bin.dsh),manifest}
}
