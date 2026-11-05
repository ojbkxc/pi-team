/**
 * 团队编排工具集（中文描述）。
 *
 * 这一层是「团队语义」的落点：成员名册与计划（复用既有 teamHelpers / teamPlanStore），
 * 邮箱回执与等待（teamBus），成员生命周期（teamLifecycle），真正的 spawn/revive 交给宿主桥
 * （teamHost）。工具只被注册，不硬编码任何宿主私有 API。
 *
 * 三条硬性提示词契约（来自 oh-my-pi 的团队实践）写进相关工具的 description：
 *   1. 共享文件必须有**唯一的 integration owner**（改同一份共享文件的成员只能有一个，其余人通过通信请它代改）；
 *   2. 每个任务**跳过 build/lint/test**，全部任务结束前由 lead 统一跑一次；
 *   3. **siblings 只为解阻塞通信**，不做闲聊、不广播进度噪声。
 */
import {
  Type,
  defineCompatTool,
  toolErrorResult,
  toolTextResult,
  type CompatApi,
  type CompatToolContext,
} from './compat.js'
import {
  TEAM_LEAD_NAME,
  TEAM_LIMIT_PREFIX,
  getMaxGlobalWorkers,
  getMaxMembersPerTeam,
} from './constants.js'
import {
  writeTeamFileAsync,
  readTeamFileAsync,
  deleteTeamDir,
  listTeamNames,
  type TeamFile,
} from './teamHelpers.js'
import {
  approveTeamPlan,
  claimPlanLaunch,
  completePlanLaunch,
  ensureTeamDraft,
  failPlanLaunch,
  readTeamPlan,
  replaceTeamPlan,
  submitTeamPlan,
  TeamPlanError,
} from './teamPlanStore.js'
import { getLifecycle, dropLifecycle, type TeamLifecycle } from './teamLifecycle.js'
import { getBus, dropBus, type TeamBus } from './teamBus.js'
import * as tickets from './teamTickets.js'
import type { MemberRunHandle, TeamHost } from './teamHost.js'

// ---------------------------------------------------------------------------
// 运行环境
// ---------------------------------------------------------------------------

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 统计全进程当前活跃的 worker 数（不含 team-lead），用于全局上限判断。
 *
 * 团队数据都在磁盘上（~/.pi/agent/teams/<team>/config.json），所以统计要跨所有团队。
 * `excludeTeam` 用来跳过调用方自己：team_create 是先落盘名册再派发，若把自己也算进
 * 基数，新建团队第一次派发就会自我判超限。读不到的文件直接跳过 —— 一个坏掉的团队
 * 目录不该让别的团队也派不出人。
 */
async function countActiveWorkers(excludeTeam?: string): Promise<number> {
  let total = 0
  for (const teamName of await listTeamNames()) {
    if (excludeTeam && teamName === excludeTeam) continue
    try {
      const teamFile = await readTeamFileAsync(teamName)
      if (!teamFile) continue
      total += teamFile.members.filter((member) => member.name !== TEAM_LEAD_NAME).length
    } catch {
      // 坏掉的团队目录不参与统计，也不阻断派发。
    }
  }
  return total
}

/**
 * 派发前的上限检查（设计文档 §8：8 / 32）。
 *
 * 两个上限都要查，因为它们的拒绝原因对调用方意义不同：per-team 说明「你的团队已经
 * 满了，删点人或拆团队」；global 说明「别的团队占着名额，等它们收工」。
 */
async function checkSpawnLimits(
  teamName: string,
  requestedWorkerCount: number,
): Promise<string | null> {
  const perTeamLimit = getMaxMembersPerTeam()
  if (requestedWorkerCount > perTeamLimit) {
    return (
      `${TEAM_LIMIT_PREFIX}: per-team worker limit reached (${perTeamLimit}). ` +
      `团队 "${teamName}" 本次要派发 ${requestedWorkerCount} 名成员，超过每团队上限 ${perTeamLimit}。` +
      `请拆成多个团队，或减少成员数量。`
    )
  }

  const globalLimit = getMaxGlobalWorkers()
  const activeWorkers = await countActiveWorkers(teamName)
  if (activeWorkers + requestedWorkerCount > globalLimit) {
    return (
      `${TEAM_LIMIT_PREFIX}: global worker limit reached (${globalLimit}). ` +
      `当前全进程已有 ${activeWorkers} 名活跃成员，再派发 ${requestedWorkerCount} 名会超过上限 ${globalLimit}。` +
      `请等待其他团队的成员收工，或先 team_delete 不再需要的团队。`
    )
  }

  return null
}

/**
 * 解析当前会话身份。优先用扩展加载时捕获的值（宿主在成员会话创建期注入的
 * PI_AGENT_NAME/PI_TEAM_NAME），缺省回落到进程环境变量——oh-my-pi 独立进程模型下
 * 环境变量由 spawn 时设置并全程存在，捕获与回落结果一致。
 */
export function resolveAgentName(captured: string | undefined): string | undefined {
  return captured ?? process.env.PI_AGENT_NAME
}

export function resolveTeamContext(captured: string | undefined): string | undefined {
  return captured ?? process.env.PI_TEAM_NAME
}

export interface TeamEnv {
  teamName: string
  self: string
  host: TeamHost
  lifecycle: TeamLifecycle
  bus: TeamBus
  readTeam(): Promise<TeamFile | null>
  memberNames(): Promise<string[]>
}

export interface TeamRuntime {
  readonly host: TeamHost
  envFor(teamName: string): TeamEnv
  /** 宿主上报成员完成时统一入口：记为回复、通知生命周期、唤醒等待者。 */
  handleFinish(teamName: string, handle: MemberRunHandle, notify: string[]): Promise<void>
  /** 订阅宿主完成事件；返回退订。 */
  subscribeHostFinish(teamName: string): () => void
  /** 当前会话身份（扩展加载时捕获；缺省回落进程环境变量）。 */
  readonly agentName: string | undefined
  /** 当前会话团队上下文（扩展加载时捕获；缺省回落进程环境变量）。 */
  readonly teamName: string | undefined
}

export function createTeamRuntime(
  host: TeamHost,
  identity?: { agentName?: string; teamName?: string },
): TeamRuntime {
  const capturedAgentName = identity?.agentName ?? process.env.PI_AGENT_NAME
  const capturedTeamName = identity?.teamName ?? process.env.PI_TEAM_NAME
  const envCache = new Map<string, TeamEnv>()
  const envFor = (teamName: string): TeamEnv => {
    const cached = envCache.get(teamName)
    if (cached) return cached
    const lifecycle = getLifecycle(teamName, host)
    const env: TeamEnv = {
      teamName,
      self: resolveAgentName(capturedAgentName) || TEAM_LEAD_NAME,
      host,
      lifecycle,
      bus: null as unknown as TeamBus,
      readTeam: () => readTeamFileAsync(teamName),
      memberNames: async () => {
        const team = await readTeamFileAsync(teamName)
        return team ? team.members.map((member) => member.name) : []
      },
    }
    env.bus = getBus(teamName, {
      host: () => host,
      lifecycle: () => ({
        get: (name) => lifecycle.get(name),
        ensureLive: (name) => lifecycle.ensureLive(name),
        markIdle: (name) => lifecycle.markIdle(name),
      }),
      teamName: () => teamName,
      self: () => resolveAgentName(capturedAgentName) || TEAM_LEAD_NAME,
      members: env.memberNames,
    })
    envCache.set(teamName, env)
    return env
  }
  return {
    host,
    envFor,
    agentName: capturedAgentName,
    teamName: capturedTeamName,
    async handleFinish(teamName, handle, notify) {
      const env = envFor(teamName)
      // 把宿主会话 ID 映射回成员名：未答复记录按成员名记，必须用名字回reply。
      let memberName: string | undefined
      for (const name of await env.memberNames()) {
        const entry = await env.lifecycle.get(name)
        if (entry?.sessionId === handle.sessionId) {
          memberName = name
          await env.lifecycle.onRunFinished(name, handle)
          break
        }
      }
      const from = memberName ?? handle.sessionId
      for (const who of notify) {
        if (who && who !== from) env.bus.recordReply(from, who)
      }
      // 被等待的成员完成即唤醒：给正在等它的每个 lead 投一条合成回复。
      const body = handle.result
        ? `成员 ${from} 已完成。\n\n${handle.result}`
        : handle.status === 'failed'
          ? `成员 ${from} 失败：${handle.error ?? '未知错误'}`
          : `成员 ${from} 已结束（${handle.status}）。`
      for (const who of notify) env.bus.deliverSyntheticReply(who, from, body)
      await env.bus.notifyFinished(handle, notify)
    },
    subscribeHostFinish(teamName) {
      return host.onFinish((handle) => {
        void this.handleFinish(teamName, handle, [resolveAgentName(capturedAgentName) || TEAM_LEAD_NAME])
      })
    },
  }
}

/**
 * 团队级操作仅限 team-lead（设计文档 §8.4：worker 不能再 spawn worker）。
 * 当前会话身份存在且不是 team-lead（即成员会话）时返回拒绝消息；身份缺省时放行，
 * 保持宿主未注入身份时的既有行为（graceful degradation）。
 */
function requireTeamLead(runtime: TeamRuntime): string | null {
  const name = resolveAgentName(runtime.agentName)
  if (name && name !== TEAM_LEAD_NAME) {
    return (
      `团队级操作仅限 team-lead：当前身份是 "${name}"。` +
      `需要更多人力请用 team_message 请求 lead。`
    )
  }
  return null
}

async function requireTeam(env: TeamEnv, teamName: string | undefined): Promise<string> {
  const name = teamName || resolveTeamContext(env.teamName)
  if (!name) throw new Error('未指定团队名，且当前会话没有团队上下文（PI_TEAM_NAME）。')
  const team = await readTeamFileAsync(name)
  if (!team) throw new Error(`团队 "${name}" 不存在。`)
  env.teamName = name
  return name
}

/** 解析要操作的团队名：显式参数 > 本会话捕获的团队上下文 > PI_TEAM_NAME；并校验其存在。 */
async function resolveTeamName(teamName: string | undefined, captured?: string | undefined): Promise<string> {
  const name = teamName || resolveTeamContext(captured)
  if (!name) throw new Error('未指定团队名，且当前会话没有团队上下文（PI_TEAM_NAME）。')
  const team = await readTeamFileAsync(name)
  if (!team) throw new Error(`团队 "${name}" 不存在。`)
  return name
}

function formatReceipt(receipt: { to: string; outcome: string; error?: string; targets?: Array<{ to: string; outcome: string }> }): string {
  const label: Record<string, string> = {
    injected: '已投递给正在等待的收件人',
    woken: '已入队，将在合并窗口内唤醒收件人',
    revived: '收件人此前挂起/被杀，已触发复活并入队',
    buffered: '已落盘，等收件人恢复后取用',
    failed: '投递失败',
  }
  if (receipt.targets) {
    const lines = receipt.targets.map((target) => `  - ${target.to}: ${label[target.outcome] ?? target.outcome}`)
    return `广播 ${receipt.to}：${label[receipt.outcome] ?? receipt.outcome}\n${lines.join('\n')}`
  }
  return `${receipt.to}：${label[receipt.outcome] ?? receipt.outcome}${receipt.error ? `（${receipt.error}）` : ''}`
}

/**
 * 把计划成员的 runtime 拼成宿主要求的 provider/modelId 形式。
 * 宿主（subagent-runtime.parseSubagentModel）优先按 provider/modelId 解析；裸 modelId
 * 只在全局唯一时才成功，同名模型存在于多个 provider 时直接抛 "Subagent model is
 * ambiguous"。modelId 本身已带 "/"（已是 provider/model 形式）时原样返回，避免双重前缀。
 */
function spawnModelFromRuntime(runtime: { providerId?: string; modelId?: string }): string | undefined {
  const modelId = runtime.modelId?.trim()
  if (!modelId) return undefined
  return modelId.includes('/') ? modelId : `${runtime.providerId}/${modelId}`
}

// ---------------------------------------------------------------------------
// 工具注册
// ---------------------------------------------------------------------------

export function registerTeamTools(compat: CompatApi, runtime: TeamRuntime): void {
  const host = runtime.host

  // --- team_create -------------------------------------------------------
  compat.registerTool(defineCompatTool({
    name: 'team_create',
    label: '创建团队',
    description:
      '创建一个新的 agent 团队并登记初始成员，随后按默认设置立刻派发成员（spawn）。' +
      '返回每个成员的派发回执。\n\n' +
      '硬性约定（团队协作契约）：\n' +
      '1. 共享文件只能有唯一的 integration owner：任何时刻对同一份共享文件的写入只允许一个成员负责，' +
      '其余成员不得直接改它，只能通过 team_message 请该 owner 代改，避免互相覆盖。\n' +
      '2. 每个任务在实现阶段一律跳过 build/lint/test：成员只写代码与单元级自检，' +
      '全部任务完成前由 team-lead 统一跑一次完整构建与测试。\n' +
      '3. siblings（同级成员）之间只在「解除阻塞」时通信（缺接口、缺数据、需要对方先完成），不做闲聊。',
    parameters: Type.Object({
      team_name: Type.String({ description: '新团队名称' }),
      description: Type.Optional(Type.String({ description: '这个团队在做什么' })),
      spawn: Type.Optional(Type.Boolean({ description: '是否在创建后立刻派发成员（默认 true）' })),
      members: Type.Array(
        Type.Object({
          name: Type.String({ description: '成员名（字母、数字、_ 或 -；"team-lead" 为保留名）' }),
          prompt: Type.String({ description: '给该成员的完整任务指令' }),
          agent_type: Type.Optional(Type.String({ description: 'Agent 类型预设（如 general-purpose）' })),
          model: Type.Optional(Type.String({ description: '可选的 provider/modelId 覆盖' })),
          effort_level: Type.Optional(Type.String({ description: '可选思考级别' })),
        }),
        { description: '初始团队成员' },
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const denial = requireTeamLead(runtime)
      if (denial) return toolErrorResult(denial)
      const now = Date.now()
      const name = params.team_name
      try {
        const existing = await readTeamFileAsync(name)
        if (existing) return toolErrorResult(`团队 "${name}" 已存在；要改成员请用团队计划，或先 team_delete。`)

        const teamFile: TeamFile = {
          name,
          description: params.description,
          createdAt: now,
          leadAgentId: TEAM_LEAD_NAME,
          leadSessionId: process.env.PI_SESSION_ID || 'unknown-session',
          members: [
            { agentId: `lead-${now}`, name: TEAM_LEAD_NAME, joinedAt: now, cwd: process.cwd(), subscriptions: [] },
            ...params.members.map((member, index) => ({
              agentId: `${member.name}-${now}-${index}`,
              name: member.name,
              agentType: member.agent_type || 'general-purpose',
              prompt: member.prompt,
              model: member.model,
              ...(member.effort_level ? { effortLevel: member.effort_level } : {}),
              joinedAt: now,
              cwd: process.cwd(),
              subscriptions: [] as string[],
            })),
          ],
        }
        await writeTeamFileAsync(name, teamFile)

        const env = runtime.envFor(name)
        const spawn = params.spawn !== false
        const lines: string[] = [`团队 "${name}" 已创建，含 ${teamFile.members.length} 名成员（含 team-lead）。`]
        if (!spawn) {
          lines.push('未派发成员（spawn=false）。用 team_plan 提交计划，或在计划获批后派发。')
          return toolTextResult(lines.join('\n'))
        }

        // 上限检查用「其他团队」的活跃数：本团队刚落盘，它自己这次要派的人还没起，
        // 不该被自己算进基数（否则第一次派发就会把自己判超限）。
        const limitError = await checkSpawnLimits(name, params.members.length)
        if (limitError) {
          // 团队本身已创建（成员名册有效），只是没有派发；让调用方决定是缩减还是稍后重试。
          return toolErrorResult(`${limitError}\n团队 "${name}" 已创建但未派发任何成员。`)
        }

        for (const member of params.members) {
          try {
            const handle = await host.start(
              {
                name: member.name,
                profile: member.agent_type || 'general-purpose',
                task: member.prompt,
                description: `${name}/${member.name}`,
                // 成员身份注入：宿主据此在成员会话写入 PI_AGENT_NAME / PI_TEAM_NAME，
                // 并把成员身份写进 system prompt（设计文档 §8.4）。
                teamName: name,
                agentName: member.name,
                ...(member.model ? { model: member.model } : {}),
                ...(member.effort_level ? { thinking: member.effort_level } : {}),
                runInBackground: true,
              },
              ctx as CompatToolContext,
            )
            await env.lifecycle.adopt(member.name, { sessionId: handle.sessionId, sessionFile: handle.sessionFile })
            lines.push(`  - ${member.name}: 已派发（会话 ${handle.sessionId}）`)
          } catch (error) {
            lines.push(`  - ${member.name}: 派发失败（${errorMessage(error)}）`)
          }
        }
        if (signal?.aborted) lines.push('（注意：调用已中止，部分成员可能未派发。）')
        return toolTextResult(lines.join('\n'))
      } catch (error) {
        return toolErrorResult(`创建团队失败：${errorMessage(error)}`)
      }
    },
  }))

  // --- team_plan ---------------------------------------------------------
  compat.registerTool(defineCompatTool({
    name: 'team_plan',
    label: '团队计划',
    description:
      '管理团队计划：get 读取 / submit 提交完整提案等待用户审批 / update 更新字段 / ' +
      'approve 记录用户批准并进入待派发 / launch 派发已批准计划的成员。\n' +
      '计划包含成员（含运行时）与任务依赖图。\n\n' +
      '提交前必须满足：每个任务有且仅有一个 owner；每个成员至少被分到一个任务；任务依赖无环。\n' +
      '契约提醒：任务在实现阶段跳过 build/lint/test，构建与全量测试由 lead 在最后统一跑一次；' +
      '涉及共享文件的任务，其 owner 即该文件的唯一 integration owner。',
    parameters: Type.Object({
      operation: Type.Union([
        Type.Literal('get'),
        Type.Literal('submit'),
        Type.Literal('update'),
        Type.Literal('approve'),
        Type.Literal('launch'),
      ], {
        description: '计划操作：get 读取 / submit 提交审批 / update 更新 / approve 批准 / launch 派发',
      }),
      request_id: Type.Optional(Type.String({
        description: 'approve 必需：本次批准的幂等键。同一个 request_id 重复批准不会二次提交。',
      })),
      team_name: Type.Optional(Type.String({ description: '团队名；缺省用当前团队上下文' })),
      plan: Type.Optional(
        Type.Object({
          members: Type.Optional(Type.Array(Type.Object({
            id: Type.String({ description: '成员 ID（团队内唯一）' }),
            name: Type.String({ description: '成员名' }),
            agent_type: Type.String({ description: 'Agent 类型' }),
            prompt: Type.String({ description: '该成员的任务指令' }),
            provider_id: Type.String({ description: 'provider ID' }),
            model_id: Type.String({ description: 'model ID' }),
            effort_level: Type.Optional(Type.String({ description: '可选思考级别' })),
            reason: Type.Optional(Type.String({ description: '为何选它/该模型' })),
          }))),
          tasks: Type.Optional(Type.Array(Type.Object({
            id: Type.String({ description: '任务 ID（团队内唯一）' }),
            subject: Type.String({ description: '任务标题' }),
            description: Type.Optional(Type.String({ description: '任务详情' })),
            owner_id: Type.Optional(Type.String({ description: '所属成员 ID；提交时必须填写' })),
            dependencies: Type.Optional(Type.Array(Type.String(), { description: '前置任务 ID 列表' })),
          }))),
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const denial = requireTeamLead(runtime)
      if (denial) return toolErrorResult(denial)
      try {
        const teamName = await resolveTeamName(params.team_name, runtime.teamName)
        const sessionId = process.env.PI_SESSION_ID || 'unknown-session'

        if (params.operation === 'get') {
          const plan = await readTeamPlan(teamName)
          if (!plan) return toolTextResult(`团队 "${teamName}" 尚无计划。`)
          return toolTextResult(JSON.stringify({
            state: plan.state,
            revision: plan.revision,
            members: plan.members.map((member) => ({ id: member.id, name: member.name, model: spawnModelFromRuntime(member.runtime) })),
            tasks: plan.tasks,
          }, null, 2))
        }

        const leaderRuntime = {
          providerId: process.env.PI_PROVIDER_ID || 'unknown',
          modelId: process.env.PI_MODEL_ID || 'unknown',
        }
        const toMembers = (members: NonNullable<NonNullable<typeof params.plan>['members']>) =>
          members.map((member) => ({
            id: member.id,
            name: member.name,
            agentType: member.agent_type,
            prompt: member.prompt,
            runtime: { providerId: member.provider_id, modelId: member.model_id, ...(member.effort_level ? { effortLevel: member.effort_level } : {}) },
            reason: member.reason,
          }))
        const toTasks = (tasks: NonNullable<NonNullable<typeof params.plan>['tasks']>) =>
          tasks.map((task) => ({
            id: task.id,
            subject: task.subject,
            description: task.description,
            ownerId: task.owner_id,
            dependencies: task.dependencies || [],
          }))

        if (params.operation === 'submit') {
          const draft = await ensureTeamDraft(teamName, sessionId, leaderRuntime)
          const next = await submitTeamPlan(
            teamName,
            { planId: draft.planId, sessionId, incarnationId: draft.incarnationId, expectedRevision: draft.revision },
            { members: toMembers(params.plan?.members || []), tasks: toTasks(params.plan?.tasks || []) },
          )
          return toolTextResult(`计划已提交审批（revision ${next.revision}，state ${next.state}）。请在团队面板中等待用户批准。`)
        }

        // --- approve：记录用户批准，state → launching、launch.status → pending ---
        if (params.operation === 'approve') {
          const guard = requireTeamLead(runtime)
          if (guard) return toolErrorResult(guard)
          const requestId = params.request_id?.trim()
          if (!requestId) return toolErrorResult('approve 需要 request_id（幂等键）。')
          const current = await readTeamPlan(teamName)
          if (!current) return toolErrorResult(`团队 "${teamName}" 尚无计划；请先 submit。`)
          const { plan: next, committed } = await approveTeamPlan(
            teamName,
            { planId: current.planId, sessionId: current.sessionId, incarnationId: current.incarnationId, expectedRevision: current.revision },
            requestId,
            current,
          )
          if (!committed) {
            return toolTextResult(`该批准已记录过（request_id ${requestId}），未重复提交。当前 state ${next.state}，launch ${next.launch?.status ?? '无'}。`)
          }
          return toolTextResult(
            `计划已批准（revision ${next.revision}，state ${next.state}，launch ${next.launch?.status}）。` +
            `用 team_plan { operation: "launch" } 派发这 ${next.approvedSnapshot?.members.length ?? 0} 名成员。`,
          )
        }

        // --- launch：认领待执行的计划并真正派发成员（Phase 4 步骤 5）---
        if (params.operation === 'launch') {
          const guard = requireTeamLead(runtime)
          if (guard) return toolErrorResult(guard)
          const claimed = await claimPlanLaunch(teamName)
          if (!claimed) {
            const existing = await readTeamPlan(teamName)
            const state = existing?.state ?? '无计划'
            const status = existing?.launch?.status ?? '无'
            return toolTextResult(
              `没有待派发的计划（state ${state}，launch ${status}）。` +
              `可能已经派发过，或计划还没被 approve。`,
            )
          }

          const { members } = claimed
          const limitError = await checkSpawnLimits(teamName, members.length)
          if (limitError) {
            await failPlanLaunch(teamName, limitError)
            return toolErrorResult(`${limitError}\n计划已标记 launch_failed。`)
          }

          const memberIds: Record<string, string> = {}
          const lines: string[] = [`开始派发计划成员（共 ${members.length} 名）：`]
          for (const member of members) {
            try {
              const spawnModel = spawnModelFromRuntime(member.runtime)
              const handle = await host.start(
                {
                  name: member.name,
                  profile: member.agentType || 'general-purpose',
                  task: member.prompt,
                  description: `${teamName}/${member.name}`,
                  ...(spawnModel ? { model: spawnModel } : {}),
                  ...(member.runtime?.effortLevel ? { thinking: member.runtime.effortLevel } : {}),
                  // 成员身份注入（设计文档 §8.4）：宿主据此让成员知道自己不是 lead。
                  teamName,
                  agentName: member.name,
                  runInBackground: true,
                },
                ctx as CompatToolContext,
              )
              memberIds[member.name] = handle.sessionId
              try {
                await runtime.envFor(teamName).lifecycle.adopt(member.name, {
                  sessionId: handle.sessionId,
                  sessionFile: handle.sessionFile,
                })
              } catch {
                // 登记失败不影响成员已经跑起来；下面照常报告派发成功。
              }
              lines.push(`  - ${member.name}: 已派发（会话 ${handle.sessionId}）`)
            } catch (error) {
              lines.push(`  - ${member.name}: 派发失败（${errorMessage(error)}）`)
            }
          }

          const ok = Object.keys(memberIds).length
          if (ok === 0) {
            await failPlanLaunch(teamName, '所有成员都派发失败')
            return toolErrorResult(`${lines.join('\n')}\n计划已标记 launch_failed。`)
          }
          const next = await completePlanLaunch(teamName, memberIds)
          lines.push(`派发完成：${ok}/${members.length} 成功，计划 state ${next?.state ?? 'running'}。`)
          return toolTextResult(lines.join('\n'))
        }

        const plan = await readTeamPlan(teamName)
        if (!plan) return toolErrorResult(`团队 "${teamName}" 尚无计划；请先 submit。`)
        const patch: Record<string, unknown> = {}
        if (params.plan?.members) patch.members = toMembers(params.plan.members)
        if (params.plan?.tasks) patch.tasks = toTasks(params.plan.tasks)
        const next = await replaceTeamPlan(
          teamName,
          { planId: plan.planId, sessionId, incarnationId: plan.incarnationId, expectedRevision: plan.revision },
          patch,
        )
        return toolTextResult(`计划已更新（revision ${next.revision}，state ${next.state}）。`)
      } catch (error) {
        if (error instanceof TeamPlanError) return toolErrorResult(error.message)
        return toolErrorResult(`team_plan 失败：${errorMessage(error)}`)
      }
    },
  }))

  // --- team_delete -------------------------------------------------------
  compat.registerTool(defineCompatTool({
    name: 'team_delete',
    label: '删除团队',
    description:
      '删除团队及其全部数据（配置、计划、邮箱、生命周期）。不可恢复。除非用户明确要求删除，调用前先向用户确认。',
    parameters: Type.Object({
      team_name: Type.Optional(Type.String({ description: '团队名；缺省用当前团队上下文' })),
    }),
    async execute(_id, params) {
      const denial = requireTeamLead(runtime)
      if (denial) return toolErrorResult(denial)
      try {
        const name = params.team_name || resolveTeamContext(runtime.teamName)
        if (!name) throw new Error('未指定团队名，且当前会话没有团队上下文。')
        const team = await readTeamFileAsync(name)
        if (!team) return toolErrorResult(`团队 "${name}" 不存在。`)
        dropBus(name)
        dropLifecycle(name)
        await deleteTeamDir(name)
        return toolTextResult(`团队 "${name}" 已删除。`)
      } catch (error) {
        return toolErrorResult(`删除团队失败：${errorMessage(error)}`)
      }
    },
  }))

  // --- team_message ------------------------------------------------------
  compat.registerTool(defineCompatTool({
    name: 'team_message',
    label: '发送消息',
    description:
      '按名字给成员发消息，或用 "*" 广播。返回**投递回执**（已注入给正在等待的收件人 / 已入队并将在合并窗口内唤醒 / 触发复活 / 落盘待取 / 失败）。\n\n' +
      '同一 recipient 在短时间内的多条消息会合并成一次派发（静默窗口约 2 秒），因此连发多条不会被重复唤醒。\n' +
      '用于分配工作、共享上下文或回复成员。siblings 之间只在解阻塞时通信：缺接口、缺数据、需要对方先完成——不做闲聊、不广播进度噪声。',
    parameters: Type.Object({
      recipient: Type.String({ description: '成员名，或 "*" 表示全体成员' }),
      message: Type.String({ description: '消息内容' }),
      summary: Type.Optional(Type.String({ description: '5-10 字的短摘要，显示在预览里' })),
      team_name: Type.Optional(Type.String({ description: '团队名；缺省用当前团队上下文' })),
    }),
    async execute(_id, params) {
      try {
        const name = params.team_name || resolveTeamContext(runtime.teamName)
        if (!name) throw new Error('未指定团队名，且当前会话没有团队上下文。')
        const team = await readTeamFileAsync(name)
        if (!team) return toolErrorResult(`团队 "${name}" 不存在。`)
        const from = resolveAgentName(runtime.agentName) || TEAM_LEAD_NAME
        const env = runtime.envFor(name)

        if (params.recipient !== '*') {
          const member = team.members.find((entry) => entry.name === params.recipient)
          if (!member) return toolErrorResult(`${params.recipient}：不是该团队成员。`)
        }
        const receipt = await env.bus.send({
          from,
          to: params.recipient,
          body: params.message,
          ...(params.summary ? { summary: params.summary } : {}),
        })
        return toolTextResult(formatReceipt(receipt))
      } catch (error) {
        return toolErrorResult(`team_message 失败：${errorMessage(error)}`)
      }
    },
  }))

  // --- team_status -------------------------------------------------------
  compat.registerTool(defineCompatTool({
    name: 'team_status',
    label: '团队状态',
    description:
      '查看团队当前状态：成员及其生命周期状态（idle/running/parked/aborted）、计划状态与任务、以及欠我回复的成员。用于不轮询地掌握全局。',
    parameters: Type.Object({
      team_name: Type.Optional(Type.String({ description: '团队名；缺省用当前团队上下文' })),
    }),
    async execute(_id, params) {
      try {
        const name = params.team_name || resolveTeamContext(runtime.teamName)
        const names = name ? [name] : await listTeamNames()
        if (names.length === 0) return toolTextResult('暂无团队。用 team_create 创建一个。')
        const self = resolveAgentName(runtime.agentName) || TEAM_LEAD_NAME
        const lines: string[] = []
        for (const teamName of names) {
          const team = await readTeamFileAsync(teamName)
          if (!team) continue
          lines.push(`团队：${teamName}${team.description ? ` — ${team.description}` : ''}`)
          const env = runtime.envFor(teamName)
          const lifecycle = await env.lifecycle.list()
          for (const member of team.members) {
            const entry = lifecycle.find((item) => item.name === member.name)
            const state = member.name === TEAM_LEAD_NAME ? '(lead)' : entry ? entry.status : '未登记'
            const session = entry?.sessionId ? ` session=${entry.sessionId}` : ''
            lines.push(`  - ${member.name} [${member.agentType || 'general-purpose'}] ${state}${session}`)
          }
          const plan = await readTeamPlan(teamName).catch(() => null)
          if (plan) {
            lines.push(`  计划：${plan.state}（revision ${plan.revision}）`)
            for (const task of plan.tasks) {
              lines.push(`    [${task.id}] ${task.subject} → ${task.ownerId || '(未分配)'}${task.dependencies.length ? `（依赖：${task.dependencies.join(', ')}）` : ''}`)
            }
          }
          const owing = env.bus.unansweredSends(self, 0)
          if (owing.length > 0) lines.push(`  欠我回复：${owing.map((item) => item.to).join(', ')}`)
          lines.push('')
        }
        return toolTextResult(lines.join('\n').trim())
      } catch (error) {
        return toolErrorResult(`team_status 失败：${errorMessage(error)}`)
      }
    },
  }))

  // --- team_wait ---------------------------------------------------------
  compat.registerTool(defineCompatTool({
    name: 'team_wait',
    label: '等待回复',
    description:
      '阻塞等待一条回复，不轮询：调用时挂起当前回合，消息到达（或被等待的成员完成）时立即唤醒。\n' +
      '指定 recipient 时只等它；不指定时「只等欠我回复的人」——仅等待我直接发过消息、且尚未答复的成员。\n' +
      '超时返回 null 语义的空结果。返回的消息是对方来信本身。',
    parameters: Type.Object({
      recipient: Type.Optional(Type.String({ description: '只等这个成员；缺省时只等欠我回复的人' })),
      timeout_ms: Type.Optional(Type.Number({ description: '超时毫秒数（默认 120000；<=0 表示一直等）' })),
      team_name: Type.Optional(Type.String({ description: '团队名；缺省用当前团队上下文' })),
    }),
    async execute(_id, params, signal) {
      try {
        const name = params.team_name || resolveTeamContext(runtime.teamName)
        if (!name) throw new Error('未指定团队名，且当前会话没有团队上下文。')
        const team = await readTeamFileAsync(name)
        if (!team) return toolErrorResult(`团队 "${name}" 不存在。`)
        const env = runtime.envFor(name)
        const self = resolveAgentName(runtime.agentName) || TEAM_LEAD_NAME
        const timeout = params.timeout_ms === undefined ? 120_000 : params.timeout_ms

        let filter: { from?: string; directOnly?: boolean; repliesFrom?: string[] }
        if (params.recipient) {
          filter = { from: params.recipient }
        } else {
          const owing = env.bus.unansweredSends(self, 0).map((item) => item.to)
          if (owing.length === 0) return toolTextResult('当前没有欠我回复的成员（我最近没有直接向谁提问，或他们都已答复）。')
          filter = { directOnly: true, repliesFrom: owing }
        }

        const message = await env.bus.wait(self, filter, timeout, signal)
        if (!message) return toolTextResult(`等待超时（${timeout}ms），尚未收到期待的回复。`)
        return toolTextResult(`来自 ${message.from} 的回复：\n${message.body}`)
      } catch (error) {
        return toolErrorResult(`team_wait 失败：${errorMessage(error)}`)
      }
    },
  }))

  // --- team_result -------------------------------------------------------
  compat.registerTool(defineCompatTool({
    name: 'team_result',
    label: '获取成员结果',
    description:
      '读取某个成员的最新运行结果。默认立即返回当前状态；wait=true 时通过宿主的「完成订阅」阻塞等待其结束（不轮询），结束时被唤醒。',
    parameters: Type.Object({
      member: Type.String({ description: '成员名或会话 ID' }),
      wait: Type.Optional(Type.Boolean({ description: '是否阻塞等待到该成员结束（默认 false）' })),
      timeout_ms: Type.Optional(Type.Number({ description: 'wait 的超时毫秒数（默认 300000）' })),
      team_name: Type.Optional(Type.String({ description: '团队名；缺省用当前团队上下文' })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      try {
        const name = params.team_name || resolveTeamContext(runtime.teamName)
        if (!name) throw new Error('未指定团队名，且当前会话没有团队上下文。')
        const env = runtime.envFor(name)
        const team = await readTeamFileAsync(name)
        const member = team?.members.find((entry) => entry.name === params.member)
        const entry = member ? await env.lifecycle.get(member.name) : undefined
        const sessionId = entry?.sessionId ?? params.member

        const handle = await host.get(sessionId, ctx as CompatToolContext)
        if (!params.wait) {
          if (!handle) return toolTextResult(`成员 ${params.member}：暂无运行记录（会话 ${sessionId}）。`)
          return toolTextResult(renderHandle(handle))
        }

        const timeout = params.timeout_ms === undefined ? 300_000 : params.timeout_ms
        const finished = await waitForFinish(host, sessionId, timeout, signal)
        if (!finished) return toolTextResult(`成员 ${params.member}：等待超时（${timeout}ms）。`)
        return toolTextResult(renderHandle(finished))
      } catch (error) {
        return toolErrorResult(`team_result 失败：${errorMessage(error)}`)
      }
    },
  }))

  // --- team_accept -------------------------------------------------------
  compat.registerTool(defineCompatTool({
    name: 'team_accept',
    label: '验收结果',
    description:
      '确认验收某成员的产出：读取其最新结果，记为已答复（避免重复通知），并把验收记录追加到团队的 accepted 账本。用于 lead 逐条收口。',
    parameters: Type.Object({
      member: Type.String({ description: '成员名' }),
      summary: Type.Optional(Type.String({ description: '验收结论（可选）' })),
      team_name: Type.Optional(Type.String({ description: '团队名；缺省用当前团队上下文' })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const name = params.team_name || resolveTeamContext(runtime.teamName)
        if (!name) throw new Error('未指定团队名，且当前会话没有团队上下文。')
        const env = runtime.envFor(name)
        const entry = await env.lifecycle.get(params.member)
        const sessionId = entry?.sessionId ?? params.member
        const handle = await host.get(sessionId, ctx as CompatToolContext)
        const self = resolveAgentName(runtime.agentName) || TEAM_LEAD_NAME
        // 记为该成员对我（当前 agent）的回复，之后不再重复唤醒。
        env.bus.recordReply(params.member, self)
        await appendAccepted(name, {
          member: params.member,
          sessionId,
          summary: params.summary,
          result: handle?.result,
          at: new Date().toISOString(),
        })
        const text = handle?.result ? `\n产出：\n${handle.result}` : ''
        return toolTextResult(`已验收成员 ${params.member}。${params.summary ? `结论：${params.summary}` : ''}${text}`)
      } catch (error) {
        return toolErrorResult(`team_accept 失败：${errorMessage(error)}`)
      }
    },
  }))

  // --- team_cancel -------------------------------------------------------
  compat.registerTool(defineCompatTool({
    name: 'team_cancel',
    label: '取消成员',
    description:
      '终止某成员的运行并保留其会话文件（tombstone），日后可用 team_message 触发复活。用于成员卡死或任务作废。',
    parameters: Type.Object({
      member: Type.String({ description: '成员名' }),
      reason: Type.Optional(Type.String({ description: '取消原因' })),
      team_name: Type.Optional(Type.String({ description: '团队名；缺省用当前团队上下文' })),
    }),
    async execute(_id, params) {
      try {
        const name = params.team_name || resolveTeamContext(runtime.teamName)
        if (!name) throw new Error('未指定团队名，且当前会话没有团队上下文。')
        const env = runtime.envFor(name)
        const entry = await env.lifecycle.get(params.member)
        await env.lifecycle.release(params.member, { tombstone: true })
        const sessionId = entry?.sessionId
        if (sessionId) {
          try {
            await host.stop(sessionId)
          } catch (error) {
            if (process.env.PI_TEAM_DEBUG) console.error(`[pi-team] stop ${sessionId}: ${error}`)
          }
        }
        return toolTextResult(`成员 ${params.member} 已取消${params.reason ? `（${params.reason}）` : ''}；会话已保留，可用 team_message 触发复活。`)
      } catch (error) {
        return toolErrorResult(`team_cancel 失败：${errorMessage(error)}`)
      }
    },
  }))

  // --- team_list ---------------------------------------------------------
  compat.registerTool(defineCompatTool({
    name: 'team_list',
    label: '列出团队',
    description: '列出本机所有团队及其成员数、计划状态。',
    parameters: Type.Object({}),
    async execute() {
      try {
        const names = await listTeamNames()
        if (names.length === 0) return toolTextResult('暂无团队。')
        const lines: string[] = []
        for (const teamName of names) {
          const team = await readTeamFileAsync(teamName)
          if (!team) continue
          const plan = await readTeamPlan(teamName).catch(() => null)
          lines.push(`- ${teamName}：${team.members.length} 名成员${plan ? `，计划 ${plan.state}` : '，无计划'}`)
        }
        return toolTextResult(lines.join('\n'))
      } catch (error) {
        return toolErrorResult(`team_list 失败：${errorMessage(error)}`)
      }
    },
  }))

  // --- team_ticket -------------------------------------------------------
  // 工单三段式（设计文档 §10 Phase 4 步骤 1–3）。新增工具而非改 team_message 的语义，
  // 保持既有 10 个工具的入参与返回格式不变。
  compat.registerTool(defineCompatTool({
    name: 'team_ticket',
    label: '工单',
    description:
      '管理工单（Ticket / Mandate / Assignment 三段式）。\n\n' +
      'operation:\n' +
      '  create   建工单，可选 mandate（不可变授权）与 assignees（初始派活）\n' +
      '  list     列出本团队工单（含状态与 assignment 汇总）\n' +
      '  show     看单个工单详情（mandates / assignments / 订阅者 / 讨论帖）\n' +
      '  mandate  追加一条不可变 Mandate；要变更用法是新建 + 用 revokes 撤销旧的\n' +
      '  assign   给工单派新活（同一工单可多个 assignment，状态各自独立）\n' +
      '  progress 推进 assignment：status=running|ended，ended 可带 outcome 与 result\n' +
      '  end      结束工单（open → ended）\n' +
      '  subscribe 设置订阅者：工单上的后续讨论会扇出给他们\n' +
      '  post     在工单讨论帖发言，并按订阅关系扇出（走团队邮箱投递）\n' +
      '  ack      对某条消息回执已读；unacked 查询还没确认的\n\n' +
      'Mandate 不可变是这个模型的核心：历史授权只能被撤销，不能被改写。',
    parameters: Type.Object({
      operation: Type.Union([
        Type.Literal('create'),
        Type.Literal('list'),
        Type.Literal('show'),
        Type.Literal('mandate'),
        Type.Literal('assign'),
        Type.Literal('progress'),
        Type.Literal('end'),
        Type.Literal('subscribe'),
        Type.Literal('post'),
        Type.Literal('ack'),
        Type.Literal('unacked'),
      ], { description: '操作类型' }),
      team_name: Type.Optional(Type.String({ description: '团队名；缺省用当前团队上下文' })),
      ticket_id: Type.Optional(Type.String({ description: 'create 以外的操作必需' })),
      subject: Type.Optional(Type.String({ description: 'create：工单标题' })),
      description: Type.Optional(Type.String({ description: 'create：工单描述' })),
      mandate: Type.Optional(Type.String({ description: 'create/mandate：授权内容' })),
      revokes: Type.Optional(Type.String({ description: 'mandate：要撤销的旧 mandate id' })),
      assignees: Type.Optional(Type.Array(Type.String(), { description: 'create：初始承接者名字' })),
      assignee: Type.Optional(Type.String({ description: 'assign：承接者名字' })),
      assignment_id: Type.Optional(Type.String({ description: 'progress：assignment id' })),
      status: Type.Optional(Type.String({ description: 'progress：running | ended' })),
      outcome: Type.Optional(Type.String({ description: 'progress：completed | failed | cancelled' })),
      result: Type.Optional(Type.String({ description: 'progress：结果摘要' })),
      subscribers: Type.Optional(Type.Array(Type.String(), { description: 'subscribe：订阅者名字列表' })),
      text: Type.Optional(Type.String({ description: 'post：讨论内容' })),
      message_id: Type.Optional(Type.String({ description: 'ack：被确认的消息 id' })),
      expected: Type.Optional(Type.Array(
        Type.Object({
          message_id: Type.String({ description: '消息 id' }),
          readers: Type.Array(Type.String(), { description: '应确认的人' }),
        }),
        { description: 'unacked：期望被确认的消息与读者' },
      )),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const name = params.team_name || resolveTeamContext(runtime.teamName)
        if (!name) return toolErrorResult('未指定团队名，且当前会话没有团队上下文。')
        const team = await readTeamFileAsync(name)
        if (!team) return toolErrorResult(`团队 "${name}" 不存在。`)
        const self = resolveAgentName(runtime.agentName) || TEAM_LEAD_NAME

        const ticketId = params.ticket_id?.trim()
        const needTicket = (): string => {
          if (!ticketId) throw new Error(`${params.operation} 需要 ticket_id。`)
          return ticketId
        }

        switch (params.operation) {
          case 'create': {
            if (!params.subject?.trim()) return toolErrorResult('create 需要 subject。')
            const ticket = await tickets.createTicket({
              teamName: name,
              subject: params.subject,
              ...(params.description ? { description: params.description } : {}),
              createdBy: self,
              ...(params.mandate ? { mandateStatement: params.mandate } : {}),
              assignees: (params.assignees ?? []).map((assignee) => ({ assignee })),
            })
            return toolTextResult(
              `工单已创建：${ticket.id}\n标题：${ticket.subject}\n` +
              `mandates ${ticket.mandates.length} 条，assignments ${ticket.assignments.length} 个。`,
            )
          }

          case 'list': {
            const all = await tickets.listTickets(name)
            if (all.length === 0) return toolTextResult('本团队暂无工单。')
            const lines = all.map((ticket) => {
              const running = ticket.assignments.filter((assignment) => assignment.status === 'running').length
              const ended = ticket.assignments.filter((assignment) => assignment.status === 'ended').length
              return `- ${ticket.id} [${ticket.status}] ${ticket.subject} — assignments ${ticket.assignments.length}（running ${running} / ended ${ended}），订阅 ${ticket.subscribers.length}`
            })
            return toolTextResult(lines.join('\n'))
          }

          case 'show': {
            const ticket = await tickets.readTicket(name, needTicket())
            if (!ticket) return toolErrorResult(`工单 ${ticketId} 不存在。`)
            return toolTextResult(JSON.stringify({
              id: ticket.id,
              subject: ticket.subject,
              status: ticket.status,
              mandates: ticket.mandates,
              assignments: ticket.assignments,
              subscribers: ticket.subscribers,
              thread: ticket.thread,
            }, null, 2))
          }

          case 'mandate': {
            if (!params.mandate?.trim()) return toolErrorResult('mandate 需要 mandate 内容。')
            const { ticket, mandate } = await tickets.addMandate(name, needTicket(), {
              statement: params.mandate,
              issuedBy: self,
              ...(params.revokes ? { revokes: params.revokes } : {}),
            })
            return toolTextResult(
              `已追加 Mandate ${mandate.id}${params.revokes ? `（并撤销 ${params.revokes}）` : ''}。` +
              `当前 ${ticket.mandates.length} 条。`,
            )
          }

          case 'assign': {
            if (!params.assignee?.trim()) return toolErrorResult('assign 需要 assignee。')
            const { ticket, assignment } = await tickets.addAssignment(name, needTicket(), { assignee: params.assignee })
            return toolTextResult(`已派活：${assignment.id} → ${assignment.assignee}（pending）。工单现有 ${ticket.assignments.length} 个 assignment。`)
          }

          case 'progress': {
            if (!params.assignment_id?.trim()) return toolErrorResult('progress 需要 assignment_id。')
            const status = params.status?.trim()
            if (status !== 'running' && status !== 'ended') return toolErrorResult('progress 的 status 必须是 running 或 ended。')
            const outcome = params.outcome?.trim()
            if (outcome && !['completed', 'failed', 'cancelled'].includes(outcome)) {
              return toolErrorResult('outcome 必须是 completed / failed / cancelled。')
            }
            const { assignment } = await tickets.setAssignmentStatus(name, needTicket(), params.assignment_id, {
              status,
              ...(params.result !== undefined ? { result: params.result } : {}),
              ...(outcome ? { outcome: outcome as 'completed' | 'failed' | 'cancelled' } : {}),
            })
            return toolTextResult(`Assignment ${assignment.id} → ${assignment.status}${assignment.outcome ? `（${assignment.outcome}）` : ''}。`)
          }

          case 'end': {
            const ticket = await tickets.endTicket(name, needTicket())
            return toolTextResult(`工单 ${ticket.id} 已结束（ended）。`)
          }

          case 'subscribe': {
            const ticket = await tickets.setSubscribers(name, needTicket(), params.subscribers ?? [])
            const unknown = ticket.subscribers.filter((subscriber) => !team.members.some((member) => member.name === subscriber))
            return toolTextResult(
              `订阅者已设为：${ticket.subscribers.join('、') || '（空）'}。` +
              (unknown.length ? `\n注意：${unknown.join('、')} 不是该团队成员。` : ''),
            )
          }

          case 'post': {
            if (!params.text?.trim()) return toolErrorResult('post 需要 text。')
            const { ticket, fanout } = await tickets.postToThread(name, needTicket(), { from: self, text: params.text })
            const env = runtime.envFor(name)
            const receipts: string[] = []
            for (const recipient of fanout) {
              const receipt = await env.bus.send({
                from: self,
                to: recipient,
                body: `[工单 ${ticket.id}] ${params.text}`,
                summary: ticket.subject,
              })
              receipts.push(`  - ${recipient}: ${receipt.outcome}`)
            }
            return toolTextResult(
              `已记入工单 ${ticket.id} 的讨论帖。` +
              (fanout.length ? `\n扇出给 ${fanout.length} 名订阅者：\n${receipts.join('\n')}` : '\n（无订阅者，未扇出。）'),
            )
          }

          case 'ack': {
            if (!params.message_id?.trim()) return toolErrorResult('ack 需要 message_id。')
            const receipt = await tickets.recordAck(name, params.message_id, self)
            return toolTextResult(`已回执：${receipt.messageId} 被 ${receipt.reader} 于 ${new Date(receipt.ackedAt).toISOString()} 确认。`)
          }

          case 'unacked': {
            const expected = (params.expected ?? []).map((entry) => ({ messageId: entry.message_id, readers: entry.readers }))
            if (expected.length === 0) return toolTextResult('未提供 expected；无需检查。')
            const missing = await tickets.listUnacked(name, expected)
            if (missing.length === 0) return toolTextResult('全部已确认。')
            return toolTextResult(
              `还有 ${missing.length} 条未确认：\n` +
              missing.map((entry) => `  - ${entry.messageId} ← ${entry.reader}`).join('\n'),
            )
          }

          default:
            return toolErrorResult(`未知 operation：${String(params.operation)}`)
        }
      } catch (error) {
        return toolErrorResult(`team_ticket 失败：${errorMessage(error)}`)
      }
    },
  }))
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

function renderHandle(handle: MemberRunHandle): string {
  const parts = [`成员会话 ${handle.sessionId}：${handle.status}`]
  if (handle.result) parts.push(`产出：\n${handle.result}`)
  if (handle.error) parts.push(`错误：${handle.error}`)
  return parts.join('\n')
}

/** 通过宿主完成订阅等待某会话结束（不轮询）。返回 undefined 表示超时。 */
function waitForFinish(
  host: TeamHost,
  sessionId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<MemberRunHandle | undefined> {
  return new Promise((resolve) => {
    let settled = false
    let timer: NodeJS.Timeout | undefined
    let unsubscribe: () => void = () => {}
    const onAbort = () => finish(undefined)
    const finish = (value: MemberRunHandle | undefined) => {
      if (settled) return
      settled = true
      unsubscribe()
      if (timer) clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
      resolve(value)
    }
    unsubscribe = host.onFinish((handle) => {
      if (handle.sessionId === sessionId) finish(handle)
    })
    if (timeoutMs > 0) {
      timer = setTimeout(() => finish(undefined), timeoutMs)
      timer.unref?.()
    }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

async function appendAccepted(teamName: string, record: Record<string, unknown>): Promise<void> {
  const { appendFile, mkdir } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { getTeamDir } = await import('./teamHelpers.js')
  await mkdir(getTeamDir(teamName), { recursive: true })
  await appendFile(join(getTeamDir(teamName), 'accepted.jsonl'), `${JSON.stringify(record)}\n`, 'utf-8')
}
