import { useCallback, useEffect, useRef, useState } from "react";
import { AGENT_SETTLED, uuid, type SessionInfo } from "@haro/shared";
import { loadConnections, setLastSessionPath, type Connection } from "./lib/connections";
import {
  findConversationBySession,
  listConversations,
  listMessages,
  openConversation,
  replaceMessages,
  setConversationMeta,
  deleteConversation,
  type ConversationRow,
  type MessageRow,
} from "./lib/db";
import { toChatMessages } from "./lib/chat";
import { RpcClient, type ConnStatus } from "./lib/rpc-client";
import { ChatView } from "./components/ChatView";
import { ConversationList } from "./components/ConversationList";

/**
 * Hybrid-model SPA (ARCH §3): haro's pi session store is the system of
 * record; this client keeps an offline cache (IndexedDB) that is re-synced
 * from the server whenever a conversation opens (get_messages full replace)
 * and after each run settles. The composer is enabled only while connected —
 * cached history is read-only by definition.
 */
export default function App() {
  const [connection] = useState<Connection>(() => loadConnections()[0]);
  const [conversations, setConversations] = useState<ConversationRow[]>([]);
  const [active, setActive] = useState<ConversationRow | null>(null);
  const [messages, setMessages] = useState<MessageRow[]>([]);
  /** optimistic user bubble for the in-flight prompt (never persisted) */
  const [optimistic, setOptimistic] = useState<MessageRow | null>(null);
  const [streaming, setStreaming] = useState("");
  const [status, setStatus] = useState<ConnStatus>("idle");
  /** past sessions on the agent host (Model A listing), null = not fetched */
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  /** Set when "Resume a past session…" was tapped with no conversation open:
   *  a conversation is created and the listing is requested once it connects. */
  const wantSessionsRef = useRef(false);

  const rpcRef = useRef<RpcClient | null>(null);
  const activeRef = useRef<ConversationRow | null>(null);
  const streamingRef = useRef("");
  const messagesRef = useRef<MessageRow[]>([]);
  /** Bumper for cached-message loads: only the latest switch may paint. */
  const loadSeqRef = useRef(0);

  activeRef.current = active;
  messagesRef.current = messages;

  const refreshConversations = useCallback(async () => {
    if (!connection) return;
    setConversations(await listConversations(connection.id));
  }, [connection]);

  // Boot: cached conversation list (instant, works offline).
  useEffect(() => {
    void refreshConversations();
  }, [refreshConversations]);

  /** Sync-on-open/settle: full get_messages replace + get_state adoption. */
  const syncActive = useCallback(async () => {
    const rpc = rpcRef.current;
    const conv = activeRef.current;
    if (!rpc || !conv || !connection) return;
    try {
      const [msgsRes, stateRes] = await Promise.all([
        rpc.request({ type: "get_messages" }),
        rpc.request({ type: "get_state" }),
      ]);
      if (!msgsRes.success) throw new Error(String(msgsRes.error ?? "get_messages failed"));
      const bubbles = toChatMessages(
        ((msgsRes.data as { messages?: unknown[] })?.messages ?? []) as never[],
      );
      await replaceMessages(conv.convId, bubbles);
      const fresh = await listMessages(conv.convId);
      // A sync may outlive its conversation (slow fetch while the user
      // switched): DB writes above still target the right row, but painting
      // must only happen if this conversation is still on screen — otherwise
      // the new chat shows the previous chat's messages.
      if (activeRef.current?.convId !== conv.convId) return;
      setMessages(fresh);
      setOptimistic(null);
      // Adopt the session identity pi created (new conversations only —
      // resumed ones already have their path).
      const st = (stateRes.data ?? {}) as {
        sessionFile?: string;
        sessionName?: string;
      };
      const meta: { sessionPath?: string | null; title?: string | null } = {};
      if (st.sessionFile) meta.sessionPath = st.sessionFile;
      if (st.sessionName) {
        meta.title = st.sessionName;
      } else if (!conv.title) {
        const firstUser = bubbles.find((b) => b.role === "user");
        if (firstUser) meta.title = firstUser.text.slice(0, 48);
      }
      if (meta.sessionPath || meta.title !== undefined) {
        await setConversationMeta(conv.convId, meta);
        if (meta.sessionPath) setLastSessionPath(connection.id, meta.sessionPath);
        void refreshConversations();
      }
    } catch (err) {
      // Sync is best-effort; callers decide the fallback. The cache stays
      // as-is and the offline UI remains read-only.
      console.error("[sync] failed:", err);
      throw err;
    }
  }, [connection, refreshConversations]);

  // One WS per active conversation + iOS resilience hooks.
  useEffect(() => {
    if (!connection || !active) return;

    const convId = active.convId;
    const rpc = new RpcClient({
      baseUrl: connection.url,
      convId,
      sessionPath: active.sessionPath,
      onRecord: (record) => {
        // Drop late records from a superseded client (its conversation was
        // switched away from): they would drive handleRecord against the
        // now-active conversation.
        if (rpcRef.current !== rpc || activeRef.current?.convId !== convId) return;
        void handleRecord(record, convId);
      },
      onCtl: (ctl) => {
        if (rpcRef.current !== rpc) return;
        if (ctl.ctl === "sessions") setSessions(ctl.sessions);
      },
      onStatus: (s) => {
        if (rpcRef.current !== rpc) return;
        setStatus(s);
        // Sync-on-open: reconcile the cache with the server's session store.
        if (s === "open") {
          if (wantSessionsRef.current) {
            wantSessionsRef.current = false;
            rpc.sendCtl({ ctl: "list_sessions" });
          }
          syncActive().catch(() => {});
        }
      },
    });
    rpcRef.current = rpc;
    rpc.connect();

    const rebind = () => rpc.rebind();
    document.addEventListener("visibilitychange", rebind);
    window.addEventListener("pageshow", rebind);
    window.addEventListener("online", rebind);

    return () => {
      document.removeEventListener("visibilitychange", rebind);
      window.removeEventListener("pageshow", rebind);
      window.removeEventListener("online", rebind);
      rpc.close();
      rpcRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, active?.convId, active?.sessionPath]);

  // Load the cached mirror when switching conversations.
  useEffect(() => {
    if (!active) {
      loadSeqRef.current += 1;
      setMessages([]);
      return;
    }
    const convId = active.convId;
    const seq = ++loadSeqRef.current;
    void listMessages(convId).then((rows) => {
      // Only the most recent switch may paint — a slow IndexedDB read for a
      // previously-active conversation must not overwrite the current view.
      if (seq === loadSeqRef.current && activeRef.current?.convId === convId) {
        setMessages(rows);
      }
    });
  }, [active]);

  async function handleRecord(record: unknown, convId: string) {
    const r = record as {
      type?: string;
      id?: string;
      success?: boolean;
      error?: unknown;
      command?: string;
      assistantMessageEvent?: { type?: string; delta?: string };
    };
    if (r?.type === "message_update") {
      const ev = r.assistantMessageEvent;
      if (ev?.type === "text_delta" && typeof ev.delta === "string") {
        streamingRef.current += ev.delta;
        setStreaming(streamingRef.current);
      }
      return;
    }
    if (r?.type === AGENT_SETTLED) {
      // The run ended: the session store now holds the truth — sync instead
      // of committing streaming text. Falls back to the streamed text if the
      // sync can't reach the server.
      const text = streamingRef.current;
      streamingRef.current = "";
      try {
        await syncActive();
      } catch {
        if (text && activeRef.current?.convId === convId) {
          const cur = activeRef.current;
          if (cur) {
            await replaceMessages(cur.convId, [
              ...messagesRef.current.map((m) => ({ role: m.role, text: m.text })),
              { role: "assistant" as const, text },
            ]);
            setMessages(await listMessages(cur.convId));
          }
        }
      }
      setStreaming("");
      return;
    }
    // Prompt accepted/queued/handled → the user message is now (or will be)
    // in the session store; a sync picks it up and clears the optimistic one.
    if (r?.type === "response" && r.command === "prompt" && r.success) {
      syncActive().catch(() => {});
      return;
    }
    if (r?.type === "response" && r.success === false && activeRef.current?.convId === convId) {
      const cur = activeRef.current;
      if (cur) {
        await replaceMessages(cur.convId, [
          ...messagesRef.current.map((m) => ({ role: m.role, text: m.text })),
          { role: "system" as const, text: `Error: ${JSON.stringify(r.error ?? "command failed")}` },
        ]);
        setMessages(await listMessages(cur.convId));
      }
    }
  }

  async function newConversation() {
    if (!connection) return;
    const row = await openConversation(connection.id, uuid(), null);
    setActive(row);
    setStreaming("");
    void refreshConversations();
  }

  /** Open a past session from the agent host's store (resume). */
  async function openSession(info: SessionInfo) {
    if (!connection) return;
    // Reuse the cache row already bound to this session, if we have one.
    const existing = await findConversationBySession(connection.id, info.path);
    const row = existing ?? {
      connId: connection.id,
      convId: uuid(),
      sessionPath: info.path,
      title: info.name ?? `Session ${info.id.slice(0, 8)}`,
      updatedAt: Date.now(),
    };
    const saved = await openConversation(
      connection.id,
      row.convId,
      info.path,
      info.name ?? `Session ${info.id.slice(0, 8)}`,
    );
    setActive(saved);
    setStreaming("");
    void refreshConversations();
  }

  function requestSessions() {
    setSessions(null); // loading
    if (rpcRef.current && status === "open") {
      rpcRef.current.sendCtl({ ctl: "list_sessions" });
      return;
    }
    // No conversation open → no WS exists yet. Create one; the listing is
    // requested when it connects (see onStatus). Previously this was a
    // silent no-op — the picker never appeared.
    wantSessionsRef.current = true;
    void newConversation();
  }

  async function send(text: string) {
    if (!connection || !active || status !== "open") return;
    // Optimistic user bubble — the session store becomes authoritative on
    // the next sync (prompt-response or agent_settled).
    setOptimistic({
      convId: active.convId,
      seq: messages.length,
      role: "user",
      text,
      ts: Date.now(),
    });
    rpcRef.current?.sendPi({ id: uuid(), type: "prompt", message: text });
  }

  if (!connection) return null;

  const shown = optimistic ? [...messages, optimistic] : messages;

  return (
    <div className="flex h-full">
      <ConversationList
        serverName={connection.name}
        conversations={conversations}
        activeConvId={active?.convId ?? null}
        onSelect={async (convId) => {
          const row = conversations.find((c) => c.convId === convId);
          if (row) setActive(row);
        }}
        onNew={() => void newConversation()}
        sessions={sessions}
        onBrowseSessions={requestSessions}
        onSelectSession={(info) => void openSession(info)}
        onCloseSessions={() => {
          wantSessionsRef.current = false;
          setSessions(null);
        }}
      />
      <div className="flex-1">
        <ChatView
          title={active?.title ?? null}
          status={status}
          connected={status === "open"}
          messages={shown}
          streaming={streaming}
          onSend={(t) => void send(t)}
        />
      </div>
    </div>
  );
}

// Delete-with-confirm (v0.2) is reachable from the list — scaffold exports it
// so the call site doesn't rot; wire the button when multi-conversation ships.
export { deleteConversation };
