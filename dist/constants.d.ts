export declare const TEAM_LEAD_NAME = "team-lead";
/**
 * Base directory for all team data: ~/.pi/agent/teams/
 * 可用 PI_TEAM_DIR 覆盖（测试或多环境隔离时使用）。
 */
export declare function getTeamsDir(): string;
/**
 * Environment variable to override the command used to spawn teammate instances.
 * If not set, defaults to the pi binary.
 */
export declare const TEAMMATE_COMMAND_ENV_VAR = "PI_TEAMMATE_COMMAND";
/**
 * Environment variable set on spawned teammates to indicate their assigned color.
 */
export declare const TEAMMATE_COLOR_ENV_VAR = "PI_AGENT_COLOR";
/**
 * Environment variable set on spawned teammates to require plan mode before implementation.
 */
export declare const PLAN_MODE_REQUIRED_ENV_VAR = "PI_PLAN_MODE_REQUIRED";
/**
 * Environment variable for the teammate's team name.
 */
export declare const TEAM_NAME_ENV_VAR = "PI_TEAM_NAME";
/**
 * Environment variable for the teammate's agent name.
 */
export declare const AGENT_NAME_ENV_VAR = "PI_AGENT_NAME";
/**
 * Environment variable for the teammate's agent ID.
 */
export declare const AGENT_ID_ENV_VAR = "PI_AGENT_ID";
/**
 * 宿主桥的进程级注册键。pi-agent-desktop 内置接线（t4）用它把既有 subagent runtime
 * 注入进来；oh-my-pi 侧不存在该键，扩展自动降级。
 */
export declare const TEAM_HOST_GLOBAL_KEY = "__piTeamHost";
/**
 * 同一 recipient 的静默窗口（毫秒）。窗口内到达的消息合并成一次 dispatch（一次唤醒），
 * 避免每条消息各唤醒一次。窗口每来一条消息重新计时（防抖）。可用 PI_TEAM_DISPATCH_QUIET_MS 覆盖。
 */
export declare const DISPATCH_QUIET_WINDOW_MS = 2000;
/**
 * 防抖的兜底上限：持续有消息时最多等这么久就强制派发一次，避免永远等不到静默。
 * 可用 PI_TEAM_DISPATCH_MAX_MS 覆盖。
 */
export declare const DISPATCH_MAX_WAIT_MS = 10000;
/** 静默窗口毫秒（支持环境覆盖，便于调参与测试）。 */
export declare function getDispatchQuietWindowMs(): number;
/** 防抖兜底上限毫秒（支持环境覆盖）。 */
export declare function getDispatchMaxWaitMs(): number;
/** 已派发消息在收件人邮箱里的容量上限，超出的最旧消息被丢弃。 */
export declare const MAILBOX_CAP = 200;
/** 成员空闲多久后进入 parked（挂起）。<= 0 关闭自动挂起。默认 2 分钟。 */
export declare const DEFAULT_IDLE_TTL_MS = 120000;
/**
 * 读取成员空闲 TTL；可用 PI_TEAM_IDLE_TTL_MS 覆盖（0 或负数表示不自动挂起）。
 */
export declare function getIdleTtlMs(): number;
/**
 * 工具桥默认使用的「生成子会话」工具名。仅在宿主注入桥缺失时作为降级路径，
 * 且需要 host 提供 executeTool。默认尝试 pi-agent-desktop / oh-my-pi 常见的 Agent 工具。
 */
export declare function getAgentToolName(): string;
/** 生命周期状态在本进程内是否落盘（默认落盘，便于重启后复用会话文件）。 */
export declare function isLifecyclePersisted(): boolean;
