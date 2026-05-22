import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

function isResponseMessage(
  msg: JSONRPCMessage,
): msg is Extract<JSONRPCMessage, { id: string | number }> {
  return (
    typeof msg === "object" &&
    msg !== null &&
    "id" in msg &&
    (msg as { id: unknown }).id !== null &&
    (msg as { id: unknown }).id !== undefined
  );
}

/**
 * Single-shot Transport for stateless Streamable HTTP on Cloudflare Workers.
 *
 * Each HTTP request gets its own FetchTransport + McpServer. The flow is:
 *   1. Caller wires `server.connect(transport)`.
 *   2. Caller invokes `transport.dispatch(message)` with the incoming JSON-RPC.
 *   3. The server processes via `onmessage` and emits its reply via `send()`,
 *      which resolves the promise returned by `dispatch()`.
 *   4. Caller closes the server; the transport's underlying state is GC'd.
 *
 * Server-initiated notifications (no `id`) are buffered and exposed via
 * `drainNotifications()` â useful only if the caller wants to attach them to
 * an SSE response. Pure JSON-response callers can ignore them.
 */
export class FetchTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  sessionId?: string;

  private pending = new Map<string | number, (msg: JSONRPCMessage) => void>();
  private notifications: JSONRPCMessage[] = [];

  async start(): Promise<void> {
    // No-op: this transport is request-scoped, started implicitly.
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (isResponseMessage(message)) {
      const resolver = this.pending.get(message.id);
      if (resolver) {
        this.pending.delete(message.id);
        resolver(message);
        return;
      }
    }
    this.notifications.push(message);
  }

  async close(): Promise<void> {
    this.pending.clear();
    this.onclose?.();
  }

  /**
   * Push one inbound JSON-RPC message into the server and (for requests) wait
   * for the matching response. Returns `null` for notifications (no reply).
   */
  dispatch(message: JSONRPCMessage): Promise<JSONRPCMessage | null> {
    const handler = this.onmessage;
    if (!handler) {
      return Promise.reject(
        new Error("FetchTransport: server has not connected yet"),
      );
    }

    if (!isResponseMessage(message)) {
      handler(message);
      return Promise.resolve(null);
    }

    return new Promise<JSONRPCMessage>((resolve) => {
      this.pending.set(message.id, resolve);
      handler(message);
    });
  }

  drainNotifications(): JSONRPCMessage[] {
    const out = this.notifications;
    this.notifications = [];
    return out;
  }
}
