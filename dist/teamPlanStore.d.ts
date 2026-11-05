/**
 * Team plan store — extracted from cc-haha's swarm/teamPlanStore.ts
 *
 * Changes from original:
 * - envUtils.getTeamsDir → constants.getTeamsDir (~/.pi/agent/teams)
 * - tasks.js lifecycle lock → proper-lockfile on plan.json
 * - Removed cc-haha internal deps
 */
import { type TeamPlanIdentity, type TeamPlanMember, type TeamPlanPatch, type TeamPlanRecord, type TeamPlanRuntime } from './teamPlan.js';
export declare class TeamPlanError extends Error {
    status: number;
    constructor(message: string, status?: number);
}
/** Legacy teams without plan.json remain legacy; never infer an approval from config.json. */
export declare function readTeamPlan(teamName: string): Promise<TeamPlanRecord | null>;
export declare function validateTeamPlanGraph(plan: Pick<TeamPlanRecord, 'members' | 'tasks'>, runnable?: boolean): void;
export declare function ensureTeamDraft(teamName: string, sessionId: string, leaderRuntime: TeamPlanRuntime, initial?: TeamPlanPatch & {
    workDir?: string;
}): Promise<TeamPlanRecord>;
export declare function mutateTeamPlan(teamName: string, identity: TeamPlanIdentity, update: (plan: TeamPlanRecord) => Promise<TeamPlanRecord> | TeamPlanRecord): Promise<TeamPlanRecord>;
export declare function replaceTeamPlan(teamName: string, identity: TeamPlanIdentity, patch: TeamPlanPatch, options?: {
    preserveReview?: boolean;
}): Promise<TeamPlanRecord>;
/** A complete model proposal becomes reviewable in one revision and one lock transaction. */
export declare function submitTeamPlan(teamName: string, identity: TeamPlanIdentity, patch?: TeamPlanPatch): Promise<TeamPlanRecord>;
export declare function stageMember(teamName: string, member: TeamPlanMember): Promise<TeamPlanRecord>;
/**
 * The user changed a running member's model after approval. A restart rebuilds
 * the member from the approved snapshot, so the snapshot and the live record
 * change together; nothing else the user approved does.
 */
export declare function setRunningMemberRuntime(teamName: string, planId: string, memberId: string, runtime: TeamPlanRuntime, providerName: string): Promise<TeamPlanRecord>;
export declare function findTeamPlanForSession(sessionId: string): Promise<TeamPlanRecord | null>;
/** Every current plan whose lead is paused until a person approves it (one per session). */
export declare function listTeamPlansAwaitingReview(): Promise<TeamPlanRecord[]>;
export declare function isTeamExecutionApproved(teamName: string, memberName?: string): Promise<boolean>;
export declare function approveTeamPlan(teamName: string, identity: TeamPlanIdentity, requestId: string, validated: TeamPlanRecord): Promise<{
    plan: TeamPlanRecord;
    committed: boolean;
}>;
