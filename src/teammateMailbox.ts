/**
 * Teammate mailbox — extracted from cc-haha's teammateMailbox.ts
 *
 * Changes from original:
 * - envUtils.getTeamsDir → constants.getTeamsDir (~/.pi/agent/teams)
 * - getTeamName() env lookup → required explicit teamName (default 'default')
 * - Removed idle/permission/shutdown structured message types (already in
 *   message-protocol.ts)
 * - logForDebugging/logError → console.error (debug-gated)
 * - Kept: live inbox + append-only history, identity-based claim, atomic
 *   rename writes, Windows rename retry, proper-lockfile inbox lock
 */

import { randomUUID } from 'node:crypto'
import { open, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as lockfile from 'proper-lockfile'
import { getTeamsDir, TEAM_LEAD_NAME } from './constants.js'
import { sanitizePathComponent } from './teamHelpers.js'

function logDebug(message: string): void {
  if (process.env.PI_TEAM_DEBUG) console.error(`[pi-team:mailbox] ${message}`)
}

function getErrnoCode(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException)?.code
  return typeof code === 'string' ? code : undefined
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// The team lead's inbox is a fan-in point for every teammate's messages and
// idle notifications, and a writer that runs out of retries loses its
// message. The budget therefore matches the plan lock (~2.6s total wait).
const LOCK_OPTIONS = {
  retries: {
    retries: 30,
    minTimeout: 5,
    maxTimeout: 100,
  },
}

// Windows readers can briefly prevent a rename from replacing the inbox.
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])

export type TeammateMessage = {
  /** Stable envelope identity. Older mailbox records may not have one. */
  id?: string
  from: string
  text: string
  timestamp: string
  read: boolean
  color?: string // Sender's assigned color (e.g., 'red', 'blue', 'green')
  summary?: string // 5-10 word summary shown as preview in the UI
}

export function createMailboxMessageId(): string {
  return `mailbox-${randomUUID()}`
}

export function createMailboxMessage(
  message: Omit<TeammateMessage, 'read'>,
): TeammateMessage {
  return {
    ...message,
    id: message.id ?? createMailboxMessageId(),
    read: false,
  }
}

export function isTrustedTeamLeaderMessage(message: TeammateMessage): boolean {
  return message.from === TEAM_LEAD_NAME
}

/**
 * Get the path to a teammate's inbox file
 * Structure: ~/.pi/agent/teams/{team_name}/inboxes/{agent_name}.json
 */
export function getInboxPath(agentName: string, teamName?: string): string {
  const team = teamName || 'default'
  const safeTeam = sanitizePathComponent(team)
  const safeAgentName = sanitizePathComponent(agentName)
  return join(getTeamsDir(), safeTeam, 'inboxes', `${safeAgentName}.json`)
}

async function ensureInboxDir(teamName?: string): Promise<void> {
  const team = teamName || 'default'
  const inboxDir = join(getTeamsDir(), sanitizePathComponent(team), 'inboxes')
  await mkdir(inboxDir, { recursive: true })
}

/** Suffix of the append-only file that keeps a recipient's read messages. */
export const MAILBOX_HISTORY_SUFFIX = '.history.jsonl'

/**
 * Path of the history file that sits beside a live inbox file
 * ({agent_name}.json -> {agent_name}.history.jsonl).
 */
export function getInboxHistoryPath(inboxPath: string): string {
  const stem = inboxPath.endsWith('.json')
    ? inboxPath.slice(0, -'.json'.length)
    : inboxPath
  return `${stem}${MAILBOX_HISTORY_SUFFIX}`
}

/**
 * Identity used to acknowledge exactly the messages a consumer delivered.
 * Envelope ids are unique per message; records written before ids existed
 * fall back to sender, timestamp and text.
 */
export function getMailboxMessageIdentity(
  message: Pick<TeammateMessage, 'id' | 'from' | 'timestamp' | 'text'>,
): string {
  return message.id
    ? `id:${message.id}`
    : `legacy:${message.from}|${message.timestamp}|${message.text}`
}

function isMailboxRecord(value: unknown): value is TeammateMessage {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parses a live inbox. Returns undefined for a damaged file. Legacy inboxes
 * (pretty-printed, still holding read entries) parse the same way.
 */
function parseInboxContent(content: string): TeammateMessage[] | undefined {
  // A brand-new inbox is created empty before '[]' lands in it.
  if (content.trim() === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return undefined
  }
  if (!Array.isArray(parsed)) return undefined
  // A non-object entry would break every consumer's `message.read` check.
  return parsed.filter(isMailboxRecord)
}

async function readInboxFile(inboxPath: string): Promise<TeammateMessage[]> {
  let content: string
  try {
    content = await readFile(inboxPath, 'utf-8')
  } catch (error) {
    if (getErrnoCode(error) === 'ENOENT') return []
    logDebug(`Failed to read inbox ${inboxPath}: ${error}`)
    return []
  }
  const messages = parseInboxContent(content)
  if (!messages) {
    // Writes are atomic, so this is a damaged file rather than a write in
    // progress. The next locked mutation keeps a copy before replacing it.
    logDebug(`unparseable inbox at ${inboxPath}, treating as empty`)
    return []
  }
  return messages
}

async function readInboxHistory(historyPath: string): Promise<TeammateMessage[]> {
  let content: string
  try {
    content = await readFile(historyPath, 'utf-8')
  } catch (error) {
    if (getErrnoCode(error) !== 'ENOENT') {
      logDebug(`Failed to read inbox history ${historyPath}: ${error}`)
    }
    return []
  }
  const messages: TeammateMessage[] = []
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (isMailboxRecord(parsed)) messages.push({ ...parsed, read: true })
    } catch {
      // A crash can tear the last line; the next append starts a fresh one.
    }
  }
  return messages
}

/**
 * Read all messages (unread live inbox + history) from a teammate's inbox.
 */
export async function readMailbox(
  agentName: string,
  teamName?: string,
): Promise<TeammateMessage[]> {
  const inboxPath = getInboxPath(agentName, teamName)
  const [live, history] = await Promise.all([
    readInboxFile(inboxPath),
    readInboxHistory(getInboxHistoryPath(inboxPath)),
  ])
  const seen = new Set<string>()
  const result: TeammateMessage[] = []
  for (const message of [...live, ...history]) {
    const identity = getMailboxMessageIdentity(message)
    if (seen.has(identity)) continue
    seen.add(identity)
    result.push(message)
  }
  return result
}

/**
 * Read only unread messages from a teammate's live inbox.
 */
export async function readUnreadMessages(
  agentName: string,
  teamName?: string,
): Promise<TeammateMessage[]> {
  const messages = await readInboxFile(getInboxPath(agentName, teamName))
  return messages.filter(message => !message.read)
}

/**
 * Read a teammate's full mailbox history (read messages only).
 */
export async function readMailboxHistory(
  agentName: string,
  teamName?: string,
): Promise<TeammateMessage[]> {
  const historyPath = getInboxHistoryPath(getInboxPath(agentName, teamName))
  return readInboxHistory(historyPath)
}

async function readInboxForUpdate(
  inboxPath: string,
): Promise<{ messages: TeammateMessage[]; content?: string }> {
  let content: string
  try {
    content = await readFile(inboxPath, 'utf-8')
  } catch (error) {
    if (getErrnoCode(error) === 'ENOENT') return { messages: [] }
    // Never rewrite an inbox that could not be read: that would drop it.
    throw error
  }
  const messages = parseInboxContent(content)
  if (messages) return { messages, content }
  const preservedPath = `${inboxPath}.corrupt-${Date.now()}`
  await copyFile(inboxPath, preservedPath)
  logDebug(`unparseable inbox preserved at ${preservedPath} before it is replaced`)
  return { messages: [] }
}

// Call only while holding the inbox lock.
async function appendInboxHistory(
  historyPath: string,
  messages: TeammateMessage[],
): Promise<void> {
  if (messages.length === 0) return
  const lines = messages
    .map(message => JSON.stringify({ ...message, read: true }))
    .join('\n')
  const handle = await open(historyPath, 'a+')
  try {
    // A crash can leave a torn last line; start on a fresh line so the torn
    // fragment cannot swallow the entries appended now.
    const { size } = await handle.stat()
    let separator = ''
    if (size > 0) {
      const last = Buffer.alloc(1)
      await handle.read(last, 0, 1, size - 1)
      if (last[0] !== 0x0a) separator = '\n'
    }
    await handle.write(`${separator}${lines}\n`)
  } finally {
    await handle.close()
  }
}

// Call only while holding the inbox lock. Readers take no lock: rename
// exposes either the complete previous inbox or the complete replacement.
async function replaceInboxFile(inboxPath: string, content: string): Promise<void> {
  const temporaryPath = `${inboxPath}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, content, { encoding: 'utf-8', flag: 'wx' })
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(temporaryPath, inboxPath)
        return
      } catch (error) {
        // Never unlink the live inbox: exhausted retries must leave its
        // previous contents intact.
        if (
          process.platform !== 'win32' ||
          attempt >= 5 ||
          !RENAME_RETRY_CODES.has(getErrnoCode(error) ?? '')
        ) {
          throw error
        }
        await sleep(10 * (attempt + 1))
      }
    }
  } finally {
    await rm(temporaryPath, { force: true })
  }
}

/**
 * Applies `update` to a live inbox under its lock. Entries the result holds
 * as read move to the history file; only unread entries are republished, as
 * compact JSON. Throws when the lock or the file cannot be used.
 */
async function updateInbox(
  inboxPath: string,
  update: (messages: TeammateMessage[]) => TeammateMessage[],
): Promise<void> {
  const release = await lockfile.lock(inboxPath, {
    lockfilePath: `${inboxPath}.lock`,
    realpath: false,
    ...LOCK_OPTIONS,
  })
  try {
    const current = await readInboxForUpdate(inboxPath)
    const next = update(current.messages)
    // History first: a crash between the two steps can repeat an entry,
    // which readers deduplicate, but can never lose one.
    await appendInboxHistory(
      getInboxHistoryPath(inboxPath),
      next.filter(message => message.read),
    )
    const content = JSON.stringify(next.filter(message => !message.read))
    if (content !== current.content) {
      await replaceInboxFile(inboxPath, content)
    }
  } finally {
    try {
      await release()
    } catch (error) {
      logDebug(`inbox lock release failed: ${error}`)
    }
  }
}

/**
 * Write a message to a teammate's inbox.
 * @returns true once the message is persisted; false when it was not (for
 *   example the inbox stayed locked past the retry budget). Never throws, so
 *   callers must check the result before reporting a message as sent.
 */
export async function writeToMailbox(
  recipientName: string,
  message: Omit<TeammateMessage, 'read'>,
  teamName?: string,
): Promise<boolean> {
  const inboxPath = getInboxPath(recipientName, teamName)
  try {
    await ensureInboxDir(teamName)

    // Ensure the inbox file exists before locking (proper-lockfile requires it)
    try {
      await writeFile(inboxPath, '[]', { encoding: 'utf-8', flag: 'wx' })
    } catch (error) {
      if (getErrnoCode(error) !== 'EEXIST') throw error
    }

    const newMessage = createMailboxMessage(message)
    await updateInbox(inboxPath, messages => [...messages, newMessage])
    return true
  } catch (error) {
    logDebug(`Failed to write to inbox for ${recipientName}: ${error}`)
    return false
  }
}

/**
 * Marks exactly `candidates` read, matched by identity, and resolves to the
 * subset that was still unread -- the messages this caller now owns.
 * Messages appended after the caller's read stay unread, and two consumers
 * racing on one inbox can never both claim the same message. Resolves
 * undefined when the inbox could not be updated; nothing was claimed then.
 */
export async function claimMailboxMessages(
  agentName: string,
  teamName: string | undefined,
  candidates: readonly TeammateMessage[],
): Promise<TeammateMessage[] | undefined> {
  if (candidates.length === 0) return []
  const identities = new Set(candidates.map(getMailboxMessageIdentity))
  const inboxPath = getInboxPath(agentName, teamName)
  let claimed: TeammateMessage[] = []
  try {
    await updateInbox(inboxPath, messages => {
      claimed = []
      return messages.map(message => {
        if (message.read || !identities.has(getMailboxMessageIdentity(message))) {
          return message
        }
        claimed.push(message)
        return { ...message, read: true }
      })
    })
    return claimed
  } catch (error) {
    // Without an inbox there is nothing left to claim.
    if (getErrnoCode(error) === 'ENOENT') return []
    logDebug(`could not mark ${candidates.length} message(s) read for ${agentName}: ${error}`)
    return undefined
  }
}

/**
 * Marks exactly the delivered messages read (by identity), leaving anything
 * that arrived after the caller's read untouched.
 * @returns true when none of `delivered` is unread any more; false when the
 *   inbox could not be updated (the messages will be read again).
 */
export async function markMessagesAsReadByIdentity(
  agentName: string,
  teamName: string | undefined,
  delivered: readonly TeammateMessage[],
): Promise<boolean> {
  return (
    (await claimMailboxMessages(agentName, teamName, delivered)) !== undefined
  )
}

/**
 * Clear a teammate's inbox. The messages leave the live inbox but remain in
 * its history.
 */
export async function clearMailbox(
  agentName: string,
  teamName?: string,
): Promise<void> {
  const inboxPath = getInboxPath(agentName, teamName)
  try {
    // Locking a missing file fails with ENOENT, so a clear never creates one.
    await updateInbox(inboxPath, messages =>
      messages.map(message =>
        message.read ? message : { ...message, read: true },
      ),
    )
  } catch (error) {
    if (getErrnoCode(error) === 'ENOENT') return
    logDebug(`Failed to clear inbox for ${agentName}: ${error}`)
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

type TeammateMessageEnvelope = {
  from: string
  text: string
  color?: string
  summary?: string
}

export const TEAMMATE_MESSAGE_TAG = 'teammate-message'

function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Formats one teammate message as the `<teammate-message>` block that models
 * and transcript renderers parse. Attribute values are escaped so a sender
 * name, color or summary can neither end its attribute nor forge another
 * envelope.
 */
export function formatTeammateMessage(message: TeammateMessageEnvelope): string {
  const colorAttr = message.color
    ? ` color="${escapeXmlAttr(message.color)}"`
    : ''
  const summaryAttr = message.summary
    ? ` summary="${escapeXmlAttr(message.summary)}"`
    : ''
  return `<${TEAMMATE_MESSAGE_TAG} teammate_id="${escapeXmlAttr(message.from)}"${colorAttr}${summaryAttr}>\n${message.text}\n</${TEAMMATE_MESSAGE_TAG}>`
}

/**
 * Format teammate messages as XML for attachment display
 */
export function formatTeammateMessages(
  messages: readonly TeammateMessageEnvelope[],
): string {
  return messages.map(formatTeammateMessage).join('\n\n')
}
