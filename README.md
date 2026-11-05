# pi-team

跨端**团队 agent 扩展**：一份源码，两个形态。

- **pi-agent-desktop 内置**：叠加在既有 subagent runtime（`lib/subagent-runtime.ts` 的
  `createSubagentController`）之上，**不重写 spawn**。
- **oh-my-pi marketplace**：宿主以 `default(pi)` 调用；子会话能力由宿主桥提供，缺失时降级。

> 团队（t3）交付。骨架与兼容层来自 `pi-ext-kit`（t1），已拷入 `src/compat.ts`、`src/policy.ts`、`types/pi-coding-agent.d.ts`。

## 交付清单

| 文件 | 作用 |
| --- | --- |
| `src/index.ts` | 默认导出工厂；注册团队工具；接线宿主完成订阅 |
| `src/teamTools.ts` | 10 个团队编排工具（中文描述）+ 运行环境/运行时装配 |
| `src/teamHost.ts` | **宿主桥**：唯一 spawn/revive/steer/wake 接缝 + 全局注入/降级 |
| `src/teamBus.ts` | 邮箱总线：投递回执、等待者、合并派发、欠回复追踪、完成订阅 |
| `src/teamLifecycle.ts` | 成员生命周期 idle→parked→revived + generation CAS + 落盘 |
| `src/compat.ts` / `src/policy.ts` | t1 兼容层与公共子集策略（原件） |
| `types/pi-coding-agent.d.ts` | 离线编译垫片（故意不含 `getSettings` / `before_agent_start`） |
| `src/teamHelpers.ts` 等 | 既有团队文件 / 计划 / 邮箱存储（复用，不改） |

## 构建

```bash
npm run build            # tsc → dist/（package.json 的 pi/omp.extensions 指向 dist/index.js）
npm run typecheck        # 对公共子集垫片校验（无需真实 SDK）
npm run typecheck:real   # 对真实 SDK 校验（依赖 devDependencies 里的 @earendil-works/*）
node --test test/team.test.mjs
```

> pi/omp 的扩展入口是 **编译产物** `dist/index.js`，发布/内置前需先 `npm run build`。
> `typecheck:real` 用的真实 SDK 通过 `devDependencies` 安装（`npm install` 即可），
> **不再需要**指向本机 Pi Agent 安装目录的 junction/symlink —— 那种链接会让 npm 把私有的
> 绝对路径写进 `package-lock.json`。

## 工具清单

| 工具 | 说明 |
| --- | --- |
| `team_create` | 创建团队、登记成员并按默认设置立即派发（spawn）；返回逐成员派发回执 |
| `team_plan` | 计划 get / submit / update（成员+任务依赖图） |
| `team_delete` | 删除团队全部数据 |
| `team_message` | 向成员或 `*` 广播；返回**投递回执** |
| `team_status` | 成员生命周期状态、计划/任务、欠我回复的人 |
| `team_wait` | 阻塞等待一条回复（不轮询）；不指定 recipient 时「只等欠我回复的人」 |
| `team_result` | 读取成员结果；`wait=true` 经完成订阅等到结束（不轮询） |
| `team_accept` | 验收成员产出，记为已答复并写入 `accepted.jsonl` |
| `team_cancel` | 终止成员（tombstone），保留会话文件以便日后复活 |
| `team_list` | 列出本机团队 |

> 另有 4 个跨端斜杠命令（经 compat 的 `registerCommand` 注册，自动上宿主斜杠面板）：
> `/team`（团队状态）、`/team-create <名称> [描述]`、`/team-plan`、`/team-status`（投递邮箱未读）。

## 邮箱语义（teamBus，对齐 oh-my-pi IrcBus）

- **回执**：`send` 返回 `injected | woken | revived | buffered | failed`
  - `injected`：收件人**正在等待**，消息被其 `wait` 直接取走（不落盘、不重复投递）；
  - `woken`：收件人活跃，已入其邮箱并按合并窗口调度唤醒；
  - `revived`：收件人此前 parked/aborted，本次触发复活后入队；
  - `buffered`：无活跃会话或唤醒不可用，已落盘等收件人 drain；
  - `failed`：收件人不存在或邮箱不可写。
- **只等欠我回复的人**：`unansweredSends(self)` 记下我直接发过、对方尚未答复的成员；`team_wait`
  缺省即用该集合过滤，进度消息不算承诺。
- **不轮询**：`team_wait` 挂起 Promise，投递或「被等待成员完成」事件到达即唤醒；`team_result(wait)`
  订阅宿主完成事件。
- **合并派发**：同一 recipient 的短时间消息在静默窗口（默认 2s，防抖）内合并成**一次** `wake`，
  派发后将该批消息标记已读，避免 drain 重复投递。可用 `PI_TEAM_DISPATCH_QUIET_MS` /
  `PI_TEAM_DISPATCH_MAX_MS` 调整。

## 成员生命周期（teamLifecycle）

`idle → parked → revived`，语义对齐 oh-my-pi `AgentLifecycleManager`：

- 成员派发后 `idle`，空闲超过 TTL（默认 120s，`PI_TEAM_IDLE_TTL_MS`）自动转 `parked`；
- 收到消息或 `team_result`/`ensureLive` 时，`parked`/`aborted` 的成员经宿主桥 `revive`，
  **复用其 sessionFile**（不重写会话持久化）；
- 每次迁移 `generation +1`，异步操作以 CAS 拒绝迟到覆盖；
- 状态落盘 `<teamDir>/lifecycle.json`，重启进程后仍可复活。默认 park 只改本地状态、
  不销毁会话；`PI_TEAM_PARK_DISPOSE=1` 时才让宿主释放。

## 提示词契约（写进工具 description）

1. 共享文件必须有**唯一 integration owner**；其余成员通过 `team_message` 请其代改。
2. 每个任务**跳过 build/lint/test**；全部任务完成前由 lead 统一跑一次。
3. **siblings 只为解阻塞通信**，不做闲聊、不广播进度噪声。

> `promptGuidelines` 是 pi-web 专属字段，本扩展不用它承载契约，统一放在 `description`。

## 宿主桥适配（t4 接线用）

pi-agent-desktop 内置接线需要把既有 subagent runtime 适配成 `TeamHost` 注入：

```ts
import { createSubagentController } from './lib/subagent-runtime'
import { setInjectedHost, type TeamHost } from 'pi-team'

const controller = createSubagentController({ /* 既有依赖 */ })
const host: TeamHost = {
  kind: 'subagent',
  async start(req) {
    const execution = await controller.extensionRuntime.start({
      parentContext,                    // 宿主侧持有的父会话 ExtensionContext
      parentToolCallId: 'team-lead',
      profile: req.profile,
      task: req.task,
      description: req.description,
      runInBackground: req.runInBackground ?? true,
      ...(req.model ? { model: req.model } : {}),
      ...(req.thinking ? { thinking: req.thinking } : {}),
      ...(req.isolation ? { isolation: req.isolation } : {}),
    })
    return { sessionId: execution.run.sessionId, sessionFile: execution.run.sessionPath, status: 'running' }
  },
  async revive(req) {
    const execution = await controller.extensionRuntime.resume({
      parentContext, parentToolCallId: 'team-lead', sessionId: req.sessionId,
      task: req.task ?? '继续任务并回报结果', description: req.description ?? '复活成员', runInBackground: true,
    })
    return { sessionId: execution.run.sessionId, sessionFile: execution.run.sessionPath, status: 'revived' }
  },
  async get(sessionId) {
    const run = await controller.get(sessionId)
    if (!run) return null
    return { sessionId: run.sessionId, sessionFile: run.sessionPath, status: run.status, result: run.result, error: run.error }
  },
  steer: (id, message) => controller.steer(id, message),
  stop: (id) => controller.abort(id),
  async wake({ sessionId, text }) {
    // 把合并后的一批消息作为 followUp 注入成员会话（至少一次唤醒语义）。
    await controller.steer(sessionId, text)   // 或用成员会话的 sendCustomMessage
    return true
  },
  onFinish(listener) {
    return controller.onRunFinished(listener)  // 需在 controller 上暴露完成订阅
  },
}
setInjectedHost(host)
```

注意：

- 接线处也可用工厂第二参直接传：`builtin('pi-team', (pi) => piTeamExtension(pi, host))`。
- pi-agent-desktop 的 background run 完成时，runtime 自带 `notifyParent` 会向父会话发
  `<prefix>report`。团队侧也订阅 `onFinish` 以唤醒等待者——若两者并存，注意用
  `markResultConsumed` 语义去重，避免重复唤醒（t4 决定取哪条路径）。
- `wake` 需要「给成员会话注入一条 followUp 消息」。`createSubagentController` 目前只暴露
  `steer`（要求会话 running）；成员已 idle/结束时建议接线处改为 `resume` 或对该会话
  `sendCustomMessage`。这是 t4 需要补齐的一处 runtime 缝。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PI_TEAM_DIR` | `~/.pi/agent/teams` | 团队数据根目录 |
| `PI_TEAM_NAME` / `PI_AGENT_NAME` | — | 当前会话所属团队 / 成员名 |
| `PI_TEAM_IDLE_TTL_MS` | `120000` | 空闲多久转 parked；`<=0` 关闭 |
| `PI_TEAM_DISPATCH_QUIET_MS` | `2000` | 合并派发静默窗口 |
| `PI_TEAM_DISPATCH_MAX_MS` | `10000` | 合并派发兜底上限 |
| `PI_TEAM_PARK_DISPOSE` | — | `=1` 时 park 顺带让宿主释放会话 |
| `PI_TEAM_ENABLE_TOOL_BRIDGE` | — | `=1` 启用工具桥降级（用 `PI_TEAM_AGENT_TOOL`，默认 `Agent`） |
| `PI_TEAM_DEBUG` | — | 打印调试日志 |

## 跨端约束（遵守 t1 公共子集）

- 宿主导入只用 `import type ... from "@earendil-works/pi-coding-agent"`（编译期擦除，
  dist 无 SDK 运行期依赖）；不 import `@oh-my-pi/*`、不用 `pi-ai` 的 `Type`（用 compat 的 `Type`）。
- 共享代码不用 `getSettings` / `before_agent_start`；工具字段只用
  `name/label/description/parameters/execute`。
- `registerCommand` 属允许面（两端签名兼容），经 compat 暴露，可跨端注册斜杠命令。
- 事件只用 6 个白名单事件。
