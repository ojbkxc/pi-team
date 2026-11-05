import { TEAM_HOST_GLOBAL_KEY, getAgentToolName } from './constants.js';
/** 团队成员终止状态判定。 */
export const TERMINAL_RUN_STATUSES = ['completed', 'failed', 'aborted'];
export function isTerminalRunStatus(status) {
    return TERMINAL_RUN_STATUSES.includes(status);
}
/** 什么都不做的桥：宿主未提供任何 spawn 能力时使用，所有 spawn 明确失败。 */
export function createNoopHost() {
    return {
        kind: 'none',
        async start() {
            throw new Error('宿主未提供子会话能力（未注入团队宿主桥）。团队数据与邮箱仍可用；请在宿主内置接线中注入 subagent runtime，或设置 PI_TEAM_AGENT_TOOL 指向可调用的生成工具。');
        },
        async revive() {
            throw new Error('宿主未提供子会话能力，无法复活成员。');
        },
        async get() {
            return null;
        },
        async steer() {
            throw new Error('宿主未提供子会话能力，无法向成员发送 steering。');
        },
        async stop() {
            throw new Error('宿主未提供子会话能力，无法停止成员。');
        },
        async wake() {
            return false;
        },
        onFinish() {
            return () => { };
        },
    };
}
/**
 * 工具桥：把「生成子会话」的宿主工具适配成 TeamHost。仅在宿主未注入全局桥时使用。
 * start 通过 ctx.executeTool(agentTool, {...}) 调用；wake 因缺少工具上下文而无法实现。
 */
export function createToolHost(agentTool = getAgentToolName()) {
    const listeners = new Set();
    const handles = new Map();
    const emit = (handle) => {
        handles.set(handle.sessionId, handle);
        for (const listener of listeners) {
            try {
                listener(handle);
            }
            catch {
                // 监听器异常不得打断派发
            }
        }
    };
    const readSessionId = (value) => {
        if (typeof value === 'string')
            return value;
        if (value && typeof value === 'object') {
            const record = value;
            for (const key of ['sessionId', 'session_id', 'agent_id', 'agentId', 'id']) {
                const found = record[key];
                if (typeof found === 'string' && found)
                    return found;
            }
        }
        return undefined;
    };
    const requireExecute = (ctx) => {
        const executeTool = ctx?.executeTool;
        if (!executeTool) {
            throw new Error(`工具桥需要执行 "${agentTool}" 的上下文，但当前调用未提供 executeTool。`);
        }
        return executeTool;
    };
    return {
        kind: 'tool',
        async start(request, ctx) {
            const executeTool = requireExecute(ctx);
            const result = await executeTool(agentTool, {
                prompt: request.task,
                subagent_type: request.profile,
                description: request.description,
                run_in_background: request.runInBackground ?? true,
                ...(request.model ? { model: request.model } : {}),
                ...(request.thinking ? { thinking: request.thinking } : {}),
                ...(request.isolation ? { isolation: request.isolation } : {}),
            });
            const sessionId = readSessionId(result);
            if (!sessionId) {
                throw new Error(`工具 "${agentTool}" 未返回可识别的会话 ID，无法登记成员。`);
            }
            const handle = { sessionId, status: 'running', description: request.description };
            handles.set(sessionId, handle);
            return handle;
        },
        async revive(request, ctx) {
            const executeTool = requireExecute(ctx);
            const result = await executeTool(agentTool, {
                resume: request.sessionId,
                prompt: request.task ?? '继续你之前的任务，并把结果回报给团队。',
                description: request.description ?? request.name ?? '复活成员',
                run_in_background: true,
            });
            const sessionId = readSessionId(result) ?? request.sessionId;
            const handle = { sessionId, status: 'revived', description: request.description };
            emit(handle);
            return handle;
        },
        async get(sessionId) {
            return handles.get(sessionId) ?? null;
        },
        async steer(sessionId, message, ctx) {
            const executeTool = requireExecute(ctx);
            await executeTool('steer_subagent', { agent_id: sessionId, message });
        },
        async stop(sessionId, ctx) {
            const executeTool = requireExecute(ctx);
            await executeTool('get_subagent_result', { agent_id: sessionId, wait: false });
        },
        async wake() {
            // 工具桥无法在定时器里获得工具上下文，唤醒降级为「留存在邮箱里等下次轮询/等待」。
            return false;
        },
        onFinish(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
}
/** 读取进程级全局桥。 */
export function getInjectedHost() {
    const host = globalThis[TEAM_HOST_GLOBAL_KEY];
    if (host && typeof host === 'object' && typeof host.start === 'function') {
        return host;
    }
    return undefined;
}
/** 注入进程级全局桥（供 pi-agent-desktop 内置接线调用）。 */
export function setInjectedHost(host) {
    if (host === undefined) {
        delete globalThis[TEAM_HOST_GLOBAL_KEY];
        return;
    }
    ;
    globalThis[TEAM_HOST_GLOBAL_KEY] = host;
}
/**
 * 解析当前生效的宿主桥：显式注入 > 进程级全局桥 > 工具桥（仅当用例显式要求）> noop。
 */
export function resolveTeamHost(explicit) {
    if (explicit)
        return explicit;
    const injected = getInjectedHost();
    if (injected)
        return injected;
    if (process.env.PI_TEAM_ENABLE_TOOL_BRIDGE === '1')
        return createToolHost();
    return createNoopHost();
}
//# sourceMappingURL=teamHost.js.map