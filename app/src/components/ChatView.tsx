import { useEffect, useRef, useState } from "react";
import type { MessageRow } from "../lib/db";
import type { ConnStatus } from "../lib/rpc-client";
import { MessageBubble } from "./MessageBubble";

interface ChatViewProps {
  title: string | null;
  status: ConnStatus;
  /** composer only when connected — cached history is read-only (ARCH §3) */
  connected: boolean;
  messages: MessageRow[];
  /** accumulated text_delta while a run streams (cleared on agent_settled) */
  streaming: string;
  onSend: (text: string) => void;
}

const STATUS_TEXT: Record<ConnStatus, string> = {
  idle: "offline",
  connecting: "connecting…",
  open: "connected",
  closed: "reconnect pending",
};

export function ChatView({ title, status, connected, messages, streaming, onSend }: ChatViewProps) {
  const [draft, setDraft] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, streaming]);

  function submit() {
    const text = draft.trim();
    if (!text || !connected) return;
    setDraft("");
    onSend(text);
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        <div>
          <div className="text-sm font-medium">{title ?? "New conversation"}</div>
          <div className="text-[11px] text-zinc-500">{STATUS_TEXT[status]}</div>
        </div>
      </header>

      <main className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {messages.length === 0 && !streaming && (
          <p className="pt-16 text-center text-sm text-zinc-500">
            Say something to haro — history lives on the agent host's session
            store; this view is a synced cache.
          </p>
        )}
        {messages.map((m) => (
          <MessageBubble key={m.key ?? m.seq} role={m.role} text={m.text} />
        ))}
        {streaming && (
          <MessageBubble role="assistant" text={streaming} />
        )}
        <div ref={bottomRef} />
      </main>

      <footer className="border-t border-zinc-800 p-3">
        {!connected && messages.length > 0 && (
          <p className="mb-2 text-center text-[11px] text-zinc-600">
            Offline — showing cached history. Connect to continue.
          </p>
        )}
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <textarea
            className="min-h-11 flex-1 resize-none rounded-xl bg-zinc-900 px-3 py-2.5 text-sm text-zinc-100 placeholder-zinc-500 outline-none ring-1 ring-zinc-800 focus:ring-blue-600"
            placeholder={connected ? "Message haro…" : "Connect to send…"}
            rows={1}
            value={draft}
            disabled={!connected}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <button
            type="submit"
            className="rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-40"
            disabled={!draft.trim() || !connected}
          >
            Send
          </button>
        </form>
      </footer>
    </div>
  );
}
