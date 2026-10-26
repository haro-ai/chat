import type { MessageRow } from "../lib/db";

const ROLE_STYLES: Record<MessageRow["role"], string> = {
  user: "bg-blue-600 text-white ml-auto",
  assistant: "bg-zinc-800 text-zinc-100 mr-auto",
  system: "bg-amber-500/15 text-amber-200 border border-amber-500/30 mx-auto text-xs",
};

const ROLE_LABELS: Record<MessageRow["role"], string> = {
  user: "You",
  assistant: "haro",
  system: "system",
};

export function MessageBubble({ role, text }: { role: MessageRow["role"]; text: string }) {
  return (
    <div className={`max-w-[85%] rounded-2xl px-4 py-2.5 ${ROLE_STYLES[role]}`}>
      {role !== "user" && (
        <div className="mb-0.5 text-[10px] uppercase tracking-wide opacity-60">
          {ROLE_LABELS[role]}
        </div>
      )}
      <div className="whitespace-pre-wrap break-words">{text}</div>
    </div>
  );
}