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
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
  ToolDefinition as HostToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";

import {
  COMPAT_EVENTS,
  FORBIDDEN_API,
  FORBIDDEN_EVENTS,
  FORBIDDEN_TOOL_FIELDS,
  type CompatEventName,
} from "./policy.js";

// TypeBox 单一入口：扩展代码从这里取 `Type`，保证两端都走同一来源。
export { Type } from "typebox";
export type { Static, TSchema } from "typebox";

export {
  COMPAT_EVENTS,
  FORBIDDEN_API,
  FORBIDDEN_EVENTS,
  FORBIDDEN_TOOL_FIELDS,
  ALLOWED_HOST_IMPORT,
  FORBIDDEN_IMPORT_PREFIXES,
  type CompatEventName,
} from "./policy.js";

/** 兼容层版本，随骨架演进。 */
export const COMPAT_VERSION = "0.1.0";

// ---------------------------------------------------------------------------
// 内容块（结构性最小定义）
// ---------------------------------------------------------------------------
// 注意：真实 SDK 的 TextContent/ImageContent 来自 `@earendil-works/pi-ai`，并未从
// `@earendil-works/pi-coding-agent` 再导出；为守住「只从 pi-coding-agent 导入」的约束，
// 这里用结构化最小定义，两端一致。

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

// ---------------------------------------------------------------------------
// 归一化事件形状（两端交集：pi 独有的字段降级为可选）
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 归一化上下文（只暴露两端都稳的字段）
// ---------------------------------------------------------------------------

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
  executeTool?(name: string, args: unknown, options?: { signal?: AbortSignal }): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// 工具定义（公共子集：仅 name/label/description/parameters/execute）
// ---------------------------------------------------------------------------

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
  execute(
    toolCallId: string,
    params: Static<TParams>,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
    ctx: CompatToolContext,
  ): Promise<AgentToolResult<TDetails>>;
}

// ---------------------------------------------------------------------------
// 命令定义（公共子集：仅 name + {description, getArgumentCompletions, handler}）
// ---------------------------------------------------------------------------
// 两端形状一致：
//   - pi-agent-desktop：`registerCommand(name, Omit<RegisteredCommand, "name"|"sourceInfo">)`
//   - oh-my-pi：`registerCommand(name, { description?, getArgumentCompletions?, handler })`
// 唯一差异是 getArgumentCompletions 的返回类型：pi 允许 Promise，omp 只同步取用。
// 公共子集取并集（可返回数组即可两端通用），调用处按同一方式适配。

export interface CompatCommandOptions {
  /** 命令说明（中文）。 */
  description?: string;
  /** 参数补全；返回数组/null 即可（omp 只同步取用，故公共代码不要依赖异步返回）。 */
  getArgumentCompletions?(
    argumentPrefix: string,
  ): CompatAutocompleteItem[] | null | Promise<CompatAutocompleteItem[] | null>;
  /** 命令处理：ctx 为归一化上下文（notify 等）。 */
  handler(args: string, ctx: CompatContext): Promise<void> | void;
}

// ---------------------------------------------------------------------------
// 兼容 API 面
// ---------------------------------------------------------------------------

export type CompatEventHandler<E extends CompatEventName> = (
  event: CompatEventMap[E],
  ctx: CompatContext,
) => CompatEventResultMap[E] | void | Promise<CompatEventResultMap[E] | void>;

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
  getAllTools(): readonly { name: string }[];
  /** 执行 shell 命令。 */
  exec(command: string, args: string[], options?: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** 发送自定义消息（可选能力；宿主未提供时为 undefined）。 */
  sendMessage?(
    message: { customType: string; content: string; display: boolean; details?: unknown },
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): void;
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

// ---------------------------------------------------------------------------
// 能力探测
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasFunction(target: unknown, key: string): boolean {
  return isRecord(target) && typeof target[key] === "function";
}

/** 读取宿主能力快照。 */
export function describeCapabilities(pi: unknown): CompatCapabilities {
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
export function assertCapability(pi: unknown, capability: keyof CompatCapabilities): void {
  if (!hasFunction(pi, capability)) {
    throw new Error(
      `扩展宿主缺少能力 "${capability}"：两端扩展 API 均需提供该能力，请确认宿主为 pi-agent-desktop 或 oh-my-pi 的兼容版本。`,
    );
  }
}

// ---------------------------------------------------------------------------
// 事件归一化
// ---------------------------------------------------------------------------

function isAllowedEvent(event: string): event is CompatEventName {
  return (COMPAT_EVENTS as readonly string[]).includes(event);
}

function toCompatEvent(event: CompatEventName, raw: unknown): CompatEventMap[CompatEventName] {
  const source = isRecord(raw) ? raw : {};
  switch (event) {
    case "session_start":
      return {
        type: "session_start",
        reason: source.reason as CompatSessionStartEvent["reason"],
        previousSessionFile: source.previousSessionFile as string | undefined,
      };
    case "agent_start":
      return { type: "agent_start" };
    case "agent_end":
      return {
        type: "agent_end",
        messages: Array.isArray(source.messages) ? source.messages : [],
        willContinue: source.willContinue as boolean | undefined,
      };
    case "session_shutdown":
      return { type: "session_shutdown", reason: source.reason as CompatSessionShutdownEvent["reason"] };
    case "tool_call":
      return {
        type: "tool_call",
        toolCallId: String(source.toolCallId ?? ""),
        toolName: String(source.toolName ?? ""),
        input: isRecord(source.input) ? source.input : {},
        parentToolCallId: source.parentToolCallId as string | undefined,
      };
    case "tool_result":
      return {
        type: "tool_result",
        toolCallId: String(source.toolCallId ?? ""),
        toolName: source.toolName as string | undefined,
        input: isRecord(source.input) ? source.input : {},
        content: Array.isArray(source.content) ? (source.content as CompatContent[]) : [],
        isError: source.isError === true,
        structuredContent: source.structuredContent,
      };
  }
}

function toCompatContext(ctx: unknown): CompatContext {
  const source = isRecord(ctx) ? ctx : {};
  const ui = source.ui;
  const compat: CompatContext = {
    cwd: typeof source.cwd === "string" ? source.cwd : "",
    mode: typeof source.mode === "string" ? source.mode : undefined,
    hasUI: typeof source.hasUI === "boolean" ? source.hasUI : undefined,
    signal: source.signal instanceof AbortSignal ? source.signal : undefined,
  };
  if (hasFunction(source, "isIdle")) compat.isIdle = () => (source.isIdle as () => boolean)();
  if (hasFunction(source, "abort")) compat.abort = () => (source.abort as () => void)();
  if (isRecord(ui) && typeof ui.notify === "function") {
    const notify = ui.notify as (message: string, type?: "info" | "warning" | "error") => void;
    compat.notify = (message, type) => notify.call(ui, message, type);
  }
  return compat;
}

function toCompatToolContext(ctx: unknown): CompatToolContext {
  const base = toCompatContext(ctx);
  const source = isRecord(ctx) ? ctx : {};
  const compat: CompatToolContext = { ...base };
  if (Array.isArray(source.tools)) compat.tools = source.tools;
  if (hasFunction(source, "executeTool")) {
    const executeTool = source.executeTool as CompatToolContext["executeTool"] & object;
    compat.executeTool = (name, args, options) => executeTool.call(source, name, args, options);
  }
  return compat;
}

// ---------------------------------------------------------------------------
// 禁忌守卫
// ---------------------------------------------------------------------------

/** 拒绝 pi-web 专属工具字段——它们在 oh-my-pi 端不存在。 */
export function assertNoForbiddenToolFields(tool: unknown): void {
  if (!isRecord(tool)) return;
  const hit = FORBIDDEN_TOOL_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(tool, field));
  if (hit.length > 0) {
    throw new Error(
      `工具 "${String(tool.name ?? "?")}" 使用了 pi-web 专属字段 [${hit.join(", ")}]，两端不兼容；公共子集仅允许 name/label/description/parameters/execute。`,
    );
  }
}

/** 拒绝宿主专属 API（例如 getSettings）。 */
export function assertApiAllowed(api: string): void {
  if ((FORBIDDEN_API as readonly string[]).includes(api)) {
    throw new Error(`公共子集禁止调用宿主 API "${api}"：oh-my-pi 未提供，共享代码用了会一端崩溃。`);
  }
}

/** 拒绝不兼容的事件名。 */
export function assertEventAllowed(event: string): asserts event is CompatEventName {
  if (!isAllowedEvent(event)) {
    const hint = (FORBIDDEN_EVENTS as readonly string[]).includes(event)
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
export function defineCompatTool<TParams extends TSchema, TDetails = unknown>(
  tool: CompatToolDefinition<TParams, TDetails>,
): CompatToolDefinition<TParams, TDetails> {
  assertNoForbiddenToolFields(tool);
  return tool;
}

function toHostToolDefinition<TParams extends TSchema, TDetails>(
  tool: CompatToolDefinition<TParams, TDetails>,
): HostToolDefinition<TParams, TDetails> {
  assertNoForbiddenToolFields(tool);
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    execute: (toolCallId, params, signal, onUpdate, ctx: ExtensionToolContext) =>
      tool.execute(toolCallId, params, signal, onUpdate as AgentToolUpdateCallback<TDetails>, toCompatToolContext(ctx)),
  };
}

/** 把公共子集工具注册到宿主。 */
export function registerCompatTool<TParams extends TSchema, TDetails = unknown>(
  pi: unknown,
  tool: CompatToolDefinition<TParams, TDetails>,
): void {
  assertCapability(pi, "registerTool");
  (pi as ExtensionAPI).registerTool(toHostToolDefinition(tool));
}

/**
 * 把公共子集命令注册到宿主。两端选项形状一致，仅把 handler 的 ctx 归一化后再交给扩展，
 * 因此扩展代码在两端拿到相同的 `CompatContext`。
 */
export function registerCompatCommand(pi: unknown, name: string, options: CompatCommandOptions): void {
  assertCapability(pi, "registerCommand");
  if (!name.trim()) throw new Error("命令名不能为空。");
  // 宿主 registerCommand 的 handler ctx 类型两端不同（ExtensionCommandContext），这里按
  // 「args + 任意 ctx」的统一签名调用，再用 toCompatContext 归一化。
  const rawRegister = (pi as ExtensionAPI).registerCommand as unknown as (
    name: string,
    options: {
      description?: string;
      getArgumentCompletions?: (argumentPrefix: string) => unknown;
      handler: (args: string, ctx: unknown) => unknown;
    },
  ) => void;
  rawRegister(name, {
    ...(options.description !== undefined ? { description: options.description } : {}),
    ...(options.getArgumentCompletions ? { getArgumentCompletions: options.getArgumentCompletions } : {}),
    handler: (args: string, ctx: unknown) => options.handler(args, toCompatContext(ctx)),
  });
}

// ---------------------------------------------------------------------------
// 事件订阅
// ---------------------------------------------------------------------------

/**
 * 订阅允许的事件。宿主 `on` 返回值不一致（pi 给退订函数，omp 给 void），
 * 这里统一成「返回退订函数或 no-op」。
 */
export function onCompat<E extends CompatEventName>(
  pi: unknown,
  event: E,
  handler: CompatEventHandler<E>,
): () => void {
  assertEventAllowed(event);
  assertCapability(pi, "on");
  const api = pi as ExtensionAPI;
  // 宿主 on() 是「按事件名重载」的；这里按联合签名统一调用，事件名已在
  // assertEventAllowed 收窄，事件对象经 toCompatEvent 归一化后再交给扩展。
  const rawOn = api.on as unknown as (
    event: string,
    handler: (event: unknown, ctx: unknown) => unknown,
  ) => unknown;
  const off = rawOn(event, (raw: unknown, ctx: unknown) =>
    handler(toCompatEvent(event, raw) as CompatEventMap[E], toCompatContext(ctx)),
  );
  return typeof off === "function" ? (off as () => void) : () => {};
}

// ---------------------------------------------------------------------------
// 会话条目 / 消息 / 工具 / 命令
// ---------------------------------------------------------------------------

/** 追加一条不进入 LLM 上下文的会话条目。 */
export function appendCompatEntry<T = unknown>(pi: unknown, customType: string, data?: T): void {
  assertCapability(pi, "appendEntry");
  (pi as ExtensionAPI).appendEntry(customType, data);
}

/** 发送自定义消息（可选能力）。返回是否发送成功。 */
export function sendCompatMessage<T = unknown>(
  pi: unknown,
  message: { customType: string; content: string; display: boolean; details?: T },
  options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
): boolean {
  if (!hasFunction(pi, "sendMessage")) return false;
  (pi as ExtensionAPI).sendMessage(message, options);
  return true;
}

/** 读取当前已注册工具（只保证 name）。 */
export function getCompatTools(pi: unknown): readonly { name: string }[] {
  assertCapability(pi, "getAllTools");
  const tools = (pi as ExtensionAPI).getAllTools();
  return Array.isArray(tools) ? tools : [];
}

/** 执行 shell 命令。 */
export function execCompat(
  pi: unknown,
  command: string,
  args: string[] = [],
  options?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  assertCapability(pi, "exec");
  return (pi as ExtensionAPI)
    .exec(command, args, options as never)
    .then((result) => result as unknown as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// 结果构造
// ---------------------------------------------------------------------------

/** 构造文本 content 块。 */
export function textContent(text: string): CompatTextContent {
  return { type: "text", text };
}

/** 构造成功结果：`{content:[{type:"text",text}], details}`。 */
export function toolTextResult<TDetails = unknown>(text: string, details?: TDetails): AgentToolResult<TDetails> {
  return { content: [textContent(text)], details: details as TDetails };
}

/** 构造错误结果：额外置 `isError: true`。 */
export function toolErrorResult<TDetails = unknown>(text: string, details?: TDetails): AgentToolResult<TDetails> {
  return { content: [textContent(text)], details: details as TDetails, isError: true };
}

// ---------------------------------------------------------------------------
// 聚合入口
// ---------------------------------------------------------------------------

/** 把宿主 pi 对象包装成兼容 API 面（惰性能力探测，缺能力时按需抛错）。 */
export function asCompatApi(pi: unknown): CompatApi {
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
          sendMessage: (
            message: { customType: string; content: string; display: boolean; details?: unknown },
            options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
          ) => {
            sendCompatMessage(pi, message, options);
          },
        }
      : {}),
  } as CompatApi;
}

/** 挂到 ExtensionContext 上的兼容上下文（供非工具代码使用）。 */
export { toCompatContext, toCompatToolContext };
