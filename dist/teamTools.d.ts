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
import { type CompatApi } from './compat.js';
import { type TeamFile } from './teamHelpers.js';
import { type TeamLifecycle } from './teamLifecycle.js';
import { type TeamBus } from './teamBus.js';
import type { MemberRunHandle, TeamHost } from './teamHost.js';
/**
 * 解析当前会话身份。优先用扩展加载时捕获的值（宿主在成员会话创建期注入的
 * PI_AGENT_NAME/PI_TEAM_NAME），缺省回落到进程环境变量——oh-my-pi 独立进程模型下
 * 环境变量由 spawn 时设置并全程存在，捕获与回落结果一致。
 */
export declare function resolveAgentName(captured: string | undefined): string | undefined;
export declare function resolveTeamContext(captured: string | undefined): string | undefined;
export interface TeamEnv {
    teamName: string;
    self: string;
    host: TeamHost;
    lifecycle: TeamLifecycle;
    bus: TeamBus;
    readTeam(): Promise<TeamFile | null>;
    memberNames(): Promise<string[]>;
}
export interface TeamRuntime {
    readonly host: TeamHost;
    envFor(teamName: string): TeamEnv;
    /** 宿主上报成员完成时统一入口：记为回复、通知生命周期、唤醒等待者。 */
    handleFinish(teamName: string, handle: MemberRunHandle, notify: string[]): Promise<void>;
    /** 订阅宿主完成事件；返回退订。 */
    subscribeHostFinish(teamName: string): () => void;
    /** 当前会话身份（扩展加载时捕获；缺省回落进程环境变量）。 */
    readonly agentName: string | undefined;
    /** 当前会话团队上下文（扩展加载时捕获；缺省回落进程环境变量）。 */
    readonly teamName: string | undefined;
}
export declare function createTeamRuntime(host: TeamHost, identity?: {
    agentName?: string;
    teamName?: string;
}): TeamRuntime;
export declare function registerTeamTools(compat: CompatApi, runtime: TeamRuntime): void;
