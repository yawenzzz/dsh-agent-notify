import { randomUUID } from 'node:crypto'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'

export const inject = ['llm','sessions','connection']
class FixtureModel extends LlmAdapter {
  async resolveModel(provider,id) { return {provider,id,name:'Notification integration fixture',context:{contextWindow:32768}} }
  async listModels(provider) { return [await this.resolveModel(provider,'fixture')] }
  async *stream(options) {
    const lastUser=options.messages.findLastIndex(message=>message.role==='user')
    // DSH may append time/environment context as another user-role message.
    const prompt=options.messages.filter(message=>message.role==='user')
      .flatMap(message=>message.content.filter(block=>block.type==='text').map(block=>block.text)).join('\n')
    const finished=options.messages.slice(lastUser+1).some(message=>message.role==='tool')
    let name,args
    if (!finished && prompt.includes('NOTIFY_TIMER')) {
      name='notify_user';args={title:'定时检查已完成',body:'这条通知由官方 DSH 调度唤醒 Agent 后，通过 notify_user 工具发送。任务执行时不需要浏览器保持打开。',category:'result',dedupe_key:'timer-proof'}
    } else if (!finished && prompt.includes('NOTIFY_SCHEDULE')) {
      name='schedule_create';args={title:'通知插件定时验证',prompt:'NOTIFY_TIMER：检查完成后主动通知用户。',after_seconds:6}
    } else if (!finished && prompt.includes('NOTIFY_B')) {
      name='notify_user';args={title:'需要你确认通知接入方式',body:'站内通知已经可以持久化与恢复。\n\n**请确认后续接入范围：**\n\n- 当前 DSH 应用内使用\n- 需要时再增加飞书或 Telegram 渠道\n\n请在来源会话中继续讨论。',category:'action',dedupe_key:'proof-b'}
    } else if (!finished && prompt.includes('NOTIFY_A')) {
      name='notify_user';args={title:'通知插件安装验证已完成',body:'已通过官方 DSH 的真实工具调用发送这条消息。\n\n- 消息先进入持久化发件箱\n- 后台投递到站内通知中心\n- 重启后仍可查看内容和已读状态\n\n这条消息来自集成测试模型，用于验证通知链路。',category:'result',dedupe_key:'proof-a'}
    }
    if(name) {
      if(!(options.tools??[]).some(tool=>tool.name===name)) throw new Error('Required native tool is absent: '+name)
      yield {type:'block-start',index:0,blockType:'tool-call'}
      yield {type:'block-end',index:0,block:{type:'tool-call',id:ToolCallId(randomUUID()),name,arguments:JSON.stringify(args)}}
      yield {type:'finish',reason:{kind:'tool-calls'}}
      return
    }
    yield {type:'block-start',index:0,blockType:'text'}
    yield {type:'block-end',index:0,block:{type:'text',text:'通知验证操作已完成。请在通知中心查看真实投递结果。'}}
    yield {type:'finish',reason:{kind:'stop'}}
  }
}
export function apply(ctx) {
  ctx.effect(()=>ctx.llm.registerAdapter(['notify-fixture'],new FixtureModel()))
  ctx.effect(()=>ctx.connection.fetch.register({
    path:'/api/notifyFixture/evidence',methods:['POST'],requestBody:'buffered',
    async fetch(request) {
      const input=await request.json()
      const session=ctx.sessions.list().find(value=>value.id===input.payload?.args?.sessionId)
      const events=session?.snapshotEvents()??[]
      return Response.json({type:'server-response',rpcId:input.rpcId,result:{ok:true,value:{
        calls:events.filter(event=>event.type==='tool/call').map(event=>({name:event.data.name,callId:event.data.callId})),
        results:events.filter(event=>event.type==='tool/result').map(event=>({callId:event.data.message.toolCallId,isError:event.data.message.isError})),
      }}})
    },
  }))
}
