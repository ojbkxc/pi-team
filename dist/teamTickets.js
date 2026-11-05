/**
 * 工单三段式（设计文档 §10 Phase 4 步骤 1–3）。
 *
 * 借鉴 DeepSeek 的 Ticket / Mandate / Assignment 分层，把「谁要求做什么」与「谁在做、
 * 做到哪一步」拆开：
 *
 *   Mandate     不可变的授权：lead 说「做这件事」，写完就冻结。要改只能新建一个
 *               并**显式撤销**旧的（`revokedBy` 指回新 Mandate），历史因此可追溯。
 *   Ticket      一个可讨论的工作单元（open → ended）。讨论挂在 ticket 上，订阅者
 *               通过它收到后续扇出。
 *   Assignment  把一个 ticket 派给某个成员（pending → running → ended）。同一 ticket
 *               可以有多个 assignment 各自独立推进，互不影响状态。
 *
 * 落盘布局（与 config.json / plan.json 同级，都在 getTeamDir 下）：
 *   tickets/<ticketId>.json   一个 ticket 一条，内含其 mandates 与 assignments
 *
 * 并发与原子性照抄 teamPlanStore：proper-lockfile 锁 + 写临时文件 + rename。
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as lockfile from 'proper-lockfile';
import { z } from 'zod/v4';
import { getTeamDir } from './teamHelpers.js';
export class TeamTicketError extends Error {
    status;
    constructor(message, status = 409) {
        super(message);
        this.status = status;
    }
}
// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
export const mandateSchema = z.object({
    id: z.string().min(1),
    /** 谁下的授权（成员名或 team-lead）。 */
    issuedBy: z.string().min(1),
    /** 授权内容：要达成什么。 */
    statement: z.string().min(1),
    createdAt: z.number(),
    /** 被哪个新 Mandate 撤销。一旦设置，本 Mandate 冻结且不再有效。 */
    revokedBy: z.string().optional(),
});
export const assignmentSchema = z.object({
    id: z.string().min(1),
    /** 承接该 assignment 的成员名。 */
    assignee: z.string().min(1),
    status: z.enum(['pending', 'running', 'ended']),
    createdAt: z.number(),
    updatedAt: z.number(),
    /** 结束时的结果摘要（ended 才有意义）。 */
    result: z.string().optional(),
    /** 结束原因：completed / failed / cancelled。 */
    outcome: z.enum(['completed', 'failed', 'cancelled']).optional(),
});
export const ticketSchema = z.object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    teamName: z.string().min(1),
    subject: z.string().min(1),
    description: z.string().optional(),
    status: z.enum(['open', 'ended']),
    createdBy: z.string().min(1),
    createdAt: z.number(),
    updatedAt: z.number(),
    endedAt: z.number().optional(),
    mandates: z.array(mandateSchema),
    assignments: z.array(assignmentSchema),
    /** 订阅该 ticket 的成员名：ticket 上的后续讨论会扇出给他们。 */
    subscribers: z.array(z.string()),
    /** ticket 上的讨论帖（扇出的来源）。 */
    thread: z.array(z.object({
        id: z.string().min(1),
        from: z.string().min(1),
        text: z.string(),
        at: z.number(),
    })),
});
// ---------------------------------------------------------------------------
// 路径与读写
// ---------------------------------------------------------------------------
const ticketsDir = (teamName) => join(getTeamDir(teamName), 'tickets');
const ticketPath = (teamName, ticketId) => join(ticketsDir(teamName), `${sanitizeId(ticketId)}.json`);
/** ticket/assignment/mandate 的 ID 会进文件名，必须挡住路径穿越。 */
function sanitizeId(value) {
    const cleaned = value.trim().replace(/[^A-Za-z0-9._-]/g, '-').replace(/^\.+/, '');
    if (!cleaned)
        throw new TeamTicketError('ID 不能为空', 400);
    return cleaned;
}
async function writeTicket(ticket) {
    const dir = ticketsDir(ticket.teamName);
    await mkdir(dir, { recursive: true });
    const target = ticketPath(ticket.teamName, ticket.id);
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
        await writeFile(temp, JSON.stringify(ticketSchema.parse(ticket), null, 2));
        for (let attempt = 0;; attempt++) {
            try {
                await rename(temp, target);
                break;
            }
            catch (error) {
                // Windows 上其他读者可能短暂占用目标文件。
                const code = error?.code;
                if (process.platform !== 'win32' || attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? ''))
                    throw error;
                await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
            }
        }
    }
    finally {
        await unlink(temp).catch(() => { });
    }
}
/** 每次改动都持 ticket 文件锁，读-改-写在同一临界区里。 */
async function withTicketLock(teamName, ticketId, run) {
    const dir = ticketsDir(teamName);
    await mkdir(dir, { recursive: true });
    const path = ticketPath(teamName, ticketId);
    // proper-lockfile 要求目标文件存在；先落一个空对象占位，随后的写入会覆盖它。
    await writeFile(path, '{}', { encoding: 'utf-8', flag: 'wx' }).catch(() => { });
    const release = await lockfile.lock(path, {
        lockfilePath: `${path}.lock`,
        realpath: false,
        retries: { retries: 10, minTimeout: 5, maxTimeout: 100 },
    });
    try {
        return await run();
    }
    finally {
        await release().catch(() => { });
    }
}
export async function readTicket(teamName, ticketId) {
    try {
        const raw = await readFile(ticketPath(teamName, ticketId), 'utf8');
        const parsed = ticketSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : null;
    }
    catch {
        return null;
    }
}
export async function listTickets(teamName) {
    let names;
    try {
        names = await readdir(ticketsDir(teamName));
    }
    catch {
        return [];
    }
    const tickets = [];
    for (const name of names) {
        if (!name.endsWith('.json'))
            continue;
        const ticket = await readTicket(teamName, name.slice(0, -5));
        if (ticket)
            tickets.push(ticket);
    }
    return tickets.sort((a, b) => a.createdAt - b.createdAt);
}
// ---------------------------------------------------------------------------
// 操作
// ---------------------------------------------------------------------------
export async function createTicket(params) {
    const now = Date.now();
    const ticket = {
        schemaVersion: 1,
        id: `ticket-${randomUUID()}`,
        teamName: params.teamName,
        subject: params.subject,
        ...(params.description ? { description: params.description } : {}),
        status: 'open',
        createdBy: params.createdBy,
        createdAt: now,
        updatedAt: now,
        mandates: params.mandateStatement
            ? [{ id: `mandate-${randomUUID()}`, issuedBy: params.createdBy, statement: params.mandateStatement, createdAt: now }]
            : [],
        assignments: (params.assignees ?? []).map((entry) => ({
            id: `assign-${randomUUID()}`,
            assignee: entry.assignee,
            status: 'pending',
            createdAt: now,
            updatedAt: now,
        })),
        subscribers: [],
        thread: [],
    };
    await writeTicket(ticket);
    return ticket;
}
/**
 * 追加一个 Mandate。**已存在的 Mandate 永不被修改** —— 要改语义只能新建一个并撤销旧的，
 * 这样每次「改主意」都留下一条可审计的记录。
 */
export async function addMandate(teamName, ticketId, params) {
    return withTicketLock(teamName, ticketId, async () => {
        const ticket = await readTicket(teamName, ticketId);
        if (!ticket)
            throw new TeamTicketError(`工单 ${ticketId} 不存在`, 404);
        const now = Date.now();
        if (params.revokes) {
            const old = ticket.mandates.find((mandate) => mandate.id === params.revokes);
            if (!old)
                throw new TeamTicketError(`Mandate ${params.revokes} 不存在`, 404);
            if (old.revokedBy)
                throw new TeamTicketError(`Mandate ${params.revokes} 已被 ${old.revokedBy} 撤销`, 409);
        }
        const mandate = {
            id: `mandate-${randomUUID()}`,
            issuedBy: params.issuedBy,
            statement: params.statement,
            createdAt: now,
        };
        const next = {
            ...ticket,
            updatedAt: now,
            mandates: [
                ...ticket.mandates.map((existing) => params.revokes && existing.id === params.revokes ? { ...existing, revokedBy: mandate.id } : existing),
                mandate,
            ],
        };
        await writeTicket(next);
        return { ticket: next, mandate };
    });
}
/** 改 Mandate 的内容一律拒绝：不可变是这套模型的核心约束。 */
export async function updateMandate() {
    throw new TeamTicketError('Mandate 不可变：如需变更，请新建 Mandate 并用 revokes 显式撤销旧的。', 409);
}
export async function addAssignment(teamName, ticketId, params) {
    return withTicketLock(teamName, ticketId, async () => {
        const ticket = await readTicket(teamName, ticketId);
        if (!ticket)
            throw new TeamTicketError(`工单 ${ticketId} 不存在`, 404);
        if (ticket.status === 'ended')
            throw new TeamTicketError('工单已结束，不能再派活', 409);
        const now = Date.now();
        const assignment = {
            id: `assign-${randomUUID()}`,
            assignee: params.assignee,
            status: 'pending',
            createdAt: now,
            updatedAt: now,
        };
        const next = { ...ticket, updatedAt: now, assignments: [...ticket.assignments, assignment] };
        await writeTicket(next);
        return { ticket: next, assignment };
    });
}
/**
 * 推进一个 Assignment 的状态。同一 ticket 的多个 assignment 各自独立，
 * 所以这里按 assignment id 定位，不会碰到兄弟 assignment。
 */
export async function setAssignmentStatus(teamName, ticketId, assignmentId, params) {
    return withTicketLock(teamName, ticketId, async () => {
        const ticket = await readTicket(teamName, ticketId);
        if (!ticket)
            throw new TeamTicketError(`工单 ${ticketId} 不存在`, 404);
        const current = ticket.assignments.find((assignment) => assignment.id === assignmentId);
        if (!current)
            throw new TeamTicketError(`Assignment ${assignmentId} 不存在`, 404);
        if (current.status === 'ended')
            throw new TeamTicketError(`Assignment ${assignmentId} 已结束`, 409);
        const now = Date.now();
        const updated = {
            ...current,
            status: params.status,
            updatedAt: now,
            ...(params.result !== undefined ? { result: params.result } : {}),
            ...(params.outcome !== undefined ? { outcome: params.outcome } : {}),
        };
        const next = {
            ...ticket,
            updatedAt: now,
            assignments: ticket.assignments.map((assignment) => (assignment.id === assignmentId ? updated : assignment)),
        };
        await writeTicket(next);
        return { ticket: next, assignment: updated };
    });
}
export async function endTicket(teamName, ticketId) {
    return withTicketLock(teamName, ticketId, async () => {
        const ticket = await readTicket(teamName, ticketId);
        if (!ticket)
            throw new TeamTicketError(`工单 ${ticketId} 不存在`, 404);
        if (ticket.status === 'ended')
            return ticket;
        const now = Date.now();
        const next = { ...ticket, status: 'ended', endedAt: now, updatedAt: now };
        await writeTicket(next);
        return next;
    });
}
export async function setSubscribers(teamName, ticketId, subscribers) {
    return withTicketLock(teamName, ticketId, async () => {
        const ticket = await readTicket(teamName, ticketId);
        if (!ticket)
            throw new TeamTicketError(`工单 ${ticketId} 不存在`, 404);
        const unique = [...new Set(subscribers.map((name) => name.trim()).filter(Boolean))];
        const next = { ...ticket, subscribers: unique, updatedAt: Date.now() };
        await writeTicket(next);
        return next;
    });
}
/**
 * 往 ticket 的讨论帖追加一条，并返回「应当收到扇出的人」。
 *
 * 扇出对象 = 订阅者 − 发言者自己。调用方拿这个列表走既有的 teamBus 投递，
 * 不在这里另造一套投递机制。
 */
export async function postToThread(teamName, ticketId, params) {
    return withTicketLock(teamName, ticketId, async () => {
        const ticket = await readTicket(teamName, ticketId);
        if (!ticket)
            throw new TeamTicketError(`工单 ${ticketId} 不存在`, 404);
        const now = Date.now();
        const next = {
            ...ticket,
            updatedAt: now,
            thread: [...ticket.thread, { id: `post-${randomUUID()}`, from: params.from, text: params.text, at: now }],
        };
        await writeTicket(next);
        return { ticket: next, fanout: next.subscribers.filter((name) => name !== params.from) };
    });
}
// ---------------------------------------------------------------------------
// Read receipt（设计文档 §10 Phase 4 步骤 3）
// ---------------------------------------------------------------------------
/**
 * 一条消息的已读回执。落盘在 `acks/` 下，与邮箱分离 ——
 * 邮箱记录「投递了什么」，acks 记录「谁确认读过了」。
 */
export const receiptSchema = z.object({
    messageId: z.string().min(1),
    reader: z.string().min(1),
    ackedAt: z.number(),
});
const acksDir = (teamName) => join(getTeamDir(teamName), 'acks');
const acksPath = (teamName) => join(acksDir(teamName), 'receipts.jsonl');
/**
 * 记一条 ack。同一个 (messageId, reader) 重复 ack 只保留一次 —— 覆盖写整份文件，
 * 所以调用方不需要去重。
 */
export async function recordAck(teamName, messageId, reader) {
    const dir = acksDir(teamName);
    await mkdir(dir, { recursive: true });
    const path = acksPath(teamName);
    const release = await lockfile.lock(path, {
        lockfilePath: `${path}.lock`,
        realpath: false,
        retries: { retries: 10, minTimeout: 5, maxTimeout: 100 },
    }).catch(async () => {
        // 目标不存在时先落一个空文件再锁。
        await writeFile(path, '', { encoding: 'utf-8', flag: 'wx' }).catch(() => { });
        return lockfile.lock(path, {
            lockfilePath: `${path}.lock`,
            realpath: false,
            retries: { retries: 10, minTimeout: 5, maxTimeout: 100 },
        });
    });
    try {
        const existing = await readReceipts(teamName);
        const receipt = { messageId, reader, ackedAt: Date.now() };
        const merged = existing.filter((entry) => !(entry.messageId === messageId && entry.reader === reader));
        merged.push(receipt);
        const temp = `${path}.${randomUUID()}.tmp`;
        try {
            await writeFile(temp, merged.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
            await rename(temp, path);
        }
        finally {
            await unlink(temp).catch(() => { });
        }
        return receipt;
    }
    finally {
        await release().catch(() => { });
    }
}
export async function readReceipts(teamName) {
    try {
        const raw = await readFile(acksPath(teamName), 'utf8');
        return raw
            .split('\n')
            .filter((line) => line.trim())
            .flatMap((line) => {
            const parsed = receiptSchema.safeParse(JSON.parse(line));
            return parsed.success ? [parsed.data] : [];
        });
    }
    catch {
        return [];
    }
}
/**
 * 「未 ack 回 Eval」：给定应该确认的消息与应该确认它们的人，
 * 返回还没确认的组合。设计文档要求未确认的要能回到待处理状态，
 * 所以这里只做查询，重投交给调用方。
 */
export async function listUnacked(teamName, expected) {
    const receipts = await readReceipts(teamName);
    const acked = new Set(receipts.map((receipt) => `${receipt.messageId}\u0000${receipt.reader}`));
    const missing = [];
    for (const entry of expected) {
        for (const reader of entry.readers) {
            if (!acked.has(`${entry.messageId}\u0000${reader}`))
                missing.push({ messageId: entry.messageId, reader });
        }
    }
    return missing;
}
//# sourceMappingURL=teamTickets.js.map