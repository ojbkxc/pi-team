/**
 * 公共子集策略：白名单与禁忌名单的**唯一事实来源**。
 *
 * compat.ts 用它做运行期守卫；test/forbidden-scan.mjs 用它扫描共享源码；
 * README 用它生成文档。改这里即改三处。
 */
/** 允许共享代码订阅的事件（两端形状兼容，且语义一致）。 */
export const COMPAT_EVENTS = [
    "session_start",
    "agent_start",
    "agent_end",
    "session_shutdown",
    "tool_call",
    "tool_result",
];
/**
 * 禁止订阅的事件：`before_agent_start` 两端参数/返回值形状不兼容
 * （pi 侧是 systemPromptOptions/handler 链，omp 侧是另一套），
 * 共享代码订阅它必然一端出错。
 */
export const FORBIDDEN_EVENTS = ["before_agent_start"];
/**
 * 禁止出现在工具定义里的字段：pi-web 专属（SDK 有、omp 无），
 * 写了会让工具在另一端被静默忽略或直接报错。
 */
export const FORBIDDEN_TOOL_FIELDS = [
    "promptSnippet",
    "promptGuidelines",
    "exposure",
    "executionMode",
    "defaultActive",
    "constrainedSampling",
    "renderShell",
    "prepareArguments",
    "outputSchema",
    "namespace",
    "reachesTools",
    "annotations",
    "prepareLoadout",
];
/** 禁止在共享代码里调用的宿主 API。 */
export const FORBIDDEN_API = ["getSettings"];
/**
 * 允许面说明（非机器可读，供人核对）。
 *
 * `registerCommand` **属于允许面**：两端签名兼容
 * （pi-agent-desktop：`Omit<RegisteredCommand, "name"|"sourceInfo">`；oh-my-pi：`{ description?, getArgumentCompletions?, handler }`），
 * 故由 `compat.ts` 的 `asCompatApi` 暴露，可跨端注册斜杠命令。它**不在** `FORBIDDEN_API` 内。
 */
/** 禁止出现在共享源码里的导入源前缀（只能从 @earendil-works/pi-coding-agent 取宿主 API）。 */
export const FORBIDDEN_IMPORT_PREFIXES = ["@oh-my-pi/"];
/** 共享源码允许的宿主导入源。 */
export const ALLOWED_HOST_IMPORT = "@earendil-works/pi-coding-agent";
//# sourceMappingURL=policy.js.map