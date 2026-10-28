import { mkdir,readFile,writeFile,access } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { Processes,cleanEnvironment,officialBinary,prepareFixture,boot,prompt,until,redact } from './runtime-test.mjs'

const {values}=parseArgs({options:{'release-url':{type:'string'},'tarball':{type:'string'}}})
const root=fileURLToPath(new URL('..',import.meta.url))
const taskRoot=join(homedir(),'.dsh-agent-notify-demo')
const taskHome=join(taskRoot,'home')
const profile='notify-demo'
const processes=new Processes(cleanEnvironment(taskRoot,taskHome))
let closing=false
let resolveExit
const exit=new Promise(resolve=>{resolveExit=resolve})
const stop=()=>{if(!closing){closing=true;resolveExit()}}
process.on('SIGINT',stop);process.on('SIGTERM',stop)
try{
  await mkdir(taskRoot,{recursive:true,mode:0o700})
  await mkdir(join(root,'.artifacts'),{recursive:true})
  await writeFile(join(taskRoot,'.npmrc'),'registry=https://registry.npmjs.org/\n')
  const manifest=JSON.parse(await readFile(join(root,'package.json'),'utf8'))
  const {binary}=await officialBinary(root)
  let fresh=false
  try{await access(join(taskHome,'profiles',profile,'package.json'))}catch{
    fresh=true
    await processes.command(process.execPath,[binary,'--profile',profile,'--from-default-profile','web','--dump-config'],taskRoot)
  }
  let spec=values['release-url']??values.tarball
  if(!spec){
    const packed=JSON.parse(await processes.command('npm',['pack','--ignore-scripts','--json','--pack-destination',join(root,'.artifacts')],root))[0]
    const bytes=await readFile(join(root,'.artifacts',packed.filename))
    spec=join(root,'.artifacts','notify-demo-'+createHash('sha256').update(bytes).digest('hex').slice(0,16)+'.tgz')
    await writeFile(spec,bytes)
  }
  // A rebuilt local tarball can keep its version; force prevents pnpm reusing old bytes.
  await processes.command(process.execPath,[binary,'plugin','--profile',profile,'add',spec,'--ignore-scripts','--force'],taskRoot)
  await prepareFixture(taskRoot,binary,processes,profile,manifest.engines.dsh,join(root,'tests/fixtures/model.mjs'),fresh)
  await mkdir(join(taskRoot,'通知验证'),{recursive:true})
  const app=await boot(binary,profile,taskRoot,processes)
  await writeFile(join(root,'.artifacts/local-demo.json'),JSON.stringify({
    pid:process.pid,hostPid:app.state.child.pid,origin:app.origin,url:app.url,dshHome:taskHome,profile,
    fixtureModel:true,installedFrom:spec,
  },null,2)+'\n',{mode:0o600})
  const previous=await app.rpc('agentNotify/list',{})
  if(!previous.items.some(item=>item.title==='定时检查已完成')){
    for(const [name,text] of [['研究助手','NOTIFY_A'],['交互评审','NOTIFY_B'],['后台巡检','NOTIFY_SCHEDULE']]){
      const session=await app.rpc('session/create',{request:{cwd:join(taskRoot,'通知验证')}})
      await app.rpc('session/rename',{request:{sessionId:session.sessionId,title:name}})
      await prompt(app,session.sessionId,text)
    }
    await until(async()=> (await app.rpc('agentNotify/status')).counts.sent>=3)
  }
  console.log('Local notification plugin is running: '+app.origin)
  console.log('Isolated profile: '+profile+'; integration fixture model (no paid model calls).')
  await Promise.race([exit,app.state.done.then(()=>{if(!closing)throw new Error('DSH stopped: '+redact(app.state.stderr).slice(-3000))})])
}catch(error){console.error(redact(error.message??error));process.exitCode=1}
finally{
  await processes.close()
  process.off('SIGINT',stop);process.off('SIGTERM',stop)
}
