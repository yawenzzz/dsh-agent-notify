import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Archive, ArrowUpRight, Bell, Box, Check, CheckCheck, ChevronDown, ChevronRight,
  Clock, FileText, Inbox, RefreshCw, Search, Settings2, X, type LucideIcon } from 'lucide-react'
import type { HostObservable, InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { defaultSettings, settingsSchema, type ListQuery, type Notice, type NoticeDetail, type NoticeList, type NotifySettings } from '../contract.ts'
import { type NotifyClient, type ViewState } from './controller.ts'
import css from './styles.module.css'

export type Face = { hooks: { notify: HostObservable<ViewState> }; client: NotifyClient }
type Props = InjectFace<Face>
const c = (...names: (string | false | undefined)[]) => names.filter(Boolean).map(name => css[name as string] ?? name).join(' ')
const message = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试。'
function Icon({ icon: Shape, size = 16 }: { icon: LucideIcon; size?: number }) {
  return <Shape width={size} height={size} style={{width:size,height:size}} strokeWidth={1.6} aria-hidden="true" className={c('n-icon')} />
}
function Button({ icon, children, tone, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { icon?: LucideIcon; tone?: string }) {
  return <button type="button" {...props} className={c('n-button',tone)}>{icon && <Icon icon={icon} />}{children}</button>
}
function IconButton({ icon, label, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: LucideIcon; label: string }) {
  return <button type="button" {...props} className={c('n-icon-button')} aria-label={label} title={label}><Icon icon={icon} /></button>
}
export function NotificationBell({ useNotify, client }: Props & PropsRuntime<'sidebar.footer.action'>) {
  const count = useNotify(s => s.status?.unread ?? 0), open = useNotify(s => s.open)
  return <div className={c('root')}><button type="button" className={c('n-bell')} title="通知"
    aria-label={'通知，' + count + ' 条未读'} aria-expanded={open} aria-controls="agent-notify-drawer" onClick={() => client.toggle()}>
    <Icon icon={Bell} size={18} />{count > 0 && <span className={c('n-unread-badge')} aria-hidden="true">{count > 99 ? '99+' : count}</span>}
  </button></div>
}
export function NotificationIcon({ size }: PropsRuntime<'sidebar.panellist'>) { return <Bell size={size} strokeWidth={1.6} /> }

function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*\n]+\*\*|\u0060[^\u0060\n]+\u0060)/g).map((part,i) =>
    part.startsWith('**') && part.endsWith('**') ? <strong key={i}>{part.slice(2,-2)}</strong>
      : part.startsWith('\u0060') && part.endsWith('\u0060') ? <code key={i}>{part.slice(1,-1)}</code> : part)
}
/** React text nodes deliberately do not execute HTML, images, or links from a model. */
export function Body({ text }: { text: string }) {
  return <div className={c('n-body')}>{text.split(/\n\s*\n/).map((block,index) => {
    const lines = block.split('\n')
    if (lines.every(line => /^[-*] /.test(line))) return <ul key={index}>{lines.map((line,i) => <li key={i}>{inline(line.slice(2))}</li>)}</ul>
    if (lines.every(line => /^\d+\. /.test(line))) return <ol key={index}>{lines.map((line,i) => <li key={i}>{inline(line.replace(/^\d+\. /,''))}</li>)}</ol>
    return <p key={index}>{inline(block)}</p>
  })}</div>
}
function dateGroup(time: number) {
  const date = new Date(time), today = new Date(), yesterday = new Date()
  yesterday.setDate(today.getDate()-1)
  return date.toDateString() === today.toDateString() ? '今天' : date.toDateString() === yesterday.toDateString() ? '昨天'
    : date.toLocaleDateString('zh-CN',{month:'long',day:'numeric'})
}
function shortTime(time: number) {
  const date = new Date(time)
  return date.toDateString() === new Date().toDateString() ? date.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false})
    : date.toLocaleDateString('zh-CN',{month:'2-digit',day:'2-digit'})
}
function useList(client: NotifyClient, revision: number, reload: number, query: ListQuery) {
  const [list,setList] = useState<NoticeList | null>(null), [error,setError] = useState<string | null>(null)
  const [loading,setLoading] = useState(true)
  const key = JSON.stringify(query)
  const filterKey = JSON.stringify({...query,limit:0})
  const oldKey = useRef(filterKey)
  useEffect(() => {
    const controller = new AbortController()
    const queryChanged = oldKey.current !== filterKey; oldKey.current = filterKey
    if (queryChanged) setList(null)
    setLoading(true)
    void client.api.list(JSON.parse(key),controller.signal).then(result => {
      if (controller.signal.aborted) return
      setList(result); setError(null)
    }).catch(e => { if (!controller.signal.aborted) setError(message(e)) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  },[client,key,filterKey,revision,reload])
  return { list,error,loading }
}
function Tabs({ value,counts,onChange,id }: { value: ListQuery['filter']; counts: NoticeList['counts']; onChange: (filter: ListQuery['filter']) => void; id: string }) {
  const filters = ['all','unread','action'] as const
  return <div className={c('n-tabs')} role="tablist" aria-label="通知筛选">
    {filters.map((filter,index) => <button type="button" key={filter} role="tab" id={id+'-'+filter}
      aria-controls={id+'-list'} aria-selected={value===filter} tabIndex={value===filter?0:-1}
      onClick={() => onChange(filter)} onKeyDown={event => {
        if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return
        event.preventDefault()
        const next = event.key==='Home'?0:event.key==='End'?2:(index+(event.key==='ArrowRight'?1:2))%3
        onChange(filters[next])
        document.getElementById(id+'-'+filters[next])?.focus()
      }}>{['全部','未读','需处理'][index]}{counts[filter] > 0 && <span className={c('n-tab-count')}>{counts[filter]}</span>}</button>)}
  </div>
}
function Empty({ filter, archived, searched }: { filter: string; archived: boolean; searched: boolean }) {
  const title = searched?'没有匹配的通知':archived?'暂无归档通知':filter==='unread'?'未读消息已看完':filter==='action'?'暂无需处理的通知':'还没有通知'
  const copy = searched?'试试其他关键词或来源 Agent。':archived?'归档后的通知会保留在这里。':filter==='unread'?'有新消息时，铃铛会显示未读数量。':filter==='action'?'需要你参与的消息会集中显示在这里。':'Agent 主动发送消息后，会出现在这里。'
  return <div className={c('n-empty')}><Icon icon={filter==='unread'?CheckCheck:Bell} size={32}/><h3>{title}</h3><p>{copy}</p></div>
}
function NoticeRow({ item, client, detail, onExpand, onCollapse, onArchive }: {
  item: Notice; client: NotifyClient; detail?: NoticeDetail; onExpand: (detail: NoticeDetail) => void; onCollapse: () => void; onArchive: () => void
}) {
  const [error,setError]=useState<string | null>(null), [busy,setBusy]=useState(false)
  const run = async (fn: () => Promise<void>) => {
    if (busy) return
    setBusy(true);setError(null)
    try { await fn() } catch(e) { setError(message(e)) } finally { setBusy(false) }
  }
  const expanded = !!detail
  const expand = () => run(async () => {
    if (expanded) { onCollapse(); return }
    const result = await client.api.read(item.id)
    if (!result.readAt) await client.command(() => client.api.markRead(item.id,true))
    onExpand({ ...result, readAt: result.readAt ?? Date.now() })
  })
  return <article className={c('n-notice',item.readAt?'read':'unread',expanded&&'expanded')} data-notice-id={item.id}>
    <div className={c('n-notice-head')}>
      <span className={c('n-unread-dot',!!item.readAt&&'read')} aria-label={item.readAt?'已读':'未读'} />
      <span className={c('n-source')}><span className={c('n-source-name')}>{item.source.agentName}{item.source.workspace?' · '+item.source.workspace:''}</span></span>
      <time dateTime={new Date(item.createdAt).toISOString()} title={new Date(item.createdAt).toLocaleString()}>{shortTime(item.createdAt)}</time>
    </div>
    <h3 className={c('n-notice-title',!expanded&&'clamp')}>{item.title}</h3>
    <div className={c('n-notice-meta')}><span className={c('n-category',item.category)}>
      {item.category !== 'general' && <Icon icon={item.category==='result'?FileText:Clock} size={13}/>}
      {{general:'普通',result:'任务结果',action:'需处理'}[item.category]}
    </span>{expanded&&<span className={c('n-count')}>{item.readAt?'已读':'未读'}</span>}</div>
    {detail ? <Body text={detail.body}/> : <p className={c('n-notice-summary','clamp')}>{item.summary}</p>}
    <div className={c('n-notice-actions')}>
      <Button icon={expanded?ChevronDown:ChevronRight} tone="blue" aria-expanded={expanded} disabled={busy} onClick={expand}>{expanded?'收起内容':'展开内容'}</Button>
      <Button icon={ArrowUpRight} disabled={busy} onClick={() => run(() => client.openSource(item.id))}>打开来源会话</Button>
      <IconButton icon={item.readAt?Inbox:Check} label={item.readAt?'标为未读':'标为已读'} disabled={busy}
        onClick={() => run(async () => { await client.command(() => client.api.markRead(item.id,!item.readAt)); if (detail) onExpand({...detail,readAt:item.readAt?null:Date.now()}) })}/>
      <IconButton icon={item.archivedAt?RefreshCw:Archive} label={item.archivedAt?'移回收件箱':'归档通知'} disabled={busy}
        onClick={() => run(async () => { await client.command(() => client.api.archive(item.id,!item.archivedAt)); onArchive() })}/>
    </div>
    {error&&<div className={c('n-source-error')} role="alert">{error}</div>}
  </article>
}
function NotificationSurface({ client, state, center = false, onClose }: { client: NotifyClient; state: ViewState; center?: boolean; onClose?: () => void }) {
  const id=useId(), [filter,setFilter]=useState<ListQuery['filter']>('all'),[archived,setArchived]=useState(false)
  const [search,setSearch]=useState(''),[query,setQuery]=useState(''),[source,setSource]=useState(''),[limit,setLimit]=useState(20)
  const [expanded,setExpanded]=useState<Record<string,NoticeDetail>>({}),[mutationError,setMutationError]=useState<string|null>(null),[marking,setMarking]=useState(false)
  const expandedRef=useRef(expanded);expandedRef.current=expanded
  useEffect(()=>{
    let active=true
    const ids=Object.keys(expandedRef.current)
    if(ids.length)void Promise.all(ids.map(async id=>{
      try{return {id,detail:await client.api.read(id)}}catch{return {id,detail:null}}
    })).then(results=>{
      if(!active)return
      setExpanded(old=>{
        const next={...old}
        for(const {id,detail} of results)if(id in next){if(detail)next[id]=detail;else delete next[id]}
        return next
      })
    })
    return()=>{active=false}
  },[client,state.status?.revision])
  useEffect(() => { const timer=setTimeout(()=>setQuery(search),250); return ()=>clearTimeout(timer) },[search])
  useEffect(()=>{ setLimit(20);setExpanded({}) },[filter,archived,source,query])
  const {list,error,loading}=useList(client,state.status?.revision??-1,state.reload,{filter,archived,query,agentId:source,limit})
  const items=[...(list?.items??[])]
  if(filter==='unread') for(const value of Object.values(expanded)) if(!items.some(item=>item.id===value.id)&&!!value.archivedAt===archived) items.push(value)
  items.sort((a,b)=>b.seq-a.seq)
  const counts=list?.counts??{all:0,unread:0,action:0}
  const markAll=async()=>{
    if(!list||marking)return
    setMarking(true);setMutationError(null)
    // IDs and cutoff belong to the displayed snapshot, even while new messages arrive.
    const ids=list.items.filter(item=>!item.readAt).map(item=>item.id),cutoff=list.cutoff
    try{await client.command(()=>client.api.markAllRead(ids,cutoff))}
    catch(e){setMutationError(message(e))}
    finally{setMarking(false)}
  }
  let previousGroup=''
  return <>
    <header className={c(center?'n-center-header':'n-drawer-header')}>
      {center?<><div><h1>通知中心</h1><p>查看 Agent 发来的消息与需要你处理的事项。</p></div>
        <div className={c('n-toolbar')}><Button icon={Settings2} tone="outline" onClick={()=>client.show('settings')}>通知设置</Button><Button onClick={()=>client.show('conversation')}>返回会话</Button></div></>
        :<><div className={c('n-drawer-title')}><h2 id="agent-notify-title">通知</h2><span className={c('n-count')}>{state.status?.unread??0} 条未读</span>
          <Button disabled={marking||!counts.unread||!!state.error} onClick={markAll}>{marking?'标记中…':'全部已读'}</Button><IconButton icon={X} label="关闭通知" onClick={onClose}/></div>
          <div className={c('n-scope')}><Icon icon={Box} size={13}/><span>当前应用 · 所有 Agent</span></div>
          <Tabs value={filter} counts={counts} onChange={setFilter} id={id}/></>}
    </header>
    {center&&<><div className={c('n-center-toolbar')}>
      <label className={c('n-center-search')}><Icon icon={Search}/><input aria-label="搜索通知" placeholder="搜索标题或内容" value={search} onChange={e=>setSearch(e.target.value)}/></label>
      <label className={c('n-center-select')}>来源<select aria-label="来源 Agent" value={source} onChange={e=>setSource(e.target.value)}><option value="">所有 Agent</option>{list?.sources.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      <Button icon={Archive} aria-pressed={archived} onClick={()=>setArchived(!archived)}>{archived?'返回收件箱':'已归档'}</Button>
    </div><div className={c('center-tabs')}><Tabs value={filter} counts={counts} onChange={setFilter} id={id}/>
      <Button icon={CheckCheck} disabled={marking||!counts.unread||archived||!!state.error} onClick={markAll}>全部已读</Button></div></>}
    <div className={c(center?'n-center-list':'n-drawer-scroll')}>
      {(state.error||error||mutationError)&&<div className={c('n-banner','warning')} role="alert"><span>{mutationError??error??state.error} 已加载内容仍保留。</span><Button onClick={()=>void client.refresh()}>重试</Button></div>}
      {state.status&&!state.status.settings.enabled&&<div className={c('n-banner')}><span>主动通知已停用，历史消息仍可查看。</span><Button onClick={()=>client.show('settings')}>设置</Button></div>}
      <div id={id+'-list'} role="tabpanel" aria-labelledby={id+'-'+filter} aria-busy={loading}>
        {!list&&loading?<div role="status" aria-label="正在读取通知">{[0,1,2].map(i=><div key={i} className={c('n-skeleton')}><span/><span/><span/></div>)}</div>:
          items.length===0?<Empty filter={filter} archived={archived} searched={!!query||!!source}/>:
          items.map(item=>{
            const group=dateGroup(item.createdAt),heading=previousGroup!==group;previousGroup=group
            return <div key={item.id}>{heading&&<div className={c('n-date-label')}>{group}</div>}
              <NoticeRow item={item} client={client} detail={expanded[item.id]}
                onExpand={detail=>setExpanded(old=>({...old,[item.id]:detail}))}
                onCollapse={()=>setExpanded(old=>{const next={...old};delete next[item.id];return next})}
                onArchive={()=>setExpanded(old=>{const next={...old};delete next[item.id];return next})}/></div>
          })}
        {list?.hasMore?<div className={c('n-load-more')}><Button icon={ChevronDown} disabled={loading} onClick={()=>setLimit(n=>Math.min(5000,n+20))}>加载更多</Button></div>
          :items.length>0&&<p className={c('n-notice-footer')}>已显示全部通知</p>}
      </div>
    </div>
    {!center&&<footer className={c('n-drawer-footer')}><span className={c('n-footer-connection',!!state.error&&'offline')}><span aria-hidden="true"/>{state.error?'连接已断开':state.status?'消息已同步':'正在连接'}</span>
      <Button icon={ChevronRight} onClick={()=>client.show('center')}>查看全部</Button></footer>}
  </>
}
export function NotificationOverlay({useNotify,client}:Props) {
  const state=useNotify(s=>s),dialog=useRef<HTMLDialogElement>(null)
  useEffect(()=>{
    if(!state.open||!dialog.current)return
    const element=dialog.current, media=matchMedia('(max-width:600px)')
    const show=()=>{
      if(element.open)element.close()
      if(media.matches)element.showModal();else element.show()
      element.querySelector<HTMLButtonElement>('[aria-label="关闭通知"]')?.focus()
    }
    show();media.addEventListener('change',show)
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();client.close()}}
    element.addEventListener('keydown',escape)
    return()=>{media.removeEventListener('change',show);element.removeEventListener('keydown',escape);if(element.open)element.close()}
  },[state.open,client])
  return <>{state.open&&<dialog ref={dialog} id="agent-notify-drawer" className={c('root','n-drawer')}
    aria-labelledby="agent-notify-title" onCancel={event=>{event.preventDefault();client.close()}}>
    <NotificationSurface state={state} client={client} onClose={()=>client.close()}/>
  </dialog>}{state.toast&&<div className={c('root','notice-toast')} role="status" aria-live="polite"><Icon icon={Bell}/><span>{state.toast}</span><Button onClick={()=>{if(!state.open)client.toggle()}}>查看</Button></div>}</>
}
export function NotificationCenter({useNotify,client}:Props) {
  const state=useNotify(s=>s)
  return <section className={c('root','n-center')}><div className={c('n-center-inner')}><NotificationSurface state={state} client={client} center/></div></section>
}
function Toggle({value,label,onChange,disabled=false}:{value:boolean;label:string;onChange:(value:boolean)=>void;disabled?:boolean}) {
  return <button type="button" role="switch" aria-checked={value} aria-label={label} disabled={disabled}
    className={c('toggle',value&&'on')} onClick={()=>onChange(!value)}><span/></button>
}
function SettingRow({title,description,children}:{title:string;description:string;children:ReactNode}) {
  return <div className={c('n-setting-row')}><div className={c('n-setting-copy')}><strong>{title}</strong><p>{description}</p></div>{children}</div>
}
export function NotificationSettings({useNotify,client}:Props) {
  const state=useNotify(s=>s), [draft,setDraft]=useState<NotifySettings>(defaultSettings),[revision,setRevision]=useState(0)
  const [dirty,setDirty]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[feedback,setFeedback]=useState('')
  useEffect(()=>{if(!dirty&&state.status){setDraft(state.status.settings);setRevision(state.status.settingsRevision)}},[dirty,state.status?.settingsRevision,JSON.stringify(state.status?.settings)])
  const update=<K extends keyof NotifySettings>(key:K,value:NotifySettings[K])=>{setDraft(old=>({...old,[key]:value}));setDirty(true);setFeedback('尚未保存')}
  const run=async(action:()=>Promise<unknown>,success:string)=>{
    if(busy)return
    setBusy(true);setError(null)
    try{await client.command(action);setFeedback(success)}
    catch(e){setError(message(e))}
    finally{setBusy(false)}
  }
  const save=()=>run(async()=>{const value=settingsSchema.parse(draft);await client.api.settings(value,revision);setDirty(false)},'设置已保存')
  const statuses={pending:'等待投递',sending:'正在投递',sent:'已发送',retry_wait:'等待重试',failed:'投递失败'}
  return <section className={c('root','n-center','n-settings')}><div className={c('n-center-inner')}>
    <div className={c('n-settings-head')}><span className={c('n-plugin-icon')}><Icon icon={Bell} size={24}/></span><div><h1>主动通知</h1><p>接收 Agent 的主动消息，查看未读通知与来源会话。</p></div>
      <Button onClick={()=>client.show('center')}>返回通知中心</Button></div>
    <div className={c('n-host-note')}><Icon icon={Box}/><span>设置作用于当前 DSH 应用，所有 Agent 共用。其他 profile 的通知独立保存。</span></div>
    <form className={c('n-settings-form')} onSubmit={event=>{event.preventDefault();void save()}}>
      <fieldset disabled={busy||!state.status?.settingsWritable} className={c('fieldset')}>
        <section className={c('n-setting-section')}><h2>通知偏好</h2>
          <SettingRow title="启用主动通知" description="停用后暂停新通知及后续投递，历史消息仍可查看。"><Toggle value={draft.enabled} label="启用主动通知" onChange={v=>update('enabled',v)}/></SettingRow>
          <SettingRow title="弹出提示" description="收到新通知时显示简短提示，不切换会话或抢占输入焦点。"><Toggle value={draft.popup} label="弹出提示" onChange={v=>update('popup',v)}/></SettingRow>
          <SettingRow title="静默时段" description="只暂停弹出提示，通知仍保留在收件箱并计入未读。"><Toggle value={draft.quiet} label="启用静默时段" onChange={v=>update('quiet',v)}/></SettingRow>
          {draft.quiet&&<><div className={c('n-times')}><label>开始<input type="time" aria-label="静默开始时间" value={draft.quietStart} onChange={e=>update('quietStart',e.target.value)} required/></label><span>—</span>
            <label>结束<input type="time" aria-label="静默结束时间" value={draft.quietEnd} onChange={e=>update('quietEnd',e.target.value)} required/></label></div><p className={c('n-quiet-caption')}>按浏览器本地时间执行，支持跨夜；相同时间表示全天静默。</p></>}
          <SettingRow title="已读消息保留期" description="未读和待投递消息不会自动清理，清理时同时删除对应历史投递与去重记录。">
            <select aria-label="已读消息保留期" value={draft.retentionDays} onChange={e=>update('retentionDays',Number(e.target.value) as NotifySettings['retentionDays'])}>
              {[7,30,90,0].map(n=><option key={n} value={n}>{n===0?'永久保留':n+' 天'}</option>)}</select></SettingRow>
        </section>
        <details className={c('n-advanced')}><summary><Icon icon={ChevronRight}/>高级投递配置</summary><p>控制后台投递的批量、并发和重试预算。</p>
          {([['batchSize','每批投递数量','每次领取的通知条数，范围 1–100。',1,100],['concurrency','并发上限','同时处理的投递数量，范围 1–10。',1,10],['maxRetries','重试次数','临时失败的最大重试次数，范围 0–20。',0,20]] as const).map(([key,title,description,min,max])=>
            <SettingRow key={key} title={title} description={description}><input className={c('n-number-input')} type="number" aria-label={title} min={min} max={max} step={1} value={draft[key]} onChange={e=>update(key,Number(e.target.value))} required/></SettingRow>)}
        </details>
        {error&&<p className={c('n-field-error')} role="alert">{error}</p>}
        <div className={c('n-settings-actions')}><button className={c('n-button','solid')} type="submit" disabled={!dirty||busy}>{busy?'保存中…':'保存设置'}</button>
          <Button disabled={!dirty||busy} onClick={()=>{setDirty(false);setError(null);setFeedback('已取消修改')}}>取消修改</Button><span className={c('n-save-feedback')} role="status">{feedback}</span></div>
      </fieldset>
    </form>
    {!state.status?.settingsWritable&&<p className={c('n-field-error')}>当前 profile 的通知设置不可编辑。</p>}
    <section className={c('n-setting-section')}><h2>投递状态</h2>
      <div className={c('n-delivery-summary')}>{(['pending','sent','failed'] as const).map(key=><span key={key}>{statuses[key]} <strong>{state.status?.counts[key]??0}</strong></span>)}
        <Button icon={Bell} tone="outline" disabled={busy||!state.status?.settings.enabled} onClick={()=>run(()=>client.api.test(),'测试通知已提交')}>发送测试通知</Button></div>
      {state.status?.workerError&&<p role="alert" className={c('n-field-error')}>{state.status.workerError}</p>}
      {state.status?.recent.length===0&&<p className={c('n-settings-fineprint')}>暂无投递记录。可以发送一条测试通知。</p>}
      {state.status?.recent.map(row=><div className={c('n-delivery-row')} key={row.notificationId}><div><span className={c('n-delivery-title')}>{row.title}</span>
        <span className={c('n-delivery-note')}>{row.error??('尝试 '+row.attempts+' 次 · '+shortTime(row.updatedAt))}</span></div><span className={c('n-delivery-status',row.state)}>{statuses[row.state]}</span>
        {['failed','retry_wait'].includes(row.state)&&<Button disabled={busy} onClick={()=>run(()=>client.api.retry(row.notificationId),'已重新加入投递队列')}>重试</Button>}</div>)}
    </section><p className={c('n-settings-fineprint')}>站内“已发送”表示消息已进入通知中心，不表示你已阅读。{state.status?.schedulerAvailable?'后台定时检查可通过 DSH 的自动化任务配置。':'当前 Host 未启用官方调度，仍可接收运行中 Agent 的通知。'}</p>
  </div></section>
}
