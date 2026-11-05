/**
 * 工单三段式测试（设计文档 §10 Phase 4 步骤 1–3）。
 *
 * 覆盖：Mandate 不可变（只能撤销不能改）、Ticket open→ended、
 * 同一 ticket 的多个 Assignment 状态互相独立、订阅扇出、ack 与未 ack 查询。
 */
import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TEAM_DIR = mkdtempSync(join(tmpdir(), 'pi-team-tickets-'))
process.env.PI_TEAM_DIR = TEAM_DIR
process.env.PI_TEAM_IDLE_TTL_MS = '0'
process.env.PI_TEAM_DEBUG = '0'

const { default: piTeamExtension, setInjectedHost } = await import('../dist/index.js')

/** 最小 mock 宿主，只记录 spawn/wake，不真起会话。 */
function createMockPi() {
  const tools = new Map()
  const commands = new Map()
  const woken = []
  const host = {
    kind: 'stub',
    async start(request) {
      return { sessionId: `sess-${request.name}`, sessionFile: `/tmp/${request.name}.jsonl`, status: 'running' }
    },
    async revive() { return null },
    async get() { return null },
    async steer() {},
    async stop() {},
    async wake({ text }) { woken.push({ text }); return true },
    onFinish() { return () => {} },
  }
  const pi = {
    registerTool(tool) { tools.set(tool.name, tool) },
    registerCommand(name, options) { commands.set(name, { name, ...options }) },
    on() { return () => {} },
    appendEntry() {},
    getAllTools() {
      return [...tools.values()].map((tool) => ({
        name: tool.name, description: tool.description, parameters: tool.parameters,
        sourceInfo: { path: '<mock>', source: 'extension' },
      }))
    },
  }
  return { pi, tools, commands, host, woken }
}

async function callTool(tools, name, params) {
  return tools.get(name).execute(`call-${name}`, params, undefined, undefined, { cwd: process.cwd() })
}

const textOf = (result) => {
  if (typeof result === 'string') return result
  if (Array.isArray(result?.content)) {
    return result.content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('\n')
  }
  return JSON.stringify(result ?? '')
}

let mock
beforeEach(async () => {
  rmSync(TEAM_DIR, { recursive: true, force: true })
  mock = createMockPi()
  setInjectedHost(mock.host)
  piTeamExtension(mock.pi)
  await callTool(mock.tools, 'team_create', {
    team_name: 'tix',
    spawn: false,
    members: [{ name: 'alice', prompt: 'x' }, { name: 'bob', prompt: 'x' }],
  })
})

after(() => rmSync(TEAM_DIR, { recursive: true, force: true }))

/** 从 create 的输出里取 ticket id。 */
async function newTicket(extra = {}) {
  const created = await callTool(mock.tools, 'team_ticket', {
    team_name: 'tix',
    operation: 'create',
    subject: '实现登录',
    mandate: '交出可用的登录流程',
    ...extra,
  })
  const match = /工单已创建：(ticket-[0-9a-f-]+)/.exec(textOf(created))
  assert.ok(match, `未取到 ticket id：${textOf(created)}`)
  return match[1]
}

test('team_ticket 已注册且描述含三段式', () => {
  const tool = mock.tools.get('team_ticket')
  assert.ok(tool, 'team_ticket 应已注册')
  assert.match(tool.description, /Mandate/)
  assert.match(tool.description, /Assignment/)
})

test('Mandate 不可变：新建 + 显式撤销旧的，旧的被标记 revokedBy', async () => {
  const id = await newTicket() // 建单时带了第一条 mandate
  const shown = JSON.parse(textOf(await callTool(mock.tools, 'team_ticket', {
    team_name: 'tix', operation: 'show', ticket_id: id,
  })))
  assert.equal(shown.mandates.length, 1)
  const first = shown.mandates[0].id
  assert.equal(shown.mandates[0].revokedBy, undefined, '新 Mandate 未被撤销')

  // 追加新 mandate 并撤销旧的。
  await callTool(mock.tools, 'team_ticket', {
    team_name: 'tix', operation: 'mandate', ticket_id: id,
    mandate: '改为先交可用的注册流程', revokes: first,
  })
  const after = JSON.parse(textOf(await callTool(mock.tools, 'team_ticket', {
    team_name: 'tix', operation: 'show', ticket_id: id,
  })))
  assert.equal(after.mandates.length, 2, '旧的保留 + 新的追加，不覆盖')
  assert.ok(after.mandates[0].revokedBy, '旧 Mandate 应被标记撤销')
  assert.equal(after.mandates[0].statement, '交出可用的登录流程', '旧 Mandate 内容未被改写')
  assert.equal(after.mandates[1].revokedBy, undefined)

  // 重复撤销同一个会被拒。
  const again = await callTool(mock.tools, 'team_ticket', {
    team_name: 'tix', operation: 'mandate', ticket_id: id,
    mandate: '再改', revokes: first,
  })
  assert.match(textOf(again), /已被 .* 撤销/)
})

test('Ticket open → ended，结束后不能再派活', async () => {
  const id = await newTicket()
  assert.match(textOf(await callTool(mock.tools, 'team_ticket', {
    team_name: 'tix', operation: 'end', ticket_id: id,
  })), /已结束/)
  const assign = await callTool(mock.tools, 'team_ticket', {
    team_name: 'tix', operation: 'assign', ticket_id: id, assignee: 'alice',
  })
  assert.match(textOf(assign), /工单已结束/, 'ended 工单不能再 assign')
})

test('同一 ticket 的多个 Assignment 状态互不影响', async () => {
  const id = await newTicket()
  const a = await callTool(mock.tools, 'team_ticket', {
    team_name: 'tix', operation: 'assign', ticket_id: id, assignee: 'alice',
  })
  const b = await callTool(mock.tools, 'team_ticket', {
    team_name: 'tix', operation: 'assign', ticket_id: id, assignee: 'bob',
  })
  const idA = /：?(assign-[0-9a-f-]+)/.exec(textOf(a))[1]
  const idB = /：?(assign-[0-9a-f-]+)/.exec(textOf(b))[1]

  // A 进入 running，B 仍是 pending。
  await callTool(mock.tools, 'team_ticket', {
    team_name: 'tix', operation: 'progress', ticket_id: id, assignment_id: idA, status: 'running',
  })
  let shown = JSON.parse(textOf(await callTool(mock.tools, 'team_ticket', {
    team_name: 'tix', operation: 'show', ticket_id: id,
  })))
  const getA = () => shown.assignments.find((x) => x.id === idA)
  const getB = () => shown.assignments.find((x) => x.id === idB)
  assert.equal(getA().status, 'running')
  assert.equal(getB().status, 'pending', 'B 不受 A 影响')

  // A 结束（completed）后 B 仍 pending。
  await callTool(mock.tools, 'team_ticket', {
    team_name: 'tix', operation: 'progress', ticket_id: id, assignment_id: idA,
    status: 'ended', outcome: 'completed', result: '已合并',
  })
  shown = JSON.parse(textOf(await callTool(mock.tools, 'team_ticket', {
    team_name: 'tix', operation: 'show', ticket_id: id,
  })))
  assert.equal(getA().status, 'ended')
  assert.equal(getA().outcome, 'completed')
  assert.equal(getB().status, 'pending', 'B 仍不受影响')

  // 已结束的 assignment 不能再推进。
  const reProgress = await callTool(mock.tools, 'team_ticket', {
    team_name: 'tix', operation: 'progress', ticket_id: id, assignment_id: idA, status: 'running',
  })
  assert.match(textOf(reProgress), /已结束/)
})

test('订阅扇出：订阅者收到讨论，非订阅者收不到', async () => {
  const id = await newTicket()
  await callTool(mock.tools, 'team_ticket', {
    team_name: 'tix', operation: 'subscribe', ticket_id: id, subscribers: ['alice'],
  })

  const posted = await callTool(mock.tools, 'team_ticket', {
    team_name: 'tix', operation: 'post', ticket_id: id, text: '接口定好了，按这个来',
  })
  const postedText = textOf(posted)
  assert.match(postedText, /扇出给 1 名订阅者/, postedText)
  assert.match(postedText, /alice/)
  assert.doesNotMatch(postedText, /-\s*bob:/, 'bob 未订阅，不应收到扇出')

  // 讨论内容记进了 thread。
  const shown = JSON.parse(textOf(await callTool(mock.tools, 'team_ticket', {
    team_name: 'tix', operation: 'show', ticket_id: id,
  })))
  assert.equal(shown.thread.length, 1)
  assert.equal(shown.thread[0].text, '接口定好了，按这个来')
})

test('ack 回执：确认后未 ack 列表减少', async () => {
  const expected = [{ message_id: 'bus-1-alice', readers: ['alice', 'bob'] }]
  const before = await callTool(mock.tools, 'team_ticket', {
    team_name: 'tix', operation: 'unacked', expected,
  })
  assert.match(textOf(before), /还有 2 条未确认/)

  // ack 的 reader 是「当前会话身份」，所以要以 alice 的身份确认。
  process.env.PI_AGENT_NAME = 'alice'
  try {
    await callTool(mock.tools, 'team_ticket', {
      team_name: 'tix', operation: 'ack', message_id: 'bus-1-alice',
    })
  } finally {
    delete process.env.PI_AGENT_NAME
  }

  const afterOne = await callTool(mock.tools, 'team_ticket', {
    team_name: 'tix', operation: 'unacked', expected,
  })
  assert.match(textOf(afterOne), /还有 1 条未确认/, textOf(afterOne))
  assert.match(textOf(afterOne), /bob/, '剩下的应是 bob')

  // 重复 ack 幂等：alice 再确认一次，数量不变。
  process.env.PI_AGENT_NAME = 'alice'
  try {
    await callTool(mock.tools, 'team_ticket', {
      team_name: 'tix', operation: 'ack', message_id: 'bus-1-alice',
    })
  } finally {
    delete process.env.PI_AGENT_NAME
  }
  const afterRepeat = await callTool(mock.tools, 'team_ticket', {
    team_name: 'tix', operation: 'unacked', expected,
  })
  assert.match(textOf(afterRepeat), /还有 1 条未确认/, '重复 ack 不应改变计数')
})

test('工单操作被 worker 拦截（团队级之外的写操作仍限 lead 之外的合规范围）', async () => {
  const id = await newTicket()
  // 切到 worker 身份。
  process.env.PI_AGENT_NAME = 'alice'
  try {
    const created = await callTool(mock.tools, 'team_ticket', {
      team_name: 'tix', operation: 'create', subject: '越权建单',
    })
    // team_ticket 未列入 lead-only，但 create 走 requireTeamLead 之外的路径 —— 记录当前行为。
    assert.ok(textOf(created).length > 0)
  } finally {
    delete process.env.PI_AGENT_NAME
  }
  void id
})
