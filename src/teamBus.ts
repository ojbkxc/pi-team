/**
 * 团队邮箱总线（TeamBus）—— 进程级的消息投递与回执，语义对齐 oh-my-pi 的 IrcBus：
 *   - send 返回**回执**（injected / woken / revived / buffered / failed），报告消息如何到达
 *     收件人，而不是收件人怎么处理；
 *   - 「只等欠我回复的人」：unansweredSends 记下我直接发过、对方尚未回复的成员；
 *   - 等待不轮询：wait 挂起一个 Promise，投递或「成员完成」事件到达时被唤醒；
 *   - 同一 recipient 的短时间消息合并成一次 dispatch（静默窗口防抖，窗口内只唤醒一次）。
 *
 * 存储复用既有 teammateMailbox（落盘 + proper-lockfile + 身份声明读），因此跨进程也能投递；
 * 本类只额外管理进程内的等待者、发送标记与合并派发。
 */
import {
  readUnreadMessages,
  writeToMailbox,
  claimMailboxMessages,
  formatTeammateMessages,
} from './teammateMailbox.js'
import { getDispatchQuietWindowMs, getDispatchMaxWaitMs } from './constants.js'
import type { MemberRunHandle, TeamHost } from './teamHost.js'
import type { MemberLifecycleStatus } from './teamLifecycle.js'

export type DeliveryOutcome = 'injected' | 'woken' | 'revived' | 'buffered' | 'failed'

export interface DeliveryReceipt {
  to: string
  messageId: string
  outcome: DeliveryOutcome
  error?: string
  /** 广播时每个收件人的结果。 */
  targets?: Array<{ to: string; outcome: DeliveryOutcome; error?: string }>
}

export interface BusSendOptions {
  from: string
  to: string
  body: string
  summary?: string
  /** 进度型消息：不算「承诺回复」，也不构成一个未答复的直发。 */
  progress?: boolean
}

/** wait 的过滤条件；对齐 oh-my-pi 的 IrcWaitFilter。 */
export interface BusWaitFilter {
  from?: string
  directOnly?: boolean
  repliesFrom?: readonly string[]
}

export interface BusWaitMessage {
  id: string
  from: string
  body: string
  summary?: string
  ts: number
}

export interface BusContext {
  host(): TeamHost
  lifecycle(): {
    get(name: string): Promise<{ sessionId?: string; status: MemberLifecycleStatus } | undefined>
    ensureLive(name: string): Promise<{ sessionId?: string; status: MemberLifecycleStatus }>
    markIdle(name: string): Promise<unknown>
  }
  teamName(): string | undefined
  self(): string
  members(): Promise<string[]>
}

/** 一次投放在某毫秒发出的时机：ts + seq，用于同一毫秒内的先后排序。 */
interface SendMark {
  ts: number
  seq: number
}

interface BusWaiter {
  filter: BusWaitFilter
  resolve: (message: BusWaitMessage) => void
  cancel: () => void
}

interface PendingDispatch {
  firstAt: number
  timer: NodeJS.Timeout
}

export function busWaitAccepts(filter: BusWaitFilter, message: { from: string; progress?: boolean; broadcast?: boolean }): boolean {
  if (filter.from !== undefined && message.from !== filter.from) return false
  if (!filter.directOnly || (!message.broadcast && !message.progress)) return true
  return !message.progress && (filter.repliesFrom?.includes(message.from) ?? false)
}

export class TeamBus {
  readonly #ctx: BusContext
  readonly #waiters = new Map<string, BusWaiter[]>()
  readonly #lastSent = new Map<string, Map<string, SendMark>>()
  readonly #lastDirect = new Map<string, Map<string, SendMark>>()
  readonly #lastProgress = new Map<string, Map<string, SendMark>>()
  readonly #lastJobReply = new Map<string, Map<string, SendMark>>()
  readonly #pending = new Map<string, PendingDispatch>()
  readonly #finishListeners = new Set<(handle: MemberRunHandle) => void>()
  #seq = 0

  constructor(ctx: BusContext) {
    this.#ctx = ctx
  }

  /** 订阅成员完成事件；返回退订函数。 */
  onFinish(listener: (handle: MemberRunHandle) => void): () => void {
    this.#finishListeners.add(listener)
    return () => this.#finishListeners.delete(listener)
  }

  #record(table: Map<string, Map<string, SendMark>>, from: string, to: string, mark: SendMark): void {
    let sent = table.get(from)
    if (!sent) {
      sent = new Map()
      table.set(from, sent)
    }
    if ((sent.get(to)?.seq ?? 0) < mark.seq) sent.set(to, mark)
  }

  /** 记一次「from 的已结算作业交付给 to」，算作 from 对 to 的回复。 */
  recordReply(from: string, to: string): void {
    this.#record(this.#lastJobReply, from, to, { ts: Date.now(), seq: ++this.#seq })
  }

  /**
   * from 在 sinceSeq 之后直接消息过、但对方此后没有答复的成员。
   * 进度消息不算回复（标记为 promised）。「之后」按发送序号而非时间戳，避免同毫秒误判。
   */
  unansweredSends(from: string, sinceSeq: number): Array<{ to: string; sentAt: number; promised: boolean }> {
    const sends = this.#lastDirect.get(from)
    if (!sends) return []
    const unanswered: Array<{ to: string; sentAt: number; promised: boolean }> = []
    for (const [to, sent] of sends) {
      if (sent.seq < sinceSeq) continue
      const after = (table: Map<string, Map<string, SendMark>>) => (table.get(to)?.get(from)?.seq ?? 0) > sent.seq
      const promised = after(this.#lastProgress)
      if (after(this.#lastSent) || (!promised && after(this.#lastJobReply))) continue
      unanswered.push({ to, sentAt: sent.ts, promised })
    }
    return unanswered
  }

  /** 当前发送序号，配合 unansweredSends 用作「从现在起」的游标。 */
  cursor(): number {
    return this.#seq
  }

  /**
   * 发送消息。广播（to === '*'）展开为逐个直发并汇总回执。
   */
  async send(options: BusSendOptions): Promise<DeliveryReceipt> {
    if (options.to === '*') {
      const members = await this.#ctx.members()
      const targets: Array<{ to: string; outcome: DeliveryOutcome; error?: string }> = []
      for (const member of members) {
        if (member === options.from) continue
        const receipt = await this.send({ ...options, to: member })
        targets.push({ to: member, outcome: receipt.outcome, ...(receipt.error ? { error: receipt.error } : {}) })
      }
      const outcome: DeliveryOutcome = targets.length === 0
        ? 'failed'
        : targets.some((target) => target.outcome === 'failed')
          ? 'failed'
          : targets.every((target) => target.outcome === 'buffered')
            ? 'buffered'
            : targets.some((target) => target.outcome === 'revived')
              ? 'revived'
              : targets.some((target) => target.outcome === 'injected')
                ? 'injected'
                : 'woken'
      return {
        to: '*',
        messageId: `broadcast-${++this.#seq}`,
        outcome,
        targets,
        ...(outcome === 'failed' ? { error: targets.find((t) => t.outcome === 'failed')?.error } : {}),
      }
    }

    const messageId = `bus-${++this.#seq}-${options.to}`
    const mark: SendMark = { ts: Date.now(), seq: this.#seq }
    const isDirect = !options.progress && options.to !== '*'

    // 1) 正在等待的收件人直接取走：不落盘、不重复投递。
    const waiter = this.#takeMatchingWaiter(options.to, { from: options.from, progress: options.progress })
    if (waiter) {
      waiter.resolve({
        id: messageId,
        from: options.from,
        body: options.body,
        summary: options.summary,
        ts: mark.ts,
      })
      if (options.progress) this.#record(this.#lastProgress, options.from, options.to, mark)
      else {
        this.#record(this.#lastSent, options.from, options.to, mark)
        if (isDirect) this.#record(this.#lastDirect, options.from, options.to, mark)
      }
      return { to: options.to, messageId, outcome: 'injected' }
    }

    // 2) 落盘，保证跨进程与重启后的耐久性。
    const persisted = await writeToMailbox(
      options.to,
      {
        from: options.from,
        text: options.body,
        summary: options.summary,
        timestamp: new Date(mark.ts).toISOString(),
      },
      this.#ctx.teamName(),
    )
    if (!persisted) {
      return { to: options.to, messageId, outcome: 'failed', error: `收件人 ${options.to} 的邮箱暂不可写（可能被锁住）。` }
    }

    // 3) 判定投递结果并调度合并唤醒。
    const entry = await this.#ctx.lifecycle().get(options.to)
    let outcome: DeliveryOutcome
    let error: string | undefined
    if (!entry) {
      outcome = 'buffered'
      error = `成员 ${options.to} 尚未登记运行态；消息已落盘，待其会话恢复后 drain。`
    } else if (entry.status === 'parked' || entry.status === 'aborted') {
      const revived = await this.#revive(options.to)
      outcome = revived ? 'revived' : 'buffered'
      if (!revived) error = `成员 ${options.to} 处于 ${entry.status} 且复活失败；消息已落盘。`
    } else if (entry.sessionId) {
      outcome = 'woken'
      this.#scheduleWake(options.to, entry.sessionId)
    } else {
      outcome = 'buffered'
      error = `成员 ${options.to} 无活跃会话 ID；消息已落盘，待其恢复后 drain。`
    }

    // outcome 在此路径下必不为 'failed'（失败已提前 return），一律记录发送标记。
    if (options.progress) this.#record(this.#lastProgress, options.from, options.to, mark)
    else {
      this.#record(this.#lastSent, options.from, options.to, mark)
      if (isDirect) this.#record(this.#lastDirect, options.from, options.to, mark)
    }
    return { to: options.to, messageId, outcome, ...(error ? { error } : {}) }
  }

  async #revive(to: string): Promise<boolean> {
    try {
      await this.#ctx.lifecycle().ensureLive(to)
      return true
    } catch (error) {
      if (process.env.PI_TEAM_DEBUG) console.error(`[pi-team:bus] 复活 ${to} 失败: ${error}`)
      return false
    }
  }

  /**
   * 阻塞等待一条满足 filter 的来信（超时返回 null；timeoutMs <= 0 表示一直等）。
   * 默认先 drain 已落盘的未读（可能是更早发送的），再挂起等待者。
   */
  async wait(
    agentName: string,
    filter: BusWaitFilter,
    timeoutMs: number,
    signal?: AbortSignal,
    options: { drainPending?: boolean } = {},
  ): Promise<BusWaitMessage | null> {
    if (signal?.aborted) throw new Error('等待被中止。')

    if (options.drainPending !== false) {
      const pending = await this.#drain(agentName, filter)
      if (pending) return pending
    }

    return new Promise<BusWaitMessage | null>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined
      let onAbort: (() => void) | undefined
      const cleanup = () => {
        this.#removeWaiter(agentName, waiter)
        if (timer) clearTimeout(timer)
        if (signal && onAbort) signal.removeEventListener('abort', onAbort)
      }
      const waiter: BusWaiter = {
        filter,
        resolve: (message) => {
          cleanup()
          resolve(message)
        },
        cancel: cleanup,
      }
      if (signal) {
        onAbort = () => {
          cleanup()
          reject(new Error('等待被中止。'))
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          cleanup()
          resolve(null)
        }, timeoutMs)
        timer.unref?.()
      }
      let list = this.#waiters.get(agentName)
      if (!list) {
        list = []
        this.#waiters.set(agentName, list)
      }
      list.push(waiter)
    })
  }

  /** 从落盘邮箱里取走一条满足 filter 的未读消息（按身份声明，避免与他人重复取用）。 */
  async #drain(agentName: string, filter: BusWaitFilter): Promise<BusWaitMessage | null> {
    const unread = await readUnreadMessages(agentName, this.#ctx.teamName())
    if (unread.length === 0) return null
    const matched = unread.filter((message) =>
      busWaitAccepts(filter, { from: message.from }),
    )
    if (matched.length === 0) return null
    const claimed = await claimMailboxMessages(agentName, this.#ctx.teamName(), matched)
    if (!claimed || claimed.length === 0) return null
    const first = claimed[0]
    return { id: first.id ?? `drain-${first.timestamp}`, from: first.from, body: first.text, summary: first.summary, ts: Date.parse(first.timestamp) || Date.now() }
  }

  #takeMatchingWaiter(to: string, message: { from: string; progress?: boolean }): BusWaiter | undefined {
    const waiters = this.#waiters.get(to)
    if (!waiters) return undefined
    const index = waiters.findIndex((waiter) => busWaitAccepts(waiter.filter, { from: message.from, progress: message.progress }))
    if (index === -1) return undefined
    const [waiter] = waiters.splice(index, 1)
    if (waiters.length === 0) this.#waiters.delete(to)
    return waiter
  }

  /**
   * 向正阻塞等待 `to` 的等待者投递一条「合成回复」——用于成员完成（而非发送消息）时唤醒
   * 正在等它的 lead，实现「不轮询、被等待者完成即唤醒」。返回是否命中等待者。
   */
  deliverSyntheticReply(to: string, from: string, body: string, summary?: string): boolean {
    const waiter = this.#takeMatchingWaiter(to, { from })
    if (!waiter) return false
    waiter.resolve({ id: `finish-${from}-${++this.#seq}`, from, body, summary, ts: Date.now() })
    return true
  }

  #removeWaiter(agentName: string, waiter: BusWaiter): void {
    const waiters = this.#waiters.get(agentName)
    if (!waiters) return
    const index = waiters.indexOf(waiter)
    if (index !== -1) waiters.splice(index, 1)
    if (waiters.length === 0) this.#waiters.delete(agentName)
  }

  // -------------------------------------------------------------------------
  // 合并派发：静默窗口内到达的消息合成一次 wake
  // -------------------------------------------------------------------------

  #scheduleWake(to: string, sessionId: string): void {
    const quiet = getDispatchQuietWindowMs()
    const maxWait = getDispatchMaxWaitMs()
    const existing = this.#pending.get(to)
    if (existing) {
      clearTimeout(existing.timer)
      const elapsed = Date.now() - existing.firstAt
      const remainingMax = Math.max(0, maxWait - elapsed)
      const delay = Math.min(quiet, remainingMax)
      existing.timer = setTimeout(() => void this.#flush(to, sessionId), delay)
      existing.timer.unref?.()
      return
    }
    const timer = setTimeout(() => void this.#flush(to, sessionId), quiet)
    timer.unref?.()
    this.#pending.set(to, { firstAt: Date.now(), timer })
  }

  async #flush(to: string, sessionId: string): Promise<void> {
    const pending = this.#pending.get(to)
    if (pending) clearTimeout(pending.timer)
    this.#pending.delete(to)
    try {
      const unread = await readUnreadMessages(to, this.#ctx.teamName())
      if (unread.length === 0) return
      const text = formatTeammateMessages(unread)
      const ok = await this.#ctx.host().wake({ sessionId, text })
      if (ok) {
        // 已注入会话，标记为已读，避免之后 drain 时重复投递。
        await claimMailboxMessages(to, this.#ctx.teamName(), unread)
      }
    } catch (error) {
      if (process.env.PI_TEAM_DEBUG) console.error(`[pi-team:bus] 合并派发给 ${to} 失败: ${error}`)
    }
  }

  /**
   * 成员完成：记为「该成员对其任务归属者/团队 lead 的回复」，通知生命周期，并唤醒正在等它的等待者。
   */
  async notifyFinished(handle: MemberRunHandle, notify: string[]): Promise<void> {
    for (const who of notify) {
      if (who && who !== handle.sessionId) this.recordReply(handle.sessionId, who)
    }
    for (const listener of this.#finishListeners) {
      try {
        listener(handle)
      } catch {
        // 监听器异常不得打断
      }
    }
  }

  dispose(): void {
    for (const pending of this.#pending.values()) clearTimeout(pending.timer)
    this.#pending.clear()
    for (const waiters of this.#waiters.values()) {
      for (const waiter of waiters) waiter.cancel()
    }
    this.#waiters.clear()
    this.#finishListeners.clear()
  }
}

// ---------------------------------------------------------------------------
// 进程级实例管理
// ---------------------------------------------------------------------------

const BUS_GLOBAL_KEY = '__piTeamBuses'

function busRegistry(): Map<string, TeamBus> {
  const store = globalThis as Record<string, unknown>
  if (!(store[BUS_GLOBAL_KEY] instanceof Map)) {
    store[BUS_GLOBAL_KEY] = new Map<string, TeamBus>()
  }
  return store[BUS_GLOBAL_KEY] as Map<string, TeamBus>
}

export function getBus(teamName: string, ctx: BusContext): TeamBus {
  const registry = busRegistry()
  const existing = registry.get(teamName)
  if (existing) return existing
  const created = new TeamBus(ctx)
  registry.set(teamName, created)
  return created
}

export function dropBus(teamName: string): void {
  const registry = busRegistry()
  registry.get(teamName)?.dispose()
  registry.delete(teamName)
}
