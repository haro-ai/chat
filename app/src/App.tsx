import { useCallback, useEffect, useRef, useState } from "react";
import { AGENT_SETTLED } from "@haro/shared";
import { loadConnections, setLastConvId, type Connection } from "./lib/connections";
import {
  addMessage,
  createConversation,
  listConversations,
  listMessages,
  touchConversation,
  deleteConversation,
  type MessageRow,
  type SessionRow,
} from "./lib/db";
import { RpcClient, type ConnStatus } from "./lib/rpc-client";
import { ChatView } from "./components/ChatView";
import { ConversationList } from "./components/ConversationList";

/**
 * v0.1 minimal SPA (PRD §4): one hardcoded connection (haro), a conversation
 * list, composer + streaming renderer, shallow client-side mirror in
 * IndexedDB. Refresh keeps history; the server keeps nothing (R5).
 */
export default function App() {
  const [connection] = useState<Connection>(() => loadConnections()[0]);
  const [conversations, setConversations] = useState<SessionRow[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [streaming, setStreaming] = useState("");
  const [status, setStatus] = useState<ConnStatus>("idle");

  const rpcRef = useRef<RpcClient | null>(null);
  const streamingRef = useRef("");

  const refreshConversations = useCallback(async () => {
    if (!connection) return;
    setConversations(await listConversations(connection.id));
  }, [connection]);

  // Boot: conversation list for the (single, hardcoded) connection.
  useEffect(() => {
    void (async () => {
      await refreshConversations();
    })();
  }, [refreshConversations]);

  // Wire one WS per active conversation + iOS resilience hooks (R6).
  useEffect(() => {
    if (!connection || !activeConvId) return;

    const rpc = new RpcClient({
      baseUrl: connection.url,
      convId: activeConvId,
      onRecord: (record) => void handleRecord(record),
      onStatus: setStatus,
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
  }, [connection, activeConvId]);

  // Load the message mirror when switching conversations.
  useEffect(() => {
    if (!activeConvId) {
      setMessages([]);
      return;
    }
    void listMessages(activeConvId).then(setMessages);
  }, [activeConvId]);

  async function handleRecord(record: unknown) {
    const r = record as {
      type?: string;
      success?: boolean;
      error?: unknown;
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
      const text = streamingRef.current;
      streamingRef.current = "";
      setStreaming("");
      if (text && activeConvId) {
        await addMessage({
          convId: activeConvId,
          role: "assistant",
          text,
          ts: Date.now(),
        });
        setMessages(await listMessages(activeConvId));
      }
      return;
    }
    // Failed command = single response record; runtime failures surface in
    // the event stream → render as system bubbles (never silence errors).
    if (r?.type === "response" && r.success === false && activeConvId) {
      await addMessage({
        convId: activeConvId,
        role: "system",
        text: `Error: ${JSON.stringify(r.error ?? "command failed")}`,
        ts: Date.now(),
      });
      setMessages(await listMessages(activeConvId));
    }
  }

  async function newConversation() {
    if (!connection) return;
    const conv = await createConversation(connection.id, crypto.randomUUID());
    await refreshConversations();
    setActiveConvId(conv.convId);
    setLastConvId(connection.id, conv.convId);
    setStreaming("");
  }

  async function send(text: string) {
    if (!connection || !activeConvId) return;
    await addMessage({
      convId: activeConvId,
      role: "user",
      text,
      ts: Date.now(),
    });
    setMessages(await listMessages(activeConvId));
    await touchConversation(connection.id, activeConvId);
    rpcRef.current?.sendPi({
      id: crypto.randomUUID(),
      type: "prompt",
      message: text,
    });
  }

  if (!connection) return null;

  const active = conversations.find((c) => c.convId === activeConvId) ?? null;

  return (
    <div className="flex h-full">
      <ConversationList
        serverName={connection.name}
        conversations={conversations}
        activeConvId={activeConvId}
        onSelect={setActiveConvId}
        onNew={() => void newConversation()}
      />
      <div className="flex-1">
        <ChatView
          title={active?.title ?? null}
          status={status}
          messages={messages}
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