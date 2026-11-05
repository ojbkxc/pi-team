/**
 * pi-team 跨端扩展冒烟测试（不装真实 SDK，不真派发子进程）。
 *
 * 覆盖验收点：
 *  - 工具已注册且描述为中文、不含 pi-web 专属字段；
 *  - team_create 经宿主桥 spawn 成员并登记生命周期；
 *  - team_message 返回回执（injected / woken / revived / buffered / failed）；
 *  - team_wait 不轮询：投递即唤醒；被等待成员完成时经完成订阅唤醒；
 *  - idle → parked → revived 生命周期 + generation CAS。
 */
import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 先把团队目录指到临时目录，必须在动态 import 扩展之前设置。
const TEAM_DIR = mkdtempSync(join(tmpdir(), 'pi-team-test-'))
process.env.PI_TEAM_DIR = TEAM_DIR
process.env.PI_TEAM_IDLE_TTL_MS = '80'
process.env.PI_TEAM_DEBUG = '0'

const { default: piTeamExtension, setInjectedHost } = await import('../dist/index.js')

/** 最小 mock 宿主：只实现公共子集。 */
function createMockPi() {
  const tools = new Map()
  const commands = new Map()
  const handlers = new Map()
  const entries = []
  const messages = []
  const logs = []
  const context = {
    cwd: process.cwd(),
    mode: 'rpc',
    hasUI: false,
    signal: undefined,
    isIdle: () => true,
    abort() {},
    ui: { notify(message, type) { logs.push({ message, type }) } },
  }
  const pi = {
    registerTool(tool) {
      tools.set(tool.name, tool)
    },
    registerCommand(name, options) {
      commands.set(name, { name, ...options })
    },
    on(event, handler) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => handlers.set(event, (handlers.get(event) ?? []).filter((h) => h !== handler))
    },
    appendEntry(customType, data) {
      entries.push({ customType, data })
    },
    getAllTools() {
      return [...tools.values()].map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters, sourceInfo: { path: '<mock>', source: 'extension' } }))
    },
    async exec(command, args) {
      return { stdout: `${command} ${args.join(' ')}`.trim(), stderr: '', code: 0 }
    },
    sendMessage(message, options) {
      messages.push({ message, options })
    },
  }
  return { pi, tools, commands, entries, messages, logs, context }
}

/** 内存宿主桥：记录 spawn/revive/wake，并可手动触发完成事件。 */
function createMemoryHost() {
  let counter = 0
  const finishListeners = new Set()
  const spawned = []
  const revived = []
  const stopped = []
  const woken = []
  const runs = new Map()
  const host = {
    kind: 'subagent',
    async start(request) {
      counter += 1
      const sessionId = `sess-${counter}-${request.name}`
      const handle = { sessionId, sessionFile: `/tmp/${sessionId}.jsonl`, status: 'running', description: request.description }
      runs.set(sessionId, handle)
      spawned.push({ request, handle })
      return handle
    },
    async revive(request) {
      revived.push(request)
      const handle = { sessionId: request.sessionId, sessionFile: request.sessionFile, status: 'revived', description: request.description }
      runs.set(handle.sessionId, handle)
      return handle
    },
    async get(sessionId) {
      return runs.get(sessionId) ?? null
    },
    async steer() {},
    async stop(sessionId) {
      stopped.push(sessionId)
      runs.set(sessionId, { ...(runs.get(sessionId) ?? { sessionId }), status: 'aborted' })
    },
    async wake(request) {
      woken.push(request)
      return true
    },
    onFinish(listener) {
      finishListeners.add(listener)
      return () => finishListeners.delete(listener)
    },
  }
  return {
    host,
    spawned,
    revived,
    stopped,
    woken,
    runs,
    complete(handle) {
      for (const listener of finishListeners) listener(handle)
    },
  }
}

async function callTool(tools, name, params, ctx = {}) {
  const tool = tools.get(name)
  assert.ok(tool, `工具 ${name} 应已注册`)
  return tool.execute(`call-${name}`, params, undefined, undefined, { cwd: process.cwd(), ...ctx })
}

function textOf(result) {
  return (result.content ?? []).map((block) => block.text ?? '').join('')
}

let memory
let mock

beforeEach(() => {
  for (const entry of Object.keys(globalThis)) {
    if (entry.startsWith('__piTeam')) delete globalThis[entry]
  }
  process.env.PI_TEAM_IDLE_TTL_MS = '80'
  process.env.PI_TEAM_NAME = 'default'
  delete process.env.PI_AGENT_NAME
  memory = createMemoryHost()
  mock = createMockPi()
  setInjectedHost(memory.host)
  piTeamExtension(mock.pi)
})

after(() => {
  rmSync(TEAM_DIR, { recursive: true, force: true })
})

test('4 个 /team* 命令已注册且描述为中文', async () => {
  const names = [...mock.commands.keys()].sort()
  assert.deepEqual(names, ['team', 'team-create', 'team-plan', 'team-status'])
  for (const command of mock.commands.values()) {
    assert.match(command.description, /[\u4e00-\u9fa5]/, `${command.name} 描述应为中文`)
    assert.equal(typeof command.handler, 'function')
  }
  // 参数补全为同步返回（跨端要求）
  const completion = mock.commands.get('team').getArgumentCompletions
  assert.equal(typeof completion, 'function')
  assert.ok(completion('x') === null || Array.isArray(completion('x')))
})

test('/team 命令触发 notify 且不抛错', async () => {
  await callTool(mock.tools, 'team_create', { team_name: 'cmd-team', members: [{ name: 'w', prompt: 'x' }] })
  const command = mock.commands.get('team')
  await command.handler('cmd-team', mock.context)
  assert.ok(mock.logs.some((entry) => /cmd-team/.test(entry.message)), '应通知团队状态')
  assert.equal(mock.logs.at(-1).type, 'info')
})

test('工具已注册，描述为中文且不含 pi-web 专属字段', () => {
  const names = [...mock.tools.keys()].sort()
  assert.deepEqual(names, [
    'team_accept', 'team_cancel', 'team_create', 'team_delete', 'team_list',
    'team_message', 'team_plan', 'team_result', 'team_status', 'team_ticket', 'team_wait',
  ])
  for (const tool of mock.tools.values()) {
    assert.match(tool.description, /[\u4e00-\u9fa5]/, `${tool.name} 描述应为中文`)
    for (const forbidden of ['promptSnippet', 'promptGuidelines', 'exposure', 'executionMode', 'namespace', 'annotations']) {
      assert.ok(!(forbidden in tool), `${tool.name} 不应含 pi-web 专属字段 ${forbidden}`)
    }
  }
  // 硬性契约写进描述
  assert.match(mock.tools.get('team_create').description, /integration owner/)
  assert.match(mock.tools.get('team_plan').description, /build\/lint\/test/)
  assert.match(mock.tools.get('team_message').description, /解阻塞|阻塞/)
})

test('team_create 经宿主桥 spawn 成员并登记生命周期', async () => {
  const result = await callTool(mock.tools, 'team_create', {
    team_name: 'alpha',
    description: '测试团队',
    members: [
      { name: 'worker-a', prompt: '实现 A' },
      { name: 'worker-b', prompt: '实现 B', agent_type: 'general-purpose' },
    ],
  })
  const text = textOf(result)
  assert.match(text, /已创建/)
  assert.match(text, /worker-a: 已派发/)
  assert.match(text, /worker-b: 已派发/)
  assert.equal(memory.spawned.length, 2)

  const { getLifecycle } = await import('../dist/teamLifecycle.js')
  const lifecycle = getLifecycle('alpha', memory.host)
  const a = await lifecycle.get('worker-a')
  assert.ok(a?.sessionId)
  assert.equal(a.status, 'idle')
})

test('team_message 返回回执；等待者直接注入（injected）', async () => {
  await callTool(mock.tools, 'team_create', { team_name: 'beta', members: [{ name: 'worker', prompt: 'x' }] })
  const { getBus } = await import('../dist/teamBus.js')
  const bus = getBus('beta', { host: () => memory.host, lifecycle: () => ({}), teamName: () => 'beta', self: () => 'worker', members: async () => ['worker'] })

  // 模拟 worker 正在等待
  const waiting = bus.wait('worker', { from: 'team-lead' }, 2000)
  const receipt = await callTool(mock.tools, 'team_message', { team_name: 'beta', recipient: 'worker', message: '你好' }, {})
  const text = textOf(receipt)
  assert.match(text, /worker/)
  assert.match(text, /已投递给正在等待的收件人/)

  const got = await waiting
  assert.equal(got?.from, 'team-lead')
  assert.equal(got?.body, '你好')
})

test('team_message 到活跃成员返回 woken 并调度合并派发', async () => {
  await callTool(mock.tools, 'team_create', { team_name: 'gamma', members: [{ name: 'w', prompt: 'x' }] })
  const receipt = await callTool(mock.tools, 'team_message', { team_name: 'gamma', recipient: 'w', message: '任务1' })
  assert.match(textOf(receipt), /唤醒/)
})

test('idle → parked → revived 生命周期', async () => {
  const { getLifecycle } = await import('../dist/teamLifecycle.js')
  const lifecycle = getLifecycle('delta', memory.host)
  await lifecycle.adopt('m', { sessionId: 'sess-x', sessionFile: '/tmp/x.jsonl' })
  assert.equal((await lifecycle.get('m')).status, 'idle')

  // 等到 TTL 触发挂起
  await new Promise((resolve) => setTimeout(resolve, 160))
  assert.equal((await lifecycle.get('m')).status, 'parked')

  const revived = await lifecycle.ensureLive('m')
  assert.equal(revived.status, 'idle')
  assert.equal(memory.revived.length, 1)
  assert.equal(memory.revived[0].sessionId, 'sess-x')
})

test('被等待成员完成时经完成订阅唤醒（不轮询）', async () => {
  const created = await callTool(mock.tools, 'team_create', { team_name: 'eps', members: [{ name: 'solo', prompt: '干活' }] })
  assert.match(textOf(created), /已派发/)
  const sessionId = memory.spawned[0].handle.sessionId

  const { createTeamRuntime } = await import('../dist/teamTools.js')
  const runtime = createTeamRuntime(memory.host)
  runtime.subscribeHostFinish('eps')

  // 先发一条消息，制造「欠我回复」
  await callTool(mock.tools, 'team_message', { team_name: 'eps', recipient: 'solo', message: '请干活' })

  const { getBus } = await import('../dist/teamBus.js')
  const bus = getBus('eps', { host: () => memory.host, lifecycle: () => ({}), teamName: () => 'eps', self: () => 'team-lead', members: async () => ['team-lead', 'solo'] })
  const waitPromise = bus.wait('team-lead', { directOnly: true, repliesFrom: ['solo'] }, 2000)

  memory.complete({ sessionId, status: 'completed', result: '已完成 A' })
  const got = await waitPromise
  assert.ok(got, '完成事件应唤醒等待者')
  assert.equal(got.from, 'solo')
  assert.match(got.body, /已完成 A/)
})

test('generation CAS 拒绝迟到的覆盖', async () => {
  const { TeamLifecycle } = await import('../dist/teamLifecycle.js')
  const lifecycle = new TeamLifecycle('cas', memory.host)
  await lifecycle.adopt('g', { sessionId: 's1' })
  const entry = await lifecycle.get('g')
  // 用旧代数直接驱动一次 ensureLive 之后的竞态：新迁移后旧代数不得覆盖
  const stale = await lifecycle.park('g')
  assert.equal(stale.status, 'parked')
  // 重新登记会 +generation
  await lifecycle.adopt('g', { sessionId: 's2' })
  const after = await lifecycle.get('g')
  assert.ok(after.generation > entry.generation)
  assert.equal(after.sessionId, 's2')
})

test('同一 recipient 短时间多条消息合并成一次 dispatch', async () => {
  process.env.PI_TEAM_DISPATCH_QUIET_MS = '40'
  process.env.PI_TEAM_DISPATCH_MAX_MS = '500'
  await callTool(mock.tools, 'team_create', { team_name: 'merge', members: [{ name: 'w', prompt: 'x' }] })
  for (const body of ['一', '二', '三']) {
    await callTool(mock.tools, 'team_message', { team_name: 'merge', recipient: 'w', message: body })
  }
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(memory.woken.length, 1, '三条消息应只唤醒一次')
  const text = memory.woken[0].text
  assert.match(text, /一/)
  assert.match(text, /二/)
  assert.match(text, /三/)
  delete process.env.PI_TEAM_DISPATCH_QUIET_MS
  delete process.env.PI_TEAM_DISPATCH_MAX_MS
})

test('向 parked 成员发消息返回 revived 回执', async () => {
  await callTool(mock.tools, 'team_create', { team_name: 'rev', members: [{ name: 'p', prompt: 'x' }] })
  const { getLifecycle } = await import('../dist/teamLifecycle.js')
  const lifecycle = getLifecycle('rev', memory.host)
  await lifecycle.park('p')
  assert.equal((await lifecycle.get('p')).status, 'parked')

  const receipt = await callTool(mock.tools, 'team_message', { team_name: 'rev', recipient: 'p', message: '回来' })
  assert.match(textOf(receipt), /触发复活/)
  assert.equal(memory.revived.length, 1)
  assert.equal((await lifecycle.get('p')).status, 'idle')
})

// --- 并发上限（设计文档 §8：8 / 32）------------------------------------------

test('超出每团队上限时拒绝派发，且团队已创建但无成员被 spawn', async () => {
  process.env.PI_TEAM_MAX_MEMBERS = '2'
  try {
    const members = [
      { name: 'a', prompt: 'x' },
      { name: 'b', prompt: 'x' },
      { name: 'c', prompt: 'x' },
    ]
    const result = await callTool(mock.tools, 'team_create', { team_name: 'limit-per-team', members })
    const text = textOf(result)
    assert.match(text, /LIMIT_EXCEEDED: per-team worker limit reached \(2\)/)
    assert.match(text, /已创建但未派发任何成员/)
    // 团队名册仍然有效，只是没有派发。
    const { readTeamFileAsync } = await import('../dist/teamHelpers.js')
    const teamFile = await readTeamFileAsync('limit-per-team')
    assert.equal(teamFile.members.length, 4, 'team-lead + 3 名成员应已登记')
  } finally {
    delete process.env.PI_TEAM_MAX_MEMBERS
  }
})

test('超出全局上限时拒绝派发，拒绝消息区分 global', async () => {
  process.env.PI_TEAM_MAX_GLOBAL_WORKERS = '2'
  // 全局计数跨所有团队，所以先把前面测试留下的团队清掉，否则基数不是 0。
  const { listTeamNames, deleteTeamDir } = await import('../dist/teamHelpers.js')
  for (const name of await listTeamNames()) await deleteTeamDir(name)
  try {
    // 先占满全局：第一个团队派 2 名成员。
    const first = await callTool(mock.tools, 'team_create', {
      team_name: 'limit-global-a',
      members: [{ name: 'x', prompt: 'x' }, { name: 'y', prompt: 'x' }],
    })
    assert.doesNotMatch(textOf(first), /LIMIT_EXCEEDED/, '第一队应正常派发')

    // 第二个团队再派 1 名就超了。
    const second = await callTool(mock.tools, 'team_create', {
      team_name: 'limit-global-b',
      members: [{ name: 'z', prompt: 'x' }],
    })
    const text = textOf(second)
    assert.match(text, /LIMIT_EXCEEDED: global worker limit reached \(2\)/)
  } finally {
    delete process.env.PI_TEAM_MAX_GLOBAL_WORKERS
  }
})

// --- 人类优先槽（设计文档 §8.4）---------------------------------------------

test('人的直发消息跳过静默合并窗口，立刻唤醒；成员消息仍合并', async () => {
  // 把静默窗口调大，如果人类消息也走合并，它在窗口内不会被唤醒。
  process.env.PI_TEAM_DISPATCH_QUIET_MS = '5000'
  process.env.PI_TEAM_DISPATCH_MAX_MS = '6000'
  try {
    await callTool(mock.tools, 'team_create', { team_name: 'priority', members: [{ name: 'p', prompt: 'x' }] })
    const { getLifecycle } = await import('../dist/teamLifecycle.js')
    const lifecycle = getLifecycle('priority', memory.host)
    const before = memory.woken.length

    // 以 human 身份直发：应立即 flush（不等 5s 窗口）。
    const { getBus } = await import('../dist/teamBus.js')
    const bus = getBus('priority', memory.host)
    await bus.send({ from: 'human', to: 'p', body: '人类插队消息' })
    await new Promise((resolve) => setTimeout(resolve, 120))

    const after = memory.woken.length
    assert.ok(after > before, '人类的直发消息应立即唤醒成员，而不是等 5s 静默窗口')
    assert.match(memory.woken[after - 1].text, /人类插队消息/)
    void lifecycle
  } finally {
    delete process.env.PI_TEAM_DISPATCH_QUIET_MS
    delete process.env.PI_TEAM_DISPATCH_MAX_MS
  }
})

// --- 成员身份拦截（设计文档 §8.4：worker 不能再 spawn worker）----------------

test('worker 身份下 team_create 被拒，消息含「仅限 team-lead」', async () => {
  process.env.PI_AGENT_NAME = 'worker-1'
  try {
    const result = await callTool(mock.tools, 'team_create', {
      team_name: 'lead-only',
      members: [{ name: 'x', prompt: 'x' }],
    })
    const text = textOf(result)
    assert.match(text, /仅限 team-lead/)
    assert.match(text, /worker-1/)
    assert.match(text, /team_message/)
    // 拒绝后不得落盘团队
    const { listTeamNames } = await import('../dist/teamHelpers.js')
    assert.ok(!(await listTeamNames()).includes('lead-only'))
  } finally {
    delete process.env.PI_AGENT_NAME
  }
})

test('worker 身份下 team_message 仍可用', async () => {
  // 先以 team-lead（无身份）建团队
  await callTool(mock.tools, 'team_create', { team_name: 'msg-team', members: [{ name: 'w', prompt: 'x' }] })
  // 再以 worker 身份发消息：team_message 不属于团队级操作，必须可用
  process.env.PI_AGENT_NAME = 'worker-1'
  try {
    const receipt = await callTool(mock.tools, 'team_message', {
      team_name: 'msg-team',
      recipient: 'w',
      message: '继续',
    })
    assert.match(textOf(receipt), /w/)
    assert.match(textOf(receipt), /唤醒|已投递|已入队|复活|落盘/)
  } finally {
    delete process.env.PI_AGENT_NAME
  }
})

test('未设身份或身份为 team-lead 时 team_create 正常', async () => {
  // 未设身份：按 team-lead 放行（graceful degradation）
  const lead1 = await callTool(mock.tools, 'team_create', { team_name: 'no-identity', members: [{ name: 'a', prompt: 'x' }] })
  assert.match(textOf(lead1), /已创建/)
  // 身份为 team-lead：放行
  process.env.PI_AGENT_NAME = 'team-lead'
  try {
    const lead2 = await callTool(mock.tools, 'team_create', { team_name: 'lead-identity', members: [{ name: 'b', prompt: 'x' }] })
    assert.match(textOf(lead2), /已创建/)
  } finally {
    delete process.env.PI_AGENT_NAME
  }
})

test('扩展加载时捕获的成员身份在环境变量恢复后仍生效', async () => {
  // 宿主在成员会话创建期注入身份（PI_AGENT_NAME），扩展工厂期捕获；
  // 之后宿主恢复环境变量，成员会话的团队级操作仍应被拦截。
  process.env.PI_AGENT_NAME = 'worker-2'
  piTeamExtension(mock.pi)
  delete process.env.PI_AGENT_NAME
  const result = await callTool(mock.tools, 'team_create', {
    team_name: 'captured',
    members: [{ name: 'x', prompt: 'x' }],
  })
  assert.match(textOf(result), /仅限 team-lead/)
})

// --- Phase 4 步骤 5：审批后自动派发 ------------------------------------------

test('计划批准后 launch 会派发成员；重复 launch 不重复派发', async () => {
  const team = 'launch-team'
  await callTool(mock.tools, 'team_create', { team_name: team, spawn: false, members: [] })

  // 提交计划：两名成员、两个任务。
  await callTool(mock.tools, 'team_plan', {
    operation: 'submit',
    team_name: team,
    plan: {
      members: [
        { id: 'm1', name: 'w1', agent_type: 'general-purpose', prompt: '做 1', provider_id: 'p', model_id: 'mm' },
        { id: 'm2', name: 'w2', agent_type: 'general-purpose', prompt: '做 2', provider_id: 'p', model_id: 'mm' },
      ],
      tasks: [
        { id: 't1', subject: 'T1', owner_id: 'm1', dependencies: [] },
        { id: 't2', subject: 'T2', owner_id: 'm2', dependencies: [] },
      ],
    },
  })

  // 批准。
  const approved = await callTool(mock.tools, 'team_plan', { operation: 'approve', team_name: team, request_id: 'req-1' })
  assert.match(textOf(approved), /计划已批准/)

  // 派发。
  const before = memory.spawned?.length ?? 0
  const launched = await callTool(mock.tools, 'team_plan', { operation: 'launch', team_name: team })
  const launchText = textOf(launched)
  assert.match(launchText, /已派发/, launchText)

  const { readTeamPlan } = await import('../dist/teamPlanStore.js')
  const afterFirst = await readTeamPlan(team)
  assert.equal(afterFirst.state, 'running', '派发完成后计划应进入 running')
  assert.equal(afterFirst.launch.status, 'running')
  assert.equal(Object.keys(afterFirst.launch.memberIds ?? {}).length, 2, '应记录两名成员的会话 ID')

  // 再次 launch：没有待派发的计划，不应重复。
  const again = await callTool(mock.tools, 'team_plan', { operation: 'launch', team_name: team })
  assert.match(textOf(again), /没有待派发的计划/)
  const afterSecond = await readTeamPlan(team)
  assert.deepEqual(afterSecond.launch.memberIds, afterFirst.launch.memberIds, '重复 launch 不应改变成员映射')
  void before
})

test('未批准的计划不能 launch', async () => {
  const team = 'not-approved'
  await callTool(mock.tools, 'team_create', { team_name: team, spawn: false, members: [] })
  await callTool(mock.tools, 'team_plan', {
    operation: 'submit',
    team_name: team,
    plan: {
      members: [{ id: 'm1', name: 'w', agent_type: 'general-purpose', prompt: 'x', provider_id: 'p', model_id: 'mm' }],
      tasks: [{ id: 't1', subject: 'T', owner_id: 'm1', dependencies: [] }],
    },
  })
  const launched = await callTool(mock.tools, 'team_plan', { operation: 'launch', team_name: team })
  assert.match(textOf(launched), /没有待派发的计划/)
})

// --- 给成员指定模型（providerId 拼接 / team_create 的 effort_level）----------------

test('launch 时 model 拼成 providerId/modelId 传给宿主（多 provider 不丢 provider）', async () => {
  const team = 'model-launch'
  await callTool(mock.tools, 'team_create', { team_name: team, spawn: false, members: [] })
  await callTool(mock.tools, 'team_plan', {
    operation: 'submit',
    team_name: team,
    plan: {
      members: [
        { id: 'm1', name: 'w1', agent_type: 'general-purpose', prompt: '做 1', provider_id: 'ty', model_id: 'claude-sonnet-4-6' },
        { id: 'm2', name: 'w2', agent_type: 'general-purpose', prompt: '做 2', provider_id: 'deepseek', model_id: 'deepseek-v4' },
      ],
      tasks: [
        { id: 't1', subject: 'T1', owner_id: 'm1', dependencies: [] },
        { id: 't2', subject: 'T2', owner_id: 'm2', dependencies: [] },
      ],
    },
  })
  await callTool(mock.tools, 'team_plan', { operation: 'approve', team_name: team, request_id: 'req-model-1' })
  const launched = await callTool(mock.tools, 'team_plan', { operation: 'launch', team_name: team })
  assert.match(textOf(launched), /已派发/)

  const byName = new Map(memory.spawned.map((entry) => [entry.request.name, entry.request]))
  assert.equal(byName.get('w1').model, 'ty/claude-sonnet-4-6', 'launch 必须把 providerId 拼进 model')
  assert.equal(byName.get('w2').model, 'deepseek/deepseek-v4', 'launch 必须把 providerId 拼进 model')
})

test('launch 时 model_id 已含 provider 前缀则不再拼接', async () => {
  const team = 'model-qualified'
  await callTool(mock.tools, 'team_create', { team_name: team, spawn: false, members: [] })
  await callTool(mock.tools, 'team_plan', {
    operation: 'submit',
    team_name: team,
    plan: {
      members: [{ id: 'm1', name: 'w', agent_type: 'general-purpose', prompt: 'x', provider_id: 'ty', model_id: 'ty/claude' }],
      tasks: [{ id: 't1', subject: 'T', owner_id: 'm1', dependencies: [] }],
    },
  })
  await callTool(mock.tools, 'team_plan', { operation: 'approve', team_name: team, request_id: 'req-qualified-1' })
  await callTool(mock.tools, 'team_plan', { operation: 'launch', team_name: team })
  assert.equal(memory.spawned[0].request.model, 'ty/claude', '已带前缀的 modelId 不应被双重拼接')
})

test('team_create 成员的 effort_level 透传到 host.start 并落盘名册', async () => {
  const result = await callTool(mock.tools, 'team_create', {
    team_name: 'effort-team',
    members: [
      { name: 'brainy', prompt: '深入思考', effort_level: 'high' },
      { name: 'plain', prompt: '随便做' },
    ],
  })
  assert.match(textOf(result), /已创建/)
  assert.equal(memory.spawned.length, 2)

  const byName = new Map(memory.spawned.map((entry) => [entry.request.name, entry.request]))
  assert.equal(byName.get('brainy').thinking, 'high', 'effort_level 应透传为 thinking')
  assert.equal(byName.get('plain').thinking, undefined, '未指定时不应传 thinking')

  const { readTeamFileAsync } = await import('../dist/teamHelpers.js')
  const teamFile = await readTeamFileAsync('effort-team')
  assert.equal(teamFile.members.find((m) => m.name === 'brainy')?.effortLevel, 'high', 'effortLevel 应落盘名册')
})

// --- 未读背压（设计文档 §8.4：inbox 上限 8 条未读）---------------------------

test('未读达到上限后背压拒投，且错误信息区分"未读已满"与"被锁住"', async () => {
  process.env.PI_TEAM_MAX_UNREAD = '3'
  try {
    await callTool(mock.tools, 'team_create', { team_name: 'backpressure', spawn: false, members: [{ name: 'busy', prompt: 'x' }] })

    // 收件人没有活跃会话 → 消息只会落盘、不会被执行，未读因此越攒越多。
    const { getBus } = await import('../dist/teamBus.js')
    const bus = getBus('backpressure', memory.host)

    const outcomes = []
    for (let i = 1; i <= 5; i++) {
      const receipt = await bus.send({ from: 'team-lead', to: 'busy', body: `第 ${i} 条` })
      outcomes.push(receipt)
    }

    // 前 3 条落盘成功（buffered），第 4 条起被背压拒投。
    assert.equal(outcomes[0].outcome, 'buffered')
    assert.equal(outcomes[2].outcome, 'buffered')
    assert.equal(outcomes[3].outcome, 'failed')
    assert.match(outcomes[3].error, /未读已达上限 3 条/)
    assert.match(outcomes[3].error, /背压/)
    assert.equal(outcomes[4].outcome, 'failed')

    // 拒投的消息不应写进邮箱：未读数仍是 3。
    const { readUnreadMessages } = await import('../dist/teammateMailbox.js')
    const unread = await readUnreadMessages('busy', 'backpressure')
    assert.equal(unread.length, 3, `未读数应停在 3，实际 ${unread.length}`)
  } finally {
    delete process.env.PI_TEAM_MAX_UNREAD
  }
})

test('PI_TEAM_MAX_UNREAD=0 关闭背压', async () => {
  process.env.PI_TEAM_MAX_UNREAD = '0'
  try {
    await callTool(mock.tools, 'team_create', { team_name: 'no-backpressure', spawn: false, members: [{ name: 'idle-worker', prompt: 'x' }] })
    const { getBus } = await import('../dist/teamBus.js')
    const bus = getBus('no-backpressure', memory.host)

    for (let i = 1; i <= 12; i++) {
      const receipt = await bus.send({ from: 'team-lead', to: 'idle-worker', body: `第 ${i} 条` })
      assert.equal(receipt.outcome, 'buffered', `第 ${i} 条不应被拒`)
    }
    const { readUnreadMessages } = await import('../dist/teammateMailbox.js')
    assert.equal((await readUnreadMessages('idle-worker', 'no-backpressure')).length, 12)
  } finally {
    delete process.env.PI_TEAM_MAX_UNREAD
  }
})

// --- 默认上限值（不设环境变量时的真实行为）-----------------------------------

test('默认上限：每团队 12 / 全局 32，未设环境变量时生效', async () => {
  const { getMaxMembersPerTeam, getMaxGlobalWorkers } = await import('../dist/constants.js')
  delete process.env.PI_TEAM_MAX_MEMBERS
  delete process.env.PI_TEAM_MAX_GLOBAL_WORKERS
  assert.equal(getMaxMembersPerTeam(), 12, '每团队默认应为 12')
  assert.equal(getMaxGlobalWorkers(), 32, '全局默认应为 32')

  // 环境变量可覆盖，非法值回落默认。
  process.env.PI_TEAM_MAX_MEMBERS = '5'
  assert.equal(getMaxMembersPerTeam(), 5)
  process.env.PI_TEAM_MAX_MEMBERS = 'abc'
  assert.equal(getMaxMembersPerTeam(), 12, '非法值应回落默认')
  delete process.env.PI_TEAM_MAX_MEMBERS
  delete process.env.PI_TEAM_MAX_GLOBAL_WORKERS
})

test('12 名成员可以派发，第 13 名被拒', async () => {
  delete process.env.PI_TEAM_MAX_MEMBERS
  delete process.env.PI_TEAM_MAX_GLOBAL_WORKERS
  const members = Array.from({ length: 13 }, (_, i) => ({ name: `m${i + 1}`, prompt: 'x' }))
  const result = await callTool(mock.tools, 'team_create', { team_name: 'twelve', spawn: false, members })
  assert.doesNotMatch(textOf(result), /LIMIT_EXCEEDED/, 'spawn=false 时不应触发上限')

  // spawn=false 只登记不派发；再用 13 人做一次带 spawn 的检查。
  const spawned = await callTool(mock.tools, 'team_create', { team_name: 'thirteen', members })
  assert.match(textOf(spawned), /LIMIT_EXCEEDED: per-team worker limit reached \(12\)/, textOf(spawned))
})
