/**
 * 宿主桥（TeamHost）—— 团队扩展与「既有 subagent runtime」之间的唯一接缝。
 *
 * 团队扩展**不重写 spawn**：真正的会话创建、续跑、steering 都由宿主提供。
 * 桥有三种来源，按优先级解析：
 *   1. 显式注入（工程内置接线时把 runtime 包成桥，交给工厂第二参）；
 *   2. 进程级全局桥 `globalThis.__piTeamHost`（pi-agent-desktop 接线点，见 t4）。
 *      既有 subagent runtime（lib/subagent-runtime.ts 的 createSubagentController）拥有
 *      start/resume/get/steer 与「后台完成通知」，接线处只需把它适配成下面的 TeamHost。
 *   3. 工具桥降级：宿主既没注入全局桥、又能通过 ctx.executeTool 调用一个「生成子会话」
 *      的工具（例如 oh-my-pi 的 Agent 工具）时，用它代跑；该路径无法在定时器里唤醒收件人。
 * 三者都没有时返回 noop 桥：团队成员仍会被记录、邮箱仍会落盘，但 spawn 返回失败回执。
 *
 * 约束：本文件不 import 任何宿主私有模块，只用 compat 暴露的公共子集。
 */
import type { CompatToolContext } from './compat.js'
import { TEAM_HOST_GLOBAL_KEY, getAgentToolName } from './constants.js'

/** 成员运行状态（对齐既有 subagent run 状态，外加生命周期态）。 */
export type MemberRunStatus =
  | 'queued'
  | 'running'
  | 'idle'
  | 'parked'
  | 'completed'
  | 'failed'
  | 'aborted'
  | 'revived'

/** 生成一个新成员所需的入参。 */
export interface MemberSpawnRequest {
  /** 成员名（团队内唯一）。 */
  name: string
  /** Agent 类型 / 档案名。 */
  profile: string
  /** 完整任务指令。 */
  task: string
  /** 界面上的短标签。 */
  description: string
  /** 可选 provider/modelId 覆盖。 */
  model?: string
  /** 可选思考级别。 */
  thinking?: string
  /** 可选隔离方式：git worktree。 */
  isolation?: 'worktree'
  /** 后台运行（默认 true：团队协作下成员应后台跑，由回执与唤醒驱动）。 */
  runInBackground?: boolean
}

/** 复活一个已挂起/被杀成员所需的入参。 */
export interface MemberReviveRequest {
  sessionId: string
  sessionFile?: string
  name?: string
  /** 复活后要投递的消息（通常是欠着的邮箱内容）。 */
  task?: string
  description?: string
}

/** 宿主返回的一次运行句柄。 */
export interface MemberRunHandle {
  sessionId: string
  sessionFile?: string
  status: MemberRunStatus
  /** 终态时的文本结果。 */
  result?: string
  error?: string
  description?: string
  /** 是否为续跑（resume）产生的报告。 */
  resumed?: boolean
}

/** 宿主桥接口。wake/onFinish 不接收工具上下文：它们可能在定时器里被调用。 */
export interface TeamHost {
  readonly kind: 'subagent' | 'tool' | 'none'
  start(request: MemberSpawnRequest, ctx?: CompatToolContext): Promise<MemberRunHandle>
  revive(request: MemberReviveRequest, ctx?: CompatToolContext): Promise<MemberRunHandle>
  get(sessionId: string, ctx?: CompatToolContext): Promise<MemberRunHandle | null>
  steer(sessionId: string, message: string, ctx?: CompatToolContext): Promise<void>
  stop(sessionId: string, ctx?: CompatToolContext): Promise<void>
  /** 把一批合并后的消息投递给某成员的会话；返回是否投递成功。 */
  wake(request: { sessionId: string; text: string }, ctx?: CompatToolContext): Promise<boolean>
  /** 订阅成员完成事件（至少一次唤醒，不轮询）。返回退订函数。 */
  onFinish(listener: (handle: MemberRunHandle) => void): () => void
}

/** 团队成员终止状态判定。 */
export const TERMINAL_RUN_STATUSES: readonly MemberRunStatus[] = ['completed', 'failed', 'aborted']

export function isTerminalRunStatus(status: MemberRunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status)
}

/** 什么都不做的桥：宿主未提供任何 spawn 能力时使用，所有 spawn 明确失败。 */
export function createNoopHost(): TeamHost {
  return {
    kind: 'none',
    async start() {
      throw new Error(
        '宿主未提供子会话能力（未注入团队宿主桥）。团队数据与邮箱仍可用；请在宿主内置接线中注入 subagent runtime，或设置 PI_TEAM_AGENT_TOOL 指向可调用的生成工具。',
      )
    },
    async revive() {
      throw new Error('宿主未提供子会话能力，无法复活成员。')
    },
    async get() {
      return null
    },
    async steer() {
      throw new Error('宿主未提供子会话能力，无法向成员发送 steering。')
    },
    async stop() {
      throw new Error('宿主未提供子会话能力，无法停止成员。')
    },
    async wake() {
      return false
    },
    onFinish() {
      return () => {}
    },
  }
}

/**
 * 工具桥：把「生成子会话」的宿主工具适配成 TeamHost。仅在宿主未注入全局桥时使用。
 * start 通过 ctx.executeTool(agentTool, {...}) 调用；wake 因缺少工具上下文而无法实现。
 */
export function createToolHost(agentTool: string = getAgentToolName()): TeamHost {
  const listeners = new Set<(handle: MemberRunHandle) => void>()
  const handles = new Map<string, MemberRunHandle>()
  const emit = (handle: MemberRunHandle) => {
    handles.set(handle.sessionId, handle)
    for (const listener of listeners) {
      try {
        listener(handle)
      } catch {
        // 监听器异常不得打断派发
      }
    }
  }
  const readSessionId = (value: unknown): string | undefined => {
    if (typeof value === 'string') return value
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>
      for (const key of ['sessionId', 'session_id', 'agent_id', 'agentId', 'id']) {
        const found = record[key]
        if (typeof found === 'string' && found) return found
      }
    }
    return undefined
  }
  const requireExecute = (ctx?: CompatToolContext): NonNullable<CompatToolContext['executeTool']> => {
    const executeTool = ctx?.executeTool
    if (!executeTool) {
      throw new Error(
        `工具桥需要执行 "${agentTool}" 的上下文，但当前调用未提供 executeTool。`,
      )
    }
    return executeTool
  }
  return {
    kind: 'tool',
    async start(request, ctx) {
      const executeTool = requireExecute(ctx)
      const result = await executeTool(agentTool, {
        prompt: request.task,
        subagent_type: request.profile,
        description: request.description,
        run_in_background: request.runInBackground ?? true,
        ...(request.model ? { model: request.model } : {}),
        ...(request.thinking ? { thinking: request.thinking } : {}),
        ...(request.isolation ? { isolation: request.isolation } : {}),
      })
      const sessionId = readSessionId(result)
      if (!sessionId) {
        throw new Error(`工具 "${agentTool}" 未返回可识别的会话 ID，无法登记成员。`)
      }
      const handle: MemberRunHandle = { sessionId, status: 'running', description: request.description }
      handles.set(sessionId, handle)
      return handle
    },
    async revive(request, ctx) {
      const executeTool = requireExecute(ctx)
      const result = await executeTool(agentTool, {
        resume: request.sessionId,
        prompt: request.task ?? '继续你之前的任务，并把结果回报给团队。',
        description: request.description ?? request.name ?? '复活成员',
        run_in_background: true,
      })
      const sessionId = readSessionId(result) ?? request.sessionId
      const handle: MemberRunHandle = { sessionId, status: 'revived', description: request.description }
      emit(handle)
      return handle
    },
    async get(sessionId) {
      return handles.get(sessionId) ?? null
    },
    async steer(sessionId, message, ctx) {
      const executeTool = requireExecute(ctx)
      await executeTool('steer_subagent', { agent_id: sessionId, message })
    },
    async stop(sessionId, ctx) {
      const executeTool = requireExecute(ctx)
      await executeTool('get_subagent_result', { agent_id: sessionId, wait: false })
    },
    async wake() {
      // 工具桥无法在定时器里获得工具上下文，唤醒降级为「留存在邮箱里等下次轮询/等待」。
      return false
    },
    onFinish(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

/** 读取进程级全局桥。 */
export function getInjectedHost(): TeamHost | undefined {
  const host = (globalThis as Record<string, unknown>)[TEAM_HOST_GLOBAL_KEY]
  if (host && typeof host === 'object' && typeof (host as TeamHost).start === 'function') {
    return host as TeamHost
  }
  return undefined
}

/** 注入进程级全局桥（供 pi-agent-desktop 内置接线调用）。 */
export function setInjectedHost(host: TeamHost | undefined): void {
  if (host === undefined) {
    delete (globalThis as Record<string, unknown>)[TEAM_HOST_GLOBAL_KEY]
    return
  }
  ;(globalThis as Record<string, unknown>)[TEAM_HOST_GLOBAL_KEY] = host
}

/**
 * 解析当前生效的宿主桥：显式注入 > 进程级全局桥 > 工具桥（仅当用例显式要求）> noop。
 */
export function resolveTeamHost(explicit?: TeamHost): TeamHost {
  if (explicit) return explicit
  const injected = getInjectedHost()
  if (injected) return injected
  if (process.env.PI_TEAM_ENABLE_TOOL_BRIDGE === '1') return createToolHost()
  return createNoopHost()
}
