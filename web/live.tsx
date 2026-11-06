/** État temps réel partagé : connexion SSE, dernier cycle, incidents arrivés en direct. */
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { hub } from "./sse.js";
import { fmtDate } from "./api.js";

export interface LiveIncident {
  id: number;
  kind: string;
  severity: number;
  uid: number | null;
  victim_uid: number | null;
  name: string | null;
  victim_name: string | null;
  x: number | null;
  y: number | null;
  z: number | null;
  container_key: string | null;
  amount: number | null;
}

interface LiveState {
  connected: boolean;
  lastCycleAt: number | null;
  liveIncidents: LiveIncident[];
  unread: number;
  clearUnread: () => void;
}

const Ctx = createContext<LiveState>({
  connected: false,
  lastCycleAt: null,
  liveIncidents: [],
  unread: 0,
  clearUnread: () => {},
});

export function LiveProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [lastCycleAt, setLast] = useState<number | null>(null);
  const [liveIncidents, setLive] = useState<LiveIncident[]>([]);
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    const stop = hub.subscribe((e) => {
      if (e.type === "hello") setConnected(true);
      else if (e.type === "disconnected") setConnected(false);
      else if (e.type === "cycle") {
        const d = e.data as { at?: number; incidentsNew?: number };
        if (d.at) setLast(d.at);
        if ((d.incidentsNew ?? 0) > 0) setUnread((u) => u + (d.incidentsNew ?? 0));
      } else if (e.type === "incident") {
        const d = e.data as LiveIncident;
        setLive((arr) => [d, ...arr].slice(0, 60));
        setUnread((u) => u + 1);
      }
    });
    return stop;
  }, []);

  const value: LiveState = {
    connected,
    lastCycleAt,
    liveIncidents,
    unread,
    clearUnread: () => setUnread(0),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useLive = (): LiveState => useContext(Ctx);
export const lastCycleLabel = (at: number | null): string => (at === null ? "en attente" : fmtDate(at));
