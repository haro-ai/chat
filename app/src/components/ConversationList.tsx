import type { SessionRow } from "../lib/db";

interface ConversationListProps {
  serverName: string;
  conversations: SessionRow[];
  activeConvId: string | null;
  onSelect: (convId: string) => void;
  onNew: () => void;
}

/** v0.1 minimal list — rename/delete/confirm land in v0.2 (PRD §4). */
export function ConversationList({
  serverName,
  conversations,
  activeConvId,
  onSelect,
  onNew,
}: ConversationListProps) {
  return (
    <div className="flex h-full w-64 flex-col border-r border-zinc-800 bg-zinc-950">
      <header className="px-4 py-4">
        <div className="text-xs uppercase tracking-wide text-zinc-500">Server</div>
        <div className="text-sm font-medium">{serverName}</div>
      </header>

      <div className="flex-1 space-y-1 overflow-y-auto px-2">
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
      </div>

      <footer className="p-3">
        <button
          className="w-full rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-900"
          onClick={onNew}
        >
          + New conversation
        </button>
      </footer>
    </div>
  );
}