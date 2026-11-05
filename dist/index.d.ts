/**
 * pi-team —— 跨端团队 agent 扩展（默认导出工厂）。
 *
 * 「一份源码，两个形态」：
 *   - pi-agent-desktop 内置：`builtin('pi-team', (pi) => piTeamExtension(pi, subagentHost))`，
 *     接线处把既有 subagent runtime（lib/subagent-runtime.ts 的 createSubagentController）
 *     适配成 TeamHost 传入（见 README 的适配说明）。
 *   - oh-my-pi marketplace：package.json 的 `omp.extensions` / `pi.extensions` 指向本包 dist 入口，
 *     宿主以 `default(pi)` 调用；若宿主未注入子会话能力，则 spawn 明确失败但团队数据/邮箱仍可用。
 *
 * 叠加方式：不重写 spawn，一切会话创建/续跑/steering 都委托给 TeamHost；
 * 邮箱回执、合并派发、idle→parked→revived 生命周期在本扩展内实现（teamBus / teamLifecycle）。
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { type TeamHost } from './teamHost.js';
/** 扩展名，供内置接线与诊断使用。 */
export declare const PI_TEAM_EXTENSION_NAME = "pi-team";
/**
 * 默认导出工厂。第二参 `host` 为可选的宿主桥：pi-agent-desktop 内置接线传入由
 * subagent runtime 适配的桥；marketplace 加载时不传，届时按 globalThis.__piTeamHost
 * 或降级路径解析。
 */
export default function piTeamExtension(pi: ExtensionAPI, host?: TeamHost): void;
/** 具名工厂，便于内置接线直接 import 后 builtin() 包装。 */
export declare function createPiTeamExtension(pi: ExtensionAPI, host?: TeamHost): void;
export { setInjectedHost, resolveTeamHost } from './teamHost.js';
export type { TeamHost, MemberRunHandle, MemberRunStatus } from './teamHost.js';
export { getLifecycle, type TeamLifecycle } from './teamLifecycle.js';
export { getBus, type TeamBus, type DeliveryReceipt, type DeliveryOutcome } from './teamBus.js';
