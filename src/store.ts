import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { lock } from 'proper-lockfile'
import { z } from 'zod'
import { listQuerySchema, notificationInputSchema, sourceSchema, type Delivery, type DeliveryState,
  type ListQuery, type Notice, type NoticeDetail, type NoticeList, type NotificationInput,
  type NotificationSource, type SubmitReceipt } from './contract.ts'

const states = ['pending', 'sending', 'sent', 'retry_wait', 'failed'] as const
const rowSchema = z.object({
  id: z.string(), seq: z.number(), source: z.string(), title: z.string(), body: z.string(),
  category: z.enum(['general', 'result', 'action']), created_at: z.number(),
  sent_at: z.number(), read_at: z.number().nullable(), archived_at: z.number().nullable(),
})
const deliverySchema = z.object({
  notification_id: z.string(), title: z.string(), state: z.enum(states), attempts: z.number(),
  error: z.string().nullable(), created_at: z.number(), updated_at: z.number(), next_attempt_at: z.number(),
})
export class NotifyError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'NotifyError' }
}
export interface ClaimedDelivery { id: string; owner: string }

/** A single Host owns one database. Every visible change commits with its revision. */
export class NotifyStore {
  readonly hostId: string
  private closed = false
  private compromised: Error | undefined
  private constructor(private db: DatabaseSync, private release: () => Promise<void>, readonly directory: string) {
    const version = z.object({ user_version: z.number() }).parse(db.prepare('PRAGMA user_version').get()).user_version
    if (version !== 0 && version !== 1) throw new NotifyError('unsupported_database', '通知数据库版本不兼容，原文件已保留。')
    if (version === 0) {
      if (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get()) {
        throw new NotifyError('invalid_database', '通知数据库包含未知表，原文件已保留。')
      }
      db.exec([
        'BEGIN IMMEDIATE;',
        'CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;',
        'CREATE TABLE notifications (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, source TEXT NOT NULL, scope TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, category TEXT NOT NULL, content_hash TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT;',
        'CREATE TABLE dedupe (key TEXT PRIMARY KEY, notification_id TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE) STRICT;',
        "CREATE TABLE deliveries (notification_id TEXT PRIMARY KEY REFERENCES notifications(id) ON DELETE CASCADE, state TEXT NOT NULL CHECK(state IN ('pending','sending','sent','retry_wait','failed')), attempts INTEGER NOT NULL DEFAULT 0, owner TEXT, next_attempt_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, error TEXT) STRICT;",
        'CREATE TABLE inbox (notification_id TEXT PRIMARY KEY REFERENCES notifications(id) ON DELETE CASCADE, sent_at INTEGER NOT NULL, read_at INTEGER, archived_at INTEGER) STRICT;',
        'CREATE INDEX delivery_due ON deliveries(state, next_attempt_at);',
        'CREATE INDEX notifications_scope ON notifications(scope, seq);',
        "INSERT INTO meta VALUES ('revision','0');",
        "INSERT INTO meta VALUES ('hostId','" + randomUUID() + "');",
        'PRAGMA user_version = 1;',
        'COMMIT;',
      ].join('\n'))
    }
    const check = db.prepare('PRAGMA quick_check').get()
    if (!check || Object.values(check)[0] !== 'ok') throw new NotifyError('corrupt_database', '通知数据库检查失败，原文件已保留。')
    const host = db.prepare("SELECT value FROM meta WHERE key='hostId'").get()
    if (!host) throw new NotifyError('corrupt_database', '通知数据库缺少身份信息，原文件已保留。')
    this.hostId = z.object({ value: z.string().uuid() }).parse(host).value
    this.revision
    // The exclusive directory lock proves the previous dispatcher no longer owns this DB.
    this.tx(() => {
      const recovered = db.prepare("UPDATE deliveries SET state='pending',owner=NULL,next_attempt_at=0 WHERE state='sending'").run()
      if (Number(recovered.changes)) this.bump()
    })
  }
  static async open(directory: string): Promise<NotifyStore> {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const canonical = await realpath(directory)
    const path = join(canonical, 'notifications.sqlite')
    try {
      if ((await lstat(path)).isSymbolicLink()) throw new NotifyError('invalid_path', '通知数据库不能使用符号链接。')
    } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
    let store: NotifyStore | undefined
    let leaseError: Error | undefined
    const release = await lock(canonical, { realpath: false, stale: 30000, update: 10000, retries: 0,
      onCompromised: error => { leaseError = error; if (store) store.compromised = error } })
    let db: DatabaseSync | undefined
    try {
      db = new DatabaseSync(path, { timeout: 1000 })
      db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;')
      await chmod(path, 0o600)
      store = new NotifyStore(db, release, canonical)
      if (leaseError) throw leaseError
      return store
    } catch (error) { db?.close(); await release().catch(() => {}); throw error }
  }
  private alive(): void {
    if (this.closed) throw new NotifyError('closed', '通知服务已经停止。')
    if (this.compromised) throw new NotifyError('writer_lost', '通知服务失去写入锁，请检查另一个运行进程。')
  }
  private tx<T>(run: () => T): T {
    this.alive()
    this.db.exec('BEGIN IMMEDIATE')
    try { const value = run(); this.db.exec('COMMIT'); return value }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  private bump(): void { this.db.prepare("UPDATE meta SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT) WHERE key='revision'").run() }
  get revision(): number {
    this.alive()
    const value = z.object({ value: z.string().regex(/^\d+$/) }).parse(this.db.prepare("SELECT value FROM meta WHERE key='revision'").get()).value
    return z.number().int().nonnegative().safe().parse(Number(value))
  }
  submit(raw: NotificationInput, origin: NotificationSource, now = Date.now()): SubmitReceipt {
    const input = notificationInputSchema.parse(raw), source = sourceSchema.parse(origin)
    const scope = JSON.stringify([source.kind, source.agentId, source.sessionId])
    const keys = [JSON.stringify([scope, 'call', source.callId])]
    if (input.dedupe_key) keys.push(JSON.stringify([scope, 'business', input.dedupe_key]))
    const digest = createHash('sha256').update(JSON.stringify([input.title, input.body, input.category])).digest('hex')
    return this.tx(() => {
      let existing: string | undefined
      for (const key of keys) {
        const found = this.db.prepare('SELECT n.id,n.content_hash FROM dedupe k JOIN notifications n ON n.id=k.notification_id WHERE k.key=?').get(key)
        if (!found) continue
        const row = z.object({ id: z.string(), content_hash: z.string() }).parse(found)
        if (row.content_hash !== digest || existing && existing !== row.id) throw new NotifyError('dedupe_conflict', '该通知标识已经用于另一条内容。')
        existing = row.id
      }
      if (existing) {
        for (const key of keys) this.db.prepare('INSERT OR IGNORE INTO dedupe VALUES (?,?)').run(key, existing)
        return { notificationId: existing, state: this.delivery(existing).state, duplicate: true }
      }
      const count = Number(this.db.prepare('SELECT COUNT(*) AS n FROM notifications').get()?.n)
      if (count >= 5000) throw new NotifyError('capacity', '通知记录已达到 5000 条，请调整已读保留期并清理历史记录。')
      const id = randomUUID()
      this.db.prepare('INSERT INTO notifications (id,source,scope,title,body,category,content_hash,created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(id, JSON.stringify(source), scope, input.title, input.body, input.category, digest, now)
      for (const key of keys) this.db.prepare('INSERT INTO dedupe VALUES (?,?)').run(key, id)
      this.db.prepare("INSERT INTO deliveries (notification_id,state,created_at,updated_at) VALUES (?,'pending',?,?)").run(id, now, now)
      this.bump()
      return { notificationId: id, state: 'pending', duplicate: false }
    })
  }
  claim(limit: number, owner: string, now = Date.now()): ClaimedDelivery[] {
    return this.tx(() => {
      const rows = this.db.prepare("SELECT notification_id FROM deliveries WHERE state IN ('pending','retry_wait') AND next_attempt_at<=? ORDER BY created_at,notification_id LIMIT ?").all(now, limit)
      const claimed = rows.map(row => z.object({ notification_id: z.string() }).parse(row).notification_id)
      for (const id of claimed) this.db.prepare("UPDATE deliveries SET state='sending',owner=?,attempts=attempts+1,updated_at=? WHERE notification_id=?").run(owner, now, id)
      if (claimed.length) this.bump()
      return claimed.map(id => ({ id, owner }))
    })
  }
  /** Inbox insertion and delivery acknowledgment are one transaction. Safe to replay. */
  publish(job: ClaimedDelivery, now = Date.now()): void {
    this.tx(() => {
      const row = this.db.prepare('SELECT state,owner FROM deliveries WHERE notification_id=?').get(job.id)
      if (row?.state === 'sent') return
      if (row?.state !== 'sending' || row.owner !== job.owner) throw new NotifyError('lease_lost', '通知投递归属已经变化。')
      this.db.prepare('INSERT OR IGNORE INTO inbox (notification_id,sent_at) VALUES (?,?)').run(job.id, now)
      this.db.prepare("UPDATE deliveries SET state='sent',owner=NULL,error=NULL,updated_at=? WHERE notification_id=?").run(now, job.id)
      this.bump()
    })
  }
  fail(job: ClaimedDelivery, error: string, maxRetries: number, now = Date.now()): void {
    this.tx(() => {
      const row = this.db.prepare("SELECT attempts FROM deliveries WHERE notification_id=? AND owner=? AND state='sending'").get(job.id, job.owner)
      if (!row) return
      const attempts = z.object({ attempts: z.number() }).parse(row).attempts
      const state = attempts <= maxRetries ? 'retry_wait' : 'failed'
      this.db.prepare('UPDATE deliveries SET state=?,owner=NULL,error=?,next_attempt_at=?,updated_at=? WHERE notification_id=?')
        .run(state, error.slice(0,512), now + Math.min(300000, 1000 * 2 ** Math.min(attempts, 8)), now, job.id)
      this.bump()
    })
  }
  retry(id: string): void {
    this.tx(() => {
      const row = this.delivery(id)
      if (row.state !== 'failed' && row.state !== 'retry_wait') throw new NotifyError('not_retryable', '只有明确失败的通知可以重试。')
      this.db.prepare("UPDATE deliveries SET state='pending',attempts=0,owner=NULL,next_attempt_at=0,error=NULL,updated_at=? WHERE notification_id=?").run(Date.now(), id)
      this.bump()
    })
  }
  private select = 'SELECT n.*,i.sent_at,i.read_at,i.archived_at FROM notifications n JOIN inbox i ON n.id=i.notification_id'
  private notice(value: unknown): NoticeDetail {
    const row = rowSchema.parse(value)
    return { id: row.id, seq: row.seq, hostId: this.hostId, source: sourceSchema.parse(JSON.parse(row.source)),
      title: row.title, body: row.body, summary: row.body.replace(/\*\*|\u0060/g,'')
        .replace(/(^|\n)\s*(?:#{1,6}\s|[-*]\s|\d+\.\s)/g,'$1').replace(/\s+/g,' ').slice(0,180), category: row.category,
      createdAt: row.created_at, sentAt: row.sent_at, readAt: row.read_at, archivedAt: row.archived_at }
  }
  read(id: string): NoticeDetail {
    this.alive()
    const row = this.db.prepare(this.select + ' WHERE n.id=?').get(id)
    if (!row) throw new NotifyError('not_found', '这条通知已不存在。')
    return this.notice(row)
  }
  list(raw: ListQuery): NoticeList {
    this.alive()
    const query = listQuerySchema.parse(raw)
    const where = [query.archived ? 'i.archived_at IS NOT NULL' : 'i.archived_at IS NULL']
    const args: SQLInputValue[] = []
    if (query.agentId) { where.push("json_extract(n.source,'$.agentId')=?"); args.push(query.agentId) }
    if (query.query) {
      where.push("(instr(lower(n.title || ' ' || n.body || ' ' || json_extract(n.source,'$.agentName') || ' ' || json_extract(n.source,'$.workspace')),lower(?))>0)")
      args.push(query.query)
    }
    const base = ' FROM notifications n JOIN inbox i ON n.id=i.notification_id WHERE ' + where.join(' AND ')
    const count = z.object({ all: z.number(), unread: z.number(), action: z.number() }).parse(this.db.prepare(
      "SELECT COUNT(*) AS 'all',COALESCE(SUM(i.read_at IS NULL),0) AS unread,COALESCE(SUM(n.category='action'),0) AS action" + base).get(...args))
    const filtered = query.filter === 'unread' ? ' AND i.read_at IS NULL' : query.filter === 'action' ? " AND n.category='action'" : ''
    const rows = this.db.prepare('SELECT n.*,i.sent_at,i.read_at,i.archived_at' + base + filtered + ' ORDER BY n.seq DESC LIMIT ?').all(...args, query.limit)
    const sources = this.db.prepare("SELECT json_extract(n.source,'$.agentId') AS id,MAX(json_extract(n.source,'$.agentName')) AS name FROM notifications n JOIN inbox i ON n.id=i.notification_id GROUP BY id ORDER BY name").all()
      .map(row => z.object({ id: z.string(), name: z.string() }).parse(row))
    const total = count[query.filter]
    return { items: rows.map(row => { const { body: _body, ...item } = this.notice(row); return item }), counts: count, sources,
      total, cutoff: Number(this.db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM notifications').get()?.n),
      revision: this.revision, hasMore: total > rows.length }
  }
  markRead(id: string, read: boolean, now = Date.now()): void {
    this.tx(() => {
      this.read(id)
      const result = this.db.prepare('UPDATE inbox SET read_at=? WHERE notification_id=? AND (read_at IS NULL)<>?').run(read ? now : null, id, read ? 0 : 1)
      if (Number(result.changes)) this.bump()
    })
  }
  markAllRead(ids: string[], cutoff: number, now = Date.now()): void {
    this.tx(() => {
      let changed = 0
      for (const id of new Set(ids)) changed += Number(this.db.prepare('UPDATE inbox SET read_at=? WHERE notification_id=? AND read_at IS NULL AND archived_at IS NULL AND notification_id IN (SELECT id FROM notifications WHERE seq<=?)').run(now, id, cutoff).changes)
      if (changed) this.bump()
    })
  }
  archive(id: string, archived: boolean, now = Date.now()): void {
    this.tx(() => {
      this.read(id)
      const result = this.db.prepare('UPDATE inbox SET archived_at=? WHERE notification_id=? AND (archived_at IS NULL)<>?').run(archived ? now : null, id, archived ? 0 : 1)
      if (Number(result.changes)) this.bump()
    })
  }
  private delivery(id: string): Delivery {
    const row = this.db.prepare('SELECT d.*,n.title FROM deliveries d JOIN notifications n ON n.id=d.notification_id WHERE notification_id=?').get(id)
    if (!row) throw new NotifyError('not_found', '通知投递记录不存在。')
    return this.mapDelivery(row)
  }
  private mapDelivery(value: unknown): Delivery {
    const row = deliverySchema.parse(value)
    return { notificationId: row.notification_id, title: row.title, state: row.state, attempts: row.attempts,
      error: row.error, createdAt: row.created_at, updatedAt: row.updated_at, nextAttemptAt: row.next_attempt_at }
  }
  status(): { hostId: string; revision: number; unread: number; latestSentSeq: number; counts: Record<DeliveryState, number>; recent: Delivery[] } {
    this.alive()
    const counts = { pending: 0, sending: 0, sent: 0, retry_wait: 0, failed: 0 }
    for (const value of this.db.prepare('SELECT state,COUNT(*) AS n FROM deliveries GROUP BY state').all()) {
      const row = z.object({ state: z.enum(states), n: z.number() }).parse(value); counts[row.state] = row.n
    }
    return { hostId: this.hostId, revision: this.revision,
      unread: Number(this.db.prepare('SELECT COUNT(*) AS n FROM inbox WHERE read_at IS NULL AND archived_at IS NULL').get()?.n), counts,
      latestSentSeq: Number(this.db.prepare('SELECT COALESCE(MAX(n.seq),0) AS n FROM notifications n JOIN inbox i ON n.id=i.notification_id').get()?.n),
      recent: this.db.prepare('SELECT d.*,n.title FROM deliveries d JOIN notifications n ON n.id=d.notification_id ORDER BY updated_at DESC LIMIT 20').all().map(row => this.mapDelivery(row)) }
  }
  prune(retentionDays: number, now = Date.now()): number {
    if (retentionDays === 0) return 0
    return this.tx(() => {
      const result = this.db.prepare("DELETE FROM notifications WHERE id IN (SELECT i.notification_id FROM inbox i JOIN deliveries d ON d.notification_id=i.notification_id WHERE i.read_at IS NOT NULL AND i.read_at<? AND d.state='sent')").run(now - retentionDays * 86400000)
      const removed = Number(result.changes)
      if (removed) this.bump()
      return removed
    })
  }
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    try { this.db.close() } finally { await this.release() }
  }
}
