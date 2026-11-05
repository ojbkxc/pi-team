import type { MemberRunHandle, TeamHost } from './teamHost.js';
export type MemberLifecycleStatus = 'idle' | 'running' | 'parked' | 'aborted';
export interface MemberLifecycleEntry {
    name: string;
    sessionId?: string;
    sessionFile?: string;
    status: MemberLifecycleStatus;
    /** 状态代数：每次状态迁移 +1，用于拒绝迟到的异步覆盖。 */
    generation: number;
    parkedAt?: number;
    updatedAt: number;
    lastError?: string;
}
export declare class TeamLifecycle {
    #private;
    constructor(teamName: string, host: TeamHost);
    /** 读取成员条目（不存在返回 undefined）。 */
    get(name: string): Promise<MemberLifecycleEntry | undefined>;
    list(): Promise<MemberLifecycleEntry[]>;
    /** 登记一个新成员并置为 idle，arm 空闲 TTL。 */
    adopt(name: string, info: {
        sessionId?: string;
        sessionFile?: string;
    }): Promise<MemberLifecycleEntry>;
    /** 标记成员正在运行（清掉空闲计时器）。 */
    markRunning(name: string): Promise<MemberLifecycleEntry>;
    /** 标记成员回到空闲（重新 arm 空闲计时器，TTL 后自动 parked）。 */
    markIdle(name: string): Promise<MemberLifecycleEntry>;
    /** 显式挂起：idle → parked。默认只改本地状态，保留 sessionFile；设置 PI_TEAM_PARK_DISPOSE=1 时顺带让宿主释放会话。 */
    park(name: string): Promise<MemberLifecycleEntry>;
    /** 明确终止（tombstone）：aborted，保留 sessionFile 以便日后 ensureLive 复活。 */
    release(name: string, options?: {
        tombstone?: boolean;
    }): Promise<MemberLifecycleEntry>;
    /**
     * 确保成员有活跃会话：
     *  - running/idle → 直接返回；
     *  - parked/aborted → 通过宿主桥 revive（复用 sessionFile），成功后回到 idle。
     * 并发调用按成员名合并。
     */
    ensureLive(name: string): Promise<MemberLifecycleEntry>;
    /** 记录一次宿主完成事件：成员回到 idle（arm TTL）或进入终止态。 */
    onRunFinished(name: string, handle: MemberRunHandle): Promise<MemberLifecycleEntry>;
    /** 停止所有计时器（进程退出或团队删除时调用）。 */
    dispose(): void;
}
/** 取（或创建）某团队在本进程的生命周期管理器。 */
export declare function getLifecycle(teamName: string, host: TeamHost): TeamLifecycle;
/** 丢弃某团队的生命周期管理器（团队删除时调用）。 */
export declare function dropLifecycle(teamName: string): void;
