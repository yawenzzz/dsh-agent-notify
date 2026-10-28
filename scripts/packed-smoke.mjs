import assert from 'node:assert/strict'
import { mkdir,mkdtemp,readFile,realpath,rm,writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join,relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Script } from 'node:vm'
import { parseArgs } from 'node:util'
import { Processes,cleanEnvironment,officialBinary,prepareFixture,boot,prompt,until,redact } from './runtime-test.mjs'

const {values}=parseArgs({options:{'release-url':{type:'string'}}})
const checkout=await realpath(fileURLToPath(new URL('..',import.meta.url)))
const manifest=JSON.parse(await readFile(join(checkout,'package.json'),'utf8'))
const taskRoot=await realpath(await mkdtemp(join(tmpdir(),'dsh-notify-packed-')))
const taskHome=join(taskRoot,'home')
const processes=new Processes(cleanEnvironment(taskRoot,taskHome))
const result={status:'failed',plugin:manifest.name,version:manifest.version,runtime:manifest.engines.dsh,checks:[],cleanup:'pending'}
const started=Date.now()
let interrupted=false
let app
const stop=()=>{interrupted=true;for(const state of processes.states)processes.kill(state)}
process.on('SIGINT',stop);process.on('SIGTERM',stop)
try{
  await writeFile(join(taskRoot,'.npmrc'),'registry=https://registry.npmjs.org/\n@deepseek-ai:registry=https://registry.npmjs.org/\n')
  await mkdir(join(taskRoot,'packed'));await mkdir(join(taskRoot,'runtime'));await mkdir(join(taskRoot,'workspace'))
  console.log('[smoke] Pack and inspect published files')
  const pack=JSON.parse(await processes.command('npm',['pack','--ignore-scripts','--json','--pack-destination',join(taskRoot,'packed')],checkout))[0]
  assert.ok(pack.files.some(file=>file.path==='dist/client.js'))
  assert.ok(pack.files.some(file=>file.path==='dist/index.js'))
  assert.ok(!pack.files.some(file=>/^(src|tests|node_modules|\.artifacts)\//.test(file.path)))
  result.checks.push('built-tarball-without-source-or-runtime')
  const tarball=join(taskRoot,'packed',pack.filename)
  console.log('[smoke] Install official DSH in a clean runtime and temporary DSH home')
  await writeFile(join(taskRoot,'runtime/package.json'),'{"name":"notify-clean-runtime","private":true,"type":"module"}\n')
  await processes.command('npm',['install','--ignore-scripts','--prefer-online','--no-audit','--no-fund','@deepseek-ai/dsh@'+manifest.engines.dsh],join(taskRoot,'runtime'))
  const {binary,manifest:runtime}=await officialBinary(join(taskRoot,'runtime'))
  assert.equal(runtime.version,manifest.engines.dsh)
  await processes.command(process.execPath,[binary,'--profile','notify','--from-default-profile','web','--dump-config'],taskRoot)
  const profile=join(taskHome,'profiles/notify')
  await writeFile(join(profile,'.npmrc'),'registry=https://registry.npmjs.org/\n@deepseek-ai:registry=https://registry.npmjs.org/\n')
  await processes.command(process.execPath,[binary,'plugin','--profile','notify','add',values['release-url']??tarball,'--ignore-scripts'],taskRoot)
  const installed=await realpath(join(profile,'node_modules',manifest.name))
  assert.ok(!relative(taskRoot,installed).startsWith('..'))
  new Script(await readFile(join(installed,'dist/client.js'),'utf8'))
  result.checks.push('official-cli-packed-install','valid-client-factory')
  await prepareFixture(taskRoot,binary,processes,'notify',manifest.engines.dsh,join(checkout,'tests/fixtures/model.mjs'))
  console.log('[smoke] Run two native Agent sessions and verify real notification tool calls')
  app=await boot(binary,'notify',taskRoot,processes)
  const anonymous=await fetch(app.origin+'/api/agentNotify/status',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})
  assert.equal(anonymous.status,401)
  const first=await app.rpc('session/create',{request:{cwd:join(taskRoot,'workspace')}})
  const second=await app.rpc('session/create',{request:{cwd:join(taskRoot,'workspace')}})
  await prompt(app,first.sessionId,'NOTIFY_A')
  await prompt(app,second.sessionId,'NOTIFY_B')
  await until(async()=> (await app.rpc('agentNotify/status')).unread===2)
  let list=await app.rpc('agentNotify/list',{})
  assert.equal(list.items.length,2)
  assert.equal(new Set(list.items.map(item=>item.source.sessionId)).size,2)
  const a=list.items.find(item=>item.source.sessionId===first.sessionId)
  const evidence=await app.rpc('notifyFixture/evidence',{sessionId:first.sessionId})
  assert.ok(evidence.calls.some(call=>call.name==='notify_user'&&call.callId===a.source.callId))
  assert.ok(evidence.results.some(item=>item.callId===a.source.callId&&!item.isError))
  result.checks.push('owner-authentication','native-notify-tool-and-evidence','two-session-source-binding')
  await app.rpc('agentNotify/markRead',{id:a.id,read:true})
  assert.equal((await app.rpc('agentNotify/status')).unread,1)
  let status=await app.rpc('agentNotify/status')
  assert.equal(status.settingsWritable,true)
  await app.rpc('agentNotify/settings',{value:{...status.settings,popup:false,batchSize:7},revision:status.settingsRevision})
  const scheduled=await app.rpc('session/create',{request:{cwd:join(taskRoot,'workspace')}})
  await prompt(app,scheduled.sessionId,'NOTIFY_SCHEDULE')
  const schedule=await app.rpc('notifyFixture/evidence',{sessionId:scheduled.sessionId})
  assert.ok(schedule.calls.some(call=>call.name==='schedule_create'))
  console.log('[smoke] Restart before the reminder; verify cold wake, settings and read-state durability')
  await processes.stop(app.state)
  app=await boot(binary,'notify',taskRoot,processes)
  status=await app.rpc('agentNotify/status')
  assert.equal(status.settings.popup,false);assert.equal(status.settings.batchSize,7)
  assert.ok((await app.rpc('agentNotify/read',{id:a.id})).readAt)
  await until(async()=> (await app.rpc('agentNotify/list',{})).items.some(item=>item.title==='定时检查已完成'))
  list=await app.rpc('agentNotify/list',{})
  const reminder=list.items.find(item=>item.title==='定时检查已完成')
  assert.equal(reminder.source.sessionId,scheduled.sessionId)
  result.checks.push('settings-persisted-in-profile','unread-state-survives-restart','native-schedule-cold-wake','background-inbox-delivery')
  const before=list.cutoff
  await app.rpc('agentNotify/test',{})
  await until(async()=> (await app.rpc('agentNotify/status')).counts.sent===4)
  await app.rpc('agentNotify/markAllRead',{ids:list.items.map(item=>item.id),cutoff:before})
  assert.equal((await app.rpc('agentNotify/status')).unread,1)
  const all=await app.rpc('agentNotify/list',{})
  const test=all.items.find(item=>item.source.kind==='test')
  await app.rpc('agentNotify/archive',{id:test.id,archived:true})
  assert.equal((await app.rpc('agentNotify/list',{archived:true})).items[0].id,test.id)
  result.checks.push('bulk-read-watermark','archive-preserves-message')
  await processes.stop(app.state)
  if(interrupted)throw new Error('Interrupted')
  result.status='passed'
}catch(error){
  result.error=redact(error.message??error).replaceAll(taskRoot,'<temporary>')
  await mkdir(join(checkout,'.artifacts'),{recursive:true})
  if(app){
    const diagnostics={stdout:redact(app.state.stdout),stderr:redact(app.state.stderr)}
    try{diagnostics.sessions=await app.rpc('session/list',{_request:{}})}catch{}
    await writeFile(join(checkout,'.artifacts/smoke-diagnostics.json'),JSON.stringify(diagnostics,null,2)+'\n',{mode:0o600})
  }
  console.error(result.error);process.exitCode=1
}
finally{
  await processes.close()
  await rm(taskRoot,{recursive:true,force:true})
  result.cleanup='completed';result.durationMs=Date.now()-started
  await mkdir(join(checkout,'.artifacts'),{recursive:true})
  await writeFile(join(checkout,'.artifacts',values['release-url']?'release-smoke.json':'packed-smoke.json'),JSON.stringify(result,null,2)+'\n')
  process.off('SIGINT',stop);process.off('SIGTERM',stop)
}
if(result.status==='passed')console.log('Packed smoke passed: '+result.checks.join(', '))
