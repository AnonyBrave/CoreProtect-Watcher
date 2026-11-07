/** Libellés français de CoreProtect-Watcher : natures d'incidents, états de propriété, statuts. */

export const KIND_LABEL: Record<string, string> = {
  theft: "Vol",
  theft_shared: "Vol entre copropriétaires",
  dupe: "Duplication",
  grief: "Grief",
  anomaly: "Anomalie",
  chat: "Propos / commande",
};

export const STATE_LABEL: Record<string, string> = {
  owned: "possédé",
  public: "public",
  shared: "partagé",
  ambiguous: "ambigu",
  untracked: "non suivi",
};

export const STATUS_LABEL: Record<string, string> = {
  new: "nouvel",
  seen: "vu",
  closed: "fermé",
};

export const STATUS_CLASS: Record<string, string> = { new: "st-new", seen: "st-seen", closed: "st-closed" };

export const stateClass = (state: string): string => (state === "owned" ? "owned" : state === "public" ? "public" : state === "ambiguous" ? "ambiguous" : "untracked");

/** Couleur de la pastille de sévérité selon les paliers d'alerte. */
export const severityClass = (sev: number): string =>
  sev >= 80 ? "sev-critique" : sev >= 60 ? "sev-haut" : sev >= 40 ? "sev-moyen" : "sev-faible";

/** Palette stable des joueurs sur la carte et les graphes (par uid). */
const PALETTE = ["#3fa34d", "#5678a8", "#d29922", "#b07aa0", "#6fb3c6", "#c06a5f", "#8a909c", "#7fb3d5"];

export const playerColor = (uid: number): string => PALETTE[Math.abs(uid) % PALETTE.length];

/** Position d'un conteneur physique en texte lisible. */
export const coordText = (x: number | null, y: number | null, z: number | null): string =>
  x === null ? "?" : `x=${x} y=${y} z=${z}`;
