/**
 * LF-only JSONL line splitter for pi stdout.
 *
 * Deliberately NOT Node's `readline` — readline also splits on \r, U+2028 and
 * U+2029, which can appear inside pi event JSON and would corrupt framing
 * (ARCHITECTURE.md §2.2, protocol discipline).
 */
export function createLineSplitter(onLine: (line: string) => void) {
  let buf = "";
  return (chunk: Buffer | string) => {
    buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim().length > 0) onLine(line);
    }
  };
}
