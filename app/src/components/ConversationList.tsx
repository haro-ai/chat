import type { SessionInfo } from "@haro/shared";
import type { ConversationRow } from "../lib/db";

interface ConversationListProps {
  serverName: string;
  conversations: ConversationRow[];
  activeConvId: string | null;
  onSelect: (convId: string) => void;
  onNew: () => void;
  /** past sessions on the agent host; null = not fetched / panel closed */
  sessions: SessionInfo[] | null;
  onBrowseSessions: () => void;
  onSelectSession: (info: SessionInfo) => void;
  onCloseSessions: () => void;
}

/**
 * Cached conversations + the Model A "past sessions" picker (ARCH §3):
 * sessions live on the agent host's pi store — the same place SSH/TUI
 * sessions land — so anything started there can be resumed here.
 */
export function ConversationList({
  serverName,
  conversations,
  activeConvId,
  onSelect,
  onNew,
  sessions,
  onBrowseSessions,
  onSelectSession,
  onCloseSessions,
}: ConversationListProps) {
  return (
    <div className="flex h-full w-64 flex-col border-r border-zinc-800 bg-zinc-950">
      <header className="px-4 py-4">
        <div className="text-xs uppercase tracking-wide text-zinc-500">Server</div>
        <div className="text-sm font-medium">{serverName}</div>
      </header>

      <div className="flex-1 space-y-1 overflow-y-auto px-2">
        {sessions === null ? (
          <>
            {conversations.map((c) => (
              <button
                key={c.convId}
                className={`w-full truncate rounded-lg px-3 py-2 text-left text-sm ${
                  c.convId === activeConvId
                    ? "bg-zinc-800 text-zinc-100"
                    : "text-zinc-400 hover:bg-zinc-900"
                }`}
                onClick={() => onSelect(c.convId)}
              >
                {c.title ?? `Conversation ${c.convId.slice(0, 8)}`}
              </button>
            ))}
            {conversations.length === 0 && (
              <p className="px-3 py-6 text-center text-xs text-zinc-600">
                No conversations yet.
              </p>
            )}
          </>
        ) : (
          <SessionPicker
            sessions={sessions}
            onSelect={onSelectSession}
            onClose={onCloseSessions}
          />
        )}
      </div>

      <footer className="space-y-2 p-3">
        {sessions === null ? (
          <>
            <button
              className="w-full rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-900"
              onClick={onBrowseSessions}
            >
              Resume a past session…
            </button>
            <button
              className="w-full rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-900"
              onClick={onNew}
            >
              + New conversation
            </button>
          </>
        ) : (
          <button
            className="w-full rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-900"
            onClick={onCloseSessions}
          >
            Back to conversations
          </button>
        )}
      </footer>
    </div>
  );
}

function SessionPicker({
  sessions,
  onSelect,
  onClose,
}: {
  sessions: SessionInfo[];
  onSelect: (info: SessionInfo) => void;
  onClose: () => void;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-xs uppercase tracking-wide text-zinc-500">
          Past sessions
        </span>
        <button
          className="text-xs text-zinc-500 hover:text-zinc-300"
          onClick={onClose}
          aria-label="Close session list"
        >
          ✕
        </button>
      </div>
      {sessions.length === 0 && (
        <p className="px-3 py-6 text-center text-xs text-zinc-600">
          No sessions on this host yet.
        </p>
      )}
      {sessions.map((s) => (
        <button
          key={s.path}
          className="w-full rounded-lg px-3 py-2 text-left text-sm text-zinc-400 hover:bg-zinc-900"
          onClick={() => onSelect(s)}
        >
          <div className="truncate text-zinc-200">
            {s.name ?? `Session ${s.id.slice(0, 8)}`}
          </div>
          <div className="truncate text-[11px] text-zinc-600">
            {s.cwd} · {new Date(s.mtime).toLocaleDateString()}
          </div>
        </button>
      ))}
    </div>
  );
}
