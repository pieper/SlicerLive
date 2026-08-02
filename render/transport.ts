// Transport — the wire binding LiveSync moves messages over. The WebSocket is one implementation;
// shared-memory / HTTP / p2p slot in behind the same interface later (ARCHITECTURE-2026-08-02 §1
// axis 2). A transport carries opaque JSON messages and knows nothing about mrson or LiveScene.

export interface Transport {
  connect(): void;
  close(): void;
  send(msg: unknown): void;
  readonly isOpen: boolean;
  onMessage?: (msg: unknown) => void;
  onOpen?: () => void;
  onClose?: () => void;
}

/** WebSocket binding of the transport (the `ws://host:2132/` mrson live channel). Reconnect/backoff
 *  is LiveSync's concern, not the transport's — the transport just reports open/close. */
export class WsTransport implements Transport {
  private ws?: WebSocket;
  onMessage?: (msg: unknown) => void;
  onOpen?: () => void;
  onClose?: () => void;

  constructor(public url: string) {}

  get isOpen(): boolean { return this.ws?.readyState === WebSocket.OPEN; }

  connect(): void {
    let ws: WebSocket;
    try { ws = new WebSocket(this.url); } catch { this.onClose?.(); return; }
    this.ws = ws;
    ws.onopen = () => this.onOpen?.();
    ws.onmessage = (m) => {
      let msg: unknown;
      try { msg = JSON.parse(m.data as string); } catch { return; }
      this.onMessage?.(msg);
    };
    ws.onerror = () => { /* a close always follows; reconnect is driven from onClose */ };
    ws.onclose = () => { if (this.ws === ws) this.ws = undefined; this.onClose?.(); };
  }

  send(msg: unknown): void { if (this.isOpen) this.ws!.send(JSON.stringify(msg)); }

  close(): void { const ws = this.ws; this.ws = undefined; ws?.close(); }
}
