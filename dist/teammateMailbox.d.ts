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
export type TeammateMessage = {
    /** Stable envelope identity. Older mailbox records may not have one. */
    id?: string;
    from: string;
    text: string;
    timestamp: string;
    read: boolean;
    color?: string;
    summary?: string;
};
export declare function createMailboxMessageId(): string;
export declare function createMailboxMessage(message: Omit<TeammateMessage, 'read'>): TeammateMessage;
export declare function isTrustedTeamLeaderMessage(message: TeammateMessage): boolean;
/**
 * Get the path to a teammate's inbox file
 * Structure: ~/.pi/agent/teams/{team_name}/inboxes/{agent_name}.json
 */
export declare function getInboxPath(agentName: string, teamName?: string): string;
/** Suffix of the append-only file that keeps a recipient's read messages. */
export declare const MAILBOX_HISTORY_SUFFIX = ".history.jsonl";
/**
 * Path of the history file that sits beside a live inbox file
 * ({agent_name}.json -> {agent_name}.history.jsonl).
 */
export declare function getInboxHistoryPath(inboxPath: string): string;
/**
 * Identity used to acknowledge exactly the messages a consumer delivered.
 * Envelope ids are unique per message; records written before ids existed
 * fall back to sender, timestamp and text.
 */
export declare function getMailboxMessageIdentity(message: Pick<TeammateMessage, 'id' | 'from' | 'timestamp' | 'text'>): string;
/**
 * Read all messages (unread live inbox + history) from a teammate's inbox.
 */
export declare function readMailbox(agentName: string, teamName?: string): Promise<TeammateMessage[]>;
/**
 * Read only unread messages from a teammate's live inbox.
 */
export declare function readUnreadMessages(agentName: string, teamName?: string): Promise<TeammateMessage[]>;
/**
 * Read a teammate's full mailbox history (read messages only).
 */
export declare function readMailboxHistory(agentName: string, teamName?: string): Promise<TeammateMessage[]>;
/**
 * Write a message to a teammate's inbox.
 * @returns true once the message is persisted; false when it was not (for
 *   example the inbox stayed locked past the retry budget). Never throws, so
 *   callers must check the result before reporting a message as sent.
 */
export declare function writeToMailbox(recipientName: string, message: Omit<TeammateMessage, 'read'>, teamName?: string): Promise<boolean>;
/**
 * Marks exactly `candidates` read, matched by identity, and resolves to the
 * subset that was still unread -- the messages this caller now owns.
 * Messages appended after the caller's read stay unread, and two consumers
 * racing on one inbox can never both claim the same message. Resolves
 * undefined when the inbox could not be updated; nothing was claimed then.
 */
export declare function claimMailboxMessages(agentName: string, teamName: string | undefined, candidates: readonly TeammateMessage[]): Promise<TeammateMessage[] | undefined>;
/**
 * Marks exactly the delivered messages read (by identity), leaving anything
 * that arrived after the caller's read untouched.
 * @returns true when none of `delivered` is unread any more; false when the
 *   inbox could not be updated (the messages will be read again).
 */
export declare function markMessagesAsReadByIdentity(agentName: string, teamName: string | undefined, delivered: readonly TeammateMessage[]): Promise<boolean>;
/**
 * Clear a teammate's inbox. The messages leave the live inbox but remain in
 * its history.
 */
export declare function clearMailbox(agentName: string, teamName?: string): Promise<void>;
type TeammateMessageEnvelope = {
    from: string;
    text: string;
    color?: string;
    summary?: string;
};
export declare const TEAMMATE_MESSAGE_TAG = "teammate-message";
/**
 * Formats one teammate message as the `<teammate-message>` block that models
 * and transcript renderers parse. Attribute values are escaped so a sender
 * name, color or summary can neither end its attribute nor forge another
 * envelope.
 */
export declare function formatTeammateMessage(message: TeammateMessageEnvelope): string;
/**
 * Format teammate messages as XML for attachment display
 */
export declare function formatTeammateMessages(messages: readonly TeammateMessageEnvelope[]): string;
export {};
