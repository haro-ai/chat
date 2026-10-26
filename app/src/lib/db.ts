import Dexie, { type Table } from "dexie";

/**
 * Client-owned data (ARCH §4) — the ONLY durable copy of chats.
 * - `sessions`: per-conversation metadata + the pi session JSONL mirror.
 *   Full portable-session plumbing (snapshot/delta handoff to haro) is v0.2;
 *   v0.1 keeps the shallow mirror in `messages`.
 * - v0.3 adds at-rest encryption (AES-256-GCM) + `navigator.storage.persist()`.
 */
export interface SessionRow {
  key?: number;
  connId: string;
  convId: string;
  title: string | null;
  updatedAt: number;
  /** pi session JSONL lines (append-only past the last exchanged entry id) */
  lines: string[];
}

/** Shallow v0.1 mirror: one bubble per rendered message. */
export interface MessageRow {
  key?: number;
  convId: string;
  seq: number;
  role: "user" | "assistant" | "system";
  text: string;
  ts: number;
}

export class HaroChatDB extends Dexie {
  sessions!: Table<SessionRow, number>;
  messages!: Table<MessageRow, number>;

  constructor() {
    super("haro-chat");
    this.version(1).stores({
      sessions: "++key, [connId+convId], connId, updatedAt",
      messages: "++key, [convId+seq], convId",
    });
  }
}

export const db = new HaroChatDB();

export async function listConversations(connId: string): Promise<SessionRow[]> {
  const rows = await db.sessions.where("connId").equals(connId).sortBy("updatedAt");
  return rows.reverse();
}

export async function createConversation(
  connId: string,
  convId: string,
): Promise<SessionRow> {
  const row: SessionRow = {
    connId,
    convId,
    title: null,
    updatedAt: Date.now(),
    lines: [],
  };
  await db.sessions.add(row);
  return row;
}

export async function deleteConversation(
  connId: string,
  convId: string,
): Promise<void> {
  await db.transaction("rw", db.sessions, db.messages, async () => {
    const session = await db.sessions
      .where("[connId+convId]")
      .equals([connId, convId])
      .first();
    if (session?.key !== undefined) await db.sessions.delete(session.key);
    const msgs = await db.messages.where("convId").equals(convId).toArray();
    for (const m of msgs) if (m.key !== undefined) await db.messages.delete(m.key);
  });
}

export async function touchConversation(connId: string, convId: string): Promise<void> {
  const session = await db.sessions
    .where("[connId+convId]")
    .equals([connId, convId])
    .first();
  if (session?.key !== undefined) {
    await db.sessions.update(session.key, { updatedAt: Date.now() });
  }
}

export async function listMessages(convId: string): Promise<MessageRow[]> {
  return db.messages.where("convId").equals(convId).sortBy("seq");
}

export async function addMessage(
  row: Omit<MessageRow, "key" | "seq">,
): Promise<void> {
  const seq = await db.messages.where("convId").equals(row.convId).count();
  await db.messages.add({ ...row, seq });
}

export async function countMessages(convId: string): Promise<number> {
  return db.messages.where("convId").equals(convId).count();
}