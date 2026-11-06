/** Flux temps réel : SSE /api/stream (cycle, incident, incident-update, settings-changed). */

export type SseEvent = { type: string; data: unknown };

type Listener = (e: SseEvent) => void;

class SseHub {
  private es: EventSource | null = null;
  private listeners = new Set<Listener>();

  connect(): void {
    if (this.es) return;
    const es = new EventSource("/api/stream");
    this.es = es;
    for (const name of ["hello", "cycle", "incident", "incident-update", "settings-changed"]) {
      es.addEventListener(name, (ev: MessageEvent) => {
        let data: unknown = null;
        try {
          data = JSON.parse(ev.data);
        } catch {
          data = ev.data;
        }
        this.emit({ type: name, data });
      });
    }
    es.addEventListener("error", () => {
      this.emit({ type: "disconnected", data: null });
      // EventSource se reconnecte seul ; on garde le même objet.
    });
  }

  private emit(e: SseEvent): void {
    for (const l of this.listeners) l(e);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    this.connect();
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.es?.close();
    this.es = null;
  }
}

export const hub = new SseHub();
