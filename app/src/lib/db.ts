import Dexie, { type Table } from "dexie";

/**
 * Client cache (hybrid model — ARCH §3): haro's pi session store is the
 * system of record; this IndexedDB mirror makes history instant on open and
 * readable offline. It is rebuilt from the server (`get_messages` full
 * replace) whenever a conversation opens or a run settles — never treated as
 * authoritative. The composer is disabled while disconnected; the cache is
 * read-only by definition.
 */
export interface ConversationRow {
  key?: number;
  connId: string;
  convId: string;
  /** pi session file on the agent host this conversation is bound to */
  sessionPath: string | null;
  title: string | null;
  updatedAt: number;
}

/** One rendered bubble of the cached mirror. */
export interface MessageRow {
  key?: number;
  convId: string;
  seq: number;
  role: "user" | "assistant" | "system";
  text: string;
  ts: number;
}

export class HaroChatDB extends Dexie {
  conversations!: Table<ConversationRow, number>;
  messages!: Table<MessageRow, number>;

  constructor() {
    super("haro-chat");
    // v2: server-authoritative cache. The old client-owned `sessions` store
    // (Model B) is dropped — the cache is disposable and rebuilt on open.
    this.version(2).stores({
      conversations: "++key, connId, updatedAt, sessionPath",
      messages: "++key, [convId+seq], convId",
    });
  }
}

export const db = new HaroChatDB();

export async function listConversations(connId: string): Promise<ConversationRow[]> {
  const rows = await db.conversations.where("connId").equals(connId).sortBy("updatedAt");
  return rows.reverse();
}

/** Open (or create) a conversation bound to a pi session file (null = new). */
export async function openConversation(
  connId: string,
  convId: string,
  sessionPath: string | null,
  title?: string | null,
): Promise<ConversationRow> {
  const existing = await db.conversations
    .where("connId")
    .equals(connId)
    .and((r) => r.convId === convId)
    .first();
  if (existing) {
    await db.conversations.update(existing.key!, {
      sessionPath,
      updatedAt: Date.now(),
      ...(title !== undefined ? { title: title ?? existing.title } : {}),
    });
    return { ...existing, sessionPath, title: title ?? existing.title };
  }
  const row: ConversationRow = {
    connId,
    convId,
    sessionPath,
    title: title ?? null,
    updatedAt: Date.now(),
  };
  await db.conversations.add(row);
  return row;
}

/** Reuse the cache row already bound to a session file, if any. */
export async function findConversationBySession(
  connId: string,
  sessionPath: string,
): Promise<ConversationRow | undefined> {
  return db.conversations
    .where("connId")
    .equals(connId)
    .and((r) => r.sessionPath === sessionPath)
    .first();
}

export async function setConversationMeta(
  convId: string,
  meta: { sessionPath?: string | null; title?: string | null },
): Promise<void> {
  const row = await db.conversations.where("convId").equals(convId).first();
  if (row) await db.conversations.update(row.key!, { ...meta, updatedAt: Date.now() });
}

export async function deleteConversation(convId: string): Promise<void> {
  await db.transaction("rw", db.conversations, db.messages, async () => {
    const row = await db.conversations.where("convId").equals(convId).first();
    if (row?.key !== undefined) await db.conversations.delete(row.key);
    const msgs = await db.messages.where("convId").equals(convId).toArray();
    for (const m of msgs) if (m.key !== undefined) await db.messages.delete(m.key);
  });
}

export async function listMessages(convId: string): Promise<MessageRow[]> {
  return db.messages.where("convId").equals(convId).sortBy("seq");
}

/** Full replace — the cache never merges; the server is the source of truth. */
export async function replaceMessages(
  convId: string,
  msgs: { role: MessageRow["role"]; text: string }[],
): Promise<void> {
  await db.transaction("rw", db.messages, async () => {
    await db.messages.where("convId").equals(convId).delete();
    if (msgs.length > 0) {
      await db.messages.bulkAdd(
        msgs.map((m, seq) => ({ convId, seq, ts: Date.now(), ...m })),
      );
    }
  });
}
