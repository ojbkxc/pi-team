/**
 * Message protocol for inter-agent communication.
 *
 * Defines the structured message types exchanged via mailbox, plus
 * serialization/deserialization helpers. Each message type has a
 * discriminator field `type` and a corresponding type guard.
 */
export declare const MessageType: {
    /** A plain text message between agents. */
    readonly TEXT: "text";
    /** Notification that an agent became idle. */
    readonly IDLE_NOTIFICATION: "idle_notification";
    /** A task assignment from leader to member. */
    readonly TASK_ASSIGNMENT: "task_assignment";
    /** Request for permission from worker to leader. */
    readonly PERMISSION_REQUEST: "permission_request";
    /** Permission response from leader to worker. */
    readonly PERMISSION_RESPONSE: "permission_response";
    /** Request for plan approval. */
    readonly PLAN_APPROVAL_REQUEST: "plan_approval_request";
    /** Response to plan approval request. */
    readonly PLAN_APPROVAL_RESPONSE: "plan_approval_response";
    /** Request to shut down a teammate. */
    readonly SHUTDOWN_REQUEST: "shutdown_request";
    /** Approval of shutdown from teammate. */
    readonly SHUTDOWN_APPROVED: "shutdown_approved";
    /** Rejection of shutdown from teammate. */
    readonly SHUTDOWN_REJECTED: "shutdown_rejected";
    /** Broadcast a permission update to all teammates. */
    readonly TEAM_PERMISSION_UPDATE: "team_permission_update";
    /** Request to set a teammate's mode. */
    readonly MODE_SET_REQUEST: "mode_set_request";
    /** Sandbox permission request. */
    readonly SANDBOX_PERMISSION_REQUEST: "sandbox_permission_request";
    /** Sandbox permission response. */
    readonly SANDBOX_PERMISSION_RESPONSE: "sandbox_permission_response";
};
export type MessageTypeValue = (typeof MessageType)[keyof typeof MessageType];
export interface IdleNotificationMessage {
    type: typeof MessageType.IDLE_NOTIFICATION;
    from: string;
    timestamp: string;
    idleReason?: 'available' | 'interrupted' | 'failed';
    summary?: string;
    completedTaskId?: string;
    completedStatus?: 'resolved' | 'blocked' | 'failed';
    failureReason?: string;
    result?: string;
}
export interface TaskAssignmentMessage {
    type: typeof MessageType.TASK_ASSIGNMENT;
    taskId: string;
    subject: string;
    description: string;
    assignedBy: string;
    timestamp: string;
}
export interface PermissionRequestMessage {
    type: typeof MessageType.PERMISSION_REQUEST;
    request_id: string;
    agent_id: string;
    tool_name: string;
    tool_use_id: string;
    description: string;
    input: Record<string, unknown>;
    permission_suggestions: unknown[];
}
export interface PermissionResponseMessage {
    type: typeof MessageType.PERMISSION_RESPONSE;
    request_id: string;
    subtype: 'success' | 'error';
    error?: string;
    updated_input?: Record<string, unknown>;
}
export interface PlanApprovalRequestMessage {
    type: typeof MessageType.PLAN_APPROVAL_REQUEST;
    from: string;
    timestamp: string;
    planFilePath: string;
    planContent: string;
    requestId: string;
}
export interface PlanApprovalResponseMessage {
    type: typeof MessageType.PLAN_APPROVAL_RESPONSE;
    requestId: string;
    approved: boolean;
    feedback?: string;
    timestamp: string;
    permissionMode?: string;
}
export interface ShutdownRequestMessage {
    type: typeof MessageType.SHUTDOWN_REQUEST;
    requestId: string;
    from: string;
    reason?: string;
    timestamp: string;
}
export interface ShutdownApprovedMessage {
    type: typeof MessageType.SHUTDOWN_APPROVED;
    requestId: string;
    from: string;
    timestamp: string;
}
export interface ShutdownRejectedMessage {
    type: typeof MessageType.SHUTDOWN_REJECTED;
    requestId: string;
    from: string;
    reason: string;
    timestamp: string;
}
export interface ModeSetRequestMessage {
    type: typeof MessageType.MODE_SET_REQUEST;
    mode: string;
    from: string;
}
export interface SandboxPermissionRequestMessage {
    type: typeof MessageType.SANDBOX_PERMISSION_REQUEST;
    requestId: string;
    workerId: string;
    workerName: string;
    hostPattern: {
        host: string;
    };
    createdAt: number;
}
export interface SandboxPermissionResponseMessage {
    type: typeof MessageType.SANDBOX_PERMISSION_RESPONSE;
    requestId: string;
    host: string;
    allow: boolean;
    timestamp: string;
}
export type StructuredMessage = IdleNotificationMessage | TaskAssignmentMessage | PermissionRequestMessage | PermissionResponseMessage | PlanApprovalRequestMessage | PlanApprovalResponseMessage | ShutdownRequestMessage | ShutdownApprovedMessage | ShutdownRejectedMessage | ModeSetRequestMessage | SandboxPermissionRequestMessage | SandboxPermissionResponseMessage;
export declare function serializeMessage(message: StructuredMessage): string;
export declare function deserializeMessage(text: string): StructuredMessage | null;
export declare function isIdleNotification(msg: StructuredMessage): msg is IdleNotificationMessage;
export declare function isTaskAssignment(msg: StructuredMessage): msg is TaskAssignmentMessage;
export declare function isPermissionRequest(msg: StructuredMessage): msg is PermissionRequestMessage;
export declare function isPermissionResponse(msg: StructuredMessage): msg is PermissionResponseMessage;
export declare function isPlanApprovalRequest(msg: StructuredMessage): msg is PlanApprovalRequestMessage;
export declare function isPlanApprovalResponse(msg: StructuredMessage): msg is PlanApprovalResponseMessage;
export declare function isShutdownRequest(msg: StructuredMessage): msg is ShutdownRequestMessage;
export declare function isShutdownApproved(msg: StructuredMessage): msg is ShutdownApprovedMessage;
export declare function isShutdownRejected(msg: StructuredMessage): msg is ShutdownRejectedMessage;
export declare function isModeSetRequest(msg: StructuredMessage): msg is ModeSetRequestMessage;
export declare function isSandboxPermissionRequest(msg: StructuredMessage): msg is SandboxPermissionRequestMessage;
export declare function isSandboxPermissionResponse(msg: StructuredMessage): msg is SandboxPermissionResponseMessage;
export declare function isStructuredProtocolMessage(text: string): boolean;
export declare function createIdleNotification(from: string, options?: {
    idleReason?: IdleNotificationMessage['idleReason'];
    summary?: string;
    completedTaskId?: string;
    completedStatus?: 'resolved' | 'blocked' | 'failed';
    failureReason?: string;
    result?: string;
}): IdleNotificationMessage;
export declare function createTaskAssignment(params: {
    taskId: string;
    subject: string;
    description: string;
    assignedBy: string;
}): TaskAssignmentMessage;
export declare function createShutdownRequest(params: {
    from: string;
    reason?: string;
}): ShutdownRequestMessage;
export declare function createShutdownApproved(params: {
    requestId: string;
    from: string;
}): ShutdownApprovedMessage;
export declare function createShutdownRejected(params: {
    requestId: string;
    from: string;
    reason: string;
}): ShutdownRejectedMessage;
export declare function createModeSetRequest(params: {
    mode: string;
    from: string;
}): ModeSetRequestMessage;
export declare function createPermissionRequest(params: {
    request_id: string;
    agent_id: string;
    tool_name: string;
    tool_use_id: string;
    description: string;
    input: Record<string, unknown>;
    permission_suggestions?: unknown[];
}): PermissionRequestMessage;
export declare function createPermissionResponse(params: {
    request_id: string;
    subtype: 'success' | 'error';
    error?: string;
    updated_input?: Record<string, unknown>;
}): PermissionResponseMessage;
export declare function createPlanApprovalRequest(params: {
    from: string;
    planFilePath: string;
    planContent: string;
}): PlanApprovalRequestMessage;
export declare function createPlanApprovalResponse(params: {
    requestId: string;
    approved: boolean;
    feedback?: string;
    permissionMode?: string;
}): PlanApprovalResponseMessage;
export declare function createSandboxPermissionRequest(params: {
    workerId: string;
    workerName: string;
    host: string;
}): SandboxPermissionRequestMessage;
export declare function createSandboxPermissionResponse(params: {
    requestId: string;
    host: string;
    allow: boolean;
}): SandboxPermissionResponseMessage;
