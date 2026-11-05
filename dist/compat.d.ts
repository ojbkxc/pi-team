/**
 * 跨端扩展兼容层（compat）。
 *
 * 「一份源码，两个形态」的落点：
 *   - pi-agent-desktop（内嵌 @earendil-works/pi-coding-agent v1.5.0）
 *   - oh-my-pi（把 @earendil-works/* 重写到自身宿主副本）
 *
 * 它做三件事：
 *   1. **能力探测**：`typeof host.x === "function"`，缺能力时抛出中文错误而非静默失败；
 *   2. **公共子集封装**：把两端一致的工具注册、事件订阅、消息/条目/工具/命令封装成
 *      `CompatApi`，屏蔽返回值差异（例如 pi 的 `on` 返回退订函数，omp 返回 void）；
 *   3. **双向安全声明**：`defineCompatTool` 在编译期把参数约束到公共子集，
 *      `assertNoForbiddenToolFields` 在运行期拒绝 pi-web 专属字段。
 *
 * 约束（勿破）：
 *   - 宿主导入一律 `import type ... from "@earendil-works/pi-coding-agent"`（编译期擦除，
 *     运行期由宿主提供；禁止 `@oh-my-pi/*`）。
 *   - 参数用 TypeBox（`typebox` 包；omp 会把它重写到自身 TypeBox 门面）。
 *   - 不 import 任何 SDK **运行期值** —— 这样 dist 不依赖真实 SDK 也能加载。
 */
import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import { type CompatEventName } from "./policy.js";
export { Type } from "typebox";
export type { Static, TSchema } from "typebox";
export { COMPAT_EVENTS, FORBIDDEN_API, FORBIDDEN_EVENTS, FORBIDDEN_TOOL_FIELDS, ALLOWED_HOST_IMPORT, FORBIDDEN_IMPORT_PREFIXES, type CompatEventName, } from "./policy.js";
/** 兼容层版本，随骨架演进。 */
export declare const COMPAT_VERSION = "0.1.0";
export interface CompatTextContent {
    type: "text";
    text: string;
}
export interface CompatImageContent {
    type: "image";
    data: string;
    mimeType: string;
}
export type CompatContent = CompatTextContent | CompatImageContent;
/**
 * 命令参数补全项（结构性最小定义）。
 * 真实类型 `AutocompleteItem` 来自 `@earendil-works/pi-tui`，未从 pi-coding-agent 再导出；
 * 为守住「只从 pi-coding-agent 导入」的约束，这里按形状镜像，两端一致。
 */
export interface CompatAutocompleteItem {
    value: string;
    label: string;
    description?: string;
}
export interface CompatSessionStartEvent {
    type: "session_start";
    reason?: "startup" | "reload" | "new" | "resume" | "fork";
    previousSessionFile?: string;
}
export interface CompatAgentStartEvent {
    type: "agent_start";
}
export interface CompatAgentEndEvent {
    type: "agent_end";
    messages: readonly unknown[];
    willContinue?: boolean;
}
export interface CompatSessionShutdownEvent {
    type: "session_shutdown";
    reason?: "quit" | "reload" | "new" | "resume" | "fork";
}
export interface CompatToolCallEvent {
    type: "tool_call";
    toolCallId: string;
    toolName: string;
    input: Record<string, unknown>;
    parentToolCallId?: string;
}
export interface CompatToolResultEvent {
    type: "tool_result";
    toolCallId: string;
    toolName?: string;
    input: Record<string, unknown>;
    content: readonly CompatContent[];
    isError: boolean;
    structuredContent?: unknown;
}
export interface CompatToolCallEventResult {
    block?: boolean;
    reason?: string;
}
export interface CompatToolResultEventResult {
    content?: CompatContent[];
    details?: unknown;
    isError?: boolean;
}
export interface CompatEventMap {
    session_start: CompatSessionStartEvent;
    agent_start: CompatAgentStartEvent;
    agent_end: CompatAgentEndEvent;
    session_shutdown: CompatSessionShutdownEvent;
    tool_call: CompatToolCallEvent;
    tool_result: CompatToolResultEvent;
}
export interface CompatEventResultMap {
    session_start: void;
    agent_start: void;
    agent_end: void;
    session_shutdown: void;
    tool_call: CompatToolCallEventResult;
    tool_result: CompatToolResultEventResult;
}
export interface CompatContext {
    /** 当前工作目录；宿主未提供时为空串。 */
    readonly cwd: string;
    /** 运行模式："tui" | "rpc" | "json" | "print"。 */
    readonly mode?: string;
    /** UI 是否可用。 */
    readonly hasUI?: boolean;
    /** 当前 abort signal。 */
    readonly signal?: AbortSignal;
    /** 是否空闲；宿主未提供时为 undefined。 */
    isIdle?(): boolean;
    /** 中止当前操作；宿主未提供时为 undefined。 */
    abort?(): void;
    /** 通知用户（转调 ctx.ui.notify）；宿主无 UI 时为 undefined。 */
    notify?(message: string, type?: "info" | "warning" | "error"): void;
}
export interface CompatToolContext extends CompatContext {
    /** 可被 executeTool 调用的工具（若宿主提供）。 */
    tools?: readonly unknown[];
    /** 运行另一个工具（若宿主提供）。 */
    executeTool?(name: string, args: unknown, options?: {
        signal?: AbortSignal;
    }): Promise<unknown>;
}
export interface CompatToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown> {
    /** 工具名（LLM 调用时使用）。 */
    name: string;
    /** UI 展示标签。 */
    label: string;
    /** 给 LLM 的描述（中文）。 */
    description: string;
    /** 参数 schema，用 TypeBox 声明。 */
    parameters: TParams;
    /** 执行实现；返回 `{content:[{type:"text",text}], details}`。错误请直接 throw。 */
    execute(toolCallId: string, params: Static<TParams>, signal: AbortSignal | undefined, onUpdate: AgentToolUpdateCallback<TDetails> | undefined, ctx: CompatToolContext): Promise<AgentToolResult<TDetails>>;
}
export interface CompatCommandOptions {
    /** 命令说明（中文）。 */
    description?: string;
    /** 参数补全；返回数组/null 即可（omp 只同步取用，故公共代码不要依赖异步返回）。 */
    getArgumentCompletions?(argumentPrefix: string): CompatAutocompleteItem[] | null | Promise<CompatAutocompleteItem[] | null>;
    /** 命令处理：ctx 为归一化上下文（notify 等）。 */
    handler(args: string, ctx: CompatContext): Promise<void> | void;
}
export type CompatEventHandler<E extends CompatEventName> = (event: CompatEventMap[E], ctx: CompatContext) => CompatEventResultMap[E] | void | Promise<CompatEventResultMap[E] | void>;
export interface CompatApi {
    /** 注册一个公共子集工具。缺 registerTool 能力时抛错。 */
    registerTool<TParams extends TSchema, TDetails = unknown>(tool: CompatToolDefinition<TParams, TDetails>): void;
    /** 注册一个命令（斜杠面板）。缺 registerCommand 能力时抛错。 */
    registerCommand(name: string, options: CompatCommandOptions): void;
    /** 订阅允许的事件；返回退订函数（宿主不给退订时返回 no-op）。 */
    on<E extends CompatEventName>(event: E, handler: CompatEventHandler<E>): () => void;
    /** 追加一条不进入 LLM 上下文的会话条目（用于状态持久化）。 */
    appendEntry<T = unknown>(customType: string, data?: T): void;
    /** 当前已注册工具（只保证 name 字段）。 */
    getAllTools(): readonly {
        name: string;
    }[];
    /** 执行 shell 命令。 */
    exec(command: string, args: string[], options?: Record<string, unknown>): Promise<Record<string, unknown>>;
    /** 发送自定义消息（可选能力；宿主未提供时为 undefined）。 */
    sendMessage?(message: {
        customType: string;
        content: string;
        display: boolean;
        details?: unknown;
    }, options?: {
        triggerTurn?: boolean;
        deliverAs?: "steer" | "followUp" | "nextTurn";
    }): void;
    /** 能力快照，便于诊断。 */
    readonly capabilities: CompatCapabilities;
}
export interface CompatCapabilities {
    registerTool: boolean;
    registerCommand: boolean;
    on: boolean;
    appendEntry: boolean;
    getAllTools: boolean;
    exec: boolean;
    sendMessage: boolean;
}
/** 读取宿主能力快照。 */
export declare function describeCapabilities(pi: unknown): CompatCapabilities;
/** 断言宿主具备某能力；缺失时抛出中文错误。 */
export declare function assertCapability(pi: unknown, capability: keyof CompatCapabilities): void;
declare function toCompatContext(ctx: unknown): CompatContext;
declare function toCompatToolContext(ctx: unknown): CompatToolContext;
/** 拒绝 pi-web 专属工具字段——它们在 oh-my-pi 端不存在。 */
export declare function assertNoForbiddenToolFields(tool: unknown): void;
/** 拒绝宿主专属 API（例如 getSettings）。 */
export declare function assertApiAllowed(api: string): void;
/** 拒绝不兼容的事件名。 */
export declare function assertEventAllowed(event: string): asserts event is CompatEventName;
/**
 * 声明一个公共子集工具。做三件事：保留 TypeBox 参数推断、运行期拒绝禁忌字段、
 * 返回与宿主 `ToolDefinition` 兼容的结构。**不**调用任何宿主 API。
 */
export declare function defineCompatTool<TParams extends TSchema, TDetails = unknown>(tool: CompatToolDefinition<TParams, TDetails>): CompatToolDefinition<TParams, TDetails>;
/** 把公共子集工具注册到宿主。 */
export declare function registerCompatTool<TParams extends TSchema, TDetails = unknown>(pi: unknown, tool: CompatToolDefinition<TParams, TDetails>): void;
/**
 * 把公共子集命令注册到宿主。两端选项形状一致，仅把 handler 的 ctx 归一化后再交给扩展，
 * 因此扩展代码在两端拿到相同的 `CompatContext`。
 */
export declare function registerCompatCommand(pi: unknown, name: string, options: CompatCommandOptions): void;
/**
 * 订阅允许的事件。宿主 `on` 返回值不一致（pi 给退订函数，omp 给 void），
 * 这里统一成「返回退订函数或 no-op」。
 */
export declare function onCompat<E extends CompatEventName>(pi: unknown, event: E, handler: CompatEventHandler<E>): () => void;
/** 追加一条不进入 LLM 上下文的会话条目。 */
export declare function appendCompatEntry<T = unknown>(pi: unknown, customType: string, data?: T): void;
/** 发送自定义消息（可选能力）。返回是否发送成功。 */
export declare function sendCompatMessage<T = unknown>(pi: unknown, message: {
    customType: string;
    content: string;
    display: boolean;
    details?: T;
}, options?: {
    triggerTurn?: boolean;
    deliverAs?: "steer" | "followUp" | "nextTurn";
}): boolean;
/** 读取当前已注册工具（只保证 name）。 */
export declare function getCompatTools(pi: unknown): readonly {
    name: string;
}[];
/** 执行 shell 命令。 */
export declare function execCompat(pi: unknown, command: string, args?: string[], options?: Record<string, unknown>): Promise<Record<string, unknown>>;
/** 构造文本 content 块。 */
export declare function textContent(text: string): CompatTextContent;
/** 构造成功结果：`{content:[{type:"text",text}], details}`。 */
export declare function toolTextResult<TDetails = unknown>(text: string, details?: TDetails): AgentToolResult<TDetails>;
/** 构造错误结果：额外置 `isError: true`。 */
export declare function toolErrorResult<TDetails = unknown>(text: string, details?: TDetails): AgentToolResult<TDetails>;
/** 把宿主 pi 对象包装成兼容 API 面（惰性能力探测，缺能力时按需抛错）。 */
export declare function asCompatApi(pi: unknown): CompatApi;
/** 挂到 ExtensionContext 上的兼容上下文（供非工具代码使用）。 */
export { toCompatContext, toCompatToolContext };
