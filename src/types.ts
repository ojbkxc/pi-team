/**
 * Type definitions for pi-team extension.
 *
 * These types model the runtime state of agent teams: members, tasks, plans,
 * messages, and fleet snapshots for the TUI.
 */

import type { TeamFileMember, TeamFile } from './teamHelpers.js'
import type { TeamPlanRecord, TeamPlanMember, TeamPlanTask } from './teamPlan.js'

// ---------------------------------------------------------------------------
// Core domain types
// ---------------------------------------------------------------------------

export type MemberStatus =
  | 'idle'
  | 'running'
  | 'waiting_for_dependencies'
  | 'terminated'
  | 'error'

export type TaskStatus =
  | 'pending'
  | 'assigned'
  | 'in_progress'
  | 'completed'
  | 'blocked'
  | 'failed'

export interface TeamMember {
  id: string
  name: string
  agentType: string
  prompt: string
  model?: string
  providerId?: string | null
  status: MemberStatus
  sessionId?: string
  color?: string
  joinedAt: number
  lastError?: string
}

export interface TeamTask {
  id: string
  subject: string
  description?: string
  ownerId?: string
  dependencies: string[]
  status: TaskStatus
}

export interface Team {
  name: string
  description?: string
  createdAt: number
  leadAgentId: string
  leadSessionId?: string
  members: TeamMember[]
  tasks: TeamTask[]
}

export interface TeamMessage {
  id: string
  from: string
  to: string | '*'
  text: string
  timestamp: string
  read: boolean
  color?: string
  summary?: string
}

export interface TeamPlan {
  planId: string
  teamName: string
  state: TeamPlanRecord['state']
  revision: number
  members: TeamPlanMember[]
  tasks: TeamPlanTask[]
  createdAt: number
  updatedAt: number
}

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

export interface TeamRuntime {
  name: string
  teamFile: TeamFile
  plan: TeamPlanRecord | null
  members: Map<string, TeamMember>
  tasks: Map<string, TeamTask>
  messages: TeamMessage[]
  lastReconciledAt: number
}

export interface TeamState {
  /** Create a new team with initial members and optional tasks. */
  createTeam(params: {
    teamName: string
    description?: string
    leadAgentId: string
    leadSessionId?: string
    members: Array<{
      name: string
      agentType: string
      prompt: string
      model?: string
      providerId?: string
    }>
    tasks?: Array<{
      id: string
      subject: string
      description?: string
      ownerId?: string
      dependencies?: string[]
    }>
  }): Promise<Team>

  /** Manage the team plan: get, submit, or update. */
  managePlan(params: {
    teamName: string
    operation: 'get' | 'submit' | 'update'
    plan?: Partial<TeamPlan>
  }): Promise<TeamPlanRecord | null>

  /** Delete a team and all its data. */
  deleteTeam(teamName: string): Promise<void>

  /** Handle an incoming mailbox message. */
  handleMessage(params: {
    teamName: string
    from: string
    to: string | '*'
    text: string
  }): Promise<void>

  /** List all known teams. */
  listTeams(): Promise<Team[]>

  /** Get a status summary for TUI display. */
  getStatusSummary(): Promise<TeamFleetSnapshot>

  /** Reconcile in-memory state from disk. */
  reconcileFromDisk(): Promise<void>

  /** Clean up resources. */
  dispose(): void
}

// ---------------------------------------------------------------------------
// TUI snapshot
// ---------------------------------------------------------------------------

export interface FleetMemberRow {
  name: string
  agentType: string
  status: MemberStatus
  model?: string
  color?: string
  lastError?: string
  taskSubject?: string
}

export interface FleetTaskRow {
  id: string
  subject: string
  ownerId?: string
  status: TaskStatus
  dependencies: string[]
}

export interface TeamFleetSnapshot {
  teams: Array<{
    name: string
    description?: string
    memberCount: number
    taskCount: number
    planState?: TeamPlanRecord['state']
    members: FleetMemberRow[]
    tasks: FleetTaskRow[]
  }>
  totalTeams: number
  totalMembers: number
  totalTasks: number
}