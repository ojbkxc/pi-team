/**
 * 离线编译垫片：`@earendil-works/pi-coding-agent` 公共子集声明。
 *
 * 目的（见 README「公共子集与禁忌」）：
 *  1. 让共享源码在**不安装真实 SDK** 的情况下也能通过 `tsc` 编译与单测；
 *  2. 把「两边都能跑」的能力固定成编译期契约 —— 宿主专属能力（getSettings、
 *     before_agent_start 等）**故意不声明**，因此共享代码一旦触碰就会编译报错。
 *
 * 来源：`@earendil-works/pi-coding-agent@1.5.0`
 *   dist/core/extensions/types.d.ts（ExtensionAPI / ToolDefinition / ExtensionContext /
 *   事件类型）与 dist/index.d.ts（公开导出面）。这里只镜像本包用到的字段/签名，
 *   结构保持与上游一致；升级 SDK 时需同步核对本文件。
 *
 * 当某个仓库本身已安装真实 SDK（例如 pi-team）时：删掉 tsconfig 里的 `paths`
 * 映射（或移除本文件），即可改为对真实 SDK 做类型校验。
 */
import type { Static, TSchema } from "typebox";

export interface SourceInfo {
  /** 工具来源标识，例如 `<builtin:read>` 或 `<extension:lsp>`。 */
  path: string;
  /** 来源类别："builtin" | "sdk" | "mcp" | "extension"。 */
  source: string;
  scope?: "user" | "project" | "temporary";
  origin?: "package" | "top-level";
  baseDir?: string;
}

// 注意：真实 SDK 并未从本包再导出 TextContent/ImageContent（它们来自
// @earendil-works/pi-ai），因此这里刻意不导出，避免共享代码误依赖。
interface TextContent {
  type: "text";
  text: string;
}

interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface AgentToolResult<TDetails = unknown> {
  content: (TextContent | ImageContent)[];
  details: TDetails;
  isError?: boolean;
  structuredContent?: unknown;
}

export type AgentToolUpdateCallback<TDetails = unknown> = (partial: AgentToolResult<TDetails>) => void;

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  signal?: AbortSignal;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal?: string | null;
  killed?: boolean;
}

export interface ContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export interface ExtensionContext {
  /** 当前工作目录。 */
  cwd: string;
  /** 当前运行模式："tui" | "rpc" | "json" | "print"。 */
  mode: "tui" | "rpc" | "json" | "print";
  /** TUI / RPC 模式下 UI 可用。 */
  hasUI: boolean;
  /** 当前 abort signal，流式期间存在。 */
  signal: AbortSignal | undefined;
  /** 是否空闲（未在流式输出）。 */
  isIdle(): boolean;
  /** 中止当前 agent 操作。 */
  abort(): void;
  /** 是否有排队中的消息。 */
  hasPendingMessages(): boolean;
  /** 优雅退出 pi。 */
  shutdown(): void;
  /** 当前模型的上下文占用。 */
  getContextUsage(): ContextUsage | undefined;
  /** UI 交互面（仅声明 notify，其余宿主专属 UI 不在公共子集内）。 */
  ui?: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
  };
}

export interface ExtensionToolContext extends ExtensionContext {
  /** 可被 executeTool 调用的工具。 */
  readonly tools: readonly unknown[];
  /** 运行另一个工具（走同样的校验与权限）。 */
  executeTool(name: string, args: unknown, options?: { signal?: AbortSignal }): Promise<unknown>;
}

export interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown, TState = any> {
  name: string;
  label: string;
  description: string;
  parameters: TParams;
  execute(
    toolCallId: string,
    params: Static<TParams>,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
    ctx: ExtensionToolContext,
  ): Promise<AgentToolResult<TDetails>>;
  renderShell?: "default" | "self";
  renderCall?: (args: Static<TParams>, theme: unknown, context: unknown) => unknown;
  renderResult?: (result: AgentToolResult<TDetails>, options: unknown, theme: unknown, context: unknown) => unknown;
}

export interface ToolInfo {
  name: string;
  description: string;
  parameters: TSchema;
  exposure?: string;
  namespace?: unknown;
  annotations?: unknown;
  sourceInfo: SourceInfo;
}

// --- 允许公共子集使用的事件（其余事件两端形状不兼容，故意不声明） ---

export interface SessionStartEvent {
  type: "session_start";
  /** pi 提供 reason；omp 不提供，故共享代码须按可选处理。 */
  reason?: "startup" | "reload" | "new" | "resume" | "fork";
  previousSessionFile?: string;
}

export interface AgentStartEvent {
  type: "agent_start";
}

export interface AgentEndEvent {
  type: "agent_end";
  messages: unknown[];
}

export interface SessionShutdownEvent {
  type: "session_shutdown";
  reason?: "quit" | "reload" | "new" | "resume" | "fork";
  targetSessionFile?: string;
}

interface ToolCallEventBase {
  type: "tool_call";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  parentToolCallId?: string;
}

export type ToolCallEvent = ToolCallEventBase;

export interface ToolCallEventResult {
  block?: boolean;
  reason?: string;
}

interface ToolResultEventBase {
  type: "tool_result";
  toolCallId: string;
  toolName?: string;
  input: Record<string, unknown>;
  content: (TextContent | ImageContent)[];
  isError: boolean;
  structuredContent?: unknown;
}

export type ToolResultEvent = ToolResultEventBase;

export interface ToolResultEventResult {
  content?: (TextContent | ImageContent)[];
  details?: unknown;
  isError?: boolean;
}

export type ExtensionHandler<E, R = undefined> = (event: E, ctx: ExtensionContext) => Promise<R | void> | R | void;

/**
 * 命令参数补全项。真实类型来自 `@earendil-works/pi-tui`（未从本包再导出），
 * 这里按形状镜像，避免共享代码依赖 pi-tui。
 */
export interface AutocompleteItem {
  value: string;
  label: string;
  description?: string;
}

/**
 * 命令定义。两端形状一致：
 *   - pi-agent-desktop：`Omit<RegisteredCommand, "name" | "sourceInfo">`
 *   - oh-my-pi：`{ description?, getArgumentCompletions?, handler }`
 * `getArgumentCompletions` 在 pi 端可为 Promise，omp 端只同步取用，公共子集取并集。
 */
export interface RegisteredCommand {
  name: string;
  description?: string;
  getArgumentCompletions?(
    argumentPrefix: string,
  ): AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
  handler: (args: string, ctx: ExtensionContext) => Promise<void> | void;
}

export type CompatAllowedEventName =
  | "session_start"
  | "agent_start"
  | "agent_end"
  | "session_shutdown"
  | "tool_call"
  | "tool_result";

export interface ExtensionAPI {
  on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): () => void;
  on(event: "agent_start", handler: ExtensionHandler<AgentStartEvent>): () => void;
  on(event: "agent_end", handler: ExtensionHandler<AgentEndEvent>): () => void;
  on(event: "session_shutdown", handler: ExtensionHandler<SessionShutdownEvent>): () => void;
  on(event: "tool_call", handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult>): () => void;
  on(event: "tool_result", handler: ExtensionHandler<ToolResultEvent, ToolResultEventResult>): () => void;
  registerTool<TParams extends TSchema = TSchema, TDetails = unknown, TState = any>(
    tool: ToolDefinition<TParams, TDetails, TState>,
  ): void;
  registerCommand(
    name: string,
    options: { description?: string; getArgumentCompletions?: RegisteredCommand["getArgumentCompletions"]; handler: (args: string, ctx: ExtensionContext) => Promise<void> | void },
  ): void;
  sendMessage<T = unknown>(
    message: { customType: string; content: string | (TextContent | ImageContent)[]; display: boolean; details?: T },
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): void;
  appendEntry<T = unknown>(customType: string, data?: T): void;
  getAllTools(): ToolInfo[];
  exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
}

export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;

export type InlineExtension =
  | ExtensionFactory
  | {
      name: string;
      factory: ExtensionFactory;
      hidden?: boolean;
      replaceable?: boolean;
      builtin?: boolean;
    };
