import { homedir } from 'node:os';
import { join } from 'node:path';
export const TEAM_LEAD_NAME = 'team-lead';
/**
 * Base directory for all team data: ~/.pi/agent/teams/
 * 可用 PI_TEAM_DIR 覆盖（测试或多环境隔离时使用）。
 */
export function getTeamsDir() {
    return process.env.PI_TEAM_DIR || join(homedir(), '.pi', 'agent', 'teams');
}
/**
 * Environment variable to override the command used to spawn teammate instances.
 * If not set, defaults to the pi binary.
 */
export const TEAMMATE_COMMAND_ENV_VAR = 'PI_TEAMMATE_COMMAND';
/**
 * Environment variable set on spawned teammates to indicate their assigned color.
 */
export const TEAMMATE_COLOR_ENV_VAR = 'PI_AGENT_COLOR';
/**
 * Environment variable set on spawned teammates to require plan mode before implementation.
 */
export const PLAN_MODE_REQUIRED_ENV_VAR = 'PI_PLAN_MODE_REQUIRED';
/**
 * Environment variable for the teammate's team name.
 */
export const TEAM_NAME_ENV_VAR = 'PI_TEAM_NAME';
/**
 * Environment variable for the teammate's agent name.
 */
export const AGENT_NAME_ENV_VAR = 'PI_AGENT_NAME';
/**
 * Environment variable for the teammate's agent ID.
 */
export const AGENT_ID_ENV_VAR = 'PI_AGENT_ID';
// ---------------------------------------------------------------------------
// 跨端团队扩展新增常量
// ---------------------------------------------------------------------------
/**
 * 宿主桥的进程级注册键。pi-agent-desktop 内置接线（t4）用它把既有 subagent runtime
 * 注入进来；oh-my-pi 侧不存在该键，扩展自动降级。
 */
export const TEAM_HOST_GLOBAL_KEY = '__piTeamHost';
/**
 * 同一 recipient 的静默窗口（毫秒）。窗口内到达的消息合并成一次 dispatch（一次唤醒），
 * 避免每条消息各唤醒一次。窗口每来一条消息重新计时（防抖）。可用 PI_TEAM_DISPATCH_QUIET_MS 覆盖。
 */
export const DISPATCH_QUIET_WINDOW_MS = 2_000;
/**
 * 防抖的兜底上限：持续有消息时最多等这么久就强制派发一次，避免永远等不到静默。
 * 可用 PI_TEAM_DISPATCH_MAX_MS 覆盖。
 */
export const DISPATCH_MAX_WAIT_MS = 10_000;
/** 静默窗口毫秒（支持环境覆盖，便于调参与测试）。 */
export function getDispatchQuietWindowMs() {
    const raw = process.env.PI_TEAM_DISPATCH_QUIET_MS;
    const parsed = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(parsed) ? parsed : DISPATCH_QUIET_WINDOW_MS;
}
/** 防抖兜底上限毫秒（支持环境覆盖）。 */
export function getDispatchMaxWaitMs() {
    const raw = process.env.PI_TEAM_DISPATCH_MAX_MS;
    const parsed = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(parsed) ? parsed : DISPATCH_MAX_WAIT_MS;
}
/** 已派发消息在收件人邮箱里的容量上限，超出的最旧消息被丢弃。 */
export const MAILBOX_CAP = 200;
// ---------------------------------------------------------------------------
// 并发上限（设计文档 §8「8 / 32 + 人类优先槽」）
//
// PI-Desktop 的 4/16 偏保守（单父 4 个 worker 在大型重构里不够用），这里取
// 8（每父会话，正好对应泳道的 8 条可见 lane）与 32（全进程，受内存与 provider
// 限流约束）的平衡。上限拒绝必须区分原因，否则调用方分不清是「自己派多了」
// 还是「全局被别人占满了」。
// ---------------------------------------------------------------------------
/** 单个父会话可同时活跃的 worker 数（不含 team-lead）。可用 PI_TEAM_MAX_MEMBERS 覆盖。 */
export const DEFAULT_MAX_MEMBERS_PER_TEAM = 8;
/** 全进程可同时活跃的 worker 总数（跨所有团队）。可用 PI_TEAM_MAX_GLOBAL_WORKERS 覆盖。 */
export const DEFAULT_MAX_GLOBAL_WORKERS = 32;
function positiveIntFromEnv(name, fallback) {
    const raw = process.env[name];
    const parsed = raw === undefined ? NaN : Number(raw);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
/** 每团队成员上限（支持环境覆盖）。 */
export function getMaxMembersPerTeam() {
    return positiveIntFromEnv('PI_TEAM_MAX_MEMBERS', DEFAULT_MAX_MEMBERS_PER_TEAM);
}
/** 全局 worker 上限（支持环境覆盖）。 */
export function getMaxGlobalWorkers() {
    return positiveIntFromEnv('PI_TEAM_MAX_GLOBAL_WORKERS', DEFAULT_MAX_GLOBAL_WORKERS);
}
export const TEAM_LIMIT_PREFIX = 'LIMIT_EXCEEDED';
/**
 * 人类优先槽（设计文档 §8.4）。
 *
 * 借鉴 DeepSeek 的有界并发槽位：给「人」留一个额外槽位，人的消息/状态请求不排队，
 * 直接插队。落地方式是不进静默合并窗口 —— 成员之间的消息走 `DISPATCH_QUIET_WINDOW_MS`
 * 的防抖合并（减少唤醒次数），而人的直发消息立即派发，避免被一串 agent 消息饿死。
 *
 * 默认开启；`PI_TEAM_HUMAN_PRIORITY=0` 可关闭（例如测试里想观察纯合并行为时）。
 */
export function isHumanPriorityEnabled() {
    const raw = process.env.PI_TEAM_HUMAN_PRIORITY;
    return raw !== '0' && raw !== 'false';
}
/** 人类发言者的身份名。与成员名同处一个命名空间，用保留名避免撞名。 */
export const HUMAN_SENDER_NAME = 'human';
/** 成员空闲多久后进入 parked（挂起）。<= 0 关闭自动挂起。默认 2 分钟。 */
export const DEFAULT_IDLE_TTL_MS = 120_000;
/**
 * 读取成员空闲 TTL；可用 PI_TEAM_IDLE_TTL_MS 覆盖（0 或负数表示不自动挂起）。
 */
export function getIdleTtlMs() {
    const raw = process.env.PI_TEAM_IDLE_TTL_MS;
    if (raw === undefined)
        return DEFAULT_IDLE_TTL_MS;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : DEFAULT_IDLE_TTL_MS;
}
/**
 * 工具桥默认使用的「生成子会话」工具名。仅在宿主注入桥缺失时作为降级路径，
 * 且需要 host 提供 executeTool。默认尝试 pi-agent-desktop / oh-my-pi 常见的 Agent 工具。
 */
export function getAgentToolName() {
    return process.env.PI_TEAM_AGENT_TOOL || 'Agent';
}
/** 生命周期状态在本进程内是否落盘（默认落盘，便于重启后复用会话文件）。 */
export function isLifecyclePersisted() {
    return process.env.PI_TEAM_PERSIST_LIFECYCLE !== '0';
}
//# sourceMappingURL=constants.js.map