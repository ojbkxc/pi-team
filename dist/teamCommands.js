/**
 * 团队斜杠命令（4 个，跨端）：/team、/team-create、/team-plan、/team-status。
 *
 * 经 t1 兼容层的 `compat.registerCommand` 注册 —— 两端签名兼容
 * （`name + { description?, getArgumentCompletions?, handler }`），命令会自动上到宿主斜杠面板。
 * 命令上下文用 compat 归一化后的 `CompatContext`（`notify` 等），因此两端行为一致。
 *
 * 注意：参数补全必须是**同步**返回（oh-my-pi 只同步取用），所以这里用 readdirSync 列出团队。
 */
import { readdirSync } from 'node:fs';
import { TEAM_LEAD_NAME, getTeamsDir } from './constants.js';
import { readTeamFileAsync } from './teamHelpers.js';
import { readTeamPlan } from './teamPlanStore.js';
import { claimMailboxMessages, formatTeammateMessages, readUnreadMessages, } from './teammateMailbox.js';
function currentTeamName() {
    return process.env.PI_TEAM_NAME;
}
function currentAgentName() {
    return process.env.PI_AGENT_NAME;
}
/** 同步列出团队名（供参数补全；补全端点只同步取用）。 */
function listTeamNamesSync() {
    try {
        return readdirSync(getTeamsDir(), { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name);
    }
    catch {
        return [];
    }
}
function teamNameCompletions(prefix) {
    const items = listTeamNamesSync()
        .filter((name) => name.startsWith(prefix))
        .map((name) => ({ value: name, label: name }));
    return items.length > 0 ? items : null;
}
export function registerTeamCommands(compat, _runtime) {
    // --- /team -------------------------------------------------------------
    compat.registerCommand('team', {
        description: '查看团队状态：成员（含生命周期）、计划、任务、欠我回复的成员',
        getArgumentCompletions: teamNameCompletions,
        async handler(args, ctx) {
            const requested = args.trim();
            const teamName = requested || currentTeamName();
            const names = teamName ? [teamName] : listTeamNamesSync();
            if (names.length === 0) {
                ctx.notify?.('暂无团队。用 team_create 工具创建一个。', 'info');
                return;
            }
            const lines = [];
            for (const name of names) {
                const team = await readTeamFileAsync(name);
                if (!team)
                    continue;
                lines.push(`团队：${name}${team.description ? ` — ${team.description}` : ''}`);
                for (const member of team.members) {
                    const flag = member.name === TEAM_LEAD_NAME ? '*' : '-';
                    lines.push(`  ${flag} ${member.name}${member.agentType ? ` [${member.agentType}]` : ''}${member.isActive === false ? '（已停止）' : ''}`);
                }
                const plan = await readTeamPlan(name).catch(() => null);
                if (plan) {
                    lines.push(`  计划：${plan.state}（revision ${plan.revision}）`);
                    for (const task of plan.tasks) {
                        lines.push(`    - [${task.id}] ${task.subject}${task.ownerId ? ` → ${task.ownerId}` : ''}${task.dependencies.length ? `（依赖：${task.dependencies.join(', ')}）` : ''}`);
                    }
                }
                lines.push('');
            }
            ctx.notify?.(lines.join('\n').trim(), 'info');
        },
    });
    // --- /team-create ------------------------------------------------------
    compat.registerCommand('team-create', {
        description: '创建团队：/team-create <名称> [描述]（随后用 team_create 工具加成员）',
        async handler(args, ctx) {
            const [name, ...rest] = args.trim().split(/\s+/).filter(Boolean);
            if (!name) {
                ctx.notify?.('用法：/team-create <团队名> [描述]。', 'warning');
                return;
            }
            const description = rest.join(' ');
            ctx.notify?.(`请用 team_create 工具创建团队：team_name="${name}"${description ? `，description="${description}"` : ''}，并在 members 里列出成员及其 prompt。`, 'info');
        },
    });
    // --- /team-plan --------------------------------------------------------
    compat.registerCommand('team-plan', {
        description: '查看当前团队计划（状态、版本、成员、任务）',
        getArgumentCompletions: teamNameCompletions,
        async handler(args, ctx) {
            const teamName = args.trim() || currentTeamName();
            if (!teamName) {
                ctx.notify?.('当前会话没有团队上下文；可传入团队名：/team-plan <团队名>。', 'warning');
                return;
            }
            const plan = await readTeamPlan(teamName).catch(() => null);
            if (!plan) {
                ctx.notify?.(`团队 "${teamName}" 尚无计划。`, 'info');
                return;
            }
            const lines = [
                `计划 ${plan.planId}`,
                `状态：${plan.state}（revision ${plan.revision}）`,
                '',
                '成员：',
                ...plan.members.map((member) => `  ${member.id}：${member.name} [${member.runtime.providerId}/${member.runtime.modelId}]`),
                '',
                '任务：',
                ...plan.tasks.map((task) => `  [${task.id}] ${task.subject} → ${task.ownerId || '(未分配)'}${task.dependencies.length ? ` | 依赖：${task.dependencies.join(', ')}` : ''}`),
            ];
            ctx.notify?.(lines.join('\n'), 'info');
        },
    });
    // --- /team-status ------------------------------------------------------
    compat.registerCommand('team-status', {
        description: '检查当前成员的邮箱未读消息并投递进对话',
        getArgumentCompletions: teamNameCompletions,
        async handler(args, ctx) {
            const teamName = args.trim() || currentTeamName();
            if (!teamName) {
                ctx.notify?.('当前会话没有团队上下文；可传入团队名：/team-status <团队名>。', 'warning');
                return;
            }
            const team = await readTeamFileAsync(teamName);
            if (!team) {
                ctx.notify?.(`团队 "${teamName}" 不存在。`, 'error');
                return;
            }
            const me = currentAgentName() || TEAM_LEAD_NAME;
            const unread = await readUnreadMessages(me, teamName);
            if (unread.length === 0) {
                ctx.notify?.('没有未读消息。', 'info');
                return;
            }
            const claimed = await claimMailboxMessages(me, teamName, unread);
            if (!claimed) {
                ctx.notify?.('邮箱繁忙，请稍后再试。', 'warning');
                return;
            }
            const formatted = formatTeammateMessages(claimed);
            const sent = compat.sendMessage
                ? (compat.sendMessage({ customType: 'teammate-messages', content: formatted, display: true }, { triggerTurn: true, deliverAs: 'followUp' }),
                    true)
                : false;
            if (!sent) {
                ctx.notify?.(`宿主不支持 sendMessage，无法投递 ${claimed.length} 条消息；内容：\n${formatted}`, 'warning');
                return;
            }
            ctx.notify?.(`已投递 ${claimed.length} 条消息。`, 'info');
        },
    });
}
//# sourceMappingURL=teamCommands.js.map