/**
 * Message protocol for inter-agent communication.
 *
 * Defines the structured message types exchanged via mailbox, plus
 * serialization/deserialization helpers. Each message type has a
 * discriminator field `type` and a corresponding type guard.
 */
import { randomUUID } from 'node:crypto';
// ---------------------------------------------------------------------------
// Message type enum
// ---------------------------------------------------------------------------
export const MessageType = {
    /** A plain text message between agents. */
    TEXT: 'text',
    /** Notification that an agent became idle. */
    IDLE_NOTIFICATION: 'idle_notification',
    /** A task assignment from leader to member. */
    TASK_ASSIGNMENT: 'task_assignment',
    /** Request for permission from worker to leader. */
    PERMISSION_REQUEST: 'permission_request',
    /** Permission response from leader to worker. */
    PERMISSION_RESPONSE: 'permission_response',
    /** Request for plan approval. */
    PLAN_APPROVAL_REQUEST: 'plan_approval_request',
    /** Response to plan approval request. */
    PLAN_APPROVAL_RESPONSE: 'plan_approval_response',
    /** Request to shut down a teammate. */
    SHUTDOWN_REQUEST: 'shutdown_request',
    /** Approval of shutdown from teammate. */
    SHUTDOWN_APPROVED: 'shutdown_approved',
    /** Rejection of shutdown from teammate. */
    SHUTDOWN_REJECTED: 'shutdown_rejected',
    /** Broadcast a permission update to all teammates. */
    TEAM_PERMISSION_UPDATE: 'team_permission_update',
    /** Request to set a teammate's mode. */
    MODE_SET_REQUEST: 'mode_set_request',
    /** Sandbox permission request. */
    SANDBOX_PERMISSION_REQUEST: 'sandbox_permission_request',
    /** Sandbox permission response. */
    SANDBOX_PERMISSION_RESPONSE: 'sandbox_permission_response',
};
// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------
export function serializeMessage(message) {
    return JSON.stringify(message);
}
export function deserializeMessage(text) {
    try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && 'type' in parsed) {
            return parsed;
        }
    }
    catch {
        // Not valid JSON
    }
    return null;
}
// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------
export function isIdleNotification(msg) {
    return msg.type === MessageType.IDLE_NOTIFICATION;
}
export function isTaskAssignment(msg) {
    return msg.type === MessageType.TASK_ASSIGNMENT;
}
export function isPermissionRequest(msg) {
    return msg.type === MessageType.PERMISSION_REQUEST;
}
export function isPermissionResponse(msg) {
    return msg.type === MessageType.PERMISSION_RESPONSE;
}
export function isPlanApprovalRequest(msg) {
    return msg.type === MessageType.PLAN_APPROVAL_REQUEST;
}
export function isPlanApprovalResponse(msg) {
    return msg.type === MessageType.PLAN_APPROVAL_RESPONSE;
}
export function isShutdownRequest(msg) {
    return msg.type === MessageType.SHUTDOWN_REQUEST;
}
export function isShutdownApproved(msg) {
    return msg.type === MessageType.SHUTDOWN_APPROVED;
}
export function isShutdownRejected(msg) {
    return msg.type === MessageType.SHUTDOWN_REJECTED;
}
export function isModeSetRequest(msg) {
    return msg.type === MessageType.MODE_SET_REQUEST;
}
export function isSandboxPermissionRequest(msg) {
    return msg.type === MessageType.SANDBOX_PERMISSION_REQUEST;
}
export function isSandboxPermissionResponse(msg) {
    return msg.type === MessageType.SANDBOX_PERMISSION_RESPONSE;
}
export function isStructuredProtocolMessage(text) {
    const msg = deserializeMessage(text);
    return msg !== null;
}
// ---------------------------------------------------------------------------
// Message factory helpers
// ---------------------------------------------------------------------------
export function createIdleNotification(from, options) {
    return {
        type: MessageType.IDLE_NOTIFICATION,
        from,
        timestamp: new Date().toISOString(),
        idleReason: options?.idleReason,
        summary: options?.summary,
        completedTaskId: options?.completedTaskId,
        completedStatus: options?.completedStatus,
        failureReason: options?.failureReason,
        result: options?.result,
    };
}
export function createTaskAssignment(params) {
    return {
        type: MessageType.TASK_ASSIGNMENT,
        taskId: params.taskId,
        subject: params.subject,
        description: params.description,
        assignedBy: params.assignedBy,
        timestamp: new Date().toISOString(),
    };
}
export function createShutdownRequest(params) {
    return {
        type: MessageType.SHUTDOWN_REQUEST,
        requestId: `shutdown-${randomUUID()}`,
        from: params.from,
        reason: params.reason,
        timestamp: new Date().toISOString(),
    };
}
export function createShutdownApproved(params) {
    return {
        type: MessageType.SHUTDOWN_APPROVED,
        requestId: params.requestId,
        from: params.from,
        timestamp: new Date().toISOString(),
    };
}
export function createShutdownRejected(params) {
    return {
        type: MessageType.SHUTDOWN_REJECTED,
        requestId: params.requestId,
        from: params.from,
        reason: params.reason,
        timestamp: new Date().toISOString(),
    };
}
export function createModeSetRequest(params) {
    return {
        type: MessageType.MODE_SET_REQUEST,
        mode: params.mode,
        from: params.from,
    };
}
export function createPermissionRequest(params) {
    return {
        type: MessageType.PERMISSION_REQUEST,
        request_id: params.request_id,
        agent_id: params.agent_id,
        tool_name: params.tool_name,
        tool_use_id: params.tool_use_id,
        description: params.description,
        input: params.input,
        permission_suggestions: params.permission_suggestions || [],
    };
}
export function createPermissionResponse(params) {
    if (params.subtype === 'error') {
        return {
            type: MessageType.PERMISSION_RESPONSE,
            request_id: params.request_id,
            subtype: 'error',
            error: params.error || 'Permission denied',
        };
    }
    return {
        type: MessageType.PERMISSION_RESPONSE,
        request_id: params.request_id,
        subtype: 'success',
        updated_input: params.updated_input,
    };
}
export function createPlanApprovalRequest(params) {
    return {
        type: MessageType.PLAN_APPROVAL_REQUEST,
        from: params.from,
        timestamp: new Date().toISOString(),
        planFilePath: params.planFilePath,
        planContent: params.planContent,
        requestId: `plan-${randomUUID()}`,
    };
}
export function createPlanApprovalResponse(params) {
    return {
        type: MessageType.PLAN_APPROVAL_RESPONSE,
        requestId: params.requestId,
        approved: params.approved,
        feedback: params.feedback,
        timestamp: new Date().toISOString(),
        permissionMode: params.permissionMode,
    };
}
export function createSandboxPermissionRequest(params) {
    return {
        type: MessageType.SANDBOX_PERMISSION_REQUEST,
        requestId: `sandbox-${randomUUID()}`,
        workerId: params.workerId,
        workerName: params.workerName,
        hostPattern: { host: params.host },
        createdAt: Date.now(),
    };
}
export function createSandboxPermissionResponse(params) {
    return {
        type: MessageType.SANDBOX_PERMISSION_RESPONSE,
        requestId: params.requestId,
        host: params.host,
        allow: params.allow,
        timestamp: new Date().toISOString(),
    };
}
//# sourceMappingURL=message-protocol.js.map