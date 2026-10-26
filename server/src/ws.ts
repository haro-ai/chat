import { WebSocketServer, type WebSocket } from "ws";
import type { Config } from "./config.js";
import { ConversationRegistry, type Conversation } from "./conversations.js";
import { isEnvelope } from "@haro/shared";

/**
 * The chat service: a dumb pump between WebSocket and pi stdin/stdout
 * (ARCH §2). One WS per conversation; content is never interpreted here —
 * `kind:"pi"` envelopes are forwarded verbatim in both directions.
 */
export function startServer(config: Config): WebSocketServer {
  const registry = new ConversationRegistry(config);
  const wss = new WebSocketServer({ host: config.host, port: config.port });

  wss.on("connection", (ws: WebSocket, req) => {
    // Conversation id arrives in the query string: /ws?conv=<uuid>
    const url = new URL(req.url ?? "/", "http://localhost");
    const conv = url.searchParams.get("conv") ?? "";
    if (!/^[0-9a-f-]{36}$/i.test(conv)) {
      ws.close(4400, "bad conv id");
      return;
    }

    const c = registry.get(conv);
    c.attach(ws);
    console.log(`[ws] connection open (conv ${conv})`);

    ws.on("message", (data) => {
      c.touch();
      void handleEnvelope(c, ws, data.toString("utf8")).catch((err) => {
        console.error(`[ws] error on conv ${conv}:`, err);
      });
    });

    ws.on("close", () => {
      console.log(`[ws] connection closed (conv ${conv})`);
      // WS drops don't destroy the pi child mid-run (ARCH §2.3): the idle timer
      // owns the recycle, giving best-effort finish headroom.
    });
  });

  wss.on("listening", () => {
    console.log(
      `haro chat service listening on ${config.host}:${config.port} ` +
        `(cwd: ${config.cwd}, pi: ${config.piBin})`,
    );
    console.log("publish with: tailscale serve --bg --ws 80 http://127.0.0.1:" + config.port);
  });

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  async function shutdown() {
    console.log("[service] shutting down; disposing conversations");
    await registry.disposeAll();
    wss.close();
    process.exit(0);
  }

  return wss;
}

async function handleEnvelope(c: Conversation, ws: WebSocket, raw: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    ws.close(4400, "bad json");
    return;
  }
  if (!isEnvelope(parsed)) {
    ws.close(4400, "bad envelope");
    return;
  }

  if (parsed.kind === "pi") {
    // Verbatim pump: client → pi stdin (queued if the child is mid-spawn).
    c.sendPi(parsed.payload);
    return;
  }

  await c.handleCtl(parsed.payload);
}
