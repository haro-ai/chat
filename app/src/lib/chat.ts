/**
 * In-memory chat model (Model A — ARCH §3: haro's session store is the system
 * of record; the client is a view). Nothing here is persisted; history is
 * fetched with `get_messages` each time a conversation opens.
 *
 * The full AgentMessage type ships with pi (`message-types.md`); this module
 * narrows the small renderable slice defensively.
 */
export interface ChatMessage {
  key: string;
  role: "user" | "assistant" | "system";
  text: string;
}

type ContentBlock = { type?: string; text?: string; name?: string };
type AnyMessage = { role?: string; content?: string | ContentBlock[] };

/** Renderable text of a message: its text content blocks joined. */
function messageText(m: AnyMessage): string {
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
  }
  return "";
}

/**
 * get_messages → bubbles. System messages (the persisted prompt/tool loadout)
 * and tool results are not rendered; assistant toolCall blocks render as a
 * muted chip so coding activity stays visible.
 */
export function toChatMessages(messages: unknown[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  messages.forEach((raw, i) => {
    const m = raw as AnyMessage;
    if (m.role === "system" || m.role === "toolResult" || m.role === "custom") return;
    const blocks = Array.isArray(m.content) ? m.content : [{ type: "text", text: messageText(m) }];
    for (const b of blocks) {
      if (b.type === "text" && b.text?.trim()) {
        out.push({ key: `${i}-t`, role: m.role === "user" ? "user" : "assistant", text: b.text });
      } else if (b.type === "toolCall") {
        out.push({ key: `${i}-c`, role: "system", text: `⚙︎ ${b.name ?? "tool"}` });
      }
    }
  });
  return out;
}
