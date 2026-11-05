/**
 * Message protocol for inter-agent communication.
 *
 * Defines the structured message types exchanged via mailbox, plus
 * serialization/deserialization helpers. Each message type has a
 * discriminator field `type` and a corresponding type guard.
 */

import { randomUUID } from 'node:crypto'

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
} as const

export type MessageTypeValue = (typeof MessageType)[keyof typeof MessageType]

// ---------------------------------------------------------------------------
// Structured message shapes
// ---------------------------------------------------------------------------

export interface IdleNotificationMessage {
  type: typeof MessageType.IDLE_NOTIFICATION
  from: string
  timestamp: string
  idleReason?: 'available' | 'interrupted' | 'failed'
  summary?: string
  completedTaskId?: string
  completedStatus?: 'resolved' | 'blocked' | 'failed'
  failureReason?: string
  result?: string
}

export interface TaskAssignmentMessage {
  type: typeof MessageType.TASK_ASSIGNMENT
  taskId: string
  subject: string
  description: string
  assignedBy: string
  timestamp: string
}

export interface PermissionRequestMessage {
  type: typeof MessageType.PERMISSION_REQUEST
  request_id: string
  agent_id: string
  tool_name: string
  tool_use_id: string
  description: string
  input: Record<string, unknown>
  permission_suggestions: unknown[]
}

export interface PermissionResponseMessage {
  type: typeof MessageType.PERMISSION_RESPONSE
  request_id: string
  subtype: 'success' | 'error'
  error?: string
  updated_input?: Record<string, unknown>
}

export interface PlanApprovalRequestMessage {
  type: typeof MessageType.PLAN_APPROVAL_REQUEST
  from: string
  timestamp: string
  planFilePath: string
  planContent: string
  requestId: string
}

export interface PlanApprovalResponseMessage {
  type: typeof MessageType.PLAN_APPROVAL_RESPONSE
  requestId: string
  approved: boolean
  feedback?: string
  timestamp: string
  permissionMode?: string
}

export interface ShutdownRequestMessage {
  type: typeof MessageType.SHUTDOWN_REQUEST
  requestId: string
  from: string
  reason?: string
  timestamp: string
}

export interface ShutdownApprovedMessage {
  type: typeof MessageType.SHUTDOWN_APPROVED
  requestId: string
  from: string
  timestamp: string
}

export interface ShutdownRejectedMessage {
  type: typeof MessageType.SHUTDOWN_REJECTED
  requestId: string
  from: string
  reason: string
  timestamp: string
}

export interface ModeSetRequestMessage {
  type: typeof MessageType.MODE_SET_REQUEST
  mode: string
  from: string
}

export interface SandboxPermissionRequestMessage {
  type: typeof MessageType.SANDBOX_PERMISSION_REQUEST
  requestId: string
  workerId: string
  workerName: string
  hostPattern: { host: string }
  createdAt: number
}

export interface SandboxPermissionResponseMessage {
  type: typeof MessageType.SANDBOX_PERMISSION_RESPONSE
  requestId: string
  host: string
  allow: boolean
  timestamp: string
}

export type StructuredMessage =
  | IdleNotificationMessage
  | TaskAssignmentMessage
  | PermissionRequestMessage
  | PermissionResponseMessage
  | PlanApprovalRequestMessage
  | PlanApprovalResponseMessage
  | ShutdownRequestMessage
  | ShutdownApprovedMessage
  | ShutdownRejectedMessage
  | ModeSetRequestMessage
  | SandboxPermissionRequestMessage
  | SandboxPermissionResponseMessage

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

export function serializeMessage(message: StructuredMessage): string {
  return JSON.stringify(message)
}

export function deserializeMessage(text: string): StructuredMessage | null {
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && 'type' in parsed) {
      return parsed as StructuredMessage
    }
  } catch {
    // Not valid JSON
  }
  return null
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

export function isIdleNotification(msg: StructuredMessage): msg is IdleNotificationMessage {
  return msg.type === MessageType.IDLE_NOTIFICATION
}

export function isTaskAssignment(msg: StructuredMessage): msg is TaskAssignmentMessage {
  return msg.type === MessageType.TASK_ASSIGNMENT
}

export function isPermissionRequest(msg: StructuredMessage): msg is PermissionRequestMessage {
  return msg.type === MessageType.PERMISSION_REQUEST
}

export function isPermissionResponse(msg: StructuredMessage): msg is PermissionResponseMessage {
  return msg.type === MessageType.PERMISSION_RESPONSE
}

export function isPlanApprovalRequest(msg: StructuredMessage): msg is PlanApprovalRequestMessage {
  return msg.type === MessageType.PLAN_APPROVAL_REQUEST
}

export function isPlanApprovalResponse(msg: StructuredMessage): msg is PlanApprovalResponseMessage {
  return msg.type === MessageType.PLAN_APPROVAL_RESPONSE
}

export function isShutdownRequest(msg: StructuredMessage): msg is ShutdownRequestMessage {
  return msg.type === MessageType.SHUTDOWN_REQUEST
}

export function isShutdownApproved(msg: StructuredMessage): msg is ShutdownApprovedMessage {
  return msg.type === MessageType.SHUTDOWN_APPROVED
}

export function isShutdownRejected(msg: StructuredMessage): msg is ShutdownRejectedMessage {
  return msg.type === MessageType.SHUTDOWN_REJECTED
}

export function isModeSetRequest(msg: StructuredMessage): msg is ModeSetRequestMessage {
  return msg.type === MessageType.MODE_SET_REQUEST
}

export function isSandboxPermissionRequest(msg: StructuredMessage): msg is SandboxPermissionRequestMessage {
  return msg.type === MessageType.SANDBOX_PERMISSION_REQUEST
}

export function isSandboxPermissionResponse(msg: StructuredMessage): msg is SandboxPermissionResponseMessage {
  return msg.type === MessageType.SANDBOX_PERMISSION_RESPONSE
}

export function isStructuredProtocolMessage(text: string): boolean {
  const msg = deserializeMessage(text)
  return msg !== null
}

// ---------------------------------------------------------------------------
// Message factory helpers
// ---------------------------------------------------------------------------

export function createIdleNotification(
  from: string,
  options?: {
    idleReason?: IdleNotificationMessage['idleReason']
    summary?: string
    completedTaskId?: string
    completedStatus?: 'resolved' | 'blocked' | 'failed'
    failureReason?: string
    result?: string
  },
): IdleNotificationMessage {
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
  }
}

export function createTaskAssignment(params: {
  taskId: string
  subject: string
  description: string
  assignedBy: string
}): TaskAssignmentMessage {
  return {
    type: MessageType.TASK_ASSIGNMENT,
    taskId: params.taskId,
    subject: params.subject,
    description: params.description,
    assignedBy: params.assignedBy,
    timestamp: new Date().toISOString(),
  }
}

export function createShutdownRequest(params: {
  from: string
  reason?: string
}): ShutdownRequestMessage {
  return {
    type: MessageType.SHUTDOWN_REQUEST,
    requestId: `shutdown-${randomUUID()}`,
    from: params.from,
    reason: params.reason,
    timestamp: new Date().toISOString(),
  }
}

export function createShutdownApproved(params: {
  requestId: string
  from: string
}): ShutdownApprovedMessage {
  return {
    type: MessageType.SHUTDOWN_APPROVED,
    requestId: params.requestId,
    from: params.from,
    timestamp: new Date().toISOString(),
  }
}

export function createShutdownRejected(params: {
  requestId: string
  from: string
  reason: string
}): ShutdownRejectedMessage {
  return {
    type: MessageType.SHUTDOWN_REJECTED,
    requestId: params.requestId,
    from: params.from,
    reason: params.reason,
    timestamp: new Date().toISOString(),
  }
}

export function createModeSetRequest(params: {
  mode: string
  from: string
}): ModeSetRequestMessage {
  return {
    type: MessageType.MODE_SET_REQUEST,
    mode: params.mode,
    from: params.from,
  }
}

export function createPermissionRequest(params: {
  request_id: string
  agent_id: string
  tool_name: string
  tool_use_id: string
  description: string
  input: Record<string, unknown>
  permission_suggestions?: unknown[]
}): PermissionRequestMessage {
  return {
    type: MessageType.PERMISSION_REQUEST,
    request_id: params.request_id,
    agent_id: params.agent_id,
    tool_name: params.tool_name,
    tool_use_id: params.tool_use_id,
    description: params.description,
    input: params.input,
    permission_suggestions: params.permission_suggestions || [],
  }
}

export function createPermissionResponse(params: {
  request_id: string
  subtype: 'success' | 'error'
  error?: string
  updated_input?: Record<string, unknown>
}): PermissionResponseMessage {
  if (params.subtype === 'error') {
    return {
      type: MessageType.PERMISSION_RESPONSE,
      request_id: params.request_id,
      subtype: 'error',
      error: params.error || 'Permission denied',
    }
  }
  return {
    type: MessageType.PERMISSION_RESPONSE,
    request_id: params.request_id,
    subtype: 'success',
    updated_input: params.updated_input,
  }
}

export function createPlanApprovalRequest(params: {
  from: string
  planFilePath: string
  planContent: string
}): PlanApprovalRequestMessage {
  return {
    type: MessageType.PLAN_APPROVAL_REQUEST,
    from: params.from,
    timestamp: new Date().toISOString(),
    planFilePath: params.planFilePath,
    planContent: params.planContent,
    requestId: `plan-${randomUUID()}`,
  }
}

export function createPlanApprovalResponse(params: {
  requestId: string
  approved: boolean
  feedback?: string
  permissionMode?: string
}): PlanApprovalResponseMessage {
  return {
    type: MessageType.PLAN_APPROVAL_RESPONSE,
    requestId: params.requestId,
    approved: params.approved,
    feedback: params.feedback,
    timestamp: new Date().toISOString(),
    permissionMode: params.permissionMode,
  }
}

export function createSandboxPermissionRequest(params: {
  workerId: string
  workerName: string
  host: string
}): SandboxPermissionRequestMessage {
  return {
    type: MessageType.SANDBOX_PERMISSION_REQUEST,
    requestId: `sandbox-${randomUUID()}`,
    workerId: params.workerId,
    workerName: params.workerName,
    hostPattern: { host: params.host },
    createdAt: Date.now(),
  }
}

export function createSandboxPermissionResponse(params: {
  requestId: string
  host: string
  allow: boolean
}): SandboxPermissionResponseMessage {
  return {
    type: MessageType.SANDBOX_PERMISSION_RESPONSE,
    requestId: params.requestId,
    host: params.host,
    allow: params.allow,
    timestamp: new Date().toISOString(),
  }
}