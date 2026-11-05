/**
 * 成员生命周期：idle → parked → revived 建模。
 *
 * 设计对齐 oh-my-pi 的 AgentLifecycleManager，但**不重写会话的创建与持久化**：
 * 真正的会话文件（sessionFile）由宿主的 subagent runtime 生成与维护，本模块只
 *   - 记录每个成员的运行态与「代数（generation）」；
 *   - 成员空闲超过 TTL 时由 idle 转入 parked（不销毁会话文件，仅停止在内存里视为活跃）；
 *   - 收到消息或显式请求时 ensureLive：parked / aborted 的成员通过宿主桥 revive（复用同一 sessionFile）；
 *   - 用 generation CAS 拒绝迟到的异步操作覆盖新状态。
 *
 * 状态落盘到 <teamDir>/lifecycle.json，因此重启进程后仍能按 sessionFile 复活成员。
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { getTeamDir } from './teamHelpers.js'
import { isLifecyclePersisted, getIdleTtlMs } from './constants.js'
import type { MemberRunHandle, TeamHost } from './teamHost.js'

export type MemberLifecycleStatus = 'idle' | 'running' | 'parked' | 'aborted'

export interface MemberLifecycleEntry {
  name: string
  sessionId?: string
  sessionFile?: string
  status: MemberLifecycleStatus
  /** 状态代数：每次状态迁移 +1，用于拒绝迟到的异步覆盖。 */
  generation: number
  parkedAt?: number
  updatedAt: number
  lastError?: string
}

interface LifecycleFile {
  version: 1
  members: Record<string, MemberLifecycleEntry>
}

function lifecyclePath(teamName: string): string {
  return join(getTeamDir(teamName), 'lifecycle.json')
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, content, { encoding: 'utf-8', flag: 'wx', mode: 0o600 })
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(temp, path)
        return
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code
        if (process.platform !== 'win32' || attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '')) {
          throw error
        }
        await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)))
      }
    }
  } finally {
    await rm(temp, { force: true })
  }
}

/** 进行中的复活操作，按成员名合并，避免并发 ensureLive 反复重建。 */
interface ReviveInFlight {
  promise: Promise<MemberLifecycleEntry>
}

export class TeamLifecycle {
  readonly #teamName: string
  readonly #host: TeamHost
  readonly #members = new Map<string, MemberLifecycleEntry>()
  readonly #timers = new Map<string, NodeJS.Timeout>()
  readonly #revives = new Map<string, ReviveInFlight>()
  #loaded = false

  constructor(teamName: string, host: TeamHost) {
    this.#teamName = teamName
    this.#host = host
  }

  async #ensureLoaded(): Promise<void> {
    if (this.#loaded) return
    this.#loaded = true
    if (!isLifecyclePersisted()) return
    try {
      const raw = await readFile(lifecyclePath(this.#teamName), 'utf-8')
      const parsed = JSON.parse(raw) as Partial<LifecycleFile>
      if (parsed && parsed.members && typeof parsed.members === 'object') {
        for (const [name, entry] of Object.entries(parsed.members)) {
          if (entry && typeof entry === 'object') {
            const partial = entry as Partial<MemberLifecycleEntry>
            this.#members.set(name, {
              name: partial.name ?? name,
              status: partial.status ?? 'idle',
              generation: partial.generation ?? 0,
              updatedAt: partial.updatedAt ?? 0,
              ...(partial.sessionId ? { sessionId: partial.sessionId } : {}),
              ...(partial.sessionFile ? { sessionFile: partial.sessionFile } : {}),
              ...(partial.parkedAt ? { parkedAt: partial.parkedAt } : {}),
              ...(partial.lastError ? { lastError: partial.lastError } : {}),
            })
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        if (process.env.PI_TEAM_DEBUG) console.error(`[pi-team:lifecycle] 读取失败: ${error}`)
      }
    }
  }

  async #persist(): Promise<void> {
    if (!isLifecyclePersisted()) return
    const file: LifecycleFile = { version: 1, members: Object.fromEntries(this.#members) }
    await mkdir(getTeamDir(this.#teamName), { recursive: true })
    await writeAtomic(lifecyclePath(this.#teamName), JSON.stringify(file, null, 2))
  }

  /** 读取成员条目（不存在返回 undefined）。 */
  async get(name: string): Promise<MemberLifecycleEntry | undefined> {
    await this.#ensureLoaded()
    return this.#members.get(name)
  }

  async list(): Promise<MemberLifecycleEntry[]> {
    await this.#ensureLoaded()
    return [...this.#members.values()]
  }

  /**
   * 以 generation CAS 应用一次迁移：仅当成员当前代数等于 expected 时才写入。
   * 返回更新后的条目；代数不匹配（有更新的迁移领先）时返回当前条目且不覆盖。
   */
  async #apply(
    name: string,
    expected: number | undefined,
    mutate: (entry: MemberLifecycleEntry) => MemberLifecycleEntry,
  ): Promise<MemberLifecycleEntry> {
    await this.#ensureLoaded()
    const current: MemberLifecycleEntry =
      this.#members.get(name) ?? { name, status: 'idle', generation: 0, updatedAt: 0 }
    if (expected !== undefined && current.generation !== expected) return current
    const next = mutate(current)
    next.generation = current.generation + 1
    next.updatedAt = Date.now()
    this.#members.set(name, next)
    await this.#persist()
    return next
  }

  #clearTimer(name: string): void {
    const timer = this.#timers.get(name)
    if (timer) {
      clearTimeout(timer)
      this.#timers.delete(name)
    }
  }

  #armIdleTimer(name: string, generation: number): void {
    this.#clearTimer(name)
    const ttl = getIdleTtlMs()
    if (ttl <= 0) return
    const timer = setTimeout(() => {
      this.#timers.delete(name)
      void this.#apply(name, generation, (entry) =>
        entry.status === 'idle' ? { ...entry, status: 'parked', parkedAt: Date.now() } : entry,
      ).then((entry) => {
        if (entry.status !== 'parked' && entry.status === 'idle') this.#armIdleTimer(name, entry.generation)
      })
    }, ttl)
    timer.unref?.()
    this.#timers.set(name, timer)
  }

  /** 登记一个新成员并置为 idle，arm 空闲 TTL。 */
  async adopt(name: string, info: { sessionId?: string; sessionFile?: string }): Promise<MemberLifecycleEntry> {
    const entry = await this.#apply(name, undefined, (current) => ({
      ...current,
      sessionId: info.sessionId ?? current.sessionId,
      sessionFile: info.sessionFile ?? current.sessionFile,
      status: 'idle',
      parkedAt: undefined,
      lastError: undefined,
    }))
    this.#armIdleTimer(name, entry.generation)
    return entry
  }

  /** 标记成员正在运行（清掉空闲计时器）。 */
  async markRunning(name: string): Promise<MemberLifecycleEntry> {
    this.#clearTimer(name)
    return this.#apply(name, undefined, (current) => ({ ...current, status: 'running' }))
  }

  /** 标记成员回到空闲（重新 arm 空闲计时器，TTL 后自动 parked）。 */
  async markIdle(name: string): Promise<MemberLifecycleEntry> {
    const entry = await this.#apply(name, undefined, (current) => ({ ...current, status: 'idle' }))
    this.#armIdleTimer(name, entry.generation)
    return entry
  }

  /** 显式挂起：idle → parked。默认只改本地状态，保留 sessionFile；设置 PI_TEAM_PARK_DISPOSE=1 时顺带让宿主释放会话。 */
  async park(name: string): Promise<MemberLifecycleEntry> {
    this.#clearTimer(name)
    const entry = await this.#apply(name, undefined, (current) =>
      current.status === 'parked' ? current : { ...current, status: 'parked', parkedAt: Date.now() },
    )
    if (process.env.PI_TEAM_PARK_DISPOSE === '1' && entry.sessionId) {
      try {
        await this.#host.stop(entry.sessionId)
      } catch (error) {
        if (process.env.PI_TEAM_DEBUG) console.error(`[pi-team:lifecycle] park 释放会话失败: ${error}`)
      }
    }
    return entry
  }

  /** 明确终止（tombstone）：aborted，保留 sessionFile 以便日后 ensureLive 复活。 */
  async release(name: string, options: { tombstone?: boolean } = {}): Promise<MemberLifecycleEntry> {
    this.#clearTimer(name)
    const entry = await this.#apply(name, undefined, (current) => ({
      ...current,
      status: options.tombstone ? 'aborted' : 'parked',
      parkedAt: Date.now(),
    }))
    if (entry.sessionId) {
      try {
        await this.#host.stop(entry.sessionId)
      } catch (error) {
        if (process.env.PI_TEAM_DEBUG) console.error(`[pi-team:lifecycle] release 停止会话失败: ${error}`)
      }
    }
    return entry
  }

  /**
   * 确保成员有活跃会话：
   *  - running/idle → 直接返回；
   *  - parked/aborted → 通过宿主桥 revive（复用 sessionFile），成功后回到 idle。
   * 并发调用按成员名合并。
   */
  async ensureLive(name: string): Promise<MemberLifecycleEntry> {
    await this.#ensureLoaded()
    const current = this.#members.get(name)
    if (!current) throw new Error(`成员 "${name}" 未登记到生命周期中。`)
    if (current.status === 'running' || current.status === 'idle') {
      this.#armIdleTimer(name, current.generation)
      return current
    }
    const inflight = this.#revives.get(name)
    if (inflight) return inflight.promise
    const promise = this.#revive(name, current)
    this.#revives.set(name, { promise })
    try {
      return await promise
    } finally {
      if (this.#revives.get(name)?.promise === promise) this.#revives.delete(name)
    }
  }

  async #revive(name: string, snapshot: MemberLifecycleEntry): Promise<MemberLifecycleEntry> {
    if (!snapshot.sessionId) {
      throw new Error(
        `成员 "${name}" 处于 ${snapshot.status} 但没有可复活的会话（sessionId 缺失）；请在邮箱里留言，等它的会话恢复后自行 drain。`,
      )
    }
    let handle: MemberRunHandle
    try {
      handle = await this.#host.revive({
        sessionId: snapshot.sessionId,
        sessionFile: snapshot.sessionFile,
        name,
        description: `复活成员 ${name}`,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.#apply(name, undefined, (current) => ({ ...current, lastError: message }))
      throw new Error(`复活成员 "${name}" 失败：${message}`)
    }
    const entry = await this.#apply(name, snapshot.generation, (current) => ({
      ...current,
      sessionId: handle.sessionId || current.sessionId,
      sessionFile: handle.sessionFile ?? current.sessionFile,
      status: 'idle',
      parkedAt: undefined,
      lastError: undefined,
    }))
    this.#armIdleTimer(name, entry.generation)
    return entry
  }

  /** 记录一次宿主完成事件：成员回到 idle（arm TTL）或进入终止态。 */
  async onRunFinished(name: string, handle: MemberRunHandle): Promise<MemberLifecycleEntry> {
    this.#clearTimer(name)
    if (handle.status === 'completed' || handle.status === 'failed' || handle.status === 'aborted') {
      return this.#apply(name, undefined, (current) => ({
        ...current,
        sessionId: handle.sessionId || current.sessionId,
        sessionFile: handle.sessionFile ?? current.sessionFile,
        status: 'idle',
        ...(handle.error ? { lastError: handle.error } : {}),
      }))
    }
    return this.markIdle(name)
  }

  /** 停止所有计时器（进程退出或团队删除时调用）。 */
  dispose(): void {
    for (const timer of this.#timers.values()) clearTimeout(timer)
    this.#timers.clear()
    this.#revives.clear()
  }
}

// ---------------------------------------------------------------------------
// 进程级实例管理
// ---------------------------------------------------------------------------

const LIFECYCLE_GLOBAL_KEY = '__piTeamLifecycles'

function lifecycleRegistry(): Map<string, TeamLifecycle> {
  const store = globalThis as Record<string, unknown>
  if (!(store[LIFECYCLE_GLOBAL_KEY] instanceof Map)) {
    store[LIFECYCLE_GLOBAL_KEY] = new Map<string, TeamLifecycle>()
  }
  return store[LIFECYCLE_GLOBAL_KEY] as Map<string, TeamLifecycle>
}

/** 取（或创建）某团队在本进程的生命周期管理器。 */
export function getLifecycle(teamName: string, host: TeamHost): TeamLifecycle {
  const registry = lifecycleRegistry()
  const existing = registry.get(teamName)
  if (existing) return existing
  const created = new TeamLifecycle(teamName, host)
  registry.set(teamName, created)
  return created
}

/** 丢弃某团队的生命周期管理器（团队删除时调用）。 */
export function dropLifecycle(teamName: string): void {
  const registry = lifecycleRegistry()
  registry.get(teamName)?.dispose()
  registry.delete(teamName)
}
