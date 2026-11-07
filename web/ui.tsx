/** Primitives d'interface partagées (cartes, pastilles, barres). */
import type { ReactNode } from "react";
import { severityClass, stateClass, STATUS_LABEL, KIND_LABEL } from "./labels.js";

export const Card = ({ title, children }: { title: string; children: ReactNode }) => (
  <div className="card">
    <h3>{title}</h3>
    {children}
  </div>
);

export const Sev = ({ sev }: { sev: number }) => (
  <span className={`sev ${severityClass(sev)}`}>{Math.round(sev)}</span>
);

export const StateChip = ({ state }: { state: string }) => (
  <span className={`chip ${stateClass(state)}`}>{state}</span>
);

export const StatusChip = ({ status, count = 0 }: { status: string; count?: number }) => (
  <span className={`chip ${STATUS_CLASS[status] ?? "untracked"}`}>
    {STATUS_LABEL[status] ?? status}
    {count > 0 ? ` · ${count}` : ""}
  </span>
);

const STATUS_CLASS: Record<string, string> = { new: "st-new", seen: "st-seen", closed: "st-closed" };

export const KindChip = ({ kind }: { kind: string }) => (
  <span className="chip public">{KIND_LABEL[kind] ?? kind}</span>
);

export const Bar = ({ value, max = 100 }: { value: number; max?: number }) => (
  <div className="barwrap">
    <div className="bar" style={{ width: `${Math.min(100, (value / max) * 100)}%` }} />
  </div>
);

export const LiveLine = ({ connected, lastCycle }: { connected: boolean; lastCycle: string }) => (
  <span className="flexrow">
    <span style={{ color: connected ? "#79c58b" : "#f08a8a" }}>{connected ? "flux temps réel connecté" : "flux temps réel déconnecté"}</span>
    <span className="muted"> · dernier cycle : {lastCycle}</span>
  </span>
);

export const Toast = ({ text }: { text: string }) => <div className="toast">{text}</div>;

/** Clavier / sélection simple pour les filtres. */
export function Select<T extends string>({ value, options, onChange, label }: { value: T | ""; options: readonly T[]; onChange: (v: T) => void; label: string }) {
  return (
    <div>
      <label>{label}</label>
      <select value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o} value={o}>
            {o === "" ? "tous" : o}
          </option>
        ))}
      </select>
    </div>
  );
}
