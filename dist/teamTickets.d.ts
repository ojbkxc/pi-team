import { z } from 'zod/v4';
export declare class TeamTicketError extends Error {
    status: number;
    constructor(message: string, status?: number);
}
export declare const mandateSchema: z.ZodObject<{
    id: z.ZodString;
    issuedBy: z.ZodString;
    statement: z.ZodString;
    createdAt: z.ZodNumber;
    revokedBy: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const assignmentSchema: z.ZodObject<{
    id: z.ZodString;
    assignee: z.ZodString;
    status: z.ZodEnum<{
        running: "running";
        pending: "pending";
        ended: "ended";
    }>;
    createdAt: z.ZodNumber;
    updatedAt: z.ZodNumber;
    result: z.ZodOptional<z.ZodString>;
    outcome: z.ZodOptional<z.ZodEnum<{
        completed: "completed";
        failed: "failed";
        cancelled: "cancelled";
    }>>;
}, z.core.$strip>;
export declare const ticketSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    id: z.ZodString;
    teamName: z.ZodString;
    subject: z.ZodString;
    description: z.ZodOptional<z.ZodString>;
    status: z.ZodEnum<{
        ended: "ended";
        open: "open";
    }>;
    createdBy: z.ZodString;
    createdAt: z.ZodNumber;
    updatedAt: z.ZodNumber;
    endedAt: z.ZodOptional<z.ZodNumber>;
    mandates: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        issuedBy: z.ZodString;
        statement: z.ZodString;
        createdAt: z.ZodNumber;
        revokedBy: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    assignments: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        assignee: z.ZodString;
        status: z.ZodEnum<{
            running: "running";
            pending: "pending";
            ended: "ended";
        }>;
        createdAt: z.ZodNumber;
        updatedAt: z.ZodNumber;
        result: z.ZodOptional<z.ZodString>;
        outcome: z.ZodOptional<z.ZodEnum<{
            completed: "completed";
            failed: "failed";
            cancelled: "cancelled";
        }>>;
    }, z.core.$strip>>;
    subscribers: z.ZodArray<z.ZodString>;
    thread: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        from: z.ZodString;
        text: z.ZodString;
        at: z.ZodNumber;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type Mandate = z.infer<typeof mandateSchema>;
export type Assignment = z.infer<typeof assignmentSchema>;
export type Ticket = z.infer<typeof ticketSchema>;
export declare function readTicket(teamName: string, ticketId: string): Promise<Ticket | null>;
export declare function listTickets(teamName: string): Promise<Ticket[]>;
export declare function createTicket(params: {
    teamName: string;
    subject: string;
    description?: string;
    createdBy: string;
    mandateStatement?: string;
    assignees?: Array<{
        assignee: string;
    }>;
}): Promise<Ticket>;
/**
 * 追加一个 Mandate。**已存在的 Mandate 永不被修改** —— 要改语义只能新建一个并撤销旧的，
 * 这样每次「改主意」都留下一条可审计的记录。
 */
export declare function addMandate(teamName: string, ticketId: string, params: {
    statement: string;
    issuedBy: string;
    revokes?: string;
}): Promise<{
    ticket: Ticket;
    mandate: Mandate;
}>;
/** 改 Mandate 的内容一律拒绝：不可变是这套模型的核心约束。 */
export declare function updateMandate(): Promise<never>;
export declare function addAssignment(teamName: string, ticketId: string, params: {
    assignee: string;
}): Promise<{
    ticket: Ticket;
    assignment: Assignment;
}>;
/**
 * 推进一个 Assignment 的状态。同一 ticket 的多个 assignment 各自独立，
 * 所以这里按 assignment id 定位，不会碰到兄弟 assignment。
 */
export declare function setAssignmentStatus(teamName: string, ticketId: string, assignmentId: string, params: {
    status: Assignment['status'];
    result?: string;
    outcome?: Assignment['outcome'];
}): Promise<{
    ticket: Ticket;
    assignment: Assignment;
}>;
export declare function endTicket(teamName: string, ticketId: string): Promise<Ticket>;
export declare function setSubscribers(teamName: string, ticketId: string, subscribers: string[]): Promise<Ticket>;
/**
 * 往 ticket 的讨论帖追加一条，并返回「应当收到扇出的人」。
 *
 * 扇出对象 = 订阅者 − 发言者自己。调用方拿这个列表走既有的 teamBus 投递，
 * 不在这里另造一套投递机制。
 */
export declare function postToThread(teamName: string, ticketId: string, params: {
    from: string;
    text: string;
}): Promise<{
    ticket: Ticket;
    fanout: string[];
}>;
/**
 * 一条消息的已读回执。落盘在 `acks/` 下，与邮箱分离 ——
 * 邮箱记录「投递了什么」，acks 记录「谁确认读过了」。
 */
export declare const receiptSchema: z.ZodObject<{
    messageId: z.ZodString;
    reader: z.ZodString;
    ackedAt: z.ZodNumber;
}, z.core.$strip>;
export type Receipt = z.infer<typeof receiptSchema>;
/**
 * 记一条 ack。同一个 (messageId, reader) 重复 ack 只保留一次 —— 覆盖写整份文件，
 * 所以调用方不需要去重。
 */
export declare function recordAck(teamName: string, messageId: string, reader: string): Promise<Receipt>;
export declare function readReceipts(teamName: string): Promise<Receipt[]>;
/**
 * 「未 ack 回 Eval」：给定应该确认的消息与应该确认它们的人，
 * 返回还没确认的组合。设计文档要求未确认的要能回到待处理状态，
 * 所以这里只做查询，重投交给调用方。
 */
export declare function listUnacked(teamName: string, expected: Array<{
    messageId: string;
    readers: string[];
}>): Promise<Array<{
    messageId: string;
    reader: string;
}>>;
