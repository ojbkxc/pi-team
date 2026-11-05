import type { MemberRunHandle, TeamHost } from './teamHost.js';
import type { MemberLifecycleStatus } from './teamLifecycle.js';
export type DeliveryOutcome = 'injected' | 'woken' | 'revived' | 'buffered' | 'failed';
export interface DeliveryReceipt {
    to: string;
    messageId: string;
    outcome: DeliveryOutcome;
    error?: string;
    /** 广播时每个收件人的结果。 */
    targets?: Array<{
        to: string;
        outcome: DeliveryOutcome;
        error?: string;
    }>;
}
export interface BusSendOptions {
    from: string;
    to: string;
    body: string;
    summary?: string;
    /** 进度型消息：不算「承诺回复」，也不构成一个未答复的直发。 */
    progress?: boolean;
}
/** wait 的过滤条件；对齐 oh-my-pi 的 IrcWaitFilter。 */
export interface BusWaitFilter {
    from?: string;
    directOnly?: boolean;
    repliesFrom?: readonly string[];
}
export interface BusWaitMessage {
    id: string;
    from: string;
    body: string;
    summary?: string;
    ts: number;
}
export interface BusContext {
    host(): TeamHost;
    lifecycle(): {
        get(name: string): Promise<{
            sessionId?: string;
            status: MemberLifecycleStatus;
        } | undefined>;
        ensureLive(name: string): Promise<{
            sessionId?: string;
            status: MemberLifecycleStatus;
        }>;
        markIdle(name: string): Promise<unknown>;
    };
    teamName(): string | undefined;
    self(): string;
    members(): Promise<string[]>;
}
export declare function busWaitAccepts(filter: BusWaitFilter, message: {
    from: string;
    progress?: boolean;
    broadcast?: boolean;
}): boolean;
export declare class TeamBus {
    #private;
    constructor(ctx: BusContext);
    /** 订阅成员完成事件；返回退订函数。 */
    onFinish(listener: (handle: MemberRunHandle) => void): () => void;
    /** 记一次「from 的已结算作业交付给 to」，算作 from 对 to 的回复。 */
    recordReply(from: string, to: string): void;
    /**
     * from 在 sinceSeq 之后直接消息过、但对方此后没有答复的成员。
     * 进度消息不算回复（标记为 promised）。「之后」按发送序号而非时间戳，避免同毫秒误判。
     */
    unansweredSends(from: string, sinceSeq: number): Array<{
        to: string;
        sentAt: number;
        promised: boolean;
    }>;
    /** 当前发送序号，配合 unansweredSends 用作「从现在起」的游标。 */
    cursor(): number;
    /**
     * 发送消息。广播（to === '*'）展开为逐个直发并汇总回执。
     */
    send(options: BusSendOptions): Promise<DeliveryReceipt>;
    /**
     * 阻塞等待一条满足 filter 的来信（超时返回 null；timeoutMs <= 0 表示一直等）。
     * 默认先 drain 已落盘的未读（可能是更早发送的），再挂起等待者。
     */
    wait(agentName: string, filter: BusWaitFilter, timeoutMs: number, signal?: AbortSignal, options?: {
        drainPending?: boolean;
    }): Promise<BusWaitMessage | null>;
    /**
     * 向正阻塞等待 `to` 的等待者投递一条「合成回复」——用于成员完成（而非发送消息）时唤醒
     * 正在等它的 lead，实现「不轮询、被等待者完成即唤醒」。返回是否命中等待者。
     */
    deliverSyntheticReply(to: string, from: string, body: string, summary?: string): boolean;
    /**
     * 成员完成：记为「该成员对其任务归属者/团队 lead 的回复」，通知生命周期，并唤醒正在等它的等待者。
     */
    notifyFinished(handle: MemberRunHandle, notify: string[]): Promise<void>;
    dispose(): void;
}
export declare function getBus(teamName: string, ctx: BusContext): TeamBus;
export declare function dropBus(teamName: string): void;
