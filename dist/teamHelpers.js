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
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { access, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as lockfile from 'proper-lockfile';
import { getTeamsDir, TEAM_LEAD_NAME } from './constants.js';
export function isValidTeamFile(value) {
    return (typeof value === 'object' &&
        value !== null &&
        Array.isArray(value.members));
}
/**
 * Sanitizes a name for use in file paths.
 * Replaces all non-alphanumeric characters with hyphens and lowercases.
 */
export function sanitizeName(name) {
    return name.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
}
/**
 * Sanitizes an agent name for use in deterministic agent IDs.
 */
export function sanitizeAgentName(name) {
    return name.replace(/@/g, '-');
}
/**
 * Sanitizes a path component to prevent directory traversal.
 */
export function sanitizePathComponent(name) {
    return name.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^\.+/, '');
}
/**
 * Gets the path to a team's directory
 */
export function getTeamDir(teamName) {
    return join(getTeamsDir(), sanitizeName(teamName));
}
/**
 * Gets the path to a team's config.json file
 */
export function getTeamFilePath(teamName) {
    return join(getTeamDir(teamName), 'config.json');
}
function getErrnoCode(error) {
    const code = error?.code;
    return typeof code === 'string' ? code : undefined;
}
function logDebug(message) {
    // Minimal debug logging — no cc-haha debug dependency
    if (process.env.PI_TEAM_DEBUG)
        console.error(`[pi-team] ${message}`);
}
/**
 * Reads a team file by name (sync — for sync contexts)
 */
export function readTeamFile(teamName) {
    try {
        const content = readFileSync(getTeamFilePath(teamName), 'utf-8');
        const parsed = JSON.parse(content);
        return isValidTeamFile(parsed) ? parsed : null;
    }
    catch (e) {
        if (getErrnoCode(e) === 'ENOENT')
            return null;
        logDebug(`Failed to read team file for ${teamName}: ${e}`);
        return null;
    }
}
/**
 * Reads a team file by name (async)
 */
export async function readTeamFileAsync(teamName) {
    try {
        const content = await readFile(getTeamFilePath(teamName), 'utf-8');
        const parsed = JSON.parse(content);
        return isValidTeamFile(parsed) ? parsed : null;
    }
    catch (e) {
        if (getErrnoCode(e) === 'ENOENT')
            return null;
        logDebug(`Failed to read team file for ${teamName}: ${e}`);
        return null;
    }
}
/**
 * Every name, agent id and session id by which a member of a team led by
 * `leadSessionId` can be addressed.
 */
export async function listLeadTeamMemberIdentities(leadSessionId) {
    let teamNames;
    try {
        teamNames = await readdir(getTeamsDir());
    }
    catch {
        return [];
    }
    const identities = [];
    for (const teamName of teamNames) {
        const team = readTeamFile(teamName);
        if (team?.leadSessionId !== leadSessionId)
            continue;
        for (const member of team.members) {
            if (member.name === TEAM_LEAD_NAME)
                continue;
            identities.push(member.name, member.agentId);
            if (member.sessionId)
                identities.push(member.sessionId);
        }
    }
    return identities;
}
// Call only while holding the config lock. Readers need no lock: rename
// exposes either the complete previous config or the complete replacement.
async function replaceTeamFileAsync(teamName, content) {
    const targetPath = getTeamFilePath(teamName);
    const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporaryPath, content, {
            encoding: 'utf-8',
            flag: 'wx',
            mode: 0o600,
        });
        for (let attempt = 0;; attempt++) {
            try {
                await rename(temporaryPath, targetPath);
                break;
            }
            catch (error) {
                // Windows readers can briefly prevent replacement.
                if (process.platform !== 'win32' || attempt >= 5 ||
                    !['EPERM', 'EACCES', 'EBUSY'].includes(getErrnoCode(error) ?? ''))
                    throw error;
                await new Promise(resolve => setTimeout(resolve, 10 * (attempt + 1)));
            }
        }
    }
    finally {
        await rm(temporaryPath, { force: true });
    }
}
async function withTeamFileLock(teamName, action) {
    const teamFilePath = getTeamFilePath(teamName);
    const release = await lockfile.lock(teamFilePath, {
        lockfilePath: `${teamFilePath}.lock`,
        realpath: false,
        retries: { retries: 10, minTimeout: 5, maxTimeout: 100 },
    });
    try {
        return await action();
    }
    finally {
        await release();
    }
}
/**
 * Writes the initial team config. Updates must use mutateTeamFileAsync.
 */
export async function writeTeamFileAsync(teamName, teamFile) {
    const teamDir = getTeamDir(teamName);
    await mkdir(teamDir, { recursive: true });
    await withTeamFileLock(teamName, () => replaceTeamFileAsync(teamName, JSON.stringify(teamFile, null, 2)));
}
class TeamFileNotFoundError extends Error {
    constructor(teamName) {
        super(`Team "${teamName}" does not exist`);
    }
}
/**
 * Atomically read-modify-write a team file under a file lock.
 */
export async function mutateTeamFileAsync(teamName, mutator) {
    try {
        await access(getTeamDir(teamName));
        return await withTeamFileLock(teamName, async () => {
            const current = await readTeamFileAsync(teamName);
            if (!isValidTeamFile(current)) {
                throw new TeamFileNotFoundError(teamName);
            }
            const previousContent = JSON.stringify(current, null, 2);
            const next = mutator(current) ?? current;
            const nextContent = JSON.stringify(next, null, 2);
            if (nextContent !== previousContent) {
                await replaceTeamFileAsync(teamName, nextContent);
            }
            return next;
        });
    }
    catch (error) {
        if (getErrnoCode(error) === 'ENOENT')
            throw new TeamFileNotFoundError(teamName);
        throw error;
    }
}
// Preserve the boolean helpers' missing-team behavior without swallowing
// lock or persistence failures.
async function mutateExistingTeamFileAsync(teamName, mutator) {
    let result = false;
    try {
        await mutateTeamFileAsync(teamName, teamFile => {
            result = mutator(teamFile);
        });
        return result;
    }
    catch (error) {
        if (error instanceof TeamFileNotFoundError)
            return false;
        throw error;
    }
}
/**
 * Removes a teammate from the team file by agent ID or name.
 */
export async function removeTeammateFromTeamFile(teamName, identifier) {
    const identifierStr = identifier.agentId || identifier.name;
    if (!identifierStr)
        return false;
    return mutateExistingTeamFileAsync(teamName, teamFile => {
        const originalLength = teamFile.members.length;
        teamFile.members = teamFile.members.filter(m => {
            if (identifier.agentId && m.agentId === identifier.agentId)
                return false;
            if (identifier.name && m.name === identifier.name)
                return false;
            return true;
        });
        return teamFile.members.length !== originalLength;
    });
}
/**
 * Sets a team member's active status.
 */
export async function setMemberActive(teamName, memberName, isActive) {
    await mutateTeamFileAsync(teamName, teamFile => {
        const member = teamFile.members.find(m => m.name === memberName);
        if (!member)
            return;
        if (member.isActive === isActive)
            return;
        return {
            ...teamFile,
            members: teamFile.members.map(current => current.name === memberName ? { ...current, isActive } : current),
        };
    });
}
/**
 * Sets a team member's permission mode.
 */
export async function setMemberMode(teamName, memberName, mode) {
    return mutateExistingTeamFileAsync(teamName, teamFile => {
        const member = teamFile.members.find(m => m.name === memberName);
        if (!member)
            return false;
        if (member.mode === mode)
            return true;
        teamFile.members = teamFile.members.map(m => m.name === memberName ? { ...m, mode } : m);
        return true;
    });
}
/**
 * List all team names on disk.
 */
export async function listTeamNames() {
    try {
        return await readdir(getTeamsDir());
    }
    catch {
        return [];
    }
}
/**
 * Delete a team directory entirely.
 */
export async function deleteTeamDir(teamName) {
    const teamDir = getTeamDir(teamName);
    await rm(teamDir, { recursive: true, force: true });
}
//# sourceMappingURL=teamHelpers.js.map