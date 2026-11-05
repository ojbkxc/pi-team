/**
 * Team plan store — extracted from cc-haha's swarm/teamPlanStore.ts
 *
 * Changes from original:
 * - envUtils.getTeamsDir → constants.getTeamsDir (~/.pi/agent/teams)
 * - tasks.js lifecycle lock → proper-lockfile on plan.json
 * - Removed cc-haha internal deps
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import * as lockfile from 'proper-lockfile';
import { isValidTeamMemberName, teamPlanRecordSchema, } from './teamPlan.js';
import { getTeamsDir } from './constants.js';
import { getTeamDir, readTeamFileAsync } from './teamHelpers.js';
export class TeamPlanError extends Error {
    status;
    constructor(message, status = 409) {
        super(message);
        this.status = status;
    }
}
const planPath = (name) => join(getTeamDir(name), 'plan.json');
async function locked(teamName, run) {
    const path = planPath(teamName);
    await mkdir(getTeamDir(teamName), { recursive: true });
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
async function incarnation(teamName, sessionId) {
    const team = await readTeamFileAsync(teamName);
    if (!team || team.leadSessionId !== sessionId)
        throw new TeamPlanError('Team does not belong to this session', 404);
    return createHash('sha256').update(JSON.stringify([team.name, team.leadSessionId ?? '', team.createdAt])).digest('hex');
}
/** Legacy teams without plan.json remain legacy; never infer an approval from config.json. */
export async function readTeamPlan(teamName) {
    let raw;
    try {
        raw = JSON.parse(await readFile(planPath(teamName), 'utf8'));
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return null;
        throw error;
    }
    const parsed = teamPlanRecordSchema.safeParse(raw);
    if (!parsed.success)
        throw new TeamPlanError('Unsupported or invalid persisted team plan', 409);
    return parsed.data;
}
async function writePlan(plan, path = planPath(plan.teamName)) {
    await mkdir(getTeamDir(plan.teamName), { recursive: true });
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
        await writeFile(temp, JSON.stringify(teamPlanRecordSchema.parse(plan), null, 2));
        await rename(temp, path);
    }
    finally {
        await unlink(temp).catch(() => { });
    }
}
export function validateTeamPlanGraph(plan, runnable = false) {
    for (const member of plan.members) {
        if (!isValidTeamMemberName(member.name))
            throw new TeamPlanError(`Invalid teammate name: ${member.name}. Use letters, numbers, underscores or hyphens; "team-lead" is reserved.`, 400);
    }
    const memberIds = new Set(plan.members.map(member => member.id));
    const names = new Set(plan.members.map(member => member.name));
    const tasks = new Map(plan.tasks.map(task => [task.id, task]));
    if (memberIds.size !== plan.members.length || names.size !== plan.members.length || tasks.size !== plan.tasks.length)
        throw new TeamPlanError('Member names and IDs and task IDs must be unique', 400);
    if (runnable && (plan.members.length === 0 || plan.tasks.length === 0))
        throw new TeamPlanError('Plan needs members and assigned tasks', 400);
    if (runnable && plan.members.some(member => !plan.tasks.some(task => task.ownerId === member.id)))
        throw new TeamPlanError('Every member needs an assigned task', 400);
    const visiting = new Set(), visited = new Set();
    const visit = (id) => {
        if (visited.has(id))
            return;
        if (visiting.has(id))
            throw new TeamPlanError('Task dependency cycle', 400);
        const task = tasks.get(id);
        if (!task)
            throw new TeamPlanError(`Unknown dependency: ${id}`, 400);
        if (runnable && !task.ownerId)
            throw new TeamPlanError('Every task needs an assigned member', 400);
        if (task.ownerId && !memberIds.has(task.ownerId))
            throw new TeamPlanError(`Unknown task owner: ${task.ownerId}`, 400);
        visiting.add(id);
        task.dependencies.forEach(visit);
        visiting.delete(id);
        visited.add(id);
    };
    plan.tasks.forEach(task => visit(task.id));
}
export async function ensureTeamDraft(teamName, sessionId, leaderRuntime, initial = {}) {
    return locked(teamName, async () => {
        const incarnationId = await incarnation(teamName, sessionId);
        const existing = await readTeamPlan(teamName);
        if (existing && existing.incarnationId === incarnationId)
            return existing;
        const now = Date.now();
        const plan = teamPlanRecordSchema.parse({ schemaVersion: 1, planId: randomUUID(), sessionId, teamName, incarnationId, revision: 1, state: 'draft', workDir: initial.workDir ?? process.cwd(), leaderRuntime, agentCatalog: initial.agentCatalog, members: initial.members ?? [], tasks: initial.tasks ?? [], createdAt: now, updatedAt: now });
        validateTeamPlanGraph(plan);
        await writePlan(plan);
        return plan;
    });
}
async function requireCurrent(teamName, identity) {
    const plan = await readTeamPlan(teamName);
    if (!plan || plan.planId !== identity.planId || plan.sessionId !== identity.sessionId || plan.incarnationId !== identity.incarnationId || await incarnation(teamName, identity.sessionId) !== identity.incarnationId)
        throw new TeamPlanError('Plan identity changed; refresh before continuing');
    return plan;
}
export async function mutateTeamPlan(teamName, identity, update) {
    return locked(teamName, async () => {
        const plan = await requireCurrent(teamName, identity);
        if (plan.revision !== identity.expectedRevision)
            throw new TeamPlanError('Plan changed; refresh before continuing');
        const next = await update(structuredClone(plan));
        next.revision = plan.revision + 1;
        next.updatedAt = Date.now();
        validateTeamPlanGraph(next);
        await writePlan(next);
        return next;
    });
}
function preserveRuntimeExtensions(previous, next) {
    if (!previous)
        return next;
    const { providerId: _provider, modelId: _model, effortLevel: _effort, ...extensions } = previous;
    return { ...extensions, ...next };
}
function applyDraftPatch(plan, patch, preserveHumanRuntime) {
    return { ...plan, ...patch,
        ...(patch.members ? { members: patch.members.map(member => {
                const previous = plan.members.find(item => item.id === member.id);
                return { ...previous, ...member, runtime: preserveRuntimeExtensions(previous?.runtime, member.runtime),
                    ...(preserveHumanRuntime && previous?.runtimeSource === 'human' ? { runtime: previous.runtime, runtimeSource: 'human', suggestedRuntime: member.suggestedRuntime ?? member.runtime } : {}),
                };
            }) } : {}),
        ...(patch.tasks ? { tasks: patch.tasks.map(task => ({ ...plan.tasks.find(previous => previous.id === task.id), ...task })) } : {}),
    };
}
export function replaceTeamPlan(teamName, identity, patch, options = {}) {
    return mutateTeamPlan(teamName, identity, plan => {
        if (plan.state !== 'draft' && plan.state !== 'review_pending')
            throw new TeamPlanError('Only a draft or pending review can be edited');
        return { ...applyDraftPatch(plan, patch, !options.preserveReview), state: options.preserveReview ? plan.state : 'draft' };
    });
}
/** A complete model proposal becomes reviewable in one revision and one lock transaction. */
export function submitTeamPlan(teamName, identity, patch) {
    return mutateTeamPlan(teamName, identity, plan => {
        if (plan.state !== 'draft' && plan.state !== 'review_pending')
            throw new TeamPlanError('Plan cannot be submitted');
        const next = patch ? applyDraftPatch(plan, patch, true) : plan;
        validateTeamPlanGraph(next, true);
        return { ...next, state: 'review_pending' };
    });
}
export async function stageMember(teamName, member) {
    return locked(teamName, async () => {
        let plan = await readTeamPlan(teamName);
        if (!plan)
            throw new TeamPlanError('Create the team draft first');
        await requireCurrent(teamName, { ...plan, expectedRevision: plan.revision });
        if (await isTeamExecutionApproved(teamName, member.name))
            throw new TeamPlanError(`A running team already has member ${member.name}. Give it more work with team_message instead; a stopped member restarts from its saved conversation when messaged.`);
        if (plan.state === 'running') {
            await writeFile(join(getTeamDir(teamName), `plan-${plan.planId}.json`), JSON.stringify(plan, null, 2));
            plan = { ...plan, parentPlanId: plan.planId, planId: randomUUID(), revision: 0, state: 'draft', members: [], tasks: [], approvedSnapshot: undefined, launch: undefined };
        }
        if (plan.state !== 'draft' && plan.state !== 'review_pending')
            throw new TeamPlanError('Plan is not editable');
        const previous = plan.members.find(item => item.id === member.id || item.name === member.name);
        const value = { ...previous, ...member, runtime: preserveRuntimeExtensions(previous?.runtime, member.runtime), id: previous?.id ?? member.id,
            ...(previous?.runtimeSource === 'human' ? { runtime: previous.runtime, runtimeSource: 'human', suggestedRuntime: member.suggestedRuntime ?? member.runtime } : {}),
        };
        plan.members = [...plan.members.filter(item => item !== previous), value];
        plan.state = 'draft';
        plan.revision++;
        plan.updatedAt = Date.now();
        validateTeamPlanGraph(plan);
        await writePlan(plan);
        return plan;
    });
}
/**
 * The user changed a running member's model after approval. A restart rebuilds
 * the member from the approved snapshot, so the snapshot and the live record
 * change together; nothing else the user approved does.
 */
export async function setRunningMemberRuntime(teamName, planId, memberId, runtime, providerName) {
    return locked(teamName, async () => {
        const current = await readTeamPlan(teamName);
        let plan = current?.planId === planId ? current : null;
        let path = planPath(teamName);
        if (!plan) {
            // Archive identities are generated UUIDs; never turn input into a path.
            if (!/^[a-f0-9-]{36}$/i.test(planId))
                throw new TeamPlanError('Team plan not found', 404);
            path = join(getTeamDir(teamName), `plan-${planId}.json`);
            try {
                plan = teamPlanRecordSchema.parse(JSON.parse(await readFile(path, 'utf8')));
            }
            catch {
                throw new TeamPlanError('Team plan not found', 404);
            }
        }
        if (plan.state !== 'running' || !plan.approvedSnapshot)
            throw new TeamPlanError('Only a member of a running team can change its model');
        if (!plan.approvedSnapshot.members.some(member => member.id === memberId))
            throw new TeamPlanError('Member not found in this team', 404);
        const apply = (member) => member.id === memberId
            ? { ...member, runtime: preserveRuntimeExtensions(member.runtime, runtime), providerName }
            : member;
        const next = {
            ...plan,
            members: plan.members.map(apply),
            approvedSnapshot: { ...plan.approvedSnapshot, members: plan.approvedSnapshot.members.map(apply) },
            revision: plan.revision + 1,
            updatedAt: Date.now(),
        };
        await writePlan(next, path);
        return next;
    });
}
export async function findTeamPlanForSession(sessionId) {
    let names;
    try {
        names = await readdir(getTeamsDir());
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return null;
        throw error;
    }
    const plans = await Promise.all(names.map(async (name) => {
        let plan;
        try {
            plan = await readTeamPlan(name);
        }
        catch {
            return null;
        }
        if (!plan || plan.sessionId !== sessionId)
            return null;
        try {
            return await incarnation(name, sessionId) === plan.incarnationId ? plan : null;
        }
        catch {
            return null;
        }
    }));
    return plans.filter((plan) => plan !== null).sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
}
/** Every current plan whose lead is paused until a person approves it (one per session). */
export async function listTeamPlansAwaitingReview() {
    let names;
    try {
        names = await readdir(getTeamsDir());
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return [];
        throw error;
    }
    const plans = await Promise.all(names.map(async (name) => {
        let plan;
        try {
            plan = await readTeamPlan(name);
        }
        catch {
            return null;
        }
        if (!plan || plan.state !== 'review_pending')
            return null;
        try {
            return await incarnation(name, plan.sessionId) === plan.incarnationId ? plan : null;
        }
        catch {
            return null;
        }
    }));
    const latest = new Map();
    for (const plan of plans) {
        if (!plan)
            continue;
        const known = latest.get(plan.sessionId);
        if (!known || plan.updatedAt > known.updatedAt)
            latest.set(plan.sessionId, plan);
    }
    return [...latest.values()];
}
export async function isTeamExecutionApproved(teamName, memberName) {
    const plan = await readTeamPlan(teamName);
    if (!plan)
        return false;
    if (await incarnation(teamName, plan.sessionId) !== plan.incarnationId)
        return false;
    if ((plan.state === 'launching' || plan.state === 'running') && plan.approvedSnapshot && (!memberName || plan.approvedSnapshot.members.some(member => member.name === memberName || member.id === memberName)))
        return true;
    let parentPlanId = memberName ? plan.parentPlanId : undefined;
    const visited = new Set();
    while (parentPlanId && !visited.has(parentPlanId)) {
        visited.add(parentPlanId);
        // Archive identities are generated UUIDs; never turn persisted input into a path.
        if (!/^[a-f0-9-]{36}$/i.test(parentPlanId))
            return false;
        let archived;
        try {
            archived = teamPlanRecordSchema.parse(JSON.parse(await readFile(join(getTeamDir(teamName), `plan-${parentPlanId}.json`), 'utf8')));
        }
        catch {
            return false;
        }
        if (archived.incarnationId !== plan.incarnationId)
            return false;
        if (archived.state === 'running' && archived.approvedSnapshot?.members.some(member => member.name === memberName || member.id === memberName))
            return true;
        parentPlanId = archived.parentPlanId;
    }
    return false;
}
export async function approveTeamPlan(teamName, identity, requestId, validated) {
    if (!requestId.trim())
        throw new TeamPlanError('requestId is required', 400);
    return locked(teamName, async () => {
        const plan = await requireCurrent(teamName, identity);
        if (plan.approvedSnapshot?.requestId === requestId)
            return { plan, committed: false };
        if (plan.revision !== identity.expectedRevision || validated.revision !== plan.revision)
            throw new TeamPlanError('Plan changed; review it again');
        if (plan.state !== 'review_pending')
            throw new TeamPlanError('Plan is not awaiting review');
        validateTeamPlanGraph(validated, true);
        const now = Date.now();
        const next = { ...plan, members: validated.members, state: 'launching', revision: plan.revision + 1, updatedAt: now, approvedSnapshot: { revision: plan.revision, members: structuredClone(validated.members), tasks: structuredClone(plan.tasks), leaderRuntime: structuredClone(plan.leaderRuntime), approvedAt: now, requestId }, launch: { ...plan.launch, status: 'pending' } };
        await writePlan(next);
        return { plan: next, committed: true };
    });
}
/**
 * 领取一次待执行的 launch（Phase 4 步骤 5：审批后自动派发成员）。
 *
 * `approveTeamPlan()` 只把 state 置为 `launching` 且 `launch.status = 'pending'`，没有任何人
 * 消费它 —— 计划批准后就永久停在那里。本函数是那个消费入口：原子地（持 plan 锁）把
 * pending 认领成 running，并在返回值里给出要派发的成员快照。
 *
 * 幂等靠状态机而不是调用方自觉：第二次调用时 status 已不是 `pending`，返回 null，
 * 于是重复批准/重复触发都不会重复 spawn。
 */
export async function claimPlanLaunch(teamName) {
    return locked(teamName, async () => {
        let plan;
        try {
            plan = teamPlanRecordSchema.parse(JSON.parse(await readFile(planPath(teamName), 'utf8')));
        }
        catch {
            return null;
        }
        if (plan.state !== 'launching' || plan.launch?.status !== 'pending')
            return null;
        const members = plan.approvedSnapshot?.members ?? plan.members;
        const next = {
            ...plan,
            revision: plan.revision + 1,
            updatedAt: Date.now(),
            launch: { ...plan.launch, status: 'running' },
        };
        await writePlan(next);
        return { plan: next, members: structuredClone(members) };
    });
}
/** 全部成员派发完成：`launching` → `running`，并记下成员名到会话 ID 的映射。 */
export async function completePlanLaunch(teamName, memberIds) {
    return locked(teamName, async () => {
        let plan;
        try {
            plan = teamPlanRecordSchema.parse(JSON.parse(await readFile(planPath(teamName), 'utf8')));
        }
        catch {
            return null;
        }
        if (plan.launch?.status !== 'running')
            return null;
        const next = {
            ...plan,
            state: 'running',
            revision: plan.revision + 1,
            updatedAt: Date.now(),
            launch: { ...plan.launch, status: 'running', memberIds: { ...plan.launch.memberIds, ...memberIds } },
        };
        await writePlan(next);
        return next;
    });
}
/** 派发失败：记下错误供界面显示，避免计划无声地卡在 launching。 */
export async function failPlanLaunch(teamName, error) {
    return locked(teamName, async () => {
        let plan;
        try {
            plan = teamPlanRecordSchema.parse(JSON.parse(await readFile(planPath(teamName), 'utf8')));
        }
        catch {
            return null;
        }
        const next = {
            ...plan,
            state: 'launch_failed',
            revision: plan.revision + 1,
            updatedAt: Date.now(),
            launch: { ...plan.launch, status: 'failed', error },
        };
        await writePlan(next);
        return next;
    });
}
//# sourceMappingURL=teamPlanStore.js.map