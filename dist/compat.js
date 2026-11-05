import { COMPAT_EVENTS, FORBIDDEN_API, FORBIDDEN_EVENTS, FORBIDDEN_TOOL_FIELDS, } from "./policy.js";
// TypeBox 单一入口：扩展代码从这里取 `Type`，保证两端都走同一来源。
export { Type } from "typebox";
export { COMPAT_EVENTS, FORBIDDEN_API, FORBIDDEN_EVENTS, FORBIDDEN_TOOL_FIELDS, ALLOWED_HOST_IMPORT, FORBIDDEN_IMPORT_PREFIXES, } from "./policy.js";
/** 兼容层版本，随骨架演进。 */
export const COMPAT_VERSION = "0.1.0";
// ---------------------------------------------------------------------------
// 能力探测
// ---------------------------------------------------------------------------
function isRecord(value) {
    return typeof value === "object" && value !== null;
}
function hasFunction(target, key) {
    return isRecord(target) && typeof target[key] === "function";
}
/** 读取宿主能力快照。 */
export function describeCapabilities(pi) {
    return {
        registerTool: hasFunction(pi, "registerTool"),
        registerCommand: hasFunction(pi, "registerCommand"),
        on: hasFunction(pi, "on"),
        appendEntry: hasFunction(pi, "appendEntry"),
        getAllTools: hasFunction(pi, "getAllTools"),
        exec: hasFunction(pi, "exec"),
        sendMessage: hasFunction(pi, "sendMessage"),
    };
}
/** 断言宿主具备某能力；缺失时抛出中文错误。 */
export function assertCapability(pi, capability) {
    if (!hasFunction(pi, capability)) {
        throw new Error(`扩展宿主缺少能力 "${capability}"：两端扩展 API 均需提供该能力，请确认宿主为 pi-agent-desktop 或 oh-my-pi 的兼容版本。`);
    }
}
// ---------------------------------------------------------------------------
// 事件归一化
// ---------------------------------------------------------------------------
function isAllowedEvent(event) {
    return COMPAT_EVENTS.includes(event);
}
function toCompatEvent(event, raw) {
    const source = isRecord(raw) ? raw : {};
    switch (event) {
        case "session_start":
            return {
                type: "session_start",
                reason: source.reason,
                previousSessionFile: source.previousSessionFile,
            };
        case "agent_start":
            return { type: "agent_start" };
        case "agent_end":
            return {
                type: "agent_end",
                messages: Array.isArray(source.messages) ? source.messages : [],
                willContinue: source.willContinue,
            };
        case "session_shutdown":
            return { type: "session_shutdown", reason: source.reason };
        case "tool_call":
            return {
                type: "tool_call",
                toolCallId: String(source.toolCallId ?? ""),
                toolName: String(source.toolName ?? ""),
                input: isRecord(source.input) ? source.input : {},
                parentToolCallId: source.parentToolCallId,
            };
        case "tool_result":
            return {
                type: "tool_result",
                toolCallId: String(source.toolCallId ?? ""),
                toolName: source.toolName,
                input: isRecord(source.input) ? source.input : {},
                content: Array.isArray(source.content) ? source.content : [],
                isError: source.isError === true,
                structuredContent: source.structuredContent,
            };
    }
}
function toCompatContext(ctx) {
    const source = isRecord(ctx) ? ctx : {};
    const ui = source.ui;
    const compat = {
        cwd: typeof source.cwd === "string" ? source.cwd : "",
        mode: typeof source.mode === "string" ? source.mode : undefined,
        hasUI: typeof source.hasUI === "boolean" ? source.hasUI : undefined,
        signal: source.signal instanceof AbortSignal ? source.signal : undefined,
    };
    if (hasFunction(source, "isIdle"))
        compat.isIdle = () => source.isIdle();
    if (hasFunction(source, "abort"))
        compat.abort = () => source.abort();
    if (isRecord(ui) && typeof ui.notify === "function") {
        const notify = ui.notify;
        compat.notify = (message, type) => notify.call(ui, message, type);
    }
    return compat;
}
function toCompatToolContext(ctx) {
    const base = toCompatContext(ctx);
    const source = isRecord(ctx) ? ctx : {};
    const compat = { ...base };
    if (Array.isArray(source.tools))
        compat.tools = source.tools;
    if (hasFunction(source, "executeTool")) {
        const executeTool = source.executeTool;
        compat.executeTool = (name, args, options) => executeTool.call(source, name, args, options);
    }
    return compat;
}
// ---------------------------------------------------------------------------
// 禁忌守卫
// ---------------------------------------------------------------------------
/** 拒绝 pi-web 专属工具字段——它们在 oh-my-pi 端不存在。 */
export function assertNoForbiddenToolFields(tool) {
    if (!isRecord(tool))
        return;
    const hit = FORBIDDEN_TOOL_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(tool, field));
    if (hit.length > 0) {
        throw new Error(`工具 "${String(tool.name ?? "?")}" 使用了 pi-web 专属字段 [${hit.join(", ")}]，两端不兼容；公共子集仅允许 name/label/description/parameters/execute。`);
    }
}
/** 拒绝宿主专属 API（例如 getSettings）。 */
export function assertApiAllowed(api) {
    if (FORBIDDEN_API.includes(api)) {
        throw new Error(`公共子集禁止调用宿主 API "${api}"：oh-my-pi 未提供，共享代码用了会一端崩溃。`);
    }
}
/** 拒绝不兼容的事件名。 */
export function assertEventAllowed(event) {
    if (!isAllowedEvent(event)) {
        const hint = FORBIDDEN_EVENTS.includes(event)
            ? "：该事件两端形状不兼容"
            : "";
        throw new Error(`公共子集不允许订阅事件 "${event}"${hint}。允许的事件：${COMPAT_EVENTS.join(", ")}。`);
    }
}
// ---------------------------------------------------------------------------
// 工具：定义 / 注册
// ---------------------------------------------------------------------------
/**
 * 声明一个公共子集工具。做三件事：保留 TypeBox 参数推断、运行期拒绝禁忌字段、
 * 返回与宿主 `ToolDefinition` 兼容的结构。**不**调用任何宿主 API。
 */
export function defineCompatTool(tool) {
    assertNoForbiddenToolFields(tool);
    return tool;
}
function toHostToolDefinition(tool) {
    assertNoForbiddenToolFields(tool);
    return {
        name: tool.name,
        label: tool.label,
        description: tool.description,
        parameters: tool.parameters,
        execute: (toolCallId, params, signal, onUpdate, ctx) => tool.execute(toolCallId, params, signal, onUpdate, toCompatToolContext(ctx)),
    };
}
/** 把公共子集工具注册到宿主。 */
export function registerCompatTool(pi, tool) {
    assertCapability(pi, "registerTool");
    pi.registerTool(toHostToolDefinition(tool));
}
/**
 * 把公共子集命令注册到宿主。两端选项形状一致，仅把 handler 的 ctx 归一化后再交给扩展，
 * 因此扩展代码在两端拿到相同的 `CompatContext`。
 */
export function registerCompatCommand(pi, name, options) {
    assertCapability(pi, "registerCommand");
    if (!name.trim())
        throw new Error("命令名不能为空。");
    // 宿主 registerCommand 的 handler ctx 类型两端不同（ExtensionCommandContext），这里按
    // 「args + 任意 ctx」的统一签名调用，再用 toCompatContext 归一化。
    const rawRegister = pi.registerCommand;
    rawRegister(name, {
        ...(options.description !== undefined ? { description: options.description } : {}),
        ...(options.getArgumentCompletions ? { getArgumentCompletions: options.getArgumentCompletions } : {}),
        handler: (args, ctx) => options.handler(args, toCompatContext(ctx)),
    });
}
// ---------------------------------------------------------------------------
// 事件订阅
// ---------------------------------------------------------------------------
/**
 * 订阅允许的事件。宿主 `on` 返回值不一致（pi 给退订函数，omp 给 void），
 * 这里统一成「返回退订函数或 no-op」。
 */
export function onCompat(pi, event, handler) {
    assertEventAllowed(event);
    assertCapability(pi, "on");
    const api = pi;
    // 宿主 on() 是「按事件名重载」的；这里按联合签名统一调用，事件名已在
    // assertEventAllowed 收窄，事件对象经 toCompatEvent 归一化后再交给扩展。
    const rawOn = api.on;
    const off = rawOn(event, (raw, ctx) => handler(toCompatEvent(event, raw), toCompatContext(ctx)));
    return typeof off === "function" ? off : () => { };
}
// ---------------------------------------------------------------------------
// 会话条目 / 消息 / 工具 / 命令
// ---------------------------------------------------------------------------
/** 追加一条不进入 LLM 上下文的会话条目。 */
export function appendCompatEntry(pi, customType, data) {
    assertCapability(pi, "appendEntry");
    pi.appendEntry(customType, data);
}
/** 发送自定义消息（可选能力）。返回是否发送成功。 */
export function sendCompatMessage(pi, message, options) {
    if (!hasFunction(pi, "sendMessage"))
        return false;
    pi.sendMessage(message, options);
    return true;
}
/** 读取当前已注册工具（只保证 name）。 */
export function getCompatTools(pi) {
    assertCapability(pi, "getAllTools");
    const tools = pi.getAllTools();
    return Array.isArray(tools) ? tools : [];
}
/** 执行 shell 命令。 */
export function execCompat(pi, command, args = [], options) {
    assertCapability(pi, "exec");
    return pi
        .exec(command, args, options)
        .then((result) => result);
}
// ---------------------------------------------------------------------------
// 结果构造
// ---------------------------------------------------------------------------
/** 构造文本 content 块。 */
export function textContent(text) {
    return { type: "text", text };
}
/** 构造成功结果：`{content:[{type:"text",text}], details}`。 */
export function toolTextResult(text, details) {
    return { content: [textContent(text)], details: details };
}
/** 构造错误结果：额外置 `isError: true`。 */
export function toolErrorResult(text, details) {
    return { content: [textContent(text)], details: details, isError: true };
}
// ---------------------------------------------------------------------------
// 聚合入口
// ---------------------------------------------------------------------------
/** 把宿主 pi 对象包装成兼容 API 面（惰性能力探测，缺能力时按需抛错）。 */
export function asCompatApi(pi) {
    if (!isRecord(pi)) {
        throw new Error("扩展宿主对象无效：期望收到 ExtensionAPI 对象。");
    }
    const capabilities = describeCapabilities(pi);
    return {
        capabilities,
        registerTool: (tool) => registerCompatTool(pi, tool),
        registerCommand: (name, options) => registerCompatCommand(pi, name, options),
        on: (event, handler) => onCompat(pi, event, handler),
        appendEntry: (customType, data) => appendCompatEntry(pi, customType, data),
        getAllTools: () => getCompatTools(pi),
        exec: (command, args, options) => execCompat(pi, command, args, options),
        ...(capabilities.sendMessage
            ? {
                sendMessage: (message, options) => {
                    sendCompatMessage(pi, message, options);
                },
            }
            : {}),
    };
}
/** 挂到 ExtensionContext 上的兼容上下文（供非工具代码使用）。 */
export { toCompatContext, toCompatToolContext };
//# sourceMappingURL=compat.js.map