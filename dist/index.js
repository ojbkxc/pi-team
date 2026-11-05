import { COMPAT_VERSION, appendCompatEntry, asCompatApi, onCompat, } from './compat.js';
import { resolveTeamHost } from './teamHost.js';
import { createTeamRuntime, registerTeamTools } from './teamTools.js';
import { registerTeamCommands } from './teamCommands.js';
/** 扩展名，供内置接线与诊断使用。 */
export const PI_TEAM_EXTENSION_NAME = 'pi-team';
/**
 * 默认导出工厂。第二参 `host` 为可选的宿主桥：pi-agent-desktop 内置接线传入由
 * subagent runtime 适配的桥；marketplace 加载时不传，届时按 globalThis.__piTeamHost
 * 或降级路径解析。
 */
export default function piTeamExtension(pi, host) {
    const compat = asCompatApi(pi);
    const resolvedHost = resolveTeamHost(host);
    const runtime = createTeamRuntime(resolvedHost);
    registerTeamTools(compat, runtime);
    registerTeamCommands(compat, runtime);
    // 当前会话若已是某团队成员，订阅宿主完成事件：成员结束会唤醒正在等它的 lead（不轮询）。
    // 团队上下文来自扩展加载时捕获的 PI_TEAM_NAME（宿主在成员会话创建期注入）。
    const teamName = runtime.teamName;
    if (teamName) {
        runtime.subscribeHostFinish(teamName);
    }
    onCompat(compat, 'session_start', (event) => {
        appendCompatEntry(compat, 'pi-team/loaded', {
            compatVersion: COMPAT_VERSION,
            hostKind: resolvedHost.kind,
            team: teamName ?? null,
            reason: event.reason ?? null,
        });
    });
    onCompat(compat, 'session_shutdown', () => {
        // 所有状态都在磁盘上（~/.pi/agent/teams），无需释放；此处只作为生命周期锚点。
    });
}
/** 具名工厂，便于内置接线直接 import 后 builtin() 包装。 */
export function createPiTeamExtension(pi, host) {
    piTeamExtension(pi, host);
}
export { setInjectedHost, resolveTeamHost } from './teamHost.js';
export { getLifecycle } from './teamLifecycle.js';
export { getBus } from './teamBus.js';
//# sourceMappingURL=index.js.map