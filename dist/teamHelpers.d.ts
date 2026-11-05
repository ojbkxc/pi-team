/**
 * Team file helpers — extracted from cc-haha's teamHelpers.ts
 *
 * Changes from original:
 * - envUtils.getTeamsDir → fixed path ~/.pi/agent/teams/
 * - lockfile → proper-lockfile (direct import)
 * - Removed worktree/pane/tmux cleanup logic
 * - Removed cc-haha internal deps (tasks.js, teammate.js, debug.js, etc.)
 * - Kept TeamFile CRUD: readTeamFile, writeTeamFileAsync, mutateTeamFileAsync,
 *   getTeamDir, getTeamFilePath
 */
export type TeamAllowedPath = {
    path: string;
    toolName: string;
    addedBy: string;
    addedAt: number;
};
export type TeamFileMember = {
    agentId: string;
    name: string;
    agentType?: string;
    model?: string;
    providerId?: string | null;
    providerName?: string;
    effortLevel?: string;
    planMemberId?: string;
    terminated?: boolean;
    prompt?: string;
    color?: string;
    planModeRequired?: boolean;
    joinedAt: number;
    cwd: string;
    worktreePath?: string;
    sessionId?: string;
    subscriptions: string[];
    isActive?: boolean;
    mode?: string;
    lastError?: string;
    autoRetry?: {
        attempt: number;
        max: number;
        nextAt: number;
    };
    awaitingDependencies?: boolean;
};
export type TeamFile = {
    reviewRequired?: boolean;
    name: string;
    description?: string;
    createdAt: number;
    leadAgentId: string;
    leadSessionId?: string;
    hiddenPaneIds?: string[];
    teamAllowedPaths?: TeamAllowedPath[];
    members: TeamFileMember[];
};
export declare function isValidTeamFile(value: unknown): value is TeamFile;
/**
 * Sanitizes a name for use in file paths.
 * Replaces all non-alphanumeric characters with hyphens and lowercases.
 */
export declare function sanitizeName(name: string): string;
/**
 * Sanitizes an agent name for use in deterministic agent IDs.
 */
export declare function sanitizeAgentName(name: string): string;
/**
 * Sanitizes a path component to prevent directory traversal.
 */
export declare function sanitizePathComponent(name: string): string;
/**
 * Gets the path to a team's directory
 */
export declare function getTeamDir(teamName: string): string;
/**
 * Gets the path to a team's config.json file
 */
export declare function getTeamFilePath(teamName: string): string;
/**
 * Reads a team file by name (sync — for sync contexts)
 */
export declare function readTeamFile(teamName: string): TeamFile | null;
/**
 * Reads a team file by name (async)
 */
export declare function readTeamFileAsync(teamName: string): Promise<TeamFile | null>;
/**
 * Every name, agent id and session id by which a member of a team led by
 * `leadSessionId` can be addressed.
 */
export declare function listLeadTeamMemberIdentities(leadSessionId: string): Promise<string[]>;
/**
 * Writes the initial team config. Updates must use mutateTeamFileAsync.
 */
export declare function writeTeamFileAsync(teamName: string, teamFile: TeamFile): Promise<void>;
/**
 * Atomically read-modify-write a team file under a file lock.
 */
export declare function mutateTeamFileAsync(teamName: string, mutator: (teamFile: TeamFile) => TeamFile | void): Promise<TeamFile>;
/**
 * Removes a teammate from the team file by agent ID or name.
 */
export declare function removeTeammateFromTeamFile(teamName: string, identifier: {
    agentId?: string;
    name?: string;
}): Promise<boolean>;
/**
 * Sets a team member's active status.
 */
export declare function setMemberActive(teamName: string, memberName: string, isActive: boolean): Promise<void>;
/**
 * Sets a team member's permission mode.
 */
export declare function setMemberMode(teamName: string, memberName: string, mode: string): Promise<boolean>;
/**
 * List all team names on disk.
 */
export declare function listTeamNames(): Promise<string[]>;
/**
 * Delete a team directory entirely.
 */
export declare function deleteTeamDir(teamName: string): Promise<void>;
